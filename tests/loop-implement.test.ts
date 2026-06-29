import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
});
