import protobuf from 'protobufjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = 'packages/protocol/proto';
const sources = JSON.parse(await readFile(`${directory}/sources.json`, 'utf8')) as {
  sha256: Record<string, string>;
};
for (const [name, digest] of Object.entries(sources.sha256)) {
  const bytes = await readFile(`${directory}/${name}`);
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error('Protocol source checksum mismatch');
}
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => `${directory}/${target}`;
await root.load([
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
  'google/rpc/status.proto',
]);
await writeFile(
  'packages/protocol/src/traces/descriptor.json',
  JSON.stringify(root.toJSON(), null, 2) + '\n',
);
const formatted = await import('node:child_process');
if (
  formatted.spawnSync('bun', ['fmt', 'packages/protocol/src/traces/descriptor.json'], {
    stdio: 'inherit',
  }).status !== 0
)
  throw new Error('Protocol descriptor formatting failed');
