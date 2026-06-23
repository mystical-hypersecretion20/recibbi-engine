'use strict';

// Shared "apply a profile to a receipt" service. The logic lived inline in
// routes/receiptProfiles.js (Step 1, synchronous). Step 2 reuses it from the
// BullMQ worker (the `applyProfile` job), so it's extracted here to avoid
// duplication. Pure JS, no Express/Redis dependency — load receipt + profile +
// transformer, run the engine, build the result doc, persist unless dryRun.

const store = require('../store');
const profileStore = require('./profileStore');
const resultStore = require('./resultStore');
const registry = require('./registry');
const identity = require('../identity');
const { applyProfile } = require('./engine');
const logger = require('../logger');

// Error with an HTTP-ish status so the sync route can map it; the worker just
// lets it propagate (job fails/retries).
class ApplyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApplyError';
    this.status = status;
  }
}

/**
 * Apply a profile to a receipt and (unless dryRun) persist the result.
 * @param {string} receiptId
 * @param {string} profileId  profile id or name
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<object>} the result document
 * @throws {ApplyError} 404 (unknown receipt/profile) | 422 (transformer gone)
 */
async function applyProfileToReceipt(receiptId, profileId, { dryRun = false } = {}) {
  const record = await store.get(receiptId);
  if (!record) throw new ApplyError(404, 'receipt not found');
  // Profiles are tenant-scoped; resolve within the receipt's tenant.
  const { tenantId } = identity.scopeOf(record.id);
  const profile = await profileStore.get(profileId, { tenantId });
  if (!profile) throw new ApplyError(404, 'profile not found');

  const transformer = registry.get(profile.transformer);
  if (!transformer) {
    // Validated at create time, but a transformer file can disappear later.
    throw new ApplyError(422, `transformer "${profile.transformer}" is not available`);
  }

  const ctx = {
    receiptId: record.id,
    config: profile.config || {},
    log: (msg, extra) => logger.info({ ...extra, receiptId: record.id, profile: profile.name }, msg),
  };
  const out = applyProfile(record, transformer.transform, ctx);
  const result = {
    receiptId: record.id,
    profileId: profile.id,
    profileName: profile.name,
    profileVersion: profile.version,
    transformer: profile.transformer,
    appliedAt: new Date().toISOString(),
    dryRun: !!dryRun,
    ...out,
  };

  if (!dryRun) {
    await resultStore.save(result);
    logger.info(
      { receiptId: record.id, profileId: profile.id, transformer: profile.transformer, changes: out.changes.length },
      'profile applied'
    );
  }
  return result;
}

module.exports = { applyProfileToReceipt, ApplyError };
