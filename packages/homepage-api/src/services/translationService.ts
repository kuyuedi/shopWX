import { queryWithPool, query, createLogger } from '@prediction-market/shared';
import OpenAI from 'openai';

const logger = createLogger('translation-service');

// 懒加载，避免启动时因缺少 key 报错
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MODEL = process.env.TRANSLATION_MODEL || 'gpt-4o-mini';
const BATCH_SIZE = 20; // Translate up to 20 texts per API call
const MAX_PER_CYCLE = 100; // Max translations per cron cycle

interface TranslationRow {
  source_table: string;
  source_id: string;
  field: string;
  source_text: string;
}

/**
 * Translate a batch of texts to Chinese using GPT.
 * Returns an array of translated texts in the same order.
 */
async function translateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];

  const numberedTexts = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const prompt = `Translate the following prediction market titles/texts to Simplified Chinese.

Rules:
- Transliterate Western person names phonetically (e.g., "Gavin Newsom" → "加文·纽森")
- Use standard Chinese names for well-known cities (e.g., "Oklahoma City" → "俄克拉荷马城", "New York" → "纽约")
- Use standard Chinese names for countries and political terms
- Use standard Chinese names for sports teams when available
- Keep brand names in English: Kalshi, Polymarket, Bitcoin, Ethereum, etc.
- Keep ticker symbols, numbers, and percentages as-is
- Keep the same meaning and tone — do not add or remove information
- For resolution rules, maintain the conditional structure ("If X, then resolves to Yes")

Return ONLY the translations, numbered in the same order. No explanations.

${numberedTexts}`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: texts.length * 200,
    });

    const content = response.choices[0]?.message?.content || '';
    // Parse numbered responses
    const lines = content.split('\n').filter((l: string) => /^\d+\./.test(l.trim()));
    const translations = lines.map((l: string) => l.replace(/^\d+\.\s*/, '').trim());

    // If parsing failed, try splitting by double newline
    if (translations.length !== texts.length) {
      logger.warn({ expected: texts.length, got: translations.length }, 'Translation count mismatch, using raw split');
      const rawLines = content.split('\n').filter((l: string) => l.trim().length > 0);
      return rawLines.slice(0, texts.length);
    }

    return translations;
  } catch (err) {
    logger.error({ err, count: texts.length }, 'Translation API call failed');
    return texts.map(() => ''); // Return empty strings on failure
  }
}

/**
 * Find untranslated market titles and translate them.
 * Called by the cron job every minute.
 */
