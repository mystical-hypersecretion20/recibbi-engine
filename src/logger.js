'use strict';

const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname noise
});

module.exports = logger;
