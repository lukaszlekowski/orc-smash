import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from '../pipeline-state.js';
import type { AgentAdapter, RunInput, RunResult, RunError } from './types.js';

export interface FakeExtraWrite {
  path: string;
  content: string;
}

/**
 * Simulated interruption window for the planning-set publication protocol.
 * Consumed by one fake run; the retry observes the filesystem state and
 * resumes the protocol normally.
 */
export type PlanningSetInterruptWindow =
  | 'none'
  | 'before-renames'
  | 'between-renames'
  | 'after-renames'
  | 'during-cleanup';

export const fakeAdapterState = {
  verdicts: [] as string[],
  stdout: '',
  exitCode: 0,
  writeVerdictFile: true,
  auditError: undefined as RunError | undefined,
  followUpError: undefined as RunError | undefined,
  stderr: undefined as string | undefined,
  effectiveModel: undefined as string | undefined,
  effectiveEffort: undefined as string | undefined,
  delayMs: undefined as number | undefined,
  lifecycleMessages: [] as Array<{ text: string; toolCalls: number }>,
  failAfterMs: undefined as number | undefined,
  progressCapability: undefined as 'structured' | 'unavailable' | undefined,
  extraWrites: [] as FakeExtraWrite[],
  taskOutcome: undefined as string | undefined,
  /** When set, the implement path writes a structurally valid blocked ledger. */
  implementLedgerBlocked: undefined as string | undefined,
  planningSetInterrupt: 'none' as PlanningSetInterruptWindow,
};

// ---- planning-set (spec/plan pair) protocol simulation ----
//
// Simulates the deterministic part of the `orc-planning-set-v1` publication
// protocol the planning skills instruct real agents to execute: creation
// metadata with recomputable digests, transaction-scoped staging files, and
// zero/one/two-file recovery with bounded cleanup. Hazards are filesystem
// states the protocol must detect; tests arrange them directly.

const PLANNING_SET_PROTOCOL = 'orc-planning-set-v1';
const SPEC_STAGING_PREFIX = '.spec.md.orc-smash-';
const PLAN_STAGING_PREFIX = '.plan.md.orc-smash-';
const MAX_STAGING_ENTRIES = 8;

function enc(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function bodyAfterFrontMatter(content: string): string {
  const fm = content.match(/^---\n[\s\S]*?\n---\n/);
  return fm ? content.slice(fm[0].length) : content;
}

interface CreationMetadata {
  transactionId: string;
  sourceKind: 'accepted-research' | 'plan-bootstrap';
  sourceArtifactIdentity: string;
  sourceDigest: string;
  document: 'spec' | 'plan';
  bodyDigest: string;
  peerBodyDigest: string;
}

function creationFrontMatter(meta: CreationMetadata): string {
  return [
    '---',
    'creation:',
    `  protocol: ${PLANNING_SET_PROTOCOL}`,
    `  transactionId: ${meta.transactionId}`,
    `  sourceKind: ${meta.sourceKind}`,
    `  sourceArtifactIdentity: ${meta.sourceArtifactIdentity}`,
    `  sourceDigest: ${meta.sourceDigest}`,
    `  document: ${meta.document}`,
    `  bodyDigest: ${meta.bodyDigest}`,
    `  peerBodyDigest: ${meta.peerBodyDigest}`,
    '---',
    '',
  ].join('\n');
}

function parseCreationMetadata(content: string): { metadata: CreationMetadata; body: string } | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return null;
  const fields: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const match = line.match(/^\s*(\w+):\s*(.+)$/);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  if (
    !fields.protocol || fields.protocol !== PLANNING_SET_PROTOCOL
    || !fields.transactionId || !/^[0-9a-f]{64}$/.test(fields.transactionId)
    || !fields.sourceKind
    || !fields.sourceDigest || !/^[0-9a-f]{64}$/.test(fields.sourceDigest)
    || !fields.document
    || !fields.bodyDigest || !/^[0-9a-f]{64}$/.test(fields.bodyDigest)
    || !fields.peerBodyDigest || !/^[0-9a-f]{64}$/.test(fields.peerBodyDigest)
  ) {
    return null;
  }
  const body = content.slice(fm[0].length);
  const metadata: CreationMetadata = {
    transactionId: fields.transactionId!,
    sourceKind: fields.sourceKind as CreationMetadata['sourceKind'],
    sourceArtifactIdentity: fields.sourceArtifactIdentity ?? 'none',
    sourceDigest: fields.sourceDigest!,
    document: fields.document as 'spec' | 'plan',
    bodyDigest: fields.bodyDigest!,
    peerBodyDigest: fields.peerBodyDigest!,
  };
  if (metadata.bodyDigest !== sha256(body)) return null;
  return { metadata, body };
}

