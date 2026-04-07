import { createLogger, fetchArbConfig, fetchMatchedMarketLegs } from '@prediction-market/shared';
import type { MarketLeg } from '@prediction-market/shared';
import { refreshStaleLegs } from './orderbookRefresher.js';

const logger = createLogger('kalshi-polymarket-scanner');

// ── 核心类型定义 ─────────────────────────────────────────────────────────────

/** 套利单腿下单参数 */
export interface ArbLeg {
  /** 平台标识 */
  platform: 'KALSHI' | 'POLYMARKET';
  /** 市场标识符（Kalshi: ticker，Polymarket: token_id） */
  marketId: string;
  /** 市场标题 */
  marketTitle: string | null;
  /** 市场到期时间 */
  expiresAt: Date | null;
  /** 方向 */
  side: 'YES' | 'NO';
  /** 操作类型 */
  action: 'BUY' | 'SELL';
  /** 归一化价格（0-1 小数） */
  normalizedPrice: number;
  /** 可执行数量（份） */
  qty: number;
}

/** 套利机会报告（内存中的结构化数据） */
export interface ArbitrageReport {
  /** UUID，全局唯一 */
  arbId: string;
  /** 跨交易所市场映射唯一标识 */
  canonicalMarketId: string;
  /** 市场标题 */
  marketTitle: string | null;
  /** 套利类型 */
  arbType: 'DIRECT' | 'COMPLEMENT';
  /** 第一腿下单参数 */
  leg1: ArbLeg;
  /** 第二腿下单参数 */
  leg2: ArbLeg;
  /** 归一化毛价差（0-1） */
  grossSpread: number;
  /** 毛价差百分比 */
  grossSpreadPct: number;
  /** 可执行数量（份） */
  executableQty: number;
  /** 毛利润（美元） */
  grossProfit: number;
  /** 到期天数（COMPLEMENT 类型，null 表示无到期时间） */
  daysToExpiry: number | null;
  /** 年化收益率（COMPLEMENT 类型，null 表示无法计算） */
  apy: number | null;
  /** 第一腿数据时间戳 */
  leg1DataAt: Date;
  /** 第二腿数据时间戳 */
  leg2DataAt: Date;
  /** 扫描时间戳 */
  scannedAt: Date;
  /** 机会过期时间（scannedAt + TTL） */
  expiresAt: Date;
}

/** 一次扫描产生的套利机会列表 */
export interface ArbOpportunityList {
  /** 套利报告数组，按 grossSpreadPct 降序排列 */
  reports: ArbitrageReport[];
  /** 扫描时间戳 */
  scannedAt: Date;
  /** 机会有效期（秒） */
  opportunityTtlSec: number;
}

// ── ArbOpportunityCache 内存缓存 ──────────────────────────────────────────────

/**
 * 套利机会内存缓存
 * 每次扫描后替换全部缓存内容（不累积）
 * TTL 由 ArbitrageReport.expiresAt 字段控制
 */
export class ArbOpportunityCache {
  /** arbId → ArbitrageReport 映射 */
  private store = new Map<string, ArbitrageReport>();

  /**
   * 替换全部缓存内容（不累积）
   * @param reports 新的套利报告列表
   */
  set(reports: ArbitrageReport[]): void {
    this.store.clear();
    for (const report of reports) {
      this.store.set(report.arbId, report);
    }
  }

  /**
   * 查找指定 arbId 的报告
   * @returns 报告对象、null（不存在）或 { expired: true }（已过期）
   */
  get(arbId: string): ArbitrageReport | null | { expired: true } {
    const report = this.store.get(arbId);
    if (!report) return null;
    if (new Date() > report.expiresAt) return { expired: true };
    return report;
  }

  /**
   * 获取所有未过期的报告
   */
  getAll(): ArbitrageReport[] {
    const now = new Date();
    const result: ArbitrageReport[] = [];
    for (const report of this.store.values()) {
      if (now <= report.expiresAt) {
        result.push(report);
      }
    }
    return result;
  }
}

