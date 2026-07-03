import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, scanForStatus, scanAllForStatus } from '../state.js';
import { resolveNextStep } from '../next-step.js';
import { assembleNextStepMessage, assembleInterruptedMessage, buildPanelContext } from '../status.js';
import { readInterruptedMarker, setActiveProjectRoot } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import { resolveDefaultLoop } from '../loop-selector.js';

export interface StatusOptions {
  project?: string;
  output: CliOutput;
  all?: boolean;
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

  // §3: register the active project root (read-only command; no subprocess is
  // spawned, so this is defensive — cleared on completion below).
  setActiveProjectRoot(projectRoot);
  try {
    return await renderStatus(projectRoot, config, options);
  } finally {
    setActiveProjectRoot(null);
  }
}

async function renderStatus(projectRoot: string, config: Config, options: StatusOptions): Promise<CommandResult> {
  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    const msg = 'Error: no loops defined in manifest.';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  // --- Loop selection: marker-first precedence, then progression/heuristic.
  const { loopName: detectedLoop, implementFacts } = resolveDefaultLoop(projectRoot, config.manifest);
  const loopSpec = config.manifest.loops[detectedLoop]!;
  const marker = readInterruptedMarker(projectRoot);

  // Display-only timeline: merges the interrupted marker with artifact facts.
  const statusScan = options.all
    ? scanAllForStatus(projectRoot, config.manifest)
    : scanForStatus(projectRoot, detectedLoop, loopSpec, config.manifest);

  let nextStepMessage: string;
  if (statusScan.interruptedStep) {
    const loopOfInterrupt = marker ? marker.loop : detectedLoop;
    nextStepMessage = assembleInterruptedMessage(loopOfInterrupt, statusScan.interruptedStep.version);
  } else {
    if (loopSpec.kind === 'implement') {
      const nextVersion = implementFacts?.nextVersion ?? 1;
      nextStepMessage = assembleNextStepMessage(
        { state: 'implement', nextVersion },
        0,
        loopSpec,
        config.manifest
      );
    } else {
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
      nextStepMessage = assembleNextStepMessage(decision, stateScan.latestVersion, loopSpec, config.manifest);
    }
  }

  const panelCtx = buildPanelContext(
    projectRoot,
    options.all ? 'all' : detectedLoop,
    0,
    5,
    null,
    statusScan.timeline,
    nextStepMessage,
    null,
    statusScan.latestVersion,
    true
  );

  options.output.renderPanel(panelCtx);

  return { exitCode: 0 };
}
