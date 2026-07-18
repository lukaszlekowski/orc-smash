#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compiledCli = resolve(here, '../dist/src/cli.js');

if (!existsSync(compiledCli)) {
  process.stderr.write('orc: build output not found. Run `pnpm build` first.\n');
  process.exitCode = 127;
} else {
  try {
    const { main } = await import(pathToFileURL(compiledCli).href);
    await main(process.argv);
  } catch (error) {
    process.stderr.write(`orc: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