/** 模块级单例缓存 */
export const arbCache = new ArbOpportunityCache();

// ── 价格转换工具函数 ──────────────────────────────────────────────────────────

/**
 * 将 Kalshi 美分价格归一化为 0-1 小数
 * @param cents Kalshi 美分价格（1-99）
 * @returns 归一化价格（0-1 小数）
 */
export function normalizeKalshiPrice(cents: number): number {
  return cents / 100;
}

/**
 * 将归一化价格转换为 Kalshi 美分整数
 * @param normalized 归一化价格（0-1 小数）
 * @returns Kalshi 美分整数（取整）
 */
export function toKalshiCents(normalized: number): number {
  return Math.round(normalized * 100);
}

// ── 扫描配置 ──────────────────────────────────────────────────────────────────

/** 套利扫描配置参数（复用 arb_config 表） */
export interface ArbScanConfig {
  /** 最小套利价差百分比，默认 0.02 */
  min_arb_pct: number;
  /** 最小映射置信度，默认 0.95 */
  min_confidence: number;
  /** 最大数据陈旧时间（秒），默认 30 */
  max_staleness_sec: number;
  /** 最小可执行数量（份），默认 10 */
  min_executable_qty: number;
  /** 最小利润阈值（美元），默认 5 */
  min_liquidity_usd: number;
  /** 套利机会有效期（秒），默认 60 */
  opportunity_ttl_sec: number;
  /** REST 刷新并发数，默认 10 */
  rest_concurrency: number;
  /** REST 刷新冷却时间（秒），默认 60 */
  rest_refresh_cooldown_sec: number;
  /** REST 刷新超时（毫秒），默认 5000 */
  rest_timeout_ms: number;
  /** 两腿到期日最大允许差距（天），超过则过滤，默认 14 */
  max_expiry_diff_days: number;
}

/** 默认扫描配置 */
const DEFAULT_CONFIG: ArbScanConfig = {
  min_arb_pct: 0.02,
  min_confidence: 0.95,
  max_staleness_sec: 30,
  min_executable_qty: 10,
  min_liquidity_usd: 5,
  opportunity_ttl_sec: 60,
  rest_concurrency: 10,
  rest_refresh_cooldown_sec: 60,
  rest_timeout_ms: 5000,
  max_expiry_diff_days: 14,
};

/** 从配置 Map 中读取数字，不存在时使用默认值 */
function getConfigNum(config: Map<string, string>, key: string, fallback: number): number {
  const val = config.get(key);
  return val !== undefined ? parseFloat(val) : fallback;
}

/** 将数据库配置 Map 合并为 ArbScanConfig */
function buildConfig(dbConfig: Map<string, string>, overrides?: Partial<ArbScanConfig>): ArbScanConfig {
  return {
    min_arb_pct: getConfigNum(dbConfig, 'min_arb_pct', DEFAULT_CONFIG.min_arb_pct),
    min_confidence: getConfigNum(dbConfig, 'min_confidence', DEFAULT_CONFIG.min_confidence),
    max_staleness_sec: getConfigNum(dbConfig, 'max_staleness_sec', DEFAULT_CONFIG.max_staleness_sec),
    min_executable_qty: getConfigNum(dbConfig, 'min_executable_qty', DEFAULT_CONFIG.min_executable_qty),
    min_liquidity_usd: getConfigNum(dbConfig, 'min_liquidity_usd', DEFAULT_CONFIG.min_liquidity_usd),
    opportunity_ttl_sec: getConfigNum(dbConfig, 'opportunity_ttl_sec', DEFAULT_CONFIG.opportunity_ttl_sec),
    rest_concurrency: getConfigNum(dbConfig, 'rest_concurrency', DEFAULT_CONFIG.rest_concurrency),
    rest_refresh_cooldown_sec: getConfigNum(dbConfig, 'rest_refresh_cooldown_sec', DEFAULT_CONFIG.rest_refresh_cooldown_sec),
    rest_timeout_ms: getConfigNum(dbConfig, 'rest_timeout_ms', DEFAULT_CONFIG.rest_timeout_ms),
    max_expiry_diff_days: getConfigNum(dbConfig, 'max_expiry_diff_days', DEFAULT_CONFIG.max_expiry_diff_days),
    ...overrides,
  };
}

