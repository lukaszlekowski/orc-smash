import type { ToolCall, RunError } from './types.js';

export interface OpencodeStreamError {
  name?: string;
  message?: string;
  ref?: string;
  data?: unknown;
}

export interface ParseResult {
  finalText: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
  // Kept for tests/diagnostics: the full ordered list of step_finish reasons.
  finishReasons: string[];
  // Kept for tests/diagnostics: aggregate token usage across step_finish events.
  tokenUsage?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
  streamError?: OpencodeStreamError;
  // Kept for tests/diagnostics: lines that failed to parse as JSON stream events.
  unparsed: string[];
}

export function parseOpencodeStream(raw: string): ParseResult {
  const result: ParseResult = {
    finalText: '',
    toolCalls: [],
    stopReason: null,
    finishReasons: [],
    unparsed: []
  };

  if (!raw) {
    return result;
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const ev = JSON.parse(trimmed);
      if (!ev || typeof ev !== 'object') {
        result.unparsed.push(trimmed);
        continue;
      }

      switch (ev.type) {
        case 'text':
          if (ev.part?.text) {
            result.finalText += ev.part.text;
          }
          break;
        case 'tool_use':
          if (ev.part) {
            result.toolCalls.push({
              tool: ev.part.tool || '',
              callID: ev.part.callID,
              status: ev.part.state?.status,
              title: ev.part.state?.title ?? ev.part.title,
              input: ev.part.state?.input,
              output: ev.part.state?.output
            });
          }
          break;
        case 'step_finish':
          if (ev.part) {
            if (ev.part.reason) {
              result.finishReasons.push(ev.part.reason);
              result.stopReason = ev.part.reason; // last wins
            }
            if (ev.part.tokens) {
              result.tokenUsage = {
                prompt: ev.part.tokens.prompt,
                completion: ev.part.tokens.completion,
                total: ev.part.tokens.total
              };
            }
          }
          break;
        case 'error':
          if (ev.error && !result.streamError) {
            result.streamError = {
              name: ev.error.name,
              message: ev.error.data?.message ?? ev.error.message,
              ref: ev.error.data?.ref,
              data: ev.error.data
            };
          }
          break;
        default:
          // Ignore other event types
          break;
      }
    } catch {
      result.unparsed.push(trimmed);
    }
  }

  return result;
}

export function classifyOpencodeError(e: OpencodeStreamError): RunError {
  const nameStr = (e.name || '').toLowerCase();
  const msgStr = (e.message || '').toLowerCase();
  const searchStr = `${nameStr} ${msgStr}`;

  // auth pattern (unauthor|401|auth|credential|api[_-]?key)
  const authPattern = /unauthor|401|auth|credential|api[_-]?key/i;
  // model/provider pattern (provider|not found|unknown model|does not exist|invalid model)
  const modelPattern = /provider|not found|unknown model|does not exist|invalid model/i;

  let kind: RunError['kind'] = 'server';
  if (authPattern.test(searchStr)) {
    kind = 'auth';
  } else if (modelPattern.test(searchStr)) {
    kind = 'unknown-model';
  }

  return {
    kind,
    message: e.message || 'Unknown opencode stream error',
    ref: e.ref,
    raw: e.data
  };
}
