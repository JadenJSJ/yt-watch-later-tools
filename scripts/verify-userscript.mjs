import { readFileSync } from 'node:fs';

const SCRIPT_PATH = 'yt-watch-later-tools.user.js';
const source = readFileSync(SCRIPT_PATH, 'utf8');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const metaMatch = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
if (!metaMatch) {
  fail('Missing userscript metadata block.');
}

const metadataBlock = metaMatch[0];
const metaLines = metadataBlock
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('// @'));

const fields = new Map();
for (const line of metaLines) {
  const parsed = line.match(/^\/\/\s+@(\S+)\s+(.+)$/);
  if (!parsed) continue;
  const [, key, value] = parsed;
  if (!fields.has(key)) fields.set(key, []);
  fields.get(key).push(value.trim());
}

const requiredSingleFields = ['name', 'namespace', 'version', 'description', 'run-at'];
for (const field of requiredSingleFields) {
  const values = fields.get(field) || [];
  if (values.length === 0) fail(`Missing @${field}.`);
  if (values.length > 1) fail(`@${field} must appear exactly once.`);
}

const matchValues = fields.get('match') || [];
if (matchValues.length === 0) {
  fail('Missing at least one @match entry.');
}

const version = fields.get('version')[0];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`@version is not valid SemVer: ${version}`);
}

const namespace = fields.get('namespace')[0];
if (!namespace.startsWith('https://')) {
  fail('@namespace should be an https URL.');
}

const urlFields = ['homepageURL', 'supportURL', 'updateURL', 'downloadURL'];
for (const field of urlFields) {
  const values = fields.get(field) || [];
  for (const value of values) {
    if (!value.startsWith('https://')) {
      fail(`@${field} must use https: ${value}`);
    }
  }
}

if (!source.includes("'use strict';")) {
  fail("Script should explicitly use strict mode.");
}

if (!/^\(function \(\) \{/.test(source.slice(metaMatch.index + metaMatch[0].length).trimStart())) {
  fail('Script should be wrapped in an IIFE immediately after metadata.');
}

console.log(`OK: ${SCRIPT_PATH} metadata and structure checks passed.`);
