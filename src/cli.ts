import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { smashAction } from './commands/smash.js';
import { statusAction } from './commands/status.js';
import { createPanelCliOutput, createPlainCliOutput } from './cli-output.js';
import { handleInterruptSignal } from './interrupted-artifact.js';
import { ownershipStatusAction, ownershipReleaseAction } from './commands/ownership-recovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
let version = '1.0.0';
try {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch {
  // Ignore
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('orc')
    .description('orc-smash: A thin TypeScript CLI harness for coding-agent CLIs')
    .version(version);

  program
    .command('smash')
    .description('Run the audit ↔ follow-up loop against a target project')
    .option('-p, --project <path>', 'Path to the target project')
    .option('-l, --loop <loop-name>', 'Loop name to run')
    .option('-a, --agent <agent-name>', 'Global override for agent')
    .option('-m, --model <model-name>', 'Global override for model')
    .option('-i, --max-iterations <iterations>', 'Maximum audit iterations', '5')
    .option('--debug-spawn', 'Write spawn/process debug logs to docs/dev/spawn-debug.log')
    .option('--debug-spawn-file <path>', 'Override the spawn/process debug log path')
    .option('--plain', 'Plain append-only line-oriented output (no spinners, no screen clears)')
    .action(async (options) => {
      const projectRoot = options.project ? resolve(options.project) : process.cwd();
      const output = options.plain ? createPlainCliOutput(projectRoot) : createPanelCliOutput(projectRoot);
      const result = await smashAction({ ...options, output });
      process.exitCode = result.exitCode;
    });

  program
    .command('status')
    .description('Read-only: detect project state and render status panel')
    .option('-p, --project <path>', 'Path to the target project')
    .option('-a, --all', 'Show artifacts across all loops')
    .action(async (options) => {
      const projectRoot = options.project ? resolve(options.project) : process.cwd();
      const output = createPanelCliOutput(projectRoot);
      const result = await statusAction({ ...options, output });
      process.exitCode = result.exitCode;
    });

  program
    .command('supervisor-contract')
    .description('Report the runtime contract consumed by orc-smash-supervisor')
    .action(() => {
      process.stdout.write(JSON.stringify({
        kind: 'orc-smash-supervisor-contract',
        schemaVersion: 1,
        ownershipSchemaVersion: 1,
        pid: process.pid
      }) + '\n');
    });

  const ownership = program
    .command('ownership')
    .description('Inspect or explicitly release retained owned-run admission');

  ownership
    .command('status')
    .description('Read-only ownership diagnostics; never signals or mutates state')
    .requiredOption('-p, --project <path>', 'Path to the target project')
    .action(async (options) => {
      const projectRoot = resolve(options.project);
      const output = createPlainCliOutput(projectRoot);
      const result = await ownershipStatusAction({ project: projectRoot, output });
      process.exitCode = result.exitCode;
    });

  ownership
    .command('release')
    .description('Release retained admission after operator verification; never kills processes')
    .requiredOption('-p, --project <path>', 'Path to the target project')
    .option('--yes', 'Assert that separate inspection found no owned process remaining')
    .action(async (options) => {
      const projectRoot = resolve(options.project);
      const output = createPlainCliOutput(projectRoot);
      const result = await ownershipReleaseAction({ project: projectRoot, output, yes: options.yes });
      process.exitCode = result.exitCode;
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`orc: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

// §3: delegate SIGINT/SIGTERM to the interrupt-context API. cli.ts owns no
// mutable run context — it only forwards the signal to the runtime module that
// does. handleInterruptSignal writes an interrupted marker for the active step
// (if any), terminates active provider children (SIGTERM → SIGKILL), and exits
// with the conventional signal code. No-op safe before setup / after completion.
const onInterrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
  void handleInterruptSignal(signal);
};
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));
