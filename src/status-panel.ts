import boxen from 'boxen';
import Table from 'cli-table3';
import chalk from 'chalk';
import { formatCompactId, formatDurationMs, formatModelDisplay, formatSessionId, type PanelContext, type ResolvedRunnerDisplay } from './status.js';
import { resolveTerminalWidth } from './plain-render.js';
import { formatToolCalls } from './run-event.js';
import { roleAccent, statusAccent, panelBorderColor, resultAccent, toResultState, emphasisAccent } from './terminal-accent.js';
import type { TimelineRow } from './timeline-rows.js';
import type { Step } from './state.js';

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function strippedWidth(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

function maxLineWidth(text: string): number {
  return Math.max(0, ...text.split('\n').map(strippedWidth));
}

/**
 * Usable content width inside the boxen status panel. boxen's chrome (round
 * border + `padding: 1`) consumes 8 columns of the terminal width — not the 4
 * you'd expect from "2 border + 2 padding": a 122-char line already wraps inside
 * a width-129 box. Sizing tables to this value keeps a filled final column (e.g.
 * `Status` = `unclassifi…`) from word-wrapping onto a new line.
 */
function boxInnerWidth(): number {
  return Math.max(1, resolveTerminalWidth() - 8);
}

function tableChars(): Record<string, string> {
  return {
    top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
    bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
    left: '', 'left-mid': '', mid: '', 'mid-mid': '',
    right: '', 'right-mid': '', middle: ' '
  };
}

function fitColumnWidths(preferred: number[], minimum: number[], available: number): number[] {
  const maxSum = Math.max(0, available - Math.max(0, preferred.length - 1));
  const widths = minimum.map((value, index) => Math.min(value, preferred[index] ?? value));
  while (widths.reduce((sum, width) => sum + width, 0) > maxSum) {
    const largest = widths.reduce((candidate, width, index) =>
      width > (widths[candidate] ?? 0) && width > 3 ? index : candidate, 0);
    if (widths[largest]! <= 3) break;
    widths[largest] = widths[largest]! - 1;
  }
  let remaining = Math.max(0, maxSum - widths.reduce((sum, width) => sum + width, 0));

  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < widths.length && remaining > 0; index += 1) {
      const target = preferred[index] ?? widths[index]!;
      if (widths[index]! < target) {
        widths[index] = widths[index]! + 1;
        remaining -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return widths;
}

function renderAlignedTable(
  head: string[],
  rows: string[][],
  preferred: number[],
  minimum: number[],
): string {
  const panelInnerWidth = boxInnerWidth();
  const colWidths = fitColumnWidths(preferred, minimum, panelInnerWidth);
  const table = new Table({
    head,
    colWidths,
    style: { head: ['cyan'], border: [], 'padding-left': 0, 'padding-right': 0 },
    chars: tableChars(),
    wordWrap: false,
  });
  for (const row of rows) table.push(row);

  // cli-table3 accounts for cell padding and stripped separators in the
  // rendered width. Keep this defensive bound in case a future dependency
  // version changes that accounting.
  let rendered = table.toString();
  if (maxLineWidth(rendered) > panelInnerWidth) {
    const emergencyWidths = colWidths.map(width => Math.max(3, width - 1));
    const emergency = new Table({
      head,
      colWidths: emergencyWidths,
      style: { head: ['cyan'], border: [], 'padding-left': 0, 'padding-right': 0 },
      chars: tableChars(),
      wordWrap: false,
    });
    for (const row of rows) emergency.push(row);
    rendered = emergency.toString();
  }
  return rendered;
}

function renderRunConfiguration(runners: ResolvedRunnerDisplay[]): string {
  const rows = runners.map(runner => [
    runner.phase.charAt(0).toUpperCase() + runner.phase.slice(1),
    runner.skillId,
    runner.role,
    runner.agent,
    formatModelDisplay(runner.model),
    runner.effort ?? 'provider default',
    runner.sessionStrategy === 'resume-per-skill' ? 'resume per skill' : 'fresh per invocation',
  ]);
  return renderAlignedTable(
    ['Phase', 'Skill', 'Role', 'Provider', 'Model', 'Effort', 'Session'],
    rows,
    [9, 16, 11, 8, 17, 8, 7],
    [5, 5, 4, 8, 5, 6, 7],
  );
}

export function renderStatusPanel(context: PanelContext): string {
  const pName = emphasisAccent('identity')(context.projectRoot);
  const lName = emphasisAccent('binding-identity')(context.loopName);
  const panelTitle = resolveTerminalWidth() < 60
    ? ' ORC SMASH STATUS PANEL '
    : emphasisAccent('identity')(' ORC SMASH STATUS PANEL ');

  const iterationLabel = context.bindingKind === 'task' ? 'Execution' : 'Iteration';
  const iterationValue = context.readOnly
    ? 'not running'
    : context.bindingKind === 'task'
      ? context.providerCalls !== undefined
        ? `Single task - provider calls ${context.providerCalls}`
        : 'Single task'
      : context.providerCalls !== undefined
        ? `Round ${context.currentIteration}/${context.maxIterations} - provider calls ${context.providerCalls}`
        : `${context.currentIteration}/${context.maxIterations}`;

  let activeStr = 'None';
  if (context.activeSkillRunner) {
    activeStr = emphasisAccent('identity')(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  const contentLines: string[] = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `${iterationLabel}:        ${emphasisAccent('supporting')(iterationValue)}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${emphasisAccent('identity')(context.nextStepMessage)}`,
    `Latest version:   v${context.latestVersion}`
  ];

  if (context.resolvedRunners && context.resolvedRunners.length > 0) {
    contentLines.push('');
    contentLines.push(emphasisAccent('identity')('Run configuration'));
    contentLines.push(renderRunConfiguration(context.resolvedRunners));
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
    contentLines.push('');
    contentLines.push(emphasisAccent('identity')('Active invocation'));
    contentLines.push(`  ${active.skillId} v${active.version} — ${modeStr}`);
  }

  const timelineSection = renderTimelineSection(context);
  contentLines.push('');
  contentLines.push(emphasisAccent('identity')('Timeline:'));
  contentLines.push(timelineSection);

  const inFlightSection = renderInFlightSection(context);
  if (inFlightSection) {
    contentLines.push('');
    contentLines.push(inFlightSection);
  }

  return boxen(contentLines.join('\n'), {
    width: resolveTerminalWidth(),
    title: panelTitle,
    titleAlignment: 'center',
    padding: 1,
    margin: 0,
    borderStyle: 'round',
    borderColor: panelBorderColor(context)
  });
}

function renderInFlightSection(context: PanelContext): string | null {
  if (!context.inFlight) return null;

  // Elapsed since the spawn started; the renderer reads the closed-over
  // `startedAtMs` at paint time so the displayed elapsed grows monotonically
  // across 1s ticks.
  const elapsedStr = formatDurationMs(Date.now() - context.inFlight.startedAtMs);

  const detailLines = [
    `${emphasisAccent('identity')('Active Step:')} ${emphasisAccent('supporting')(`(elapsed ${elapsedStr})`)}`,
    `Role:             ${roleAccent(context.inFlight.role).chalk(context.inFlight.role)}`,
    `Spawn:            ${emphasisAccent('identity')(context.inFlight.spawnLabel)}`
  ];

  if (context.inFlight.progressCapability === 'unavailable') {
    detailLines.push('Live progress unavailable for this provider');
  } else {
    if (context.inFlight.toolCallCount > 0) {
      detailLines.push(`Tool calls:       ${emphasisAccent('identity')(formatToolCalls(context.inFlight.toolCallCount))}`);
    }

    if (context.inFlight.progressMessage) {
      detailLines.push(`Progress:         ${emphasisAccent('identity')(context.inFlight.progressMessage)}`);
    }
  }

  return detailLines.join('\n');
}

function truncateUnclassifiedReason(reason: string | undefined): string {
  const value = reason || 'unclassified artifact';
  return value.length > 48 ? `${value.slice(0, 47)}…` : value;
}

function compactIdentityLine(
  artifactIdentity: string | null | undefined,
  parentArtifactIdentity: string | null | undefined,
  inputFingerprint: string | null | undefined,
  resultFingerprint: string | null | undefined,
): string {
  return `artifact ${formatCompactId(artifactIdentity)}  parent ${formatCompactId(parentArtifactIdentity)}  in ${formatCompactId(inputFingerprint)}  out ${formatCompactId(resultFingerprint)}`;
}

function diagnosticSuffix(step: Step): string {
  if (!step.contractDiagnostics || step.contractDiagnostics.length === 0) return '';
  const first = step.contractDiagnostics[0]?.message;
  if (!first) return '';
  const omitted = step.contractDiagnostics.filter(item => item.code === 'diagnostics-omitted').length;
  return ` — ${first}${omitted ? ' (additional diagnostics omitted)' : ''}`;
}

function timelineCells(row: TimelineRow, marked: boolean): string[] {
  const s = row.step;
  let resultStr = '';
  if (row.relevance === 'unclassified') {
    resultStr = truncateUnclassifiedReason(s.unclassifiedReason);
  } else if (s.status === 'interrupted') {
    resultStr = '—';
  } else {
    const result = s.decision ?? s.completionOutcome ?? s.verdict ?? s.outcome;
    if (result) {
      const display = result === 'blocked' ? `${result}${diagnosticSuffix(s)}` : result;
      resultStr = row.relevance === 'unrelated'
        ? display
        : resultAccent(toResultState(result))(display);
    }
  }
  if (marked) resultStr += ` ${emphasisAccent('supporting')('*')}`;

  const isDimmed = row.relevance === 'unrelated' || row.relevance === 'unclassified';
  const roleCell = isDimmed ? s.role : roleAccent(s.role).chalk(s.role);
  const statusStr = row.relevance === 'unclassified'
    ? 'unclassified'
    : isDimmed
      ? statusAccent(s.status).label
      : statusAccent(s.status).chalk(statusAccent(s.status).label);
  const cells = [
    String(s.version),
    roleCell,
    s.agent,
    formatModelDisplay(s.model),
    s.effort ?? 'provider default',
    resultStr,
    formatDurationMs(s.durationMs),
    formatSessionId(s.sessionId),
    statusStr,
    formatCompactId(s.artifactIdentity),
    formatCompactId(s.parentArtifactIdentity),
    formatCompactId(s.inputFingerprint),
    formatCompactId(s.resultFingerprint),
  ];
  return isDimmed ? cells.map(cell => chalk.dim(cell)) : cells;
}

function inFlightCells(context: PanelContext): string[] {
  const active = context.inFlight!;
  return [
    String(active.version),
    roleAccent(active.role).chalk(active.role),
    active.agent,
    formatModelDisplay(active.model),
    active.effort ?? 'provider default',
    '—',
    formatDurationMs(Date.now() - active.startedAtMs),
    '—',
    statusAccent(active.status).chalk(statusAccent(active.status).label),
    formatCompactId(active.artifactIdentity),
    formatCompactId(active.parentArtifactIdentity),
    formatCompactId(active.inputFingerprint),
    formatCompactId(active.resultFingerprint),
  ];
}

function renderTimelineSection(context: PanelContext): string {
  const rows: string[][] = [];
  let latestCurrentChain = -1;
  for (let index = 0; index < context.timeline.length; index += 1) {
    if (context.timeline[index]!.relevance === 'current-chain') latestCurrentChain = index;
  }
  context.timeline.forEach((row, index) => rows.push(timelineCells(row, index === latestCurrentChain)));
  if (context.inFlight) rows.push(inFlightCells(context));
  if (rows.length === 0) return '';

  const head = ['Ver', 'Role', 'Agent', 'Model', 'Effort', 'Result', 'Time', 'Session', 'Status', 'Artifact', 'Parent', 'Input FP', 'Result FP'];
  const preferred = [3, 11, 8, 17, 8, 48, 7, 7, 12, 10, 10, 10, 10];
  const minimum = [3, 4, 5, 5, 6, 6, 4, 7, 6, 8, 6, 8, 9];
  const coreHead = head.slice(0, 9);
  const corePreferred = preferred.slice(0, 9);
  const coreMinimum = minimum.slice(0, 9);
  const coreRows = rows.map(row => row.slice(0, 9));

  if (context.showFingerprints !== true) {
    return renderAlignedTable(coreHead, coreRows, corePreferred, coreMinimum);
  }

  const panelInnerWidth = boxInnerWidth();
  const minTableWidth = minimum.reduce((sum, width) => sum + width, 0) + head.length - 1;

  if (minTableWidth <= panelInnerWidth) {
    return renderAlignedTable(head, rows, preferred, minimum);
  }

  const table = renderAlignedTable(coreHead, [], corePreferred, coreMinimum);
  const rowBlocks = coreRows.map((row, index) => {
    const rowText = renderAlignedTable([], [row], corePreferred, coreMinimum);
    const historical = context.timeline[index];
    const identity = historical
      ? compactIdentityLine(
        historical.step.artifactIdentity,
        historical.step.parentArtifactIdentity,
        historical.step.inputFingerprint,
        historical.step.resultFingerprint,
      )
      : compactIdentityLine(
        context.inFlight?.artifactIdentity,
        context.inFlight?.parentArtifactIdentity,
        context.inFlight?.inputFingerprint,
        context.inFlight?.resultFingerprint,
      );
    return `${rowText}\n  ${chalk.dim(identity)}`;
  });
  return [table, ...rowBlocks].join('\n');
}
