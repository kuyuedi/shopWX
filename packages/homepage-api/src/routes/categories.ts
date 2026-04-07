import type { FastifyInstance } from 'fastify';
import { queryWithPool } from '@prediction-market/shared';
import { CATEGORY_LABELS } from '../categoryMap.js';
import type { CategoriesResponse, CategoryItem } from '../types.js';

export async function categoriesRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/categories', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  label: { type: 'string' },
                  count: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const result = await queryWithPool<{ category: string | null; count: string }>(
      fastify.apiPool,
      `SELECT norm_cat AS category, COUNT(*)::text AS count FROM (
        SELECT CASE
          WHEN category IN ('Sports','Esports','Tennis','Soccer','NBA','NHL','NFL','UFC','Formula 1',
            'Cricket','Basketball','Hockey','MLS','MLB','NCAA','NCAA Basketball','NCAA CBB',
            'NCAA Football','football','Baseball','WTA','Champions League','Europa League',
            'Europa Conference League','EFL Championship','Eredivisie','Bundesliga 2','Serie A',
            'La Liga','EPL','MMA','mma','counter strike 2','league of legends','lol','Overwatch',
            'COD','cs2','Honor of Kings','Mobile Legends: Bang Bang','division') THEN 'sports'
          WHEN category IN ('Politics','Elections','Geopolitics','Trump','World','World Elections',
            'Global Elections','Congress','Primaries','US Election','Midterms','Nov 4 Elections',
            'Foreign Policy','Cabinet','Senate','Senate Primary','House Primary','Courts','SCOTUS',
            'Trump Presidency','France','Japan','China','India','Iran','Israel','Ukraine','Venezuela',
            'Brazil','Russia','Middle East','South Korea','Europe','UK','Canada','Mexico',
            'Regional Spillover','Greenland') THEN 'politics'
          WHEN category IN ('Economics','Economy','Finance','Financials','Companies','Business',
            'Macro Indicators','IPOs','IPO','Earnings','Housing','GDP','Inflation','Commodities',
            'Equities','Fed','Global Rates','Fed Rates','Interest Rate','Derivatives','S&P 500',
            'SPX','NDX','Foreign Exchange','Pre-Market') THEN 'economics'
          WHEN category IN ('Crypto','Crypto Prices','Bitcoin','Ethereum','Solana','XRP','Dogecoin',
            'BNB','Stablecoins','Airdrops','fdv','hype') THEN 'crypto'
          WHEN category IN ('Entertainment','Culture','Music','Movies','Games','Reality TV',
            'Celebrities','YouTube','Awards','Eurovision','Kpop','MrBeast','Taylor Swift',
            'Twitter','TikTok','netflix') THEN 'entertainment'
          ELSE NULL
        END AS norm_cat
        FROM events WHERE status = 'Open'
      ) sub
      WHERE norm_cat IS NOT NULL
      GROUP BY norm_cat`
    );

    const categoryItems: CategoryItem[] = [];

    for (const row of result.rows) {
      const count = parseInt(row.count, 10);
      if (row.category && CATEGORY_LABELS[row.category]) {
        categoryItems.push({
          slug: row.category,
          label: CATEGORY_LABELS[row.category]!,
          count,
        });
      }
    }

    // Sort by count descending
    categoryItems.sort((a, b) => b.count - a.count);

    // Get total open events for "All" count
    const totalResult = await queryWithPool<{ count: string }>(
      fastify.apiPool,
      `SELECT COUNT(*)::text AS count FROM events WHERE status = 'Open'`
    );
    const totalCount = parseInt(totalResult.rows[0]?.count ?? '0', 10);

    // Prepend "All"
    const categories: CategoryItem[] = [
      { slug: 'all', label: 'All', count: totalCount },
      ...categoryItems,
    ];

    const response: CategoriesResponse = { categories };
    return reply.send(response);
  });
}
