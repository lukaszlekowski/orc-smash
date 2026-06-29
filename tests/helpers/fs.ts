import { mkdirSync, rmSync, existsSync } from 'node:fs';
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
