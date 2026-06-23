# How to use the `receipt-enricher-dev` skill in future Claude sessions

This is a **project skill** for Claude Code. It captures how the Receipt
Enricher repo is wired, how to develop/test/run it, and the environment gotchas
discovered while building it — so a future session doesn't have to rediscover
them.

## Where it lives

```
~/Projects/claude-receipt-ocr/.claude/skills/receipt-enricher-dev/
├─ SKILL.md                  # the skill (auto-loaded by Claude Code)
├─ HOW_TO_USE.md             # this file
└─ references/
   └─ stack-bringup.md       # fresh/isolated stack idioms (qa/feat prefixes)
```

`.claude/skills/` is the conventional location Claude Code scans for
project-scoped skills.

## How it gets used

1. **Launch Claude Code from the working-dir root** so the skill is discovered:
   ```bash
   cd ~/Projects/claude-receipt-ocr
   claude
   ```
   Skills in `./.claude/skills/` are picked up automatically for that session.

2. **Automatic triggering.** When you ask Claude to do something involving this
   project — "run the receipt tests", "why is the vision OCR failing?", "add a
   store to the parser", "process this receipt and show me the page" — the
   skill's description should cause Claude to consult `SKILL.md` before acting.

3. **Explicit invocation.** If it doesn't trigger on its own, just point at it:
   - "Use the receipt-enricher-dev skill."
   - or reference it as `/receipt-enricher-dev` if your client exposes skills as
     slash commands.

## Making it available everywhere (optional)

To use it from any directory (not just this repo), copy it to your personal
skills folder:

```bash
cp -r ~/Projects/claude-receipt-ocr/.claude/skills/receipt-enricher-dev \
      ~/.claude/skills/
```

Personal skills in `~/.claude/skills/` are available in every session.

## Keeping it accurate

The skill points to living docs rather than duplicating them (all repo-root
relative): `docs/API.md` (HTTP API), `test/README.md` (test design +
TLS-interception/Colab notes), `test/acceptance/README.md` (the bash/curl
acceptance suite + Podman workflow), and `scripts/README.md` (fetching &
checksum-verifying the gitignored blobs). If the project's architecture, env
gotchas, or commands change, update `SKILL.md` (and those docs) so future
sessions stay correct.
