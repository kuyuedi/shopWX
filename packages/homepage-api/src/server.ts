import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createLogger } from '@prediction-market/shared';
import { healthRoute } from './routes/health.js';
import { categoriesRoute } from './routes/categories.js';
import { statsRoute } from './routes/stats.js';
import { tickerRoute } from './routes/ticker.js';
import { marketsRoute } from './routes/markets.js';
import { eventsRoute } from './routes/events.js';
import { arbRoute } from './routes/arb.js';
import { signalsRoute } from './routes/signals.js';
import { authRoute } from './routes/auth.js';
import { marketDetailRoute } from './routes/marketDetail.js';
import { kalshiTradingRoute } from './routes/kalshiTrading.js';
import { polymarketTradingRoute } from './routes/polymarketTrading.js';
import { kalshiPolymarketArbRoute } from './routes/kalshiPolymarketArb.js';

declare module 'fastify' {
  interface FastifyInstance {
    apiPool: pg.Pool;
  }
}

const logger = createLogger('server');

export async function buildServer(apiPool: pg.Pool) {
  const fastify = Fastify({
    logger: false,
  });

  fastify.decorate('apiPool', apiPool);

  // CORS
  await fastify.register(cors, {
    origin: true,
  });

  // 静态文件：将 prediction-main 根目录托管在 /arb 路径，提供 arb-dashboard.html
  // __dirname = packages/homepage-api/src，往上 3 级到 prediction-main/
  await fastify.register(staticPlugin, {
    root: path.resolve(__dirname, '../../../'),
    prefix: '/arb/',
    serve: true,
    index: 'arb-dashboard.html',
  });

  // Swagger
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: '17B Homepage API',
        description: 'Prediction market ranking and price comparison API',
        version: '1.0.0',
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/api/v1/docs',
  });

  // Routes
  await fastify.register(healthRoute);
  await fastify.register(categoriesRoute);
  await fastify.register(statsRoute);
  await fastify.register(tickerRoute);
  await fastify.register(marketsRoute);
  await fastify.register(eventsRoute);
  await fastify.register(arbRoute);
  await fastify.register(signalsRoute);
  await fastify.register(authRoute);
  await fastify.register(marketDetailRoute);
  await fastify.register(kalshiTradingRoute);
  await fastify.register(polymarketTradingRoute);
  await fastify.register(kalshiPolymarketArbRoute);

  // Raw OpenAPI JSON spec endpoint (for frontend team / Postman / codegen)
  fastify.get('/api/v1/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send(fastify.swagger());
  });

  // Error handler
  fastify.setErrorHandler((error, _request, reply) => {
    logger.error({ err: error }, 'Unhandled route error');
    reply.status(500).send({ error: 'Internal server error' });
  });

  return fastify;
}
