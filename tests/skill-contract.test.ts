import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../src/adapters/fake.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../src/adapters/testing.js';
import { createMockOutput } from './helpers/mock-output.js';
import { mintRunContext } from '../src/pipeline-state.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

const repoRoot = resolve(process.cwd());

function readSkill(skill: string): string {
  return readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8');
}

describe('Batch 8 packaged skill contracts', () => {
  describe('planning authoring skills (20/23/24) require the two-document contract', () => {
    const plan20 = readSkill('20-simple-plan');
    const createPlan = readSkill('23-simple-create-plan');
    const createSpec = readSkill('24-simple-create-spec');

    it('require both canonical documents with the authority split', () => {
      for (const content of [plan20, createPlan]) {
        expect(content).toContain('docs/dev/spec.md');
        expect(content).toContain('docs/dev/plan.md');
      }
      expect(plan20).toMatch(/Specification \(`docs\/dev\/spec\.md`\)/);
      expect(plan20).toMatch(/Plan \(`docs\/dev\/plan\.md`\)/);
      expect(plan20).toContain('acceptance criteria');
      expect(plan20).toContain('architecture and ownership boundaries');
      expect(plan20).toContain('Spec-to-Plan Coverage table');
      expect(createPlan).toContain('`docs/dev/spec.md` owns the acceptance contract');
      expect(createPlan).toContain('`docs/dev/plan.md` owns delivery');
      expect(createSpec).toContain('`docs/dev/spec.md` for an existing plan-only project');
    });

    it('require confidence of at least 0.95 and non-clobbering behavior', () => {
      expect(plan20).toMatch(/0\.95/);
      expect(plan20).toContain('Never overwrite');
      expect(createPlan).toMatch(/0\.95/);
      expect(createPlan).toContain('must not already exist');
      expect(createSpec).toMatch(/0\.95/);
      expect(createSpec).toContain('plan byte-for-byte');
      expect(createSpec).toContain('never modifies or replaces the plan');
    });

    it('define the orc-planning-set-v1 creation metadata schema', () => {
      for (const content of [plan20, createPlan, createSpec]) {
        expect(content).toContain('orc-planning-set-v1');
        expect(content).toContain('transactionId');
        expect(content).toContain('sourceKind');
        expect(content).toContain('sourceArtifactIdentity');
        expect(content).toContain('sourceDigest');
        expect(content).toContain('document: spec');
        expect(content).toContain('bodyDigest');
        expect(content).toContain('peerBodyDigest');
      }
    });

    it('bind the transaction to the accepted research source (create-plan)', () => {
      expect(createPlan).toContain('accepted-research');
      expect(createPlan).toContain('is the exact artifact identity of the accepted');
      expect(createPlan).toContain('sha256(enc(researchBytes) + enc(evaluationBytes))');
    });

    it('bind the bootstrap spec to the unchanged plan (create-spec)', () => {
      expect(createSpec).toContain('plan-bootstrap');
      expect(createSpec).toContain('sourceArtifactIdentity: none');
      expect(createSpec).toContain('sourceDigest');
      expect(createSpec).toContain('plan-body digest');
    });

    it('define transaction-scoped staging and the zero/one/two-file recovery protocol', () => {
      for (const content of [plan20, createPlan, createSpec]) {
        expect(content).toContain('.spec.md.orc-smash-<transactionId>.tmp');
        expect(content).toMatch(/[Nn]ever rename over an existing destination/);
      }
      expect(plan20).toMatch(/[Zz]ero files/);
      expect(plan20).toMatch(/one protocol-owned canonical file/);
      expect(plan20).toMatch(/two valid protocol-owned canonical files/);
      expect(createPlan).toContain('Never report successful completion with only one canonical document');
      expect(createPlan).toMatch(/more than eight/);
      expect(createSpec).toContain('idempotent');
      expect(createSpec).toContain('ambiguous');
    });

    it('preserve the existing COMPLETED/BLOCKED task-evidence contract', () => {
      expect(createPlan).toContain('## Outcome');
      expect(createPlan).toContain('COMPLETED');
      expect(createPlan).toContain('BLOCKED');
      expect(createSpec).toContain('exactly one `## Outcome`');
      expect(createSpec).toContain('COMPLETED');
      expect(createSpec).toContain('BLOCKED');
      expect(createSpec).toContain('fresh joint approval is mandatory');
    });

    it('keeps create-spec outside pipeline progression and requires a fresh joint audit', () => {
      expect(createSpec).toContain('not a pipeline stage');
      expect(createSpec).toContain('run the plan approval loop');
    });
  });

  describe('plan audit and follow-up skills (21/22)', () => {
    const audit = readSkill('21-simple-plans-audit');
    const followUp = readSkill('22-simple-plans-follow-up');

    it('audit the spec and plan as one set with both documents as inputs', () => {
      expect(audit).toContain('Specification path');
      expect(audit).toContain('Plan path');
      expect(audit).toContain('spec.md');
      expect(audit).toContain('plan.md');
    });

    it('mandate the coverage matrices and the Requirements Not Carried Forward section', () => {
      expect(audit).toContain('Spec-to-Plan Coverage');
      expect(audit).toContain('Research-to-Execution');
      expect(audit).toContain('Requirements Not Carried Forward');
      expect(audit).toContain('None');
      expect(audit).toContain('Testability Check');
      expect(audit).toContain('Real Workflow Verification Matrix');
    });

    it('apply the intentional-architecture-change rule', () => {
      expect(audit).toContain('Intentional Architecture Changes');
      expect(audit).toContain('the current behavior or architecture being replaced');
      expect(audit).toContain('the invariants retained');
      expect(audit).toContain('migration and compatibility effects');
    });

    it('enforce blocking authority, severity threshold, and confidence threshold', () => {
      expect(audit).toContain('Blocking Threshold and Authority');
      expect(audit).toContain('Critical and Major findings block approval');
      expect(audit).toContain('Minor findings are advisory');
      expect(audit).toContain('at least Major');
      expect(audit).toContain('cites its authority');
      expect(audit).toContain('0.95');
    });

    it('require the exact decision and outcome tokens', () => {
      expect(audit).toContain('APPROVED');
      expect(audit).toContain('REJECTED');
      expect(followUp).toContain('## Outcome');
      expect(followUp).toContain('COMPLETED');
      expect(followUp).toContain('BLOCKED');
      expect(followUp).toContain('Do not write a `## Verdict` section');
    });

    it('replace version-based second-opinion behavior with prior-artifact-aware behavior', () => {
      expect(audit).not.toContain('second opinion run is');
      expect(audit).toContain('Prior-Artifact-Aware Behavior');
      expect(audit).toContain('Artifact version does not identify an audit mode');
      expect(audit).toContain('Never perform a historical lookup based on the numeric version alone');
      expect(audit).toContain('independent');
    });

    it('follow-up patches both documents in place and blocks rather than guessing', () => {
      expect(followUp).toContain('Patch both documents in place');
      expect(followUp).toContain('spec/plan authority boundary');
      expect(followUp).toContain('Block rather than guess');
      expect(followUp).toContain('Rejected plans audit path');
      expect(followUp).toContain('Specification path');
      expect(followUp).toContain('Plan path');
    });
  });

  describe('implementation skill (30) first-slice contract', () => {
    const implement = readSkill('30-simple-implement');

    it('requires the spec, plan, and an approved joint plan audit before code changes', () => {
      expect(implement).toContain('docs/dev/spec.md');
      expect(implement).toContain('docs/dev/plan.md');
      expect(implement).toContain('approved joint plan audit');
      expect(implement).toContain('A legacy plan-only approval is not approval of the spec/plan pair');
    });

    it('emits the exact validator-owned ledger table headers and confidence threshold', () => {
      expect(implement).toContain('| Plan Step | Files Changed | Tests / Verification | Result | Deviation         |');
      expect(implement).toContain('| Spec Requirement / Checklist Item | Implemented In | Verified By         | Status |');
      expect(implement).toContain('0.95');
    });

    it('adds the phase-boundary rule for fresh-approval slices', () => {
      expect(implement).toContain('Phase-Boundary Rule');
      expect(implement).toContain('structurally valid blocked implementation ledger');
      expect(implement).toContain('Release run ownership');
      expect(implement).toContain('Never invoke the harness recursively');
    });

    it('constrains operator-only verification', () => {
      expect(implement).toContain('Verification Ownership');
      expect(implement).toContain('Operator-only verification');
      expect(implement).toContain('substitute evidence');
    });
  });
});

