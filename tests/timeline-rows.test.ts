import { describe, expect, it } from 'vitest';
import type { GlobalSnapshot, Step } from '../src/state.js';
import { buildTimelineRows, latestVersionForBinding } from '../src/timeline-rows.js';

function step(overrides: Partial<Step>): Step {
  return {
    kind: 'evaluate',
    bindingId: 'plan',
    bindingKind: 'loop',
    role: 'auditor',
    agent: 'fake',
    model: 'fake-model',
    version: 1,
    status: 'done',
    artifactPath: '/tmp/artifact.md',
    mtime: 0,
    ...overrides,
  };
}

function snapshot(steps: Step[]): GlobalSnapshot {
  return {
    steps,
    byBinding: new Map(),
    unclassified: steps.filter(item => item.unclassified),
    missingInputs: new Map(),
    inputAvailability: new Map(),
    interruptedMarker: null,
  };
}

describe('buildTimelineRows', () => {
  it('classifies rows with unclassified and current-chain precedence', () => {
    const currentChain = step({ chainId: 'chain-a', pipelineId: 'pipe', pipelineRunId: 'run' });
    const currentRun = step({ chainId: 'chain-b', pipelineId: 'pipe', pipelineRunId: 'run' });
    const unrelated = step({ chainId: 'chain-c', pipelineId: 'other', pipelineRunId: 'other-run' });
    const unclassified = step({ chainId: 'chain-a', unclassified: true, unclassifiedReason: 'bad identity' });

    const rows = buildTimelineRows(snapshot([currentChain, currentRun, unrelated, unclassified]), {
      chainId: 'chain-a',
      pipelineId: 'pipe',
      pipelineRunId: 'run',
      bindingId: 'plan',
    });

    expect(rows.map(row => row.relevance)).toEqual([
      'current-chain', 'current-run', 'unrelated', 'unclassified',
    ]);
    expect(rows.map(row => row.step)).toEqual([currentChain, currentRun, unrelated, unclassified]);
  });

  it('does not mutate authoritative steps and includes other bindings in scanner order', () => {
    const steps = [
      step({ bindingId: 'plan', mtime: 1, chainId: 'chain-a' }),
      step({ bindingId: 'implement', bindingKind: 'task', kind: 'task', mtime: 2, chainId: 'chain-b' }),
    ];
    const before = structuredClone(steps);
    const rows = buildTimelineRows(snapshot(steps), {
      chainId: 'chain-a',
      pipelineId: null,
      pipelineRunId: null,
      bindingId: 'plan',
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]!.relevance).toBe('unrelated');
    expect(steps).toEqual(before);
  });
});

describe('latestVersionForBinding', () => {
  it('uses the global binding history and counts the in-flight version', () => {
    const steps = [
      step({ bindingId: 'plan', version: 3 }),
      step({ bindingId: 'implement', version: 99 }),
    ];
    expect(latestVersionForBinding(snapshot(steps), 'plan', 4)).toBe(4);
    expect(latestVersionForBinding(snapshot(steps), 'plan', 0)).toBe(3);
    expect(latestVersionForBinding(snapshot(steps), 'missing', 0)).toBe(0);
  });
});
