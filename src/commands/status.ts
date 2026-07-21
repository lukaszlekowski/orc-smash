import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scanAllForStatus } from '../state.js';
import { resolveNextStep } from '../next-step.js';
import { assembleNextStepMessage, assembleInterruptedMessage, buildPanelContext } from '../status.js';
import { setActiveProjectRoot } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import { resolveDefaultLoop } from '../loop-selector.js';

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

async function renderStatus(projectRoot: string, config: Config, options: StatusOptions): Promise<CommandResult> {
  const loopKeys = Object.keys(config.manifest.loops);
  const taskKeys = Object.keys(config.manifest.tasks ?? {});
  if (loopKeys.length === 0 && taskKeys.length === 0) {
    const msg = 'Error: no loops or tasks defined in manifest.';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  const { loopName: detectedLoop } = loopKeys.length > 0
    ? resolveDefaultLoop(projectRoot, config.manifest)
    : { loopName: '' };
  const loopSpec = config.manifest.loops[detectedLoop];

  const globalStatusScan = scanAllForStatus(projectRoot, config.manifest);
  const statusScan = globalStatusScan;

  let nextStepMessage: string;
  if (statusScan.interruptedStep) {
    nextStepMessage = assembleInterruptedMessage(detectedLoop, statusScan.interruptedStep.version);
  } else {
    if (loopSpec && loopSpec.type === 'approval-loop') {
      const loopSteps = statusScan.timeline.filter(step => step.bindingId === detectedLoop);
      const evaluations = loopSteps.filter(step => step.kind === 'evaluate');
      const latest = evaluations.at(-1);
      const decision = resolveNextStep({
        latestDecision: latest?.decision ?? (latest?.unclassified ? 'unknown' : null),
        latestVersion: latest?.version ?? 0,
        hasEvaluations: evaluations.length > 0,
        latestArtifactPath: latest?.artifactPath ?? null,
      });
      nextStepMessage = assembleNextStepMessage(decision, latest?.version ?? 0, loopSpec, config.manifest);
    } else {
      nextStepMessage = detectedLoop
        ? 'No active approval loop detected.'
        : 'No approval loop selected; task artifacts are shown in the global snapshot.';
    }
  }

  const panelCtx = buildPanelContext(
    projectRoot,
    options.all ? 'all' : (options.loop ?? detectedLoop ?? 'all'),
    0,
    5,
    null,
    statusScan.timeline,
    nextStepMessage,
    null,
    statusScan.latestVersion,
    true,
  );

  options.output.renderPanel(panelCtx);

  return { exitCode: 0 };
}
