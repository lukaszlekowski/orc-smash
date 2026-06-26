# Live Mixed-CLI Smoke Sign-off Record

Date: 2026-06-26
Status: APPROVED

This document records the verification and sign-off for the real-provider integration within `orc-smash`.

## 1. Environment & Tools
The following CLI tools and models were verified on the local host:
- **opencode**: Version `1.17.11` using model `opencode/deepseek-v4-flash-free`
- **codex**: Version `0.142.2` using model `gpt-5.4`
- **claude**: Version `2.1.191 (Claude Code)` using model `claude-sonnet-4-6`

## 2. Real-Provider Contract Verification
Execution of:
`OPENCODE_DEFAULT_MODEL=opencode/deepseek-v4-flash-free CODEX_DEFAULT_MODEL=gpt-5.4 CLAUDE_DEFAULT_MODEL=claude-sonnet-4-6 OPENCODE_CONTRACT=1 CODEX_CONTRACT=1 CLAUDE_CONTRACT=1 pnpm test`

Outcome:
- **opencode**: Spawns correctly, writes JSON format, and creates expected verdict file under `docs/dev`.
- **codex**: Spawns non-interactively using the `exec` command, skips repository check, and writes the verdict file correctly.
- **claude**: Spawns with `-p <prompt>`, `--model <model>`, `--output-format json`, and `--permission-mode bypassPermissions` flags (no `--print`); the headless JSON-output and bypass-permissions flags let it run non-interactively, return a response, and write the verdict file. This is the exact invocation produced by `claudeAdapter.buildRun()` in `src/adapters/claude.ts` and asserted by `tests/adapters-args.test.ts`.

## 3. Live Mixed-CLI Smoke Test
A real loop execution was run against a local disposable fixture project:
- **Skill Loop**: `plan`
- **Role Assignments & Runner Overrides**:
  - `plan-follow-up` -> **opencode** (`opencode/deepseek-v4-flash-free`)
  - `plan-audit` -> **codex** (`gpt-5.4`)
  - Second-opinion `plan-audit` -> **claude** (`claude-sonnet-4-6`)

### Execution Trace & Verification
1. **N=1 Audit (Codex)**:
   - Spawns `codex exec -m gpt-5.4 --skip-git-repo-check <prompt>`
   - Writes `docs/dev/plan-audit-v1-codex.md` containing `REJECTED` verdict.
2. **N=2 Follow-up (Opencode)**:
   - Spawns `opencode run -m opencode/deepseek-v4-flash-free --dir ... --dangerously-skip-permissions --format json <prompt>`
   - In-place patches the plan file.
3. **N=2 Audit (Codex)**:
   - Spawns `codex` on the patched plan file.
   - Writes `docs/dev/plan-audit-v2-codex.md` containing `APPROVED` verdict.
4. **Second Opinion (Claude)**:
   - Interactive prompt triggers asking for second opinion. Choosing `run-second-opinion` prompts agent select -> select `claude`.
   - Spawns `claude -p <prompt> --model claude-sonnet-4-6 --output-format json --permission-mode bypassPermissions`
   - Writes `docs/dev/plan-audit-v3-claude.md` with final `APPROVED` verdict.

All three real providers successfully spawned, communicated, wrote artifacts, and advanced the state machine loop to completion.
