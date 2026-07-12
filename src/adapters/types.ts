import type { LifecycleEvent } from '../adapter-lifecycle.js';
import type { OwnershipContext } from '../run-ownership.js';
import type { SpawnRuntime } from './process-group.js';

export interface SpawnRequest {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  onStdoutChunk?: (chunk: string) => void;
}

export interface RunInput {
  prompt: string;
  model: string;
  cwd: string;
  skillId?: string;
  version?: number;
  kind?: 'audit' | 'follow-up' | 'implement';
  onLifecycle?: (e: LifecycleEvent) => void;
  continuity?: {
    mode: 'fresh' | 'resumed';
    sessionId?: string;
  };
  ownership?: OwnershipContext;
  spawnRuntime?: SpawnRuntime;
}

export type RunErrorKind =
  | 'auth'
  | 'config'
  | 'unknown-model'
  | 'server'
  | 'spawn'
  | 'timeout'
  | 'nonzero-exit'
  | 'ownership';

export interface RunError {
  kind: RunErrorKind;
  message: string;            // one-line human message with remediation
  ref?: string;               // opencode error ref (e.g. "err_3a9287f2") for support
  raw?: unknown;              // error.data / stderr tail for diagnostics
}

export interface ToolCall {
  tool: string;               // "bash" | "write" | ...
  callID?: string;
  status?: string;            // "completed" | "error" | ...
  title?: string;
  input?: unknown;
  output?: string;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
  stderr?: string;            // captured separately — NEVER folded into stdout
  error?: RunError;           // structured adapter error (absent ⇒ success)
  toolCalls?: ToolCall[];     // opencode: parsed tool calls (also feeds item 5 later)
  stopReason?: string | null; // opencode: raw last step_finish.part.reason (e.g. "stop"); diagnostics only
  completion?: 'complete' | 'truncated' | 'interrupted' | 'missing'; // normalized execution-completeness (Batch 1: opencode only)
  sessionId?: string;
}

export interface AgentAdapter {
  name: string;
  buildRun(input: RunInput): { command: string; args: string[] };
  run(input: RunInput): Promise<RunResult>;
}

