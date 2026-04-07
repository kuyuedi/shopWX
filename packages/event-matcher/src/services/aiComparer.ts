import OpenAI from 'openai';
import { createLogger } from '@prediction-market/shared';
import type { EventForMatching, MarketForMatching } from '@prediction-market/shared';
import type { Config } from '../config.js';

const logger = createLogger('ai-comparer');

export interface ComparisonResult {
  match: boolean;
  confidence: number;
  reasoning: string;
}

let openaiClient: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey, timeout: 60000 });
  }
  return openaiClient;
}

/**
 * Semaphore-based rate limiter that uses OpenAI response headers
 * to preemptively throttle before hitting 429s.
 *
 * Strategy: track in-flight requests. When a response indicates
 * remaining capacity is less than in-flight count, gate new requests
 * until the rate limit window resets.
 */
let inFlight = 0;
let totalRequests = 0;
let waitPromise: Promise<void> | null = null;

function parseResetDuration(value: string): number {
  let ms = 0;
  const minMatch = value.match(/(\d+)m/);
  const secMatch = value.match(/([\d.]+)s/);
  const msMatch = value.match(/(\d+)ms/);
  if (minMatch) ms += parseInt(minMatch[1]!) * 60_000;
  if (secMatch && !msMatch) ms += parseFloat(secMatch[1]!) * 1000;
  if (msMatch) ms += parseInt(msMatch[1]!);
  return ms || 1000;
}

const MAX_GATE_MS = 60_000; // Never gate for more than 60s

function gateWorkers(waitMs: number, reason: string): void {
  if (waitPromise) return; // already gated
  const cappedMs = Math.min(waitMs, MAX_GATE_MS);
  logger.info({ waitMs: cappedMs, originalWaitMs: waitMs, reason, inFlight }, 'Gating workers');
  waitPromise = new Promise<void>(resolve => {
    setTimeout(() => {
      waitPromise = null;
      resolve();
    }, cappedMs);
  });
}

function updateRateLimits(headers: { get(name: string): string | null }): void {
  const remReq = headers.get('x-ratelimit-remaining-requests');
  const remTok = headers.get('x-ratelimit-remaining-tokens');
  const limReq = headers.get('x-ratelimit-limit-requests');
  const limTok = headers.get('x-ratelimit-limit-tokens');
  const resetReq = headers.get('x-ratelimit-reset-requests');
  const resetTok = headers.get('x-ratelimit-reset-tokens');

  const remainingRequests = remReq !== null ? parseInt(remReq) : null;
  const remainingTokens = remTok !== null ? parseInt(remTok) : null;
  const limitRequests = limReq !== null ? parseInt(limReq) : null;
  const limitTokens = limTok !== null ? parseInt(limTok) : null;
  const resetRequestsMs = resetReq ? parseResetDuration(resetReq) : null;
  const resetTokensMs = resetTok ? parseResetDuration(resetTok) : null;

  logger.debug({ remainingRequests, remainingTokens, limitRequests, limitTokens, inFlight }, 'Rate limit headers');

  // Gate when 90% of capacity is used (only 10% remaining).
  // This prevents 429s by slowing down well before hitting the limit.
  if (remainingRequests !== null && limitRequests && resetRequestsMs) {
    const threshold = Math.ceil(limitRequests * 0.1);
    if (remainingRequests <= threshold) {
      gateWorkers(resetRequestsMs + 200, `RPM remaining=${remainingRequests} <= 10% of ${limitRequests}`);
    }
  }
  if (remainingTokens !== null && limitTokens && resetTokensMs) {
    const threshold = Math.ceil(limitTokens * 0.1);
    if (remainingTokens <= threshold) {
      gateWorkers(resetTokensMs + 200, `TPM remaining=${remainingTokens} <= 10% of ${limitTokens}`);
    }
  }
}

/**
 * Wait if rate limit gate is active, then increment in-flight counter.
 */
