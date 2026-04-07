import nodemailer from 'nodemailer';
import { createLogger, query } from '@prediction-market/shared';

const logger = createLogger('email-service');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtpdm-ap-southeast-1.aliyun.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true, // SSL
  auth: {
    user: process.env.SMTP_USER || 'noreply@notify.17b.com',
    pass: process.env.SMTP_PASS || 'HKnoreply17b',
  },
});

const FROM_ADDRESS = process.env.SMTP_FROM || 'noreply@notify.17b.com';
const FROM_NAME = '17B';
const BASE_URL = process.env.BASE_URL || 'https://markets.17b.com';

/**
 * Send a magic link email for passwordless login.
 */
export async function sendMagicLinkEmail(
  to: string,
  token: string,
  language: string = 'en'
): Promise<boolean> {
  const verifyUrl = `${BASE_URL}/auth/verify/${token}`;

  const isZh = language === 'zh';

  const subject = isZh
    ? '17B 登录验证链接'
    : 'Your 17B Login Link';

  const html = isZh ? `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0a0e17; color: #e2e8f0; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <span style="font-family: monospace; font-size: 28px; font-weight: 700; color: #22d3ee; letter-spacing: -1px;">17B</span>
      </div>
      <h2 style="color: #f1f5f9; font-size: 20px; margin-bottom: 8px;">登录 17B</h2>
      <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        点击下方按钮登录您的 17B 账户。此链接将在 15 分钟后过期。
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 14px 40px; background: #22d3ee; color: #000; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 8px;">
          登录 17B
        </a>
      </div>
      <p style="color: #64748b; font-size: 12px; line-height: 1.5;">
        如果您没有请求此链接，请忽略此邮件。
      </p>
      <p style="color: #475569; font-size: 11px; margin-top: 24px; padding-top: 16px; border-top: 1px solid #1e293b;">
        如果按钮无法点击，请复制以下链接到浏览器：<br/>
        <a href="${verifyUrl}" style="color: #22d3ee; word-break: break-all;">${verifyUrl}</a>
      </p>
    </div>
  ` : `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0a0e17; color: #e2e8f0; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <span style="font-family: monospace; font-size: 28px; font-weight: 700; color: #22d3ee; letter-spacing: -1px;">17B</span>
      </div>
      <h2 style="color: #f1f5f9; font-size: 20px; margin-bottom: 8px;">Sign in to 17B</h2>
      <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        Click the button below to sign in to your 17B account. This link expires in 15 minutes.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 14px 40px; background: #22d3ee; color: #000; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 8px;">
          Sign in to 17B
        </a>
      </div>
      <p style="color: #64748b; font-size: 12px; line-height: 1.5;">
        If you didn't request this link, you can safely ignore this email.
      </p>
      <p style="color: #475569; font-size: 11px; margin-top: 24px; padding-top: 16px; border-top: 1px solid #1e293b;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${verifyUrl}" style="color: #22d3ee; word-break: break-all;">${verifyUrl}</a>
      </p>
    </div>
  `;

  try {
    const result = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
    });

    logger.info({ to, messageId: result.messageId }, 'Magic link email sent');
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Failed to send magic link email');
    return false;
  }
}

// ── Arb Digest Email ──

interface ArbDigestData {
  market_title: string;
  arb_type: string;
  gross_spread_pct: number;
  gross_profit: number;
  executable_qty: number;
  leg1_exchange_id: string;
  leg1_action: string;
  leg1_side: string;
  leg1_vwap: number;
  leg2_exchange_id: string;
  leg2_action: string;
  leg2_side: string;
  leg2_vwap: number;
  category: string;
  detected_at: Date;
}

/**
 * Fetch the best active arb opportunity (highest spread, >= 3% gross).
 */
async function fetchBestActiveArb(): Promise<ArbDigestData | null> {
  const sql = `
    SELECT market_title, arb_type, gross_spread_pct, gross_profit, executable_qty,
      leg1_exchange_id, leg1_action, leg1_side, leg1_vwap,
      leg2_exchange_id, leg2_action, leg2_side, leg2_vwap,
      category, detected_at
    FROM direct_exchanges_data.arb_opportunities
    WHERE status = 'ACTIVE'
      AND gross_spread_pct >= 0.03
    ORDER BY gross_spread_pct DESC
    LIMIT 1
  `;
  const result = await query<ArbDigestData>(sql);
  return result.rows[0] || null;
}

/**
 * Build the arb digest HTML email (supports EN and ZH).
 */
