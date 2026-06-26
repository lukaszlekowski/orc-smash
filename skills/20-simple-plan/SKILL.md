---
name: 20-simple-plan
description: Creates plan document for an approved feature before implementation begins.
---

## Purpose

Draft a comprehensive, production-ready implementation plan. For every step, provide explicit file-level and code-level instructions (including exact functions, hooks, or files to modify), use industry best practices.

---

## Quality Standard

Plans must preserve the best-practice, long-term architecture approved in research. Do not downgrade requirements into "MVP-only" shortcuts, partial implementations, vague follow-up work, or structural-only scaffolding when those requirements are central to the feature's quality. If delivery must be phased, the documents must still define the full target architecture, the release boundary, and make every phase independently verifiable against real workflow behavior.

For architecture-critical, security-critical, data-integrity, paid-access, startup, sync, or cross-stack work, the plan set must prove how the real workflow will function end to end. Do not treat providers, models, routes, config fields, or UI locks as complete unless the plan also covers the owning source of truth, persistence/sync behavior, error states, failure recovery, tests, and manual verification needed to prove the user/developer/backend workflow.

---

## Documents to Produce

### Plan (`docs/dev/plan.md`)

---

## Rules

- Do not weaken approved research into MVP shortcuts or partial architecture; preserve the full long-term standard in the plan.
- Every plan step must be independently verifiable
- Confidence score required in each document header
- If confidence < 0.95 for any generated document, stop and report the specific blockers instead of finalizing the docs.
- Each step must say exactly what will change, where it will change, why it is needed, and any important edge cases or regressions to watch for. Do not write generic advice.
- Assume the model executing this has no reasoning capabilities and requires literal instructions.
- If you detect vagueness in your own draft, stop and rewrite before answering.

---

## Confirmation

Before writing, state:

- Which documents you will produce
- Your confidence score per document
- Any specific gaps that affect your confidence in generating high quality plan document.