function transactionId(sourceKind: string, sourceIdentity: string, sourceDigest: string, specBodyDigest: string, planBodyDigest: string): string {
  return sha256(
    enc(PLANNING_SET_PROTOCOL)
    + enc(sourceKind)
    + enc(sourceIdentity)
    + enc(sourceDigest)
    + enc(specBodyDigest)
    + enc(planBodyDigest),
  );
}

function acceptedResearchSourceDigest(researchBytes: Buffer, evaluationBytes: Buffer): string {
  return sha256(enc(researchBytes.toString('utf8')) + enc(evaluationBytes.toString('utf8')));
}

function makeDocument(sourceKind: 'accepted-research' | 'plan-bootstrap', sourceIdentity: string, sourceDigest: string, document: 'spec' | 'plan', body: string, peerBody: string): string {
  const metadata: CreationMetadata = {
    transactionId: '',
    sourceKind,
    sourceArtifactIdentity: sourceIdentity,
    sourceDigest,
    document,
    bodyDigest: sha256(body),
    peerBodyDigest: sha256(peerBody),
  };
  metadata.transactionId = transactionId(sourceKind, sourceIdentity, sourceDigest, document === 'spec' ? metadata.bodyDigest : sha256(peerBody), document === 'plan' ? metadata.bodyDigest : sha256(peerBody));
  return creationFrontMatter(metadata) + body;
}

function specBodyForSimulation(): string {
  return [
    '## Objective',
    '',
    'Create a spec/plan pair from the accepted research artifact.',
    '',
    '## Acceptance Criteria',
    '',
    '1. Both canonical documents exist with valid creation metadata.',
    '2. The plan is concrete enough for implementation.',
  ].join('\n') + '\n';
}

function planBodyForSimulation(): string {
  return '# Generated plan\n\n**Confidence: 0.96**\n';
}

function stagingCandidates(docsDev: string): { spec: string[]; plan: string[] } {
  const spec: string[] = [];
  const plan: string[] = [];
  const entries = existsSync(docsDev) ? readdirSyncSafe(docsDev) : [];
  for (const name of entries) {
    if (name.startsWith(SPEC_STAGING_PREFIX) && name.endsWith('.tmp') && /^[0-9a-f]{64}\.tmp$/.test(name.slice(SPEC_STAGING_PREFIX.length))) {
      spec.push(name);
    } else if (name.startsWith(PLAN_STAGING_PREFIX) && name.endsWith('.tmp') && /^[0-9a-f]{64}\.tmp$/.test(name.slice(PLAN_STAGING_PREFIX.length))) {
      plan.push(name);
    }
  }
  return { spec, plan };
}

function readdirSyncSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function writeBlockedEvidence(evidencePath: string, reason: string): void {
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `# Planning set task\n\n## Outcome\n\nBLOCKED\n\n${reason}\n`);
}

function writeCompletedEvidence(evidencePath: string, summary: string): void {
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `# Planning set task\n\n## Outcome\n\nCOMPLETED\n\n${summary}\n`);
}

function applyExtraWrites(cwd: string): void {
  for (const extraWrite of fakeAdapterState.extraWrites) {
    const absolutePath = resolve(cwd, extraWrite.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, extraWrite.content);
  }
}

