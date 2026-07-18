import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = resolve(process.cwd());
const compiledBin = join(repoRoot, 'bin', 'orc.js');

interface CapturedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  merged: string;
}

let fixtureRoot: string;
let providerBin: string;

function runCompiled(
  args: string[],
  options: { env?: Record<string, string | undefined> } = {}
): Promise<CapturedRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [compiledBin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${providerBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const mergedChunks: string[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      mergedChunks.push(text);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      mergedChunks.push(text);
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr, merged: mergedChunks.join('') }));
  });
}

function createProject(name: string, approvedPlan = false): string {
  const projectRoot = join(fixtureRoot, name);
  const devDir = join(projectRoot, 'docs', 'dev');
  mkdirSync(devDir, { recursive: true });
  writeFileSync(join(devDir, 'plan.md'), '---\nstatus: ready\nconfidence: 0.96\nowners: cli-runtime\nscope: e2e\n---\n\n# Test plan\n');
  if (approvedPlan) {
    writeFileSync(join(devDir, 'plan-audit-v1-opencode.md'), '# Plan Audit\n\n## Verdict\n\nAPPROVED\n');
  }
  return projectRoot;
}

function terminalLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => / (?:run\.completed|run\.failed)(?: |$)/.test(line));
}

function expectPlainRun(run: CapturedRun, expectedExitCode: number, terminalType: 'run.completed' | 'run.failed'): void {
  expect(run.code).toBe(expectedExitCode);
  expect(run.stderr).toBe('');
  expect(run.merged).not.toMatch(/[\u001b\u009b]/);
  expect(run.merged).not.toMatch(/(?:── Harness Event Log ──|Current project snapshot:|Success:|Loop terminated:|^Error:)/m);

  const lines = run.merged.split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} (?:INFO|PASS|FAIL|WARN) [a-z][a-z0-9.-]+(?: .*)?$/);
  }

  const terminals = terminalLines(run.merged);
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toContain(` ${terminalType} `);
}

