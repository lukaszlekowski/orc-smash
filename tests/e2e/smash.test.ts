import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../../src/loop.js';
import { scan } from '../../src/state.js';
import { loadConfig } from '../../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../../src/adapters/fake.js';

let secondOpinionSelectCalls = 0;

vi.mock('../../src/interactive.js', () => {
  return {
    promptSecondOpinionDecision: async () => {
      secondOpinionSelectCalls++;
      if (secondOpinionSelectCalls === 1) {
        return 'run-second-opinion';
      }
      return 'stop';
    },
    promptSecondOpinionRunner: async () => {
      return {
        agent: 'fake',
        model: 'fake-second-model'
      };
    },
    promptLoopSelect: async () => '',
    promptStartPoint: async () => '',
    promptRunners: async () => ({}),
    promptMaxIterations: async () => 5
  };
});

describe('Harness Loop E2E (fake adapter)', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-e2e-workspace');

  beforeEach(() => {
    secondOpinionSelectCalls = 0;
    vi.restoreAllMocks();

    if (existsSync(tempWorkspace)) {
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
    mkdirSync(tempWorkspace, { recursive: true });

    // Reset fake adapter state
    fakeAdapterState.verdicts = [];
    fakeAdapterState.stdout = '';
    fakeAdapterState.exitCode = 0;
    fakeAdapterState.writeVerdictFile = true;
  });

  afterEach(() => {
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  function setupTargetProject(name: string) {
    const root = join(tempWorkspace, name);
    const devDir = join(root, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), `# My Plan\nInitial content.\n`);
    // Write a dummy skills.yaml and roles/ if needed, but we can reuse the global one since runLoop resolves roles/ and skills/ relative to toolRoot
    return { root, devDir };
  }

  it('runs to success on immediate APPROVED verdict', async () => {
    const { root, devDir } = setupTargetProject('project-approved');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['APPROVED'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    expect(result.lastAuditPath).toContain('plan-audit-v1-fake.md');

    // Verify file exists
    const auditFile = join(devDir, 'plan-audit-v1-fake.md');
    expect(existsSync(auditFile)).toBe(true);
    const content = readFileSync(auditFile, 'utf-8');
    expect(content).toContain('## Verdict\n\nAPPROVED');
    // Verify provenance comment is stamped
    expect(content).toContain('<!-- orc-smash-provenance agent="fake" model="fake-model" version="1" -->');
  });

  it('runs follow-up and audits version 2 on initial REJECTED verdict', async () => {
    const { root, devDir } = setupTargetProject('project-rejected');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 5,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    expect(result.lastAuditPath).toContain('plan-audit-v2-fake.md');

    // Check v1 was written
    const v1Path = join(devDir, 'plan-audit-v1-fake.md');
    expect(existsSync(v1Path)).toBe(true);
    expect(readFileSync(v1Path, 'utf-8')).toContain('## Verdict\n\nREJECTED');

    // Check target plan.md was patched by follow-up
    const planContent = readFileSync(join(root, 'docs/dev/plan.md'), 'utf-8');
    expect(planContent).toContain('Patched by follow-up');

    // Check v2 was written
    const v2Path = join(devDir, 'plan-audit-v2-fake.md');
    expect(existsSync(v2Path)).toBe(true);
    expect(readFileSync(v2Path, 'utf-8')).toContain('## Verdict\n\nAPPROVED');
  });

  it('terminates immediately and does not mutate target on unknown verdict', async () => {
    const { root } = setupTargetProject('project-unknown');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['unknown'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');

    // Verify target plan.md was NOT patched
    const planContent = readFileSync(join(root, 'docs/dev/plan.md'), 'utf-8');
    expect(planContent).not.toContain('Patched by follow-up');
  });

  it('stops and reports failure on hitting max-iterations', async () => {
    const { root } = setupTargetProject('project-max');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'REJECTED'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 2,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('REJECTED');
    expect(result.message).toContain('hit max-iterations, awaiting human');
  });

  it('proves dual-project isolation concurrently', async () => {
    const projA = setupTargetProject('project-a');
    const projB = setupTargetProject('project-b');

    const configA = loadConfig(projA.root);
    const configB = loadConfig(projB.root);

    // Running loop on project-a with APPROVED
    fakeAdapterState.verdicts = ['APPROVED'];
    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const resultA = await runLoop(projA.root, 'plan', configA.manifest.loops['plan']!, configA, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    // Running loop on project-b with REJECTED then APPROVED
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];
    const resultB = await runLoop(projB.root, 'plan', configB.manifest.loops['plan']!, configB, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    expect(resultA.success).toBe(true);
    expect(resultA.lastAuditPath).toContain('plan-audit-v1-fake.md');
    expect(existsSync(join(projA.devDir, 'plan-audit-v2-fake.md'))).toBe(false);

    expect(resultB.success).toBe(true);
    expect(resultB.lastAuditPath).toContain('plan-audit-v2-fake.md');
    expect(existsSync(join(projB.devDir, 'plan-audit-v1-fake.md'))).toBe(true);
    expect(existsSync(join(projB.devDir, 'plan-audit-v2-fake.md'))).toBe(true);
  });

  it('exercises APPROVED -> run-second-opinion -> next review version', async () => {
    const { root, devDir } = setupTargetProject('project-second-opinion');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['APPROVED', 'APPROVED'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 5,
      startPoint: 'fresh',
      interactive: true
    });
    expect(result.success).toBe(true);
    expect(result.lastAuditPath).toContain('plan-audit-v2-fake.md');

    // N=1 and N=2 should be approved
    expect(existsSync(join(devDir, 'plan-audit-v1-fake.md'))).toBe(true);
    expect(existsSync(join(devDir, 'plan-audit-v2-fake.md'))).toBe(true);

    const history = scan(root, loopSpec.auditPattern).history;
    expect(history).toHaveLength(2);
    expect(history[0]?.verdict).toBe('APPROVED');
    expect(history[1]?.verdict).toBe('APPROVED');
    expect(history[1]?.model).toBe('fake-second-model'); // overridden runner for second opinion
  });

  it('runs loop where audit and follow-up use different fake runners', async () => {
    const { root, devDir } = setupTargetProject('project-mixed-runners');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-audit-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-follow-up-model' }
    };

    const runSpy = vi.spyOn(fakeAdapter, 'run');

    const loopSpec = config.manifest.loops['plan']!;
    const result = await runLoop(root, 'plan', loopSpec, config, runners, {
      maxIterations: 5,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(3); // 1. audit v1, 2. follow-up, 3. audit v2
    
    // First call (audit v1):
    expect(runSpy.mock.calls[0]![0].model).toBe('fake-audit-model');
    // Second call (follow-up):
    expect(runSpy.mock.calls[1]![0].model).toBe('fake-follow-up-model');
    // Third call (audit v2):
    expect(runSpy.mock.calls[2]![0].model).toBe('fake-audit-model');
  });
});
