'use strict';

const { Queue, FlowProducer } = require('bullmq');
const config = require('./config');
const identity = require('./identity');
const { createConnection } = require('./redis');

// Per-job options shared by the plain Queue and the FlowProducer. A FlowProducer
// does NOT inherit a Queue's defaultJobOptions, so each flow node must carry its
// own opts — we reuse this object to keep them identical.
const defaultJobOptions = {
  attempts: config.jobAttempts,
  backoff: { type: 'exponential', delay: 5000 },
  // Keep history bounded so Redis doesn't grow forever.
  removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

// MULTI-TENANCY: each tenant gets its own queue, `receipts-<tenant>`. BullMQ
// rejects ':' in BOTH queue names and custom job ids, so the queue name uses a
// '-' separator (tenant ids are validated [A-Za-z0-9_-], so `receipts-<tenant>`
// is unique per tenant) and job ids hash the composite id (identity.jobId). The
// worker (src/worker.js) runs one BullMQ Worker per tenant queue, discovered via
// the tenant registry (src/tenants.js).
function queueNameFor(tenantId) {
  return `${config.queueName}-${tenantId}`;
}

// One shared connection for all producer-side Queues + the FlowProducer. Created
// lazily so merely requiring this module opens nothing (keeps the hermetic tests'
// queue stub simple — they replace this module wholesale before it loads).
let connection = null;
function conn() {
  if (!connection) connection = createConnection();
  return connection;
}

const queues = new Map();
function queueFor(tenantId) {
  if (!queues.has(tenantId)) {
    queues.set(tenantId, new Queue(queueNameFor(tenantId), { connection: conn(), defaultJobOptions }));
  }
  return queues.get(tenantId);
}

let _flow = null;
function flowProducer() {
  if (!_flow) _flow = new FlowProducer({ connection: conn() });
  return _flow;
}

// The tenant a (composite) receipt id belongs to — selects its queue.
function tenantOf(receiptId) {
  return identity.scopeOf(receiptId).tenantId;
}

/**
 * Enqueue a receipt for processing on its tenant's queue. The job payload is
 * intentionally tiny; the durable record lives on disk and is looked up by its
 * composite id in the worker.
 */
async function enqueueReceipt(receiptId) {
  return queueFor(tenantOf(receiptId)).add(
    'process-receipt',
    { receiptId },
    { jobId: identity.jobId('receipt', receiptId) }
  );
}

/**
 * Enqueue a flow that runs the OCR pipeline FIRST, then applies a profile:
 * child `process-receipt` (upstream) -> parent `applyProfile` (downstream).
 */
async function enqueueProcessAndApply(receiptId, profileId) {
  const qn = queueNameFor(tenantOf(receiptId));
  return flowProducer().add({
    name: 'applyProfile',
    queueName: qn,
    data: { receiptId, profileId },
    opts: { ...defaultJobOptions, jobId: identity.jobId('applyProfile', receiptId, profileId) },
    children: [
      {
        name: 'process-receipt',
        queueName: qn,
        data: { receiptId },
        opts: { ...defaultJobOptions, jobId: identity.jobId('receipt', receiptId), failParentOnFailure: true },
      },
    ],
  });
}

/**
 * Enqueue a childless `applyProfile` job to (re)apply a profile to a receipt
 * that's already been processed — the async variant of the sync apply route.
 */
async function enqueueApplyProfile(receiptId, profileId) {
  return queueFor(tenantOf(receiptId)).add(
    'applyProfile',
    { receiptId, profileId },
    { jobId: identity.jobId('applyProfile', receiptId, profileId) }
  );
}

/**
 * Enqueue a childless `resolveProducts` job to (re)resolve products for a
 * receipt whose profile has already been applied — the async variant of the
 * sync resolve route.
 */
async function enqueueResolveProducts(receiptId, profileId) {
  return queueFor(tenantOf(receiptId)).add(
    'resolveProducts',
    { receiptId, profileId },
    { jobId: identity.jobId('resolveProducts', receiptId, profileId) }
  );
}

/**
 * Enqueue the full end-to-end flow for a single upload: OCR pipeline, then
 * profile, then product resolution, all on the receipt's tenant queue. Runs
 * bottom-up: process-receipt -> applyProfile -> resolveProducts.
 */
async function enqueueProcessApplyAndResolve(receiptId, profileId) {
  const qn = queueNameFor(tenantOf(receiptId));
  return flowProducer().add({
    name: 'resolveProducts',
    queueName: qn,
    data: { receiptId, profileId },
    opts: { ...defaultJobOptions, jobId: identity.jobId('resolveProducts', receiptId, profileId) },
    children: [
      {
        name: 'applyProfile',
        queueName: qn,
        data: { receiptId, profileId },
        opts: { ...defaultJobOptions, jobId: identity.jobId('applyProfile', receiptId, profileId), failParentOnFailure: true },
        children: [
          {
            name: 'process-receipt',
            queueName: qn,
            data: { receiptId },
            opts: { ...defaultJobOptions, jobId: identity.jobId('receipt', receiptId), failParentOnFailure: true },
          },
        ],
      },
    ],
  });
}

module.exports = {
  queueNameFor,
  queueFor,
  flowProducer,
  enqueueReceipt,
  enqueueProcessAndApply,
  enqueueApplyProfile,
  enqueueResolveProducts,
  enqueueProcessApplyAndResolve,
  connection: conn,
};
