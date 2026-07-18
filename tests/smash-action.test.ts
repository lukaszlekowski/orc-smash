import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/loop.js', () => ({
  runLoop: vi.fn().mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null })
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  const { loadManifest } = await import('../src/manifest.js');
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  return {
    ...actual,
    loadConfig: (projectRoot?: string) => {
      const registry = structuredClone(actual.DEFAULT_REGISTRY);
      registry.providers['fake'] = {
        models: ['fake-model'],
        defaultModel: 'fake-model'
      };
      for (const profileName of Object.keys(registry.profiles)) {
        registry.profiles[profileName] = { provider: 'fake' };
      }
      registry.defaultProfile = 'audit';
      registry.profiles['audit'] = { provider: 'fake' };

      const pRoot = projectRoot ?? process.cwd();
      let manifestPath = resolve(pRoot, 'skills.yaml');
      if (!existsSync(manifestPath)) {
        manifestPath = resolve(process.cwd(), 'skills.yaml');
      }
      const manifest = loadManifest(manifestPath, registry);
      return { registry, manifest };
    }
  };
});

let lastPromptedDefault: string | undefined;
let mockedLoopSelectChoice: string | undefined;
vi.mock('../src/interactive.js', () => ({
  promptLoopSelect: async (_loops: string[], defaultLoop: string) => {
    lastPromptedDefault = defaultLoop;
    return mockedLoopSelectChoice ?? defaultLoop;
  },
  promptStartPoint: async (_allowed: string[], defaultSP: string) => defaultSP,
  promptRunners: async (skills: string[]) => {
    const res: any = {};
    for (const s of skills) res[s] = { agent: 'fake', model: 'fake-model' };
    return res;
  },
  promptMaxIterations: async () => 5
}));

import { smashAction } from '../src/commands/smash.js';
import { runLoop } from '../src/loop.js';
import { buildFrontMatter } from '../src/provenance.js';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { makeArtifactMeta } from './helpers/provenance.js';
import { resolveImplementFacts } from '../src/state.js';
import * as configModule from '../src/config.js';
import { loadConfig } from '../src/config.js';

const mockedRunLoop = vi.mocked(runLoop);

let lastWarningMessage = '';
let lastErrorMessage = '';
const mockOutput = createMockOutput({
  warn: (msg: string) => { lastWarningMessage = msg; },
  error: (msg: string) => { lastErrorMessage = msg; }
});

