import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

import { smashAction } from './commands/smash.js';
import { statusAction } from './commands/status.js';

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
  .action(async (options) => {
    await smashAction(options);
  });

program
  .command('status')
  .description('Read-only: detect project state and render status panel')
  .option('-p, --project <path>', 'Path to the target project')
  .action(async (options) => {
    await statusAction(options);
  });

program.parse(process.argv);
