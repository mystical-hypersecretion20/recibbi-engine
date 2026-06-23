'use strict';

const config = require('../config');

/**
 * Selects the configured extraction provider and returns its result:
 *   { rawText: string|null, structured: object|null, provider: string }
 *
 * Routing:
 *   'vision'    -> ./vision    (in-process multimodal LLM)
 *   'tesseract' -> ./tesseract (in-process offline OCR; the default)
 *   anything else (e.g. 'paddle', 'paddle-vl') -> ./rest, a generic client for a
 *     remote HTTP OCR backend registered under config.ocr.rest. This is the
 *     extension point for OCR engines that run as their own container.
 */
async function extract(record) {
  const provider = config.ocrProvider;
  let impl;
  if (provider === 'vision') impl = require('./vision');
  else if (provider === 'tesseract') impl = require('./tesseract');
  else impl = require('./rest');
  const out = await impl.extract(record);
  return { ...out, provider };
}

module.exports = { extract };
