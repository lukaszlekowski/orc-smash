import type { RunEvent } from './run-event.js';

function fmtTime(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function level(event: RunEvent): string {
  switch (event.type) {
    case 'config.failed':
    case 'runner.rejected':
    case 'artifact.missing':
    case 'verdict.unknown':
    case 'provider.failed':
    case 'ownership.lost':
    case 'run.failed':
    case 'run.interrupted':
    case 'error':
      return 'FAIL';
    case 'warning':
      return 'WARN';
    case 'artifact.verified':
    case 'implementation.ledger-validated':
    case 'run.completed':
      return 'PASS';
    default:
      return 'INFO';
  }
}

function quote(s: string): string {
  if (/[\s"\\\x00-\x1f]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
  }
  return s;
}

function fmtEvent(event: RunEvent): string {
  const ts = fmtTime(event.atMs);
  const lvl = level(event);

  switch (event.type) {
    case 'run.started':
      return `${ts} ${lvl} run.started`;
    case 'config.loaded':
      return `${ts} ${lvl} config.loaded path=${quote(event.path)}`;
    case 'config.failed':
      return `${ts} ${lvl} config.failed message=${quote(event.message)}`;
    case 'loop.selected':
      return `${ts} ${lvl} loop.selected loop=${quote(event.loopName)}`;
    case 'runner.resolved': {
      let line = `${ts} ${lvl} runner.resolved skillId=${quote(event.skillId)} agent=${quote(event.agent)} model=${quote(event.model)} agentSource=${event.agentSource} modelSource=${event.modelSource}`;
      if (event.inheritedSession) {
        line += ` inheritedSession=${quote(`${event.inheritedSession.agent}/${event.inheritedSession.model}/${event.inheritedSession.sessionId}`)}`;
      }
      return line;
    }
    case 'runner.rejected':
      return `${ts} ${lvl} runner.rejected skillId=${quote(event.skillId)} message=${quote(event.message)}`;
    case 'state.scanned':
      return `${ts} ${lvl} state.scanned latestVerdict=${event.latestVerdict} version=${event.version}`;
    case 'iteration.started':
      return `${ts} ${lvl} iteration.started iteration=${event.iteration} maxIterations=${event.maxIterations}`;
    case 'step.started':
      return `${ts} ${lvl} step.started kind=${event.kind} skillId=${quote(event.skillId)} agent=${quote(event.agent)} model=${quote(event.model)} version=${event.version} message=${quote(event.message)}`;
    case 'provider.started':
      return `${ts} ${lvl} provider.started agent=${quote(event.agent)}`;
    case 'provider.progress':
      return `${ts} ${lvl} provider.progress agent=${quote(event.agent)} message=${quote(event.message)}`;
    case 'provider.completed':
      return `${ts} ${lvl} provider.completed agent=${quote(event.agent)} toolCalls=${event.toolCalls} progressEmitted=${event.progressEmitted} progressSuppressed=${event.progressSuppressed}`;
    case 'provider.failed':
      return `${ts} ${lvl} provider.failed agent=${quote(event.agent)}${event.errorKind ? ` errorKind=${event.errorKind}` : ''} toolCalls=${event.toolCalls} progressEmitted=${event.progressEmitted} progressSuppressed=${event.progressSuppressed}`;
    case 'artifact.verified':
      return `${ts} ${lvl} artifact.verified path=${quote(event.path)}${event.verdict ? ` verdict=${event.verdict}` : ''}`;
    case 'artifact.missing':
      return `${ts} ${lvl} artifact.missing path=${quote(event.path)} reason=${quote(event.reason)}`;
    case 'verdict.parsed':
      return `${ts} ${lvl} verdict.parsed verdict=${event.verdict}`;
    case 'verdict.unknown':
      return `${ts} ${lvl} verdict.unknown path=${quote(event.path)}`;
    case 'follow-up.outcome':
      return `${ts} ${lvl} follow-up.outcome outcome=${event.outcome}`;
    case 'stage.action':
      return `${ts} ${lvl} stage.action action=${event.action} phase=${event.phase}`;
    case 'implementation.ledger-validated':
      return `${ts} ${lvl} implementation.ledger-validated isComplete=${event.isComplete}`;
    case 'plan.closeout':
      return `${ts} ${lvl} plan.closeout status=${event.status}`;
    case 'ownership.opened':
      return `${ts} ${lvl} ownership.opened projectRoot=${quote(event.projectRoot)}`;
    case 'ownership.finalized':
      return `${ts} ${lvl} ownership.finalized success=${event.success}`;
    case 'ownership.lost':
      return `${ts} ${lvl} ownership.lost${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'run.interrupted':
      return `${ts} ${lvl} run.interrupted${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'run.completed':
      return `${ts} ${lvl} run.completed verdict=${event.verdict} outcome=${quote(event.outcome)}`;
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