describe('smashAction start-point derivation (consumes canonical rule)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-action');

  beforeEach(() => {
    createTempDir('temp-smash-action');
    mockedRunLoop.mockClear();
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
    mockedLoopSelectChoice = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writeAudit(version: number, verdict: 'APPROVED' | 'REJECTED') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v${version}-fake.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\n${verdict}\n`
    );
  }

  async function runSmash() {
    return await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
  }

  it('REJECTED state => runs loop successfully', async () => {
    writeAudit(1, 'REJECTED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(res.exitCode).toBe(0);
  });

  it('APPROVED state => runs loop successfully', async () => {
    writeAudit(1, 'APPROVED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(lastErrorMessage).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('fresh state (no audits) => runs loop successfully', async () => {
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(lastErrorMessage).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('unknown latest audit is terminal: rejected before runLoop is reached', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nGARBAGE\n`
    );
    const res = await runSmash();
    expect(mockedRunLoop).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
  });

  it('loop failure with verdict unknown returns exitCode: 1', async () => {
    mockedRunLoop.mockResolvedValueOnce({ success: false, verdict: 'unknown', message: 'failed', lastAuditPath: null });
    const res = await runSmash();
    expect(res.exitCode).toBe(1);
  });

  it('loop failure with verdict REJECTED (max iterations reached) returns exitCode: 0', async () => {
    mockedRunLoop.mockResolvedValueOnce({ success: false, verdict: 'REJECTED', message: 'max iterations', lastAuditPath: null });
    const res = await runSmash();
    expect(res.exitCode).toBe(0);
  });

  it('forwards the custom output options object to runLoop', async () => {
    const customOutput = { ...mockOutput };
    await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: customOutput
    });
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ output: customOutput });
  });

  it('direct implement loop entry fails if no approved plan exists', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'implement',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(mockedRunLoop).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
    expect(lastErrorMessage).toContain('No approved plan audit found');
  });

  it('direct implement loop entry succeeds and skips start-point derivation when plan is approved', async () => {
    writeAudit(1, 'APPROVED');
    const res = await smashAction({
      project: tempDir,
      loop: 'implement',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(res.exitCode).toBe(0);
    // Explicit override seeds the runner (no interactive prompt).
    const overrideRunners = mockedRunLoop.mock.calls[0]![4] as Record<string, unknown>;
    expect(overrideRunners['30-simple-implement']).toMatchObject({ agent: 'fake', model: 'fake-model' });
  });

  it('interactive implement (no override) defers runner selection to runLoop — does not silently seed the default', async () => {
    writeAudit(1, 'APPROVED');
    mockedLoopSelectChoice = 'implement';
    const res = await smashAction({ project: tempDir, output: mockOutput });
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(res.exitCode).toBe(0);
    const passedRunners = mockedRunLoop.mock.calls[0]![4] as Record<string, unknown>;
    // Not pre-seeded: runLoop's implement branch must prompt for the model.
    expect(passedRunners['30-simple-implement']).toBeUndefined();
  });

  it('v5-audit C1: interactive startup does NOT default to review after a closeout_failed run', async () => {
    // Pre-state: an approved plan audit exists, but the only implement
    // artifact is the agent's raw ledger (no harness front matter) —
    // exactly what the harness leaves on disk when writePlanCloseout
    // fails (Step 7 v5-audit C1 contract: writeArtifactWithMeta does
    // NOT run on the closeout_failed branch).
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );
    // Agent's raw ledger — no harness front matter. This simulates the
    // on-disk state after a `closeout_failed` run (Step 7 v5-audit C1).
    writeFileSync(
      join(tempDir, 'docs/dev/impl-v1-fake.md'),
      `# Implementation Evidence Ledger\n\n| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n| --- | --- | --- | --- | --- |\n| Step 1 | src/x.ts | pnpm test | pass | none |\n\n| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n| --- | --- | --- | --- |\n| Req A | src/x.ts | tests/x.test.ts | pass |\n\nState overall confidence: 1.00\n`
    );

    // Read the project-local manifest so we can call resolveImplementFacts
    // with the same patterns the loop uses internally.
    const config = loadConfig(tempDir);
    const facts = resolveImplementFacts(
      tempDir,
      {
        auditPattern: config.manifest.loops['plan']!.auditPattern ?? '',
        followUpPattern: config.manifest.loops['plan']!.followUpPattern ?? ''
      },
      {
        implementPattern: config.manifest.loops['implement']!.implementPattern ?? ''
      }
    );
    // The fix: the state scanner MUST NOT count a closeout_failed run as
    // a completed implementation. Without the harness's front matter
    // carrying `priorAudit: docs/dev/plan-audit-v1-fake.md`, the scan
    // reads `priorAudit: 'none'` and `currentPlanImplemented` is false.
    // This is the contract that stops `smash.ts` from defaulting the
    // next interactive start to `review` — proving the v5-audit C1
    // single-workflow-boundary fix end-to-end.
    expect(facts.approvedPlanAuditPath).toContain('plan-audit-v1-fake.md');
    expect(facts.currentPlanImplemented).toBe(false);

    // Direct assertion on the `smash.ts` default-loop logic. Calling
    // `smashAction` in interactive mode (no `--loop`) reads the same
    // `resolveImplementFacts()` result; the default loop should be
    // `implement` (continue the work), not `review` (skip ahead as if
    // it were done). The `vi.mock` for `promptLoopSelect` records the
    // default the harness computed (`lastPromptedDefault`) and returns
    // it; `runLoop` is then called with that loop name.
    mockedRunLoop.mockClear();
    lastPromptedDefault = undefined;
    await smashAction({
      project: tempDir,
      // no `loop` → interactive mode → reads `resolveImplementFacts`
      // and defaults to `implement` (NOT `review`) when
      // `currentPlanImplemented` is false but `approvedPlanAuditPath`
      // is non-null.
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    // The default the harness computed (and the loop name it called
    // runLoop with) on a `closeout_failed` post-state is `implement`,
    // not `review`. If the v5-audit C1 fix is missing, this assertion
    // fails (the default would silently advance to `review`).
    expect(lastPromptedDefault).toBe('implement');
    expect(mockedRunLoop).toHaveBeenCalled();
    const calledLoopName = mockedRunLoop.mock.calls[0]![1];
    expect(calledLoopName).toBe('implement');
  });

  it('v9-audit Critical: interactive startup does NOT default to review after a blocked closeout run', async () => {
    // The on-disk post-state of a blocked run: the plan front matter
    // has been updated to `status: blocked` by `writePlanCloseout`,
    // and the impl ledger file exists BUT without the harness's front
    // matter (writeArtifactWithMeta is NOT called on the blocked
    // branch — see Step 7 v9-audit Critical fix). The state scanner
    // must see `currentPlanImplemented: false` and the default loop
    // must be `implement`, not `review`.
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );
    // Plan with `status: blocked` — the post-blocked-closeout state.
    writeFileSync(
      join(tempDir, 'docs/dev/plan.md'),
      '---\nstatus: blocked\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Plan body\n'
    );
    // Agent's raw ledger — no harness front matter. This simulates the
    // post-blocked-closeout state: the agent produced a complete ledger,
    // closeout updated the plan, but the loop did NOT stamp the harness
    // front matter.
    writeFileSync(
      join(tempDir, 'docs/dev/impl-v1-fake.md'),
      `# Implementation Evidence Ledger\n\n| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n| --- | --- | --- | --- | --- |\n| Step 1 | src/x.ts | pnpm test | pass | none |\n\n| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n| --- | --- | --- | --- |\n| Req A | src/x.ts | tests/x.test.ts | pass |\n\nState overall confidence: 0.94\n`
    );

    const config = loadConfig(tempDir);
    const facts = resolveImplementFacts(
      tempDir,
      {
        auditPattern: config.manifest.loops['plan']!.auditPattern ?? '',
        followUpPattern: config.manifest.loops['plan']!.followUpPattern ?? ''
      },
      {
        implementPattern: config.manifest.loops['implement']!.implementPattern ?? ''
      }
    );
    // Without the harness's front matter, the scanner reads
    // `priorAudit: 'none'` and `currentPlanImplemented` is false.
    expect(facts.approvedPlanAuditPath).toContain('plan-audit-v1-fake.md');
    expect(facts.currentPlanImplemented).toBe(false);

    mockedRunLoop.mockClear();
    lastPromptedDefault = undefined;
    await smashAction({
      project: tempDir,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    // The default on a blocked post-state is `implement` (continue
    // the work), not `review` (skip ahead as if it were done).
    expect(lastPromptedDefault).toBe('implement');
    expect(mockedRunLoop).toHaveBeenCalled();
    const calledLoopName = mockedRunLoop.mock.calls[0]![1];
    expect(calledLoopName).toBe('implement');
  });
});

describe('smashAction setup-time quarantine of interrupted artifacts (§3)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-quarantine');

  beforeEach(() => {
    createTempDir('temp-smash-quarantine');
    mockedRunLoop.mockClear();
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
    mockedLoopSelectChoice = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  it('a partial plan audit + marker is quarantined before state resolution, so smash is NOT blocked by "unparseable"', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    // Garbage partial that would otherwise parse as verdict 'unknown' and block smash.
    writeFileSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'), 'PARTIAL GARBAGE NO VERDICT');
    writeInterruptedMarker(tempDir, {
      loop: 'plan', kind: 'audit', version: 1, agent: 'fake', model: 'fake-model',
      skillId: 'plan-audit', interruptedAtMs: 500
    });

    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    // Not blocked: the partial was quarantined before the decision scan ran.
    expect(res.exitCode).toBe(0);
    expect(lastErrorMessage).not.toMatch(/unparseable/);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
    expect(existsSync(join(tempDir, 'docs/dev/archived'))).toBe(true);
    expect(readdirSync(join(tempDir, 'docs/dev/archived')).length).toBeGreaterThan(0);
    // The marker is consumed by the quarantine.
    expect(existsSync(join(tempDir, '.orc-smash/interrupted.json'))).toBe(false);
  });

  it('a partial review audit + marker is quarantined before state resolution, so smash is NOT blocked by "unparseable"', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(join(tempDir, 'docs/dev/review-v2-fake.md'), 'PARTIAL GARBAGE NO VERDICT');
    writeInterruptedMarker(tempDir, {
      loop: 'review',
      kind: 'audit',
      version: 2,
      agent: 'fake',
      model: 'fake-model',
      skillId: 'review',
      interruptedAtMs: 750
    });

    const res = await smashAction({
      project: tempDir,
      loop: 'review',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    expect(res.exitCode).toBe(0);
    expect(lastErrorMessage).not.toMatch(/unparseable/);
    expect(existsSync(join(tempDir, 'docs/dev/review-v2-fake.md'))).toBe(false);
    expect(existsSync(join(tempDir, 'docs/dev/archived'))).toBe(true);
    expect(existsSync(join(tempDir, '.orc-smash/interrupted.json'))).toBe(false);
  });

  it('a partial implement artifact + marker is quarantined before resolveImplementFacts, so the next default is implement (not review)', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    // Approved plan audit.
    const auditMeta = makeArtifactMeta({ version: 1, agent: 'fake', loop: 'plan', skill: 'plan-audit', kind: 'audit' });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(auditMeta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );
    // Partial implement artifact WITH a front-matter priorAudit link — without
    // quarantine this would make resolveImplementFacts return currentPlanImplemented
    // true and the interactive default would advance to 'review'.
    const implMeta = makeArtifactMeta({ version: 1, agent: 'fake', loop: 'implement', skill: '30-simple-implement', kind: 'implement', priorAudit: 'docs/dev/plan-audit-v1-fake.md' });
    writeFileSync(
      join(tempDir, 'docs/dev/impl-v1-fake.md'),
      buildFrontMatter(implMeta) + `# partial implementation ledger\n`
    );
    writeInterruptedMarker(tempDir, {
      loop: 'implement', kind: 'implement', version: 1, agent: 'fake', model: 'fake-model',
      skillId: '30-simple-implement', interruptedAtMs: 500
    });

    lastPromptedDefault = undefined;
    await smashAction({
      project: tempDir,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    // Quarantine removed the partial impl before the default-loop derivation,
    // so currentPlanImplemented is false and the default is 'implement', not 'review'.
    expect(existsSync(join(tempDir, 'docs/dev/impl-v1-fake.md'))).toBe(false);
    expect(lastPromptedDefault).toBe('implement');
  });

  it('rejects --audit-continuity when agent does not support session resume', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      auditContinuity: true,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    // fake does not support session resume; the policy validation rejects it
    // before provider spawn.
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('requires codex, opencode, or claude, but the resolved agent is');
  });

  it('rejects mutual --audit-continuity + --codex-audit-continuity', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      auditContinuity: true,
      codexAuditContinuity: true,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('mutually exclusive');
  });

  it('rejects --audit-continuity for implement loop', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'implement',
      auditContinuity: true,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('not supported');
  });

  it('passes --runner and --runner-model options through to smash', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      runner: ['plan-audit=fake'],
      runnerModel: ['plan-audit=fake-model'],
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(res.exitCode).toBe(0);
  });

  it('rejects per-skill override without --loop', async () => {
    const res = await smashAction({
      project: tempDir,
      runner: ['plan-audit=fake'],
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--runner');
  });

  it('warns if the audit runner resolves to an unsupported runner', async () => {
    lastWarningMessage = '';
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
    expect(res.exitCode).toBe(0);
    expect(lastWarningMessage).toContain('agent fake does not support session resume');
  });


  it('Rule 2 pre-implementation: interactive smash defaults to implement loop when plan approved but not implemented', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    // Write approved plan
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    mockedRunLoop.mockClear();
    lastPromptedDefault = undefined;

    await smashAction({
      project: tempDir,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    expect(lastPromptedDefault).toBe('implement');
    expect(mockedRunLoop).toHaveBeenCalledWith(
      expect.any(String),
      'implement',
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('Rule 3 mixed-history: interactive smash defaults to the loop with the newest activity when Rule 2 is not active', async () => {
    const customManifest = {
      roles: {
        auditor: 'roles/auditor.md'
      },
      skills: {
        'skill-a': { file: 'skills/a.md', role: 'auditor', kind: 'audit', agent: 'fake', model: 'fake-model' },
        'skill-a-follow': { file: 'skills/af.md', role: 'auditor', kind: 'follow-up', agent: 'fake', model: 'fake-model' },
        'skill-b': { file: 'skills/b.md', role: 'auditor', kind: 'audit', agent: 'fake', model: 'fake-model' },
        'skill-b-follow': { file: 'skills/bf.md', role: 'auditor', kind: 'follow-up', agent: 'fake', model: 'fake-model' }
      },
      loops: {
        loopA: {
          kind: 'doc-audit',
          target: 'a.md',
          targetKind: 'file',
          audit: 'skill-a',
          'follow-up': 'skill-a-follow',
          auditPattern: 'docs/dev/a-audit-v{n}-{agent}.md',
          followUpPattern: 'docs/dev/a-followup-v{n}-{agent}.md',
          inputs: []
        },
        loopB: {
          kind: 'doc-audit',
          target: 'b.md',
          targetKind: 'file',
          audit: 'skill-b',
          'follow-up': 'skill-b-follow',
          auditPattern: 'docs/dev/b-audit-v{n}-{agent}.md',
          followUpPattern: 'docs/dev/b-followup-v{n}-{agent}.md',
          inputs: []
        }
      }
    };

    vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      registry: { providers: { fake: { models: ['fake-model'], defaultModel: 'fake-model' } }, defaultProfile: 'default', profiles: { default: { provider: 'fake' } } },
      manifest: customManifest as any
    });

    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    
    // Write loopA and loopB rejected audits
    const body = '\n# Audit\n\n## Verdict\n\nREJECTED\n';
    writeFileSync(join(tempDir, 'docs/dev/a-audit-v1-fake.md'), buildFrontMatter(makeArtifactMeta({ version: 1, agent: 'fake', kind: 'audit' })) + body);
    writeFileSync(join(tempDir, 'docs/dev/b-audit-v1-fake.md'), buildFrontMatter(makeArtifactMeta({ version: 1, agent: 'fake', kind: 'audit' })) + body);

    // Set file times
    const now = Date.now();
    const fs = await import('node:fs');
    fs.utimesSync(join(tempDir, 'docs/dev/a-audit-v1-fake.md'), new Date(now - 10000), new Date(now - 10000));
    fs.utimesSync(join(tempDir, 'docs/dev/b-audit-v1-fake.md'), new Date(now), new Date(now));

    mockedRunLoop.mockClear();
    lastPromptedDefault = undefined;

    await smashAction({
      project: tempDir,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    expect(lastPromptedDefault).toBe('loopB');
    expect(mockedRunLoop).toHaveBeenCalledWith(
      expect.any(String),
      'loopB',
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('Rule 2 post-implementation: interactive smash defaults to review loop after implementation is complete', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    
    // Write approved plan
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    // Write implementation ledger matching this approved plan
    const implMeta = {
      loop: 'implement',
      skill: '30-simple-implement',
      kind: 'implement' as const,
      role: 'implementer',
      version: 1,
      agent: 'fake',
      model: 'fake-model',
      target: '.',
      priorAudit: 'docs/dev/plan-audit-v1-fake.md',
      timestamp: new Date().toISOString()
    };
    writeFileSync(join(tempDir, 'docs/dev/impl-v1-fake.md'), buildFrontMatter(implMeta) + '# Implemented');

    mockedRunLoop.mockClear();
    lastPromptedDefault = undefined;

    await smashAction({
      project: tempDir,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    expect(lastPromptedDefault).toBe('review');
    expect(mockedRunLoop).toHaveBeenCalledWith(
      expect.any(String),
      'review',
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
