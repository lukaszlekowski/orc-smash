export type Runner = { agent: string; model: string };

export type LoopReturn = {
  success: boolean;
  verdict: string;
  message: string;
  lastAuditPath: string | null;
  terminalEventEmitted?: boolean;
};
