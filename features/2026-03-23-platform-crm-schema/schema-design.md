# CRM / Platform Users Schema — Plan

## Context

The platform currently has no user system — all APIs are public and the only "user" concept is anonymous signal subscriptions by email/Telegram. We need a proper CRM module to support:
1. **User accounts** (registration, login via magic link)
2. **Watchlists** (save favorite markets)
3. **Alert preferences** (custom arb thresholds, specific markets)
4. **Contact/lead tracking** (for B2B outreach later)

Auth method: **Email magic link** (no passwords). Wallet connection deferred until trading/paid features.

## Schema: `platform`

New schema in the same PostgreSQL database. Separate from `direct_exchanges_data` (market data) for clean isolation, but can JOIN across schemas when needed.

```sql
CREATE SCHEMA IF NOT EXISTS platform;
```

---

## Tables

### 1. `platform.users` — Core user accounts

```sql
CREATE TABLE platform.users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  display_name  VARCHAR(100),
  avatar_url    TEXT,
  role          VARCHAR(20) NOT NULL DEFAULT 'user',  -- user, pro, admin
  is_active     BOOLEAN NOT NULL DEFAULT true,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  language      VARCHAR(5) DEFAULT 'en',              -- en, zh
  timezone      VARCHAR(50),
  last_login_at TIMESTAMPTZ,
  login_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON platform.users(email);
CREATE INDEX idx_users_role ON platform.users(role);
```

### 2. `platform.magic_links` — Passwordless auth tokens

```sql
CREATE TABLE platform.magic_links (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES platform.users(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,             -- for new users (user_id may be null)
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,              -- typically NOW() + 15 minutes
  used_at     TIMESTAMPTZ,                       -- null = unused
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_magic_links_token ON platform.magic_links(token);
CREATE INDEX idx_magic_links_email ON platform.magic_links(email);
```

### 3. `platform.sessions` — Active login sessions

```sql
CREATE TABLE platform.sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ip_address  INET,
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,              -- typically NOW() + 30 days
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON platform.sessions(token);
CREATE INDEX idx_sessions_user ON platform.sessions(user_id);
```

### 4. `platform.watchlists` — Saved favorite markets

```sql
CREATE TABLE platform.watchlists (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  canonical_market_id   VARCHAR(100) NOT NULL,    -- references direct_exchanges_data.market_mappings
  canonical_event_id    VARCHAR(100),             -- optional, for event-level watching
  notes                 TEXT,                     -- user's personal notes
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, canonical_market_id)
);

CREATE INDEX idx_watchlists_user ON platform.watchlists(user_id);
```

### 5. `platform.alerts` — Custom alert configurations

```sql
CREATE TABLE platform.alerts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type            VARCHAR(30) NOT NULL,     -- arb_threshold, price_move, new_market, whale_trade, volume_spike
  canonical_market_id   VARCHAR(100),             -- null = global alert (all markets)
  category              VARCHAR(50),              -- null = all categories
  config                JSONB NOT NULL DEFAULT '{}',
  -- config examples:
  -- arb_threshold:  {"min_spread_pct": 0.03, "min_profit_usd": 10}
  -- price_move:     {"direction": "up", "threshold_pct": 0.05, "timeframe_min": 60}
  -- whale_trade:    {"min_qty": 1000}
  -- volume_spike:   {"multiplier": 3}
  channel               VARCHAR(20) NOT NULL DEFAULT 'email',  -- email, telegram, sms, whatsapp, discord, webhook, push
  is_active             BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at     TIMESTAMPTZ,
  trigger_count         INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes      INTEGER NOT NULL DEFAULT 60,  -- min time between triggers
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_user ON platform.alerts(user_id);
CREATE INDEX idx_alerts_type ON platform.alerts(alert_type);
CREATE INDEX idx_alerts_active ON platform.alerts(is_active) WHERE is_active = true;
```

### 6. `platform.alert_history` — Sent alert log

```sql
CREATE TABLE platform.alert_history (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    BIGINT REFERENCES platform.alerts(id) ON DELETE SET NULL,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type  VARCHAR(30) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  payload     JSONB NOT NULL,                    -- what was sent (market, spread, etc.)
  status      VARCHAR(20) NOT NULL DEFAULT 'sent', -- sent, failed, bounced
  cost_usd    NUMERIC(6,4) DEFAULT 0,            -- actual cost of this message
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_history_user ON platform.alert_history(user_id);
CREATE INDEX idx_alert_history_sent ON platform.alert_history(sent_at);
```

### 7. `platform.channel_config` — Notification channel settings & cost control

```sql
CREATE TABLE platform.channel_config (
  channel         VARCHAR(20) PRIMARY KEY,        -- email, telegram, sms, whatsapp, discord, webhook, push
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  min_role        VARCHAR(20) NOT NULL DEFAULT 'user',  -- minimum user role required (user, pro, admin)
  cost_per_msg    NUMERIC(6,4) DEFAULT 0,         -- USD cost per message (SMS ~$0.01-0.05)
  daily_limit     INTEGER,                        -- max messages per user per day (null = unlimited)
  provider        VARCHAR(50),                    -- resend, twilio, telegram-bot, discord-bot, http, web-push
  provider_config JSONB DEFAULT '{}',             -- API keys, webhook URLs, bot tokens (encrypted at rest)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data: free channels for all users, paid channels for pro+
INSERT INTO platform.channel_config (channel, is_enabled, min_role, cost_per_msg, daily_limit, provider) VALUES
  ('email',     true, 'user',  0,      50,   'resend'),
  ('telegram',  true, 'user',  0,      100,  'telegram-bot'),
  ('sms',       true, 'pro',   0.02,   10,   'twilio'),
  ('whatsapp',  true, 'pro',   0.01,   20,   'twilio'),
  ('discord',   true, 'user',  0,      100,  'discord-bot'),
  ('webhook',   true, 'pro',   0,      1000, 'http'),
  ('push',      true, 'user',  0,      50,   'web-push');
```

