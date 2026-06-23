'use strict';

const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const profileStore = require('./receiptProfiles/profileStore');
const tenants = require('./tenants');

const app = createApp();

// Register the default tenant (so it's listed + its queue is consumed) and seed
// its shipped example receipt profile(s) on first boot (no-op if any exist).
// Other tenants are provisioned (and seeded) on demand via POST /api/tenants.
(async () => {
  try {
    await tenants.hydrate(); // repopulate the Redis SET from the durable list
    await tenants.ensureDefault();
    const n = await profileStore.seedIfEmpty();
    if (n) logger.info({ tenant: config.defaultTenantId, seeded: n }, 'seeded receipt profiles');
  } catch (err) {
    logger.warn({ err: err.message }, 'default tenant bootstrap failed');
  }
})();

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(
    { port: config.port, ocr: config.ocrProvider, enrichment: config.enrich.enabled },
    'API server listening'
  );
});

function shutdown(sig) {
  logger.info({ sig }, 'shutting down API');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
