import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { smashAction } from './commands/smash.js';
import { statusAction } from './commands/status.js';
import { createPanelCliOutput, createPlainCliOutput } from './cli-output.js';
import { handleInterruptSignal } from './interrupted-artifact.js';

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
      const output = options.plain ? createPlainCliOutput() : createPanelCliOutput();
      const result = await smashAction({ ...options, output });
      process.exitCode = result.exitCode;
    });

  program
    .command('status')
    .description('Read-only: detect project state and render status panel')
    .option('-p, --project <path>', 'Path to the target project')
    .option('-a, --all', 'Show artifacts across all loops')
    .action(async (options) => {
      const output = createPanelCliOutput();
      const result = await statusAction({ ...options, output });
      process.exitCode = result.exitCode;
    });

  return program;
}

const program = buildProgram();

const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
);

if (isMain) {
  program.parse(process.argv);
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
