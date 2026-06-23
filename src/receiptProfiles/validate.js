'use strict';

const registry = require('./registry');

// A profile is now METADATA that binds a name to an on-disk transformer (+ an
// optional config object passed to the transformer). The transformation logic
// lives in code (src/receiptProfiles/transformers/), so validation here is just
// shape + referential integrity (the transformer must exist).

const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/; // camelCase-ish, no dashes/spaces

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a profile definition (user-supplied body, before ids/timestamps).
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateProfile(input) {
  const errors = [];
  if (!isPlainObject(input)) return { valid: false, errors: ['profile must be a JSON object'] };

  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    errors.push('name must be camelCase letters/digits (no dashes/spaces), 1–64 chars');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    errors.push('description must be a string');
  }

  if (typeof input.transformer !== 'string' || !input.transformer.trim()) {
    errors.push('transformer is required (the id of an on-disk transformer)');
  } else if (!registry.has(input.transformer)) {
    const available = registry.list().map((t) => t.id).join(', ') || '(none)';
    errors.push(`unknown transformer "${input.transformer}"; available: ${available}`);
  }

  if (input.config !== undefined && !isPlainObject(input.config)) {
    errors.push('config must be a JSON object');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateProfile, NAME_RE };
