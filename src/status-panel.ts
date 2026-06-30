import boxen from 'boxen';
import Table from 'cli-table3';
import chalk from 'chalk';
import type { PanelContext } from './status.js';
import { roleAccent, statusAccent, panelBorderColor, inFlightRole } from './status-accent.js';

export function renderStatusPanel(context: PanelContext): string {
  const pName = chalk.cyan(context.projectRoot);
  const lName = chalk.yellow(context.loopName);

  const iterStr = context.readOnly
    ? chalk.magenta('Iteration: not running')
    : chalk.magenta(`Iteration: ${context.currentIteration}/${context.maxIterations}`);

  let activeStr = 'None';
  if (context.activeSkillRunner) {
    activeStr = chalk.green(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  const contentLines: string[] = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    iterStr,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${chalk.white(context.nextStepMessage)}`,
    `Latest version:   v${context.latestVersion}`
  ];

  const inFlightSection = renderInFlightSection(context);
  if (inFlightSection) {
    contentLines.push('');
    contentLines.push(inFlightSection);
  }

  const timelineSection = renderTimelineSection(context);
  contentLines.push('');
  contentLines.push(chalk.bold('Timeline:'));
  contentLines.push(timelineSection);

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

  const roleAcc = roleAccent(inFlightRole(context.inFlight.kind));
  const statusAcc = statusAccent(context.inFlight.status);

  const rows: string[][] = [[
    String(context.inFlight.version),
    roleAcc.chalk(roleAcc.label),
    context.inFlight.agent,
    context.inFlight.model,
    '\u2014',
    statusAcc.chalk(context.inFlight.status)
  ]];

  const table = new Table({
    head: ['Ver', 'Role', 'Agent', 'Model', 'Result', 'Status'],
    style: { head: ['cyan'], border: [] },
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '', middle: ' '
    },
    wordWrap: true
  });
  for (const row of rows) {
    table.push(row);
  }

  // Elapsed since the spawn started; per the plan, the renderer reads the
  // closed-over `startedAtMs` at paint time so the displayed elapsed grows
  // monotonically across 200ms ticks.
  const elapsedSecs = Math.max(0, Math.floor((Date.now() - context.inFlight.startedAtMs) / 1000));
  const elapsedStr = elapsedSecs >= 60
    ? `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s`
    : `${elapsedSecs}s`;

  const messageSuffix = context.inFlight.message && context.inFlight.message !== '...'
    ? ` · ${chalk.white(context.inFlight.message)}`
    : '';
  return `${chalk.bold('Active Step:')} ${chalk.gray(`(elapsed ${elapsedStr})`)}${messageSuffix}\n${table.toString()}`;
}

function renderTimelineSection(context: PanelContext): string {
  const latestIndex = context.timeline.length - 1;

  const rows = context.timeline.map((s, index) => {
    const roleAcc = roleAccent(s.role);

    let resultStr = '';
    if (s.kind === 'audit') {
      const v = s.verdict;
      if (v === 'APPROVED') {
        resultStr = chalk.bold.green(v);
      } else if (v === 'REJECTED') {
        resultStr = chalk.bold.red(v);
      } else {
        resultStr = chalk.bold.yellow(v ?? 'unknown');
      }
    } else {
      const o = s.outcome;
      if (o === 'patched') {
        resultStr = chalk.green(o);
      } else if (o === 'blocked') {
        resultStr = chalk.yellow(o);
      } else {
        resultStr = o ?? '';
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
      resultStr,
      statusStr
    ];
  });

  if (rows.length === 0) {
    return '';
  }

  const table = new Table({
    head: ['Ver', 'Role', 'Agent', 'Model', 'Result', 'Status'],
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
