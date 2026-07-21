import boxen from 'boxen';
import Table from 'cli-table3';
import chalk from 'chalk';
import { formatDurationMs, formatSessionId, type PanelContext } from './status.js';
import { roleAccent, statusAccent, panelBorderColor } from './status-accent.js';

export function renderStatusPanel(context: PanelContext): string {
  const pName = chalk.cyan(context.projectRoot);
  const lName = chalk.yellow(context.loopName);

  const iterationValue = context.readOnly
    ? 'not running'
    : `${context.currentIteration}/${context.maxIterations}`;

  let activeStr = 'None';
  if (context.activeSkillRunner) {
    activeStr = chalk.green(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  const contentLines: string[] = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `Iteration:        ${chalk.magenta(iterationValue)}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${chalk.white(context.nextStepMessage)}`,
    `Latest version:   v${context.latestVersion}`
  ];

  for (const runner of context.resolvedRunners ?? []) {
    const source = runner.source === 'inherited' && runner.inheritedFrom
      ? `inherited from ${runner.inheritedFrom.kind} v${runner.inheritedFrom.version}, session ${formatSessionId(runner.inheritedFrom.sessionId)}`
      : runner.source === 'selected'
        ? 'selected this chain'
        : 'configured for this run';
    contentLines.push(`Runner (${runner.skillId}): ${chalk.green(`${runner.agent} · ${runner.model}`)} — ${source}`);
  }

  const timelineSection = renderTimelineSection(context);
  contentLines.push('');
  contentLines.push(chalk.bold('Timeline:'));
  contentLines.push(timelineSection);

  const inFlightSection = renderInFlightSection(context);
  if (inFlightSection) {
    contentLines.push('');
    contentLines.push(inFlightSection);
  }

  return boxen(contentLines.join('\n'), {
    title: chalk.bold.blue(' ORC SMASH STATUS PANEL '),
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
    `${chalk.bold('Active Step:')} ${chalk.gray(`(elapsed ${elapsedStr})`)}`,
    `Spawn:            ${chalk.white(context.inFlight.spawnLabel)}`
  ];

  if (context.inFlight.toolCallCount > 0) {
    detailLines.push(`Tool calls:       ${chalk.white(String(context.inFlight.toolCallCount))}`);
  }

  if (context.inFlight.progressMessage) {
    detailLines.push(`Progress:         ${chalk.white(context.inFlight.progressMessage)}`);
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
      if (result === 'accepted' || result === 'completed') {
        resultStr = chalk.bold.green(result);
      } else if (result === 'retry') {
        resultStr = chalk.bold.red(result);
      } else if (result === 'blocked') {
        resultStr = chalk.bold.yellow(result);
      } else {
        resultStr = result ? chalk.bold.yellow(result) : '';
      }
    }

    if (index === latestIndex) {
      resultStr += ` ${chalk.blue('*')}`;
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
      chalk.gray(formatDurationMs(s.durationMs)),
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
      'default',
      '\u2014',
      chalk.gray(formatDurationMs(Date.now() - context.inFlight.startedAtMs)),
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
