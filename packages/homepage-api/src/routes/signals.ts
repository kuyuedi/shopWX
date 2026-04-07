import type { FastifyInstance } from 'fastify';
import { queryWithPool } from '@prediction-market/shared';
import { sendDailyArbDigest, sendArbDigestEmail } from '../services/emailService.js';

const VALID_SIGNALS = ['arb', 'whale', 'volume_spike', 'new_market', 'price_move'];
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const TELEGRAM_RE = /^@[a-zA-Z0-9_]{5,32}$/;

// Simple in-memory rate limiter: IP → timestamps
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) ?? [];
  // Prune old entries
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return false;
}

interface SubscribeBody {
  contact: string;
  contact_type?: 'email' | 'telegram';
  signals: string[];
}

export async function signalsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: SubscribeBody }>('/api/v1/signals/subscribe', {
    schema: {
      body: {
        type: 'object',
        required: ['contact', 'signals'],
        properties: {
          contact: { type: 'string', description: 'Email address or Telegram handle' },
          contact_type: { type: 'string', enum: ['email', 'telegram'], description: 'Auto-detected if omitted' },
          signals: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Signal types to subscribe to',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            subscription_id: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { contact, signals } = request.body;
    let { contact_type } = request.body;

    // Validate contact is non-empty
    if (!contact || typeof contact !== 'string' || contact.trim().length === 0) {
      return reply.status(400).send({ error: 'contact is required' });
    }

    const trimmedContact = contact.trim();

    // Auto-detect contact type
    if (!contact_type) {
      contact_type = trimmedContact.startsWith('@') ? 'telegram' : 'email';
    }

    // Validate contact format
    if (contact_type === 'email' && !EMAIL_RE.test(trimmedContact)) {
      return reply.status(400).send({ error: 'Invalid email format' });
    }
    if (contact_type === 'telegram' && !TELEGRAM_RE.test(trimmedContact)) {
      return reply.status(400).send({ error: 'Invalid Telegram handle. Must be @username with 5-32 alphanumeric characters' });
    }

    // Validate signals
    if (!Array.isArray(signals) || signals.length === 0) {
      return reply.status(400).send({ error: 'signals must be a non-empty array' });
    }
    const invalidSignals = signals.filter(s => !VALID_SIGNALS.includes(s));
    if (invalidSignals.length > 0) {
      return reply.status(400).send({
        error: `Invalid signal types: ${invalidSignals.join(', ')}. Valid types: ${VALID_SIGNALS.join(', ')}`,
      });
    }

    // Rate limit
    const ip = request.ip;
    if (isRateLimited(ip)) {
      return reply.status(429).send({ error: 'Too many requests. Max 10 per hour.' });
    }

    // Upsert into legacy signal_subscriptions
    const sql = `
      INSERT INTO direct_exchanges_data.signal_subscriptions (contact, contact_type, signals)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (contact) DO UPDATE SET
        signals = EXCLUDED.signals,
        contact_type = EXCLUDED.contact_type,
        is_active = true,
        updated_at = NOW()
      RETURNING id, unsubscribe_token
    `;

    const result = await queryWithPool<{ id: number; unsubscribe_token: string }>(
      fastify.apiPool,
      sql,
      [trimmedContact, contact_type, JSON.stringify(signals)],
    );

    // Also create platform user + alerts (new CRM system)
    if (contact_type === 'email') {
      try {
        const userResult = await queryWithPool<{ id: number }>(
          fastify.apiPool,
          `INSERT INTO platform.users (email) VALUES ($1)
           ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [trimmedContact],
        );
        const userId = userResult.rows[0]!.id;

        // Create email channel entry
        await queryWithPool(
          fastify.apiPool,
          `INSERT INTO platform.user_channels (user_id, channel, channel_address, is_default)
           VALUES ($1, 'email', $2, true)
           ON CONFLICT (user_id, channel, channel_address) DO NOTHING`,
          [userId, trimmedContact],
        );

        // Create alert entries for each selected signal (upsert to prevent duplicates)
        for (const signal of signals) {
          await queryWithPool(
            fastify.apiPool,
            `INSERT INTO platform.alerts (user_id, alert_type, channel)
             VALUES ($1, $2, 'email')
             ON CONFLICT ON CONSTRAINT uq_alerts_user_type_channel DO UPDATE SET
               is_active = true, updated_at = NOW()`,
            [userId, signal],
          );
        }
      } catch (err) {
        // Don't fail the subscription if platform sync fails
        console.error('Platform user sync failed (non-blocking):', err);
      }
    }

    const row = result.rows[0]!;
    return reply.send({
      success: true,
      subscription_id: `sub_${row.id}`,
    });
  });

  // Internal endpoint: trigger daily arb digest for all subscribers
  // Protected by a simple secret key — called by cron
  fastify.post('/api/v1/signals/digest/trigger', async (request, reply) => {
    const { secret } = request.body as { secret?: string };
    if (secret !== (process.env.DIGEST_SECRET || 'arb-digest-17b-2026')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const result = await sendDailyArbDigest();
    return reply.send({ success: true, ...result });
  });

  // Test endpoint: send arb digest to a specific email (for testing)
  fastify.post<{ Body: { email: string } }>('/api/v1/signals/digest/test', async (request, reply) => {
    const { email } = request.body;
    if (!email || !EMAIL_RE.test(email)) {
      return reply.status(400).send({ error: 'Valid email required' });
    }
    const sent = await sendArbDigestEmail(email);
    return reply.send({ success: sent, message: sent ? 'Arb digest sent' : 'No qualifying arb found (>= 3% spread)' });
  });
}
