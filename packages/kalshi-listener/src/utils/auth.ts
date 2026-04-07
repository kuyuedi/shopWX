import crypto from 'crypto';
import fs from 'fs';

export interface KalshiAuthHeaders {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-SIGNATURE': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
}

export function generateAuthHeaders(
  apiKey: string,
  privateKeyPath: string,
  method: string,
  path: string
): KalshiAuthHeaders {
  const timestamp = Date.now().toString();
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

  // Message to sign: timestamp + method + path
  const message = timestamp + method + path;

  // Sign with RSA-PSS using SHA256
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

export function generateWsAuthHeaders(
  apiKey: string,
  privateKeyPath: string
): KalshiAuthHeaders {
  // For WebSocket, use GET method and the WS path
  return generateAuthHeaders(apiKey, privateKeyPath, 'GET', '/trade-api/ws/v2');
}
