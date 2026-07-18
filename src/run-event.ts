export const SCHEMA_VERSION = 1;

export const MAX_PROGRESS_EVENTS = 8;
export const PROGRESS_MAX_LENGTH = 240;

export type RunEvent =
  | { type: 'run.started'; atMs: number }
  | { type: 'config.loaded'; atMs: number; path: string }
  | { type: 'config.failed'; atMs: number; message: string }
  | { type: 'loop.selected'; atMs: number; loopName: string }
  | { type: 'runner.resolved'; atMs: number; skillId: string; agent: string; model: string; agentSource: string; modelSource: string; inheritedSession?: { agent: string; model: string; sessionId: string } }
  | { type: 'runner.rejected'; atMs: number; skillId: string; message: string }
  | { type: 'state.scanned'; atMs: number; latestVerdict: string; version: number }
  | { type: 'iteration.started'; atMs: number; iteration: number; maxIterations: number }
  | { type: 'step.started'; atMs: number; kind: string; skillId: string; agent: string; model: string; version: number; message: string }
  | { type: 'provider.started'; atMs: number; agent: string }
  | { type: 'provider.progress'; atMs: number; agent: string; message: string }
  | { type: 'provider.completed'; atMs: number; agent: string; toolCalls: number; progressEmitted: number; progressSuppressed: number }
  | { type: 'provider.failed'; atMs: number; agent: string; errorKind?: string; toolCalls: number; progressEmitted: number; progressSuppressed: number }
  | { type: 'artifact.verified'; atMs: number; path: string; verdict?: string }
  | { type: 'artifact.missing'; atMs: number; path: string; reason: string }
  | { type: 'verdict.parsed'; atMs: number; verdict: string }
  | { type: 'verdict.unknown'; atMs: number; path: string }
  | { type: 'follow-up.outcome'; atMs: number; outcome: string }
  | { type: 'stage.action'; atMs: number; action: string; phase: string }
  | { type: 'implementation.ledger-validated'; atMs: number; isComplete: boolean }
  | { type: 'plan.closeout'; atMs: number; status: string }
  | { type: 'ownership.opened'; atMs: number; projectRoot: string }
  | { type: 'ownership.finalized'; atMs: number; success: boolean }
  | { type: 'ownership.lost'; atMs: number; reason?: string }
  | { type: 'run.interrupted'; atMs: number; reason?: string }
  | { type: 'run.completed'; atMs: number; verdict: string; outcome: string }
  | { type: 'run.failed'; atMs: number; reason: string; errorKind?: string }
  | { type: 'note'; atMs: number; message: string }
  | { type: 'warning'; atMs: number; message: string }
  | { type: 'error'; atMs: number; message: string };

export interface RunEventSink {
  emit(event: RunEvent): void;
  flush(): Promise<void>;
}
