export type LifecycleEvent =
  | { type: 'started'; agent: string; model: string; version: number; skillId: string; message: string; atMs: number }
  | { type: 'message'; agent: string; version: number; text: string; toolCalls?: number; atMs: number }
  | { type: 'completed'; agent: string; version: number; atMs: number }
  | { type: 'failed'; agent: string; version: number; errorKind?: string; atMs: number };

export function summarizeLifecycle(events: LifecycleEvent[]): { lastMessage: string | null; toolCallCount: number } {
  let lastMessage: string | null = null;
  let toolCallCount = 0;
  for (const e of events) {
    if (e.type === 'message') {
      lastMessage = e.text;
      toolCallCount += e.toolCalls ?? 0;
    }
  }
  return { lastMessage, toolCallCount };
}
