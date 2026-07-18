export const SCHEMA_VERSION = 1 as const;

export const MAX_PROGRESS_EVENTS = 8;
export const PROGRESS_MAX_LENGTH = 240;
export const TOOL_CALL_DISPLAY_CAP = 999;

type RunEventBase = { schemaVersion: typeof SCHEMA_VERSION; atMs: number };

export type RunEvent =
  | (RunEventBase & { type: 'run.started' })
  | (RunEventBase & { type: 'config.loaded'; path: string })
  | (RunEventBase & { type: 'config.failed'; message: string })
  | (RunEventBase & { type: 'loop.selected'; loopName: string })
  | (RunEventBase & { type: 'runner.resolved'; skillId: string; agent: string; model: string; agentSource: string; modelSource: string; inheritedSession?: { agent: string; model: string; sessionId: string } })
  | (RunEventBase & { type: 'runner.rejected'; skillId: string; message: string })
  | (RunEventBase & { type: 'state.scanned'; latestVerdict: string; version: number })
  | (RunEventBase & { type: 'iteration.started'; iteration: number; maxIterations: number })
  | (RunEventBase & { type: 'step.started'; kind: string; skillId: string; agent: string; model: string; version: number; message: string })
  | (RunEventBase & { type: 'provider.started'; agent: string })
  | (RunEventBase & { type: 'provider.progress'; agent: string; message: string })
  | (RunEventBase & { type: 'provider.completed'; agent: string; toolCalls: number | '999+'; progressEmitted: number; progressSuppressed: number })
  | (RunEventBase & { type: 'provider.failed'; agent: string; errorKind?: string; toolCalls: number | '999+'; progressEmitted: number; progressSuppressed: number })
  | (RunEventBase & { type: 'artifact.verified'; path: string; verdict?: string })
  | (RunEventBase & { type: 'artifact.missing'; path: string; reason: string })
  | (RunEventBase & { type: 'verdict.parsed'; verdict: string })
  | (RunEventBase & { type: 'verdict.unknown'; path: string })
  | (RunEventBase & { type: 'follow-up.outcome'; outcome: string })
  | (RunEventBase & { type: 'stage.action'; action: string; phase: string })
  | (RunEventBase & { type: 'implementation.ledger-validated'; isComplete: boolean })
  | (RunEventBase & { type: 'plan.closeout'; status: string })
  | (RunEventBase & { type: 'ownership.opened'; projectRoot: string })
  | (RunEventBase & { type: 'ownership.finalized'; success: boolean })
  | (RunEventBase & { type: 'ownership.lost'; reason?: string })
  | (RunEventBase & { type: 'run.interrupted'; reason?: string })
  | (RunEventBase & { type: 'run.completed'; verdict: string; outcome: string })
  | (RunEventBase & { type: 'run.failed'; reason: string; errorKind?: string })
  | (RunEventBase & { type: 'note'; message: string })
  | (RunEventBase & { type: 'warning'; message: string })
  | (RunEventBase & { type: 'error'; message: string });

type WithoutSchema<T> = T extends unknown ? Omit<T, 'schemaVersion'> : never;
export type RunEventInput = WithoutSchema<RunEvent>;

export function makeRunEvent(event: RunEventInput): RunEvent {
  return { ...event, schemaVersion: SCHEMA_VERSION } as RunEvent;
}

export interface RunEventSink {
  emit(event: RunEvent): void;
  flush(): Promise<void>;
}
