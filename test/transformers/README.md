# Transformer regression + evaluation suites

Two complementary suites for receipt-profile **transformers**
(`src/receiptProfiles/transformers/`), both driven by one set of per-receipt
fixtures:

1. **Regression** (`transformers.test.js`, run by `npm test`) — pins each
   transformer to a known `input`→`expected` mapping so edits can't *silently*
   change behavior. Hermetic; sibling to `acceptance/` but unlike that
   bash/container suite it runs in-process.
2. **Evaluation** (`eval.js`, run by `npm run eval`) — measures *quality* against
   the verbatim vision `groundTruth` (store accuracy, description similarity, …)
   and compares it to the baseline table recorded in the transformer's header
   comment, flagging regressions. A reporting tool, not part of `npm test`.

## Layout

```
test/transformers/
├─ README.md
├─ _helpers.js            # listFixtures(), applyToInput() (registry + engine)
├─ transformers.test.js   # REGRESSION test (one case per fixture)
├─ generate-fixtures.js   # rewrite every fixture's `expected` from its `input`
├─ eval.js                # EVALUATION harness (vs groundTruth + recorded baseline)
└─ fixtures/
   └─ <transformerId>/    # e.g. tesseractGroceryUs/
      └─ *.json
```

## Fixture format

```jsonc
{
  "transformer": "tesseractGroceryUs",   // registry id (filename, no extension)
  "name": "costco/PXL_...jpg",            // human label (provenance)
  "note": "...",                          // optional
  "input":       { "store": …, "items": […], "totals": … }, // a parsed OCR receipt
  "groundTruth": { "store": …, "items": […], "totals": … }, // verbatim vision reference (for eval.js)
  "expected":    { "store": …, "items": […], "totals": … }  // canonical engine output (for the regression test)
}
```

`input` is a parsed receipt as it enters a profile (for `tesseractGroceryUs`
these are **real Tesseract parses** of the `samples/` photos — noisy descriptions,
embedded SKUs, lost store name, sign-dropped discounts, phantom rows).
`groundTruth` is the verbatim **vision** parse of the same photo (the quality
target). `expected` is the `{ store, items, totals }` the engine produces today
(the engine's derived `changes` audit trail is not pinned).

## Running

```bash
npm test                                   # includes this suite
node --test test/transformers/transformers.test.js   # just this suite
```

## Workflow

- **A transformer regressed unintentionally** → a fixture test fails with a diff.
  Fix the transformer.
- **You changed a transformer on purpose** → regenerate the goldens, eyeball the
  JSON diff (`git diff`), and commit:

  ```bash
  node test/transformers/generate-fixtures.js
  ```

- **Add a new case** → drop a JSON file with `transformer` + `input` (and a
  `name`) into `fixtures/<transformerId>/`, then run the generator to fill
  `expected`. New transformers get their own `fixtures/<id>/` folder.

## Evaluation (quality vs. ground truth)

```bash
npm run eval                     # suite: every transformer with a groundTruth dataset
npm run eval:tesseractGroceryUs  # one transformer
```

`eval.js` aligns the transformer's output to each fixture's `groundTruth` (by SKU,
then best description match) and reports, RAW vs AFTER:

| Metric | meaning |
|---|---|
| Store-name accuracy | canonical store matches ground truth |
| Exact / Mean description | description match against the printed text |
| Item precision / recall | matched items vs candidate / vs ground truth |
| Price match, SKU recall | per-matched-item price; GT SKUs recovered |
| Subtotal reconciliation | items sum to the printed subtotal |

It then reads the **baseline** from the `## Quality baseline` markdown table in the
transformer's header comment and flags any metric that drops below it
(`REGRESSION`), exiting non-zero. After an intentional change that moves the
numbers, update that table in the transformer comment.

**Adding an eval for another transformer** (e.g. a non-Tesseract / vision one):
give its fixtures a `groundTruth` block and a `## Quality baseline` table in its
header comment — `npm run eval` discovers it automatically. Add a matching
`eval:<id>` npm script if you want a one-liner for it.

> The `analysis/` folder (git-ignored) holds the throwaway harness that *produced*
> these fixtures from the sample photos (OCR runs + side-by-side); the committed
> contract lives here.