async function acquireSlot(): Promise<void> {
  while (waitPromise) {
    await waitPromise;
  }
  inFlight++;
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * Compare a source event against a list of target candidate events.
 * Returns the best match if confidence >= threshold, or null.
 * Exchange names are parameterized for use across any exchange pair.
 */
export async function compareEvents(
  sourceEvent: EventForMatching,
  candidates: EventForMatching[],
  config: Config,
  sourceExchangeName: string = 'KALSHI',
  targetExchangeName: string = 'POLYMARKET'
): Promise<{ targetEvent: EventForMatching; result: ComparisonResult } | null> {
  if (candidates.length === 0) return null;

  const client = getClient(config.apiKey!);

  await acquireSlot();

  const candidateList = candidates
    .map((c, i) => `${i + 1}. Title: "${c.title}"${c.subtitle ? ` | Subtitle: "${c.subtitle}"` : ''}${c.category ? ` | Category: ${c.category}` : ''} | Markets: ${c.market_count ?? '?'}`)
    .join('\n');

  const prompt = `You are matching prediction market events across exchanges. Determine if any ${targetExchangeName} event covers the SAME real-world topic/outcome as the ${sourceExchangeName} event.

${sourceExchangeName} EVENT:
- Title: "${sourceEvent.title}"${sourceEvent.subtitle ? `\n- Subtitle: "${sourceEvent.subtitle}"` : ''}${sourceEvent.category ? `\n- Category: ${sourceEvent.category}` : ''}
- Markets: ${sourceEvent.market_count ?? '?'}

${targetExchangeName} CANDIDATES:
${candidateList}

RULES:
- Events match if they resolve on the same real-world topic/question, even with different wording
- Events about the same subject but different specific questions are NOT matches (e.g., "Will X win?" vs "Will X get nominated?")
- Ignore category differences — focus on the actual topic
- Ignore wording differences like "buy" vs "acquire", "cut" vs "decrease", "leave office" vs "out as leader"
- Return the BEST matching candidate number (1-indexed), or 0 if none match

IMPORTANT REJECTION CRITERIA — return confidence = 0 if:
1. THRESHOLD vs EXACT: "above X%" != "exactly X%"
2. DIFFERENT TIME PERIODS: "Oct meeting" != "end of 2026", "before Jul 2026" != "in 2026"
3. DIFFERENT ENTITIES: Different people, teams, or countries
4. DIFFERENT METRICS: Cumulative vs incremental measures

Respond with JSON only:
{"best_match": <number 0 if no match or 1-N>, "confidence": <0.0-1.0>, "reasoning": "<brief explanation>"}`;

  try {
    const reqStart = Date.now();
    const reqNum = ++totalRequests;
    const { data: response, response: raw } = await client.chat.completions.create({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }).withResponse();

    releaseSlot();
    updateRateLimits(raw.headers);

    const durationMs = Date.now() - reqStart;
    const tokensUsed = response.usage?.total_tokens ?? 0;
    const remReq = raw.headers.get('x-ratelimit-remaining-requests');
    const remTok = raw.headers.get('x-ratelimit-remaining-tokens');
    logger.info({
      reqNum,
      type: 'compareEvents',
      sourceEvent: sourceEvent.event_id,
      sourceExchange: sourceExchangeName,
      targetExchange: targetExchangeName,
      candidates: candidates.length,
      durationMs,
      tokensUsed,
      inFlight,
      remainingRpm: remReq ? parseInt(remReq) : null,
      remainingTpm: remTok ? parseInt(remTok) : null,
    }, 'OpenAI call completed');

    const choice = response.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      logger.warn({
        sourceEvent: sourceEvent.event_id,
        finishReason: choice?.finish_reason,
        message: choice?.message,
        choicesLength: response.choices?.length,
      }, 'Empty AI response');
      return null;
    }

    const parsed = JSON.parse(content) as { best_match: number; confidence: number; reasoning: string };

    if (parsed.best_match === 0 || parsed.confidence < config.confidenceThreshold) {
      logger.debug({
        sourceEvent: sourceEvent.event_id,
        bestMatch: parsed.best_match,
        confidence: parsed.confidence,
      }, 'No match found');
      return null;
    }

    const matchIndex = parsed.best_match - 1;
    const matchedCandidate = candidates[matchIndex];
    if (!matchedCandidate) {
      logger.warn({ sourceEvent: sourceEvent.event_id, bestMatch: parsed.best_match }, 'Invalid match index from AI');
      return null;
    }

    logger.info({
      sourceEvent: sourceEvent.event_id,
      sourceTitle: sourceEvent.title,
      targetEvent: matchedCandidate.event_id,
      targetTitle: matchedCandidate.title,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    }, 'Match found');

    return {
      targetEvent: matchedCandidate,
      result: {
        match: true,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      },
    };
  } catch (err: unknown) {
    releaseSlot();

    if (err instanceof OpenAI.RateLimitError) {
      // Use the actual rate limit reset duration, not retry-after-ms (which is too short)
      const errHeaders = (err as { headers?: Record<string, string> }).headers;
      const resetReq = errHeaders?.['x-ratelimit-reset-requests'];
      const resetTok = errHeaders?.['x-ratelimit-reset-tokens'];
      const resetMs = Math.max(
        resetReq ? parseResetDuration(resetReq) : 0,
        resetTok ? parseResetDuration(resetTok) : 0
      ) || 60_000; // fallback to 60s
      gateWorkers(resetMs + 500, `429 on ${sourceEvent.event_id}`);
    }
    logger.error({ err, sourceEvent: sourceEvent.event_id }, 'AI comparison failed');
    return null;
  }
}

