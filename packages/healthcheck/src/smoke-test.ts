import 'dotenv/config';
import { createLogger, closePool } from '@prediction-market/shared';
import { runSmokeTests, formatSmokeTestMessage } from './checks/smokeTest.js';

const logger = createLogger('smoke-test-cli');

interface TelegramConfig {
  botToken: string;
  chatId: string;
  serverIp: string;
}

function getConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }
  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID environment variable is required');
  }

  return {
    botToken,
    chatId,
    serverIp: process.env.SERVER_IP || '8.216.43.26',
  };
}

async function sendTelegramMessage(message: string, config: TelegramConfig): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, error: errorText }, 'Failed to send Telegram message');
      return false;
    }

    logger.info('Smoke test results sent to Telegram');
    return true;
  } catch (err) {
    logger.error({ err }, 'Error sending Telegram message');
    return false;
  }
}

async function main(): Promise<void> {
  logger.info('Starting deployment smoke tests');

  try {
    const config = getConfig();

    // Run smoke tests
    const summary = await runSmokeTests();

    // Format message for Telegram
    const message = formatSmokeTestMessage(summary, config.serverIp);

    // Print results to console
    console.log('\n=== Smoke Test Results ===\n');
    for (const result of summary.results) {
      const emoji = result.passed ? '✅' : '❌';
      console.log(`${emoji} ${result.name}: ${result.message}`);
      if (result.details && Object.keys(result.details).length > 0) {
        console.log(`   Details: ${JSON.stringify(result.details)}`);
      }
    }
    console.log(`\nOverall: ${summary.passed}/${summary.totalTests} tests passed`);

    // Send to Telegram
    await sendTelegramMessage(message, config);

    // Close database pool
    await closePool();

    // Exit with appropriate code
    if (!summary.overallPassed) {
      logger.warn({ failed: summary.failed }, 'Some smoke tests failed');
      process.exit(1);
    }

    logger.info('All smoke tests passed');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Fatal error running smoke tests');
    await closePool();
    process.exit(1);
  }
}

main();
