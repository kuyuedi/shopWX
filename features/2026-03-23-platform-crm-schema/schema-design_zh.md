# CRM / 平台用户 Schema 设计

## 背景

平台目前没有用户系统 — 所有API都是公开的，唯一的"用户"概念是通过邮箱/Telegram的匿名信号订阅。我们需要一个完整的CRM模块来支持：
1. **用户账户**（注册、通过魔法链接登录）
2. **关注列表**（收藏市场）
3. **提醒偏好**（自定义套利阈值、指定市场）
4. **联系人/潜在客户跟踪**（未来B2B外联使用）

认证方式：**邮箱魔法链接**（无密码）。钱包连接推迟到交易/付费功能上线时再添加。

## Schema: `platform`

在同一个PostgreSQL数据库中创建新schema。与 `direct_exchanges_data`（市场数据）分离，但需要时可以跨schema JOIN。

```sql
CREATE SCHEMA IF NOT EXISTS platform;
```

---

## 数据表

### 1. `platform.users` — 核心用户账户

```sql
CREATE TABLE platform.users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  display_name  VARCHAR(100),
  avatar_url    TEXT,
  role          VARCHAR(20) NOT NULL DEFAULT 'user',  -- user（免费）, pro（付费）, admin（管理员）
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

### 2. `platform.magic_links` — 无密码认证令牌

```sql
CREATE TABLE platform.magic_links (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES platform.users(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,             -- 新用户时 user_id 可能为 null
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,              -- 通常 NOW() + 15分钟
  used_at     TIMESTAMPTZ,                       -- null = 未使用
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_magic_links_token ON platform.magic_links(token);
CREATE INDEX idx_magic_links_email ON platform.magic_links(email);
```

### 3. `platform.sessions` — 活跃登录会话

```sql
CREATE TABLE platform.sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ip_address  INET,
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,              -- 通常 NOW() + 30天
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON platform.sessions(token);
CREATE INDEX idx_sessions_user ON platform.sessions(user_id);
```

### 4. `platform.watchlists` — 收藏的市场

```sql
CREATE TABLE platform.watchlists (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  canonical_market_id   VARCHAR(100) NOT NULL,    -- 引用 direct_exchanges_data.market_mappings
  canonical_event_id    VARCHAR(100),             -- 可选，用于事件级关注
  notes                 TEXT,                     -- 用户的个人备注
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, canonical_market_id)
);

CREATE INDEX idx_watchlists_user ON platform.watchlists(user_id);
```

### 5. `platform.alerts` — 自定义提醒配置

```sql
CREATE TABLE platform.alerts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type            VARCHAR(30) NOT NULL,     -- arb_threshold, price_move, new_market, whale_trade, volume_spike
  canonical_market_id   VARCHAR(100),             -- null = 全局提醒（所有市场）
  category              VARCHAR(50),              -- null = 所有类别
  config                JSONB NOT NULL DEFAULT '{}',
  -- config 示例:
  -- arb_threshold:  {"min_spread_pct": 0.03, "min_profit_usd": 10}
  -- price_move:     {"direction": "up", "threshold_pct": 0.05, "timeframe_min": 60}
  -- whale_trade:    {"min_qty": 1000}
  -- volume_spike:   {"multiplier": 3}
  channel               VARCHAR(20) NOT NULL DEFAULT 'email',  -- email, telegram, sms, whatsapp, discord, webhook, push
  is_active             BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at     TIMESTAMPTZ,
  trigger_count         INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes      INTEGER NOT NULL DEFAULT 60,  -- 两次触发之间的最小间隔（分钟）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_user ON platform.alerts(user_id);
CREATE INDEX idx_alerts_type ON platform.alerts(alert_type);
CREATE INDEX idx_alerts_active ON platform.alerts(is_active) WHERE is_active = true;
```

### 6. `platform.alert_history` — 已发送提醒日志

```sql
CREATE TABLE platform.alert_history (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    BIGINT REFERENCES platform.alerts(id) ON DELETE SET NULL,
  user_id     BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  alert_type  VARCHAR(30) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  payload     JSONB NOT NULL,                    -- 发送内容（市场、价差等）
  status      VARCHAR(20) NOT NULL DEFAULT 'sent', -- sent（已发送）, failed（失败）, bounced（退回）
  cost_usd    NUMERIC(6,4) DEFAULT 0,            -- 该消息的实际成本
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_history_user ON platform.alert_history(user_id);
CREATE INDEX idx_alert_history_sent ON platform.alert_history(sent_at);
```

### 7. `platform.channel_config` — 通知渠道设置与成本控制

```sql
CREATE TABLE platform.channel_config (
  channel         VARCHAR(20) PRIMARY KEY,        -- email, telegram, sms, whatsapp, discord, webhook, push
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  min_role        VARCHAR(20) NOT NULL DEFAULT 'user',  -- 所需最低用户角色
  cost_per_msg    NUMERIC(6,4) DEFAULT 0,         -- 每条消息的美元成本（短信约$0.01-0.05）
  daily_limit     INTEGER,                        -- 每用户每日最大消息数（null = 无限制）
  provider        VARCHAR(50),                    -- resend, twilio, telegram-bot, discord-bot, http, web-push
  provider_config JSONB DEFAULT '{}',             -- API密钥、webhook URL、机器人token（静态加密）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 初始数据: 免费用户可用的免费渠道，付费渠道需要pro+
INSERT INTO platform.channel_config (channel, is_enabled, min_role, cost_per_msg, daily_limit, provider) VALUES
  ('email',     true, 'user',  0,      50,   'resend'),
  ('telegram',  true, 'user',  0,      100,  'telegram-bot'),
  ('sms',       true, 'pro',   0.02,   10,   'twilio'),
  ('whatsapp',  true, 'pro',   0.01,   20,   'twilio'),
  ('discord',   true, 'user',  0,      100,  'discord-bot'),
  ('webhook',   true, 'pro',   0,      1000, 'http'),
  ('push',      true, 'user',  0,      50,   'web-push');
```

**渠道权限按角色：**
- **免费用户 (user)**: email, telegram, discord, push
- **付费用户 (pro)**: 以上全部 + SMS ($0.02/条), WhatsApp ($0.01/条), webhook

### 8. `platform.user_channels` — 用户渠道联系信息

```sql
CREATE TABLE platform.user_channels (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL,           -- email, telegram, sms, whatsapp, discord, webhook
  channel_address VARCHAR(255) NOT NULL,           -- 邮箱地址、电话号码、@telegram、discord ID、webhook URL
  is_verified     BOOLEAN NOT NULL DEFAULT false,  -- 是否通过OTP/确认验证
  is_default      BOOLEAN NOT NULL DEFAULT false,  -- 是否为该用户的默认渠道
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, channel, channel_address)
);

CREATE INDEX idx_user_channels_user ON platform.user_channels(user_id);
```

**渠道地址示例：**
- email: `user@example.com`
- telegram: `@username` 或 chat ID `123456789`
- sms: `+85212345678`
- whatsapp: `+85212345678`
- discord: `user#1234` 或服务器 webhook URL
- webhook: `https://api.example.com/alerts`

### 9. `platform.contacts` — B2B 潜在客户跟踪

```sql
CREATE TABLE platform.contacts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES platform.users(id),  -- 未注册的潜在客户为 null
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

### 10. `platform.contact_interactions` — CRM 活动日志

```sql
CREATE TABLE platform.contact_interactions (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT NOT NULL REFERENCES platform.contacts(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,             -- email_sent, call, meeting, demo, signup, subscription
  subject     VARCHAR(255),
  notes       TEXT,
  performed_by VARCHAR(100),                    -- 记录此操作的管理员
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interactions_contact ON platform.contact_interactions(contact_id);
```

---

## 从现有 `signal_subscriptions` 迁移

现有的 `direct_exchanges_data.signal_subscriptions` 表有匿名订阅者。部署后：

1. 为每个现有订阅者创建 `platform.users` 记录（email_verified = false）
2. 根据他们的 `signals` JSONB 创建对应的 `platform.alerts` 记录
3. 暂时保留 `signal_subscriptions`，迁移验证后废弃

---

## API 端点（homepage-api 中的新路由）

### 认证
- `POST /api/v1/auth/magic-link` — 发送魔法链接到邮箱
- `GET /api/v1/auth/verify/:token` — 验证魔法链接，创建会话，返回会话token
- `POST /api/v1/auth/logout` — 使会话失效
- `GET /api/v1/auth/me` — 获取当前用户信息（从会话token）

### 关注列表
- `GET /api/v1/watchlist` — 获取用户关注列表
- `POST /api/v1/watchlist` — 添加市场到关注列表
- `DELETE /api/v1/watchlist/:id` — 从关注列表移除

### 提醒
- `GET /api/v1/alerts` — 获取用户提醒
- `POST /api/v1/alerts` — 创建提醒
- `PUT /api/v1/alerts/:id` — 更新提醒
- `DELETE /api/v1/alerts/:id` — 删除提醒
- `GET /api/v1/alerts/history` — 获取提醒历史

### 认证中间件
新的Fastify中间件：从 `Authorization: Bearer <token>` 请求头提取会话token，验证 `platform.sessions`，将 `user` 附加到请求对象。

---

## 需要创建/修改的文件

| 文件 | 操作 |
|------|------|
| `scripts/migrations/001-platform-schema.sql` | 新建 — 完整schema创建SQL |
| `packages/shared/src/db/platform-queries.ts` | 新建 — platform schema查询 |
| `packages/shared/src/db/platform-types.ts` | 新建 — TypeScript类型 |
| `packages/homepage-api/src/middleware/auth.ts` | 新建 — 会话认证中间件 |
| `packages/homepage-api/src/routes/auth.ts` | 新建 — 魔法链接认证路由 |
| `packages/homepage-api/src/routes/watchlist.ts` | 新建 — 关注列表CRUD |
| `packages/homepage-api/src/routes/alerts.ts` | 新建 — 提醒CRUD |
| `packages/homepage-api/src/services/emailService.ts` | 新建 — 发送魔法链接邮件 |
| `packages/homepage-api/src/server.ts` | 修改 — 注册新路由和认证中间件 |

## 邮件服务

魔法链接发送，使用以下服务之一：
- **Resend**（最简单，免费额度 = 100封/天）— 推荐起步
- **SendGrid**（免费额度 = 100封/天）
- **AWS SES**（大规模最便宜）
