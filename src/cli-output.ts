import type { PanelContext } from './status.js';
import { renderStatusPanel } from './status-panel.js';
import ora, { Ora } from 'ora';
import type { StepKind } from './provenance.js';
import { debugHarnessEvent } from './debug-spawn.js';
import { makeRunEvent, type RunEvent, type RunEventInput, type RunEventSink } from './run-event.js';
import { renderRunEvent } from './plain-event-renderer.js';
import { EventWriter } from './event-writer.js';
import { resultAccent, emphasisAccent } from './terminal-accent.js';

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

export interface CliOutput extends RunEventSink {
  emit(event: RunEvent): void;
  flush(): Promise<void>;
  note(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  iterationStarted(ctx: { iteration: number; maxIterations: number }): void;
  stepStarted(ctx: {
    kind: StepKind;
    skillId: string;
    agent: string;
    model: string;
    effort?: string;
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
    verdict: string | null;
    message: string;
    lastAuditPath: string | null;
    details?: string[];
  }): void;
  writeStatic(text: string): void;
  attachLiveRegion?(supplier: () => PanelContext): void;
  detachLiveRegion?(): void;
}

export function createPanelCliOutput(projectRoot?: string): CliOutput {
  const cwd = projectRoot ?? process.cwd();
  let spinner: Ora | null = null;
  let altScreenActive = false;
  let liveInterval: ReturnType<typeof setInterval> | null = null;
  let liveActive = false;
  let liveSupplier: (() => PanelContext) | null = null;
  const pendingFailures: string[] = [];
  const eventLog: string[] = [];
  let _fatalWriter: Error | null = null;

  const ensureAltScreen = () => {
    if (altScreenActive) return;
    process.stdout.write(ENTER_ALT_SCREEN);
    altScreenActive = true;
  };

  const restoreMainScreen = () => {
    if (!altScreenActive) return;
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

  const emit = (event: RunEvent): void => {
    if (_fatalWriter) return;
    eventLog.push(renderRunEvent(event));
  };
  const emitEvent = (event: RunEventInput): void => emit(makeRunEvent(event));

  const flush = async (): Promise<void> => {
    if (_fatalWriter) throw _fatalWriter;
  };

  return {
    emit,
    flush,
    note(message: string) {
      debugHarnessEvent({ cwd, category: 'info', event: 'note', detail: message, result: 'info' });
      emitEvent({ type: 'note', atMs: Date.now(), message });
      console.log(emphasisAccent('supporting')(message));
    },
    warn(message: string) {
      debugHarnessEvent({ cwd, category: 'info', event: 'warn', detail: message, result: 'info' });
      emitEvent({ type: 'warning', atMs: Date.now(), message });
      console.warn(emphasisAccent('warning')(`Warning: ${message}`));
    },
    error(message: string) {
      const line = `Error: ${message}`;
      debugHarnessEvent({ cwd, category: 'lifecycle', event: 'error', detail: message, result: 'fail' });
      emitEvent({ type: 'error', atMs: Date.now(), message });
      if (liveActive) {
        pendingFailures.push(line);
      } else {
        console.error(resultAccent('failed')(`${timestamp()} ${line}`));
      }
    },
    iterationStarted(ctx: { iteration: number; maxIterations: number }) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: 'iteration-started', detail: `${ctx.iteration}/${ctx.maxIterations}`, result: 'info' });
      emitEvent({ type: 'iteration.started', atMs: Date.now(), iteration: ctx.iteration, maxIterations: ctx.maxIterations });
    },
    stepStarted(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-started:${ctx.kind}`, detail: `v${ctx.version} agent=${ctx.agent} model=${ctx.model} effort=${ctx.effort ?? 'none'} ${ctx.message}`, result: 'info' });
      emitEvent({
        type: 'step.started', atMs: Date.now(),
        kind: ctx.kind, skillId: ctx.skillId, agent: ctx.agent, model: ctx.model,
        effort: ctx.effort,
        version: ctx.version, message: ctx.message
      });
      if (liveActive) return;
      if (spinner) spinner.stop();
      spinner = ora(emphasisAccent('binding-identity')(ctx.message)).start();
    },
    stepSucceeded(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-succeeded:${ctx.kind}`, detail: `v${ctx.version} ${ctx.message}`, result: 'pass' });
      if (liveActive) {
        console.log(resultAccent('completed')(ctx.message));
        return;
      }
      if (spinner) {
        spinner.succeed(resultAccent('completed')(ctx.message));
        spinner = null;
      } else {
        console.log(resultAccent('completed')(ctx.message));
      }
    },
    stepFailed(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-failed:${ctx.kind}`, detail: `v${ctx.version} errorKind=${ctx.errorKind ?? 'unknown'} ${ctx.message}`, result: 'fail' });
      if (liveActive) {
        pendingFailures.push(ctx.message);
        return;
      }
      if (spinner) {
        spinner.fail(resultAccent('failed')(`${timestamp()} ${ctx.message}`));
        spinner = null;
      } else {
        console.error(resultAccent('failed')(`${timestamp()} ${ctx.message}`));
      }
    },
    renderPanel(context: PanelContext) {
      panelDraw(context);
    },
    finalSummary(ctx) {
      detach();
      restoreMainScreen();
      debugHarnessEvent({ cwd, category: 'lifecycle', event: ctx.success ? 'loop-success' : 'loop-failed', detail: `verdict=${ctx.verdict} ${ctx.message}`, result: ctx.success ? 'pass' : 'fail' });
      for (const failure of pendingFailures) {
        console.error(resultAccent('failed')(`${timestamp()} ${failure}`));
      }
      pendingFailures.length = 0;

      if (eventLog.length > 0) {
        console.log(emphasisAccent('binding-identity')('\n── Harness Event Log ──'));
        for (const line of eventLog) {
          console.log(emphasisAccent('supporting')(line));
        }
        eventLog.length = 0;
      }

      if (ctx.success) {
        console.log(resultAccent('completed')(`\n${timestamp()} Success: ${ctx.message}`));
      } else {
        console.log(resultAccent('failed')(`\n${timestamp()} Loop terminated: ${ctx.message}`));
      }
      if (ctx.details && ctx.details.length > 0) {
        console.log(emphasisAccent('binding-identity')('Current project snapshot:'));
        for (const detail of ctx.details) console.log(emphasisAccent('supporting')(`  ${detail}`));
      }
    },
    writeStatic(text: string) {
      detach();
      restoreMainScreen();
      process.stdout.write(`${text}\n`);
    },
    attachLiveRegion(supplier: () => PanelContext) {
      if (liveInterval) {
        clearInterval(liveInterval);
        liveInterval = null;
      }
      if (spinner) {
        spinner.stop();
      }
      spinner = null;
      liveSupplier = supplier;
      liveActive = true;
      ensureAltScreen();
      liveInterval = setInterval(() => {
        process.stdout.write(CURSOR_HOME_CLEAR + renderStatusPanel(supplier()) + '\n');
      }, PANEL_RENDER_INTERVAL_MS);
      liveInterval.unref();
    },
    detachLiveRegion() {
      detach();
    }
  };
}

export function createPlainCliOutput(projectRoot?: string): CliOutput {
  const cwd = projectRoot ?? process.cwd();
  const writer = new EventWriter(process.stdout);

  const emit = (event: RunEvent): void => {
    const line = renderRunEvent(event);
    writer.write(event, line);
  };
  const emitEvent = (event: RunEventInput): void => emit(makeRunEvent(event));

  const flush = async (): Promise<void> => {
    await writer.flush();
  };

  return {
    emit,
    flush,
    note(message: string) {
      debugHarnessEvent({ cwd, category: 'info', event: 'note', detail: message, result: 'info' });
      emitEvent({ type: 'note', atMs: Date.now(), message });
    },
    warn(message: string) {
      debugHarnessEvent({ cwd, category: 'info', event: 'warn', detail: message, result: 'info' });
      emitEvent({ type: 'warning', atMs: Date.now(), message });
    },
    error(message: string) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: 'error', detail: message, result: 'fail' });
      emitEvent({ type: 'error', atMs: Date.now(), message });
    },
    iterationStarted(ctx: { iteration: number; maxIterations: number }) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: 'iteration-started', detail: `${ctx.iteration}/${ctx.maxIterations}`, result: 'info' });
      emitEvent({ type: 'iteration.started', atMs: Date.now(), iteration: ctx.iteration, maxIterations: ctx.maxIterations });
    },
    stepStarted(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-started:${ctx.kind}`, detail: `v${ctx.version} agent=${ctx.agent} model=${ctx.model} ${ctx.message}`, result: 'info' });
      emitEvent({
        type: 'step.started', atMs: Date.now(),
        kind: ctx.kind, skillId: ctx.skillId, agent: ctx.agent, model: ctx.model,
        version: ctx.version, message: ctx.message
      });
    },
    stepSucceeded(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-succeeded:${ctx.kind}`, detail: `v${ctx.version} ${ctx.message}`, result: 'pass' });
      emitEvent({ type: 'note', atMs: Date.now(), message: `${ctx.kind} v${ctx.version} completed: ${ctx.message}` });
    },
    stepFailed(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: `step-failed:${ctx.kind}`, detail: `v${ctx.version} errorKind=${ctx.errorKind ?? 'unknown'} ${ctx.message}`, result: 'fail' });
      emitEvent({ type: 'error', atMs: Date.now(), message: `${ctx.kind} v${ctx.version}: ${ctx.message}` });
    },
    renderPanel(_context: PanelContext) {
      // Plain mode: panel snapshots are replaced by chronological events. No-op.
    },
    finalSummary(ctx) {
      debugHarnessEvent({ cwd, category: 'lifecycle', event: ctx.success ? 'loop-success' : 'loop-failed', detail: `verdict=${ctx.verdict} ${ctx.message}`, result: ctx.success ? 'pass' : 'fail' });
    },
    writeStatic(text: string) {
      process.stdout.write(`${text}\n`);
    },
    attachLiveRegion: () => {},
    detachLiveRegion: () => {}
  };
}
