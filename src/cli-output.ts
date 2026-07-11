import type { PanelContext } from './status.js';
import { renderStatusPanel } from './status-panel.js';
import { renderPlainPanel } from './plain-render.js';
import ora, { Ora } from 'ora';
import chalk from 'chalk';
import type { StepKind } from './provenance.js';

const ENTER_ALT_SCREEN = '\u001B[?1049h';
const EXIT_ALT_SCREEN = '\u001B[?1049l';
const CURSOR_HOME_CLEAR = '\u001B[H\u001B[2J';
export const PANEL_RENDER_INTERVAL_MS = 1000;

// Wall-clock prefix for error/log lines so the operator can see when something
// happened. Kept chalk-free so the plain (piped) output stays machine-readable;
// panel output wraps it in color at the call site.
const timestamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
};

export interface CliOutput {
  note(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  iterationStarted(ctx: { iteration: number; maxIterations: number }): void;
  stepStarted(ctx: {
    kind: StepKind;
    skillId: string;
    agent: string;
    model: string;
    iteration: number;
    version: number;
    message: string;
  }): void;
  stepSucceeded(ctx: {
    kind: StepKind;
    skillId: string;
    version: number;
    message: string;
  }): void;
  stepFailed(ctx: {
    kind: StepKind;
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
    details?: string[];
  }): void;
  attachLiveRegion?(supplier: () => PanelContext): void;
  detachLiveRegion?(): void;
}

export function createPanelCliOutput(): CliOutput {
  let spinner: Ora | null = null;
  let altScreenActive = false;
  let liveInterval: ReturnType<typeof setInterval> | null = null;
  let liveActive = false;
  let liveSupplier: (() => PanelContext) | null = null;
  // Errors raised while the alt-screen live region is active are written to the alt
  // screen and lost on teardown. Buffer them here and flush to the main screen in
  // finalSummary so every error is visible with a timestamp.
  const pendingFailures: string[] = [];

  const ensureAltScreen = () => {
    if (altScreenActive) {
      return;
    }
    process.stdout.write(ENTER_ALT_SCREEN);
    altScreenActive = true;
  };

  const restoreMainScreen = () => {
    if (!altScreenActive) {
      return;
    }
    process.stdout.write(EXIT_ALT_SCREEN);
    altScreenActive = false;
  };

  const panelDraw = (ctx: PanelContext) => {
    ensureAltScreen();
    process.stdout.write(`${CURSOR_HOME_CLEAR}${renderStatusPanel(ctx)}\n`);
  };

  const detach = () => {
    if (liveSupplier) {
      process.stdout.write(CURSOR_HOME_CLEAR + renderStatusPanel(liveSupplier()) + '\n');
      liveSupplier = null;
    }
    if (liveInterval) {
      clearInterval(liveInterval);
      liveInterval = null;
    }
    liveActive = false;
  };

  return {
    note(message: string) {
      console.log(chalk.gray(message));
    },
    warn(message: string) {
      console.warn(chalk.yellow(`Warning: ${message}`));
    },
    error(message: string) {
      const line = `Error: ${message}`;
      if (liveActive) {
        pendingFailures.push(line);
      } else {
        console.error(chalk.red(`${timestamp()} ${line}`));
      }
    },
    iterationStarted(ctx: { iteration: number; maxIterations: number }) {
      // iteration started hook
    },
    stepStarted(ctx) {
      if (liveActive) {
        return;
      }
      if (spinner) {
        spinner.stop();
      }
      spinner = ora(chalk.blue(ctx.message)).start();
    },
    stepSucceeded(ctx) {
      if (liveActive) {
        console.log(chalk.green(ctx.message));
        return;
      }
      if (spinner) {
        spinner.succeed(chalk.green(ctx.message));
        spinner = null;
      } else {
        console.log(chalk.green(ctx.message));
      }
    },
    stepFailed(ctx) {
      if (liveActive) {
        // alt screen is discarded on teardown — buffer for a main-screen flush.
        pendingFailures.push(ctx.message);
        return;
      }
      if (spinner) {
        spinner.fail(chalk.red(`${timestamp()} ${ctx.message}`));
        spinner = null;
      } else {
        console.error(chalk.red(`${timestamp()} ${ctx.message}`));
      }
    },
    renderPanel(context: PanelContext) {
      panelDraw(context);
    },
    finalSummary(ctx) {
      detach();
      restoreMainScreen();
      // Flush errors that were raised during the live region (alt screen) so they
      // survive on the main screen with a timestamp instead of being discarded.
      for (const failure of pendingFailures) {
        console.error(chalk.red(`${timestamp()} ${failure}`));
      }
      pendingFailures.length = 0;
      if (ctx.success) {
        console.log(chalk.bold.green(`\n${timestamp()} Success: ${ctx.message}`));
      } else {
        console.log(chalk.bold.red(`\n${timestamp()} Loop terminated: ${ctx.message}`));
      }
      if (ctx.details && ctx.details.length > 0) {
        console.log(chalk.cyan('Current project snapshot:'));
        for (const detail of ctx.details) console.log(chalk.gray(`  ${detail}`));
      }
    },
    attachLiveRegion(supplier: () => PanelContext) {
      if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = null;
      }
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      liveSupplier = supplier;
      liveActive = true;
      ensureAltScreen();
      liveInterval = setInterval(() => {
        process.stdout.write(CURSOR_HOME_CLEAR + renderStatusPanel(supplier()) + '\n');
      }, PANEL_RENDER_INTERVAL_MS);
    },
    detachLiveRegion() {
      detach();
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
      console.error(`${timestamp()} Error: ${message}`);
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
      console.log(`${timestamp()} Step ${ctx.kind} version ${ctx.version}: failed (error: ${ctx.errorKind ?? 'unknown'})`);
    },
    renderPanel(context: PanelContext) {
      const simplified = {
        loopName: context.loopName,
        currentIteration: context.currentIteration,
        maxIterations: context.maxIterations,
        activeSkillRunner: context.activeSkillRunner,
        nextStepMessage: context.nextStepMessage,
        inFlight: context.inFlight,
        latestVersion: context.latestVersion,
        readOnly: context.readOnly,
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
        console.log(renderPlainPanel(context));
      }
    },
    finalSummary(ctx) {
      if (ctx.success) {
        console.log(`${timestamp()} Success: ${ctx.message} (Verdict: ${ctx.verdict}, Path: ${ctx.lastAuditPath})`);
      } else {
        console.log(`${timestamp()} Loop terminated: ${ctx.message} (Verdict: ${ctx.verdict})`);
      }
      for (const detail of ctx.details ?? []) console.log(`  ${detail}`);
    },
    attachLiveRegion: () => {},
    detachLiveRegion: () => {}
  };
}
