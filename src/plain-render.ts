import { formatDurationMs, formatSessionId, type PanelContext } from './status.js';
import { roleAccent, statusAccent, kindAccent, resultAccent, toResultState } from './terminal-accent.js';

export function resolveTerminalWidth(): number {
  const envColumns = process.env['COLUMNS'];
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (Number.isFinite(parsed) && parsed >= 40) {
      return parsed;
    }
  }
  if (typeof process.stdout.columns === 'number' && process.stdout.columns >= 40) {
    return process.stdout.columns;
  }
  return 80;
}

export function wrapField(label: string, value: string, width: number): string[] {
  const labelLine = `${label}: ${value}`;
  if (labelLine.length <= width) {
    return [labelLine];
  }
  const firstLine = `${label}:`;
  const valueIndent = ' '.repeat(label.length + 2);
  const lines: string[] = [firstLine];
  let remaining = value;
  while (remaining.length > 0) {
    const available = width - valueIndent.length;
    if (available <= 0) {
      lines.push(valueIndent + remaining);
      break;
    }
    const chunk = remaining.slice(0, available);
    lines.push(valueIndent + chunk);
    remaining = remaining.slice(available);
  }
  return lines;
}

/**
 * Render a plain normal-screen representation of PanelContext.
 * Utility renderer available for non-TTY or plain snapshot rendering.
 */
export function renderPlainPanel(context: PanelContext): string {
  const lines: string[] = [];
  const width = resolveTerminalWidth();

  lines.push('\u2500\u2500 orc-smash \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  lines.push(...wrapField('Loop', context.loopName, width));

  const iterValue = context.readOnly
    ? 'not running'
    : `${context.currentIteration}/${context.maxIterations}`;
  lines.push(...wrapField('Iteration', iterValue, width));

  const activeStr = context.activeSkillRunner
    ? `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} \u00b7 ${context.activeSkillRunner.model})`
    : 'None';
  lines.push(...wrapField('Active', activeStr, width));

  lines.push(...wrapField('Next', context.nextStepMessage, width));

  if (context.latestVersion > 0) {
    lines.push(...wrapField('Latest version', `v${context.latestVersion}`, width));
  }

  if (context.resolvedRunners && context.resolvedRunners.length > 0) {
    for (const runner of context.resolvedRunners) {
      const phaseLabel = runner.phase ? runner.phase.charAt(0).toUpperCase() + runner.phase.slice(1) : 'Skill';
      const roleStr = runner.role ? ` · ${runner.role}` : '';
      const effortStr = runner.effort ?? 'provider default';
      const stratStr = runner.sessionStrategy === 'resume-per-skill' ? 'resume per skill' : 'fresh per invocation';
      lines.push(...wrapField(`Runner [${phaseLabel}] (${runner.skillId}${roleStr})`, `${runner.agent} · ${runner.model} (${effortStr}) — ${stratStr}`, width));
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
    lines.push(...wrapField('Active invocation', `${active.skillId} v${active.version} — ${modeStr}`, width));
  }

  lines.push('Timeline:');

  if (context.timeline.length > 0) {
    for (let i = 0; i < context.timeline.length; i++) {
      const s = context.timeline[i]!;
      const kindAcc = kindAccent(s.kind);
      const roleAcc = roleAccent(s.role);

      const agentModel = `${s.agent} \u00b7 ${s.model}`;
      const headerLine = `\u2500\u2500 v${s.version} ${roleAcc.label} \u2500 ${agentModel}`;
      if (headerLine.length <= width) {
        lines.push(kindAcc.chalk(headerLine));
      } else {
        const prefix = `\u2500\u2500 v${s.version} ${roleAcc.label} \u2500`;
        lines.push(kindAcc.chalk(prefix));
        const indent = ' '.repeat(prefix.length + 1);
        let remaining = agentModel;
        while (remaining.length > 0) {
          const avail = width - indent.length;
          if (avail <= 0) {
            lines.push(kindAcc.chalk(indent + remaining));
            break;
          }
          lines.push(kindAcc.chalk(indent + remaining.slice(0, avail)));
          remaining = remaining.slice(avail);
        }
      }

      const timestamp = new Date(s.mtime).toISOString().slice(0, 19).replace('T', ' ');

      const rawRes = s.status === 'interrupted'
        ? '—'
        : (s.decision ?? s.completionOutcome ?? s.verdict ?? s.outcome ?? 'unknown');
      const resultText = s.status === 'interrupted'
        ? '—'
        : resultAccent(toResultState(rawRes))(rawRes);
      const statusAcc = statusAccent(s.status);
      const statusStr = statusAcc.chalk(statusAcc.label);

      const plainDetailLine = `   ${timestamp}  result: ${rawRes}   time: ${formatDurationMs(s.durationMs)}   session: ${formatSessionId(s.sessionId)}   status: ${statusAcc.label}`;
      if (plainDetailLine.length <= width) {
        lines.push(`   ${timestamp}  result: ${resultText}   time: ${formatDurationMs(s.durationMs)}   session: ${formatSessionId(s.sessionId)}   status: ${statusStr}`);
      } else {
        lines.push(`   ${timestamp}`);
        lines.push(`   result: ${resultText}`);
        lines.push(`   time: ${formatDurationMs(s.durationMs)}`);
        lines.push(`   session: ${formatSessionId(s.sessionId)}`);
        lines.push(`   status: ${statusStr}`);
      }

      if (i < context.timeline.length - 1) {
        lines.push('---');
      }
    }
  }

  return lines.join('\n');
}
