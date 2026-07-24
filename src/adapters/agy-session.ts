/**
 * The opaque AGY continuity contract.
 *
 * AGY exposes project and conversation identity only through bounded invocation
 * diagnostics. Keep those provider-specific details here so the generic runner
 * and provenance layers continue to treat the resulting token as opaque.
 */

export interface AgySessionIdentity {
  projectId: string;
  conversationId: string;
}

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_PATTERN}$`, 'i');
const TOKEN_PREFIX = 'agy:v1:';

const PROJECT_MARKER = 'Backend project ID updated dynamically to:';
const PROJECT_LINE = new RegExp(`${PROJECT_MARKER}\\s*(${UUID_PATTERN})\\s*$`, 'i');
const CONVERSATION_MARKER = 'Print mode: conversation=';
const CONVERSATION_LINE = new RegExp(
  `${CONVERSATION_MARKER}(${UUID_PATTERN}),\\s*sending message\\s*$`,
  'i',
);

function normalizeUuid(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new Error(`AGY ${label} is not a valid UUID.`);
  }
  return value.toLowerCase();
}

function normalizeIdentity(identity: AgySessionIdentity): AgySessionIdentity {
  return {
    projectId: normalizeUuid(identity.projectId, 'project ID'),
    conversationId: normalizeUuid(identity.conversationId, 'conversation ID'),
  };
}

function recordIdentity(
  current: string | undefined,
  next: string,
  label: string,
): string {
  if (current !== undefined && current !== next) {
    throw new Error(`AGY invocation log contains conflicting ${label} values.`);
  }
  return next;
}

/** Encode the exact versioned pair used for AGY continuity. */
export function encodeAgySession(identity: AgySessionIdentity): string {
  const normalized = normalizeIdentity(identity);
  return `${TOKEN_PREFIX}${normalized.projectId}:${normalized.conversationId}`;
}

/** Decode a versioned AGY token; no provider history or fallback is consulted. */
export function decodeAgySession(token: string): AgySessionIdentity {
  if (typeof token !== 'string') {
    throw new Error('AGY session token must be a string.');
  }

  const fields = token.split(':');
  if (fields.length !== 4 || fields[0] !== 'agy' || fields[1] !== 'v1') {
    throw new Error('AGY session token has an unsupported prefix, version, or shape.');
  }

  return normalizeIdentity({
    projectId: fields[2]!,
    conversationId: fields[3]!,
  });
}

/**
 * Parse only the two AGY 1.1.6 diagnostic lines that identify this invocation.
 * Repeated identical lines are harmless; any conflicting, partial, or malformed
 * identity line fails closed.
 */
export function parseAgyInvocationLog(log: string): AgySessionIdentity {
  let projectId: string | undefined;
  let conversationId: string | undefined;

  for (const line of log.split(/\r?\n/)) {
    if (line.includes(PROJECT_MARKER)) {
      const match = line.match(PROJECT_LINE);
      if (!match) {
        throw new Error('AGY invocation log contains a malformed project identity line.');
      }
      projectId = recordIdentity(projectId, normalizeUuid(match[1]!, 'project ID'), 'project ID');
    }

    if (line.includes(CONVERSATION_MARKER)) {
      const match = line.match(CONVERSATION_LINE);
      if (!match) {
        throw new Error('AGY invocation log contains a malformed conversation identity line.');
      }
      conversationId = recordIdentity(
        conversationId,
        normalizeUuid(match[1]!, 'conversation ID'),
        'conversation ID',
      );
    }
  }

  if (!projectId || !conversationId) {
    throw new Error('AGY invocation log did not contain a complete project/conversation identity.');
  }

  return { projectId, conversationId };
}

/** Require a resumed invocation to return the exact requested identity pair. */
export function assertAgyResumedIdentity(
  expected: AgySessionIdentity,
  actual: AgySessionIdentity,
): void {
  const normalizedExpected = normalizeIdentity(expected);
  const normalizedActual = normalizeIdentity(actual);
  if (
    normalizedExpected.projectId !== normalizedActual.projectId
    || normalizedExpected.conversationId !== normalizedActual.conversationId
  ) {
    throw new Error('AGY resumed project/conversation identity does not match the requested session.');
  }
}