// ── DIRECT 套利识别 ───────────────────────────────────────────────────────────

/**
 * 识别 DIRECT 套利机会（同侧价差）
 * 当 ask_A < bid_B 时，在 A 平台买入、B 平台卖出
 */
function detectDirectArbs(
  canonicalId: string,
  marketTitle: string | null,
  kalshiLegs: MarketLeg[],
  polymarketLegs: MarketLeg[],
  config: ArbScanConfig,
  scannedAt: Date,
): ArbitrageReport[] {
  const reports: ArbitrageReport[] = [];

  for (const side of ['YES', 'NO'] as const) {
    const kalshiSide = kalshiLegs.filter(l => l.outcome_side === side);
    const polymarketSide = polymarketLegs.filter(l => l.outcome_side === side);

    // 遍历所有 (买腿, 卖腿) 组合：Kalshi买/Polymarket卖 和 Polymarket买/Kalshi卖
    const pairs: Array<{ buyLeg: MarketLeg; sellLeg: MarketLeg }> = [];
    for (const k of kalshiSide) {
      for (const p of polymarketSide) {
        pairs.push({ buyLeg: k, sellLeg: p }); // Kalshi 买，Polymarket 卖
        pairs.push({ buyLeg: p, sellLeg: k }); // Polymarket 买，Kalshi 卖
      }
    }

    for (const { buyLeg, sellLeg } of pairs) {
      const askPrice = buyLeg.band_vwap_ask;
      const bidPrice = sellLeg.band_vwap_bid;
      if (askPrice == null || bidPrice == null) continue;

      // 过滤已过期市场
      if (buyLeg.expires_at && buyLeg.expires_at <= new Date()) continue;
      if (sellLeg.expires_at && sellLeg.expires_at <= new Date()) continue;

      // 过滤已结算市场（价格接近 0 或 1）
      if (askPrice <= 0.01 || askPrice >= 0.99) continue;
      if (bidPrice <= 0.01 || bidPrice >= 0.99) continue;

      const spread = bidPrice - askPrice;
      if (spread <= 0) continue;

      const spreadPct = spread / Math.max(askPrice, bidPrice);
      if (spreadPct < config.min_arb_pct) continue;

      const execQty = Math.min(
        buyLeg.band_liquidity_qty_ask ?? 0,
        sellLeg.band_liquidity_qty_bid ?? 0,
      );
      if (execQty < config.min_executable_qty) continue;

      const grossProfit = spread * execQty;
      if (grossProfit < config.min_liquidity_usd) continue;

      const buyPlatform: 'KALSHI' | 'POLYMARKET' = buyLeg.exchange_id === 'KALSHI' ? 'KALSHI' : 'POLYMARKET';
      const sellPlatform: 'KALSHI' | 'POLYMARKET' = sellLeg.exchange_id === 'KALSHI' ? 'KALSHI' : 'POLYMARKET';

      const expiresAt = new Date(scannedAt.getTime() + config.opportunity_ttl_sec * 1000);

      reports.push({
        arbId: crypto.randomUUID(),
        canonicalMarketId: canonicalId,
        marketTitle,
        arbType: 'DIRECT',
        leg1: {
          platform: buyPlatform,
          marketId: buyLeg.market_id,
          marketTitle: buyLeg.market_title ?? null,
          expiresAt: buyLeg.expires_at ?? null,
          side,
          action: 'BUY',
          normalizedPrice: askPrice,
          qty: execQty,
        },
        leg2: {
          platform: sellPlatform,
          marketId: sellLeg.market_id,
          marketTitle: sellLeg.market_title ?? null,
          expiresAt: sellLeg.expires_at ?? null,
          side,
          action: 'SELL',
          normalizedPrice: bidPrice,
          qty: execQty,
        },
        grossSpread: spread,
        grossSpreadPct: spreadPct,
        executableQty: execQty,
        grossProfit,
        daysToExpiry: null,
        apy: null,
        leg1DataAt: buyLeg.data_updated_at,
        leg2DataAt: sellLeg.data_updated_at,
        scannedAt,
        expiresAt,
      });
    }
  }

  return reports;
}