### 8. `platform.user_channels` — Per-user channel contact details

```sql
CREATE TABLE platform.user_channels (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL,           -- email, telegram, sms, whatsapp, discord, webhook
  channel_address VARCHAR(255) NOT NULL,           -- email address, phone number, @telegram, discord ID, webhook URL
  is_verified     BOOLEAN NOT NULL DEFAULT false,  -- verified via OTP/confirmation
  is_default      BOOLEAN NOT NULL DEFAULT false,  -- default channel for this user
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, channel, channel_address)
);

CREATE INDEX idx_user_channels_user ON platform.user_channels(user_id);
```

**Channel address examples:**
- email: `user@example.com`
- telegram: `@username` or chat ID `123456789`
- sms: `+85212345678`
- whatsapp: `+85212345678`
- discord: `user#1234` or server webhook URL
- webhook: `https://api.example.com/alerts`

### 10. `platform.contacts` — B2B lead tracking / CRM

```sql
CREATE TABLE platform.contacts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES platform.users(id),  -- null for non-registered leads
  company       VARCHAR(255),
  contact_name  VARCHAR(255),
  email         VARCHAR(255),
  phone         VARCHAR(50),
  source        VARCHAR(50),                    -- website, referral, outbound, conference
  status        VARCHAR(30) NOT NULL DEFAULT 'lead',  -- lead, contacted, qualified, customer, churned
  tier          VARCHAR(20),                    -- free, starter, pro, enterprise
  notes         TEXT,
  tags          TEXT[],                         -- ['hedge_fund', 'quant', 'asia']
  last_contact_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contacts_email ON platform.contacts(email);
CREATE INDEX idx_contacts_status ON platform.contacts(status);
```

### 11. `platform.contact_interactions` — CRM activity log

```sql
CREATE TABLE platform.contact_interactions (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT NOT NULL REFERENCES platform.contacts(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,             -- email_sent, call, meeting, demo, signup, subscription
  subject     VARCHAR(255),
  notes       TEXT,
  performed_by VARCHAR(100),                    -- admin user who logged this
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interactions_contact ON platform.contact_interactions(contact_id);
```

---

## Migration from existing `signal_subscriptions`

The existing `direct_exchanges_data.signal_subscriptions` table has anonymous subscribers. After deploying:

1. For each existing subscriber, create a `platform.users` record (email_verified = false)
2. Create corresponding `platform.alerts` records based on their `signals` JSONB
3. Keep `signal_subscriptions` as-is temporarily, deprecate after migration verified

---

## API Endpoints (new routes in homepage-api)

### Auth
- `POST /api/v1/auth/magic-link` — Send magic link to email
- `GET /api/v1/auth/verify/:token` — Verify magic link, create session, return session token
- `POST /api/v1/auth/logout` — Invalidate session
- `GET /api/v1/auth/me` — Get current user (from session token)

### Watchlist
- `GET /api/v1/watchlist` — Get user's watchlist
- `POST /api/v1/watchlist` — Add market to watchlist
- `DELETE /api/v1/watchlist/:id` — Remove from watchlist

### Alerts
- `GET /api/v1/alerts` — Get user's alerts
- `POST /api/v1/alerts` — Create alert
- `PUT /api/v1/alerts/:id` — Update alert
- `DELETE /api/v1/alerts/:id` — Delete alert
- `GET /api/v1/alerts/history` — Get alert history

### Auth Middleware
New Fastify middleware: extract session token from `Authorization: Bearer <token>` header, validate against `platform.sessions`, attach `user` to request.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `scripts/migrations/001-platform-schema.sql` | NEW — full schema creation SQL |
| `packages/shared/src/db/platform-queries.ts` | NEW — queries for platform schema |
| `packages/shared/src/db/platform-types.ts` | NEW — TypeScript types |
| `packages/homepage-api/src/middleware/auth.ts` | NEW — session auth middleware |
| `packages/homepage-api/src/routes/auth.ts` | NEW — magic link auth routes |
| `packages/homepage-api/src/routes/watchlist.ts` | NEW — watchlist CRUD |
| `packages/homepage-api/src/routes/alerts.ts` | NEW — alerts CRUD |
| `packages/homepage-api/src/services/emailService.ts` | NEW — send magic link emails |
| `packages/homepage-api/src/server.ts` | MODIFY — register new routes + auth middleware |

## Email Service

For magic links, use a simple SMTP transporter (nodemailer) or a service like:
- **Resend** (simplest, free tier = 100 emails/day)
- **SendGrid** (free tier = 100/day)
- **AWS SES** (cheapest at scale)

Start with Resend — easiest to set up, good developer experience.

## Verification

1. Run migration SQL on the DB
2. Test magic link flow: request → email → click → session created
3. Test watchlist CRUD with session token
4. Test alert creation and verify it stores correctly
5. Query `platform.users` to confirm records created
