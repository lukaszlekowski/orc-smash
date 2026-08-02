# Changelog

All notable changes to orc-smash are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-08-02

### Added
- Semantic per-location color theming system (`src/theme.ts`, `config/theme.yaml`):
  colors defined by semantic token, resolved per renderer location, with a rich
  palette (orange/teal/purple) replacing the old monochrome helpers.
- `--theme <path>` CLI option for `orc smash` and `orc status`.
- Content-aware column sizing: columns size to measured content clamped to
  `[minimum, preferred]` — sparse columns collapse, long ones grow.
- Byte-identity baseline test + snapshot fixtures proving the theming layer
  is byte-neutral.
- `CHANGELOG.md`.

### Changed
- `terminal-accent.ts` helpers now delegate to `theme.ts`; all call sites
  pass an optional location argument (signatures preserved).
- `panelBorderColor` shares a single `borderContext` extraction (no duplicate
  context-to-color map in source).
- Updated `README.md`, `AGENTS.md`, and `docs/architecture/overview.md` for
  the theming system.

## 2026-08-01

### Added
- Dedicated `researcher` role (`roles/researcher.md`) for the `research-audit`
  skill.
- Spec/plan paired contract: `docs/dev/spec.md` as acceptance source paired
  with `docs/dev/plan.md`; the plan loop audits both as one set through a
  named `specPath` input.
- `create-spec` task for plan-only project migration.
- `create-plan` skill for the research-first pipeline.
- Composite artifact snapshots: `resultFingerprint` now includes declared
  `files:` dependencies, not just the target.
- Joint audit skills (`research-audit`, `plans-audit`) and review/follow-up
  skills with role-aware prompt contracts.
- Default effort levels for claude, agy, and opencode providers.

### Fixed
- Table sized to boxen's real inner width (`terminalWidth − 8`, not `− 4`),
  fixing a filled-final-column word-wrap onto a new line.
- Model prefix stripping (`opencode-go/`) in timeline and run-config tables.
- Column preferred/minimum widths tuned (Status 12, Model 17, Effort 8).

## 2026-07-31

### Added
- Optional `research-first` pipeline (`research → create-plan → plan →
  implement → review`). Research is never a prerequisite for the default
  pipeline; every stage transition remains operator-confirmed.
- Operator **Tasks** action: generic task chooser in manifest declaration
  order with task-detail confirmation.
- Packaged `commit` task (`50-simple-commit`): agent-run, one local commit,
  explicit-path staging, never contacts a remote.
- `--show-fingerprints` presentation flag for `orc smash` and `orc status`:
  adds diagnostic columns (Artifact, Parent, Input FP, Result FP) or a compact
  identity line on narrow terminals.
- grok-4.5, gpt-5.6-luna, hy3 models and confirmed opencode variants.

### Changed
- Reordered research-first pipeline stages for logical precedence.

## 2026-07-27

### Added
- Live status panel (`renderStatusPanel`): boxen-bordered TUI with project
  info, run configuration, active invocation, timeline table, and in-flight
  step detail. Alternate-screen with `--plain` for CI.
- Timeline table with nine operational columns.
- `project-snapshot-view.ts` and `project-snapshot-renderer.ts` for
  `orc status` detailed and compact rendering.
- Per-skill runner selection with interactive provider/model/effort/session
  selection and `--runner`/`--runner-model`/`--runner-effort` CLI overrides.
- Per-skill session continuity (`resume-per-skill` / `fresh-per-invocation`).
- Artifact outcome normalization (`COMPLETED` / `BLOCKED` / `unknown`);
  blocked implementation ledgers persist as evidence but never unlock a
  successor.
- Confidence-pattern tightening and decision-correction resilience.
- Structured progress telemetry for `opencode`, `codex`, and `claude`
  (tool-call counts, progress messages).

### Fixed
- Disabled `wordWrap` in status-panel tables to prevent cell wrapping.

## 2026-07-24

### Added
- Unified action menu with standardized availability labels and typed
  categories.
- Pipeline suggestions with eligible continuation candidates.
- Interactive operator menus: per-skill continuity, error-boundary recovery,
  upfront runner prompt.
- Shared terminal semantics and inspectable prompt contracts.
- Binding-aware pipeline lineage: each artifact carries pipeline/run/stage/
  chain identity, parent lineage, runner provenance, and fingerprints.
- Typed candidate reasons (`target-fingerprint-drift`, `missing-target-
  fingerprint`, `exact-edge-consumed`, `eligible`).
- Full AGY (Antigravity) adapter: `--new-project` workspace binding,
  `--project`/`--conversation` resumed-session pair, opaque session token,
  logical Gemini model slugs, auth-failure detection.
- AGY effort tokens, strengthened model gate, effort validation.

## 2026-07-21

### Added
- `bin/orc.js` as the canonical runtime entrypoint.
- Typed plain output (`--plain`): append-only event stream for CI/logs.
- `runner-overrides.ts` for repeatable CLI override parsing.
- Implementation-ledger validation diagnostics.
- Harness event logging and screen-output buffering.
- R1 signal-interruption engine, interactive recovery loop, model-specific
  effort catalog.
- v1 digest verification, outcomes matrix, task-decision schema prohibition.
- Owned runs with `ORC_RUN_ID`/`ORC_RUN_TOKEN` admission protocol, lease
  records, portable POSIX process groups.
- Authorized kill gate: identity-gated `process.kill(-pgid)`.
- `orc ownership status` / `orc ownership release` diagnostic recovery.

### Fixed
- Provider artifact and timeout guidance.

## 2026-07-15

### Added
- Provider catalogue split into per-agent YAML files (`config/providers/*.yaml`).
- `createTestConfig` test helper.
- Owned-run supervision foundation: admission, `control.json`, `active.json`,
  lease timing, process-capability records.
- Ownership verification coverage and lifecycle cleanup.
- Crash-safe owned runs with portable process groups.
- Upfront runner prompt force-select and multi-iteration session-continuity
  fix.
- Session-ID column in timeline (truncated to last 5 chars with `*` prefix).
- Second-opinion audits seed their own fresh continuity chain.
- `--all` flag for cross-loop timeline display.
- Active-loop-aware panel context.

### Changed
- Implementation loop fix; chain-mode cycling on rejection without re-prompting.

### Fixed
- Approved-continue fallback regression for providers without session-resume.
- Review-v1 findings across follow-up chains and tests.

## 2026-07-08

### Added
- Antigravity (`agy`) provider with watchdog timeouts and interrupted-run
  handling.
- Codex and Claude audit continuity with opt-in resumed-session chains.
- Audit continuity broadened to opencode and Claude.
- Unified action menu plan.
- Centralized model registry config.
- Three-stage pipeline (`plan → implement → review`).
- Claude model updates; opencode timeout extension.

### Fixed
- AGY auth-detection grounding.
- Implementation loop fix.

## 2026-06-30

### Added
- Rendering and output polish for CLI/runtime ergonomics.
- Follow-up outcome contract and test infrastructure.

### Changed
- Harness core refactor.
- Roadmap grouping and model updates.

## 2026-06-26

### Added
- Initial orc-smash CLI implementation.
- `opencode` first-class adapter with stream parsing and structured error
  handling.
- Repository scaffold, authority docs, `.env.example`, and `.gitignore`.
