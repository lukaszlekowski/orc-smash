import boxen from 'boxen';
import Table from 'cli-table3';
import { formatDurationMs, formatSessionId, type PanelContext } from './status.js';
import { roleAccent, statusAccent, panelBorderColor, resultAccent, toResultState, emphasisAccent } from './terminal-accent.js';

export function renderStatusPanel(context: PanelContext): string {
  const pName = emphasisAccent('identity')(context.projectRoot);
  const lName = emphasisAccent('binding-identity')(context.loopName);

  const iterationValue = context.readOnly
    ? 'not running'
    : context.providerCalls !== undefined
      ? `Round ${context.currentIteration}/${context.maxIterations} - provider calls ${context.providerCalls}`
      : `${context.currentIteration}/${context.maxIterations}`;

  let activeStr = 'None';
  if (context.activeSkillRunner) {
    activeStr = emphasisAccent('identity')(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  const contentLines: string[] = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `Iteration:        ${emphasisAccent('supporting')(iterationValue)}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${emphasisAccent('identity')(context.nextStepMessage)}`,
    `Latest version:   v${context.latestVersion}`
  ];

  if (context.resolvedRunners && context.resolvedRunners.length > 0) {
    contentLines.push('');
    contentLines.push(emphasisAccent('identity')('Run configuration'));
    for (const runner of context.resolvedRunners) {
      const phaseLabel = runner.phase ? runner.phase.charAt(0).toUpperCase() + runner.phase.slice(1) : 'Skill';
      const roleStr = runner.role ? ` (${runner.role})` : '';
      const effortStr = runner.effort ?? 'provider default';
      const stratStr = runner.sessionStrategy === 'resume-per-skill' ? 'resume per skill' : 'fresh per invocation';
      contentLines.push(`  ${phaseLabel.padEnd(10)} ${`${runner.skillId}${roleStr}`.padEnd(24)} ${emphasisAccent('identity')(`${runner.agent} · ${runner.model}`)}  ${effortStr}  ${stratStr}`);
    }
  }

  if (context.activeInvocation) {
    const active = context.activeInvocation;
    const pendingStr = (active.newSessionPending || active.sessionMode === 'fresh') ? ', new session ID: pending' : '';
    const modeStr = active.sessionMode === 'resumed'
      ? `resuming session ${formatSessionId(active.sessionId)}`
      : active.freshReason === 'policy'
        ? `fresh session (policy${pendingStr})`
        : active.freshReason === 'provider-unsupported'
          ? `fresh session (provider unsupported${pendingStr})`
          : `fresh session (no compatible session${pendingStr})`;
    contentLines.push('');
    contentLines.push(emphasisAccent('identity')('Active invocation'));
    contentLines.push(`  ${active.skillId} v${active.version} — ${modeStr}`);
  }

  const timelineSection = renderTimelineSection(context);
  contentLines.push('');
  contentLines.push(emphasisAccent('identity')('Timeline:'));
  contentLines.push(timelineSection);

  const inFlightSection = renderInFlightSection(context);
  if (inFlightSection) {
    contentLines.push('');
    contentLines.push(inFlightSection);
  }

  return boxen(contentLines.join('\n'), {
    title: emphasisAccent('identity')(' ORC SMASH STATUS PANEL '),
    titleAlignment: 'center',
    padding: 1,
    margin: 0,
    borderStyle: 'round',
    borderColor: panelBorderColor(context)
  });
}

function renderInFlightSection(context: PanelContext): string | null {
  if (!context.inFlight) return null;

  // Elapsed since the spawn started; the renderer reads the closed-over
  // `startedAtMs` at paint time so the displayed elapsed grows monotonically
  // across 200ms ticks.
  const elapsedStr = formatDurationMs(Date.now() - context.inFlight.startedAtMs);

  const detailLines = [
    `${emphasisAccent('identity')('Active Step:')} ${emphasisAccent('supporting')(`(elapsed ${elapsedStr})`)}`,
    `Spawn:            ${emphasisAccent('identity')(context.inFlight.spawnLabel)}`
  ];

  if (context.inFlight.toolCallCount > 0) {
    detailLines.push(`Tool calls:       ${emphasisAccent('identity')(String(context.inFlight.toolCallCount))}`);
  }

  if (context.inFlight.progressMessage) {
    detailLines.push(`Progress:         ${emphasisAccent('identity')(context.inFlight.progressMessage)}`);
  }

  return detailLines.join('\n');
}

function renderTimelineSection(context: PanelContext): string {
  const latestIndex = context.timeline.length - 1;

  const rows = context.timeline.map((s, index) => {
    const roleAcc = roleAccent(s.role);

    // An interrupted step has no verdict/outcome — render an em dash so the
    // status column's literal "interrupted" is the signal, not a misleading
    // "unknown" result.
    let resultStr = '';
    if (s.status === 'interrupted') {
      resultStr = '—';
    } else {
      const result = s.decision ?? s.completionOutcome ?? s.verdict ?? s.outcome;
      if (result) {
        resultStr = resultAccent(toResultState(result))(result);
      }
    }

    if (index === latestIndex) {
      resultStr += ` ${emphasisAccent('supporting')('*')}`;
    }

    const statusAcc = statusAccent(s.status);
    const statusStr = statusAcc.chalk(statusAcc.label);

    return [
      String(s.version),
      roleAcc.chalk(roleAcc.label),
      s.agent,
      s.model,
      s.effort ?? 'default',
      resultStr,
      emphasisAccent('supporting')(formatDurationMs(s.durationMs)),
      formatSessionId(s.sessionId),
      statusStr
    ];
  });

  if (context.inFlight) {
    const roleAcc = roleAccent(context.inFlight.role);
    const statusAcc = statusAccent(context.inFlight.status);
    rows.push([
      String(context.inFlight.version),
      roleAcc.chalk(roleAcc.label),
      context.inFlight.agent,
      context.inFlight.model,
      context.inFlight.effort ?? 'default',
      '\u2014',
      emphasisAccent('supporting')(formatDurationMs(Date.now() - context.inFlight.startedAtMs)),
      '\u2014',
      statusAcc.chalk(statusAcc.label)
    ]);
  }

  if (rows.length === 0) {
    return '';
  }

  const table = new Table({
    head: ['Ver', 'Role', 'Agent', 'Model', 'Effort', 'Result', 'Time', 'Session', 'Status'],
    style: { head: ['cyan'], border: [] },
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '',
      middle: ' '
    },
    wordWrap: true
  });

  for (const row of rows) {
    table.push(row);
  }

  return table.toString();
}
