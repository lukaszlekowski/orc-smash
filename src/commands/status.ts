import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scanGlobalSnapshot } from '../artifact-index.js';
import { buildProjectSnapshotView } from '../project-snapshot-view.js';
import { renderDetailedSnapshot } from '../project-snapshot-renderer.js';
import { setActiveProjectRoot } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';

export interface StatusOptions {
  project?: string;
  config?: string;
  output: CliOutput;
  all?: boolean;
  loop?: string;
}

export async function statusAction(options: StatusOptions): Promise<CommandResult> {
  if (!options.project) {
    const msg = 'Error: project path is required. Use --project <path>';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  const projectRoot = resolve(options.project);
  let config: Config;
  try {
    config = loadConfig(projectRoot, options.config);
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  setActiveProjectRoot(projectRoot);
  try {
    return await renderStatus(projectRoot, config, options);
  } finally {
    setActiveProjectRoot(null);
  }
}

/**
 * Render the global status snapshot to the output. Shared between
 * `orc status` and the interactive menu's `Display pipeline and project state`.
 */
export function renderStatusPanel(
  projectRoot: string,
  config: Config,
  output: CliOutput,
  _opts?: { loop?: string; all?: boolean },
): void {
  const snapshot = scanGlobalSnapshot(projectRoot, config.manifest);
  const view = buildProjectSnapshotView(config, snapshot);
  const text = renderDetailedSnapshot(view);
  output.writeStatic(text);
}

async function renderStatus(projectRoot: string, config: Config, options: StatusOptions): Promise<CommandResult> {
  const loopKeys = Object.keys(config.manifest.loops);
  const taskKeys = Object.keys(config.manifest.tasks ?? {});
  if (loopKeys.length === 0 && taskKeys.length === 0) {
    const msg = 'Error: no loops or tasks defined in manifest.';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  renderStatusPanel(projectRoot, config, options.output, { loop: options.loop, all: options.all });
  return { exitCode: 0 };
}
