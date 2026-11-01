import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli, symbolicateEvent, type CliIO } from '../index.js';
import type { StoredEvent } from '../../../protocol/src/types.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-cli-'));
  directories.push(directory);
  return directory;
}
function ioFixture(
  fetcher: typeof fetch = vi.fn(async () => Response.json({ ok: true })) as typeof fetch,
): CliIO & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
    env: {
      TELEMETRY_TOKEN: `reader.${'s'.repeat(32)}`,
      TELEMETRY_ENDPOINTS: 'https://telemetry.example',
    },
    fetch: fetcher,
    output,
    errors,
  };
}
function page(cursor: string | null, ids: string[]) {
  return {
    items: ids.map((id) => ({ ...event(), properties: { marker: id } })),
    next_cursor: cursor,
    query_id: 'query',
    consistency: 'primary_committed',
    pagination: 'live-pagination',
    range: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
  };
}
const filters = [
  '--environment',
  'production',
  '--from',
  '2026-11-01T00:00:00.000Z',
  '--to',
  '2026-11-02T00:00:00.000Z',
];
it.each([500, 502, 503, 504])(
  'regression: HTTP %s switches to a healthy endpoint and releases the failed body',
  async (status) => {
    const cancelled = vi.fn();
    const failed = new Response(new ReadableStream({ cancel: cancelled }), { status });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(Response.json({ api_version: '1', project_id: 'healthy-project' }));
    const io = ioFixture(fetcher);
    io.env.TELEMETRY_ENDPOINTS = 'https://zone-a.example,https://zone-b.example';
    expect(await runCli(['doctor'], io)).toBe(0);
    expect(fetcher.mock.calls.map(([url]) => (url as URL).href)).toEqual([
      'https://zone-a.example/v1/doctor',
      'https://zone-b.example/v1/doctor',
    ]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ project_id: 'healthy-project' });
  },
);
it('regression: unavailable endpoints exhaust one bounded round and release every response', async () => {
  const cancelled = vi.fn();
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }),
  );
  const io = ioFixture(fetcher);
  io.env.TELEMETRY_ENDPOINTS = 'https://zone-a.example,https://zone-b.example';
  expect(await runCli(['doctor'], io)).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(cancelled).toHaveBeenCalledTimes(2);
  expect(io.output).toEqual([]);
});
it('passes event/error commands and identity through HTTP without printing the token', async () => {
  const io = ioFixture();
  expect(
    await runCli(['events', 'list', '--environment', 'production', '--service', 'web'], io),
  ).toBe(0);
  expect((vi.mocked(io.fetch).mock.calls[0]![0] as URL).href).toBe(
    'https://telemetry.example/v1/events?environment=production&service=web',
  );
  expect(
    await runCli(
      [
        'errors',
        'get',
        '--environment',
        'production',
        '--service',
        'web',
        '--source',
        'server',
        '--id',
        '44bf94dc-17a7-4462-9528-dd16b4978cad',
      ],
      io,
    ),
  ).toBe(0);
  expect((vi.mocked(io.fetch).mock.calls[1]![0] as URL).href).toContain(
    '/v1/errors/server/44bf94dc-17a7-4462-9528-dd16b4978cad?environment=production&service=web',
  );
  expect(io.output.join('')).not.toContain(io.env.TELEMETRY_TOKEN);
});
it.each([
  ['events', 'list', '--token', 'private'],
  ['events', 'get', '--environment', 'production'],
  ['unknown'],
  ['events', 'list', '--environment', 'production', '--environment', 'other'],
])('rejects malformed commands and secret command parameters: %j', async (...argv) => {
  const io = ioFixture();
  expect(await runCli(argv as string[], io)).toBe(2);
  expect(io.fetch).not.toHaveBeenCalled();
  expect(io.errors.join('')).not.toContain('private');
});
it('requires 0600 credentials owned by current user', async () => {
  const directory = await temp();
  const path = join(directory, 'credentials.json');
  await writeFile(
    path,
    JSON.stringify({ token: `reader.${'x'.repeat(32)}`, endpoints: ['https://telemetry.example'] }),
    { mode: 0o644 },
  );
  const io = ioFixture();
  io.env = {};
  expect(await runCli(['doctor', '--credentials', path], io)).toBe(1);
  await chmod(path, 0o600);
  expect(await runCli(['doctor', '--credentials', path], io)).toBe(0);
});
it('does not follow insecure endpoints, redirects, or put secrets into URL', async () => {
  const io = ioFixture();
  io.env.TELEMETRY_ENDPOINTS = 'https://user:password@telemetry.example';
  expect(await runCli(['doctor'], io)).toBe(2);
  io.env.TELEMETRY_ENDPOINTS = 'http://public.example';
  expect(await runCli(['doctor'], io)).toBe(2);
  expect(io.fetch).not.toHaveBeenCalled();
});
it('rotates endpoints on connection failure and does not rotate after quota response', async () => {
  const io = ioFixture(
    vi
      .fn()
      .mockRejectedValueOnce(new Error('connection'))
      .mockResolvedValueOnce(
        Response.json({ api_version: '1', services: ['web'] }),
      ) as typeof fetch,
  );
  io.env.TELEMETRY_ENDPOINTS = 'https://a.example,https://b.example';
  expect(await runCli(['doctor'], io)).toBe(0);
  expect(io.output.join('')).toContain('cli_version');
  expect(io.fetch).toHaveBeenCalledTimes(2);
  vi.mocked(io.fetch)
    .mockReset()
    .mockResolvedValue(new Response('', { status: 429 }));
  expect(await runCli(['doctor'], io)).toBe(1);
  expect(io.fetch).toHaveBeenCalledTimes(1);
});
it('writes all export pages to NDJSON and a complete live-pagination manifest', async () => {
  const directory = await temp();
  const output = join(directory, 'events.ndjson');
  const io = ioFixture(
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(page('next-signed-cursor', ['a', 'b'])))
      .mockResolvedValueOnce(Response.json(page(null, ['c']))) as typeof fetch,
  );
  expect(await runCli(['export', ...filters, '--out', output], io)).toBe(0);
  expect(
    (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).properties.marker),
  ).toEqual(['a', 'b', 'c']);
  const manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'));
  expect(manifest).toMatchObject({ count: 3, complete: true, pagination: 'live-pagination' });
  expect(manifest.limitations).toContain('retention expiry');
  expect(manifest.filter_digest).toMatch(/^[a-f0-9]{64}$/);
  expect((vi.mocked(io.fetch).mock.calls[1]![0] as URL).href).toContain(
    'cursor=next-signed-cursor',
  );
});
it('records partial exports with exit 3 after a later-page failure', async () => {
  const directory = await temp();
  const output = join(directory, 'partial.ndjson');
  const io = ioFixture(
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(page('next', ['a'])))
      .mockResolvedValueOnce(new Response('', { status: 503 })) as typeof fetch,
  );
  expect(await runCli(['export', ...filters, '--out', output], io)).toBe(3);
  expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'))).toMatchObject({
    count: 1,
    complete: false,
  });
});
it('rejects repeated pagination cursors and preserves partial output', async () => {
  const directory = await temp();
  const output = join(directory, 'cycle.ndjson');
  const io = ioFixture(
    vi.fn().mockImplementation(async () => Response.json(page('same', ['a']))) as typeof fetch,
  );
  expect(await runCli(['export', ...filters, '--out', output], io)).toBe(3);
  expect(io.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')).complete).toBe(false);
});
it('rejects malformed pages rather than marking an export complete', async () => {
  const directory = await temp();
  const output = join(directory, 'invalid.ndjson');
  const io = ioFixture(vi.fn(async () => Response.json({ items: [] })) as typeof fetch);
  expect(await runCli(['export', ...filters, '--out', output], io)).toBe(3);
  expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')).count).toBe(0);
});
function event(): StoredEvent {
  return {
    id: '44bf94dc-17a7-4462-9528-dd16b4978cad',
    occurred_at: '2026-11-01T00:00:00.000Z',
    kind: 'error',
    name: 'runtime.error',
    properties: {},
    project_id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f',
    environment: 'production',
    service: 'web',
    source: 'browser',
    release: 'v1',
    build_id: 'build-a',
    received_at: '2026-11-01T00:00:00.000Z',
    retain_until: '2026-12-01T00:00:00.000Z',
    policy_version: '1',
    clock_skew_ms: 0,
    error: {
      type: 'Error',
      mechanism: 'manual',
      handled: true,
      frames: [{ file: '/app.js', function: 'a', line: 1, column: 0 }],
    },
  };
}
async function build(directory: string, files = { '/app.js': 'app.js.map' }) {
  await writeFile(
    join(directory, '.telemetry-build.json'),
    JSON.stringify({ service: 'web', release: 'v1', build_id: 'build-a', files }),
  );
  await writeFile(
    join(directory, 'app.js.map'),
    JSON.stringify({
      version: 3,
      sources: ['src/run.ts'],
      names: ['run'],
      mappings: 'AAAAA',
      sourcesContent: ['throw new Error()'],
    }),
  );
}
it('symbolicates a hand-calculated one-based line and zero-based column only from a matching build', async () => {
  const directory = await temp();
  await build(directory);
  const result = await symbolicateEvent(event(), directory);
  expect(result.error!.frames[0]).toEqual({
    file: 'src/run.ts',
    function: 'run',
    line: 1,
    column: 0,
  });
  expect(event().error!.frames[0]!.file).toBe('/app.js');
  const mismatch = event();
  mismatch.build_id = 'another-build';
  await expect(symbolicateEvent(mismatch, directory)).rejects.toThrow('does not match');
});
it('rejects source-map path traversal and symlink escapes without network access', async () => {
  const directory = await temp();
  const outside = await temp();
  await writeFile(join(outside, 'outside.map'), '{}');
  await build(directory, { '/app.js': '../outside.map' });
  await expect(symbolicateEvent(event(), directory)).rejects.toThrow();
  await symlink(join(outside, 'outside.map'), join(directory, 'link.map'));
  await build(directory, { '/app.js': 'link.map' });
  await expect(symbolicateEvent(event(), directory)).rejects.toThrow('escapes');
});
it.each(['map', 'manifest', 'directory', 'root'])(
  'never symbolicates outside the build directory while the %s is atomically replaced',
  async (artifact) => {
    const directory = await temp();
    const outside = await temp();
    const map = (source: string) =>
      JSON.stringify({ version: 3, sources: [source], names: [], mappings: 'AAAA' });
    const manifest = (file: string) =>
      JSON.stringify({
        service: 'web',
        release: 'v1',
        build_id: 'build-a',
        files: { '/app.js': file },
      });
    await build(directory);
    await writeFile(join(outside, 'app.js.map'), map('outside-confidential.ts'));
    await writeFile(join(directory, 'secret.map'), map('outside-confidential.ts'));
    await writeFile(
      join(outside, '.telemetry-build.json'),
      manifest(artifact === 'root' ? 'app.js.map' : 'secret.map'),
    );
    if (artifact === 'directory') {
      await mkdir(join(directory, 'maps'));
      await writeFile(join(directory, 'maps', 'app.js.map'), map('src/run.ts'));
      await writeFile(join(directory, '.telemetry-build.json'), manifest('maps/app.js.map'));
    }
    const target =
      artifact === 'root'
        ? directory
        : join(
            directory,
            artifact === 'manifest'
              ? '.telemetry-build.json'
              : artifact === 'directory'
                ? 'maps'
                : 'app.js.map',
          );
    const parked = join(artifact === 'root' ? outside : directory, 'parked');
    const nextLink = join(artifact === 'root' ? outside : directory, 'next-link');
    let stopped = false;
    let rounds = 0;
    const replace = (async () => {
      while (!stopped) {
        if (artifact === 'directory' || artifact === 'root') await rename(target, parked);
        await symlink(
          artifact === 'directory' || artifact === 'root'
            ? outside
            : join(outside, artifact === 'manifest' ? '.telemetry-build.json' : 'app.js.map'),
          nextLink,
        );
        await rename(nextLink, target);
        if (artifact === 'directory' || artifact === 'root') {
          await rm(target);
          await rename(parked, target);
        } else {
          await writeFile(
            join(directory, 'next-file'),
            artifact === 'manifest' ? manifest('app.js.map') : map('src/run.ts'),
          );
          await rename(join(directory, 'next-file'), target);
        }
        rounds += 1;
      }
    })();
    const resolved: string[] = [];
    const deadline = Date.now() + 1000;
    try {
      while (Date.now() < deadline) {
        try {
          const result = await symbolicateEvent(event(), directory);
          resolved.push(result.error!.frames[0]!.file);
          if (resolved.includes('outside-confidential.ts')) break;
        } catch {}
      }
    } finally {
      stopped = true;
      await replace;
    }
    expect(rounds).toBeGreaterThan(0);
    expect(resolved).not.toContain('outside-confidential.ts');
    expect((await symbolicateEvent(event(), directory)).error!.frames[0]!.file).toBe('src/run.ts');
  },
);
it('reads nested regular maps and preserves the caller working directory across concurrent symbolication', async () => {
  const directory = await temp();
  const second = await temp();
  await build(directory, { '/app.js': 'maps/app.js.map' });
  await mkdir(join(directory, 'maps'));
  await rename(join(directory, 'app.js.map'), join(directory, 'maps', 'app.js.map'));
  await build(second);
  const input = event();
  input.error!.frames.push({ file: '/app.js', line: 1, column: 0 });
  const cwd = process.cwd();
  const results = await Promise.all([
    symbolicateEvent(input, directory),
    symbolicateEvent(event(), second),
  ]);
  expect(results.flatMap((result) => result.error!.frames.map((frame) => frame.file))).toEqual([
    'src/run.ts',
    'src/run.ts',
    'src/run.ts',
  ]);
  expect(process.cwd()).toBe(cwd);
  expect(input.error!.frames[0]!.file).toBe('/app.js');
});
it('preserves unknown positions and unmapped frames while resolving the mapped frame group', async () => {
  const directory = await temp();
  await build(directory);
  const input = event();
  input.error!.frames.push(
    { file: '/app.js', column: 0 },
    { file: '/app.js', line: 1 },
    { file: '/unmapped.js', line: 1, column: 0 },
  );
  const result = await symbolicateEvent(input, directory);
  expect(result.error!.frames).toEqual([
    { file: 'src/run.ts', function: 'run', line: 1, column: 0 },
    { file: '/app.js', column: 0 },
    { file: '/app.js', line: 1 },
    { file: '/unmapped.js', line: 1, column: 0 },
  ]);
});
it('rejects invalid manifest entries instead of resolving a partially processed event', async () => {
  const directory = await temp();
  await build(directory);
  await writeFile(
    join(directory, '.telemetry-build.json'),
    JSON.stringify({
      service: 'web',
      release: 'v1',
      build_id: 'build-a',
      files: { '/app.js': null },
    }),
  );
  await expect(symbolicateEvent(event(), directory)).rejects.toThrow(
    'Invalid build artifact manifest',
  );
});
it('returns an independent regular event after verifying the build identity', async () => {
  const directory = await temp();
  await build(directory);
  const input = event();
  input.kind = 'event';
  input.name = 'model_viewed';
  delete input.error;
  const result = await symbolicateEvent(input, directory);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
});
it('rejects symlink directory components even when they currently point within the build', async () => {
  const directory = await temp();
  await build(directory, { '/app.js': 'linked/app.js.map' });
  await mkdir(join(directory, 'maps'));
  await rename(join(directory, 'app.js.map'), join(directory, 'maps', 'app.js.map'));
  await symlink(join(directory, 'maps'), join(directory, 'linked'));
  await expect(symbolicateEvent(event(), directory)).rejects.toThrow('escapes');
});
it.each(['manifest', 'map'])(
  'rejects a non-regular %s without attempting to read it',
  async (artifact) => {
    const directory = await temp();
    await build(directory);
    const path = join(directory, artifact === 'manifest' ? '.telemetry-build.json' : 'app.js.map');
    await rm(path);
    await mkdir(path);
    await expect(symbolicateEvent(event(), directory)).rejects.toThrow('Invalid build artifact');
  },
);
it.each(['manifest', 'map'])(
  'rejects an oversized %s before parsing its JSON',
  async (artifact) => {
    const directory = await temp();
    await build(directory);
    const path = join(directory, artifact === 'manifest' ? '.telemetry-build.json' : 'app.js.map');
    const original = await readFile(path, 'utf8');
    const limit = artifact === 'manifest' ? 1024 * 1024 : 16 * 1024 * 1024;
    await writeFile(path, original + ' '.repeat(limit + 1 - Buffer.byteLength(original)));
    await expect(symbolicateEvent(event(), directory)).rejects.toThrow('Invalid build artifact');
  },
);
it('supports symbolicate through the CLI without credentials', async () => {
  const directory = await temp();
  await build(directory);
  await writeFile(join(directory, 'event.json'), JSON.stringify(event()));
  const io = ioFixture();
  io.env = {};
  expect(
    await runCli(
      ['symbolicate', '--input', join(directory, 'event.json'), '--build-dir', directory],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(io.output[0]!).error.frames[0].file).toBe('src/run.ts');
  expect(io.fetch).not.toHaveBeenCalled();
});
it('bounds response memory and marks oversized export responses as partial', async () => {
  const directory = await temp();
  const output = join(directory, 'oversized.ndjson');
  const io = ioFixture(
    vi.fn(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1))) as typeof fetch,
  );
  expect(await runCli(['export', ...filters, '--out', output], io)).toBe(3);
  expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')).complete).toBe(false);
});
