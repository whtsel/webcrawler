#!/usr/bin/env node
/* Integrity gate.
 *
 * The BlackBox Stream project rule is: the shipped server file is never
 * edited in place. If a change is ever needed it comes as a new version
 * from Drive, with a new hash recorded here.
 *
 * This script fails the build when server/bbx-vote-server.mjs is not
 * byte-identical to BlackBox Stream v75's bbx-vote-server.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'bbx-vote-server.mjs');

/* v75 — recorded in BBX-SERVER-HANDOFF-v75.md §2 */
const EXPECTED_SHA256 = '983f99b2f0e5919d5aaddd614dbadfa6bbdb2b382a1e722c0d48a3aae08f9ace';
const EXPECTED_SIZE = 12491;

let actualHash;
try {
  actualHash = createHash('sha256').update(readFileSync(SERVER)).digest('hex');
} catch (error) {
  console.error(`FAIL  cannot read ${path.relative(ROOT, SERVER)}: ${error.message}`);
  process.exit(1);
}

const actualSize = statSync(SERVER).size;
const problems = [];

if (actualHash !== EXPECTED_SHA256) {
  problems.push(`sha256 is ${actualHash}\n        expected ${EXPECTED_SHA256}`);
}
if (actualSize !== EXPECTED_SIZE) {
  problems.push(`size is ${actualSize} bytes (expected ${EXPECTED_SIZE})`);
}

if (problems.length) {
  console.error('FAIL  server/bbx-vote-server.mjs does not match v75');
  for (const problem of problems) console.error(`      ${problem}`);
  console.error('\nThis file ships byte-identical. Replace it with a new release from');
  console.error('Drive (and update EXPECTED_SHA256) rather than editing it here.');
  process.exit(1);
}

console.log(`ok    server/bbx-vote-server.mjs is v75, ${actualSize} bytes`);
console.log(`      sha256 ${actualHash}`);
