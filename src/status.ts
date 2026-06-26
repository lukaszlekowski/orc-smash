import boxen from 'boxen';
import Table from 'cli-table3';
import chalk from 'chalk';
import type { HistoryEntry } from './state.js';

export interface PanelContext {
  projectRoot: string;
  loopName: string;
  currentIteration: number;
  maxIterations: number;
  activeSkillRunner: { skillId: string; agent: string; model: string } | null;
  history: HistoryEntry[];
  nextStepMessage: string;
}

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
    head: ['Ver', 'Agent', 'Model', 'Verdict', 'Status'],
    style: { head: ['cyan'], border: ['gray'] }
  });

  const latestIndex = context.history.length - 1;
  context.history.forEach((h, index) => {
    let verdictStr: string = h.verdict;
    if (h.verdict === 'APPROVED') {
      verdictStr = chalk.bold.green(h.verdict);
    } else if (h.verdict === 'REJECTED') {
      verdictStr = chalk.bold.red(h.verdict);
    } else {
      verdictStr = chalk.bold.yellow(h.verdict);
    }

    const marker = index === latestIndex ? chalk.blue('◀ latest') : '';
    table.push([
      String(h.version),
      h.agent,
      h.model,
      verdictStr,
      marker
    ]);
  });

  const content = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `Iteration:        ${iter}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${chalk.white(context.nextStepMessage)}`,
    '',
    chalk.bold('Audit History:'),
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
