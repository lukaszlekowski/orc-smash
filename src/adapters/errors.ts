import type { RunResult } from './types.js';
import { boundedTail } from './utils.js';

export interface MessageContext {
  label: string;
  model: string;
  agent: string;
}

/**
 * opencode-specific remediation text, keyed by error kind. Data-driven so the
 * shared branches below stay provider-neutral — only opencode has verified
 * provider remediation wording in Batch 1 (codex/claude use the generic path).
 */
const OPENCODE_HINTS: Partial<Record<string, (ctx: MessageContext, msg: string, refStr: string, ms: string | number) => string>> = {
  'server': (ctx, msg, refStr) =>
    `opencode rejected model '${ctx.model}': ${msg}${refStr}. Verify with \`opencode models\`; set OPENCODE_DEFAULT_MODEL or use --model.`,
  'unknown-model': (ctx, msg, refStr) =>
    `opencode rejected model '${ctx.model}': ${msg}${refStr}. Verify with \`opencode models\`; set OPENCODE_DEFAULT_MODEL or use --model.`,
  'auth': (_ctx, msg, refStr) =>
    `opencode provider/credential error: ${msg}${refStr}. Run \`opencode providers list\`.`,
  'config': (_ctx, msg, refStr) =>
    `opencode provider/credential error: ${msg}${refStr}. Run \`opencode providers list\`.`,
  'timeout': (_ctx, _msg, _refStr, ms) =>
    `opencode run timed out after ${ms}ms (network/gateway stall?). Verify the model/provider with \`opencode models\`.`,
  'spawn': (_ctx, msg) =>
    `opencode failed to start: is the 'opencode' CLI installed and on PATH? (${msg})`
};

/**
 * Format a structured adapter error for the operator. Context now carries the
 * agent/provider identity so shared failure paths (spawn, nonzero-exit, generic
 * auth/config/timeout/server) name the correct provider instead of always saying
 * "opencode". opencode keeps its provider-specific remediation text; every other
 * provider gets the pinned generic wording below.
 */
export function structuredMessage(result: RunResult, ctx: MessageContext): string {
  const { label, agent } = ctx;
  const error = result.error;
  const exitCode = result.exitCode;

  const stderrTail = boundedTail(result.stderr);

  if (error) {
    const msg = error.message || '';
    const refStr = error.ref ? ` (ref ${error.ref})` : '';
    const kind = error.kind;
    const rawObj = error.raw as Record<string, any> | undefined;
    const ms = rawObj?.timeoutMs ?? '?';

    // opencode: provider-specific remediation text (data-driven hints).
    if (agent === 'opencode') {
      const hint = OPENCODE_HINTS[kind];
      if (hint) {
        return hint(ctx, msg, refStr, ms);
      }
    }

    // Generic, provider-neutral wording — codex/claude/fake and any unmapped kind.
    switch (kind) {
      case 'auth':
        return `${agent} provider/credential error: ${msg}${refStr}`;
      case 'config':
        return `${agent} configuration error: ${msg}${refStr}`;
      case 'timeout':
        return `${agent} timed out after ${ms}ms`;
      case 'server':
      case 'unknown-model':
        return `${agent} execution error: ${msg}${refStr}`;
      case 'spawn':
        return `${agent} failed to start: ${msg}`;
      case 'nonzero-exit':
        return `${label} exited with code ${exitCode}. stderr: ${stderrTail}`;
      default:
        return `${label} error (${kind}): ${msg}${refStr}`;
    }
  }

  return `${label} exited with code ${exitCode}. stderr: ${stderrTail}`;
}
