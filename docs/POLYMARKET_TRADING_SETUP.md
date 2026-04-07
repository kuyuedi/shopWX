# Polymarket 交易接口配置指南

## 前提条件

- 已有 Polymarket 账户
- 账户绑定了以太坊钱包（MetaMask 等）
- 钱包在 Polygon 链上有 USDC 余额

---

## 第一步：导出钱包私钥

1. 打开 MetaMask
2. 点击右上角三个点 → **账户详情**
3. 点击 **导出私钥**
4. 输入 MetaMask 密码确认
5. 复制私钥（格式：`0x` 开头的 64 位十六进制字符串）

> ⚠️ 私钥是最高权限凭据，不要泄露给任何人，不要提交到 git

---

## 第二步：生成 CLOB API Key

Polymarket 交易接口（CLOB）需要独立的 API Key，通过钱包私钥签名生成。

### 安装依赖

在 `prediction-main` 目录下运行：

```bash
pnpm add -w ethers
```

### 运行生成脚本

```bash
node scripts/generate-polymarket-apikey.mjs 0x你的私钥
```

### 输出示例

```
钱包地址： 0xAbCd...

✅ 生成成功，请保存以下信息到 .env：

POLYMARKET_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
POLYMARKET_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POLYMARKET_API_PASSPHRASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POLYMARKET_WALLET_ADDRESS=0xAbCd...
```

---

## 第三步：配置 .env

将上一步输出的四个变量添加到 `prediction-main/.env`：

```env
POLYMARKET_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
POLYMARKET_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POLYMARKET_API_PASSPHRASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
POLYMARKET_WALLET_ADDRESS=0xAbCd...
POLYMARKET_PRIVATE_KEY=0x你的私钥
```

---

## 接口说明

配置完成后，以下接口可用：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/v1/polymarket/balance` | GET | 查询 USDC 余额 |
| `/api/v1/polymarket/orders` | POST | 下单 |
| `/api/v1/polymarket/orders` | GET | 查询订单列表 |
| `/api/v1/polymarket/orders/:orderId` | GET | 查询单个订单 |
| `/api/v1/polymarket/positions` | GET | 查询持仓 |

---

## 注意事项

- Polymarket 使用 **Polygon 链上的 USDC**，不是以太坊主网
- 下单前需确保钱包已在 Polygon 链上授权 CLOB 合约
- API Key 有效期为 24 小时，过期需重新生成
- 与 Kalshi 不同，Polymarket 价格单位为 **0-1 的小数**（如 0.65 表示 65 美分）