function buildArbDigestHtml(arb: ArbDigestData, language: string = 'en'): string {
  const isZh = language === 'zh';
  const spreadPct = (arb.gross_spread_pct * 100).toFixed(1);
  const leg1Price = (Number(arb.leg1_vwap) * 100).toFixed(0);
  const leg2Price = (Number(arb.leg2_vwap) * 100).toFixed(0);
  const profit = Number(arb.gross_profit).toFixed(2);
  const qty = Math.round(Number(arb.executable_qty));
  const arbUrl = `${BASE_URL}/arbitrage`;

  const exchangeColor = (ex: string) => ex === 'KALSHI' ? '#3b82f6' : '#8b5cf6';
  const exchangeName = (ex: string) => ex === 'KALSHI' ? 'Kalshi' : ex === 'POLYMARKET' ? 'Polymarket' : ex;

  // i18n labels
  const t = {
    arbAlert: isZh ? '套利提醒' : 'Arb Alert',
    grossSpread: isZh ? '毛利差' : 'Gross Spread',
    complementArb: isZh ? '互补套利' : 'Complement Arb',
    directArb: isZh ? '直接套利' : 'Direct Arb',
    estProfit: isZh ? '预估利润' : 'Est. Profit',
    quantity: isZh ? '数量' : 'Quantity',
    spread: isZh ? '利差' : 'Spread',
    viewLive: isZh ? '在 17B 上查看实时行情 →' : 'View Live on 17B →',
    disclaimer: isZh
      ? '套利机会具有时效性，查看时可能已不存在。所示价格为检测时的价格，交易前请务必核实当前价格。'
      : 'Arb opportunities are time-sensitive and may no longer be available when you view them. Prices shown are from the time of detection. Always verify current prices before trading.',
    subscribed: isZh
      ? '您收到此邮件是因为您在 17B 上订阅了套利提醒。'
      : 'You\'re receiving this because you subscribed to arb alerts on',
    unsubscribe: isZh ? '取消订阅' : 'Unsubscribe',
  };

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 0; background: #0a0e17; border-radius: 12px; overflow: hidden;">

      <!-- Header -->
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 28px 24px 20px;">
        <div style="text-align: center; margin-bottom: 16px;">
          <span style="font-family: monospace; font-size: 24px; font-weight: 700; color: #22d3ee; letter-spacing: -1px;">17B</span>
          <span style="color: #475569; font-size: 13px; margin-left: 8px;">${t.arbAlert}</span>
        </div>
        <div style="text-align: center;">
          <span style="display: inline-block; background: #22d3ee; color: #000; font-size: 28px; font-weight: 800; padding: 4px 16px; border-radius: 8px; font-family: 'SF Mono', Monaco, monospace;">
            ${spreadPct}%
          </span>
          <div style="color: #94a3b8; font-size: 12px; margin-top: 6px; text-transform: uppercase; letter-spacing: 1px;">${t.grossSpread}</div>
        </div>
      </div>

      <!-- Market Title -->
      <div style="padding: 20px 24px 0;">
        <div style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">
          ${arb.category || 'Market'} &bull; ${arb.arb_type === 'COMPLEMENT' ? t.complementArb : t.directArb}
        </div>
        <h2 style="color: #f1f5f9; font-size: 17px; font-weight: 600; margin: 0 0 16px; line-height: 1.4;">
          ${arb.market_title}
        </h2>
      </div>

      <!-- Legs -->
      <div style="padding: 0 24px;">
        <!-- Leg 1 -->
        <div style="background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td style="vertical-align: middle;">
              <span style="display: inline-block; background: ${exchangeColor(arb.leg1_exchange_id)}; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
                ${exchangeName(arb.leg1_exchange_id)}
              </span>
              <span style="color: #94a3b8; font-size: 13px; margin-left: 8px;">
                ${arb.leg1_action} ${arb.leg1_side}
              </span>
            </td>
            <td style="vertical-align: middle; text-align: right;">
              <span style="color: #22d3ee; font-size: 22px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace;">
                ${leg1Price}&cent;
              </span>
            </td>
          </tr></table>
        </div>

        <!-- Arrow -->
        <div style="text-align: center; color: #475569; font-size: 16px; margin: 2px 0;">&#x2195;</div>

        <!-- Leg 2 -->
        <div style="background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td style="vertical-align: middle;">
              <span style="display: inline-block; background: ${exchangeColor(arb.leg2_exchange_id)}; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
                ${exchangeName(arb.leg2_exchange_id)}
              </span>
              <span style="color: #94a3b8; font-size: 13px; margin-left: 8px;">
                ${arb.leg2_action} ${arb.leg2_side}
              </span>
            </td>
            <td style="vertical-align: middle; text-align: right;">
              <span style="color: #22d3ee; font-size: 22px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace;">
                ${leg2Price}&cent;
              </span>
            </td>
          </tr></table>
        </div>
      </div>

      <!-- Stats Row -->
      <div style="padding: 0 24px 20px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #0f172a; border-radius: 8px;"><tr>
          <td style="text-align: center; padding: 12px 8px;">
            <div style="color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${t.estProfit}</div>
            <div style="color: #4ade80; font-size: 16px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace;">$${profit}</div>
          </td>
          <td style="text-align: center; padding: 12px 8px;">
            <div style="color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${t.quantity}</div>
            <div style="color: #e2e8f0; font-size: 16px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace;">${qty}</div>
          </td>
          <td style="text-align: center; padding: 12px 8px;">
            <div style="color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${t.spread}</div>
            <div style="color: #22d3ee; font-size: 16px; font-weight: 700; font-family: 'SF Mono', Monaco, monospace;">${spreadPct}%</div>
          </td>
        </tr></table>
      </div>

      <!-- CTA Button -->
      <div style="padding: 0 24px 24px; text-align: center;">
        <a href="${arbUrl}" style="display: inline-block; width: 100%; padding: 14px 0; background: #22d3ee; color: #000; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 8px; text-align: center; box-sizing: border-box;">
          ${t.viewLive}
        </a>
      </div>

      <!-- Disclaimer -->
      <div style="padding: 0 24px 20px;">
        <p style="color: #475569; font-size: 11px; line-height: 1.5; margin: 0;">
          ${t.disclaimer}
        </p>
      </div>

      <!-- Footer -->
      <div style="background: #0f172a; padding: 16px 24px; border-top: 1px solid #1e293b;">
        <p style="color: #475569; font-size: 11px; margin: 0; text-align: center;">
          ${isZh ? t.subscribed : `${t.subscribed} <a href="${BASE_URL}" style="color: #22d3ee; text-decoration: none;">17B</a>.`}
          <br/>
          <a href="${BASE_URL}/unsubscribe" style="color: #64748b; text-decoration: underline;">${t.unsubscribe}</a>
        </p>
      </div>
    </div>
  `;
}

/**
 * Send the daily arb digest to a single user.
 */
export async function sendArbDigestEmail(to: string, language: string = 'en'): Promise<boolean> {
  const arb = await fetchBestActiveArb();
  if (!arb) {
    logger.debug({ to }, 'No qualifying arb for digest, skipping');
    return false;
  }

  const spreadPct = (arb.gross_spread_pct * 100).toFixed(1);
  const isZh = language === 'zh';
  const subject = isZh
    ? `${spreadPct}% 套利机会: ${arb.market_title?.substring(0, 50)}`
    : `${spreadPct}% Arb: ${arb.market_title?.substring(0, 50)}`;
  const html = buildArbDigestHtml(arb, language);

  try {
    const result = await transporter.sendMail({
      from: `"${FROM_NAME} ${isZh ? '提醒' : 'Alerts'}" <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
    });
    logger.info({ to, messageId: result.messageId, market: arb.market_title }, 'Arb digest email sent');
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Failed to send arb digest email');
    return false;
  }
}

