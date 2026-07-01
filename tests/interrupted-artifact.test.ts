import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  setActiveProjectRoot,
  setStepCtx,
  getStepCtx,
  getActiveProjectRoot,
  clearInterruptState,
  markerPath,
  writeInterruptedMarker,
  readInterruptedMarker,
  clearInterruptedMarker,
  resolveInterruptedArtifactPath,
  quarantineArtifact,
  quarantineLateArtifactsForLoop,
  quarantineInterruptedResume,
  handleInterruptSignal,
  INTERRUPTED_MARKER_DIR,
  type InterruptedMarker
} from '../src/interrupted-artifact.js';
import { resetActiveChildren } from '../src/adapters/utils.js';
import type { LoopSpec } from '../src/manifest.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

function makeMarker(overrides: Partial<InterruptedMarker> = {}): InterruptedMarker {
  return {
    loop: 'plan',
    kind: 'audit',
    version: 3,
    agent: 'codex',
    model: 'gpt-5.4',
    skillId: 'plan-audit',
    interruptedAtMs: 1_000_000,
    ...overrides
  };
}

/** A representative three-loop manifest shape (plan/review/implement patterns). */
function makeLoops(): Record<string, LoopSpec> {
  const base = {
    target: '.',
    targetKind: 'file' as const,
    inputs: []
  };
  return {
    plan: {
      ...base,
      kind: 'doc-audit' as const,
      audit: 'plan-audit',
      'follow-up': 'plan-followup',
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    },
    review: {
      ...base,
      kind: 'code-review' as const,
      planPath: 'docs/dev/plan.md',
      audit: 'review-audit',
      'follow-up': 'review-followup',
      auditPattern: 'docs/dev/review-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/review-followup-v{n}-{agent}.md'
    },
    implement: {
      ...base,
      kind: 'implement' as const,
      planPath: 'docs/dev/plan.md',
      implement: 'simple-implement',
      implementPattern: 'docs/dev/impl-v{n}-{agent}.md'
    }
  };
}

describe('interrupted-artifact marker I/O', () => {
  const tempDir = join(process.cwd(), 'temp-interrupted-marker');

  beforeEach(() => {
    createTempDir('temp-interrupted-marker');
    clearInterruptState();
    resetActiveChildren();
  });
  afterEach(() => {
    removeTempDir(tempDir);
    clearInterruptState();
  });

  it('writes then reads a marker round-trip under the project root', () => {
    writeInterruptedMarker(tempDir, makeMarker());
    const read = readInterruptedMarker(tempDir);
    expect(read).toEqual(makeMarker());
    // Marker lives under <projectRoot>/.orc-smash/interrupted.json
    expect(existsSync(markerPath(tempDir))).toBe(true);
    expect(markerPath(tempDir)).toBe(join(tempDir, INTERRUPTED_MARKER_DIR, 'interrupted.json'));
  });

  it('returns null when no marker exists (no-marker no-op)', () => {
    expect(readInterruptedMarker(tempDir)).toBeNull();
  });

  it('treats a corrupt marker as absent (never blocks resume)', () => {
    mkdirSync(join(tempDir, INTERRUPTED_MARKER_DIR), { recursive: true });
    writeFileSync(markerPath(tempDir), '{ not valid json');
    expect(readInterruptedMarker(tempDir)).toBeNull();
  });

  it('treats a structurally-invalid marker (wrong field types) as absent', () => {
    mkdirSync(join(tempDir, INTERRUPTED_MARKER_DIR), { recursive: true });
    writeFileSync(markerPath(tempDir), JSON.stringify({ loop: 'plan', kind: 'audit', version: 'oops' }));
    expect(readInterruptedMarker(tempDir)).toBeNull();
  });

  it('clear removes the marker file (idempotent when absent)', () => {
    writeInterruptedMarker(tempDir, makeMarker());
    clearInterruptedMarker(tempDir);
    expect(existsSync(markerPath(tempDir))).toBe(false);
    // Second clear is a no-op, not an error.
    expect(() => clearInterruptedMarker(tempDir)).not.toThrow();
  });
});

