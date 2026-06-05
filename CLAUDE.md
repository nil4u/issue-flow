# Issue Flow Plugin

Label-based issue state machine and deterministic git provider operations.

## Structure

- `.claude-plugin/plugin.json` — plugin manifest
- `assets/` — packaged runtime assets (workflow files, default prompts, templates, config)
- `skills/issue-flow/SKILL.md` — single skill entry point (agent-facing)
- `skills/issue-flow/scripts/` — deterministic CJS scripts
- `docs/` — human-facing documentation (labels, state machine, CI integration, provider API)
- `test/` — node:test based test suite

## Development

Run tests:

```bash
node --test test/
```

Scripts are CommonJS (.cjs) with no external dependencies beyond Node.js built-ins.
Provider operations use `gh`/`glab` CLI or direct HTTP via Node's built-in fetch.

## Key Conventions

- Scripts are the source of truth for deterministic behavior
- SKILL.md is the agent-facing usage guide (keep concise, avoid noise)
- docs/ are human-facing (CI setup, env vars, provider details)
- All scripts support `--dry-run` for safe testing