describe('compiled bin plain-mode end-to-end matrix', () => {
  beforeAll(() => {
    const build = spawnSync('pnpm', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (build.status !== 0) {
      throw new Error(`pnpm build failed:\n${build.stdout}\n${build.stderr}`);
    }

    fixtureRoot = mkdtempSync(join(tmpdir(), 'orc-plain-compiled-'));
    providerBin = join(fixtureRoot, 'provider-bin');
    mkdirSync(providerBin, { recursive: true });
    const provider = join(providerBin, 'opencode');
    writeFileSync(provider, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const prompt = process.argv.at(-1) ?? '';
const outputMatch = prompt.match(/Write your output to:\\s*([^\\r\\n]+)/i);
const outputPath = outputMatch?.[1]?.trim();
const mode = process.env.ORC_E2E_PROVIDER_MODE ?? 'approved';

if (mode === 'spawn-error') process.exit(1);

if (outputPath && mode !== 'missing') {
  mkdirSync(dirname(outputPath), { recursive: true });
  if (outputPath.includes('plan-audit')) {
    const version = Number(outputPath.match(/-v(\\d+)-/)?.[1] ?? '1');
    const verdict = mode === 'reject-approve' && version === 1 ? 'REJECTED' : 'APPROVED';
    writeFileSync(outputPath, '# Plan Audit\\n\\n## Verdict\\n\\n' + verdict + '\\n');
  } else if (outputPath.includes('plan-followup')) {
    writeFileSync(outputPath, '# Plan Follow-up\\n\\n## Follow-up Outcome\\n\\npatched\\n');
  } else if (outputPath.includes('impl-v')) {
    writeFileSync(outputPath, '# Implementation Evidence Ledger\\n\\n' +
      '## Implementation Evidence\\n\\n' +
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\\n' +
      '| --- | --- | --- | --- | --- |\\n' +
      '| Step 1 | src/config.ts | pnpm test | pass | none |\\n\\n' +
      '## Requirement Coverage\\n\\n' +
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\\n' +
      '| --- | --- | --- | --- |\\n' +
      '| Config-driven timeouts | src/config.ts | tests/config.test.ts | pass |\\n\\n' +
      'State overall confidence: 0.98\\n');
  }
}

if (mode === 'auth-error') {
  process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'AuthError', message: 'unauthorized' } }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'fixture provider completed' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }) + '\\n');
}
`);
    chmodSync(provider, 0o755);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('covers missing-project, invalid-loop, and invalid max-iterations setup paths', async () => {
    const missingProject = await runCompiled(['smash', '--plain']);
    expectPlainRun(missingProject, 1, 'run.failed');
    expect(missingProject.merged).toContain('error message="Error: project path is required. Use --project <path>"');

    const project = createProject('setup-errors');
    const invalidLoop = await runCompiled(['smash', '--plain', '--project', project, '--loop', 'no-such-loop']);
    expectPlainRun(invalidLoop, 1, 'run.failed');
    expect(invalidLoop.merged).toContain('loop \'no-such-loop\' not found in manifest');

    const invalidIterations = await runCompiled([
      'smash', '--plain', '--project', project, '--loop', 'plan', '--max-iterations', 'not-a-number'
    ]);
    expectPlainRun(invalidIterations, 1, 'run.failed');
    expect(invalidIterations.merged).toContain('error message="Error: max-iterations must be a positive integer."');
  });

  it('rejects invalid runner and continuity options before ownership admission', async () => {
    const project = createProject('validation-errors');
    const invalidRunner = await runCompiled([
      'smash', '--plain', '--project', project, '--loop', 'plan', '--agent', 'not-a-provider'
    ]);
    expectPlainRun(invalidRunner, 1, 'run.failed');
    expect(invalidRunner.merged).toContain('runner.rejected');
    expect(invalidRunner.merged).not.toContain('ownership.opened');

    const conflictingContinuity = await runCompiled([
      'smash', '--plain', '--project', project, '--loop', 'plan', '--audit-continuity', '--codex-audit-continuity'
    ]);
    expectPlainRun(conflictingContinuity, 1, 'run.failed');
    expect(conflictingContinuity.merged).toContain('mutually exclusive');
    expect(conflictingContinuity.merged).not.toContain('ownership.opened');

    const runnerWithoutLoop = await runCompiled([
      'smash', '--plain', '--project', project, '--runner', 'plan-audit=opencode'
    ]);
    expectPlainRun(runnerWithoutLoop, 1, 'run.failed');
    expect(runnerWithoutLoop.merged).toContain('require an explicit --loop');
    expect(runnerWithoutLoop.merged).not.toContain('ownership.opened');
  });

  it('reports ownership admission failure as one flushed terminal event', async () => {
    const project = createProject('ownership-admission');
    const run = await runCompiled(
      ['smash', '--plain', '--project', project, '--loop', 'plan', '--max-iterations', '1'],
      {
        env: {
          ORC_RUN_ID: 'compiled-e2e-missing-control',
          ORC_RUN_TOKEN: 'compiled-e2e-token',
          ORC_RUN_STATE_DIR: join(fixtureRoot, 'ownership-state')
        }
      }
    );
    expectPlainRun(run, 2, 'run.failed');
    expect(run.merged).toContain('Ownership setup failed');
    expect(run.merged).not.toContain('ownership.opened');
  });

  it('covers provider failure, missing artifact, max iterations, and approved completion', async () => {
    const implementPreflightProject = createProject('implement-preflight');
    const implementPreflight = await runCompiled([
      'smash', '--plain', '--project', implementPreflightProject, '--loop', 'implement', '--max-iterations', '1'
    ]);
    expectPlainRun(implementPreflight, 1, 'run.failed');
    expect(implementPreflight.merged).toContain('approved plan audit');
    expect(implementPreflight.merged).not.toContain('provider.started');

    const missingArtifactProject = createProject('missing-artifact');
    const missingArtifact = await runCompiled(
      ['smash', '--plain', '--project', missingArtifactProject, '--loop', 'plan', '--max-iterations', '1'],
      { env: { ORC_E2E_PROVIDER_MODE: 'missing' } }
    );
    expectPlainRun(missingArtifact, 1, 'run.failed');
    expect(missingArtifact.merged).toContain('artifact.missing');

    const providerFailureProject = createProject('provider-failure');
    const providerFailure = await runCompiled(
      ['smash', '--plain', '--project', providerFailureProject, '--loop', 'plan', '--max-iterations', '1'],
      { env: { ORC_E2E_PROVIDER_MODE: 'spawn-error' } }
    );
    expectPlainRun(providerFailure, 1, 'run.failed');
    expect(providerFailure.merged).toContain('provider.failed');

    const authProject = createProject('auth-failure');
    const authFailure = await runCompiled(
      ['smash', '--plain', '--project', authProject, '--loop', 'plan', '--max-iterations', '1'],
      { env: { ORC_E2E_PROVIDER_MODE: 'auth-error' } }
    );
    expectPlainRun(authFailure, 1, 'run.failed');
    expect(authFailure.merged).toContain('provider.failed agent=opencode errorKind=auth');
    expect(existsSync(join(authProject, 'docs', 'dev', 'plan-audit-v1-opencode.md'))).toBe(false);

    const maxProject = createProject('max-iterations');
    const maxed = await runCompiled(
      ['smash', '--plain', '--project', maxProject, '--loop', 'plan', '--max-iterations', '1'],
      { env: { ORC_E2E_PROVIDER_MODE: 'reject-approve' } }
    );
    expectPlainRun(maxed, 0, 'run.failed');
    expect(maxed.merged).toContain('verdict.parsed verdict=REJECTED');

    const approvedProject = createProject('approved');
    const approved = await runCompiled([
      'smash', '--plain', '--project', approvedProject, '--loop', 'plan', '--max-iterations', '1'
    ]);
    expectPlainRun(approved, 0, 'run.completed');
    expect(approved.merged).toContain('artifact.verified');
    expect(approved.merged).toContain('verdict.parsed verdict=APPROVED');
  });

  it('covers rejected→follow-up→approved and implementation closeout on the compiled bin', async () => {
    const reviewProject = createProject('rejected-followup-approved');
    const reviewRun = await runCompiled([
      'smash', '--plain', '--project', reviewProject, '--loop', 'plan', '--max-iterations', '3'
    ], { env: { ORC_E2E_PROVIDER_MODE: 'reject-approve' } });
    expectPlainRun(reviewRun, 0, 'run.completed');
    expect(reviewRun.merged.match(/verdict\.parsed/g)).toHaveLength(2);
    expect(reviewRun.merged).toContain('follow-up.outcome outcome=patched');
    expect(reviewRun.merged).toContain('step.started kind=follow-up');

    const implementationProject = createProject('implementation-closeout', true);
    const implementationRun = await runCompiled([
      'smash', '--plain', '--project', implementationProject, '--loop', 'implement', '--max-iterations', '1'
    ]);
    expectPlainRun(implementationRun, 0, 'run.completed');
    expect(implementationRun.merged).toContain('implementation.ledger-validated isComplete=true');
    expect(implementationRun.merged).toContain('plan.closeout status=done');
    expect(readFileSync(join(implementationProject, 'docs', 'dev', 'plan.md'), 'utf8')).toContain('status: done');
  });
});
