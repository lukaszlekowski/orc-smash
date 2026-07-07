import { formatDurationMs, type PanelContext } from './status.js';
import { roleAccent, statusAccent, kindAccent } from './status-accent.js';

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

      let resultText = '';
      if (s.status === 'interrupted') {
        // No verdict/outcome for an interrupted step; the status line carries
        // the literal "interrupted" signal.
        resultText = '—';
      } else if (s.kind === 'audit') {
        resultText = s.verdict ?? 'unknown';
      } else {
        resultText = s.outcome ?? '';
      }

      const statusAcc = statusAccent(s.status);
      const detailLine = `   ${timestamp}  result: ${resultText}   time: ${formatDurationMs(s.durationMs)}   session: ${s.sessionId ?? '—'}   status: ${statusAcc.label}`;
      lines.push(detailLine);

      if (i < context.timeline.length - 1) {
        lines.push('---');
      }
    }
  }

  return lines.join('\n');
}
