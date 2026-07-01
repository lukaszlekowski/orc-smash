import chalk, { type ChalkInstance } from 'chalk';
import type { PanelContext } from './status.js';
import type { StepKind, StepStatus } from './state.js';

export interface RoleAccent {
  chalk: ChalkInstance;
  label: string;
}

export interface KindAccent {
  chalk: ChalkInstance;
  label: string;
}

export interface StatusAccent {
  chalk: ChalkInstance;
  label: string;
}

export type PanelBorderColor = 'cyan' | 'yellow' | 'green' | 'red' | 'blue';

const roleMap: Record<string, RoleAccent> = {
  auditor: { chalk: chalk.cyan, label: 'auditor' },
  planner: { chalk: chalk.yellow, label: 'planner' },
  reviewer: { chalk: chalk.magenta, label: 'reviewer' },
  implementer: { chalk: chalk.green, label: 'implementer' }
};

const defaultRoleAccent: RoleAccent = { chalk: chalk.gray, label: 'unknown' };

export function roleAccent(role: string): RoleAccent {
  return roleMap[role] ?? defaultRoleAccent;
}

const kindMap: Record<StepKind, KindAccent> = {
  audit: { chalk: chalk.cyan, label: 'audit' },
  'follow-up': { chalk: chalk.yellow, label: 'follow-up' },
  implement: { chalk: chalk.green, label: 'implement' }
};

export function kindAccent(kind: StepKind): KindAccent {
  return kindMap[kind];
}

const statusMap: Record<StepStatus, StatusAccent> = {
  running: { chalk: chalk.yellow, label: 'running' },
  failed: { chalk: chalk.red, label: 'failed' },
  done: { chalk: chalk.gray, label: 'done' },
  interrupted: { chalk: chalk.magenta, label: 'interrupted' }
};

export function statusAccent(status: StepStatus): StatusAccent {
  return statusMap[status];
}

export function inFlightRole(kind: StepKind): string {
  const map: Record<StepKind, string> = {
    audit: 'auditor',
    'follow-up': 'planner',
    implement: 'implementer'
  };
  return map[kind];
}

export function panelBorderColor(ctx: PanelContext): PanelBorderColor {
  if (ctx.inFlight?.status === 'failed') {
    return 'red';
  }

  if (ctx.inFlight) {
    const map: Record<StepKind, PanelBorderColor> = {
      audit: 'cyan',
      'follow-up': 'yellow',
      implement: 'green'
    };
    return map[ctx.inFlight.kind];
  }

  const last = ctx.timeline[ctx.timeline.length - 1];
  if (last?.status === 'failed') {
    return 'red';
  }

  if (last) {
    const map: Record<StepKind, PanelBorderColor> = {
      audit: 'cyan',
      'follow-up': 'yellow',
      implement: 'green'
    };
    return map[last.kind] ?? 'blue';
  }

  return 'blue';
}


