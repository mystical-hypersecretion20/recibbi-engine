'use strict';

const IORedis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

/**
 * Create a Redis connection suitable for BullMQ.
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses.
 */
function createConnection() {
  const conn = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  conn.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
  return conn;
}

// A shared client for general-purpose caching (NOT used by BullMQ internals).
let cacheClient = null;
function cache() {
  if (!cacheClient) cacheClient = createConnection();
  return cacheClient;
}

module.exports = { createConnection, cache };
