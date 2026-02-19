import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCE_PATH = 'yt-watch-later-tools.user.js';
const DIST_DIR = 'dist';
const DIST_PATH = `${DIST_DIR}/yt-watch-later-tools.user.js`;

const source = readFileSync(SOURCE_PATH, 'utf8');
mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(DIST_PATH, source, 'utf8');
console.log(`Built ${DIST_PATH}`);
