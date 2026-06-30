import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan } from '../state.js';
import { resolveNextStep } from '../next-step.js';
import { assembleNextStepMessage, buildPanelContext, latestAuditVersion } from '../status.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';

export interface StatusOptions {
  project?: string;
  output: CliOutput;
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
    config = loadConfig(projectRoot);
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    const msg = 'Error: no loops defined in manifest.';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  // Detect loop based on history length
  let detectedLoop = loopKeys[0]!;
  let maxHistory = -1;
  for (const key of loopKeys) {
    const spec = config.manifest.loops[key]!;
    if (spec.kind === 'implement') continue;
    const stateScan = scan(projectRoot, {
      auditPattern: spec.auditPattern ?? '',
      followUpPattern: spec.followUpPattern ?? ''
    });
    if (stateScan.auditSteps.length > maxHistory) {
      maxHistory = stateScan.auditSteps.length;
      detectedLoop = key;
    }
  }

  const loopSpec = config.manifest.loops[detectedLoop]!;
  const stateScan = scan(projectRoot, {
    auditPattern: loopSpec.auditPattern ?? '',
    followUpPattern: loopSpec.followUpPattern ?? ''
  });

  const decision = resolveNextStep({
    latestVerdict: stateScan.latestVerdict,
    latestVersion: stateScan.latestVersion,
    hasAudits: stateScan.auditSteps.length > 0,
    latestAuditPath: stateScan.auditSteps[stateScan.auditSteps.length - 1]?.artifactPath ?? null
  });

  const nextStepMessage = assembleNextStepMessage(decision, stateScan.latestVersion);

  const panelCtx = buildPanelContext(
    projectRoot,
    detectedLoop,
    0,
    5,
    null,
    stateScan.timeline,
    nextStepMessage,
    null,
    latestAuditVersion(stateScan.timeline),
    true
  );

  options.output.renderPanel(panelCtx);

  return { exitCode: 0 };
}
