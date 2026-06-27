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
    fakeAdapterState.auditError = undefined;
    fakeAdapterState.followUpError = undefined;
    fakeAdapterState.stderr = undefined;
  });

  afterEach(() => {
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  function setupTargetProject(name: string) {
    const root = join(tempWorkspace, name);
    const devDir = join(root, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), `# My Plan\nInitial content.\n`);
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
    // Verify front matter is stamped
    expect(content).toContain('kind: audit');
    expect(content).toContain('agent: fake');
    expect(content).toContain('model: fake-model');
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

    // Check follow-up v1 was written to the follow-up path, not audit path
    const followUpPath = join(devDir, 'plan-followup-v1-fake.md');
    expect(existsSync(followUpPath)).toBe(true);
    const followUpContent = readFileSync(followUpPath, 'utf-8');
    expect(followUpContent).toContain('## Follow-up Outcome\n\npatched');
    expect(followUpContent).not.toContain('## Verdict');

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

    const history = scan(root, { auditPattern: loopSpec.auditPattern, followUpPattern: loopSpec.followUpPattern }).auditSteps;
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

  it('verifies verdict queue integrity and path-token-based kind detection', async () => {
    const { root, devDir } = setupTargetProject('project-integrity');
    const config = loadConfig(root);

    // Initial REJECTED then APPROVED
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
    // After the run, both verdicts in the queue should be consumed by audits only
    expect(fakeAdapterState.verdicts).toHaveLength(0);

    // Let's test that if prompt contains "follow-up" but outputPath is audit, it is treated as audit (shifts verdict)
    fakeAdapterState.verdicts = ['APPROVED'];
    const buildResult = await fakeAdapter.run({
      prompt: 'Write your output to: docs/dev/plan-audit-v1-fake.md\nThis prompt mentions follow-up in the prose!',
      model: 'fake-model',
      cwd: root
    });
    // Verdict should be shifted and consumed
    expect(fakeAdapterState.verdicts).toHaveLength(0);
    expect(buildResult.stdout).toContain('Fake run completed with verdict APPROVED');
    const tempAuditFile = join(root, 'docs/dev/plan-audit-v1-fake.md');
    expect(existsSync(tempAuditFile)).toBe(true);
    const content = readFileSync(tempAuditFile, 'utf-8');
    expect(content).toContain('## Verdict\n\nAPPROVED');
  });

  it('fails fast on audit server error (C1)', async () => {
    const { root } = setupTargetProject('project-audit-server-error');
    const config = loadConfig(root);

    fakeAdapterState.auditError = {
      kind: 'server',
      message: 'Unexpected server error. Check server logs for details.',
      ref: 'err_3a9287f2'
    };

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
    expect(result.message).toContain('opencode rejected model');
    expect(result.message).toContain('err_3a9287f2');
  });

  it('fails fast on audit timeout error (C1 + m6)', async () => {
    const { root } = setupTargetProject('project-audit-timeout');
    const config = loadConfig(root);

    fakeAdapterState.auditError = {
      kind: 'timeout',
      message: 'no completion event before deadline',
      raw: { timeoutMs: 5000 }
    };

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
    expect(result.message).toContain('timed out');
    expect(result.message).toContain('5000ms');
  });

  it('fails fast on audit auth error (C1)', async () => {
    const { root } = setupTargetProject('project-audit-auth');
    const config = loadConfig(root);

    fakeAdapterState.auditError = {
      kind: 'auth',
      message: 'unauthorized',
      ref: 'err_x'
    };

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
    expect(result.message).toContain('provider/credential error');
  });

  it('fails on follow-up error and does not write false patched step (C2)', async () => {
    const { root, devDir } = setupTargetProject('project-followup-error');
    const config = loadConfig(root);

    // Initial audit rejects, forcing loop into follow-up
    fakeAdapterState.verdicts = ['REJECTED'];
    fakeAdapterState.followUpError = {
      kind: 'server',
      message: 'Unexpected server error.',
      ref: 'err_y'
    };
    fakeAdapterState.exitCode = 0; // exit 0 but with an error event to test error-event-wins

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
    expect(result.message).toContain('opencode rejected model');
    expect(result.message).toContain('err_y');

    // Verify follow-up file was NOT written (due to early failure)
    const followUpFile = join(devDir, 'plan-followup-v1-fake.md');
    expect(existsSync(followUpFile)).toBe(false);
  });

  it('preserves codex/claude behavior where nonzero exit with valid verdict is accepted (M1 pinning, m7)', async () => {
    const { root, devDir } = setupTargetProject('project-pinning');
    const config = loadConfig(root);

    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.exitCode = 1; // nonzero exit
    // no fakeAdapterState.auditError, simulating non-opencode agent success with nonzero exit

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
    expect(existsSync(join(devDir, 'plan-audit-v1-fake.md'))).toBe(true);
  });
});
