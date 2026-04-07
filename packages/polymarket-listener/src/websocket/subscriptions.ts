export type PolymarketSubscriptionType = 'market' | 'user';

export interface PolymarketSubscription {
  type: PolymarketSubscriptionType;
  assetIds: string[];
}

export interface PolymarketSubscriptionMessage {
  type: PolymarketSubscriptionType;
  assets_ids: string[];
}

export function createMarketSubscription(assetIds: string[]): PolymarketSubscription {
  return {
    type: 'market',
    assetIds,
  };
}

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
