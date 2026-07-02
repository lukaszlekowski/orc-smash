/**
 * Parse Codex JSONL event output, capturing the sessionId and final assistant text.
 */
export function parseCodexJsonOutput(stdout: string): { sessionId: string; assistantText: string } {
  const lines = stdout.split(/\r?\n/);
  let sessionId: string | undefined;
  let assistantText: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (err: any) {
      throw new Error(`Malformed JSON output: failed to parse line: ${line}`);
    }

    if (obj.type === 'thread.started') {
      if (sessionId !== undefined) {
        throw new Error('Duplicate thread.started event in Codex JSON stream');
      }
      if (!obj.thread_id || typeof obj.thread_id !== 'string') {
        throw new Error('Missing thread_id in thread.started event');
      }
      sessionId = obj.thread_id;
    } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
      if (obj.item.text === undefined || typeof obj.item.text !== 'string') {
        throw new Error('Missing text in agent_message item.completed event');
      }
      // If there are multiple agent_message items, concatenate them
      assistantText = (assistantText ?? '') + obj.item.text;
    }
  }

  if (sessionId === undefined) {
    throw new Error('Missing thread.started event in Codex JSON stream');
  }
  if (assistantText === undefined) {
    throw new Error('Missing final assistant output (agent_message item.completed event) in Codex JSON stream');
  }

  return { sessionId, assistantText };
}