// ── COMPLEMENT 套利识别 ───────────────────────────────────────────────────────

/**
 * 识别 COMPLEMENT 套利机会（互补价差）
 * 当 yesAsk + noAsk < 1.0 时，同时买入 YES 和 NO，到期必然获利
 */
function detectComplementArbs(
  canonicalId: string,
  marketTitle: string | null,
  kalshiLegs: MarketLeg[],
  polymarketLegs: MarketLeg[],
  config: ArbScanConfig,
  scannedAt: Date,
): ArbitrageReport[] {
  const reports: ArbitrageReport[] = [];

  const kalshiYes = kalshiLegs.filter(l => l.outcome_side === 'YES');
  const kalshiNo = kalshiLegs.filter(l => l.outcome_side === 'NO');
  const polyYes = polymarketLegs.filter(l => l.outcome_side === 'YES');
  const polyNo = polymarketLegs.filter(l => l.outcome_side === 'NO');

  // 两种组合：Kalshi YES + Polymarket NO，以及 Polymarket YES + Kalshi NO
  const combos: Array<{ yesLeg: MarketLeg; noLeg: MarketLeg }> = [];
  for (const ky of kalshiYes) {
    for (const pn of polyNo) {
      combos.push({ yesLeg: ky, noLeg: pn });
    }
  }
  for (const py of polyYes) {
    for (const kn of kalshiNo) {
      combos.push({ yesLeg: py, noLeg: kn });
    }
  }

  for (const { yesLeg, noLeg } of combos) {
    const yesAsk = yesLeg.band_vwap_ask;
    const noAsk = noLeg.band_vwap_ask;
    if (yesAsk == null || noAsk == null) continue;

    // 过滤已过期市场
    if (yesLeg.expires_at && yesLeg.expires_at <= new Date()) continue;
    if (noLeg.expires_at && noLeg.expires_at <= new Date()) continue;

    // 过滤两腿到期日差距过大的市场（说明是不同截止日的错误匹配）
    if (yesLeg.expires_at && noLeg.expires_at) {
      const diffDays = Math.abs(yesLeg.expires_at.getTime() - noLeg.expires_at.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > config.max_expiry_diff_days) continue;
    }

    // 过滤已结算市场（价格接近 0 或 1）
    if (yesAsk <= 0.01 || yesAsk >= 0.99) continue;
    if (noAsk <= 0.01 || noAsk >= 0.99) continue;

    const combinedCost = yesAsk + noAsk;
    if (combinedCost >= 1.0) continue;

    const spread = 1.0 - combinedCost;
    const spreadPct = spread / combinedCost;
    if (spreadPct < config.min_arb_pct) continue;

    const execQty = Math.min(
      yesLeg.band_liquidity_qty_ask ?? 0,
      noLeg.band_liquidity_qty_ask ?? 0,
    );
    if (execQty < config.min_executable_qty) continue;

    const grossProfit = spread * execQty;
    if (grossProfit < config.min_liquidity_usd) continue;

    // 计算到期天数和 APY（使用 YES 腿的到期时间）
    const expiryDate = yesLeg.expires_at ?? noLeg.expires_at;
    let daysToExpiry: number | null = null;
    let apy: number | null = null;
    if (expiryDate) {
      const msToExpiry = expiryDate.getTime() - scannedAt.getTime();
      daysToExpiry = msToExpiry / (1000 * 60 * 60 * 24);
      if (daysToExpiry > 0) {
        apy = (spreadPct / daysToExpiry) * 365;
      }
    }

    const yesPlatform: 'KALSHI' | 'POLYMARKET' = yesLeg.exchange_id === 'KALSHI' ? 'KALSHI' : 'POLYMARKET';
    const noPlatform: 'KALSHI' | 'POLYMARKET' = noLeg.exchange_id === 'KALSHI' ? 'KALSHI' : 'POLYMARKET';

    const expiresAt = new Date(scannedAt.getTime() + config.opportunity_ttl_sec * 1000);

    reports.push({
      arbId: crypto.randomUUID(),
      canonicalMarketId: canonicalId,
      marketTitle,
      arbType: 'COMPLEMENT',
      leg1: {
        platform: yesPlatform,
        marketId: yesLeg.market_id,
        marketTitle: yesLeg.market_title ?? null,
        expiresAt: yesLeg.expires_at ?? null,
        side: 'YES',
        action: 'BUY',
        normalizedPrice: yesAsk,
        qty: execQty,
      },
      leg2: {
        platform: noPlatform,
        marketId: noLeg.market_id,
        marketTitle: noLeg.market_title ?? null,
        expiresAt: noLeg.expires_at ?? null,
        side: 'NO',
        action: 'BUY',
        normalizedPrice: noAsk,
        qty: execQty,
      },
      grossSpread: spread,
      grossSpreadPct: spreadPct,
      executableQty: execQty,
      grossProfit,
      daysToExpiry,
      apy,
      leg1DataAt: yesLeg.data_updated_at,
      leg2DataAt: noLeg.data_updated_at,
      scannedAt,
      expiresAt,
    });
  }

  return reports;
}

