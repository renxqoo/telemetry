import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { validateEvent } from '../../protocol/src/index.js';
import type { SpanPage } from '../../protocol/src/traces/types.js';
import type { EventPage, StoredEvent } from '../../protocol/src/types.js';
import { withBuildArtifacts } from './artifacts.js';
export interface CliIO {
  stdout(text: string): unknown;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}
class CliError extends Error {
  constructor(
    message: string,
    public status = 1,
  ) {
    super(message);
  }
}
const filters = [
  'environment',
  'from',
  'to',
  'limit',
  'source',
  'name',
  'service',
  'release',
  'request_id',
  'trace_id',
  'span_id',
  'user_id',
  'code',
  'fingerprint',
];
function argumentsFor(argv: string[]): { command: string; options: Record<string, string> } {
  let command = argv[0] ?? '';
  let offset = 1;
  if (command === 'events' || command === 'errors' || command === 'traces') {
    command += ` ${argv[1] ?? ''}`;
    offset = 2;
  }
  const options: Record<string, string> = {};
  if (
    ![
      'traces list',
      'traces get',
      'events list',
      'errors list',
      'events get',
      'errors get',
      'export',
      'doctor',
      'symbolicate',
    ].includes(command)
  )
    throw new CliError('Expected events/errors list/get, export, symbolicate or doctor.', 2);
  const allowed = command.startsWith('traces ')
    ? [
        'environment',
        'from',
        'to',
        'service',
        'limit',
        'cursor',
        'trace_id',
        'span_id',
        'name',
        'status_code',
        'min_duration_ns',
        'max_duration_ns',
        'format',
        'id',
        'out',
        'credentials',
      ]
    : command === 'doctor'
      ? ['credentials']
      : command === 'symbolicate'
        ? ['input', 'build-dir']
        : command === 'export'
          ? [...filters, 'kind', 'out', 'credentials']
          : command.endsWith('get')
            ? ['environment', 'service', 'source', 'id', 'credentials']
            : [...filters, 'credentials'];
  for (let index = offset; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (
      !argv[index]?.startsWith('--') ||
      !key ||
      !allowed.includes(key) ||
      options[key] !== undefined ||
      !value ||
      value.startsWith('--')
    )
      throw new CliError('Invalid command arguments.', 2);
    options[key] = value;
  }
  return { command, options };
}
async function credentials(
  options: Record<string, string>,
  io: CliIO,
): Promise<{ token: string; endpoints: string[] }> {
  let file: { token?: unknown; endpoints?: unknown } = {};
  const path = options.credentials ?? io.env.TELEMETRY_CREDENTIALS_FILE;
  if (path) {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
        throw new CliError('Credential file must be owned by the current user and have mode 0600.');
      file = JSON.parse(await handle.readFile('utf8')) as typeof file;
    } finally {
      await handle.close();
    }
  }
  const token = io.env.TELEMETRY_TOKEN ?? file.token;
  const endpoints = io.env.TELEMETRY_ENDPOINTS?.split(',') ?? file.endpoints;
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}\.[^\s]{32,}$/.test(token) ||
    !Array.isArray(endpoints) ||
    !endpoints.length ||
    endpoints.length > 8 ||
    endpoints.some((item) => typeof item !== 'string')
  )
    throw new CliError(
      'Provide token and endpoints through secret injection or a 0600 credential file.',
      2,
    );
  for (const value of endpoints as string[]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CliError('Invalid endpoint.', 2);
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
      throw new CliError(
        'Endpoints require HTTPS or loopback HTTP and no embedded credentials.',
        2,
      );
  }
  return { token, endpoints: endpoints as string[] };
}
function ensure(options: Record<string, string>, keys: string[]): void {
  if (keys.some((key) => !options[key]))
    throw new CliError(`Required options: ${keys.map((key) => `--${key}`).join(', ')}.`, 2);
}
function query(options: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of filters) if (options[key]) params.set(key, options[key]!);
  return params;
}
async function request(
  path: string,
  auth: { token: string; endpoints: string[] },
  io: CliIO,
): Promise<unknown> {
  for (let attempt = 0; attempt < auth.endpoints.length; attempt += 1) {
    let response: Response;
    try {
      response = await io.fetch(new URL(path, auth.endpoints[attempt]!), {
        headers: { Authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      if (attempt + 1 < auth.endpoints.length) continue;
      throw new CliError('Endpoint connection failed.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 500 && attempt + 1 < auth.endpoints.length) continue;
      throw new CliError(`Request failed with HTTP ${response.status}.`);
    }
    try {
      if (!response.body) throw new Error('Missing response body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Response too large');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new CliError('Endpoint returned invalid JSON.');
    }
  }
  throw new CliError('No endpoints available.');
}
function isStoredEvent(value: unknown): value is StoredEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as StoredEvent;
  const fields: Record<string, unknown> = {};
  for (const key of [
    'id',
    'occurred_at',
    'kind',
    'name',
    'properties',
    'context',
    'truncated',
    'sample_rate',
    'error',
  ] as const)
    if (event[key] !== undefined) fields[key] = event[key];
  try {
    validateEvent(fields);
  } catch {
    return false;
  }
  return (
    typeof event.project_id === 'string' &&
    /^[a-f0-9-]{36}$/.test(event.project_id) &&
    ['browser', 'server'].includes(event.source) &&
    ['environment', 'service', 'release', 'build_id', 'policy_version'].every(
      (key) =>
        typeof event[key as keyof StoredEvent] === 'string' &&
        event[key as keyof StoredEvent] !== '',
    ) &&
    Number.isFinite(Date.parse(event.received_at)) &&
    Number.isFinite(Date.parse(event.retain_until)) &&
    Number.isFinite(event.clock_skew_ms)
  );
}
function eventPage(value: unknown): EventPage {
  const page = value as EventPage;
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 500 ||
    !page.items.every(isStoredEvent) ||
    !(page.next_cursor === null || typeof page.next_cursor === 'string') ||
    page.consistency !== 'primary_committed' ||
    page.pagination !== 'live-pagination' ||
    typeof page.query_id !== 'string' ||
    !page.range ||
    typeof page.range.from !== 'string' ||
    typeof page.range.to !== 'string'
  )
    throw new CliError('Endpoint returned an invalid page.');
  return page;
}
async function exportEvents(
  options: Record<string, string>,
  auth: { token: string; endpoints: string[] },
  io: CliIO,
): Promise<number> {
  ensure(options, ['environment', 'from', 'to', 'out']);
  const kind = options.kind ?? 'events';
  if (!['events', 'errors'].includes(kind)) throw new CliError('Invalid export kind.', 2);
  const path = resolve(options.out!);
  const manifestPath = `${path}.manifest.json`;
  const output = await open(path, 'wx', 0o600);
  let manifestHandle;
  try {
    manifestHandle = await open(manifestPath, 'wx', 0o600);
  } catch (error) {
    await output.close();
    throw error;
  }
  const params = query(options);
  const digest = createHash('sha256').update(params.toString()).digest('hex');
  let count = 0;
  let complete = false;
  let failure = '';
  let range: EventPage['range'] = { from: options.from!, to: options.to! };
  const seen = new Set<string>();
  try {
    for (;;) {
      const page = eventPage(await request(`/v1/${kind}?${params}`, auth, io));
      range = page.range;
      for (const event of page.items) {
        await output.writeFile(`${JSON.stringify(event)}\n`);
        count += 1;
      }
      if (!page.next_cursor) {
        complete = true;
        break;
      }
      if (seen.has(page.next_cursor)) throw new CliError('Endpoint repeated a pagination cursor.');
      seen.add(page.next_cursor);
      params.set('cursor', page.next_cursor);
    }
  } catch {
    failure = 'Export stopped before all pages were received.';
  } finally {
    await output.sync();
    await output.close();
    try {
      await manifestHandle.writeFile(
        `${JSON.stringify({ schema_version: '1', kind, range, filter_digest: digest, count, complete, pagination: 'live-pagination', limitations: 'Pages use separate snapshots; late commits and retention expiry may change the observed set.', ...(failure ? { failure } : {}) }, null, 2)}\n`,
      );
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
  }
  await io.stdout(`${JSON.stringify({ output: path, manifest: manifestPath, count, complete })}\n`);
  return complete ? 0 : 3;
}
function tracePage(value: unknown): SpanPage {
  const page = value as SpanPage;
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 500 ||
    page.scope !== 'authorized_services' ||
    page.consistency !== 'primary_committed' ||
    page.pagination !== 'live-pagination' ||
    !(page.next_cursor === null || typeof page.next_cursor === 'string') ||
    !page.range ||
    typeof page.range.from !== 'string' ||
    typeof page.range.to !== 'string' ||
    typeof page.query_id !== 'string' ||
    !page.items.every(
      (item) =>
        item &&
        /^[a-f0-9]{32}$/.test(item.trace_id) &&
        /^[a-f0-9]{16}$/.test(item.span_id) &&
        typeof item.service === 'string' &&
        Number.isFinite(Date.parse(item.received_at)) &&
        typeof item.duration_ns === 'string' &&
        /^\d+$/.test(item.duration_ns) &&
        Array.isArray(item.attributes) &&
        Array.isArray(item.events) &&
        Array.isArray(item.links),
    )
  )
    throw new CliError('Endpoint returned an invalid trace page.');
  return page;
}
async function traceCommand(
  command: string,
  options: Record<string, string>,
  auth: { token: string; endpoints: string[] },
  io: CliIO,
): Promise<number> {
  ensure(options, ['environment']);
  const detail = command === 'traces get';
  const format = options.format ?? 'json';
  if (
    !['json', 'ndjson'].includes(format) ||
    (!detail && (options.id || options.out)) ||
    (options.out && format !== 'ndjson')
  )
    throw new CliError('Invalid trace output options.', 2);
  if (detail) {
    ensure(options, ['id']);
    if (
      !/^[a-fA-F0-9]{32}$/.test(options.id) ||
      /^0+$/.test(options.id) ||
      ['trace_id', 'span_id', 'name', 'status_code', 'min_duration_ns', 'max_duration_ns'].some(
        (key) => options[key],
      )
    )
      throw new CliError('Invalid trace identity or filters.', 2);
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options))
    if (!['format', 'out', 'id', 'credentials'].includes(key)) params.set(key, value);
  const route = detail ? `/v1/traces/${options.id.toLowerCase()}` : '/v1/spans';
  if (format === 'json') {
    await io.stdout(
      `${JSON.stringify(tracePage(await request(`${route}?${params}`, auth, io)))}\n`,
    );
    return 0;
  }
  const file = options.out ? await open(resolve(options.out), 'wx', 0o600) : undefined;
  let complete = false,
    count = 0,
    lastKey: string | undefined,
    previousCursor: string | undefined;
  try {
    for (;;) {
      const page = tracePage(await request(`${route}?${params}`, auth, io));
      for (const item of page.items) {
        const key = `${item.received_at}:${item.trace_id}:${item.span_id}`;
        if (lastKey && key >= lastKey) throw new CliError('Trace pagination did not advance.');
        lastKey = key;
        const line = `${JSON.stringify(item)}\n`;
        if (file) await file.writeFile(line);
        else await io.stdout(line);
        count++;
      }
      if (!page.next_cursor) {
        complete = true;
        break;
      }
      if (!page.items.length || page.next_cursor === previousCursor)
        throw new CliError('Trace pagination did not advance.');
      previousCursor = page.next_cursor;
      params.set('cursor', page.next_cursor);
    }
    return 0;
  } catch {
    io.stderr('Trace export stopped before all pages were received.\n');
    return 3;
  } finally {
    if (file) {
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    io.stderr(`${JSON.stringify({ count, complete, pagination: 'live-pagination' })}\n`);
  }
}
export async function symbolicateEvent(
  event: StoredEvent,
  buildDirectory: string,
): Promise<StoredEvent> {
  if (!isStoredEvent(event)) throw new CliError('Invalid stored input event.', 2);
  return withBuildArtifacts(buildDirectory, async (read) => {
    const manifest = JSON.parse(await read('.telemetry-build.json', 1024 * 1024)) as {
      service: string;
      release: string;
      build_id: string;
      files: Record<string, string>;
    };
    if (
      manifest.service !== event.service ||
      manifest.release !== event.release ||
      manifest.build_id !== event.build_id ||
      !manifest.files ||
      typeof manifest.files !== 'object' ||
      Array.isArray(manifest.files)
    )
      throw new CliError('Source map build metadata does not match the event.');
    const result = structuredClone(event);
    if (!result.error) return result;
    const frames = result.error.frames;
    const groups = new Map<string, typeof frames>();
    for (const frame of frames) {
      if (
        frame.line === undefined ||
        frame.column === undefined ||
        !Object.hasOwn(manifest.files, frame.file)
      )
        continue;
      const entry = manifest.files[frame.file];
      if (typeof entry !== 'string') throw new CliError('Invalid build artifact manifest.');
      const group = groups.get(entry) ?? [];
      group.push(frame);
      groups.set(entry, group);
    }
    for (const [entry, group] of groups) {
      const map = new TraceMap(
        JSON.parse(await read(entry, 16 * 1024 * 1024)) as ConstructorParameters<
          typeof TraceMap
        >[0],
      );
      for (const frame of group) {
        const position = originalPositionFor(map, { line: frame.line!, column: frame.column! });
        if (position.source !== null && position.line !== null && position.column !== null) {
          frame.file = position.source;
          frame.line = position.line;
          frame.column = position.column;
          if (position.name) frame.function = position.name;
        }
      }
    }
    return result;
  });
}
export async function runCli(argv: string[], overrides: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdout: async (value) => {
      if (!process.stdout.write(value)) await once(process.stdout, 'drain');
    },
    stderr: (value) => process.stderr.write(value),
    env: process.env,
    fetch,
    ...overrides,
  };
  try {
    const { command, options } = argumentsFor(argv);
    if (command === 'symbolicate') {
      ensure(options, ['input', 'build-dir']);
      const event = JSON.parse(await readFile(options.input!, 'utf8')) as StoredEvent;
      if (
        !event ||
        typeof event.service !== 'string' ||
        typeof event.release !== 'string' ||
        typeof event.build_id !== 'string' ||
        (event.error && !Array.isArray(event.error.frames))
      )
        throw new CliError('Invalid input event.', 2);
      await io.stdout(`${JSON.stringify(await symbolicateEvent(event, options['build-dir']!))}\n`);
      return 0;
    }
    const auth = await credentials(options, io);
    if (command.startsWith('traces ')) return await traceCommand(command, options, auth, io);
    if (command === 'export') return await exportEvents(options, auth, io);
    let path: string;
    if (command === 'doctor') path = '/v1/doctor';
    else if (command.endsWith('get')) {
      ensure(options, ['environment', 'service', 'source', 'id']);
      if (!['browser', 'server'].includes(options.source!) || !/^[a-f0-9-]{36}$/.test(options.id!))
        throw new CliError('Invalid event identity.', 2);
      const params = new URLSearchParams({
        environment: options.environment!,
        service: options.service!,
      });
      path = `/v1/${command.split(' ')[0]}/${options.source}/${options.id}?${params}`;
    } else {
      ensure(options, ['environment']);
      path = `/v1/${command.split(' ')[0]}?${query(options)}`;
    }
    const result = await request(path, auth, io);
    await io.stdout(
      `${JSON.stringify(command === 'doctor' ? { cli_version: '0.1.0', ...(result as object) } : result)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof CliError ? error.message : 'Operation failed.'}\n`);
    return error instanceof CliError ? error.status : 1;
  }
}
