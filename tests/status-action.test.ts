import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusAction } from '../src/commands/status.js';
import { buildFrontMatter } from '../src/provenance.js';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import * as configModule from '../src/config.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { makeArtifactMeta } from './helpers/provenance.js';
import { createPanelCliOutput } from '../src/cli-output.js';
import { renderStatusPanel } from '../src/status-panel.js';

describe('statusAction command (consumes resolveNextStep)', () => {
  const tempDir = join(process.cwd(), 'temp-status-action');

  let renderPanelCalledWith: any = null;
  let errorCalledWith: any = null;

  const mockOutput = {
    note: () => {},
    warn: () => {},
    error: (msg: string) => { errorCalledWith = msg; },
    iterationStarted: () => {},
    stepStarted: () => {},
    stepSucceeded: () => {},
    stepFailed: () => {},
    renderPanel: (ctx: any) => { renderPanelCalledWith = ctx; },
    finalSummary: () => {}
  };

  beforeEach(() => {
    createTempDir('temp-status-action');
    renderPanelCalledWith = null;
    errorCalledWith = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writeAudit(version: number, verdict: 'APPROVED' | 'REJECTED' | 'MALFORMED', agent = 'fake') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version, agent });
    const body = verdict === 'MALFORMED'
      ? `# Plan Audit\n\n## Verdict\n\nGARBAGE\n`
      : `# Plan Audit\n\n## Verdict\n\n${verdict}\n`;
    writeFileSync(join(tempDir, `docs/dev/plan-audit-v${version}-${agent}.md`), buildFrontMatter(meta) + body);
  }

  it('rejected: message asserts nextAuditVersion (latestVersion + 1), driven by resolveNextStep', async () => {
    writeAudit(1, 'REJECTED');
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.nextStepMessage).toContain('Proposed next: plan-follow-up then plan-audit version 2');
    expect(renderPanelCalledWith.nextStepMessage).not.toMatch(/plan-audit version 1\b/);
  });

  it('approved plan / pre-implementation: status selects implement loop and ready to run implementation version 1', async () => {
    writeAudit(1, 'APPROVED');
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.loopName).toBe('implement');
    expect(renderPanelCalledWith.nextStepMessage).toContain('Ready to run 30-simple-implement version 1');

    // Verify status panel output contains Timeline: header and does not crash
    const output = createPanelCliOutput();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    (process.stdout as any).isTTY = true;
    const res = await statusAction({ project: tempDir, output });
    expect(res.exitCode).toBe(0);
    const written = writeSpy.mock.calls.map(c => c[0] as string).join('');
    expect(written).toContain('Timeline:');
    expect(written).toContain('Ready to run 30-simple-implement version 1');
  });

  it('fresh: message reports version 1 (nextAuditVersion)', async () => {
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.nextStepMessage).toContain('Ready to run plan-audit version 1 (fresh)');
  });

  it('unknown latest audit: terminal message', async () => {
    writeAudit(1, 'MALFORMED');
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.nextStepMessage).toContain('Terminal error: latest audit is unparseable');
  });

  it('proves statusAction receives and uses StatusOptions.output for guard error', async () => {
    vi.spyOn(configModule, 'loadConfig').mockImplementationOnce(() => {
      throw new Error('mocked config error');
    });
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(1);
    expect(errorCalledWith).toContain('failed to load config or manifest: mocked config error');
  });

  // -------------------------------------------------------------------
  // Read-only view disambiguation: v5 audit Major + v9 audit Major #1
  // -------------------------------------------------------------------
  it('read-only view: captured PanelContext has currentIteration=0, latestVersion=2, readOnly=true (disambiguates iteration from artifact version)', async () => {
    writeAudit(1, 'REJECTED');
    writeAudit(2, 'REJECTED');
    await statusAction({ project: tempDir, output: mockOutput });
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.currentIteration).toBe(0);
    expect(renderPanelCalledWith.latestVersion).toBe(2);
    expect(renderPanelCalledWith.readOnly).toBe(true);
    // No live in-flight in the read-only view
    expect(renderPanelCalledWith.inFlight).toBeNull();
  });

  it('read-only view: rendered panel contains "Iteration: not running" and does NOT contain "0/5" or "Iteration: 0" (v9 audit Major #1 closure)', async () => {
    writeAudit(1, 'REJECTED');
    writeAudit(2, 'REJECTED');
    // Use the real createPanelCliOutput so we can capture the actual rendered
    // string via process.stdout.write spy (the mock output drops the panel).
    const output = createPanelCliOutput();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    (process.stdout as any).isTTY = true;

    const result = await statusAction({ project: tempDir, output });
    expect(result.exitCode).toBe(0);

    const written = writeSpy.mock.calls.map(c => c[0] as string).join('');
    expect(written).toContain('Iteration:        ');
    expect(written).toContain('not running');
    expect(written).not.toMatch(/0\/5|0 \/ 5/);
    expect(written).not.toMatch(/Iteration:\s+0\b/);
    // A distinct "Latest version: v2" label proves the artifact version is
    // disambiguated from the iteration counter (v5 audit Major closure).
    expect(written).toMatch(/Latest version:\s+v2/);
  });

  it('read-only view: direct renderer call produces the same non-live label (status.test.ts closure)', () => {
    // Independent of the statusAction wiring — confirms the renderer rule
    // itself: readOnly=true → Iteration: not running; currentIteration=0
    // is the data shape, the renderer is the rule.
    const out = renderStatusPanel({
      projectRoot: tempDir,
      loopName: 'plan',
      currentIteration: 0,
      maxIterations: 5,
      activeSkillRunner: null,
      timeline: [],
      nextStepMessage: '...',
      inFlight: null,
      latestVersion: 0,
      readOnly: true
    });
    expect(out).toContain('Iteration:        ');
    expect(out).toContain('not running');
    expect(out).not.toMatch(/0\/5|0 \/ 5/);
    expect(out).not.toMatch(/Iteration:\s+0\b/);
  });
});

