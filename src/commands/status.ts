import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { scan } from '../state.js';
import { renderStatusPanel } from '../status.js';
import { resolveNextStep } from '../next-step.js';

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
    const stateScan = scan(projectRoot, { auditPattern: spec.auditPattern, followUpPattern: spec.followUpPattern });
    if (stateScan.auditSteps.length > maxHistory) {
      maxHistory = stateScan.auditSteps.length;
      detectedLoop = key;
    }
  }

  const loopSpec = config.manifest.loops[detectedLoop]!;
  const stateScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern, followUpPattern: loopSpec.followUpPattern });

  // Single source of truth: next-step messaging derives from resolveNextStep,
  // the same rule the loop and smash command consume.
  const decision = resolveNextStep({
    latestVerdict: stateScan.latestVerdict,
    latestVersion: stateScan.latestVersion,
    hasAudits: stateScan.auditSteps.length > 0,
    latestAuditPath: stateScan.auditSteps[stateScan.auditSteps.length - 1]?.artifactPath ?? null
  });

  let nextStepMessage = 'Ready to smash';
  switch (decision.state) {
    case 'fresh':
      nextStepMessage = `Ready to smash version ${decision.nextAuditVersion} (fresh)`;
      break;
    case 'rejected':
      // Built from nextAuditVersion (not followUpVersion) so the status message
      // cannot drift from the canonical restart rule.
      nextStepMessage = `Proposed next: follow-up then audit version ${decision.nextAuditVersion}`;
      break;
    case 'approved':
      nextStepMessage = `Completed: approved at version ${stateScan.latestVersion}`;
      break;
    case 'unknown-latest-audit':
      nextStepMessage = `Terminal error: latest audit is unparseable`;
      break;
  }

  console.log(
    renderStatusPanel({
      projectRoot,
      loopName: detectedLoop,
      currentIteration: stateScan.latestVersion,
      maxIterations: 5,
      activeSkillRunner: null,
      timeline: stateScan.timeline,
      nextStepMessage
    })
  );
  process.exit(0);
}