function implementLedgerContent(): string {
  if (fakeAdapterState.implementLedgerBlocked !== undefined) {
    return (
      `# Implementation Evidence Ledger\n\n` +
      `## Implementation Evidence Ledger\n\n` +
      `| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n` +
      `| --- | --- | --- | --- | --- |\n` +
      `| First slice | config, skills, src, tests | pnpm build + pnpm test | pass | none |\n` +
      `| Remaining slices | pending | pending | blocked | ${fakeAdapterState.implementLedgerBlocked} |\n\n` +
      `## Requirement Coverage\n\n` +
      `| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n` +
      `| --- | --- | --- | --- |\n` +
      `| First-slice requirements | config, skills, src, tests | pnpm build + pnpm test | pass |\n` +
      `| Remaining Batch 8 requirements | pending | pending | blocked |\n\n` +
      `State overall confidence: 0.97\n`
    );
  }
  return (
    `# Implementation Evidence Ledger\n\n` +
    `## Implementation Evidence Ledger\n\n` +
    `| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `| Step 1 | src/config.ts | pnpm test | pass | none |\n\n` +
    `## Requirement Coverage\n\n` +
    `| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n` +
    `| --- | --- | --- | --- |\n` +
    `| Config-driven timeouts | src/config.ts | tests/config.test.ts | pass |\n\n` +
    `State overall confidence: 1.00\n`
  );
}

function fakeTelemetry(): Pick<RunResult, 'effectiveModel' | 'effectiveEffort'> {
  return {
    ...(fakeAdapterState.effectiveModel !== undefined ? { effectiveModel: fakeAdapterState.effectiveModel } : {}),
    ...(fakeAdapterState.effectiveEffort !== undefined ? { effectiveEffort: fakeAdapterState.effectiveEffort } : {}),
  };
}

/**
 * Simulate the `23-simple-create-plan` / `24-simple-create-spec` protocol for
 * deterministic tests. Returns 'blocked' | 'completed' | 'interrupted'.
 */
