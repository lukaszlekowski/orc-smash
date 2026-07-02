import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/loop.js', () => ({
  runLoop: vi.fn().mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null })
}));

let lastPromptedDefault: string | undefined;
vi.mock('../src/interactive.js', () => ({
  promptLoopSelect: async (_loops: string[], defaultLoop: string) => {
    lastPromptedDefault = defaultLoop;
    return defaultLoop;
  },
  promptStartPoint: async () => 'fresh',
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
import { makeArtifactMeta } from './helpers/provenance.js';
import { resolveImplementFacts } from '../src/state.js';
import { loadConfig } from '../src/config.js';

const mockedRunLoop = vi.mocked(runLoop);

let lastErrorMessage = '';
const mockOutput = {
  note: () => {},
  warn: () => {},
  error: (msg: string) => { lastErrorMessage = msg; },
  iterationStarted: () => {},
  stepStarted: () => {},
  stepSucceeded: () => {},
  stepFailed: () => {},
  renderPanel: () => {},
  finalSummary: () => {}
};

describe('smashAction start-point derivation (consumes canonical rule)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-action');

  beforeEach(() => {
    createTempDir('temp-smash-action');
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  opencode:\n    - opencode-go/deepseek-v4-flash\n  fake:\n    - fake-model\ndefaults:\n  agent: fake\n  model: fake-model\n'
    );
    mockedRunLoop.mockClear();
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
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

  it('REJECTED state => start-point resume (matches allowedStartPoint)', async () => {
    writeAudit(1, 'REJECTED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'resume' });
    expect(res.exitCode).toBe(0);
  });

  it('APPROVED state => start-point new-round', async () => {
    writeAudit(1, 'APPROVED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'new-round' });
    expect(lastErrorMessage).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('fresh state (no audits) => start-point fresh', async () => {
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'fresh' });
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
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: undefined });
    expect(res.exitCode).toBe(0);
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
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  opencode:\n    - opencode-go/deepseek-v4-flash\n  fake:\n    - fake-model\ndefaults:\n  agent: fake\n  model: fake-model\n'
    );
    mockedRunLoop.mockClear();
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
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

  it('rejects if both --audit-continuity and --codex-audit-continuity are supplied', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      auditContinuity: true,
      codexAuditContinuity: true,
      agent: 'codex',
      model: 'gpt-5.5',
      output: mockOutput
    });
    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--audit-continuity and --codex-audit-continuity are mutually exclusive');
  });

  it('rejects --audit-continuity on the implement loop', async () => {
    const auditMeta = makeArtifactMeta({ version: 1, agent: 'fake', loop: 'plan', skill: 'plan-audit', kind: 'audit' });
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(auditMeta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    const res = await smashAction({
      project: tempDir,
      loop: 'implement',
      auditContinuity: true,
      agent: 'codex',
      model: 'gpt-5.5',
      output: mockOutput
    });

    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--audit-continuity is only valid for plan and review loops');
  });

  it('rejects --audit-continuity if the audit runner resolves to an unsupported runner', async () => {
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      auditContinuity: true,
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });

    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--audit-continuity requires the audit runner to be codex, opencode, or claude');
  });

  it('accepts --audit-continuity if the audit runner is Claude or Opencode', async () => {
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  claude:\n    - glm-4.7\n  opencode:\n    - opencode-go/deepseek-v4-flash\ndefaults:\n  agent: claude\n  model: glm-4.7\n'
    );

    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      auditContinuity: true,
      agent: 'claude',
      model: 'glm-4.7',
      output: mockOutput
    });

    expect(res.exitCode).toBe(0);
    expect(mockedRunLoop).toHaveBeenCalledWith(
      expect.any(String),
      'plan',
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        'plan-audit': { agent: 'claude', model: 'glm-4.7' }
      }),
      expect.objectContaining({
        auditContinuity: 'claude-resume'
      })
    );
  });

  it('rejects --codex-audit-continuity on the implement loop', async () => {
    // Approved plan audit to get past the implement loop check.
    const auditMeta = makeArtifactMeta({ version: 1, agent: 'fake', loop: 'plan', skill: 'plan-audit', kind: 'audit' });
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(auditMeta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    const res = await smashAction({
      project: tempDir,
      loop: 'implement',
      codexAuditContinuity: true,
      agent: 'codex',
      model: 'gpt-5.5',
      output: mockOutput
    });

    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--codex-audit-continuity is only valid for plan and review loops');
  });

  it('rejects --codex-audit-continuity if the audit runner resolves to a non-Codex runner', async () => {
    // Plan loop with codexAuditContinuity, but agent is fake/opencode (non-Codex)
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      codexAuditContinuity: true,
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      output: mockOutput
    });

    expect(res.exitCode).toBe(1);
    expect(res.message).toContain('--codex-audit-continuity requires the audit runner to be codex');
  });

  it('accepts --codex-audit-continuity if the audit runner is Codex and follow-up is not Codex', async () => {
    // We override program configurations for this test
    const config = loadConfig(tempDir);
    config.manifest.skills['plan-audit'].agent = 'codex';
    config.manifest.skills['plan-audit'].model = 'gpt-5.5';
    config.manifest.skills['plan-follow-up'].agent = 'opencode';
    config.manifest.skills['plan-follow-up'].model = 'opencode-go/deepseek-v4-flash';

    // Mock resolveSmashRunSetup/loadConfig or just write an environment that uses codex registry
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  codex:\n    - gpt-5.5\n  opencode:\n    - opencode-go/deepseek-v4-flash\ndefaults:\n  agent: codex\n  model: gpt-5.5\n'
    );

    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      codexAuditContinuity: true,
      agent: 'codex',
      model: 'gpt-5.5',
      output: mockOutput
    });

    expect(res.exitCode).toBe(0); // runs mockLoop successfully
    expect(mockedRunLoop).toHaveBeenCalledWith(
      expect.any(String),
      'plan',
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        'plan-audit': { agent: 'codex', model: 'gpt-5.5' }
      }),
      expect.objectContaining({
        auditContinuity: 'codex-resume'
      })
    );
  });
});
