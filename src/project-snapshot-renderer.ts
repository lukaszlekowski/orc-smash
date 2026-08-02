import type { ProjectSnapshotView } from './project-snapshot-view.js';
import {
  resultAccent,
  toResultState,
  availabilityAccent,
  emphasisAccent,
  unclassifiedAccent,
  staleAccent,
} from './terminal-accent.js';

const terminalEmphasis = (state: Parameters<typeof emphasisAccent>[0]) => emphasisAccent(state, 'terminal-accent');
const terminalAvailability = (state: Parameters<typeof availabilityAccent>[0]) => availabilityAccent(state, 'terminal-accent');
const terminalResult = (state: Parameters<typeof resultAccent>[0]) => resultAccent(state, 'terminal-accent');
const terminalUnclassified = (count: number) => unclassifiedAccent(count, 'terminal-accent');
const terminalStale = (isStale: boolean) => staleAccent(isStale, 'terminal-accent');

/** Render the compact startup project snapshot for the interactive header. */
export function renderCompactSnapshot(view: ProjectSnapshotView): string {
  const pipelinesStr = view.pipelines.length > 0
    ? view.pipelines.join(', ')
    : terminalEmphasis('placeholder')('(none configured)');

  const lines: string[] = [
    `Project:   ${terminalEmphasis('identity')(view.projectRoot)}`,
    `Config:    ${terminalEmphasis('supporting')(view.configPath)}`,
    `Pipelines: ${pipelinesStr}`,
    `Suggested loop: ${view.suggestedLoop ? terminalEmphasis('binding-identity')(view.suggestedLoop) : terminalEmphasis('placeholder')('(none)')}`,
    `Reason:    ${terminalEmphasis('supporting')(view.suggestedLoopReason)}`,
    '',
    'Bindings:',
  ];

  for (const b of view.bindings) {
    const targetInfo = b.targetPath ? ` (target: ${b.targetPath})` : '';
    lines.push(`  [${b.bindingKind}] ${terminalEmphasis('binding-identity')(b.bindingId)}${targetInfo}`);

    if (b.bindingKind === 'loop') {
      if (b.latestEvaluate) {
        const s = b.latestEvaluate.step;
        const rawDec = s.decision ?? s.verdict ?? 'valid';
        const dec = terminalResult(toResultState(rawDec))(rawDec);
        const filename = s.artifactPath.split('/').pop();
        const meta = terminalEmphasis('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestEvaluate.effortStr}, session: ${b.latestEvaluate.sessionStr}]`);
        lines.push(`    evaluate: ${filename} (${dec}) ${meta}`);
      } else {
        lines.push(`    evaluate: ${terminalEmphasis('placeholder')('(none)')}`);
      }
      if (b.latestRepair) {
        const s = b.latestRepair.step;
        const rawOut = s.completionOutcome ?? s.outcome ?? 'valid';
        const out = terminalResult(toResultState(rawOut))(rawOut);
        const filename = s.artifactPath.split('/').pop();
        const meta = terminalEmphasis('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestRepair.effortStr}, session: ${b.latestRepair.sessionStr}]`);
        lines.push(`    repair: ${filename} (${out}) ${meta}`);
      } else {
        lines.push(`    repair: ${terminalEmphasis('placeholder')('(none)')}`);
      }
    } else {
      if (b.latestTask) {
        const s = b.latestTask.step;
        const rawDec = s.completionOutcome ?? s.outcome ?? 'valid';
        const dec = terminalResult(toResultState(rawDec))(rawDec);
        const filename = s.artifactPath.split('/').pop();
        const meta = terminalEmphasis('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestTask.effortStr}, session: ${b.latestTask.sessionStr}]`);
        lines.push(`    task: ${filename} (${dec}) ${meta}`);
      } else {
        lines.push(`    task: ${terminalEmphasis('placeholder')('(none)')}`);
      }
    }

    if (b.missingInputs.length > 0) {
      lines.push(`    ${terminalAvailability('missing-inputs')(`Missing inputs: ${b.missingInputs.join(', ')}`)}`);
    }

    const unclassStr = terminalUnclassified(b.unclassifiedCount)(`unclassified count: ${b.unclassifiedCount}`);
    lines.push(`    ${unclassStr}`);
  }

  return lines.join('\n');
}

/** Render the detailed project status report (used by `orc status` and prompt-contract inspection). */
export function renderDetailedSnapshot(view: ProjectSnapshotView, opts?: { showFingerprints?: boolean }): string {
  const lines: string[] = [];

  lines.push('================================================================================');
  lines.push('                                Project Snapshot                                ');
  lines.push('================================================================================');
  lines.push(`Project Root: ${terminalEmphasis('identity')(view.projectRoot)}`);
  lines.push(`Manifest:     ${terminalEmphasis('supporting')(view.configPath)}`);
  lines.push(`Pipelines:    ${view.pipelines.length > 0 ? view.pipelines.join(', ') : terminalEmphasis('placeholder')('(none)')}`);
  lines.push(`Unclassified: ${terminalUnclassified(view.unclassifiedCount)(`${view.unclassifiedCount} file(s)`)}`);
  lines.push('');

  lines.push(`Suggested loop: ${view.suggestedLoop ? terminalEmphasis('binding-identity')(view.suggestedLoop) : terminalEmphasis('placeholder')('(none)')}`);
  lines.push(`Reason:         ${terminalEmphasis('supporting')(view.suggestedLoopReason)}`);
  lines.push('Configured Pipelines:');
  if (!view.configuredPipelines || view.configuredPipelines.length === 0) {
    lines.push(`  ${terminalEmphasis('placeholder')('(none configured)')}`);
  } else {
    for (const pipe of view.configuredPipelines) {
      const stagesStr = pipe.stages.map((s) => `${s.stageId} (${s.loopOrTask})`).join(' -> ');
      lines.push(`  - Pipeline '${terminalEmphasis('binding-identity')(pipe.pipelineId)}': ${stagesStr}`);
    }
  }
  lines.push('');

  lines.push('Prompt Contracts:');
  for (const bindingContract of view.promptContracts) {
    lines.push(`  [${bindingContract.bindingKind}] ${terminalEmphasis('binding-identity')(bindingContract.bindingId)}`);
    const targetTag = bindingContract.targetStatus === 'missing'
      ? terminalAvailability('missing-inputs')(`[${bindingContract.targetKind}: missing target]`)
      : `[${bindingContract.targetKind}]`;
    lines.push(`    Target:          ${bindingContract.targetPath} ${targetTag}`);
    lines.push(`    Prompt recipe:   ${bindingContract.composition}`);
    lines.push(`    Result contract: Pattern -> contract -> decision/validator`);

    for (const step of bindingContract.steps) {
      lines.push('');
      const phaseTitle = step.phase.charAt(0).toUpperCase() + step.phase.slice(1);
      lines.push(`    ${phaseTitle}:`);
      lines.push(`      Role:   ${step.roleId} -> ${step.rolePath}`);
      lines.push(`      Skill:  ${step.skillId} -> ${step.skillPath}`);
      lines.push(`      Inputs:`);
      for (const input of step.inputs) {
        const noteText = input.note
          ? terminalAvailability(input.status === 'missing' ? 'missing-inputs' : 'available')(input.note)
          : '';
        lines.push(`        ${input.label.padEnd(15)} <- ${input.source.padEnd(20)} ${noteText}`.trimEnd());
      }
      lines.push(`      Result contract:`);
      lines.push(`        Pattern:  ${step.outputPattern}`);
      lines.push(`        Contract: ${step.outputContract}`);
      if (step.decision) {
        lines.push(`        Decision: heading=${step.decision.heading}, accepted=${step.decision.accepted}, retry=${step.decision.retry}`);
      }
      if (step.validator) {
        lines.push(`        Validator: ${step.validator}`);
      }
    }
    lines.push('');
  }

  lines.push('Bindings:');
  for (const binding of view.bindings) {
    const targetInfo = binding.targetPath ? ` -> ${binding.targetPath}` : '';
    lines.push(`  [${binding.bindingKind}] ${terminalEmphasis('binding-identity')(binding.bindingId)}${targetInfo}`);

    if (binding.missingInputs.length > 0) {
      lines.push(`    ${terminalAvailability('missing-inputs')(`Missing inputs: ${binding.missingInputs.join(', ')}`)}`);
    }

    if (binding.bindingKind === 'loop') {
      if (binding.latestEvaluate) {
        const s = binding.latestEvaluate.step;
        const rawState = s.decision ?? s.verdict ?? 'valid';
        const stateStr = terminalResult(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest evaluate: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestEvaluate.effortStr}, session: ${binding.latestEvaluate.sessionStr}]`);
        lines.push(`    Path: ${terminalEmphasis('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest evaluate: ${terminalEmphasis('placeholder')('(none)')}`);
      }
      if (binding.latestRepair) {
        const s = binding.latestRepair.step;
        const rawState = s.completionOutcome ?? s.outcome ?? 'valid';
        const stateStr = terminalResult(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest repair: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestRepair.effortStr}, session: ${binding.latestRepair.sessionStr}]`);
        lines.push(`    Path: ${terminalEmphasis('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest repair: ${terminalEmphasis('placeholder')('(none)')}`);
      }
    } else {
      if (binding.latestTask) {
        const s = binding.latestTask.step;
        const rawState = s.completionOutcome ?? s.outcome ?? 'valid';
        const stateStr = terminalResult(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest task: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestTask.effortStr}, session: ${binding.latestTask.sessionStr}]`);
        lines.push(`    Path: ${terminalEmphasis('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest task: ${terminalEmphasis('placeholder')('(none)')}`);
      }
    }

    const unclassStr = terminalUnclassified(binding.unclassifiedCount)(`Unclassified count: ${binding.unclassifiedCount}`);
    lines.push(`    ${unclassStr}`);

    lines.push('--------------------------------------------------------------------------------');
  }

  lines.push('');
  lines.push(`Pipeline Suggestions (Eligible: ${view.eligibleCandidates.length}, Total: ${view.allCandidates.length}):`);
  if (view.allCandidates.length === 0) {
    lines.push(`  ${terminalEmphasis('placeholder')('(none)')}`);
  } else {
    for (const cand of view.allCandidates) {
      const rawStatusStr = cand.reason === 'eligible'
        ? 'eligible'
        : cand.stale
          ? `unavailable (${cand.staleReason ?? cand.reason})`
          : `unavailable (${cand.unavailableReason ?? cand.reason})`;
      const statusStr = terminalStale(cand.stale)(rawStatusStr);
      lines.push(`  - [${cand.pipelineId}:${cand.pipelineRunId}] ${cand.predecessorStageId} -> ${cand.successorStageId} (${statusStr})`);
      lines.push(`    Predecessor artifact: ${cand.completionArtifactPath}`);
      if (opts?.showFingerprints === true) {
        lines.push(`    Artifact identity: ${cand.completionArtifactIdentity}`);
      }
      lines.push(`    Decision/Outcome: ${cand.decisionOrOutcome}`);
      lines.push(`    Binding/Phase: ${cand.predecessorBindingKind}/${cand.predecessorBindingId}/${cand.predecessorPhase}`);
      lines.push(`    Chain: ${cand.predecessorChainId} | Normalized result: ${cand.normalizedResult}`);
      lines.push(`    Eligibility reason: ${cand.reason}`);
      if (opts?.showFingerprints === true) {
        const rawFpStr = cand.stale
          ? `drift (recorded ${cand.resultFingerprint ?? 'none'} vs current ${cand.targetFingerprintNow ?? 'none'})`
          : `valid (${cand.resultFingerprint ?? 'none'})`;
        const fpStr = terminalStale(cand.stale)(rawFpStr);
        lines.push(`    Fingerprint: ${fpStr}`);
      }
    }
  }

  if (view.interruptedMarker) {
    lines.push('');
    lines.push(`Interrupted Run:`);
    lines.push(`  Binding: ${view.interruptedMarker.loop}, Step: ${view.interruptedMarker.kind}, Version: ${view.interruptedMarker.version}`);
  }

  lines.push('');
  lines.push(`Unclassified Artifacts (${view.unclassifiedCount}):`);
  if (view.unclassifiedSteps.length === 0) {
    lines.push(`  ${terminalEmphasis('placeholder')('(none)')}`);
  } else {
    for (const step of view.unclassifiedSteps) {
      lines.push(`  - Path: ${step.artifactPath}`);
      lines.push(`    Reason: ${step.unclassifiedReason ?? 'Unclassified'}`);
    }
  }

  lines.push('================================================================================');

  return lines.join('\n');
}