describe('plan-audit prior-artifact semantics (Batch 8)', () => {
  const workspace = resolve(process.cwd(), 'temp-plan-audit-prior-test');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-plan-audit-prior-test');
    mkdirSync(join(workspace, 'docs/dev'), { recursive: true });
    writeFileSync(join(workspace, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(workspace, 'docs/dev/spec.md'), '# Spec\n');
    resetFakeAdapterState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(workspace);
  });

  const runners = {
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' },
  };

  function options() {
    return {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
    };
  }

  it('gives an ordinary post-repair v2 the repair artifact and a fresh second opinion none', async () => {
    const config = loadConfig(workspace);
    const capturedPrompts: string[] = [];
    const originalRun = fakeAdapter.run;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(function (input: Parameters<typeof fakeAdapter.run>[0]) {
      capturedPrompts.push(input.prompt);
      return originalRun.call(fakeAdapter, input);
    });

    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];
    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan,
      config,
      runners,
      { ...options(), runContext: mintRunContext({ mode: 'ad-hoc' }) },
    );
    expect(result.success).toBe(true);

    const v2Prompt = capturedPrompts.find(prompt => prompt.includes('Version: 2'))!;
    expect(v2Prompt).toContain(`Prior artifact: ${resolve(workspace, 'docs/dev/plan-followup-v1-fake.md')}`);

    const opinion = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan,
      config,
      runners,
      { ...options(), runContext: mintRunContext({ mode: 'second-opinion' }) },
    );
    expect(opinion.success).toBe(true);
    const opinionPrompt = [...capturedPrompts].reverse().find(prompt => prompt.includes('# Skill: plan-audit'))!;
    expect(opinionPrompt).toContain('Prior artifact: none');
    expect(opinionPrompt).not.toContain('plan-audit-v2-fake.md');
  });
});
