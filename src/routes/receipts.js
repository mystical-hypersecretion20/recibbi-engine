'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
const { enqueueReceipt, enqueueProcessAndApply, enqueueProcessApplyAndResolve } = require('../queue');
const profileStore = require('../receiptProfiles/profileStore');
const identity = require('../identity');
const tenants = require('../tenants');
const view = require('../web/view');
const logger = require('../logger');

const router = express.Router();

// Interpret an optional form flag: absent → use the fallback; otherwise treat
// anything but an explicit falsey value as true.
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image uploads are accepted'));
  },
});

function links(id) {
  return {
    statusUrl: `${config.publicBaseUrl}/api/receipts/${id}`,
    viewUrl: `${config.publicBaseUrl}/receipts/${id}/view`,
  };
}

// --- REST API ---

// Upload a receipt image. Field name: "receipt" (also accepts "file"/"image").
router.post(
  '/api/receipts',
  (req, res, next) =>
    upload.fields([
      { name: 'receipt', maxCount: 1 },
      { name: 'file', maxCount: 1 },
      { name: 'image', maxCount: 1 },
    ])(req, res, next),
  async (req, res, next) => {
    try {
      const f =
        (req.files?.receipt && req.files.receipt[0]) ||
        (req.files?.file && req.files.file[0]) ||
        (req.files?.image && req.files.image[0]);
      if (!f) return res.status(400).json({ error: 'No image uploaded. Use field "receipt".' });

      // Resolve the identity this upload belongs to (X-Tenant-Id/X-User-Id
      // headers, tenantId/userId form fields, or the configured default). Tenants
      // are provisioned accounts: reject an upload for an unknown tenant.
      const { tenantId, userId } = identity.resolveIdentity(req);
      if (!(await tenants.isAllowed(tenantId))) {
        return res.status(400).json({ error: `unknown tenant "${tenantId}"` });
      }

      // Optional: apply a profile after OCR. An explicit form field wins;
      // otherwise fall back to a server-wide default (DEFAULT_PROFILE_ID).
      // Profiles are tenant-scoped, so resolve within this upload's tenant.
      const requestedProfileId =
        (req.body && req.body.profileId) || config.receiptProfiles.defaultProfileId || null;
      let profile = null;
      if (requestedProfileId) {
        profile = await profileStore.get(requestedProfileId, { tenantId });
        if (!profile) {
          return res.status(400).json({ error: `unknown profile "${requestedProfileId}"` });
        }
      }

      const record = await store.createReceipt({
        buffer: f.buffer,
        mimeType: f.mimetype,
        originalName: f.originalname,
        source: (req.body && req.body.source) || 'api',
        tenantId,
        userId,
      });

      // Product resolution needs a profile result, so it only applies when a
      // profile is selected. It's on by default (config.products.resolveOnUpload),
      // opt out per-upload with resolveProducts=0.
      const wantsProducts =
        !!profile && config.products.enabled && flag(req.body && req.body.resolveProducts, config.products.resolveOnUpload);

      // Choose the flow depth: OCR+profile+products (3-level), OCR+profile
      // (2-level), or OCR only (single job). Without a profile the path is unchanged.
      if (wantsProducts) {
        await enqueueProcessApplyAndResolve(record.id, profile.id);
        logger.info({ id: record.id, source: record.source, profileId: profile.id }, 'receipt accepted; OCR+profile+products flow queued');
      } else if (profile) {
        await enqueueProcessAndApply(record.id, profile.id);
        logger.info({ id: record.id, source: record.source, profileId: profile.id }, 'receipt accepted; OCR+profile flow queued');
      } else {
        await enqueueReceipt(record.id);
        logger.info({ id: record.id, source: record.source }, 'receipt accepted and queued');
      }

      res.status(202).json({
        id: record.id,
        status: record.status,
        profileId: profile ? profile.id : null,
        profileResultUrl: profile
          ? `${config.publicBaseUrl}/api/receipts/${record.id}/profileResults/${profile.id}`
          : null,
        productsUrl: wantsProducts
          ? `${config.publicBaseUrl}/api/receipts/${record.id}/products/${profile.id}`
          : null,
        ...links(record.id),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/api/receipts', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    // List only the requesting identity's receipts (header/default scope).
    const { tenantId, userId } = identity.resolveIdentity(req);
    const records = await store.list({ tenantId, userId, limit });
    res.json(
      records.map((r) => ({
        id: r.id,
        status: r.status,
        store: r.store,
        itemCount: r.totals ? r.totals.itemCount : 0,
        createdAt: r.createdAt,
        ...links(r.id),
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ ...record, ...links(record.id) });
  } catch (err) {
    next(err);
  }
});

// --- Web views ---

router.get('/receipts/:id/image', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('not found');
    res.type(record.image.mimeType || 'application/octet-stream');
    res.sendFile(store.imagePathFor(record));
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:id/view', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('Receipt not found');
    res.type('html').send(view.renderReceipt(record));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const records = await store.list({ limit: 100 });
    res.type('html').send(view.renderList(records));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
