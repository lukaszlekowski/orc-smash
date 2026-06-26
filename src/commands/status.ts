import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { scan } from '../state.js';
import { renderStatusPanel } from '../status.js';

export interface StatusOptions {
  project?: string;
}

export async function statusAction(options: StatusOptions): Promise<void> {
  if (!options.project) {
    console.error(chalk.red('Error: project path is required. Use --project <path>'));
    process.exit(1);
  }

  const projectRoot = resolve(options.project);
  let config: any;
  try {
    config = loadConfig(projectRoot);
  } catch (err: any) {
    console.error(chalk.red(`Error: failed to load config or manifest: ${err.message}`));
    process.exit(1);
  }

  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    console.error(chalk.red('Error: no loops defined in manifest.'));
    process.exit(1);
  }

  // Detect loop based on history length
  let detectedLoop = loopKeys[0]!;
  let maxHistory = -1;
  for (const key of loopKeys) {
    const spec = config.manifest.loops[key]!;
    const stateScan = scan(projectRoot, spec.auditPattern);
    if (stateScan.history.length > maxHistory) {
      maxHistory = stateScan.history.length;
      detectedLoop = key;
    }
  }

  const loopSpec = config.manifest.loops[detectedLoop]!;
  const stateScan = scan(projectRoot, loopSpec.auditPattern);

  let nextStepMessage = 'Ready to smash';
  if (stateScan.latestVerdict === 'REJECTED') {
    nextStepMessage = `Proposed next: follow-up then audit version ${stateScan.latestVersion + 1}`;
  } else if (stateScan.latestVerdict === 'APPROVED') {
    nextStepMessage = `Completed: approved at version ${stateScan.latestVersion}`;
  } else if (stateScan.latestVerdict === 'unknown' && stateScan.history.length > 0) {
    nextStepMessage = `Terminal error: latest audit is unparseable`;
  } else if (stateScan.history.length === 0) {
    nextStepMessage = 'Ready to smash version 1 (fresh)';
  }

  console.log(
    renderStatusPanel({
      projectRoot,
      loopName: detectedLoop,
      currentIteration: stateScan.latestVersion,
      maxIterations: 5,
      activeSkillRunner: null,
      history: stateScan.history,
      nextStepMessage
    })
  );
  process.exit(0);
}
