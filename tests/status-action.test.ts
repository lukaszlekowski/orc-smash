import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statusAction } from '../src/commands/status.js';
import { buildFrontMatter } from '../src/provenance.js';
import * as configModule from '../src/config.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { makeArtifactMeta } from './helpers/provenance.js';

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
});
