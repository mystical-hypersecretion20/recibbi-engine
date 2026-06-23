// Shared types for receipt-profile transformers. A transformer is an on-disk
// module that exports `meta` + a `transform` entrypoint. The engine hands the
// entrypoint a deep copy of the parsed receipt (so mutating it is safe), then
// auto-derives the change/audit trail and recomputes totals.

export interface Store {
  name: string | null;
  date: string | null;
}

export interface Item {
  description: string;
  sku: string | null;
  qty: number | null;
  unitPrice: number | null;
  price: number | null;
  enrichment: unknown;
  /**
   * Total promo/discount folded into this line's `price` by a transformer
   * (negative). Set when a separate discount line was merged into the item so
   * the net price shows on one row; the web view surfaces it as a sub-note.
   */
  discount?: number | null;
}

export interface ReceiptDraft {
  store: Store;
  items: Item[];
  totals: Record<string, number | null>;
}

export interface TransformContext {
  /** The receipt id being transformed. */
  receiptId: string;
  /** Optional per-profile config object (from the profile definition). */
  config: Record<string, unknown>;
  /** Structured logging hook (no console access inside transformers). */
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface TransformerMeta {
  name: string;
  description?: string;
  version?: number;
}

/**
 * The entrypoint every transformer module must export. Mutate `receipt` in place
 * and/or return a (possibly new) draft; returning nothing uses the mutated one.
 */
export type Transform = (
  receipt: ReceiptDraft,
  ctx: TransformContext
) => ReceiptDraft | void;
