import { readFile, open } from 'node:fs/promises';
import { convertConfigurationV1 } from '../packages/application/src/config.js';
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4)
  throw new Error('Usage: bun run config:convert <schema-1.json> <schema-2.json>');
const converted = convertConfigurationV1(JSON.parse(await readFile(input, 'utf8')));
const file = await open(output, 'wx', 0o600);
try {
  await file.writeFile(`${JSON.stringify(converted, null, 2)}\n`);
  await file.sync();
} finally {
  await file.close();
}