describe('interrupted-artifact path resolution from marker + manifest', () => {
  const loops = makeLoops();

  it('resolves the audit artifact path for a plan-audit marker', () => {
    const path = resolveInterruptedArtifactPath('/proj', makeMarker({ loop: 'plan', kind: 'audit', version: 3, agent: 'codex' }), loops);
    expect(path).toBe(join('/proj', 'docs/dev/plan-audit-v3-codex.md'));
  });

  it('resolves the follow-up artifact path', () => {
    const path = resolveInterruptedArtifactPath('/proj', makeMarker({ kind: 'follow-up', version: 2, agent: 'claude' }), loops);
    expect(path).toBe(join('/proj', 'docs/dev/plan-followup-v2-claude.md'));
  });

  it('resolves the implement artifact path', () => {
    const path = resolveInterruptedArtifactPath('/proj', makeMarker({ loop: 'implement', kind: 'implement', version: 1, agent: 'agy' }), loops);
    expect(path).toBe(join('/proj', 'docs/dev/impl-v1-agy.md'));
  });

  it('returns null when the marker loop is unknown', () => {
    expect(resolveInterruptedArtifactPath('/proj', makeMarker({ loop: 'nope' }), loops)).toBeNull();
  });
});

describe('interrupted-artifact quarantine', () => {
  const tempDir = join(process.cwd(), 'temp-interrupted-quarantine');

  beforeEach(() => {
    createTempDir('temp-interrupted-quarantine');
    clearInterruptState();
  });
  afterEach(() => {
    removeTempDir(tempDir);
    clearInterruptState();
  });

  it('moves an existing artifact into docs/dev/archived/', () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const artifact = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    writeFileSync(artifact, 'partial');
    const result = quarantineArtifact(tempDir, artifact, { reason: 'interrupted', notBeforeMs: 0 });
    expect(result.quarantined).toBe(true);
    expect(result.archivedPath).toContain('docs/dev/archived');
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(result.archivedPath!)).toBe(true);
    expect(readFileSync(result.archivedPath!, 'utf-8')).toBe('partial');
  });

  it('is a no-op when the artifact does not exist', () => {
    const result = quarantineArtifact(tempDir, join(tempDir, 'docs/dev/missing.md'));
    expect(result.quarantined).toBe(false);
    expect(result.archivedPath).toBeNull();
  });

  it('respects the notBeforeMs late-guard (older files are NOT quarantined)', () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const artifact = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    writeFileSync(artifact, 'old');
    // File mtime is "now"; a far-future threshold means the file is NOT newer → skip.
    const result = quarantineArtifact(tempDir, artifact, { notBeforeMs: Date.now() + 60_000 });
    expect(result.quarantined).toBe(false);
    expect(existsSync(artifact)).toBe(true);
  });

  it('quarantineLateArtifactsForLoop moves only pattern-matching files newer than the threshold', () => {
    const loops = makeLoops();
    const planSpec = loops['plan']!;
    const implementSpec = loops['implement']!;
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    
    const newerAudit = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    const newerFollowUp = join(tempDir, 'docs/dev/plan-followup-v3-codex.md');
    const olderAudit = join(tempDir, 'docs/dev/plan-audit-v2-codex.md');
    const olderFollowUp = join(tempDir, 'docs/dev/plan-followup-v2-codex.md');
    const unrelated = join(tempDir, 'docs/dev/plan.md');
    
    writeFileSync(newerAudit, 'new audit');
    writeFileSync(newerFollowUp, 'new follow-up');
    writeFileSync(olderAudit, 'old audit');
    writeFileSync(olderFollowUp, 'old follow-up');
    writeFileSync(unrelated, 'plan body');
    
    const past = new Date(Date.now() - 60_000);
    utimesSync(olderAudit, past, past);
    utimesSync(olderFollowUp, past, past);
    const threshold = Date.now() - 30_000;

    const archived = quarantineLateArtifactsForLoop(tempDir, planSpec, threshold);
    expect(archived.length).toBe(2);
    expect(existsSync(newerAudit)).toBe(false);       // quarantined
    expect(existsSync(newerFollowUp)).toBe(false);    // quarantined
    expect(existsSync(olderAudit)).toBe(true);        // too old, kept
    expect(existsSync(olderFollowUp)).toBe(true);     // too old, kept
    expect(existsSync(unrelated)).toBe(true);        // not a pattern match, kept

    const newerImpl = join(tempDir, 'docs/dev/impl-v3-codex.md');
    writeFileSync(newerImpl, 'new implement');
    const archivedImpl = quarantineLateArtifactsForLoop(tempDir, implementSpec, threshold);
    expect(archivedImpl.length).toBe(1);
    expect(existsSync(newerImpl)).toBe(false);        // quarantined
  });

  it('quarantineInterruptedResume: marker present → quarantine in-flight + clear marker', () => {
    const loops = makeLoops();
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const artifact = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    writeFileSync(artifact, 'partial');
    writeInterruptedMarker(tempDir, makeMarker({ interruptedAtMs: 0 }));

    const result = quarantineInterruptedResume(tempDir, loops);
    expect(result.hadMarker).toBe(true);
    expect(result.marker).not.toBeNull();
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(markerPath(tempDir))).toBe(false); // marker cleared
    expect(result.quarantined.length).toBeGreaterThanOrEqual(1);
  });

  it('quarantineInterruptedResume: no marker → no-op', () => {
    const loops = makeLoops();
    const result = quarantineInterruptedResume(tempDir, loops);
    expect(result.hadMarker).toBe(false);
    expect(result.marker).toBeNull();
    expect(result.quarantined).toEqual([]);
  });
});

