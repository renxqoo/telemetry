import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sendAttempt } from '../packages/sdk/src/transport.js';
import type { Envelope } from '../packages/protocol/src/types.js';
const command = z.strictObject({ binary: z.string().min(1), args: z.array(z.string()) });
const schema = z.strictObject({
  collector_endpoints: z.array(z.url()).min(2),
  query_endpoints: z.array(z.url()).min(2),
  project_id: z.uuid(),
  environment: z.string().min(1),
  service: z.string().min(1),
  release: z.string().min(1),
  build_id: z.string().min(1),
  event_name: z.string().min(1),
  event_properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  fault_domains: z.array(z.string().min(1)).length(3),
  fault: command,
  recover: command,
  observe: command,
  fault_target_domain: z.string().min(1),
  request_timeout_ms: z.number().int().positive().max(30000).default(3000),
  response_bytes: z.number().int().positive().max(1048576).default(65536),
  command_output_bytes: z.number().int().positive().max(1048576).default(65536),
  recovery_budget_ms: z.number().int().positive().max(30000),
  command_timeout_ms: z.number().int().positive().max(60000),
  confirmed_events: z.number().int().min(20).max(10000),
});
const configPath = process.argv[2];
const execute = process.argv[3];
const output = resolve(process.argv[4] ?? 'artifacts/ha.json');
if (!configPath || execute !== '--execute-faults')
  throw new Error(
    'Usage: bun run test:ha CONFIG_JSON --execute-faults [REPORT_JSON]. This command executes the configured fault and recovery commands.',
  );
const configuration = schema.parse(JSON.parse(await readFile(configPath, 'utf8')));
if (
  new Set(configuration.fault_domains).size !== 3 ||
  !configuration.fault_domains.includes(configuration.fault_target_domain)
)
  throw new Error('Three distinct fault domains required');
for (const endpoint of [...configuration.collector_endpoints, ...configuration.query_endpoints]) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('HA endpoints require credential-free HTTPS');
}
const writeToken = process.env.TELEMETRY_HA_WRITE_TOKEN,
  readToken = process.env.TELEMETRY_HA_READ_TOKEN;
if (!writeToken || !readToken)
  throw new Error('TELEMETRY_HA_WRITE_TOKEN and TELEMETRY_HA_READ_TOKEN required');
