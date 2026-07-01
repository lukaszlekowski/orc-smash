import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, scanForStatus } from '../state.js';
import { resolveNextStep } from '../next-step.js';
import { assembleNextStepMessage, assembleInterruptedMessage, buildPanelContext, latestAuditVersion } from '../status.js';
import { readInterruptedMarker, setActiveProjectRoot } from '../interrupted-artifact.js';
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

  // --- Loop selection: marker-first precedence, then the audit-history heuristic.
  //
  // The marker's `loop` field is authoritative. This is required because the
  // heuristic skips `implement` loops and otherwise picks the non-implement loop
  // with the most audits — so without marker precedence an interrupted
  // `implement` run (with richer plan history on disk) would render as plan/review
  // state instead of the interrupted implement state the marker records.
  const marker = readInterruptedMarker(projectRoot);
  let detectedLoop: string;
  if (marker && config.manifest.loops[marker.loop]) {
    detectedLoop = marker.loop;
  } else {
    detectedLoop = loopKeys[0]!;
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
  }

  const loopSpec = config.manifest.loops[detectedLoop]!;

  // Display-only timeline: merges the interrupted marker with artifact facts.
  // Decision-path `scan()` stays unchanged; this is the only display merger.
  const statusScan = scanForStatus(projectRoot, detectedLoop, loopSpec, config.manifest);

  let nextStepMessage: string;
  if (statusScan.interruptedStep) {
    // Interrupted-aware read-only message. An interrupted state MUST NOT render
    // the audit-only fallback messages from assembleNextStepMessage().
    nextStepMessage = assembleInterruptedMessage(detectedLoop, statusScan.interruptedStep.version);
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
    nextStepMessage = assembleNextStepMessage(decision, stateScan.latestVersion);
  }

  const panelCtx = buildPanelContext(
    projectRoot,
    detectedLoop,
    0,
    5,
    null,
    statusScan.timeline,
    nextStepMessage,
    null,
    latestAuditVersion(statusScan.timeline),
    true
  );

  options.output.renderPanel(panelCtx);

  return { exitCode: 0 };
}