export async function translateNewContent(): Promise<{ translated: number; errors: number }> {
  let translated = 0;
  let errors = 0;

  try {
    // 0. Find untranslated EVENT titles (CE-xxx, shown on homepage)
    const untranslatedEvents = await query<{
      canonical_event_id: string;
      title: string;
    }>(`
      SELECT DISTINCT em.canonical_event_id, e.title
      FROM direct_exchanges_data.event_mappings em
      JOIN direct_exchanges_data.events e ON em.event_id = e.event_id AND em.exchange_id = e.exchange_id
      WHERE em.exchange_id = 'KALSHI'
        AND e.status = 'Open'
        AND e.title IS NOT NULL AND e.title != ''
        AND NOT EXISTS (
          SELECT 1 FROM direct_exchanges_data.translations t
          WHERE t.source_table = 'events'
            AND t.source_id = em.canonical_event_id
            AND t.field = 'title'
            AND t.language = 'zh'
        )
      LIMIT ${MAX_PER_CYCLE}
    `);

    if (untranslatedEvents.rows.length > 0) {
      logger.info({ count: untranslatedEvents.rows.length }, 'Translating event titles');

      for (let i = 0; i < untranslatedEvents.rows.length; i += BATCH_SIZE) {
        const batch = untranslatedEvents.rows.slice(i, i + BATCH_SIZE);
        const texts = batch.map(r => r.title);
        const translations = await translateBatch(texts);

        for (let j = 0; j < batch.length; j++) {
          const tr = translations[j];
          if (tr && tr.length > 0) {
            try {
              await query(
                `INSERT INTO direct_exchanges_data.translations
                  (source_table, source_id, field, source_text, translated_text, language, model_used)
                 VALUES ($1, $2, $3, $4, $5, 'zh', $6)
                 ON CONFLICT (source_table, source_id, field, language)
                 DO UPDATE SET
                   translated_text = CASE WHEN direct_exchanges_data.translations.manual_override THEN direct_exchanges_data.translations.translated_text ELSE EXCLUDED.translated_text END,
                   source_text = EXCLUDED.source_text,
                   model_used = EXCLUDED.model_used,
                   updated_at = NOW()`,
                ['events', batch[j]?.canonical_event_id, 'title', texts[j], translations[j], MODEL]
              );
              translated++;
            } catch (err) {
              logger.error({ err, id: batch[j]!.canonical_event_id }, 'Failed to insert event translation');
              errors++;
            }
          } else {
            errors++;
          }
        }
      }
    }

    // 1. Find untranslated market titles (highest priority)
    if (translated >= MAX_PER_CYCLE) return { translated, errors };
    const untranslatedTitles = await query<{
      canonical_market_id: string;
      generated_title: string;
    }>(`
      SELECT mt.canonical_market_id, mt.generated_title
      FROM direct_exchanges_data.market_titles mt
      WHERE mt.generated_title IS NOT NULL
        AND mt.generated_title != ''
        AND NOT EXISTS (
          SELECT 1 FROM direct_exchanges_data.translations t
          WHERE t.source_table = 'market_titles'
            AND t.source_id = mt.canonical_market_id
            AND t.field = 'title'
            AND t.language = 'zh'
        )
      LIMIT ${MAX_PER_CYCLE}
    `);

    if (untranslatedTitles.rows.length > 0) {
      logger.info({ count: untranslatedTitles.rows.length }, 'Translating market titles');

      // Process in batches
      for (let i = 0; i < untranslatedTitles.rows.length; i += BATCH_SIZE) {
        const batch = untranslatedTitles.rows.slice(i, i + BATCH_SIZE);
        const texts = batch.map(r => r.generated_title);
        const translations = await translateBatch(texts);

        for (let j = 0; j < batch.length; j++) {
          const tr = translations[j];
          if (tr && tr.length > 0) {
            try {
              await query(
                `INSERT INTO direct_exchanges_data.translations
                  (source_table, source_id, field, source_text, translated_text, language, model_used)
                 VALUES ($1, $2, $3, $4, $5, 'zh', $6)
                 ON CONFLICT (source_table, source_id, field, language)
                 DO UPDATE SET
                   translated_text = CASE WHEN direct_exchanges_data.translations.manual_override THEN direct_exchanges_data.translations.translated_text ELSE EXCLUDED.translated_text END,
                   source_text = EXCLUDED.source_text,
                   model_used = EXCLUDED.model_used,
                   updated_at = NOW()`,
                ['market_titles', batch[j]?.canonical_market_id, 'title', texts[j], translations[j], MODEL]
              );
              translated++;
            } catch (err) {
              logger.error({ err, id: batch[j]!.canonical_market_id }, 'Failed to insert translation');
              errors++;
            }
          } else {
            errors++;
          }
        }
      }
    }

    // 2. Find untranslated outcome names (from prediction_markets via market_mappings)
    if (translated < MAX_PER_CYCLE) {
      const remaining = MAX_PER_CYCLE - translated;
      const untranslatedOutcomes = await query<{
        canonical_market_id: string;
        kalshi_title: string;
      }>(`
        SELECT mt.canonical_market_id, mt.kalshi_title
        FROM direct_exchanges_data.market_titles mt
        WHERE mt.kalshi_title IS NOT NULL
          AND mt.kalshi_title != ''
          AND NOT EXISTS (
            SELECT 1 FROM direct_exchanges_data.translations t
            WHERE t.source_table = 'market_titles'
              AND t.source_id = mt.canonical_market_id
              AND t.field = 'kalshi_title'
              AND t.language = 'zh'
          )
        LIMIT ${remaining}
      `);

      if (untranslatedOutcomes.rows.length > 0) {
        for (let i = 0; i < untranslatedOutcomes.rows.length; i += BATCH_SIZE) {
          const batch = untranslatedOutcomes.rows.slice(i, i + BATCH_SIZE);
          const texts = batch.map(r => r.kalshi_title);
          const translations = await translateBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            const tr = translations[j];
          if (tr && tr.length > 0) {
              try {
                await query(
                  `INSERT INTO direct_exchanges_data.translations
                    (source_table, source_id, field, source_text, translated_text, language, model_used)
                   VALUES ($1, $2, $3, $4, $5, 'zh', $6)
                   ON CONFLICT (source_table, source_id, field, language)
                   DO UPDATE SET
                     translated_text = CASE WHEN direct_exchanges_data.translations.manual_override THEN direct_exchanges_data.translations.translated_text ELSE EXCLUDED.translated_text END,
                     source_text = EXCLUDED.source_text,
                     updated_at = NOW()`,
                  ['market_titles', batch[j]?.canonical_market_id, 'kalshi_title', texts[j], translations[j], MODEL]
                );
                translated++;
              } catch (err) {
                errors++;
              }
            }
          }
        }
      }
    }

    // 3. Find untranslated resolution rules (lower priority)
    if (translated < MAX_PER_CYCLE) {
      const remaining = MAX_PER_CYCLE - translated;
      const untranslatedRules = await query<{
        canonical_market_id: string;
        exchange_id: string;
        rules_primary: string;
      }>(`
        SELECT DISTINCT mm.canonical_market_id, pm.exchange_id, pm.rules_primary
        FROM direct_exchanges_data.market_mappings mm
        JOIN direct_exchanges_data.prediction_markets pm
          ON mm.market_id = pm.market_id AND mm.exchange_id = pm.exchange_id AND mm.outcome_side = pm.outcome_side
        WHERE pm.rules_primary IS NOT NULL AND pm.rules_primary != ''
          AND mm.outcome_side = 'YES'
          AND NOT EXISTS (
            SELECT 1 FROM direct_exchanges_data.translations t
            WHERE t.source_table = 'prediction_markets'
              AND t.source_id = mm.canonical_market_id || ':' || pm.exchange_id
              AND t.field = 'rules_primary'
              AND t.language = 'zh'
          )
        LIMIT ${remaining}
      `);

      if (untranslatedRules.rows.length > 0) {
        for (let i = 0; i < untranslatedRules.rows.length; i += BATCH_SIZE) {
          const batch = untranslatedRules.rows.slice(i, i + BATCH_SIZE);
          const texts = batch.map(r => r.rules_primary);
          const translations = await translateBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            const tr = translations[j];
          if (tr && tr.length > 0) {
              try {
                const sourceId = (batch[j]?.canonical_market_id || '') + ':' + (batch[j]?.exchange_id || '');
                await query(
                  `INSERT INTO direct_exchanges_data.translations
                    (source_table, source_id, field, source_text, translated_text, language, model_used)
                   VALUES ($1, $2, $3, $4, $5, 'zh', $6)
                   ON CONFLICT (source_table, source_id, field, language)
                   DO UPDATE SET
                     translated_text = CASE WHEN direct_exchanges_data.translations.manual_override THEN direct_exchanges_data.translations.translated_text ELSE EXCLUDED.translated_text END,
                     source_text = EXCLUDED.source_text,
                     updated_at = NOW()`,
                  ['prediction_markets', sourceId, 'rules_primary', texts[j], translations[j], MODEL]
                );
                translated++;
              } catch (err) {
                errors++;
              }
            }
          }
        }
      }
    }

  } catch (err) {
    logger.error({ err }, 'Translation cycle failed');
  }

  if (translated > 0 || errors > 0) {
    logger.info({ translated, errors }, 'Translation cycle complete');
  }

  return { translated, errors };
}

/**
 * Get translations for a list of canonical market IDs.
 * Returns a map of source_id → { field → translated_text }
 */
export async function getTranslations(
  sourceTable: string,
  sourceIds: string[],
  language: string = 'zh'
): Promise<Map<string, Record<string, string>>> {
  if (sourceIds.length === 0) return new Map();

  const result = await query<{
    source_id: string;
    field: string;
    translated_text: string;
  }>(`
    SELECT source_id, field, translated_text
    FROM direct_exchanges_data.translations
    WHERE source_table = $1
      AND source_id = ANY($2)
      AND language = $3
  `, [sourceTable, sourceIds, language]);

  const map = new Map<string, Record<string, string>>();
  for (const row of result.rows) {
    if (!map.has(row.source_id)) map.set(row.source_id, {});
    map.get(row.source_id)![row.field] = row.translated_text;
  }
  return map;
}
