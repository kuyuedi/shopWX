import crypto from 'crypto';
import fs from 'fs';

// Kalshi RSA-PSS 签名认证头接口
export interface KalshiAuthHeaders {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-SIGNATURE': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
  [key: string]: string;
}

/**
 * 生成 Kalshi API 认证头
 * 使用 RSA-PSS + SHA256 对 timestamp+method+path 进行签名
 *
 * @param apiKey - Kalshi API Key
 * @param privateKeyPath - RSA 私钥文件路径
 * @param method - HTTP 方法（GET、POST 等），必须大写
 * @param path - 请求路径（不含 base URL 和 query string），例如 /trade-api/v2/portfolio/orders
 */
export function generateAuthHeaders(
  apiKey: string,
  privateKeyPath: string,
  method: string,
  path: string
): KalshiAuthHeaders {
  const timestamp = Date.now().toString();
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

  // 签名内容：时间戳 + HTTP 方法 + 请求路径
  const message = timestamp + method + path;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64'
  );

  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
  };
}