/**
 * Quick AI check for modifier conflicts.
 * Returns 'SAME' or 'DIFFERENT'.
 */
export async function verifyModifierConflict(
  titleA: string,
  titleB: string,
  config: Config
): Promise<'SAME' | 'DIFFERENT'> {
  const client = getClient(config.apiKey!);

  await acquireSlot();

  const prompt = `You are comparing two prediction market titles to determine if they ask the same question.

Title A: ${titleA}
Title B: ${titleB}

Do these two titles ask the same question? Consider:
- Different date formats for the same deadline are the SAME question
  (e.g., "before 2027" and "before Jan 1, 2027")
- Different timeframes are DIFFERENT questions
  (e.g., "by March 31" vs "in 2026")
- "exactly N" and "N" alone are the SAME question
- "N" and "N or fewer/more" are DIFFERENT questions

Answer SAME or DIFFERENT (one word only).`;

  try {
    const reqStart = Date.now();
    const reqNum = ++totalRequests;
    const { data: response, response: raw } = await client.chat.completions.create({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    }).withResponse();

    releaseSlot();
    updateRateLimits(raw.headers);

    const durationMs = Date.now() - reqStart;
    const tokensUsed = response.usage?.total_tokens ?? 0;
    logger.info({
      reqNum,
      type: 'verifyModifierConflict',
      titleA,
      titleB,
      durationMs,
      tokensUsed,
      inFlight,
    }, 'Modifier conflict check completed');

    const content = response.choices[0]?.message?.content;
    if (!content) {
      logger.warn({ titleA, titleB }, 'Empty AI response for modifier check');
      return 'SAME'; // Default to allowing the match
    }

    const answer = content.trim().toUpperCase();
    return answer === 'SAME' ? 'SAME' : 'DIFFERENT';
  } catch (err: unknown) {
    releaseSlot();

    if (err instanceof OpenAI.RateLimitError) {
      const errHeaders = (err as { headers?: Record<string, string> }).headers;
      const resetReq = errHeaders?.['x-ratelimit-reset-requests'];
      const resetTok = errHeaders?.['x-ratelimit-reset-tokens'];
      const resetMs = Math.max(
        resetReq ? parseResetDuration(resetReq) : 0,
        resetTok ? parseResetDuration(resetTok) : 0
      ) || 60_000;
      gateWorkers(resetMs + 500, `429 on modifier verify`);
    }
    logger.error({ err, titleA, titleB }, 'Modifier AI verification failed');
    return 'SAME'; // On error, default to allowing the match (conservative)
  }
}

/**
 * Verify a borderline market match using AI.
 * Called for market pairs with Jaccard similarity between the lower and upper thresholds.
 * Returns true if the AI confirms the markets cover the same outcome.
 */
