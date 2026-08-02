# Changelog

All notable changes to orc-smash, derived from the project's 125-commit git
history (from the initial scaffold to the current state). The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/). Entries are grouped
by milestone, newest first.

---

## Color theming, column sizing, and the research role

### Added
- **Semantic per-location color theming system** (`src/theme.ts`,
  `config/theme.yaml`): colors are defined by semantic token (`role.auditor`,
  `result.fail`, `emphasis.identity`, …) in a zod-validated YAML file, with
  per-location overrides (`status-panel`, `terminal-accent`, `plain-timeline`,
  `log`). Ships a rich palette (orange/teal/purple/…) replacing the old
  monochrome hardcoded helpers. (`b86f916`)
- **`--theme <path>` CLI option** for `orc smash` and `orc status`, resolving
  a three-tier precedence: explicit path → project `.theme.yaml` → packaged
  `config/theme.yaml`. (`b86f916`)
- **Dedicated `researcher` role** (`roles/researcher.md`) for the
  `research-audit` skill, distinct from `auditor`. (`d85e96e`)
- **Content-aware column sizing**: each table column sizes to its measured
  content (clamped to `[minimum, preferred]`) rather than stretching to fill
  the terminal — empty columns collapse, long ones grow. (`b86f916`,
  restored in `1f1a409`)
- **AC4 byte-identity baseline test + fixtures**: snapshot the status panel
  and `--plain` timeline against a captured pre-feature renderer output to
  prove the theming layer is byte-neutral. (`6d4fd88`, baseline regenerated
  against content-aware in `1f1a409`)

### Fixed
- **Boxen inner-width mismatch**: table was sized to `terminalWidth − 4`
  but boxen's chrome (round border + padding 1) consumes 8 — a filled final
  column word-wrapped onto a new line. Fixed with `boxInnerWidth()`. (`6199612`)
- **Model prefix stripping in tables**: `formatModelDisplay()` strips the
  opencode namespace prefix (`opencode-go/`) in timeline and run-config
  tables for readability. (`6199612`)
- **Effort/status/result column widths tuned**: Status → 12 (fits
  `unclassified`), Model → 17 (fits `deepseek-v4-flash`), Effort → 8,
  Session → 7, minimums floored at header-name length. (`6199612`, `1f1a409`)

## Batch 8 — spec/plan contract (paired planning set)

### Added
- `docs/dev/spec.md` as the acceptance contract paired with `docs/dev/plan.md`
  as the delivery/closeout source; the `plan` loop audits both as one set
  through a named `specPath` file input. (`69218a0`, `fb23110`)
- `create-spec` task (`24-simple-create-spec`) for plan-only project migration:
  writes `spec.md` bound to the existing plan and requires a fresh joint plan
  approval before implementation or review. (`69218a0`)
- `create-plan` skill (`23-simple-create-plan`) for the research-first
  pipeline's plan-creation stage. (`69218a0`)
- Composite artifact snapshots: `resultFingerprint` now includes declared
  `files:` dependencies, not just the target. (`69218a0`)
- Joint audit skills for research and plan: `10-simple-research-audit` and
  `21-simple-plans-audit` operate on both the target and its paired
  dependency. (`fb23110`)
- Review and follow-up skills (`40-simple-review`, `42-simple-review-follow-up`)
  with role-aware prompt contracts. (`fb23110`)

## `--show-fingerprints` presentation flag

### Added
- Default-off, run-scoped `--show-fingerprints` flag for `orc smash` and
  `orc status`: adds four diagnostic columns (`Artifact`, `Parent`,
  `Input FP`, `Result FP`) to the wide timeline table, or a compact
  `artifact … parent … in … out …` identity line per row on narrow
  terminals. (`5af1f1f`)

## Batch 6 — research-first pipeline

### Added
- Optional `research-first` pipeline: `research → create-plan → plan →
  implement → review`. Research is never a prerequisite for the default
  pipeline; every stage transition remains operator-confirmed. (`a37d0ab`)
- `research` approval loop (target: `docs/dev/research.md`) with
  `research-audit` evaluate and `research-follow-up` repair skills. (`a37d0ab`)
- Reordered `research-first` stages for logical precedence. (`605201d`)

## Batch 5 — operator tasks and local commit

### Added
- Configured **Tasks** action: generic task chooser listing all configured
  tasks in manifest declaration order, with task-detail confirmation.
  (`ae79c6a`)
- Packaged `commit` task (`50-simple-commit`): agent-run, one local commit
  for an operator-selected scope, explicit-path staging, preserves unrelated
  changes, never contacts a remote. (`ae79c6a`)

## Batch 4 — provider progress telemetry

### Added
- Structured progress telemetry for `opencode`, `codex`, and `claude`
  (tool-call counts, progress messages) carried through live and plain event
  views without affecting workflow state or watchdog deadlines. `agy`
  declares `unavailable`. (`c09d147`)
- Active-loop-aware panel context (`f17759e`) and `--all` flag for
  cross-loop timeline display. (`6143517`)

## Batch 3 — artifact outcomes and recovery

### Added
- Artifact outcome normalization (`COMPLETED` / `BLOCKED` / `unknown`) for
  completion contracts; blocked implementation ledgers persist as durable
  evidence but never unlock a successor. (`cec7ecf`)
