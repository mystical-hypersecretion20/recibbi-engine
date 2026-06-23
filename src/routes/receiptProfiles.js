'use strict';

const express = require('express');
const config = require('../config');
const store = require('../store');
const profileStore = require('../receiptProfiles/profileStore');
const resultStore = require('../receiptProfiles/resultStore');
const registry = require('../receiptProfiles/registry');
const { applyProfileToReceipt } = require('../receiptProfiles/applyService');
const { enqueueApplyProfile } = require('../queue');
const identity = require('../identity');
const view = require('../web/view');
const logger = require('../logger');

const router = express.Router();

function summary(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    transformer: p.transformer,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function isValidationError(err) {
  return err && err.name === 'ValidationError' && Array.isArray(err.errors);
}

// --- Available transformers (read-only; code shipped with the app) ----------

router.get('/api/transformers', (req, res) => {
  res.json(registry.list());
});

// --- Profile CRUD (profiles are scoped per TENANT) ---------------------------
// Tenant comes from the request identity (X-Tenant-Id / tenantId / default).

router.get('/api/receiptProfiles', async (req, res, next) => {
  try {
    const { tenantId } = identity.resolveIdentity(req);
    const all = await profileStore.list({ tenantId });
    res.json(all.map(summary));
  } catch (err) {
    next(err);
  }
});

router.post('/api/receiptProfiles', async (req, res, next) => {
  try {
    const { tenantId } = identity.resolveIdentity(req);
    const profile = await profileStore.create(req.body || {}, { tenantId });
    logger.info({ tenantId, id: profile.id, name: profile.name, transformer: profile.transformer }, 'receipt profile created');
    res.status(201).json(profile);
  } catch (err) {
    if (isValidationError(err)) return res.status(400).json({ error: err.message, details: err.errors });
    next(err);
  }
});

router.get('/api/receiptProfiles/:id', async (req, res, next) => {
  try {
    const { tenantId } = identity.resolveIdentity(req);
    const profile = await profileStore.get(req.params.id, { tenantId });
    if (!profile) return res.status(404).json({ error: 'not found' });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.put('/api/receiptProfiles/:id', async (req, res, next) => {
  try {
    const { tenantId } = identity.resolveIdentity(req);
    const updated = await profileStore.update(req.params.id, req.body || {}, { tenantId });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (err) {
    if (isValidationError(err)) return res.status(400).json({ error: err.message, details: err.errors });
    next(err);
  }
});

router.delete('/api/receiptProfiles/:id', async (req, res, next) => {
  try {
    const { tenantId } = identity.resolveIdentity(req);
    const ok = await profileStore.remove(req.params.id, { tenantId });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Apply + results ---------------------------------------------------------
// Receipt-scoped routes derive their tenant FROM the receipt id (it's composite,
// so it carries the tenant); profiles are then resolved within that tenant.

// Apply a profile to an already-processed receipt. Synchronous by default.
// ?dryRun=1 runs the transform without persisting. ?async=1 enqueues a childless
// `applyProfile` job and returns 202 instead of running inline.
router.post('/api/receipts/:id/applyProfile/:profileId', async (req, res, next) => {
  try {
    if (req.query.async && !req.query.dryRun) {
      const record = await store.get(req.params.id);
      if (!record) return res.status(404).json({ error: 'receipt not found' });
      const { tenantId } = identity.scopeOf(record.id);
      const profile = await profileStore.get(req.params.profileId, { tenantId });
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      await enqueueApplyProfile(record.id, profile.id);
      logger.info({ receiptId: record.id, profileId: profile.id }, 'profile apply enqueued (async)');
      return res.status(202).json({
        receiptId: record.id,
        profileId: profile.id,
        status: 'queued',
        profileResultUrl: `${config.publicBaseUrl}/api/receipts/${record.id}/profileResults/${profile.id}`,
      });
    }

    const result = await applyProfileToReceipt(req.params.id, req.params.profileId, {
      dryRun: !!req.query.dryRun,
    });
    res.json(result);
  } catch (err) {
    if (err && err.name === 'ApplyError') return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Every profile result for the requesting identity (newest first).
router.get('/api/profileResults', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    res.json(await resultStore.listAll({ tenantId, userId }));
  } catch (err) {
    next(err);
  }
});

// Every result for ONE profile, across the identity's receipts. Accepts a
// profile id or name (results are keyed by id, so resolve a name first).
router.get('/api/profileResults/:profileId', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const profileId = profile ? profile.id : req.params.profileId;
    res.json(await resultStore.listByProfile(profileId, { tenantId, userId }));
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id/profileResults', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'receipt not found' });
    res.json(await resultStore.list(record.id));
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id/profileResults/:profileId', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    // Accept profile id or name; results are keyed by id, so resolve a name.
    const { tenantId } = identity.scopeOf(record.id);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const profileId = profile ? profile.id : req.params.profileId;
    const result = await resultStore.get(record.id, profileId);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Web view of a profile-applied receipt -----------------------------------

// HTML list of every profile result for the requesting identity.
router.get('/profileResults', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    res.type('html').send(view.renderProfileResultList(await resultStore.listAll({ tenantId, userId })));
  } catch (err) {
    next(err);
  }
});

// HTML list filtered to ONE profile (id or name), across the identity's receipts.
router.get('/profileResults/:profileId', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const profileId = profile ? profile.id : req.params.profileId;
    const results = await resultStore.listByProfile(profileId, { tenantId, userId });
    res.type('html').send(
      view.renderProfileResultList(results, { filter: profile ? profile.name : req.params.profileId })
    );
  } catch (err) {
    next(err);
  }
});


// HTML view of a receipt as transformed by a profile (discounts folded into
// their line items). Renders the stored result when present; otherwise computes
// it fresh (dryRun, no persistence) so the page always reflects the current
// transformer. Mirrors the JSON endpoint above.
router.get('/receipts/:id/profileResults/:profileId/view', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('Receipt not found');
    const { tenantId } = identity.scopeOf(record.id);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const result =
      (profile && (await resultStore.get(record.id, profile.id))) ||
      (await applyProfileToReceipt(req.params.id, req.params.profileId, { dryRun: true }));
    res.type('html').send(view.renderProfileResult(record, result));
  } catch (err) {
    if (err && err.name === 'ApplyError') return res.status(err.status).send(err.message);
    next(err);
  }
});

module.exports = router;