// ── 主扫描函数 ────────────────────────────────────────────────────────────────

/**
 * 扫描 Kalshi-Polymarket 跨平台套利机会
 * @param config 可选的配置覆盖参数
 * @returns 套利机会列表（已存入 arbCache）
 */
export async function scanKalshiPolymarket(
  config?: Partial<ArbScanConfig>,
): Promise<ArbOpportunityList> {
  const scannedAt = new Date();

  // 从数据库加载配置，合并覆盖参数
  let dbConfig: Map<string, string>;
  try {
    dbConfig = await fetchArbConfig();
  } catch (err) {
    logger.warn({ err }, '加载套利配置失败，使用默认值');
    dbConfig = new Map();
  }
  const cfg = buildConfig(dbConfig, config);

  // 查询所有已匹配的市场腿（不限陈旧度，后续手动过滤）
  const rawLegs = await fetchMatchedMarketLegs(null, cfg.min_confidence);

  // 将数字字段从 string 转换为 number（pg 驱动返回 numeric 类型为字符串）
  const allLegs: MarketLeg[] = rawLegs.map(l => ({
    ...l,
    band_vwap_ask: l.band_vwap_ask != null ? Number(l.band_vwap_ask) : null,
    band_vwap_bid: l.band_vwap_bid != null ? Number(l.band_vwap_bid) : null,
    band_liquidity_qty_ask: l.band_liquidity_qty_ask != null ? Number(l.band_liquidity_qty_ask) : null,
    band_liquidity_qty_bid: l.band_liquidity_qty_bid != null ? Number(l.band_liquidity_qty_bid) : null,
    confidence_score: Number(l.confidence_score),
  }));

  // 只保留同时有 Kalshi 和 Polymarket 映射的市场对
  const marketGroups = new Map<string, MarketLeg[]>();
  for (const leg of allLegs) {
    const group = marketGroups.get(leg.canonical_market_id);
    if (group) {
      group.push(leg);
    } else {
      marketGroups.set(leg.canonical_market_id, [leg]);
    }
  }

  // 过滤：只保留同时有 Kalshi 和 Polymarket 两个平台的市场
  const kalshiPolymarketGroups = new Map<string, MarketLeg[]>();
  for (const [canonicalId, legs] of marketGroups) {
    const exchanges = new Set(legs.map(l => l.exchange_id));
    if (exchanges.has('KALSHI') && exchanges.has('POLYMARKET')) {
      kalshiPolymarketGroups.set(canonicalId, legs);
    }
  }

  // 分离新鲜腿和陈旧腿
  const stalenessMs = cfg.max_staleness_sec * 1000;
  const now = Date.now();
  const freshLegs: MarketLeg[] = [];
  const staleLegs: MarketLeg[] = [];

  for (const legs of kalshiPolymarketGroups.values()) {
    for (const leg of legs) {
      const age = now - new Date(leg.data_updated_at).getTime();
      if (age <= stalenessMs) {
        freshLegs.push(leg);
      } else {
        staleLegs.push(leg);
      }
    }
  }

  // 对陈旧腿尝试 REST 刷新（只刷新有新鲜对应腿的陈旧腿，最多 50 条，15 秒总超时）
  const REST_REFRESH_LIMIT = 50;
  const REST_TOTAL_TIMEOUT_MS = 15_000;
  const activeFreshLegs = [...freshLegs];
  if (staleLegs.length > 0) {
    const freshCanonicalIds = new Set(freshLegs.map(l => l.canonical_market_id));
    const refreshable = staleLegs
      .filter(l => freshCanonicalIds.has(l.canonical_market_id))
      .slice(0, REST_REFRESH_LIMIT);

    if (refreshable.length > 0) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('REST 刷新总超时')), REST_TOTAL_TIMEOUT_MS),
        );
        const { refreshed, failed } = await Promise.race([
          refreshStaleLegs(
            refreshable,
            cfg.rest_concurrency,
            cfg.rest_refresh_cooldown_sec,
            cfg.rest_timeout_ms,
          ),
          timeoutPromise,
        ]);
        for (const leg of refreshed) {
          activeFreshLegs.push(leg);
        }
        if (failed > 0) {
          logger.warn({ failed }, '部分陈旧腿刷新失败，已跳过');
        }
      } catch (err) {
        logger.warn({ err }, 'REST 刷新陈旧腿失败或超时，继续使用现有新鲜腿');
      }
    }
  }

  // 重新按 canonical_market_id 分组（使用刷新后的腿）
  const refreshedGroups = new Map<string, MarketLeg[]>();
  for (const leg of activeFreshLegs) {
    const group = refreshedGroups.get(leg.canonical_market_id);
    if (group) {
      group.push(leg);
    } else {
      refreshedGroups.set(leg.canonical_market_id, [leg]);
    }
  }

  // 识别套利机会
  const allReports: ArbitrageReport[] = [];

  for (const [canonicalId, legs] of refreshedGroups) {
    // 只处理同时有 Kalshi 和 Polymarket 的市场
    const kalshiLegs = legs.filter(l => l.exchange_id === 'KALSHI');
    const polymarketLegs = legs.filter(l => l.exchange_id === 'POLYMARKET');
    if (kalshiLegs.length === 0 || polymarketLegs === null || polymarketLegs.length === 0) continue;

    // 过滤：两平台均需有 YES 和 NO 两侧数据
    const kalshiSides = new Set(kalshiLegs.map(l => l.outcome_side));
    const polymarketSides = new Set(polymarketLegs.map(l => l.outcome_side));
    if (!kalshiSides.has('YES') || !kalshiSides.has('NO')) continue;
    if (!polymarketSides.has('YES') || !polymarketSides.has('NO')) continue;

    const marketTitle = legs[0]?.market_title ?? null;

    // 识别 DIRECT 套利
    const directReports = detectDirectArbs(
      canonicalId, marketTitle, kalshiLegs, polymarketLegs, cfg, scannedAt,
    );
    allReports.push(...directReports);

    // 识别 COMPLEMENT 套利
    const complementReports = detectComplementArbs(
      canonicalId, marketTitle, kalshiLegs, polymarketLegs, cfg, scannedAt,
    );
    allReports.push(...complementReports);
  }

  // 按 grossSpreadPct 降序排列
  allReports.sort((a, b) => b.grossSpreadPct - a.grossSpreadPct);

  // 存入内存缓存
  arbCache.set(allReports);

  logger.info({
    marketsScanned: refreshedGroups.size,
    opportunitiesFound: allReports.length,
  }, 'Kalshi-Polymarket 套利扫描完成');

  return {
    reports: allReports,
    scannedAt,
    opportunityTtlSec: cfg.opportunity_ttl_sec,
  };
}
