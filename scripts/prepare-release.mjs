import { readFileSync, writeFileSync } from 'node:fs';

const SCRIPT_PATH = 'yt-watch-later-tools.user.js';
const version = process.argv[2];

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!version) {
  fail('Usage: npm run release:prepare -- <semver>');
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`Invalid semver version: ${version}`);
}

const source = readFileSync(SCRIPT_PATH, 'utf8');
const current = source.match(/^(\/\/\s+@version\s+)(.+)$/m);
if (!current) {
  fail('Could not find @version in userscript metadata.');
}

const currentVersion = current[2].trim();
if (currentVersion === version) {
  console.log(`No change. @version is already ${version}`);
  process.exit(0);
}

const updated = source.replace(/^(\/\/\s+@version\s+).+$/m, `$1${version}`);
writeFileSync(SCRIPT_PATH, updated, 'utf8');

console.log(`Updated ${SCRIPT_PATH}: ${currentVersion} -> ${version}`);
console.log(`Next steps:\n  1) npm run verify\n  2) git add ${SCRIPT_PATH}\n  3) git commit -m \"release: v${version}\"\n  4) git tag v${version}\n  5) git push && git push --tags`);