describe('statusAction — interrupted marker precedence + interrupted display (§3)', () => {
  const tempDir = join(process.cwd(), 'temp-status-action-interrupted');

  let renderPanelCalledWith: any = null;
  const mockOutput = {
    note: () => {},
    warn: () => {},
    error: () => {},
    iterationStarted: () => {},
    stepStarted: () => {},
    stepSucceeded: () => {},
    stepFailed: () => {},
    renderPanel: (ctx: any) => { renderPanelCalledWith = ctx; },
    finalSummary: () => {}
  };

  beforeEach(() => {
    createTempDir('temp-status-action-interrupted');
    renderPanelCalledWith = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writeMarker(loop: string, kind: any, version: number, agent = 'codex') {
    writeInterruptedMarker(tempDir, {
      loop, kind, version, agent, model: 'gpt-5.4', skillId: `${loop}-audit`, interruptedAtMs: 999
    });
  }

  function writeAudit(version: number, verdict: 'APPROVED' | 'REJECTED', agent = 'fake') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version, agent });
    const body = `# Plan Audit\n\n## Verdict\n\n${verdict}\n`;
    writeFileSync(join(tempDir, `docs/dev/plan-audit-v${version}-${agent}.md`), buildFrontMatter(meta) + body);
  }

  it('selects the marker loop first: an interrupted plan marker renders as plan interrupted', async () => {
    writeMarker('plan', 'audit', 3);
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith.loopName).toBe('plan');
    // Interrupted-aware message (NOT the audit-only fallback).
    expect(renderPanelCalledWith.nextStepMessage).toMatch(/Planning v3 was interrupted/);
    expect(renderPanelCalledWith.nextStepMessage).not.toMatch(/Ready to run|Completed: approved/);
    // The synthesized interrupted step is in the display timeline.
    expect(renderPanelCalledWith.timeline.some((s: any) => s.status === 'interrupted')).toBe(true);
  });

  it('an interrupted review marker renders as review interrupted', async () => {
    writeMarker('review', 'audit', 2, 'claude');
    await statusAction({ project: tempDir, output: mockOutput });
    expect(renderPanelCalledWith.loopName).toBe('review');
    expect(renderPanelCalledWith.nextStepMessage).toMatch(/Review v2 was interrupted/);
    expect(renderPanelCalledWith.nextStepMessage).not.toMatch(/Ready to run|Completed: approved/);
  });

  it('regression: an interrupted implement marker beats richer plan history (marker-first precedence)', async () => {
    // Rich plan history on disk — the max-history heuristic would normally pick 'plan'.
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeAudit(1, 'REJECTED');
    writeAudit(2, 'REJECTED');
    writeAudit(3, 'APPROVED');
    // But the marker says an implement run was interrupted.
    writeInterruptedMarker(tempDir, {
      loop: 'implement', kind: 'implement', version: 1, agent: 'agy',
      model: 'Gemini 3.5 Flash (Medium)', skillId: '30-simple-implement', interruptedAtMs: 999
    });

    await statusAction({ project: tempDir, output: mockOutput });

    // Marker wins: the loop selected is 'implement', NOT 'plan' (the heuristic
    // would otherwise skip implement and pick the loop with the most audits).
    expect(renderPanelCalledWith.loopName).toBe('implement');
    expect(renderPanelCalledWith.nextStepMessage).toMatch(/Implementation v1 was interrupted/);
    expect(renderPanelCalledWith.nextStepMessage).toMatch(/resumes implementation rather than advancing to review/);
    expect(renderPanelCalledWith.nextStepMessage).not.toMatch(/Ready to run|Completed: approved/);
  });

  it('Rule 2 plan loop progression is selected when no marker is present', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeAudit(1, 'REJECTED');
    await statusAction({ project: tempDir, output: mockOutput });
    expect(renderPanelCalledWith.loopName).toBe('plan');
    expect(renderPanelCalledWith.timeline.every((s: any) => s.status !== 'interrupted')).toBe(true);
  });

  it('mixed-history: Rule 3 activity heuristic selects the loop with newest activity when Rule 2 is not active', async () => {
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
    // Write loopA audit with older time
    const body = '\n# Audit\n\n## Verdict\n\nREJECTED\n';
    writeFileSync(join(tempDir, 'docs/dev/a-audit-v1-fake.md'), buildFrontMatter(makeArtifactMeta({ version: 1, agent: 'fake', kind: 'audit' })) + body);
    // Write loopB audit with newer time
    writeFileSync(join(tempDir, 'docs/dev/b-audit-v1-fake.md'), buildFrontMatter(makeArtifactMeta({ version: 1, agent: 'fake', kind: 'audit' })) + body);

    // Set file times
    const now = Date.now();
    const fs = await import('node:fs');
    fs.utimesSync(join(tempDir, 'docs/dev/a-audit-v1-fake.md'), new Date(now - 10000), new Date(now - 10000));
    fs.utimesSync(join(tempDir, 'docs/dev/b-audit-v1-fake.md'), new Date(now), new Date(now));

    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith.loopName).toBe('loopB');
    expect(renderPanelCalledWith.nextStepMessage).toContain('Proposed next: skill-b-follow then skill-b version 2');
  });

  it('post-implementation: Rule 2 selects review after implementation is complete', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeAudit(1, 'APPROVED'); // Approved plan audit v1

    // Write implementation ledger matching this approved plan audit
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

    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith.loopName).toBe('review');
    expect(renderPanelCalledWith.nextStepMessage).toContain('Ready to run review version 1');
  });

  it('all option: displays combined timeline chronologically across loops', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    
    // Write plan audit v1 (APPROVED)
    const planMeta = makeArtifactMeta({ version: 1, agent: 'fake', kind: 'audit' });
    writeFileSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'), buildFrontMatter(planMeta) + '## Verdict\n\nAPPROVED');

    // Write implement v1
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

    // Set file times so plan comes before implementation
    const now = Date.now();
    const fs = await import('node:fs');
    fs.utimesSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'), new Date(now - 5000), new Date(now - 5000));
    fs.utimesSync(join(tempDir, 'docs/dev/impl-v1-fake.md'), new Date(now), new Date(now));

    const result = await statusAction({ project: tempDir, output: mockOutput, all: true });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith.loopName).toBe('all');
    
    // Check timeline shows both steps in chronological order
    expect(renderPanelCalledWith.timeline.length).toBe(2);
    expect(renderPanelCalledWith.timeline[0].kind).toBe('audit');
    expect(renderPanelCalledWith.timeline[1].kind).toBe('implement');
  });
});
