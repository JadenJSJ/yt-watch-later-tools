const targets = [
  { name: 'Greasy Fork', key: 'GREASYFORK_WEBHOOK_URL' },
  { name: 'OpenUserJS', key: 'OPENUSERJS_WEBHOOK_URL' },
];

const tag = process.env.RELEASE_TAG || 'manual';

let configured = 0;
let failures = 0;

for (const target of targets) {
  const url = process.env[target.key];
  if (!url) {
    console.log(`SKIP: ${target.name} (${target.key} not set)`);
    continue;
  }

  configured += 1;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'local-manual', tag }),
    });

    if (!response.ok) {
      failures += 1;
      console.error(`FAIL: ${target.name} webhook returned ${response.status}`);
      continue;
    }

    console.log(`OK: ${target.name} webhook accepted request`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${target.name} webhook request error: ${message}`);
  }
}

if (configured === 0) {
  console.error('No webhook URLs configured. Set .env values or export environment variables first.');
  process.exit(1);
}

if (failures > 0) {
  process.exit(1);
}