export function simulatePlanningSetTask(
  cwd: string,
  kind: 'create-plan' | 'create-spec',
  prompt: string,
  evidenceRelativePath: string,
): 'blocked' | 'completed' | 'interrupted' {
  const docsDev = resolve(cwd, 'docs/dev');
  const specPath = resolve(docsDev, 'spec.md');
  const planPath = resolve(docsDev, 'plan.md');

  const evidencePath = resolve(cwd, evidenceRelativePath);
  const priorMatch = prompt.match(/Prior artifact:\s*([^\r\n]+)/i);
  const researchPath = resolve(cwd, 'docs/dev/research.md');

  const interrupt = fakeAdapterState.planningSetInterrupt;
  if (interrupt !== 'none') {
    fakeAdapterState.planningSetInterrupt = 'none';
  }

  const staging = stagingCandidates(docsDev);
  const stagingCount = staging.spec.length + staging.plan.length;

  // Bounded directory inspection: more than eight matching entries is an
  // ambiguous/unbounded state.
  if (stagingCount > MAX_STAGING_ENTRIES) {
    writeBlockedEvidence(evidencePath, 'Ambiguous staging set: more than 8 protocol staging files.');
    return 'blocked';
  }
  if (staging.spec.length > 1 || staging.plan.length > 1) {
    writeBlockedEvidence(evidencePath, 'Multiple matching transaction candidates; ambiguous state.');
    return 'blocked';
  }

  const planExists = existsSync(planPath);
  const specExists = existsSync(specPath);

  if (kind === 'create-spec') {
    if (!planExists) {
      writeBlockedEvidence(evidencePath, 'planPath document does not exist.');
      return 'blocked';
    }
    const planContent = readFileSync(planPath, 'utf8');
    const planBody = bodyAfterFrontMatter(planContent);
    const planBodyDigest = sha256(planBody);
    const existingSpec = specExists ? parseCreationMetadata(readFileSync(specPath, 'utf8')) : null;
    if (specExists) {
      if (!existingSpec || existingSpec.metadata.sourceKind !== 'plan-bootstrap') {
        writeBlockedEvidence(evidencePath, 'An unrelated spec exists; refusing to overwrite or adopt it.');
        return 'blocked';
      }
      if (existingSpec.metadata.sourceDigest !== planBodyDigest || existingSpec.metadata.peerBodyDigest !== planBodyDigest) {
        writeBlockedEvidence(evidencePath, 'Existing spec metadata does not bind to the unchanged plan.');
        return 'blocked';
      }
      if (interrupt === 'during-cleanup') {
        return 'interrupted';
      }
      removeMatchingStaging(join(docsDev, staging.spec[0] ?? ''), existingSpec.metadata.transactionId);
      writeCompletedEvidence(evidencePath, 'spec.md already published and bound to the unchanged plan; fresh joint plan audit required.');
      return 'completed';
    }
    const specBody = specBodyForSimulation();
    const spec = makeDocument('plan-bootstrap', 'none', planBodyDigest, 'spec', specBody, planBody);
    const parsed = parseCreationMetadata(spec)!;
    const txId = parsed.metadata.transactionId;
    const specStagingName = `${SPEC_STAGING_PREFIX}${txId}.tmp`;

    // Recover a partially published window: staged spec plus no canonical spec.
    let resumeFromStaging = false;
    if (staging.spec.length === 1) {
      const staged = readFileSync(join(docsDev, staging.spec[0]!), 'utf8');
      const stagedParsed = parseCreationMetadata(staged);
      if (stagedParsed && stagedParsed.metadata.sourceKind === 'plan-bootstrap'
        && stagedParsed.metadata.sourceDigest === planBodyDigest
        && stagedParsed.metadata.transactionId === txId) {
        resumeFromStaging = true;
      } else {
        writeBlockedEvidence(evidencePath, 'Staging file does not match the unchanged plan source binding.');
        return 'blocked';
      }
    }

    if (!resumeFromStaging) {
      mkdirSync(docsDev, { recursive: true });
      writeFileSync(join(docsDev, specStagingName), spec);
    }
    if (interrupt === 'before-renames') return 'interrupted';
    if (specExists) {
      writeBlockedEvidence(evidencePath, 'Destination spec.md exists; refusing to rename over it.');
      return 'blocked';
    }
    renameSync(join(docsDev, specStagingName), specPath);
    if (interrupt === 'between-renames') return 'interrupted';
    removeMatchingStaging(join(docsDev, staging.spec[0] ?? ''), txId);
    if (interrupt === 'after-renames') return 'interrupted';
    writeCompletedEvidence(evidencePath, 'spec.md created from the unchanged plan; fresh joint plan audit required.');
    return 'completed';
  }

  // ---- create-plan: pair publication bound to the accepted research. ----
  if (!existsSync(researchPath)) {
    writeBlockedEvidence(evidencePath, 'researchPath document does not exist.');
    return 'blocked';
  }
  if (!priorMatch || priorMatch[1]?.trim() === 'none') {
    writeBlockedEvidence(evidencePath, 'Prior artifact must be the accepted research evaluation artifact.');
    return 'blocked';
  }
  const priorPath = resolve(cwd, priorMatch[1]!.trim());
  if (!existsSync(priorPath)) {
    writeBlockedEvidence(evidencePath, 'Prior artifact file is missing.');
    return 'blocked';
  }
  const researchBytes = readFileSync(researchPath);
  const evaluationBytes = readFileSync(priorPath);
  const sourceDigest = acceptedResearchSourceDigest(researchBytes, evaluationBytes);
  const sourceIdentity = priorMatch[1]!.trim();

  const planBody = planBodyForSimulation();
  const specBody = specBodyForSimulation();
  const spec = makeDocument('accepted-research', sourceIdentity, sourceDigest, 'spec', specBody, planBody);
  const plan = makeDocument('accepted-research', sourceIdentity, sourceDigest, 'plan', planBody, specBody);
  const specParsed = parseCreationMetadata(spec)!;
  const planParsed = parseCreationMetadata(plan)!;
  const txId = specParsed.metadata.transactionId;
  if (txId !== planParsed.metadata.transactionId) {
    writeBlockedEvidence(evidencePath, 'Internal transaction mismatch.');
    return 'blocked';
  }
  const specStagingName = `${SPEC_STAGING_PREFIX}${txId}.tmp`;
  const planStagingName = `${PLAN_STAGING_PREFIX}${txId}.tmp`;

  // Two canonical documents with matching recomputed metadata: idempotent
  // success even when the completion evidence was never written.
  if (specExists && planExists) {
    const specMeta = parseCreationMetadata(readFileSync(specPath, 'utf8'));
    const planMeta = parseCreationMetadata(readFileSync(planPath, 'utf8'));
    if (specMeta && planMeta && specMeta.metadata.transactionId === txId
      && planMeta.metadata.transactionId === txId
      && specMeta.metadata.sourceDigest === sourceDigest
      && specMeta.metadata.peerBodyDigest === planMeta.metadata.bodyDigest
      && planMeta.metadata.peerBodyDigest === specMeta.metadata.bodyDigest) {
      if (interrupt === 'during-cleanup') {
        return 'interrupted';
      }
      cleanupTransactionStaging(docsDev, staging, txId);
      writeCompletedEvidence(evidencePath, 'Both canonical documents already published for this source transaction.');
      return 'completed';
    }
    writeBlockedEvidence(evidencePath, 'Existing canonical documents do not match the current source transaction.');
    return 'blocked';
  }
  if (specExists && !planExists) {
    const specMeta = parseCreationMetadata(readFileSync(specPath, 'utf8'));
    if (!specMeta || specMeta.metadata.transactionId !== txId || specMeta.metadata.sourceDigest !== sourceDigest) {
      writeBlockedEvidence(evidencePath, 'Canonical spec does not match the current source transaction.');
      return 'blocked';
    }
    // Valid canonical spec plus matching staged plan resumes the second publish.
    let staged = false;
    if (staging.plan.length === 1) {
      const planMeta = parseCreationMetadata(readFileSync(join(docsDev, staging.plan[0]!), 'utf8'));
      if (planMeta && planMeta.metadata.transactionId === txId) {
        staged = true;
      } else {
        writeBlockedEvidence(evidencePath, 'Staged plan does not match the current source transaction.');
        return 'blocked';
      }
    }
    if (!staged) {
      mkdirSync(docsDev, { recursive: true });
      writeFileSync(join(docsDev, planStagingName), plan);
    }
    if (interrupt === 'between-renames') return 'interrupted';
    if (existsSync(planPath)) {
      writeBlockedEvidence(evidencePath, 'Destination plan.md exists; refusing to rename over it.');
      return 'blocked';
    }
    renameSync(join(docsDev, planStagingName), planPath);
    if (interrupt === 'after-renames') return 'interrupted';
    cleanupTransactionStaging(docsDev, staging, txId);
    if (interrupt === 'during-cleanup') return 'interrupted';
    writeCompletedEvidence(evidencePath, 'spec.md and plan.md published from the accepted research artifact.');
    return 'completed';
  }

  // Zero canonical documents: generate and validate both staging files before
  // publishing either. Never rename over an existing destination.
  let specStaged = false;
  let planStaged = false;
  if (staging.spec.length === 1) {
    const meta = parseCreationMetadata(readFileSync(join(docsDev, staging.spec[0]!), 'utf8'));
    if (meta && meta.metadata.transactionId === txId && meta.metadata.sourceDigest === sourceDigest) {
      specStaged = true;
    } else {
      writeBlockedEvidence(evidencePath, 'Staged spec does not match the current source transaction.');
      return 'blocked';
    }
  }
  if (staging.plan.length === 1) {
    const meta = parseCreationMetadata(readFileSync(join(docsDev, staging.plan[0]!), 'utf8'));
    if (meta && meta.metadata.transactionId === txId) {
      planStaged = true;
    } else {
      writeBlockedEvidence(evidencePath, 'Staged plan does not match the current source transaction.');
      return 'blocked';
    }
  }
  if (!specStaged || !planStaged) {
    mkdirSync(docsDev, { recursive: true });
    if (!specStaged) writeFileSync(join(docsDev, specStagingName), spec);
    if (!planStaged) writeFileSync(join(docsDev, planStagingName), plan);
  }
  if (interrupt === 'before-renames') return 'interrupted';
  if (existsSync(specPath)) {
    writeBlockedEvidence(evidencePath, 'Destination spec.md exists; refusing to rename over it.');
    return 'blocked';
  }
  renameSync(join(docsDev, specStagingName), specPath);
  if (interrupt === 'between-renames') return 'interrupted';
  if (existsSync(planPath)) {
    writeBlockedEvidence(evidencePath, 'Destination plan.md exists; refusing to rename over it.');
    return 'blocked';
  }
  renameSync(join(docsDev, planStagingName), planPath);
  if (interrupt === 'after-renames') return 'interrupted';
  cleanupTransactionStaging(docsDev, staging, txId);
  if (interrupt === 'during-cleanup') return 'interrupted';
  writeCompletedEvidence(evidencePath, 'spec.md and plan.md published from the accepted research artifact.');
  return 'completed';
}

