import { readFileSync } from 'node:fs';

const SCRIPT_PATH = 'yt-watch-later-tools.user.js';

try {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  // Parse-only validation without executing script content.
  // eslint-disable-next-line no-new-func
  new Function(source);
  console.log(`OK: ${SCRIPT_PATH} syntax is valid.`);
} catch (err) {
  console.error(`ERROR: syntax check failed for ${SCRIPT_PATH}`);
  if (err instanceof Error) {
    console.error(err.message);
  }
  process.exit(1);
}