export async function verifyMarketMatch(
  sourceMarket: MarketForMatching,
  targetMarket: MarketForMatching,
  jaccardScore: number,
  config: Config,
  sourceExchangeName: string = 'KALSHI',
  targetExchangeName: string = 'POLYMARKET'
): Promise<{ match: boolean; confidence: number; reasoning: string }> {
  const client = getClient(config.apiKey!);

  await acquireSlot();

  const prompt = `You are verifying whether two prediction market outcomes from different exchanges cover the SAME specific outcome.

${sourceExchangeName} MARKET:
- Title: "${sourceMarket.title || ''}"
- Outcome: "${sourceMarket.outcome_name || ''}"

${targetExchangeName} MARKET:
- Title: "${targetMarket.title || ''}"
- Outcome: "${targetMarket.outcome_name || ''}"

RULES:
- Markets match ONLY if they resolve on the exact same specific outcome
- "Winner" vs "Both Teams to Score" = NOT a match (different market types)
- "43.7 to 43.9" vs "41.5 to 41.9" = NOT a match (different ranges)
- "Theodore" vs "Theodore" in baby names = MATCH (same name, same question)
- Different wording for the same outcome = MATCH

IMPORTANT REJECTION CRITERIA — You MUST return confidence = 0 if ANY of these are true:
1. THRESHOLD vs EXACT VALUE: One market asks "above X%" or "at least X" while the other asks "exactly X%" or "be X%". These are DIFFERENT markets. Example: "above 3.25%" != "be 3.25%"
2. DIFFERENT DATES: Markets reference different time periods or meetings. Example: "Oct meeting" != "end of 2026"
3. DIFFERENT CANDIDATES/ENTITIES: Markets reference different people, teams, or entities. Example: "Adam Miller" != "Jessica Rodriguez"
4. DIFFERENT METRICS: One measures total/cumulative, the other measures incremental/change. Example: "total above 100" != "increase by 10"

Respond with JSON only:
{"match": true/false, "confidence": <0.0-1.0>, "reasoning": "<brief explanation>"}`;

  try {
    const reqStart = Date.now();
    const reqNum = ++totalRequests;
    const { data: response, response: raw } = await client.chat.completions.create({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }).withResponse();

    releaseSlot();
    updateRateLimits(raw.headers);

    const durationMs = Date.now() - reqStart;
    const tokensUsed = response.usage?.total_tokens ?? 0;
    const remReq = raw.headers.get('x-ratelimit-remaining-requests');
    const remTok = raw.headers.get('x-ratelimit-remaining-tokens');
    logger.info({
      reqNum,
      type: 'verifyMarketMatch',
      sourceMarket: sourceMarket.market_id,
      targetMarket: targetMarket.market_id,
      durationMs,
      tokensUsed,
      inFlight,
      remainingRpm: remReq ? parseInt(remReq) : null,
      remainingTpm: remTok ? parseInt(remTok) : null,
    }, 'OpenAI call completed');

    const content = response.choices[0]?.message?.content;
    if (!content) {
      logger.warn({
        sourceMarket: sourceMarket.market_id,
        targetMarket: targetMarket.market_id,
      }, 'Empty AI response for market verification');
      return { match: false, confidence: 0, reasoning: 'Empty AI response' };
    }

    const parsed = JSON.parse(content) as { match: boolean; confidence: number; reasoning: string };

    logger.debug({
      sourceMarket: sourceMarket.market_id,
      targetMarket: targetMarket.market_id,
      jaccardScore,
      aiMatch: parsed.match,
      aiConfidence: parsed.confidence,
      reasoning: parsed.reasoning,
    }, 'Market verification result');

    return parsed;
  } catch (err: unknown) {
    releaseSlot();

    if (err instanceof OpenAI.RateLimitError) {
      const errHeaders = (err as { headers?: Record<string, string> }).headers;
      const resetReq = errHeaders?.['x-ratelimit-reset-requests'];
      const resetTok = errHeaders?.['x-ratelimit-reset-tokens'];
      const resetMs = Math.max(
        resetReq ? parseResetDuration(resetReq) : 0,
        resetTok ? parseResetDuration(resetTok) : 0
      ) || 60_000;
      gateWorkers(resetMs + 500, `429 on market verify ${sourceMarket.market_id}`);
    }
    logger.error({ err, sourceMarket: sourceMarket.market_id }, 'Market verification failed');
    return { match: false, confidence: 0, reasoning: 'AI call failed' };
  }
}
