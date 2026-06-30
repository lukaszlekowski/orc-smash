import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statusAction } from '../src/commands/status.js';
import { buildFrontMatter } from '../src/provenance.js';
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
    expect(renderPanelCalledWith.nextStepMessage).toContain('Proposed next: follow-up then audit version 2');
    expect(renderPanelCalledWith.nextStepMessage).not.toMatch(/audit version 1\b/);
  });

  it('approved: message reports the approved version', async () => {
    writeAudit(2, 'APPROVED');
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.nextStepMessage).toContain('Completed: approved at version 2');
  });

  it('fresh: message reports version 1 (nextAuditVersion)', async () => {
    const result = await statusAction({ project: tempDir, output: mockOutput });
    expect(result.exitCode).toBe(0);
    expect(renderPanelCalledWith).not.toBeNull();
    expect(renderPanelCalledWith.nextStepMessage).toContain('Ready to smash version 1 (fresh)');
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
    expect(written).toContain('Iteration: not running');
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
    expect(out).toContain('Iteration: not running');
    expect(out).not.toMatch(/0\/5|0 \/ 5/);
    expect(out).not.toMatch(/Iteration:\s+0\b/);
  });
});
