# Trigger-description optimization — how to run the automated loop

The automated optimizer (`skill-creator/scripts/run_loop.py`) tests the skill's
`description` against the queries in `eval-set.json` and proposes improvements,
selecting the best by held-out test score.

**It couldn't run inside the agent sandbox** because it shells out to `claude -p`,
which returned `401 Invalid authentication credentials` there (the nested CLI
had no usable auth). Run it from a normal terminal where your Claude Code login
works:

```bash
SC="$HOME/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/d0eaddda-89b6-4146-8a96-6ca8e8e440e7/a8b27dd5-1c38-42b6-95ce-bc7bc5cc79b3/skills/skill-creator"
cd "$SC"

# make sure the empty key isn't shadowing your CLI auth:
unset ANTHROPIC_API_KEY

python3 -m scripts.run_loop \
  --eval-set "$HOME/Projects/claude-receipt-ocr/.claude/skills/receipt-enricher-dev-workspace/trigger-opt/eval-set.json" \
  --skill-path "$HOME/Projects/claude-receipt-ocr/.claude/skills/receipt-enricher-dev" \
  --model opus \
  --max-iterations 5 \
  --verbose \
  --results-dir "$HOME/Projects/claude-receipt-ocr/.claude/skills/receipt-enricher-dev-workspace/trigger-opt"
```

It splits the eval set 60/40 train/test, runs each query 3× for a reliable
trigger rate, and iterates up to 5 times. When done it opens an HTML report and
prints `best_description`. Paste that into the `description:` field of
`../receipt-enricher-dev/SKILL.md` if it beats the current one.

## Meanwhile: a manual optimization pass was applied

Since the loop couldn't run here, the description was hand-tuned against
`eval-set.json`:
- **Reduced under-triggering**: named the receipt parser + store detection
  (`KNOWN_STORES`) and the concrete dev tasks/commands explicitly.
- **Reduced over-triggering**: added a scope clause excluding generic OCR/PDF,
  generic BullMQ/Redis/Docker/Express work in *other* repos, and one-off
  "read this receipt for me" requests — the near-miss cases in the eval set.

`eval-set.json`: 10 should-trigger + 10 should-not-trigger (deliberately tricky
near-misses) for whenever you run the automated loop.
