import { createLogger } from '@prediction-market/shared';
import type { Alert, Config } from '../types.js';

const logger = createLogger('telegram');

function formatTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function getLevelEmoji(level: Alert['level']): string {
  switch (level) {
    case 'critical':
      return '🔴';
    case 'warning':
      return '🟡';
    case 'info':
      return '🟢';
    default:
      return '⚪';
  }
}

function formatAlert(alert: Alert, serverIp: string): string {
  const emoji = getLevelEmoji(alert.level);
  const levelLabel = alert.level.toUpperCase();

  let message = `${emoji} ${levelLabel}: ${alert.title}\n`;
  message += `Server: ${serverIp}\n`;
  message += `Time: ${formatTimestamp()}\n`;

  if (alert.message) {
    message += `Details: ${alert.message}`;
  }

  if (alert.details) {
    for (const [key, value] of Object.entries(alert.details)) {
      message += `\n${key}: ${value}`;
    }
  }

  return message;
}

export async function sendAlert(alert: Alert, config: Config): Promise<boolean> {
  const message = formatAlert(alert, config.serverIp);

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, error: errorText }, 'Failed to send Telegram alert');
      return false;
    }

    logger.info({ level: alert.level, title: alert.title }, 'Alert sent successfully');
    return true;
  } catch (err) {
    logger.error({ err }, 'Error sending Telegram alert');
    return false;
  }
}

export async function sendRecoveryAlert(checkName: string, config: Config): Promise<boolean> {
  return sendAlert(
    {
      level: 'info',
      title: `${checkName} recovered`,
      message: 'Issue has been resolved',
    },
    config
  );
}
