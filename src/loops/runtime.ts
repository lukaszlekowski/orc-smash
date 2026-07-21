export type Runner = { agent: string; model: string; effort?: string; sessionStrategy?: string };

export type LoopReturn = {
  success: boolean;
  verdict: string;
  message: string;
  lastAuditPath: string | null;
  terminalEventEmitted?: boolean;
  outcome?: RunOutcome;
};

export type RunOutcome =
  | { kind: 'completed'; message: string; artifactPath: string | null }
  | { kind: 'blocked'; message: string; artifactPath: string | null }
  | { kind: 'unknown'; message: string; detail?: string; artifactPath: string | null }
  | { kind: 'provider-failed'; message: string; errorKind: string; artifactPath: string | null }
  | { kind: 'budget-exhausted'; message: string; artifactPath: string | null }
  | { kind: 'ownership-lost'; message: string; artifactPath: string | null }
  | { kind: 'interrupted'; message: string; artifactPath: string | null };
