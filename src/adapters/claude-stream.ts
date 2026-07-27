import { JsonlDecoder, type JsonlDiagnostic } from './jsonl-decoder.js';
import type { LifecycleEvent } from '../adapter-lifecycle.js';

export interface ClaudeParseOptions {
  agent?: string;
  version?: number;
}

export class ClaudeStreamParser {
  private decoder = new JsonlDecoder();
  private sessionId?: string;
  private assistantText?: string;
  private seenToolIds = new Set<string>();
  private toolCallCount = 0;
  private diagnostics: JsonlDiagnostic[] = [];
  private parseError?: Error;
  private agent: string;
  private version?: number;

  constructor(options?: ClaudeParseOptions) {
    this.agent = options?.agent ?? 'claude';
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
      throw new Error(`Malformed JSON output in Claude stream (${diag.code} at record ${diag.ordinal})`);
    }

    if (this.sessionId === undefined) {
      throw new Error('Missing session_id in Claude JSON stream');
    }
    if (this.assistantText === undefined) {
      throw new Error('Missing terminal result event in Claude JSON stream');
    }

    return {
      sessionId: this.sessionId,
      assistantText: this.assistantText,
      toolCallCount: this.toolCallCount,
    };
  }

  private processRecord(obj: any, events: LifecycleEvent[]): void {
    if (!obj || typeof obj !== 'object') return;

    if (typeof obj.session_id === 'string' && obj.session_id.trim()) {
      if (this.sessionId === undefined) {
        this.sessionId = obj.session_id.trim();
      } else if (this.sessionId !== obj.session_id.trim()) {
        // Disallow session ID changing mid-stream
        this.parseError = new Error(`Mismatched session_id in Claude stream: expected ${this.sessionId}, got ${obj.session_id.trim()}`);
        return;
      }
    }

    if (obj.type === 'result') {
      if (this.assistantText !== undefined) {
        this.parseError = new Error('Duplicate terminal result event in Claude stream');
        return;
      }
      if (obj.is_error === true || obj.subtype === 'error' || obj.error !== undefined) {
        this.parseError = new Error('Claude execution failed with provider error');
        return;
      }
      if ((obj.subtype === 'success' || obj.subtype === undefined) && typeof obj.result === 'string') {
        this.assistantText = obj.result;
        return;
      }
      this.parseError = new Error('Invalid terminal result envelope in Claude stream');
      return;
    }

    // Inspect assistant tool use events
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block && typeof block === 'object' && block.type === 'tool_use') {
          const toolId = String(block.id || `tool-${this.seenToolIds.size + 1}`);
          if (!this.seenToolIds.has(toolId)) {
            this.seenToolIds.add(toolId);
            this.toolCallCount += 1;

            const toolName = String(block.name || '').toLowerCase();
            let category = 'tool use';
            if (toolName.includes('bash') || toolName.includes('exec') || toolName.includes('terminal') || toolName.includes('command')) {
              category = 'command execution';
            } else if (toolName.includes('edit') || toolName.includes('write') || toolName.includes('patch') || toolName.includes('file')) {
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
}

export function parseClaudeStream(stdout: string): { sessionId: string; assistantText: string; toolCallCount: number } {
  const parser = new ClaudeStreamParser();
  parser.push(stdout);
  return parser.finish();
}
