/**
 * Parse Claude JSON result object, capturing the session_id and final assistant text from result.
 */
export function parseClaudeResult(stdout: string): { sessionId: string; assistantText: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Empty output received from Claude');
  }

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch (err: any) {
    throw new Error(`Malformed JSON: ${err.message}`);
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Malformed JSON: output is not an object');
  }

  if (!obj.session_id || typeof obj.session_id !== 'string') {
    throw new Error('Missing session_id in Claude result');
  }

  if (obj.result === undefined || typeof obj.result !== 'string') {
    throw new Error('Missing result in Claude result');
  }

  return {
    sessionId: obj.session_id,
    assistantText: obj.result
  };
}
