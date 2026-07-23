import type { ProjectSnapshotView } from './project-snapshot-view.js';
import {
  resultAccent,
  toResultState,
  availabilityAccent,
  emphasisAccent,
  unclassifiedAccent,
  staleAccent,
} from './terminal-accent.js';

/** Render the compact startup project snapshot for the interactive header. */
export function renderCompactSnapshot(view: ProjectSnapshotView): string {
  const pipelinesStr = view.pipelines.length > 0
    ? view.pipelines.join(', ')
    : emphasisAccent('placeholder')('(none configured)');

  const lines: string[] = [
    `Project:   ${emphasisAccent('identity')(view.projectRoot)}`,
    `Config:    ${emphasisAccent('supporting')(view.configPath)}`,
    `Pipelines: ${pipelinesStr}`,
    `Suggested loop: ${view.suggestedLoop ? emphasisAccent('binding-identity')(view.suggestedLoop) : emphasisAccent('placeholder')('(none)')}`,
    `Reason:    ${emphasisAccent('supporting')(view.suggestedLoopReason)}`,
    '',
    'Bindings:',
  ];

  for (const b of view.bindings) {
    const targetInfo = b.targetPath ? ` (target: ${b.targetPath})` : '';
    lines.push(`  [${b.bindingKind}] ${emphasisAccent('binding-identity')(b.bindingId)}${targetInfo}`);

    if (b.bindingKind === 'loop') {
      if (b.latestEvaluate) {
        const s = b.latestEvaluate.step;
        const rawDec = s.decision ?? s.verdict ?? 'valid';
        const dec = resultAccent(toResultState(rawDec))(rawDec);
        const filename = s.artifactPath.split('/').pop();
        const meta = emphasisAccent('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestEvaluate.effortStr}, session: ${b.latestEvaluate.sessionStr}]`);
        lines.push(`    evaluate: ${filename} (${dec}) ${meta}`);
      } else {
        lines.push(`    evaluate: ${emphasisAccent('placeholder')('(none)')}`);
      }
      if (b.latestRepair) {
        const s = b.latestRepair.step;
        const rawOut = s.completionOutcome ?? s.outcome ?? 'valid';
        const out = resultAccent(toResultState(rawOut))(rawOut);
        const filename = s.artifactPath.split('/').pop();
        const meta = emphasisAccent('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestRepair.effortStr}, session: ${b.latestRepair.sessionStr}]`);
        lines.push(`    repair: ${filename} (${out}) ${meta}`);
      } else {
        lines.push(`    repair: ${emphasisAccent('placeholder')('(none)')}`);
      }
    } else {
      if (b.latestTask) {
        const s = b.latestTask.step;
        const rawDec = s.completionOutcome ?? s.outcome ?? 'valid';
        const dec = resultAccent(toResultState(rawDec))(rawDec);
        const filename = s.artifactPath.split('/').pop();
        const meta = emphasisAccent('supporting')(`[${s.agent} / ${s.model}, effort: ${b.latestTask.effortStr}, session: ${b.latestTask.sessionStr}]`);
        lines.push(`    task: ${filename} (${dec}) ${meta}`);
      } else {
        lines.push(`    task: ${emphasisAccent('placeholder')('(none)')}`);
      }
    }

    if (b.missingInputs.length > 0) {
      lines.push(`    ${availabilityAccent('missing-inputs')(`Missing inputs: ${b.missingInputs.join(', ')}`)}`);
    }

    const unclassStr = unclassifiedAccent(b.unclassifiedCount)(`unclassified count: ${b.unclassifiedCount}`);
    lines.push(`    ${unclassStr}`);
  }

  return lines.join('\n');
}

/** Render the detailed project status report (used by `orc status` and prompt-contract inspection). */
export function renderDetailedSnapshot(view: ProjectSnapshotView): string {
  const lines: string[] = [];

  lines.push('================================================================================');
  lines.push('                                Project Snapshot                                ');
  lines.push('================================================================================');
  lines.push(`Project Root: ${emphasisAccent('identity')(view.projectRoot)}`);
  lines.push(`Manifest:     ${emphasisAccent('supporting')(view.configPath)}`);
  lines.push(`Pipelines:    ${view.pipelines.length > 0 ? view.pipelines.join(', ') : emphasisAccent('placeholder')('(none)')}`);
  lines.push(`Unclassified: ${unclassifiedAccent(view.unclassifiedCount)(`${view.unclassifiedCount} file(s)`)}`);
  lines.push('');

  lines.push(`Suggested loop: ${view.suggestedLoop ? emphasisAccent('binding-identity')(view.suggestedLoop) : emphasisAccent('placeholder')('(none)')}`);
  lines.push(`Reason:         ${emphasisAccent('supporting')(view.suggestedLoopReason)}`);
  lines.push('Configured Pipelines:');
  if (!view.configuredPipelines || view.configuredPipelines.length === 0) {
    lines.push(`  ${emphasisAccent('placeholder')('(none configured)')}`);
  } else {
    for (const pipe of view.configuredPipelines) {
      const stagesStr = pipe.stages.map((s) => `${s.stageId} (${s.loopOrTask})`).join(' -> ');
      lines.push(`  - Pipeline '${emphasisAccent('binding-identity')(pipe.pipelineId)}': ${stagesStr}`);
    }
  }
  lines.push('');

  lines.push('Prompt Contracts:');
  for (const bindingContract of view.promptContracts) {
    lines.push(`  [${bindingContract.bindingKind}] ${emphasisAccent('binding-identity')(bindingContract.bindingId)}`);
    const targetTag = bindingContract.targetStatus === 'missing'
      ? availabilityAccent('missing-inputs')(`[${bindingContract.targetKind}: missing target]`)
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
          ? availabilityAccent(input.status === 'missing' ? 'missing-inputs' : 'available')(input.note)
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
    lines.push(`  [${binding.bindingKind}] ${emphasisAccent('binding-identity')(binding.bindingId)}${targetInfo}`);

    if (binding.missingInputs.length > 0) {
      lines.push(`    ${availabilityAccent('missing-inputs')(`Missing inputs: ${binding.missingInputs.join(', ')}`)}`);
    }

    if (binding.bindingKind === 'loop') {
      if (binding.latestEvaluate) {
        const s = binding.latestEvaluate.step;
        const rawState = s.decision ?? s.verdict ?? 'valid';
        const stateStr = resultAccent(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest evaluate: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestEvaluate.effortStr}, session: ${binding.latestEvaluate.sessionStr}]`);
        lines.push(`    Path: ${emphasisAccent('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest evaluate: ${emphasisAccent('placeholder')('(none)')}`);
      }
      if (binding.latestRepair) {
        const s = binding.latestRepair.step;
        const rawState = s.completionOutcome ?? s.outcome ?? 'valid';
        const stateStr = resultAccent(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest repair: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestRepair.effortStr}, session: ${binding.latestRepair.sessionStr}]`);
        lines.push(`    Path: ${emphasisAccent('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest repair: ${emphasisAccent('placeholder')('(none)')}`);
      }
    } else {
      if (binding.latestTask) {
        const s = binding.latestTask.step;
        const rawState = s.completionOutcome ?? s.outcome ?? 'valid';
        const stateStr = resultAccent(toResultState(rawState))(rawState);
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest task: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestTask.effortStr}, session: ${binding.latestTask.sessionStr}]`);
        lines.push(`    Path: ${emphasisAccent('supporting')(s.artifactPath)}`);
      } else {
        lines.push(`    Latest task: ${emphasisAccent('placeholder')('(none)')}`);
      }
    }

    const unclassStr = unclassifiedAccent(binding.unclassifiedCount)(`Unclassified count: ${binding.unclassifiedCount}`);
    lines.push(`    ${unclassStr}`);

    lines.push('--------------------------------------------------------------------------------');
  }

  lines.push('');
  lines.push(`Pipeline Suggestions (Eligible: ${view.eligibleCandidates.length}, Total: ${view.allCandidates.length}):`);
  if (view.allCandidates.length === 0) {
    lines.push(`  ${emphasisAccent('placeholder')('(none)')}`);
  } else {
    for (const cand of view.allCandidates) {
      const rawStatusStr = cand.stale ? `stale (${cand.staleReason ?? 'input modified'})` : 'eligible';
      const statusStr = staleAccent(cand.stale)(rawStatusStr);
      lines.push(`  - [${cand.pipelineId}:${cand.pipelineRunId}] ${cand.predecessorStageId} -> ${cand.successorStageId} (${statusStr})`);
      lines.push(`    Predecessor artifact: ${cand.completionArtifactPath}`);
      lines.push(`    Artifact identity: ${cand.completionArtifactIdentity}`);
      lines.push(`    Decision/Outcome: ${cand.decisionOrOutcome}`);
      const rawFpStr = cand.stale
        ? `drift (recorded ${cand.resultFingerprint ?? 'none'} vs current ${cand.targetFingerprintNow ?? 'none'})`
        : `valid (${cand.resultFingerprint ?? 'none'})`;
      const fpStr = staleAccent(cand.stale)(rawFpStr);
      lines.push(`    Fingerprint: ${fpStr}`);
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
    lines.push(`  ${emphasisAccent('placeholder')('(none)')}`);
  } else {
    for (const step of view.unclassifiedSteps) {
      lines.push(`  - Path: ${step.artifactPath}`);
      lines.push(`    Reason: ${step.unclassifiedReason ?? 'Unclassified'}`);
    }
  }

  lines.push('================================================================================');

  return lines.join('\n');
}
