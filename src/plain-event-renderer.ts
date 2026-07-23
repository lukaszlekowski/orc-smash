import type { RunEvent } from './run-event.js';
import { eventLevelAccent, type EventLevel } from './terminal-accent.js';

function fmtTime(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function level(event: RunEvent): EventLevel {
  switch (event.type) {
    case 'config.failed':
    case 'runner.rejected':
    case 'artifact.missing':
    case 'artifact.unknown':
    case 'decision.unknown':
    case 'provider.failed':
    case 'ownership.lost':
    case 'run.failed':
    case 'run.interrupted':
    case 'error':
      return 'FAIL';
    case 'warning':
      return 'WARN';
    case 'artifact.verified':
    case 'run.completed':
      return 'PASS';
    default:
      return 'INFO';
  }
}

function formatLevel(lvl: EventLevel): string {
  return eventLevelAccent(lvl)(lvl);
}

function quote(s: string): string {
  if (/[\s"\\\x00-\x1f]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
  }
  return s;
}

function fmtEvent(event: RunEvent): string {
  const ts = fmtTime(event.atMs);
  const lvl = formatLevel(level(event));

  switch (event.type) {
    case 'run.started':
      return `${ts} ${lvl} run.started`;
    case 'config.loaded':
      return `${ts} ${lvl} config.loaded path=${quote(event.path)}`;
    case 'config.failed':
      return `${ts} ${lvl} config.failed message=${quote(event.message)}`;
    case 'binding.selected':
      return `${ts} ${lvl} binding.selected binding=${quote(`${event.bindingKind}/${event.bindingId}`)}`;
    case 'runner.resolved': {
      let line = `${ts} ${lvl} runner.resolved skillId=${quote(event.skillId)} agent=${quote(event.agent)} model=${quote(event.model)} effort=${quote(event.effort ?? 'provider default')}${event.effortSource ? ` effortSource=${event.effortSource}` : ''} agentSource=${event.agentSource} modelSource=${event.modelSource}`;
      if (event.inheritedSession) {
        line += ` inheritedSession=${quote(`${event.inheritedSession.agent}/${event.inheritedSession.model}/${event.inheritedSession.sessionId}`)}`;
      }
      return line;
    }
    case 'runner.rejected':
      return `${ts} ${lvl} runner.rejected skillId=${quote(event.skillId)} message=${quote(event.message)}`;
    case 'state.scanned':
      return `${ts} ${lvl} state.scanned latestResult=${event.latestResult} version=${event.version}`;
    case 'iteration.started':
      return `${ts} ${lvl} iteration.started iteration=${event.iteration} maxIterations=${event.maxIterations}`;
    case 'step.started':
      return `${ts} ${lvl} step.started kind=${event.kind} skillId=${quote(event.skillId)} agent=${quote(event.agent)} model=${quote(event.model)} effort=${quote(event.effort ?? 'provider default')} version=${event.version} message=${quote(event.message)}`;
    case 'provider.started':
      return `${ts} ${lvl} provider.started agent=${quote(event.agent)}`;
    case 'provider.progress':
      return `${ts} ${lvl} provider.progress agent=${quote(event.agent)} message=${quote(event.message)}`;
    case 'provider.completed':
      return `${ts} ${lvl} provider.completed agent=${quote(event.agent)} toolCalls=${event.toolCalls} progressEmitted=${event.progressEmitted} progressSuppressed=${event.progressSuppressed}`;
    case 'provider.failed':
      return `${ts} ${lvl} provider.failed agent=${quote(event.agent)}${event.errorKind ? ` errorKind=${event.errorKind}` : ''} toolCalls=${event.toolCalls} progressEmitted=${event.progressEmitted} progressSuppressed=${event.progressSuppressed}`;
    case 'artifact.verified':
      return `${ts} ${lvl} artifact.verified path=${quote(event.path)}${event.result ? ` result=${event.result}` : ''}`;
    case 'artifact.missing':
      return `${ts} ${lvl} artifact.missing path=${quote(event.path)} reason=${quote(event.reason)}`;
    case 'artifact.unknown':
      return `${ts} ${lvl} artifact.unknown path=${quote(event.path)} reason=${quote(event.reason)}`;
    case 'input.missing':
      return `${ts} ${lvl} input.missing items=${event.missing.join(', ')}`;
    case 'decision.parsed':
      return `${ts} ${lvl} decision.parsed decision=${event.decision}`;
    case 'decision.unknown':
      return `${ts} ${lvl} decision.unknown path=${quote(event.path)}${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'completion.parsed':
      return `${ts} ${lvl} completion.parsed outcome=${event.outcome}`;
    case 'stage.completed':
      return `${ts} ${lvl} stage.completed binding=${quote(`${event.bindingKind}/${event.bindingId}`)}`;
    case 'stage.blocked':
      return `${ts} ${lvl} stage.blocked binding=${quote(`${event.bindingKind}/${event.bindingId}`)}`;
    case 'stage.incomplete':
      return `${ts} ${lvl} stage.incomplete binding=${quote(`${event.bindingKind}/${event.bindingId}`)} reason=${quote(event.reason)}`;
    case 'stage.action':
      return `${ts} ${lvl} stage.action action=${event.action} phase=${event.phase}`;
    case 'ownership.opened':
      return `${ts} ${lvl} ownership.opened projectRoot=${quote(event.projectRoot)}`;
    case 'ownership.finalized':
      return `${ts} ${lvl} ownership.finalized success=${event.success}`;
    case 'ownership.lost':
      return `${ts} ${lvl} ownership.lost${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'run.interrupted':
      return `${ts} ${lvl} run.interrupted${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'run.completed':
      return `${ts} ${lvl} run.completed result=${event.result} outcome=${quote(event.outcome)}`;
    case 'run.failed':
      return `${ts} ${lvl} run.failed reason=${quote(event.reason)}${event.errorKind ? ` errorKind=${event.errorKind}` : ''}`;
    case 'note':
      return `${ts} ${lvl} note message=${quote(event.message)}`;
    case 'warning':
      return `${ts} ${lvl} warning message=${quote(event.message)}`;
    case 'error':
      return `${ts} ${lvl} error message=${quote(event.message)}`;
  }
}

export function renderRunEvent(event: RunEvent): string {
  return fmtEvent(event);
}
