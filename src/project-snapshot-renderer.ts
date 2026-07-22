import type { ProjectSnapshotView } from './project-snapshot-view.js';

/** Render the compact startup project snapshot for the interactive header. */
export function renderCompactSnapshot(view: ProjectSnapshotView): string {
  const pipelinesStr = view.pipelines.length > 0
    ? view.pipelines.join(', ')
    : '(none configured)';
  const lines: string[] = [
    `Project:   ${view.projectRoot}`,
    `Config:    ${view.configPath}`,
    `Pipelines: ${pipelinesStr}`,
    `Suggested loop: ${view.suggestedLoop ?? '(none)'}`,
    `Reason:    ${view.suggestedLoopReason}`,
    '',
    'Bindings:',
  ];

  if (view.bindings.length === 0) {
    lines.push('  (none configured)');
  } else {
    for (const b of view.bindings) {
      lines.push(`  [${b.bindingKind}] ${b.bindingId} (target: ${b.targetPath})`);
      if (b.bindingKind === 'loop') {
        if (b.latestEvaluate) {
          const s = b.latestEvaluate.step;
          const dec = s.decision ?? s.verdict ?? 'valid';
          const filename = s.artifactPath.split('/').pop();
          lines.push(`    evaluate: ${filename} (${dec}) [${s.agent} / ${s.model}, effort: ${b.latestEvaluate.effortStr}, session: ${b.latestEvaluate.sessionStr}]`);
        } else {
          lines.push(`    evaluate: (none)`);
        }
        if (b.latestRepair) {
          const s = b.latestRepair.step;
          const out = s.completionOutcome ?? s.outcome ?? 'valid';
          const filename = s.artifactPath.split('/').pop();
          lines.push(`    repair: ${filename} (${out}) [${s.agent} / ${s.model}, effort: ${b.latestRepair.effortStr}, session: ${b.latestRepair.sessionStr}]`);
        } else {
          lines.push(`    repair: (none)`);
        }
      } else {
        if (b.latestTask) {
          const s = b.latestTask.step;
          const dec = s.completionOutcome ?? s.outcome ?? 'valid';
          const filename = s.artifactPath.split('/').pop();
          lines.push(`    task: ${filename} (${dec}) [${s.agent} / ${s.model}, effort: ${b.latestTask.effortStr}, session: ${b.latestTask.sessionStr}]`);
        } else {
          lines.push(`    task: (none)`);
        }
      }
      if (b.missingInputs.length > 0) {
        lines.push(`    missing inputs: ${b.missingInputs.join(', ')}`);
      }
      lines.push(`    unclassified count: ${b.unclassifiedCount}`);
    }
  }

  return lines.join('\n');
}

/** Render the comprehensive detailed status view for orc status and interactive display. */
export function renderDetailedSnapshot(view: ProjectSnapshotView): string {
  const pipelinesStr = view.pipelines.length > 0
    ? view.pipelines.join(', ')
    : '(none configured)';

  const lines: string[] = [
    '================================================================================',
    'Project Snapshot',
    '================================================================================',
    `Project:   ${view.projectRoot}`,
    `Config:    ${view.configPath}`,
    `Scan Time: ${view.scanTime}`,
    `Pipelines: ${pipelinesStr}`,
    '',
    `Suggested loop: ${view.suggestedLoop ?? '(none)'}`,
    `Reason:    ${view.suggestedLoopReason}`,
    '',
    'Configured Pipelines:',
  ];

  if (!view.configuredPipelines || view.configuredPipelines.length === 0) {
    lines.push('  (none configured)');
  } else {
    for (const pipe of view.configuredPipelines) {
      const stagesStr = pipe.stages.map(s => `${s.stageId} (${s.loopOrTask})`).join(' -> ');
      lines.push(`  - Pipeline '${pipe.pipelineId}': ${stagesStr}`);
    }
  }

  lines.push('');
  lines.push('Configured Bindings:');

  for (const binding of view.bindings) {
    lines.push(`  [${binding.bindingKind}] ${binding.bindingId} (target: ${binding.targetPath})`);
    if (binding.missingInputs.length > 0) {
      lines.push(`    Missing inputs: ${binding.missingInputs.join(', ')}`);
    }

    if (binding.bindingKind === 'loop') {
      if (binding.latestEvaluate) {
        const s = binding.latestEvaluate.step;
        const stateStr = s.decision ?? s.verdict ?? 'valid';
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest evaluate: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestEvaluate.effortStr}, session: ${binding.latestEvaluate.sessionStr}]`);
        lines.push(`    Path: ${s.artifactPath}`);
      } else {
        lines.push(`    Latest evaluate: (none)`);
      }
      if (binding.latestRepair) {
        const s = binding.latestRepair.step;
        const stateStr = s.completionOutcome ?? s.outcome ?? 'valid';
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest repair: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestRepair.effortStr}, session: ${binding.latestRepair.sessionStr}]`);
        lines.push(`    Path: ${s.artifactPath}`);
      } else {
        lines.push(`    Latest repair: (none)`);
      }
    } else {
      if (binding.latestTask) {
        const s = binding.latestTask.step;
        const stateStr = s.completionOutcome ?? s.outcome ?? 'valid';
        const providerStr = `${s.agent} / ${s.model}`;
        lines.push(`    Latest task: ${s.kind} v${s.version} (${stateStr}) [${providerStr}, effort: ${binding.latestTask.effortStr}, session: ${binding.latestTask.sessionStr}]`);
        lines.push(`    Path: ${s.artifactPath}`);
      } else {
        lines.push(`    Latest task: (none)`);
      }
    }
    lines.push(`    Unclassified count: ${binding.unclassifiedCount}`);
  }

  lines.push('');
  lines.push(`Unclassified Artifacts (${view.unclassifiedCount}):`);
  if (view.unclassifiedSteps.length === 0) {
    lines.push('  (none)');
  } else {
    for (const step of view.unclassifiedSteps) {
      lines.push(`  - Path: ${step.artifactPath}`);
      lines.push(`    Reason: ${step.unclassifiedReason ?? 'Unclassified'}`);
    }
  }

  lines.push('');
  lines.push(`Pipeline Suggestions (Eligible: ${view.eligibleCandidates.length}, Total: ${view.allCandidates.length}):`);
  if (view.allCandidates.length === 0) {
    lines.push('  (none)');
  } else {
    for (const cand of view.allCandidates) {
      const statusStr = cand.stale ? `stale (${cand.staleReason ?? 'input modified'})` : 'eligible';
      lines.push(`  - [${cand.pipelineId}:${cand.pipelineRunId}] ${cand.predecessorStageId} -> ${cand.successorStageId} (${statusStr})`);
      lines.push(`    Predecessor artifact: ${cand.completionArtifactPath}`);
      lines.push(`    Artifact identity: ${cand.completionArtifactIdentity}`);
      lines.push(`    Decision/Outcome: ${cand.decisionOrOutcome}`);
      const fpStr = cand.stale
        ? `drift (recorded ${cand.resultFingerprint ?? 'none'} vs current ${cand.targetFingerprintNow ?? 'none'})`
        : `valid (${cand.resultFingerprint ?? 'none'})`;
      lines.push(`    Fingerprint: ${fpStr}`);
    }
  }

  if (view.interruptedMarker) {
    lines.push('');
    lines.push(`Interrupted Run:`);
    lines.push(`  Binding: ${view.interruptedMarker.loop}, Step: ${view.interruptedMarker.kind}, Version: ${view.interruptedMarker.version}`);
  }

  lines.push('================================================================================');
  return lines.join('\n');
}
