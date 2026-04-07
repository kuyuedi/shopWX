import type { Config } from './types.js';

export function getConfig(): Config {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (!telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }
  if (!telegramChatId) {
    throw new Error('TELEGRAM_CHAT_ID environment variable is required');
  }

  return {
    telegramBotToken,
    telegramChatId,
    intervalMs: parseInt(process.env.HEALTHCHECK_INTERVAL_MS || '60000', 10),
    diskWarningThreshold: parseInt(process.env.DISK_WARNING_THRESHOLD || '70', 10),
    diskCriticalThreshold: parseInt(process.env.DISK_CRITICAL_THRESHOLD || '85', 10),
    dataFlowMinRecords: parseInt(process.env.DATA_FLOW_MIN_RECORDS || '100', 10),
    dataFlowCheckMinutes: parseInt(process.env.DATA_FLOW_CHECK_MINUTES || '5', 10),
    alertCooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || '300000', 10), // 5 minutes
    serverIp: process.env.SERVER_IP || '8.216.43.26',
  };
}
