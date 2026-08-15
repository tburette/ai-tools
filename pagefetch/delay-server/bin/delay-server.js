#!/usr/bin/env node

import { parseArgs, HELP_TEXT } from '../src/cli.js';
import { createServer } from '../src/server.js';
import { readFileSync } from 'fs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

let final = args.final;
let initial = args.initial;

if (args.finalFile) {
  final = readFileSync(args.finalFile, 'utf-8');
}

if (args.initialFile) {
  initial = readFileSync(args.initialFile, 'utf-8');
}

const server = await createServer({
  final,
  initial,
  delay: args.delay,
  port: args.port
});

const { port } = server.address();
console.log(`Delay server running at http://localhost:${port}`);
console.log(`Initial content: "${initial}"`);
console.log(`Actual content: "${final}"`);
console.log(`Delay: ${args.delay}ms`);
