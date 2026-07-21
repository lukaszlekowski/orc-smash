import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { sha256 } from './pipeline-state.js';
import { patternToRegex } from './patterns.js';
import type { TargetSpec, V1Manifest } from './manifest.js';
import { assertInputWithinProject } from './paths.js';

/**
 * Capture the semantic target state used by provenance and eligibility.
 *
 * A worktree snapshot deliberately uses the complete visible tree rather than
 * HEAD alone. That makes staged, unstaged, and untracked edits observable even
 * in a scratch directory that is not a Git checkout. Harness output paths and
 * durable runtime records are excluded so writing an artifact cannot make the
 * target appear changed.
 */
export function captureTargetSnapshot(
  projectRoot: string,
  target: TargetSpec,
  manifest: V1Manifest,
): string {
  const targetPath = target.kind === 'worktree'
    ? resolve(projectRoot)
    : resolve(projectRoot, target.path);

  if (!existsSync(targetPath)) {
    throw new Error(`Target '${target.path}' does not exist in project '${projectRoot}'.`);
  }

  if (target.kind === 'file') {
    assertInputWithinProject(projectRoot, target.path, 'Target');
    return `file\n${relative(projectRoot, targetPath)}\n${sha256(readFileSync(targetPath))}`;
  }

  const outputMatchers = outputPatterns(manifest).map(patternToRegex);
  const gitSnapshot = getGitWorktreeSnapshot(projectRoot, outputMatchers);
  if (gitSnapshot) return gitSnapshot;

  const entries: string[] = [];
  walk(projectRoot, projectRoot, outputMatchers, entries);
  entries.sort();
  return `worktree\n${entries.join('\n')}`;
}

import { execSync } from 'node:child_process';

function parseDiffLine(line: string): { srcMode: string; dstMode: string; srcSha: string; dstSha: string; status: string; file: string } | null {
  const match = line.match(/^:(\d+) (\d+) ([a-f0-9.]+) ([a-f0-9.]+) ([A-Z]+)\s+(.+)$/);
  if (!match) return null;
  return {
    srcMode: match[1]!,
    dstMode: match[2]!,
    srcSha: match[3]!,
    dstSha: match[4]!,
    status: match[5]!,
    file: match[6]!,
  };
}

function getGitWorktreeSnapshot(projectRoot: string, outputMatchers: RegExp[]): string | null {
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
    if (!isGit) return null;

    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const stagedRaw = execSync('git diff-index --cached HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const stagedEntries: string[] = [];
    if (stagedRaw) {
      for (const line of stagedRaw.split('\n')) {
        const parsed = parseDiffLine(line);
        if (!parsed) continue;
        const { dstMode, dstSha, file } = parsed;
        if (outputMatchers.some(m => m.test(file)) || file.startsWith('.orc-smash')) continue;
        stagedEntries.push(`${file}:${dstMode}:${dstSha}`);
      }
    }

    const unstagedRaw = execSync('git diff-files', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const unstagedEntries: string[] = [];
    if (unstagedRaw) {
      for (const line of unstagedRaw.split('\n')) {
        const parsed = parseDiffLine(line);
        if (!parsed) continue;
        const { dstMode, dstSha, status, file } = parsed;
        if (outputMatchers.some(m => m.test(file)) || file.startsWith('.orc-smash')) continue;

        let hash = dstSha;
        if (status !== 'D') {
          const abs = resolve(projectRoot, file);
          if (existsSync(abs)) {
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink()) {
              hash = sha256(`symlink:${readlinkSync(abs)}`);
            } else if (stat.isFile()) {
              hash = sha256(readFileSync(abs));
            }
          }
        }
        unstagedEntries.push(`${file}:${dstMode}:${hash}`);
      }
    }

    const untrackedRaw = execSync('git ls-files --others --exclude-standard', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const untrackedEntries: string[] = [];
    if (untrackedRaw) {
      for (const rel of untrackedRaw.split('\n')) {
        if (!rel || outputMatchers.some(m => m.test(rel)) || rel.startsWith('.orc-smash') || rel.startsWith('.git')) continue;
        const abs = resolve(projectRoot, rel);
        if (existsSync(abs)) {
          const stat = lstatSync(abs);
          if (stat.isSymbolicLink()) {
            untrackedEntries.push(`${rel}:symlink:${sha256(`symlink:${readlinkSync(abs)}`)}`);
          } else if (stat.isFile()) {
            untrackedEntries.push(`${rel}:${sha256(readFileSync(abs))}`);
          }
        }
      }
    }

    return [
      'worktree:git',
      `head:${head}`,
      `staged:${stagedEntries.sort().join(';')}`,
      `unstaged:${unstagedEntries.sort().join(';')}`,
      `untracked:${untrackedEntries.sort().join(';')}`,
    ].join('\n');
  } catch {
    return null;
  }
}

/** Return a digest rather than exposing the serialized snapshot in provenance. */
export function captureTargetFingerprint(
  projectRoot: string,
  target: TargetSpec,
  manifest: V1Manifest,
): string {
  return sha256(captureTargetSnapshot(projectRoot, target, manifest));
}

/** Capture declared project-file inputs in canonical key order. */
export function captureFileDigests(
  projectRoot: string,
  files: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(files ?? {}).sort()) {
    const path = resolve(projectRoot, files![key]!);
    if (!existsSync(path)) {
      throw new Error(`Project input '${files![key]}' for '${key}' does not exist.`);
    }
    assertInputWithinProject(projectRoot, files![key]!, `Project input '${key}'`);
    result[key] = sha256(readFileSync(path));
  }
  return result;
}

function outputPatterns(manifest: V1Manifest): string[] {
  const patterns: string[] = [];
  for (const loop of Object.values(manifest.loops ?? {})) {
    patterns.push(loop.evaluate.output.pattern, loop.repair.output.pattern);
  }
  for (const task of Object.values(manifest.tasks ?? {})) {
    patterns.push(task.output.pattern);
  }
  return patterns;
}

function walk(
  root: string,
  current: string,
  outputMatchers: RegExp[],
  entries: string[],
): void {
  for (const name of readdirSync(current).sort()) {
    if (name === '.git' || name === '.orc-smash' || name === 'archived') continue;
    const absolute = join(current, name);
    const rel = relative(root, absolute);
    if (rel.split('/').includes('archived')) continue;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      walk(root, absolute, outputMatchers, entries);
      continue;
    }
    if (outputMatchers.some((matcher) => matcher.test(rel))) continue;
    if (stat.isSymbolicLink()) {
      entries.push(`${rel}\nsymlink:${readlinkSync(absolute)}`);
      continue;
    }
    if (stat.isFile()) {
      entries.push(`${rel}\nfile:${sha256(readFileSync(absolute))}`);
    }
  }
}