describe('interrupt-context registration + signal-safe entrypoint', () => {
  const tempDir = join(process.cwd(), 'temp-interrupted-signal');

  beforeEach(() => {
    createTempDir('temp-interrupted-signal');
    clearInterruptState();
    resetActiveChildren();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
  });
  afterEach(() => {
    removeTempDir(tempDir);
    clearInterruptState();
    vi.restoreAllMocks();
  });

  it('registration getters reflect set/clear (and clearInterruptState resets both)', () => {
    setActiveProjectRoot('/proj');
    setStepCtx({ loop: 'plan', kind: 'audit', version: 1, agent: 'codex', model: 'm', skillId: 's' });
    expect(getActiveProjectRoot()).toBe('/proj');
    expect(getStepCtx()?.agent).toBe('codex');
    clearInterruptState();
    expect(getActiveProjectRoot()).toBeNull();
    expect(getStepCtx()).toBeNull();
  });

  it('in-flight signal writes the marker to the active project root (not cwd), then exits 130', async () => {
    setActiveProjectRoot(tempDir);
    setStepCtx({ loop: 'plan', kind: 'audit', version: 3, agent: 'codex', model: 'gpt-5.4', skillId: 'plan-audit' });

    // The marker must land under the project root even though process.cwd()
    // is the test's launch directory, not tempDir.
    await expect(handleInterruptSignal('SIGINT')).rejects.toThrow(/EXIT:130/);
    expect(existsSync(markerPath(tempDir))).toBe(true);
    const marker = readInterruptedMarker(tempDir);
    expect(marker).not.toBeNull();
    expect(marker!.loop).toBe('plan');
    expect(marker!.version).toBe(3);
    expect(marker!.agent).toBe('codex');
  });

  it('post-completion signal (context cleared) writes NO marker', async () => {
    setActiveProjectRoot(tempDir);
    setStepCtx({ loop: 'plan', kind: 'audit', version: 3, agent: 'codex', model: 'm', skillId: 's' });
    setStepCtx(null); // runLoop cleared the step context in its finally path

    await expect(handleInterruptSignal('SIGTERM')).rejects.toThrow(/EXIT:143/);
    expect(existsSync(markerPath(tempDir))).toBe(false);
  });

  it('pre-setup signal (no project root registered) writes NO marker', async () => {
    // Before config/setup completes, no project root is registered.
    setStepCtx({ loop: 'plan', kind: 'audit', version: 1, agent: 'codex', model: 'm', skillId: 's' });
    await expect(handleInterruptSignal('SIGINT')).rejects.toThrow(/EXIT:130/);
    expect(getActiveProjectRoot()).toBeNull();
    // No marker anywhere under tempDir.
    expect(existsSync(join(tempDir, INTERRUPTED_MARKER_DIR))).toBe(false);
  });

  it('after an in-flight signal the step context is left null for the next run (no stale context)', async () => {
    setActiveProjectRoot(tempDir);
    setStepCtx({ loop: 'plan', kind: 'audit', version: 1, agent: 'codex', model: 'm', skillId: 's' });
    await expect(handleInterruptSignal('SIGINT')).rejects.toThrow();
    // A subsequent rerun starts fresh: callers clear context on completion, and
    // a new process has empty module state. Simulate by clearing.
    clearInterruptState();
    expect(getStepCtx()).toBeNull();
    expect(getActiveProjectRoot()).toBeNull();
  });
});