function removeMatchingStaging(path: string, transactionId: string): void {
  try {
    const content = readFileSync(path, 'utf8');
    const parsed = parseCreationMetadata(content);
    if (parsed && parsed.metadata.transactionId === transactionId) {
      rmSyncSafe(path);
    }
  } catch {
    // Preserve unrelated or unverifiable staging files.
  }
}

function cleanupTransactionStaging(docsDev: string, staging: { spec: string[]; plan: string[] }, transactionId: string): void {
  for (const name of [...staging.spec, ...staging.plan]) {
    removeMatchingStaging(join(docsDev, name), transactionId);
  }
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup; a later retry is idempotent.
  }
}

export const fakeAdapter: AgentAdapter = {
  name: 'fake',
  capabilities: {
    resumeSession: true,
    effort: true,
    get progress() {
      return fakeAdapterState.progressCapability ?? 'structured';
    },
  },

  buildRun(input: RunInput) {
    return { command: 'fake', args: [] };
  },

  async run(input: RunInput): Promise<RunResult> {
    const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
    const relativePath = match?.[1]?.trim() ?? '';
    const isRepair = input.kind === 'repair' || /followup-v\d+-/.test(relativePath);
    const isTask = input.kind === 'task';
    // Existing implementation-task compatibility remains intentionally scoped
    // to the test adapter; the new configurable seams below are generic.
    const isImplement = input.skillId === '30-simple-implement' || /impl-v\d+-/.test(relativePath);


    const emitStart = () => {
      if (input.onLifecycle && input.skillId && input.version !== undefined) {
        input.onLifecycle({
          type: 'started',
          agent: 'fake',
          model: input.model,
          version: input.version,
          skillId: input.skillId,
          message: 'fake spawn',
          atMs: Date.now()
        });
      }
    };

    const emitMessages = () => {
      if (input.onLifecycle && input.version !== undefined && fakeAdapterState.lifecycleMessages.length > 0) {
        for (const msg of fakeAdapterState.lifecycleMessages) {
          input.onLifecycle({
            type: 'message',
            agent: 'fake',
            version: input.version,
            text: msg.text,
            toolCalls: msg.toolCalls,
            atMs: Date.now()
          });
        }
      }
    };

    const emitEnd = (err?: RunError) => {
      if (!input.onLifecycle || input.version === undefined) return;
      if (err) {
        input.onLifecycle({
          type: 'failed',
          agent: 'fake',
          version: input.version,
          errorKind: err.kind,
          atMs: Date.now()
        });
      } else {
        input.onLifecycle({
          type: 'completed',
          agent: 'fake',
          version: input.version,
          atMs: Date.now()
        });
      }
    };

    if (input.spawnRuntime) {
      const spawnRes = input.spawnRuntime.spawn({
        command: 'fake',
        args: [],
        env: input.ownership?.env,
        cwd: input.cwd
      });
      emitStart();
      emitMessages();
      if (spawnRes.ready) {
        await spawnRes.ready;
      }
      if (fakeAdapterState.delayMs) {
        await new Promise(r => setTimeout(r, fakeAdapterState.delayMs));
      }
      const rawRes = await spawnRes.result;
      const err = isRepair || isTask ? fakeAdapterState.followUpError : fakeAdapterState.auditError;
      if (err) {
        emitEnd(err);
        return {
          stdout: rawRes.stdout || fakeAdapterState.stdout || '',
          exitCode: rawRes.exitCode,
          stderr: rawRes.stderr || fakeAdapterState.stderr,
          error: err
        };
      }
      if (isImplement) {
        if (relativePath && fakeAdapterState.writeVerdictFile) {
          const absolutePath = resolve(input.cwd, relativePath);
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, implementLedgerContent());
        }
        emitEnd();
        return {
          stdout: rawRes.stdout || fakeAdapterState.stdout || `Fake implementation completed`,
          exitCode: rawRes.exitCode,
          ...fakeTelemetry(),
        };
      }
    const isPlanningSet = input.skillId === '23-simple-create-plan' || input.skillId === '24-simple-create-spec';
      if (isTask) {
        if (relativePath && fakeAdapterState.writeVerdictFile) {
          if (isPlanningSet && fakeAdapterState.taskOutcome !== 'BLOCKED' && relativePath) {
            const outcome = simulatePlanningSetTask(
              input.cwd,
              input.skillId === '23-simple-create-plan' ? 'create-plan' : 'create-spec',
              input.prompt,
              relativePath,
            );
            if (outcome === 'interrupted') {
              emitEnd();
              return { stdout: rawRes.stdout || fakeAdapterState.stdout || 'Fake planning-set run interrupted', exitCode: rawRes.exitCode, ...fakeTelemetry() };
            }
          } else if (!isPlanningSet) {
            const absolutePath = resolve(input.cwd, relativePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, `# Fake task\n\n## Outcome\n\n${fakeAdapterState.taskOutcome ?? 'COMPLETED'}\n`);
          } else {
            const absolutePath = resolve(input.cwd, relativePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, `# Fake task\n\n## Outcome\n\nBLOCKED\n`);
          }
        }
        applyExtraWrites(input.cwd);
        emitEnd();
        return { stdout: rawRes.stdout || fakeAdapterState.stdout || 'Fake task completed', exitCode: rawRes.exitCode, ...fakeTelemetry() };
      }
      if (!isRepair) {
        const verdict = fakeAdapterState.verdicts.shift() || 'APPROVED';
        if (relativePath && fakeAdapterState.writeVerdictFile) {
          const absolutePath = resolve(input.cwd, relativePath);
          mkdirSync(dirname(absolutePath), { recursive: true });
          const heading = verdict === 'unknown' ? 'MALFORMED_OR_MISSING' : verdict;
          writeFileSync(absolutePath, `# Plan Audit\n\n## Verdict\n\n${heading}\n`);
        }
        emitEnd();
        return {
          stdout: rawRes.stdout || fakeAdapterState.stdout || `Fake run completed with verdict ${verdict}`,
          exitCode: rawRes.exitCode,
          ...fakeTelemetry(),
        };
      }
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath,
          `# Follow-up\n\n## Outcome\n\nCOMPLETED\n\nFiles patched: docs/dev/plan.md\n`);
      }
      const targetMatch = input.prompt.match(/Target document:\s*([^\r\n]+)/i);
      if (targetMatch?.[1]) {
        const relTarget = targetMatch[1].trim();
        if (relTarget !== '.' && relTarget !== 'none') {
          writeFileSync(resolve(input.cwd, relTarget), `\n# Patched by follow-up\n`, { flag: 'a' });
        }
      }
      emitEnd();
      return {
        stdout: rawRes.stdout || fakeAdapterState.stdout || `Fake repair completed`,
        exitCode: rawRes.exitCode,
        ...fakeTelemetry(),
      };
    }

    emitStart();

    if (fakeAdapterState.delayMs) {
      await new Promise(r => setTimeout(r, fakeAdapterState.delayMs));
    }

    if (fakeAdapterState.failAfterMs) {
      if (fakeAdapterState.failAfterMs > 0) {
        await new Promise(r => setTimeout(r, fakeAdapterState.failAfterMs));
      }
      const failErr: RunError = { kind: 'nonzero-exit', message: 'simulated failure' };
      emitEnd(failErr);
      return {
        stdout: fakeAdapterState.stdout ?? '',
        exitCode: 1,
        stderr: fakeAdapterState.stderr,
        error: failErr
      };
    }

    emitMessages();

    const err = isRepair || isTask ? fakeAdapterState.followUpError : fakeAdapterState.auditError;
    if (err) {
      emitEnd(err);
      return {
        stdout: fakeAdapterState.stdout ?? '',
        exitCode: fakeAdapterState.exitCode,
        stderr: fakeAdapterState.stderr,
        error: err
      };
    }

    if (isImplement) {
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, implementLedgerContent());
      }
      emitEnd();
      return {
        stdout: fakeAdapterState.stdout || `Fake implementation completed`,
        exitCode: fakeAdapterState.exitCode,
        ...fakeTelemetry(),
      };
    }

    if (isTask) {
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const isPlanningSet = input.skillId === '23-simple-create-plan' || input.skillId === '24-simple-create-spec';
        if (isPlanningSet && fakeAdapterState.taskOutcome !== 'BLOCKED' && relativePath) {
          const outcome = simulatePlanningSetTask(
            input.cwd,
            input.skillId === '23-simple-create-plan' ? 'create-plan' : 'create-spec',
            input.prompt,
            relativePath,
          );
          if (outcome === 'interrupted') {
            emitEnd();
            return { stdout: fakeAdapterState.stdout || 'Fake planning-set run interrupted', exitCode: fakeAdapterState.exitCode, ...fakeTelemetry() };
          }
        } else {
          const absolutePath = resolve(input.cwd, relativePath);
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, `# Fake task\n\n## Outcome\n\n${isPlanningSet ? 'BLOCKED' : (fakeAdapterState.taskOutcome ?? 'COMPLETED')}\n`);
        }
      }
      applyExtraWrites(input.cwd);
      emitEnd();
      return {
        stdout: fakeAdapterState.stdout || 'Fake task completed',
        exitCode: fakeAdapterState.exitCode,
        ...fakeTelemetry(),
      };
    }

    if (!isRepair) {
      // --- Audit path: consume exactly one verdict, write the audit artifact. ---
      const verdict = fakeAdapterState.verdicts.shift() || 'APPROVED';
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        const heading = verdict === 'unknown' ? 'MALFORMED_OR_MISSING' : verdict;
        writeFileSync(absolutePath, `# Plan Audit\n\n## Verdict\n\n${heading}\n`);
      }
      emitEnd();
      return {
        stdout: fakeAdapterState.stdout || `Fake run completed with verdict ${verdict}`,
        exitCode: fakeAdapterState.exitCode,
        ...fakeTelemetry(),
      };
    }

    // --- Follow-up path ---
    if (relativePath && fakeAdapterState.writeVerdictFile) {
      const absolutePath = resolve(input.cwd, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath,
        `# Follow-up\n\n## Outcome\n\nCOMPLETED\n\nFiles patched: docs/dev/plan.md\n`);
    }
    const targetMatch = input.prompt.match(/Target document:\s*([^\r\n]+)/i);
    if (targetMatch?.[1]) {
      const relTarget = targetMatch[1].trim();
      if (relTarget !== '.' && relTarget !== 'none') {
        writeFileSync(resolve(input.cwd, relTarget), `\n# Patched by follow-up\n`, { flag: 'a' });
      }
    }
    emitEnd();
    return {
      stdout: fakeAdapterState.stdout || `Fake repair completed`,
      exitCode: fakeAdapterState.exitCode,
      ...fakeTelemetry(),
    };
  }
};
