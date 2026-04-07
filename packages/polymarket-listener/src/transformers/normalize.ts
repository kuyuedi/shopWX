import {
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
  type NormalizedMarket,
  type NormalizedOrderBook,
  type NormalizedTrade,
} from '@prediction-market/shared';

export interface PolymarketMarket {
  id: string;
  question: string;
  description?: string;
  category?: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  endDateIso?: string;
  endDate?: string;
  // Token IDs and outcomes are JSON strings
  clobTokenIds?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  liquidity?: string;
  liquidityNum?: number;
  conditionId?: string;
  groupItemTitle?: string;
}

export function normalizeMarket(market: PolymarketMarket): NormalizedMarket[] {
  const results: NormalizedMarket[] = [];

  // Parse the JSON strings
  let tokenIds: string[] = [];
  let outcomes: string[] = [];
  let prices: string[] = [];

  try {
    if (market.clobTokenIds) {
      tokenIds = JSON.parse(market.clobTokenIds);
    }
    if (market.outcomes) {
      outcomes = JSON.parse(market.outcomes);
    }
    if (market.outcomePrices) {
      prices = JSON.parse(market.outcomePrices);
    }
  } catch {
    // If parsing fails, skip this market
    return results;
  }

  // Skip non-binary markets (outcomes not ["Yes","No"])
  const hasYes = outcomes.some(o => o?.toUpperCase() === 'YES');
  const hasNo = outcomes.some(o => o?.toUpperCase() === 'NO');
  if (!hasYes || !hasNo) {
    return results;
  }

  // Create a market entry for each token/outcome
  for (let i = 0; i < tokenIds.length && i < outcomes.length; i++) {
    const tokenId = tokenIds[i];
    const outcome = outcomes[i];
    const priceStr = prices[i];
    const price = priceStr ? parseFloat(priceStr) : undefined;

    if (!tokenId) continue;

    results.push({
      sourceId: POLYMARKET_SOURCE_ID,
      exchangeId: POLYMARKET_EXCHANGE_ID,
      marketId: tokenId,
      eventId: market.id,
      outcomeSide: outcome?.toUpperCase() === 'YES' ? 'YES' : 'NO',
      marketName: market.question,
      subTitle: market.groupItemTitle,
      rulesPrimary: market.description,
      category: market.category,
      price: price,
      endDate: market.endDateIso ? new Date(market.endDateIso) :
               market.endDate ? new Date(market.endDate) : undefined,
      status: market.closed ? 'Closed' : market.active ? 'Open' : 'Cancelled',
      sourceSpecificData: {
        condition_id: market.conditionId || market.id,
        volume: market.volumeNum,
        liquidity: market.liquidityNum,
      },
    });
  }

  return results;
}

export function normalizeOrderBook(
  assetId: string,
  bids: Array<{ price: string; size: string }>,
  asks: Array<{ price: string; size: string }>
): NormalizedOrderBook {
  return {
    sourceId: POLYMARKET_SOURCE_ID,
    exchangeId: POLYMARKET_EXCHANGE_ID,
    marketId: assetId,
    bids: bids.map((b) => ({ price: parseFloat(b.price), quantity: parseFloat(b.size) })),
    asks: asks.map((a) => ({ price: parseFloat(a.price), quantity: parseFloat(a.size) })),
    timestamp: new Date(),
  };
}

export function normalizeTrade(
  assetId: string,
  price: number,
  size: number,
  side?: string
): NormalizedTrade {
  // Normalize side to title case ('Buy'/'Sell') to match DB constraint
  const normalizedSide = side?.toUpperCase() === 'BUY' ? 'Buy' as const :
                         side?.toUpperCase() === 'SELL' ? 'Sell' as const : undefined;
  return {
    sourceId: POLYMARKET_SOURCE_ID,
    exchangeId: POLYMARKET_EXCHANGE_ID,
    marketId: assetId,
    price,
    quantity: size,
    side: normalizedSide,
    timestamp: new Date(),
  };
}
