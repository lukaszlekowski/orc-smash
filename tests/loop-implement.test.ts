import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { runLoop } from '../src/loop.js';
import { scan, resolveImplementFacts } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { buildFrontMatter } from '../src/provenance.js';
import { makeArtifactMeta } from './helpers/provenance.js';

const testRegistry = createTestAdapterRegistry();
const mockOutput = {
  note: () => {},
  warn: () => {},
  error: () => {},
  iterationStarted: () => {},
  stepStarted: () => {},
  stepSucceeded: () => {},
  stepFailed: () => {},
  renderPanel: () => {},
  finalSummary: () => {}
};

let mockedSecondOpinionDecision: 'stop' | 'run-second-opinion' | 'implement' = 'stop';
let mockedContinueToReview: 'stop' | 'review' = 'stop';
let promptRunnersCalls = 0;

vi.mock('../src/interactive.js', () => {
  return {
    promptSecondOpinionDecision: async () => mockedSecondOpinionDecision,
    promptSecondOpinionRunner: async () => ({ agent: 'fake', model: 'fake-second-model' }),
    promptContinueToReview: async () => mockedContinueToReview,
    promptLoopSelect: async () => '',
    promptStartPoint: async () => '',
    promptRunners: async (skills: string[]) => {
      promptRunnersCalls++;
      const res: any = {};
      for (const s of skills) {
        res[s] = { agent: 'fake', model: 'fake' };
      }
      return res;
    },
    promptMaxIterations: async () => 5
  };
});

