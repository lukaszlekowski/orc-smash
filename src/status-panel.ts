import boxen from 'boxen';
import Table from 'cli-table3';
import chalk from 'chalk';
import type { PanelContext } from './status.js';

export function renderStatusPanel(context: PanelContext): string {
  const pName = chalk.cyan(context.projectRoot);
  const lName = chalk.yellow(context.loopName);
  const iter = chalk.magenta(`${context.currentIteration}/${context.maxIterations}`);

  let activeStr = 'None';
  if (context.activeSkillRunner) {
    activeStr = chalk.green(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  // Create table
  const table = new Table({
    head: ['Ver', 'Role', 'Agent', 'Model', 'Result', 'Status'],
    style: { head: ['cyan'], border: ['gray'] }
  });

  const latestIndex = context.timeline.length - 1;
  context.timeline.forEach((s, index) => {
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
      resultStr += ` ${chalk.blue('◀ latest')}`;
    }

    let statusStr = '';
    if (s.status === 'running') {
      statusStr = chalk.yellow('running');
    } else if (s.status === 'failed') {
      statusStr = chalk.red('failed');
    } else {
      statusStr = chalk.gray('done');
    }

    table.push([
      String(s.version),
      s.role,
      s.agent,
      s.model,
      resultStr,
      statusStr
    ]);
  });

  const content = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `Iteration:        ${iter}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${chalk.white(context.nextStepMessage)}`,
    '',
    chalk.bold('Timeline:'),
    table.toString()
  ].join('\n');

  return boxen(content, {
    title: chalk.bold.blue(' ORC SMASH STATUS PANEL '),
    titleAlignment: 'center',
    padding: 1,
    margin: 1,
    borderStyle: 'double',
    borderColor: 'blue'
  });
}
