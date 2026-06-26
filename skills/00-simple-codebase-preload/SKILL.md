---
name: 00-simple-codebase-preload
description: Reads and internalises all core project authority documents, architecture references, and stage workflow index before any task begins. Use this at the start of every session or when switching context between features.
---

## Purpose

Silently read and internalise all project authority documents before any task begins. This is a prerequisite for all other skills in this pipeline.

---

## Project Discovery

Use the **workspace root** as the project root. Locate project documents in this order:

1. `.agents/AGENTS.md` — may declare project layout (docs root, source root, etc.)
2. `AGENTS.md` or `CLAUDE.md` at the workspace root
3. If authority docs are not at the root, scan immediate subdirectories for `CLAUDE.md`, `AGENTS.md`, or `README.md`

Do not assume a specific subdirectory structure (e.g. `flutter/`, `backend/`). Let the discovered files and any project config guide you.

---

## Global Quality Bar

All RPI stages should assume a best-practice, long-term engineering standard. Do not treat cut corners, partial architecture, or "limited for MVP" reductions as acceptable unless the approved documents explicitly define a phased delivery that preserves the full target architecture.

---

## Documents to Read — in Order

### Phase 1 — Core Workflow & Authority Documents

Search the workspace root (and immediate subdirectories if not found at root) for these files:

| Document      | Common Locations                         | Why Required                                                                                          |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **CLAUDE.md** | root, or declared in `.agents/AGENTS.md` | Canonical AI execution rules, patterns, verification policy, project context, architecture references |
| **AGENTS.md** | root, or `.agents/AGENTS.md`             | same as CLAUDE.md                                                                                     |
| **README.md** | root                                     | Repository layout, local setup, verification commands                                                 |

### Phase 2 — Architecture References

Search the project's documentation directory for architecture files. Common locations: `docs/`, `<source_root>/docs/`, or as declared in `AGENTS.md`.

| Document                  | Filename Pattern                         | Why Required                                   |
| ------------------------- | ---------------------------------------- | ---------------------------------------------- |
| **Architecture overview** | `ARCHITECTURE.md`                        | Top-level architecture overview                |
| **Frontend architecture** | `ARCHITECTURE_FRONTEND.md` or equivalent | State management, data flow, feature structure |
| **Backend architecture**  | `ARCHITECTURE_BACKEND.md` or equivalent  | Backend integration assumptions                |

---

## Feature Selection

After loading the core documents, **ask the user**:

> Are you working on a specific feature? If so, which one?

- If the user names a feature, locate its folder under `docs/dev/<feature>`
- If the user says no or is unsure, proceed without loading feature-specific documents. Do not guess or assume a feature.
- Do not load documents from multiple features unless the user explicitly requests it.

---

## Preload Evidence Checklist

After reading, retain a compact evidence checklist internally and report only the essentials:

| Check                 | Required Evidence                                                 |
| --------------------- | ----------------------------------------------------------------- |
| Core authority loaded | `CLAUDE.md`, or `AGENTS.md`, `README.md` readable                 |
| Architecture loaded   | frontend/backend architecture docs readable or explicitly missing |
| Feature selected      | Named by user, or explicitly none                                 |
| Missing docs          | Every missing authority document named explicitly                 |

---

## Rules

- If a core authority document is missing (`CLAUDE.md`, or `AGENTS.md`, stop and report the missing path unless the user explicitly asks to continue.
- If a non-core document is missing, log: `⚠️ Missing: [path]` and continue.
- Do not summarise the documents back unless explicitly asked.
- Do not begin any task until all readable documents have been processed.