- Confidence-pattern tightening, decision-correction resilience, and
  implementation-ledger regression tests. (`3530c57`)
- Watchdog timeouts (config-driven; `opencode` has env override, others
  config-only). (`c320ac3`)
- `SIGINT`/`SIGTERM` interrupted-run handling: durable marker, partial-artifact
  quarantine, resumable state. (`c320ac3`)

## Batch 2 — runner selection and continuity UX

### Added
- Per-skill runner selection: interactive provider/model/effort/session
  selection with `--runner`, `--runner-model`, `--runner-effort` CLI
  overrides. (`6b6eec8`)
- Per-skill session continuity (`resume-per-skill` / `fresh-per-invocation`)
  with capability-driven `resumeSession`. (`6b6eec8`)
- `continuation-runners.ts`: single seam for chain-walk and continuity
  predicate. (`6b6eec8`)

## Batch 1 — status panel and timeline

### Added
- Live status panel (`renderStatusPanel`): boxen-bordered TUI with project
  info, run configuration, active invocation, timeline table, and in-flight
  step detail. Alternate-screen with `--plain` append-only mode for CI.
  (`34beed1`)
- Timeline table with nine operational columns (version, role, agent, model,
  effort, result, time, session, status). (`34beed1`)
- `project-snapshot-view.ts` and `project-snapshot-renderer.ts` for
  `orc status` detailed and compact snapshot rendering. (`34beed1`)

## AGY provider adapter

### Added
- Full AGY (Antigravity) adapter: `--new-project` workspace binding,
  `--project`/`--conversation` resumed-session pair captured from a
  temporary `--log-file`, opaque `agy:v1:<uuid>:<uuid>` session token.
  (`704a0e9`, `7a70673`)
- Logical Gemini model slugs with separate effort choices; strict allow-list
  model validation (no namespace fallback). (`84600d6`, `7a70673`)
- Auth-failure detection (`error.kind === 'auth'`) with bounded phrase
  matching; partial-artifact quarantine. (`7a70673`)

## Binding-aware pipeline lineage

### Added
- Binding-aware pipeline stage state: each artifact carries pipeline/run/
  stage/chain identity, parent lineage, runner provenance, and fingerprints.
  (`0f6211c`, `3ecf12a`)
- Typed candidate reasons: `target-fingerprint-drift`,
  `missing-target-fingerprint`, `exact-edge-consumed`, `eligible`. (`0f6211c`)
- Exact-edge single-use replay suppression; distinct accepted chains remain
  independent candidates. (`0f6211c`)

## Interactive operator surface

### Added
- Unified action menu with standardized `(unavailable: reason)` labels and
  typed availability categories. (`b2a0f01`, `a8d25fd`)
- Pipeline suggestions (`R3`): eligible continuation candidates with
  predecessor/successor context. (`444113c`)
- Operator menus (`R2`): per-skill continuity, error-boundary recovery,
  force-select upfront runner prompt. (`60801ef`, `30d3166`)
- Second-opinion audits seed their own fresh continuity chain. (`62ac194`)

## Ownership and portable process groups

### Added
- Crash-safe owned runs with `ORC_RUN_ID`/`ORC_RUN_TOKEN` authenticated
  admission protocol, lease records, and portable POSIX process groups.
  (`07d98cc`, `70df2d5`)
- Authorized kill gate (`kill-gate.ts`): identity-gated `process.kill(-pgid)`;
  unverifiable/recycled groups never signalled; residual risk documented.
  (`a226098`)
- `orc ownership status` / `orc ownership release` diagnostic recovery.
  (`07d98cc`)
- `bin/orc.js` as the canonical runtime entrypoint. (`0b8c4d1`)

## Provider adapters

### Added
- `opencode` first-class adapter with stream parsing and structured error
  handling. (`67ed814`)
- `codex` and `claude` audit continuity with opt-in resumed-session chains.
  (`8139eaa`, `bad9ccf`)
- Centralized model registry config (`config/providers/*.yaml`) replacing
  inline provider definitions. (`403908d`, `b4d2717`)
- Provider catalogue split into per-agent YAML files. (`403908d`)

## Typed plain output and runner overrides

### Added
- `--plain` append-only, typed event stream for CI/logs. (`498e966`)
- `runner-overrides.ts` for `--runner`/`--runner-model`/`--runner-effort`
  repeatable CLI parsing. (`5cecb37`)
- Implementation-ledger validation diagnostics. (`6d19828`)

## Diagnostics and harness events

### Added
- Harness event logging (`debugHarnessEvent`) and screen-output buffering for
  CI diagnostics. (`a7e9854`)
- `--debug-spawn` flag for provider spawn/process debug logs. (`a7e9854`)

## Codex/Claude/Antigravity model updates

### Changed
- Added grok-4.5, gpt-5.6-luna, hy3 models and confirmed opencode variants.
  (`6ec6cce`)
- Set default effort for claude/agy/opencode providers. (`e0eb977`, `c8df1ad`)

## Repository scaffolding

- Initial orc-smash CLI implementation. (`97b7d31`)
- Initial authority docs and repo scaffold. (`769c79a`)
- `.gitignore` with Node/pnpm best practices. (`c1365b1`)
- `.env.example`. (`a02feb7`)
