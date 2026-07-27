import { JsonlDecoder, type JsonlDiagnostic } from './jsonl-decoder.js';
import type { LifecycleEvent } from '../adapter-lifecycle.js';

export interface CodexParseOptions {
  agent?: string;
  version?: number;
}

export class CodexJsonParser {
  private decoder = new JsonlDecoder();
  private sessionId?: string;
  private assistantText?: string;
  private seenToolItemIds = new Set<string>();
  private toolCallCount = 0;
  private diagnostics: JsonlDiagnostic[] = [];
  private parseError?: Error;
  private agent: string;
  private version?: number;

  constructor(options?: CodexParseOptions) {
    this.agent = options?.agent ?? 'codex';
    this.version = options?.version;
  }

  public push(chunk: string): LifecycleEvent[] {
    if (this.parseError) return [];
    const events: LifecycleEvent[] = [];
    const { records, diagnostics } = this.decoder.push(chunk);

    if (diagnostics.length > 0) {
      this.diagnostics.push(...diagnostics);
    }

    for (const record of records) {
      this.processRecord(record.value, events);
      if (this.parseError) break;
    }

    return events;
  }

  public finish(): { sessionId: string; assistantText: string; toolCallCount: number } {
    if (this.parseError) {
      throw this.parseError;
    }

    const { records, diagnostics } = this.decoder.finish();
    if (diagnostics.length > 0) {
      this.diagnostics.push(...diagnostics);
    }

    const events: LifecycleEvent[] = [];
    for (const record of records) {
      this.processRecord(record.value, events);
      if (this.parseError) {
        throw this.parseError;
      }
    }

    if (this.parseError) {
      throw this.parseError;
    }

    if (this.diagnostics.length > 0) {
      const diag = this.diagnostics[0]!;
      throw new Error(`Malformed JSON output in Codex stream (${diag.code} at record ${diag.ordinal})`);
    }

    if (this.sessionId === undefined) {
      throw new Error('Missing thread.started event in Codex JSON stream');
    }
    if (this.assistantText === undefined) {
      throw new Error('Missing final assistant output (agent_message item.completed event) in Codex JSON stream');
    }

    return {
      sessionId: this.sessionId,
      assistantText: this.assistantText,
      toolCallCount: this.toolCallCount,
    };
  }

  private processRecord(obj: any, events: LifecycleEvent[]): void {
    if (!obj || typeof obj !== 'object') return;

    if (obj.type === 'thread.started') {
      if (this.sessionId !== undefined) {
        this.parseError = new Error('Duplicate thread.started event in Codex JSON stream');
        return;
      }
      if (!obj.thread_id || typeof obj.thread_id !== 'string') {
        this.parseError = new Error('Missing thread_id in thread.started event');
        return;
      }
      this.sessionId = obj.thread_id;
    } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
      if (obj.item.text === undefined || typeof obj.item.text !== 'string') {
        this.parseError = new Error('Missing text in agent_message item.completed event');
        return;
      }
      this.assistantText = (this.assistantText ?? '') + obj.item.text;
    } else if (obj.item && typeof obj.item === 'object') {
      const itemType = String(obj.item.type || '');
      const ALLOWED_TOOL_ITEM_TYPES = new Set([
        'command_execution',
        'file_change',
        'tool_use',
        'mcp_tool_call',
        'web_search',
      ]);
      const isTool = ALLOWED_TOOL_ITEM_TYPES.has(itemType);

      if (isTool && itemType !== 'agent_message' && itemType !== 'reasoning') {
        const itemId = String(obj.item.id || obj.item.item_id || `ordinal-${this.seenToolItemIds.size + 1}`);
        if (!this.seenToolItemIds.has(itemId)) {
          this.seenToolItemIds.add(itemId);
          this.toolCallCount += 1;

          let category = 'tool use';
          if (itemType === 'command_execution' || itemType === 'command') {
            category = 'command execution';
          } else if (itemType === 'file_change' || itemType === 'file') {
            category = 'file change';
          }

          if (this.version !== undefined) {
            events.push({
              type: 'message',
              agent: this.agent,
              version: this.version,
              text: category,
              toolCalls: 1,
              atMs: Date.now(),
            });
          }
        }
      }
    }
  }
}

export function parseCodexJsonOutput(stdout: string): { sessionId: string; assistantText: string } {
  const parser = new CodexJsonParser();
  parser.push(stdout);
  return parser.finish();
}