/**
 * Send the daily arb digest to ALL subscribed users with active arb alerts.
 * Called by cron once per day.
 */
export async function sendDailyArbDigest(): Promise<{ sent: number; skipped: number; failed: number }> {
  const arb = await fetchBestActiveArb();
  if (!arb) {
    logger.info('No qualifying arb today, skipping daily digest for all users');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  // Get all users with active arb alerts via email (with language preference)
  const usersResult = await query<{ email: string; language: string }>(`
    SELECT DISTINCT u.email, COALESCE(u.language, 'en') as language
    FROM platform.users u
    JOIN platform.alerts a ON a.user_id = u.id
    WHERE a.alert_type = 'arb_threshold'
      AND a.is_active = true
      AND a.channel = 'email'
      AND u.is_active = true
      AND u.email_verified = true
  `);

  // Also include legacy signal subscribers (default to English)
  const legacyResult = await query<{ email: string }>(`
    SELECT DISTINCT email
    FROM direct_exchanges_data.signal_subscriptions
    WHERE email IS NOT NULL AND email != ''
  `);

  const emailLangMap = new Map<string, string>();
  usersResult.rows.forEach(r => emailLangMap.set(r.email, r.language));
  legacyResult.rows.forEach(r => { if (!emailLangMap.has(r.email)) emailLangMap.set(r.email, 'en'); });

  if (emailLangMap.size === 0) {
    logger.info('No subscribers for arb digest');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  // Pre-build both language versions
  const htmlEn = buildArbDigestHtml(arb, 'en');
  const htmlZh = buildArbDigestHtml(arb, 'zh');
  const spreadPct = (arb.gross_spread_pct * 100).toFixed(1);

  let sent = 0;
  let failed = 0;

  for (const [email, lang] of emailLangMap) {
    const isZh = lang === 'zh';
    const subject = isZh
      ? `${spreadPct}% 套利机会: ${arb.market_title?.substring(0, 50)}`
      : `${spreadPct}% Arb: ${arb.market_title?.substring(0, 50)}`;
    try {
      await transporter.sendMail({
        from: `"${FROM_NAME} ${isZh ? '提醒' : 'Alerts'}" <${FROM_ADDRESS}>`,
        to: email,
        subject,
        html: isZh ? htmlZh : htmlEn,
      });
      sent++;

      // Log to alert_history if user exists
      await query(`
        INSERT INTO platform.alert_history (user_id, alert_type, channel, payload, status, sent_at)
        SELECT u.id, 'arb_threshold', 'email', $1::jsonb, 'sent', NOW()
        FROM platform.users u WHERE u.email = $2
      `, [JSON.stringify({ market: arb.market_title, spread_pct: arb.gross_spread_pct }), email]);

    } catch (err) {
      logger.error({ err, email }, 'Failed to send arb digest');
      failed++;
    }
  }

  logger.info({ sent, failed, total: emailLangMap.size }, 'Daily arb digest complete');
  return { sent, skipped: 0, failed };
}
