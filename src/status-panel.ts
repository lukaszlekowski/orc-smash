import boxen from 'boxen';
import Table from 'cli-table3';
import { formatCompactId, formatDurationMs, formatModelDisplay, formatSessionId, type PanelContext, type ResolvedRunnerDisplay } from './status.js';
import { resolveTerminalWidth } from './plain-render.js';
import { formatToolCalls } from './run-event.js';
import { roleAccent, resultAccent, toResultState } from './terminal-accent.js';
import { resolveBorderColor, resolveStyle } from './theme.js';
import type { TimelineRow } from './timeline-rows.js';
import type { Step } from './state.js';

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const panelStyle = (token: string) => resolveStyle(token, 'status-panel');

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

/**
 * Widest visible cell in each column across the header and all rows. ANSI color
 * codes are stripped via `strippedWidth` so pre-colored row cells are measured
 * by their visible width (header cells are plain, so it is a no-op there). The
 * column count is derived from `head` (or the first row when there is no head),
 * so the empty-head / empty-row table shapes work.
 */
function measureColumnWidths(head: string[], rows: string[][]): number[] {
  const colCount = head.length || (rows[0]?.length ?? 0);
  const widths = new Array<number>(colCount).fill(0);
  for (let index = 0; index < colCount; index += 1) {
    let width = strippedWidth(head[index] ?? '');
    for (const row of rows) {
      width = Math.max(width, strippedWidth(row[index] ?? ''));
    }
    widths[index] = width;
  }
  return widths;
}

/**
 * Content-aware column widths. Each column is sized to its measured content,
 * clamped to `[minimum, preferred]` — so a header never clips and an over-long
 * cell stops at `preferred` (cli-table3 truncates the rest) — then the whole set
 * is shrunk to fit `available`, which is what keeps a row from exceeding the
 * panel. Unlike the old fixed layout, columns do not stretch to fill the
 * terminal: a sparse column (e.g. an empty `Result`) collapses to its minimum
 * instead of absorbing the slack.
 */
function fitColumnWidths(content: number[], preferred: number[], minimum: number[], available: number): number[] {
  const maxSum = Math.max(0, available - Math.max(0, preferred.length - 1));
  const widths = content.map((value, index) => {
    const lo = minimum[index] ?? value;
    const hi = preferred[index] ?? value;
    return Math.min(Math.max(value, lo), hi);
  });
  while (widths.reduce((sum, width) => sum + width, 0) > maxSum) {
    const largest = widths.reduce((candidate, width, index) =>
      width > (widths[candidate] ?? 0) && width > 3 ? index : candidate, 0);
    if (widths[largest]! <= 3) break;
    widths[largest] = widths[largest]! - 1;
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
  const colWidths = fitColumnWidths(measureColumnWidths(head, rows), preferred, minimum, panelInnerWidth);
  // cli-table3 pads a styled head cell *before* wrapping it in the head style,
  // so the padding of a `head: ['cyan']` header lives inside the SGR wrap.
  // Pre-padding the header text inside the `panel.column_header` wrap
  // reproduces that byte layout exactly (AC4 / Gate A byte-identity).
  const styledHead = head.map((cell, index) => {
    const width = colWidths[index] ?? cell.length;
    return panelStyle('panel.column_header')(cell.padEnd(width));
  });
  const table = new Table({
    head: styledHead,
    colWidths,
    style: { head: [], border: [], 'padding-left': 0, 'padding-right': 0 },
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
      head: styledHead,
      colWidths: emergencyWidths,
      style: { head: [], border: [], 'padding-left': 0, 'padding-right': 0 },
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
  const pName = panelStyle('emphasis.identity')(context.projectRoot);
  const lName = panelStyle('emphasis.binding-identity')(context.loopName);
  const panelTitle = resolveTerminalWidth() < 60
    ? ' ORC SMASH STATUS PANEL '
    : panelStyle('emphasis.identity')(' ORC SMASH STATUS PANEL ');

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
    activeStr = panelStyle('emphasis.identity')(
      `${context.activeSkillRunner.skillId} (${context.activeSkillRunner.agent} · ${context.activeSkillRunner.model})`
    );
  }

  const contentLines: string[] = [
    `Project:          ${pName}`,
    `Loop:             ${lName}`,
    `${iterationLabel}:        ${panelStyle('emphasis.supporting')(iterationValue)}`,
    `Active Runner:    ${activeStr}`,
    `Next Step:        ${panelStyle('emphasis.identity')(context.nextStepMessage)}`,
    `Latest version:   v${context.latestVersion}`
  ];

  if (context.resolvedRunners && context.resolvedRunners.length > 0) {
    contentLines.push('');
    contentLines.push(panelStyle('emphasis.identity')('Run configuration'));
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
    contentLines.push(panelStyle('emphasis.identity')('Active invocation'));
    contentLines.push(`  ${active.skillId} v${active.version} — ${modeStr}`);
  }

  const timelineSection = renderTimelineSection(context);
  contentLines.push('');
  contentLines.push(panelStyle('emphasis.identity')('Timeline:'));
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
    borderColor: resolveBorderColor(context, 'status-panel')
  });
}

function renderInFlightSection(context: PanelContext): string | null {
  if (!context.inFlight) return null;

  // Elapsed since the spawn started; the renderer reads the closed-over
  // `startedAtMs` at paint time so the displayed elapsed grows monotonically
  // across 1s ticks.
  const elapsedStr = formatDurationMs(Date.now() - context.inFlight.startedAtMs);

  const detailLines = [
    `${panelStyle('emphasis.identity')('Active Step:')} ${panelStyle('emphasis.supporting')(`(elapsed ${elapsedStr})`)}`,
    `Role:             ${roleAccent(context.inFlight.role, 'status-panel').chalk(context.inFlight.role)}`,
    `Spawn:            ${panelStyle('emphasis.identity')(context.inFlight.spawnLabel)}`
  ];

  if (context.inFlight.progressCapability === 'unavailable') {
    detailLines.push('Live progress unavailable for this provider');
  } else {
    if (context.inFlight.toolCallCount > 0) {
      detailLines.push(`Tool calls:       ${panelStyle('emphasis.identity')(formatToolCalls(context.inFlight.toolCallCount))}`);
    }

    if (context.inFlight.progressMessage) {
      detailLines.push(`Progress:         ${panelStyle('emphasis.identity')(context.inFlight.progressMessage)}`);
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
        : resultAccent(toResultState(result), 'status-panel')(display);
    }
  }
  if (marked) resultStr += ` ${panelStyle('emphasis.supporting')('*')}`;

  const isDimmed = row.relevance === 'unrelated' || row.relevance === 'unclassified';
  const roleCell = isDimmed ? s.role : roleAccent(s.role, 'status-panel').chalk(s.role);
  const statusStr = row.relevance === 'unclassified'
    ? 'unclassified'
    : isDimmed
      ? s.status
      : panelStyle(`status.${s.status}`)(s.status);
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
  return isDimmed ? cells.map(cell => panelStyle('panel.dim_row')(cell)) : cells;
}

function inFlightCells(context: PanelContext): string[] {
  const active = context.inFlight!;
  return [
    String(active.version),
    roleAccent(active.role, 'status-panel').chalk(active.role),
    active.agent,
    formatModelDisplay(active.model),
    active.effort ?? 'provider default',
    '—',
    formatDurationMs(Date.now() - active.startedAtMs),
    '—',
    panelStyle(`status.${active.status}`)(active.status),
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
    return `${rowText}\n  ${panelStyle('panel.dim_row')(identity)}`;
  });
  return [table, ...rowBlocks].join('\n');
}
