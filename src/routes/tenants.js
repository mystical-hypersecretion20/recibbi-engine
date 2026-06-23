'use strict';

// Tenant account management. Tenants are explicitly provisioned: the upload
// route rejects an unknown tenant, so a new tenant must be created here first
// (the configured default tenant is always allowed and is auto-registered at
// boot). Creating a tenant also seeds it with the shipped example profiles and
// causes the worker to start consuming its queue (via the registry watch).

const express = require('express');
const tenants = require('../tenants');
const profileStore = require('../receiptProfiles/profileStore');
const identity = require('../identity');
const logger = require('../logger');

const router = express.Router();

// List provisioned tenants (always includes the default).
router.get('/api/tenants', async (req, res, next) => {
  try {
    res.json({ default: identity.defaultScope().tenantId || null, tenants: await tenants.list() });
  } catch (err) {
    next(err);
  }
});

// Create (provision) a tenant account. Body: { tenantId } (or { id }/{ name }).
// Idempotent: re-creating an existing tenant is a no-op 200.
router.post('/api/tenants', async (req, res, next) => {
  try {
    const b = req.body || {};
    const tenantId = b.tenantId || b.id || b.name;
    if (!identity.isValidSegment(tenantId)) {
      return res.status(400).json({ error: 'a valid tenantId is required ([A-Za-z0-9_-]{1,64})' });
    }
    const existed = await tenants.isAllowed(tenantId);
    await tenants.register(tenantId);
    // Seed the shipped example profiles for the new tenant (no-op if it has any).
    let seeded = 0;
    try {
      seeded = await profileStore.seedIfEmpty({ tenantId });
    } catch (err) {
      logger.warn({ err: err.message, tenantId }, 'tenant profile seeding failed');
    }
    logger.info({ tenantId, existed, seeded }, 'tenant provisioned');
    res.status(existed ? 200 : 201).json({ tenantId, created: !existed, seededProfiles: seeded });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
