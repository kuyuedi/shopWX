-- Platform CRM Schema Migration
-- Deployed: 2026-03-23
-- Schema: platform (separate from direct_exchanges_data)

CREATE SCHEMA IF NOT EXISTS platform;

-- 1. Core user accounts (magic link auth, no passwords)
CREATE TABLE IF NOT EXISTS platform.users (
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
CREATE INDEX IF NOT EXISTS idx_users_email ON platform.users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON platform.users(role);

-- 2. Passwordless auth tokens
CREATE TABLE IF NOT EXISTS platform.magic_links (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES platform.users(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_magic_links_token ON platform.magic_links(token);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON platform.magic_links(email);

-- 3. Active login sessions
CREATE TABLE IF NOT EXISTS platform.sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ip_address  INET,
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON platform.sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON platform.sessions(user_id);

-- 4. Saved favorite markets
CREATE TABLE IF NOT EXISTS platform.watchlists (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  canonical_market_id   VARCHAR(100) NOT NULL,
  canonical_event_id    VARCHAR(100),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, canonical_market_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON platform.watchlists(user_id);

-- 5. Custom alert configurations
CREATE TABLE IF NOT EXISTS platform.alerts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type            VARCHAR(30) NOT NULL,
  canonical_market_id   VARCHAR(100),
  category              VARCHAR(50),
  config                JSONB NOT NULL DEFAULT '{}',
  channel               VARCHAR(20) NOT NULL DEFAULT 'email',
  is_active             BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at     TIMESTAMPTZ,
  trigger_count         INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes      INTEGER NOT NULL DEFAULT 60,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON platform.alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON platform.alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON platform.alerts(is_active) WHERE is_active = true;

-- 6. Sent alert log with cost tracking
CREATE TABLE IF NOT EXISTS platform.alert_history (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    BIGINT REFERENCES platform.alerts(id) ON DELETE SET NULL,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type  VARCHAR(30) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  payload     JSONB NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'sent',
  cost_usd    NUMERIC(6,4) DEFAULT 0,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_history_user ON platform.alert_history(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_sent ON platform.alert_history(sent_at);

-- 7. Notification channel settings & cost control
CREATE TABLE IF NOT EXISTS platform.channel_config (
  channel         VARCHAR(20) PRIMARY KEY,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  min_role        VARCHAR(20) NOT NULL DEFAULT 'user',
  cost_per_msg    NUMERIC(6,4) DEFAULT 0,
  daily_limit     INTEGER,
  provider        VARCHAR(50),
  provider_config JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform.channel_config (channel, is_enabled, min_role, cost_per_msg, daily_limit, provider) VALUES
  ('email',     true, 'user',  0,      50,   'resend'),
  ('telegram',  true, 'user',  0,      100,  'telegram-bot'),
  ('sms',       true, 'pro',   0.02,   10,   'twilio'),
  ('whatsapp',  true, 'pro',   0.01,   20,   'twilio'),
  ('discord',   true, 'user',  0,      100,  'discord-bot'),
  ('webhook',   true, 'pro',   0,      1000, 'http'),
  ('push',      true, 'user',  0,      50,   'web-push')
ON CONFLICT (channel) DO NOTHING;

-- 8. Per-user channel contact details
CREATE TABLE IF NOT EXISTS platform.user_channels (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL,
  channel_address VARCHAR(255) NOT NULL,
  is_verified     BOOLEAN NOT NULL DEFAULT false,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, channel, channel_address)
);
CREATE INDEX IF NOT EXISTS idx_user_channels_user ON platform.user_channels(user_id);

-- 9. B2B lead tracking / CRM
CREATE TABLE IF NOT EXISTS platform.contacts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES platform.users(id),
  company       VARCHAR(255),
  contact_name  VARCHAR(255),
  email         VARCHAR(255),
  phone         VARCHAR(50),
  source        VARCHAR(50),
  status        VARCHAR(30) NOT NULL DEFAULT 'lead',
  tier          VARCHAR(20),
  notes         TEXT,
  tags          TEXT[],
  last_contact_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON platform.contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON platform.contacts(status);

-- 10. CRM activity log
CREATE TABLE IF NOT EXISTS platform.contact_interactions (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT NOT NULL REFERENCES platform.contacts(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,
  subject     VARCHAR(255),
  notes       TEXT,
  performed_by VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON platform.contact_interactions(contact_id);
