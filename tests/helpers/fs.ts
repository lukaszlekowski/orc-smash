import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a unique temp directory inside the project root under a given name.
 */
export function createTempDir(name: string): string {
  const dirPath = join(process.cwd(), name);
  if (existsSync(dirPath)) {
    rmSync(dirPath, { recursive: true, force: true });
  }
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Writes the Batch 8 planning-set documents (`docs/dev/spec.md` and
 * `docs/dev/plan.md`) into a test project so packaged bindings that declare
 * `specPath`/`planPath` are preflighted. Use in workspace setups that
 * exercise the plan, implement, or review bindings.
 */
export function writePlanningSet(project: string): void {
  const devDir = join(project, 'docs/dev');
  mkdirSync(devDir, { recursive: true });
  writeFileSync(
    join(devDir, 'spec.md'),
    '# Specification\n\n## Acceptance Criteria\n\n1. The feature works end to end.\n',
  );
  writeFileSync(
    join(devDir, 'plan.md'),
    '---\nstatus: ready\nconfidence: 0.96\n---\n\n# Plan\n',
  );
}

/**
 * Safely removes the directory at the given path.
 */
export function removeTempDir(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Runs a function within the context of a temporary directory.
 * Safely creates the directory before executing the function, and guarantees
 * its deletion after completion or failure.
 */
export async function withTempDir(
  name: string,
  fn: (dir: string) => Promise<void> | void
): Promise<void> {
  const dirPath = createTempDir(name);
  try {
    await fn(dirPath);
  } finally {
    removeTempDir(dirPath);
  }
}
