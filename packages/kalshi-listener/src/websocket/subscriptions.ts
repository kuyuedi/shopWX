export type KalshiChannel = 'ticker' | 'orderbook_delta' | 'trade' | 'fill';

export interface KalshiSubscription {
  channel: KalshiChannel;
  ticker: string;
}

export interface KalshiSubscriptionMessage {
  id: number;
  cmd: 'subscribe' | 'unsubscribe';
  params: {
    channels: KalshiChannel[];
    market_tickers?: string[];
  };
}

export function getSubscriptionMessage(
  subscription: KalshiSubscription,
  id: number
): KalshiSubscriptionMessage {
  return {
    id,
    cmd: 'subscribe',
    params: {
      channels: [subscription.channel],
      market_tickers: [subscription.ticker],
    },
  };
}

export function getUnsubscriptionMessage(
  subscription: KalshiSubscription,
  id: number
): KalshiSubscriptionMessage {
  return {
    id,
    cmd: 'unsubscribe',
    params: {
      channels: [subscription.channel],
      market_tickers: [subscription.ticker],
    },
  };
}

export function getBatchSubscriptionMessage(
  tickers: string[],
  channels: KalshiChannel[],
  id: number
): KalshiSubscriptionMessage {
  return {
    id,
    cmd: 'subscribe',
    params: {
      channels,
      market_tickers: tickers,
    },
  };
}

export function getBatchUnsubscriptionMessage(
  tickers: string[],
  channels: KalshiChannel[],
  id: number
): KalshiSubscriptionMessage {
  return {
    id,
    cmd: 'unsubscribe',
    params: {
      channels,
      market_tickers: tickers,
    },
  };
}
