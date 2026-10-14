'use strict';

const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

function parseEvent() {
  const raw = process.argv[2];
  if (!raw) {
    return { source: 'local' };
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Event argument must be valid JSON.');
  }
}

async function main() {
  loadEnvFile(path.resolve(__dirname, '..', '.env'));

  const { handler } = require('./index.ts');
  const result = await handler(parseEvent());
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
