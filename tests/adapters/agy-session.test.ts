import { describe, expect, it } from 'vitest';
import {
  assertAgyResumedIdentity,
  decodeAgySession,
  encodeAgySession,
  parseAgyInvocationLog,
} from '../../src/adapters/agy-session.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const otherProjectId = '33333333-3333-4333-8333-333333333333';
const otherConversationId = '44444444-4444-4444-8444-444444444444';

const freshLog = [
  'Backend project ID updated dynamically to: 11111111-1111-4111-8111-111111111111',
  'Print mode: conversation=22222222-2222-4222-8222-222222222222, sending message',
].join('\n');

describe('AGY session contract', () => {
  it('parses the bounded fresh and resumed 1.1.6 identity lines', () => {
    expect(parseAgyInvocationLog(freshLog)).toEqual({ projectId, conversationId });
    expect(parseAgyInvocationLog(`prefix ${freshLog}\n${freshLog}`)).toEqual({ projectId, conversationId });
  });

  it('round-trips the versioned opaque token', () => {
    const token = encodeAgySession({ projectId, conversationId });
    expect(token).toBe(`agy:v1:${projectId}:${conversationId}`);
    expect(decodeAgySession(token)).toEqual({ projectId, conversationId });
  });

  it.each([
    'agy:v2:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    `agy:v1:${projectId}:${conversationId}:extra`,
    `agy:v1:${projectId}:not-a-uuid`,
    'agy:v1::22222222-2222-4222-8222-222222222222',
  ])('rejects malformed token %s', (token) => {
    expect(() => decodeAgySession(token)).toThrow(/AGY (session token|project ID|conversation ID)/);
  });

  it.each([
    '',
    'Backend project ID updated dynamically to: not-a-uuid',
    'Backend project ID updated dynamically to: 11111111-1111-4111-8111-111111111111',
    'Print mode: conversation=22222222-2222-4222-8222-222222222222, sending message',
    'a provider response containing 11111111-1111-4111-8111-111111111111',
  ])('rejects missing or malformed identity evidence: %s', (log) => {
    expect(() => parseAgyInvocationLog(log)).toThrow();
  });

  it('rejects conflicting duplicate IDs but accepts repeated identical diagnostics', () => {
    expect(() => parseAgyInvocationLog([
      freshLog,
      `Backend project ID updated dynamically to: ${otherProjectId}`,
    ].join('\n'))).toThrow(/conflicting project/);
    expect(() => parseAgyInvocationLog([
      freshLog,
      `Print mode: conversation=${otherConversationId}, sending message`,
    ].join('\n'))).toThrow(/conflicting conversation/);
    expect(parseAgyInvocationLog(`${freshLog}\n${freshLog}`)).toEqual({ projectId, conversationId });
  });

  it('ignores auth-looking or unrelated provider prose instead of scanning it for IDs', () => {
    expect(parseAgyInvocationLog([
      'authentication failed before keyring authentication succeeded',
      'The authorisation authority is ready.',
      freshLog,
    ].join('\n'))).toEqual({ projectId, conversationId });
  });

  it('requires exact identity equality when resuming', () => {
    expect(() => assertAgyResumedIdentity(
      { projectId, conversationId },
      { projectId: otherProjectId, conversationId },
    )).toThrow(/does not match/);
    expect(() => assertAgyResumedIdentity(
      { projectId, conversationId },
      { projectId, conversationId: otherConversationId },
    )).toThrow(/does not match/);
    expect(() => assertAgyResumedIdentity(
      { projectId: projectId.toUpperCase(), conversationId },
      { projectId, conversationId },
    )).not.toThrow();
  });
});
