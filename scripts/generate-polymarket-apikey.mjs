/**
 * 生成 Polymarket CLOB API Key（使用官方 SDK）
 * 用法：node scripts/generate-polymarket-apikey.mjs <钱包私钥>
 */

import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main() {
  const privateKey = process.argv[2];
  if (!privateKey) {
    console.error('用法：node scripts/generate-polymarket-apikey.mjs <私钥>');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  console.log('钱包地址：', wallet.address);

  // 适配 ethers v6 签名接口
  const signer = {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (domain, types, value) =>
      wallet.signTypedData(domain, types, value),
  };

  const client = new ClobClient(CLOB_URL, CHAIN_ID, signer);

  try {
    const creds = await client.createOrDeriveApiKey();
    console.log('\n✅ 生成成功，请保存以下信息到 .env：\n');
    console.log(`POLYMARKET_API_KEY=${creds.key}`);
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
    console.log(`POLYMARKET_PRIVATE_KEY=${privateKey}`);
  } catch (err) {
    console.error('生成失败：', err.message);
    process.exit(1);
  }
}

main();