async function run(
  commandValue: z.infer<typeof command>,
  deadlineMs = configuration.command_timeout_ms,
): Promise<string> {
  const child = spawn(commandValue.binary, commandValue.args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  function terminate(signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > configuration.command_output_bytes) {
      oversized = true;
      terminate('SIGKILL');
    } else if (!oversized) chunks.push(chunk);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate('SIGTERM');
  }, deadlineMs);
  const hard = setTimeout(() => terminate('SIGKILL'), deadlineMs + 1000);
  try {
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once('error', reject);
      child.once('close', resolveStatus);
    });
    if (timedOut || oversized || status !== 0) throw new Error('Scenario command failed');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    clearTimeout(hard);
    terminate('SIGKILL');
  }
}
const topologySchema = z.strictObject({
  members: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        fault_domain: z.string().min(1),
        state: z.enum(['running', 'unreachable']),
        role: z.enum(['primary', 'replica', 'unknown']),
        synchronous: z.boolean(),
      }),
    )
    .length(3),
});
type Topology = z.infer<typeof topologySchema>;
const observations: { before?: Topology; fault?: Topology; recovered?: Topology } = {};
async function observe(phase: 'before' | 'fault' | 'recovered', deadlineMs?: number) {
  const output = await run(configuration.observe, deadlineMs);
  let topology: Topology;
  try {
    topology = topologySchema.parse(JSON.parse(output));
  } catch {
    throw new Error('Topology observation is invalid');
  }
  observations[phase] = topology;
  if (
    new Set(topology.members.map((member) => member.id)).size !== 3 ||
    new Set(topology.members.map((member) => member.fault_domain)).size !== 3 ||
    topology.members.some((member) => !configuration.fault_domains.includes(member.fault_domain))
  )
    throw new Error('Topology member identities or fault domains do not match');
  if (
    observations.before &&
    topology.members.some(
      (member) =>
        !observations.before!.members.some(
          (prior) => prior.id === member.id && prior.fault_domain === member.fault_domain,
        ),
    )
  )
    throw new Error('Topology member identities changed during verification');
  const running = topology.members.filter((member) => member.state === 'running');
  const primary = running.filter((member) => member.role === 'primary');
  if (
    primary.length !== 1 ||
    running.some((member) => member.role === 'unknown') ||
    !running.some((member) => member.role === 'replica' && member.synchronous)
  )
    throw new Error('Topology does not provide a unique primary and synchronous replica');
  if (
    topology.members.some((member) => {
      const lost = phase === 'fault' && member.fault_domain === configuration.fault_target_domain;
      return lost
        ? member.state !== 'unreachable' || member.role !== 'unknown' || member.synchronous
        : member.state !== 'running';
    })
  )
    throw new Error('Configured fault or recovery is not observable');
  const beforePrimary = observations.before?.members.find((member) => member.role === 'primary');
  if (
    phase === 'fault' &&
    beforePrimary?.fault_domain === configuration.fault_target_domain &&
    primary[0]!.id === beforePrimary.id
  )
    throw new Error('Primary did not change after losing its fault domain');
}
const acknowledged = new Set<string>();
let faultStarted = false;
let recoveredMs: number | null = null;
const missing = new Set<string>();
let missingAfterFault: number | null = null;
let missingAfterRecovery: number | null = null;
async function ingest(): Promise<void> {
  const id = randomUUID();
  const payload: Envelope = {
    schema_version: '1',
    environment: configuration.environment,
    service: configuration.service,
    release: configuration.release,
    build_id: configuration.build_id,
    events: [
      {
        id,
        occurred_at: new Date().toISOString(),
        kind: 'event',
        name: configuration.event_name,
        properties: configuration.event_properties,
      },
    ],
  };
  for (const endpoint of configuration.collector_endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), configuration.request_timeout_ms);
    try {
      const result = await sendAttempt(
        fetch,
        new URL('/v1/ingest/server', endpoint).href,
        payload,
        'server',
        writeToken,
        configuration.project_id,
        controller,
        () => controller.abort(),
      );
      if (result.status === 200 && result.acknowledgement) {
        acknowledged.add(id);
        return;
      }
      if (result.status >= 400 && result.status < 500) break;
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  throw new Error('No collector safely confirmed an event');
}
async function verifyConfirmed(): Promise<number> {
  const absent: string[] = [];
  for (const id of acknowledged) {
    let found = false;
    for (const endpoint of configuration.query_endpoints) {
      try {
        const url = new URL(`/v1/events/server/${id}`, endpoint);
        url.searchParams.set('environment', configuration.environment);
        url.searchParams.set('service', configuration.service);
        const signal = AbortSignal.timeout(configuration.request_timeout_ms);
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${readToken}` },
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const reader = response.body?.getReader();
        if (!reader) continue;
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const abort = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let body: string;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > configuration.response_bytes) throw new Error('HA response too large');
            chunks.push(chunk.value);
          }
          body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } finally {
          signal.removeEventListener('abort', abort);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const event = JSON.parse(body) as {
          id?: string;
          project_id?: string;
          environment?: string;
          service?: string;
          source?: string;
        };
        if (
          !signal.aborted &&
          event.id === id &&
          event.project_id === configuration.project_id &&
          event.environment === configuration.environment &&
          event.service === configuration.service &&
          event.source === 'server'
        ) {
          found = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!found) {
      absent.push(id);
      missing.add(id);
    }
  }
  return absent.length;
}
let failure: string | undefined;
try {
  await observe('before');
  for (let index = 0; index < configuration.confirmed_events; index++) await ingest();
  faultStarted = true;
  const start = performance.now();
  await run(configuration.fault);
  while (performance.now() - start < configuration.recovery_budget_ms) {
    try {
      await observe(
        'fault',
        Math.max(
          1,
          Math.min(
            configuration.command_timeout_ms,
            configuration.recovery_budget_ms - (performance.now() - start),
          ),
        ),
      );
      await ingest();
      recoveredMs = performance.now() - start;
      break;
    } catch {
      await delay(100);
    }
  }
  if (recoveredMs === null || recoveredMs > configuration.recovery_budget_ms)
    throw new Error('Recovery exceeded the configured budget');
  missingAfterFault = await verifyConfirmed();
  if (missingAfterFault) throw new Error('Acknowledged events missing after fault');
} catch (error) {
  failure = error instanceof Error ? error.message : 'HA verification failed';
  process.exitCode = 1;
} finally {
  if (faultStarted)
    try {
      await run(configuration.recover);
      await observe('recovered');
      missingAfterRecovery = await verifyConfirmed();
      if (missingAfterRecovery) {
        failure = 'Acknowledged events missing after recovery';
        process.exitCode = 1;
      }
    } catch {
      failure = 'Recovery or post-recovery verification failed; operator action required';
      process.exitCode = 1;
    }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        fault_domains: configuration.fault_domains,
        confirmed_ids: [...acknowledged],
        missing_confirmed_ids:
          missingAfterFault === null && missingAfterRecovery === null ? null : missing.size,
        missing_ids: [...missing],
        missing_after_fault: missingAfterFault,
        missing_after_recovery: missingAfterRecovery,
        recovered_ms: recoveredMs,
        recovery_budget_ms: configuration.recovery_budget_ms,
        passed: !failure,
        observations,
        production_ha_verified: false,
        fencing_verified: false,
        n_minus_one_capacity_verified: false,
        ...(failure ? { failure } : {}),
        scope:
          'One observed configured fault-domain loss and recovery; physical fault-domain independence, fencing, sustained N-1 capacity, backups and rolling SLO are not verified.',
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(`${failure ?? 'Configured HA scenario passed'}; report: ${output}\n`);
}
