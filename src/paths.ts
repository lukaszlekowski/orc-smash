import { existsSync, realpathSync } from 'node:fs';
import { resolve as pathResolve, relative, isAbsolute, sep } from 'node:path';

/**
 * Purpose-named containment helper for project-owned paths.
 * Rejects absolute, lexical `..`-escaping, and symlink-escaping paths
 * that would leave `projectRoot`.
 */
export function assertWithinProject(
  projectRoot: string,
  relPath: string,
  label: string,
): void {
  if (isAbsolute(relPath)) {
    throw new Error(
      `${label} '${relPath}' must be a relative path within the project.`,
    );
  }
  const resolved = pathResolve(projectRoot, relPath);
  const normalized = relative(projectRoot, resolved);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(
      `${label} '${relPath}' escapes project root '${projectRoot}'.`,
    );
  }
}

/**
 * Validate that a not-yet-created output path's nearest existing parent
 * is under the project root.
 */
export function assertOutputWithinProject(
  projectRoot: string,
  relPath: string,
  label: string,
): void {
  assertWithinProject(projectRoot, relPath, label);
  const resolved = pathResolve(projectRoot, relPath);
  // Walk up to find the nearest existing parent
  let parent = resolved;
  while (parent !== pathResolve(parent, '..') && !existsSync(parent)) {
    parent = pathResolve(parent, '..');
  }
  const realRoot = existsSync(pathResolve(projectRoot))
    ? realpathSync(pathResolve(projectRoot))
    : pathResolve(projectRoot);
  const parentReal = existsSync(parent) ? realpathSync(parent) : parent;
  const parentRelative = relative(realRoot, parentReal);
  if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`)) {
    throw new Error(
      `${label} '${relPath}' nearest parent '${parent}' is outside project root.`,
    );
  }
}

/**
 * Validate that an existing input file is within the project root.
 */
export function assertInputWithinProject(
  projectRoot: string,
  relPath: string,
  label: string,
): void {
  assertWithinProject(projectRoot, relPath, label);
  if (relPath === '.' || relPath === './') return; // worktree target
  const resolved = pathResolve(projectRoot, relPath);
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(pathResolve(projectRoot));
    realPath = realpathSync(resolved);
  } catch {
    throw new Error(`${label} '${relPath}' does not exist.`);
  }
  const realRelative = relative(realRoot, realPath);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
    throw new Error(
      `${label} '${relPath}' resolves to '${realPath}' outside project root.`,
    );
  }
}

/** Validate a project-owned declaration without requiring the input to exist. */
export function assertDeclaredProjectPath(
  projectRoot: string,
  relPath: string,
  label: string,
): void {
  assertWithinProject(projectRoot, relPath, label);
  const resolved = pathResolve(projectRoot, relPath);
  if (!existsSync(resolved)) return;
  const realRoot = realpathSync(pathResolve(projectRoot));
  const realPath = realpathSync(resolved);
  const realRelative = relative(realRoot, realPath);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
    throw new Error(`${label} '${relPath}' resolves outside project root.`);
  }
}
