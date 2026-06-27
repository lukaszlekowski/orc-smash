import type { RunResult } from './types.js';

export function structuredMessage(result: RunResult, ctx: { label: string; model: string }): string {
  const model = ctx.model;
  const label = ctx.label;
  const error = result.error;
  const exitCode = result.exitCode;

  const getBoundedTail = (text?: string | null): string => {
    if (!text) return '';
    return text.length > 4000 ? text.slice(-4000) : text;
  };

  const stderrTail = getBoundedTail(result.stderr);

  if (error) {
    const msg = error.message || '';
    const refStr = error.ref ? ` (ref ${error.ref})` : '';

    switch (error.kind) {
      case 'server':
      case 'unknown-model':
        return `opencode rejected model '${model}': ${msg}${refStr}. Verify with \`opencode models\`; set OPENCODE_DEFAULT_MODEL or use --model.`;

      case 'auth':
      case 'config':
        return `opencode provider/credential error: ${msg}${refStr}. Run \`opencode providers list\`.`;

      case 'timeout': {
        const rawObj = error.raw as Record<string, any> | undefined;
        const ms = rawObj?.timeoutMs ?? '?';
        return `opencode run timed out after ${ms}ms (network/gateway stall?). Verify the model/provider with \`opencode models\`.`;
      }

      case 'spawn':
        return `opencode failed to start: is the 'opencode' CLI installed and on PATH? (${msg})`;

      case 'nonzero-exit':
        return `${label} exited with code ${exitCode}. stderr: ${stderrTail}`;

      default:
        return `${label} error (${error.kind}): ${msg}${refStr}`;
    }
  }

  return `${label} exited with code ${exitCode}. stderr: ${stderrTail}`;
}
