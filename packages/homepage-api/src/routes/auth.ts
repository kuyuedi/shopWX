import type { FastifyInstance } from 'fastify';
import { queryWithPool, createLogger } from '@prediction-market/shared';
import { sendMagicLinkEmail } from '../services/emailService.js';

const logger = createLogger('auth');

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Simple in-memory rate limiter for magic link requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) ?? [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return false;
}

interface MagicLinkBody {
  email: string;
  language?: string;
}

interface VerifyParams {
  token: string;
}

export async function authRoute(fastify: FastifyInstance): Promise<void> {

  // ─── POST /api/v1/auth/magic-link ───
  // Request a magic link. Creates user if new.
  fastify.post<{ Body: MagicLinkBody }>('/api/v1/auth/magic-link', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'Email address' },
          language: { type: 'string', enum: ['en', 'zh'], description: 'Preferred language' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { email, language } = request.body;

    // Validate email
    if (!email || !EMAIL_RE.test(email.trim())) {
      return reply.status(400).send({ error: 'Invalid email format' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Rate limit
    if (isRateLimited(request.ip)) {
      return reply.status(429).send({ error: 'Too many requests. Try again in 15 minutes.' });
    }

    // Upsert user in platform schema
    const userResult = await queryWithPool<{ id: number; email_verified: boolean }>(
      fastify.apiPool,
      `INSERT INTO platform.users (email, language)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET
         language = COALESCE(EXCLUDED.language, platform.users.language),
         updated_at = NOW()
       RETURNING id, email_verified`,
      [trimmedEmail, language || 'en'],
    );

    const user = userResult.rows[0]!;

    // Create magic link (expires in 15 minutes)
    const linkResult = await queryWithPool<{ token: string }>(
      fastify.apiPool,
      `INSERT INTO platform.magic_links (user_id, email, expires_at, ip_address)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3::inet)
       RETURNING token`,
      [user.id, trimmedEmail, request.ip],
    );

    const token = linkResult.rows[0]!.token;

    // Send magic link email
    const emailSent = await sendMagicLinkEmail(trimmedEmail, token, language || 'en');
    if (!emailSent) {
      logger.warn({ email: trimmedEmail }, 'Magic link created but email failed to send');
    }

    // Also create email channel entry if not exists
    await queryWithPool(
      fastify.apiPool,
      `INSERT INTO platform.user_channels (user_id, channel, channel_address, is_verified, is_default)
       VALUES ($1, 'email', $2, $3, true)
       ON CONFLICT (user_id, channel, channel_address) DO NOTHING`,
      [user.id, trimmedEmail, user.email_verified],
    );

    return reply.send({
      success: true,
      message: 'Magic link sent to your email. Check your inbox.',
    });
  });

  // ─── GET /api/v1/auth/verify/:token ───
  // Verify magic link and create session
  fastify.get<{ Params: VerifyParams }>('/api/v1/auth/verify/:token', {
    schema: {
      params: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            session_token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                email: { type: 'string' },
                display_name: { type: 'string' },
                role: { type: 'string' },
                language: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params;

    // Find and validate magic link
    const linkResult = await queryWithPool<{
      id: number; user_id: number | null; email: string; expires_at: Date; used_at: Date | null;
    }>(
      fastify.apiPool,
      `SELECT id, user_id, email, expires_at, used_at
       FROM platform.magic_links
       WHERE token = $1`,
      [token],
    );

    if (linkResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Invalid or expired link' });
    }

    const link = linkResult.rows[0]!;

    if (link.used_at) {
      return reply.status(410).send({ error: 'This link has already been used' });
    }

    if (new Date(link.expires_at) < new Date()) {
      return reply.status(410).send({ error: 'This link has expired. Please request a new one.' });
    }

    // Mark link as used
    await queryWithPool(
      fastify.apiPool,
      `UPDATE platform.magic_links SET used_at = NOW() WHERE id = $1`,
      [link.id],
    );

    // Get or create user
    let userId = link.user_id;
    if (!userId) {
      // User was created between magic link request and verification (edge case)
      const userResult = await queryWithPool<{ id: number }>(
        fastify.apiPool,
        `SELECT id FROM platform.users WHERE email = $1`,
        [link.email],
      );
      if (userResult.rows.length === 0) {
        return reply.status(500).send({ error: 'User not found' });
      }
      userId = userResult.rows[0]!.id;
    }

    // Mark email as verified & update login stats
    await queryWithPool(
      fastify.apiPool,
      `UPDATE platform.users
       SET email_verified = true, last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );

    // Mark email channel as verified
    await queryWithPool(
      fastify.apiPool,
      `UPDATE platform.user_channels
       SET is_verified = true, verified_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND channel = 'email'`,
      [userId],
    );

    // Create session (30 days)
    const sessionResult = await queryWithPool<{ token: string }>(
      fastify.apiPool,
      `INSERT INTO platform.sessions (user_id, ip_address, user_agent, expires_at)
       VALUES ($1, $2::inet, $3, NOW() + INTERVAL '30 days')
       RETURNING token`,
      [userId, request.ip, request.headers['user-agent'] || null],
    );

    const sessionToken = sessionResult.rows[0]!.token;

    // Fetch user data
    const userResult = await queryWithPool<{
      id: number; email: string; display_name: string | null; role: string; language: string;
    }>(
      fastify.apiPool,
      `SELECT id, email, display_name, role, language FROM platform.users WHERE id = $1`,
      [userId],
    );

    const user = userResult.rows[0]!;

    logger.info({ userId, email: user.email }, 'User verified and logged in');

    return reply.send({
      success: true,
      session_token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        language: user.language,
      },
    });
  });

  // ─── GET /api/v1/auth/me ───
  // Get current user from session token
  fastify.get('/api/v1/auth/me', async (request, reply) => {
    // Extract session token from Authorization header
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const sessionToken = authHeader.slice(7);

    // Validate session
    const sessionResult = await queryWithPool<{ user_id: number; expires_at: Date }>(
      fastify.apiPool,
      `SELECT user_id, expires_at FROM platform.sessions WHERE token = $1`,
      [sessionToken],
    );

    if (sessionResult.rows.length === 0) {
      return reply.status(401).send({ error: 'Invalid session' });
    }

    const session = sessionResult.rows[0]!;
    if (new Date(session.expires_at) < new Date()) {
      return reply.status(401).send({ error: 'Session expired. Please log in again.' });
    }

    // Fetch user
    const userResult = await queryWithPool<{
      id: number; email: string; display_name: string | null; role: string;
      language: string; email_verified: boolean; created_at: Date;
    }>(
      fastify.apiPool,
      `SELECT id, email, display_name, role, language, email_verified, created_at
       FROM platform.users WHERE id = $1 AND is_active = true`,
      [session.user_id],
    );

    if (userResult.rows.length === 0) {
      return reply.status(401).send({ error: 'User not found or deactivated' });
    }

    const user = userResult.rows[0]!;

    // Fetch user channels
    const channelsResult = await queryWithPool<{
      channel: string; channel_address: string; is_verified: boolean; is_default: boolean;
    }>(
      fastify.apiPool,
      `SELECT channel, channel_address, is_verified, is_default
       FROM platform.user_channels WHERE user_id = $1 ORDER BY is_default DESC, channel`,
      [user.id],
    );

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        language: user.language,
        email_verified: user.email_verified,
        created_at: user.created_at,
      },
      channels: channelsResult.rows,
    });
  });

  // ─── POST /api/v1/auth/logout ───
  // Invalidate session
  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization header' });
    }

    const sessionToken = authHeader.slice(7);

    await queryWithPool(
      fastify.apiPool,
      `DELETE FROM platform.sessions WHERE token = $1`,
      [sessionToken],
    );

    return reply.send({ success: true });
  });
}
