import type { AgentRegistry } from './adapters/registry.js';
import { getAdapter } from './adapters/registry.js';
import type { Config } from './config.js';
import type { Step } from './state.js';
import type { Runner } from './loops/runtime.js';
import { isValidEffortForModel, isValidModelForAgent, resolveRunner } from './runner.js';

/** The minimal provenance needed to decide whether a provider session can resume. */
export interface ResumeRecord {
  meta: {
    chainId?: string;
    skill: string;
    sessionId: string;
    agent: string;
    model: string;
    effort?: string;
  };
  decision?: string;
  completion?: string;
}

export interface ContinuityResult {
  mode: 'fresh' | 'resumed';
  sessionId?: string;
  freshReason?: 'policy' | 'no-compatible-session' | 'provider-unsupported';
}

/**
 * Return the latest same-skill record in a chain, respecting the accepted
 * boundary. Completion records are deliberately not boundaries: a completed
 * repair belongs to the ordinary evaluate/repair cycle.
 *
 * The generic shape is intentional. Runtime history uses ResumeRecord while
 * presentation derives from scanned Step objects; both consumers use this
 * one walk and therefore cannot acquire different boundary semantics.
 */
export function latestChainRunnerCandidate<T>(
  history: T[],
  chainId: string,
  skillId: string,
): T | undefined {
  const items = history.filter(item => {
    const value = item as any;
    return (value.meta?.chainId ?? value.chainId) === chainId;
  });

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]! as any;
    const itemSkill = item.meta?.skill ?? item.skillId;
    if (itemSkill === skillId) return items[i];
    if (item.decision === 'accepted') break;
  }
  return undefined;
}

/**
 * Preserve the runtime continuation predicate in one pure seam. The
 * predecessor parameter is retained for the binding-engine call contract;
 * session compatibility is determined from the canonical chain walk.
 */
export function resolveContinuity(
  _predecessor: unknown,
  runner: Runner,
  registry: AgentRegistry,
  sessionStrategy: string,
  skillId: string,
  allHistory: ResumeRecord[],
  chainId: string,
): ContinuityResult {
  if (sessionStrategy === 'fresh-per-invocation') {
    return { mode: 'fresh', freshReason: 'policy' };
  }

  const candidate = latestChainRunnerCandidate(allHistory, chainId, skillId);
  if (!candidate) {
    return { mode: 'fresh', freshReason: 'no-compatible-session' };
  }

  const sessionId = candidate.meta.sessionId;
  if (!sessionId || sessionId === 'none') {
    return { mode: 'fresh', freshReason: 'no-compatible-session' };
  }
  if (candidate.meta.agent !== runner.agent
    || candidate.meta.model !== runner.model
    || (candidate.meta.effort ?? undefined) !== (runner.effort ?? undefined)) {
    return { mode: 'fresh', freshReason: 'no-compatible-session' };
  }

  let adapter;
  try {
    adapter = getAdapter(registry, runner.agent);
  } catch {
    return { mode: 'fresh', freshReason: 'provider-unsupported' };
  }
  return adapter.capabilities.resumeSession
    ? { mode: 'resumed', sessionId }
    : { mode: 'fresh', freshReason: 'provider-unsupported' };
}

export interface RunnerPreselection {
  source: 'chain' | 'profile';
  agent: string;
  model: string;
  effort?: string;
  sessionStrategy?: string;
  sessionId?: string;
  fromStep?: { phase: string; version: number };
  fallbackReason?: string;
  note?: string;
}

export interface ContinuationRunnerDefaultsInput {
  steps: Step[];
  chainId: string;
  skillIds: string[];
  config: Config;
  registry: AgentRegistry;
}

function profilePreselection(
  skillId: string,
  config: Config,
  reason: string,
): RunnerPreselection {
  const runner = resolveRunner(skillId, config);
  return {
    source: 'profile',
    agent: runner.agent,
    model: runner.model,
    ...(runner.effort ? { effort: runner.effort } : {}),
    ...(runner.sessionStrategy ? { sessionStrategy: runner.sessionStrategy } : {}),
    fallbackReason: reason,
  };
}

/**
 * Derive the interactive continuation defaults. This is presentation state;
 * actual resume eligibility remains resolveContinuity's runtime predicate.
 */
export function continuationRunnerDefaults(
  input: ContinuationRunnerDefaultsInput,
): Map<string, RunnerPreselection> {
  const result = new Map<string, RunnerPreselection>();

  for (const skillId of input.skillIds) {
    const candidate = latestChainRunnerCandidate(input.steps, input.chainId, skillId);
    if (!candidate) {
      result.set(skillId, profilePreselection(skillId, input.config, 'no chain step for this skill'));
      continue;
    }

    const adapter = input.registry.adapters.get(candidate.agent);
    if (!adapter) {
      result.set(skillId, profilePreselection(skillId, input.config, 'unknown adapter'));
      continue;
    }

    const modelIsListed = input.config.registry.providers[candidate.agent]?.models.includes(candidate.model) ?? false;
    if (!isValidModelForAgent(candidate.agent, candidate.model, input.config.registry)) {
      result.set(skillId, profilePreselection(skillId, input.config, 'model no longer in catalogue'));
      continue;
    }

    if (candidate.effort && modelIsListed
      && !isValidEffortForModel(candidate.agent, candidate.model, candidate.effort, input.config.registry)) {
      result.set(skillId, profilePreselection(skillId, input.config, 'effort no longer offered'));
      continue;
    }

    const resumableSession = candidate.sessionId
      && candidate.sessionId !== 'none'
      && adapter.capabilities.resumeSession
      ? candidate.sessionId
      : undefined;
    result.set(skillId, {
      source: 'chain',
      agent: candidate.agent,
      model: candidate.model,
      ...(candidate.effort ? { effort: candidate.effort } : {}),
      ...(candidate.sessionStrategy ? { sessionStrategy: candidate.sessionStrategy } : {}),
      ...(resumableSession ? { sessionId: resumableSession } : {}),
      fromStep: { phase: candidate.kind, version: candidate.version },
      ...(candidate.agent === 'opencode' && !modelIsListed
        ? { note: 'model not in current catalogue' }
        : {}),
    });
  }
  return result;
}