describe('Three-stage pipeline loop/implement integration', () => {
  const tempDir = join(process.cwd(), 'temp-loop-implement');

  beforeEach(() => {
    createTempDir('temp-loop-implement');
    fakeAdapterState.verdicts = [];
    fakeAdapterState.exitCode = 0;
    fakeAdapterState.stdout = '';
    fakeAdapterState.writeVerdictFile = true;
    mockedSecondOpinionDecision = 'stop';
    mockedContinueToReview = 'stop';
    promptRunnersCalls = 0;

    // Write project-local orc.config.yaml with fake provider
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  opencode:\n    - opencode-go/deepseek-v4-flash\n  fake:\n    - fake-model\ndefaults:\n  agent: fake\n  model: fake-model\n'
    );

    // Pre-seed plan.md with ready status for implementation loops
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs/dev/plan.md'),
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n'
    );
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writePlanAudit(version: number, verdict: 'APPROVED' | 'REJECTED') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version, loop: 'plan', skill: 'plan-audit', kind: 'audit' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v${version}-fake.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\n${verdict}\n`
    );
  }

  it('runs implementation step directly when plan is approved', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5,
      registry: testRegistry,
      output: mockOutput,
      interactive: false,
      globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);

    // Verify impl artifact is written
    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(true);

    // Verify provenance priorAudit links to plan-audit-v1
    const content = readFileSync(implFile, 'utf-8');
    expect(content).toContain('priorAudit: docs/dev/plan-audit-v1-fake.md');

    // Verify resolveImplementFacts reads version and linkage correctly
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
    expect(facts.approvedPlanAuditPath).toContain('plan-audit-v1-fake.md');
    expect(facts.nextVersion).toBe(2);
    expect(facts.currentPlanImplemented).toBe(true);
  });

  it('gated: direct implementation throws error if plan is not approved', async () => {
    writePlanAudit(1, 'REJECTED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    await expect(
      runLoop(tempDir, 'implement', implementSpec, config, {}, {
        maxIterations: 5,
        registry: testRegistry,
        output: mockOutput,
        interactive: false,
        globalOverrides: { agent: 'fake', model: 'fake-model' }
      })
    ).rejects.toThrow(/No approved plan audit found/);
  });

  it('post-approval plan loop transition runs implementer inline without mutating plan loop audit state', async () => {
    // We run the plan loop, mock verdict APPROVED, and choose 'implement' at the transition
    fakeAdapterState.verdicts = ['APPROVED'];
    mockedSecondOpinionDecision = 'implement';
    mockedContinueToReview = 'stop';

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;

    const result = await runLoop(tempDir, 'plan', planSpec, config, {
      'plan-audit': { agent: 'fake', model: 'fake' }
    }, {
      maxIterations: 5,
      registry: testRegistry,
      output: mockOutput,
      interactive: true,
      startPoint: 'fresh',
      globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    expect(result.lastAuditPath).toContain('impl-v1-fake.md');

    // Verify implementation artifact is written as a downstream result
    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(true);

    // Verify plan loop audit version didn't increase (only v1-fake.md exists, no v2)
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v2-fake.md'))).toBe(false);
  });

  it('implement -> review transition runs review loop', async () => {
    writePlanAudit(1, 'APPROVED');
    mockedContinueToReview = 'review';
    // Review loop mock verdicts
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5,
      registry: testRegistry,
      output: mockOutput,
      interactive: true,
      globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);

    // Verify review loop produced review-v1 artifact
    const reviewFile = join(tempDir, 'docs/dev/review-v1-fake.md');
    expect(existsSync(reviewFile)).toBe(true);
  });

  it('gated: direct implementation fails if implementation skill did not write a ledger body', async () => {
    writePlanAudit(1, 'APPROVED');
    fakeAdapterState.writeVerdictFile = false;

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5,
      registry: testRegistry,
      output: mockOutput,
      interactive: false,
      globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');

    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(false);
  });

  it('does not re-prompt implement runner if one is already preselected', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {
      '30-simple-implement': { agent: 'fake', model: 'fake-custom-preselected' }
    }, {
      maxIterations: 5,
      registry: testRegistry,
      output: mockOutput,
      interactive: true,
      globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(0); // bypassed prompt for preselected
  });

  it('gated: implementation fails when ledger has only the evidence table (no coverage, no confidence)', async () => {
    writePlanAudit(1, 'APPROVED');
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        // Evidence table only — partial implementation.
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | none |\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });
    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toMatch(/requirement coverage/i);
  });

  it('gated: implementation fails when ledger has both tables but no confidence declaration', async () => {
    writePlanAudit(1, 'APPROVED');
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
          '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
          '| --- | --- | --- | --- |\n' +
          '| Req A | src/x.ts | tests/x.test.ts | pass |\n');
        // Note: no confidence line at all.
      }
      return { stdout: 'done', exitCode: 0 };
    });
    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toMatch(/confidence/i);
  });

  it('gated: implementation accepts the skill\'s literal "State overall confidence" wording — v2-audit C1 fix', async () => {
    writePlanAudit(1, 'APPROVED');
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
          '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
          '| --- | --- | --- | --- |\n' +
          '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
          'State overall confidence: 1.00\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });
    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });
    expect(result.success).toBe(true);
    expect(result.verdict).toBe('unknown');
  });

  it('gated: post-implementation success updates plan.md front matter to done (closeout verification — v2-audit C1)', async () => {
    // Use a real (non-fake) plan to ensure the closeout write is observable.
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    // Spy on the plan front matter writer to observe the closeout update.
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath, '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/^status:\s*done\s*$/m);
  });

  it('gated: post-implementation success appends a change-log entry to plan.md when ## Change Log already exists (closeout verification — v2-audit C1)', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    // Write a plan that already has a Change Log section, awaiting a new entry from this run.
    // The pre-batch entry is preserved so the test can assert it is NOT clobbered.
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath,
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n' +
      '# Existing plan body\n\n' +
      '## Change Log\n\n' +
      '### Pre-batch baseline\n- Plan drafted; no implementations yet.\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/## Change Log\b/);
    expect(updatedPlan).toMatch(/Pre-batch baseline/);
    expect(updatedPlan).toMatch(/Pre-batch baseline[\s\S]+### Implementation v1-fake/);
  });

  it('gated: post-implementation success creates ## Change Log section + appends entry on the real plan shape (no pre-existing Change Log — v3-audit C1)', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    // The real `docs/dev/plan.md` shape at the time of this plan:
    // front matter, then a body, with NO `## Change Log` section.
    // Verified by: `grep -c '^## Change Log' docs/dev/plan.md` → 0.
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath,
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n' +
      '# Plan — Batch 1: Runner and Provider Hardening\n\n' +
      '## Architecture decisions (read before any step)\n\n' +
      '### Decision A — Item 22\n\n' +
      '## Step list\n\n' +
      '### Step 1 — Item 25: codify codex non-interactive autonomy flag\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/^## Change Log\s*$/m);
    expect(updatedPlan).toMatch(/## Change Log\s*\n\n### Implementation v1-fake/);
    expect(updatedPlan).toMatch(/^status:\s*done\s*$/m);
    expect(updatedPlan).toContain('Decision A — Item 22');
    expect(updatedPlan).toContain('Step 1 — Item 25: codify codex non-interactive autonomy flag');
  });

  it('gated: low-confidence ledger blocks implementation advancement — status: blocked, no harness stamp (v9-audit Critical fix)', async () => {
    writePlanAudit(1, 'APPROVED');

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
          '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
          '| --- | --- | --- | --- |\n' +
          '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
          'State overall confidence: 0.94\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath, '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/^status:\s*blocked\s*$/m);
    expect(updatedPlan).toMatch(/### Implementation v1-fake[\s\S]+- status: blocked \(confidence 0\.94 below threshold 0\.95\)/);
    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(true);
    const implContent = readFileSync(implFile, 'utf-8');
    expect(implContent.startsWith('---\nloop:')).toBe(false);
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
    expect(facts.currentPlanImplemented).toBe(false);
  });

  it('gated: high-confidence ledger with a deviation row produces status: done + records the deviation in the change log (v5-audit M1 fix)', async () => {
    writePlanAudit(1, 'APPROVED');

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | skip |\n\n' +
          '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
          '| --- | --- | --- | --- |\n' +
          '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
          'State overall confidence: 0.95\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath, '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/^status:\s*done\s*$/m);
    expect(updatedPlan).toMatch(/- status: done\n/);
    expect(updatedPlan).toMatch(/- deviations: skip\n/);
    expect(updatedPlan).not.toMatch(/- status: done \(deviation/);
    expect(updatedPlan).not.toMatch(/- status: blocked/);
  });

  it('gated: implementation fails when ledger evidence Result is skipped, not run, or untested', async () => {
    writePlanAudit(1, 'APPROVED');
    for (const status of ['skipped', 'not run', 'untested']) {
      vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
        const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
        const rel = relMatch?.[1]?.trim() ?? '';
        if (/impl-v\d+-/.test(rel) && rel) {
          const abs = resolve(input.cwd, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs,
            '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
            '| --- | --- | --- | --- | --- |\n' +
            `| Step 1 | src/x.ts | pnpm test | ${status} | none |\n\n` +
            '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
            '| --- | --- | --- | --- |\n' +
            '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
            'State overall confidence: 0.95\n');
        }
        return { stdout: 'done', exitCode: 0 };
      });
      const config = loadConfig(tempDir);
      const implementSpec = config.manifest.loops['implement']!;
      const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
        maxIterations: 5, registry: testRegistry, output: mockOutput,
        interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
      });
      expect(result.success).toBe(false);
    }
  });

  it('gated: confidence exactly at the threshold (0.95) with no deviation rows produces status: done (v4-audit C1 threshold boundary)', async () => {
    writePlanAudit(1, 'APPROVED');

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const relMatch = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const rel = relMatch?.[1]?.trim() ?? '';
      if (/impl-v\d+-/.test(rel) && rel) {
        const abs = resolve(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
          '| --- | --- | --- | --- | --- |\n' +
          '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
          '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
          '| --- | --- | --- | --- |\n' +
          '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
          'State overall confidence: 0.95\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath, '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const updatedPlan = readFileSync(planPath, 'utf-8');
    expect(updatedPlan).toMatch(/^status:\s*done\s*$/m);
    expect(updatedPlan).not.toMatch(/- status: blocked/);
  });

  it('gated: post-implementation fails with closeout_failed when plan.md is missing', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const planPath = join(tempDir, 'docs/dev/plan.md');
    if (existsSync(planPath)) {
      // remove if exists
      rmSync(planPath, { force: true });
    }

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toMatch(/plan file not found|closeout/i);

    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(true);
    const implContent = readFileSync(implFile, 'utf-8');
    expect(implContent.startsWith('---\nloop:')).toBe(false);
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
    expect(facts.currentPlanImplemented).toBe(false);
  });

  it('gated: post-implementation success DOES stamp the ledger and advance the state scanner (v5-audit C1 positive control)', async () => {
    writePlanAudit(1, 'APPROVED');

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const planPath = join(tempDir, 'docs/dev/plan.md');
    writeFileSync(planPath, '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Existing plan body\n');

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 5, registry: testRegistry, output: mockOutput,
      interactive: false, globalOverrides: { agent: 'fake', model: 'fake-model' }
    });

    expect(result.success).toBe(true);
    const implFile = join(tempDir, 'docs/dev/impl-v1-fake.md');
    expect(existsSync(implFile)).toBe(true);
    const implContent = readFileSync(implFile, 'utf-8');
    expect(implContent.startsWith('---\nloop:')).toBe(true);
    expect(implContent).toContain('priorAudit: docs/dev/plan-audit-v1-fake.md');
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
    expect(facts.currentPlanImplemented).toBe(true);
  });
});
