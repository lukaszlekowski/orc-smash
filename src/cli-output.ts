import type { PanelContext } from './status.js';
import { renderStatusPanel } from './status-panel.js';
import ora, { Ora } from 'ora';
import chalk from 'chalk';

export interface CliOutput {
  note(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  iterationStarted(ctx: { iteration: number; maxIterations: number }): void;
  stepStarted(ctx: {
    kind: 'audit' | 'follow-up';
    skillId: string;
    agent: string;
    model: string;
    iteration: number;
    version: number;
    message: string;
  }): void;
  stepSucceeded(ctx: {
    kind: 'audit' | 'follow-up';
    skillId: string;
    version: number;
    message: string;
  }): void;
  stepFailed(ctx: {
    kind: 'audit' | 'follow-up';
    skillId: string;
    version: number;
    message: string;
    errorKind?: string;
  }): void;
  renderPanel(context: PanelContext): void;
  finalSummary(ctx: {
    success: boolean;
    verdict: 'APPROVED' | 'REJECTED' | 'unknown' | null;
    message: string;
    lastAuditPath: string | null;
  }): void;
}

export function createPanelCliOutput(): CliOutput {
  let spinner: Ora | null = null;

  return {
    note(message: string) {
      console.log(chalk.gray(message));
    },
    warn(message: string) {
      console.warn(chalk.yellow(`Warning: ${message}`));
    },
    error(message: string) {
      console.error(chalk.red(`Error: ${message}`));
    },
    iterationStarted(ctx: { iteration: number; maxIterations: number }) {
      // iteration started hook
    },
    stepStarted(ctx) {
      if (spinner) {
        spinner.stop();
      }
      spinner = ora(chalk.blue(ctx.message)).start();
    },
    stepSucceeded(ctx) {
      if (spinner) {
        spinner.succeed(chalk.green(ctx.message));
        spinner = null;
      } else {
        console.log(chalk.green(ctx.message));
      }
    },
    stepFailed(ctx) {
      if (spinner) {
        spinner.fail(chalk.red(ctx.message));
        spinner = null;
      } else {
        console.error(chalk.red(ctx.message));
      }
    },
    renderPanel(context: PanelContext) {
      console.clear();
      console.log(renderStatusPanel(context));
    },
    finalSummary(ctx) {
      if (ctx.success) {
        console.log(chalk.bold.green(`\nSuccess: ${ctx.message}`));
      } else {
        console.log(chalk.bold.red(`\nLoop terminated: ${ctx.message}`));
      }
    }
  };
}

export function createPlainCliOutput(): CliOutput {
  let lastPanelContextJson = '';

  return {
    note(message: string) {
      console.log(`Note: ${message}`);
    },
    warn(message: string) {
      console.warn(`Warning: ${message}`);
    },
    error(message: string) {
      console.error(`Error: ${message}`);
    },
    iterationStarted(ctx) {
      console.log(`Iteration ${ctx.iteration}/${ctx.maxIterations} started`);
    },
    stepStarted(ctx) {
      console.log(`Step ${ctx.kind} version ${ctx.version} using ${ctx.agent} (${ctx.model}): running...`);
    },
    stepSucceeded(ctx) {
      console.log(`Step ${ctx.kind} version ${ctx.version}: succeeded`);
    },
    stepFailed(ctx) {
      console.log(`Step ${ctx.kind} version ${ctx.version}: failed (error: ${ctx.errorKind ?? 'unknown'})`);
    },
    renderPanel(context: PanelContext) {
      const simplified = {
        loopName: context.loopName,
        currentIteration: context.currentIteration,
        maxIterations: context.maxIterations,
        activeSkillRunner: context.activeSkillRunner,
        nextStepMessage: context.nextStepMessage,
        timeline: context.timeline.map(s => ({
          version: s.version,
          role: s.role,
          agent: s.agent,
          model: s.model,
          verdict: s.verdict,
          outcome: s.outcome,
          status: s.status
        }))
      };
      const json = JSON.stringify(simplified);
      if (json !== lastPanelContextJson) {
        lastPanelContextJson = json;
        const activeRunner = context.activeSkillRunner
          ? `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
          : 'None';
        const timelineStr = context.timeline
          .map(s => {
            const stepName = `${s.kind} v${s.version}`;
            const stepState = s.status === 'running'
              ? 'running'
              : s.status === 'failed'
              ? 'failed'
              : s.kind === 'audit'
              ? s.verdict ?? 'done'
              : s.outcome ?? 'done';
            return `${stepName}:${stepState}`;
          })
          .join(', ');

        console.log(
          `[Panel] Loop: ${context.loopName} | Iteration: ${context.currentIteration}/${context.maxIterations} | Active: ${activeRunner} | Next: ${context.nextStepMessage} | Timeline: [${timelineStr}]`
        );
      }
    },
    finalSummary(ctx) {
      if (ctx.success) {
        console.log(`Success: ${ctx.message} (Verdict: ${ctx.verdict}, Path: ${ctx.lastAuditPath})`);
      } else {
        console.log(`Loop terminated: ${ctx.message} (Verdict: ${ctx.verdict})`);
      }
    }
  };
}
