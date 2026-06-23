'use strict';

// Type-only module: JSDoc typedefs for the product-resolver contract. The
// registry skips this file when loading resolvers (it has no `resolve` export),
// the same way receiptProfiles/registry.js skips its types module.
//
// A *resolver* is the configurable backend adapter that maps ONE receipt line
// item to product information. The first shipped resolver is `anthropic`; a
// `tavily` resolver can be added later by dropping a sibling module here and
// setting PRODUCT_RESOLVER=tavily — no call-site changes.

/**
 * @typedef {Object} LineItem
 * @property {string} description  the cleaned line-item text from a profile result
 * @property {string|null} [sku]
 * @property {number|null} [qty]
 * @property {number|null} [unitPrice]
 * @property {number|null} [price]
 */

/**
 * @typedef {Object} ResolveContext
 * @property {string|null} storeName   store name from the profile result (may be null)
 * @property {string|null} storeDate   store date from the profile result (may be null)
 * @property {object} config           the app config object
 * @property {(msg: string, extra?: object) => void} log
 */

/**
 * The product fields a resolver returns for one line item (or null if it can't
 * identify a product). The service wraps this with the originating `lineItem`.
 * @typedef {Object} ProductFields
 * @property {string|null} productTitle
 * @property {string|null} productDescription
 * @property {string|null} productUrl        the top web link substantiating the item
 * @property {string|null} [brand]
 * @property {string|null} [category]
 * @property {string|null} [emoji]           a single emoji depicting the product (config.products.emoji; null when off/none)
 * @property {number|null} [confidence]      0..1, resolver's own confidence
 */

/**
 * The resolver module contract.
 * @typedef {Object} Resolver
 * @property {string} id                       filename stem (e.g. 'anthropic')
 * @property {{name:string, description?:string}} meta
 * @property {(config: object) => boolean} ready   is the backend configured/usable?
 * @property {(item: LineItem, ctx: ResolveContext) => Promise<ProductFields|null>} resolve
 */

module.exports = {};
