import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function scenario(options: {
  observe: boolean;
  fault?: string;
  recover?: string;
  loseOnRecovery?: boolean;
  holdOutput?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'oneaster-ha-gate-'));
  directories.push(directory);
  const state = join(directory, 'state.json');
  const marker = join(directory, 'fault-started');
  const descendant = join(directory, 'descendant-pid');
  await writeFile(state, 'healthy');
  const commandFile = join(directory, 'command.mjs');
  await writeFile(
    commandFile,
    `import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const state=${JSON.stringify(state)};
if(process.argv[2]==='observe') {
 if(${Boolean(options.holdOutput)}) {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore']});
  writeFileSync(${JSON.stringify(descendant)},String(child.pid));
  child.unref();
 }
 const phase=readFileSync(state,'utf8');
 const lost=phase==='faulted';
 const primary=phase==='healthy'?'a':'b';
 process.stdout.write(JSON.stringify({members:['a','b','c'].map(id=>({id,fault_domain:'zone-'+id,state:lost&&id==='a'?'unreachable':'running',role:lost&&id==='a'?'unknown':id===primary?'primary':'replica',synchronous:id==='c'}))}));
} else {
 if(process.argv[2]==='fault') writeFileSync(${JSON.stringify(marker)},'started');
 const next=process.argv[3];
 if(next!=='noop') writeFileSync(state,next);
}
`,
  );
  const loader = join(directory, 'network.mjs');
  await writeFile(
    loader,
    `import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const events=new Map();
globalThis.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:input);
 if(init?.method==='POST') {
  const batch=JSON.parse(init.body);
  const received_at='2026-11-01T00:00:00.000Z', retain_until='2026-12-01T00:00:00.000Z';
  for(const event of batch.events) events.set(event.id,{...event,project_id:'873f33a6-02cf-4110-96bd-fde46f4a63a3',environment:batch.environment,service:batch.service,source:'server',release:batch.release,build_id:batch.build_id,received_at,retain_until,policy_version:'1',clock_skew_ms:0});
  return Response.json({request_id:randomUUID(),project_id:'873f33a6-02cf-4110-96bd-fde46f4a63a3',environment:batch.environment,service:batch.service,source:'server',acknowledged:batch.events.map(event=>({id:event.id,status:'stored',received_at,retain_until}))});
 }
 if(${Boolean(options.loseOnRecovery)}&&readFileSync(${JSON.stringify(state)},'utf8')==='recovered')return Response.json({}, {status:404});
 const event=events.get(url.pathname.split('/').at(-1));
 return Response.json(event??{}, {status:event?200:404});
};
`,
  );
  const configuration = {
    collector_endpoints: ['https://collector-a.example', 'https://collector-b.example'],
    query_endpoints: ['https://query-a.example', 'https://query-b.example'],
    project_id: '873f33a6-02cf-4110-96bd-fde46f4a63a3',
    environment: 'test',
    service: 'api',
    release: 'v1',
    build_id: 'ha-test',
    event_name: 'availability_probe',
    event_properties: {},
    fault_domains: ['zone-a', 'zone-b', 'zone-c'],
    fault: { binary: process.execPath, args: [commandFile, 'fault', options.fault ?? 'noop'] },
    recover: {
      binary: process.execPath,
      args: [commandFile, 'recover', options.recover ?? 'recovered'],
    },
    recovery_budget_ms: 400,
    command_timeout_ms: options.holdOutput ? 100 : 1000,
    confirmed_events: 20,
    ...(options.observe
      ? {
          observe: { binary: process.execPath, args: [commandFile, 'observe'] },
          fault_target_domain: 'zone-a',
        }
      : {}),
  };
  const input = join(directory, 'configuration.json');
  const report = join(directory, 'report.json');
  await writeFile(input, JSON.stringify(configuration));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      loader,
      resolve('scripts/ha.ts'),
      input,
      '--execute-faults',
      report,
    ],
    {
      env: {
        ...process.env,
        TELEMETRY_HA_WRITE_TOKEN: `writer.${'w'.repeat(32)}`,
        TELEMETRY_HA_READ_TOKEN: `reader.${'r'.repeat(32)}`,
      },
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  const descendantPid = await readFile(descendant, 'utf8').then(Number, () => undefined);
  if (descendantPid)
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch {}
  const output = await readFile(report, 'utf8').then(
    (text) => JSON.parse(text) as { passed: boolean; observations?: Record<string, unknown> },
    () => undefined,
  );
  return {
    result,
    output,
    faultStarted: await stat(marker).then(
      () => true,
      () => false,
    ),
  };
}

test('regression: an HA drill without independent topology observations cannot execute faults or pass', async () => {
  const { result, faultStarted } = await scenario({ observe: false });
  expect(result.status).not.toBe(0);
  expect(faultStarted).toBe(false);
});

test('a no-op fault cannot pass while the observed topology remains healthy', async () => {
  const { result, output, faultStarted } = await scenario({ observe: true });
  expect(result.status).not.toBe(0);
  expect(faultStarted).toBe(true);
  expect(output?.passed).toBe(false);
  expect(output?.observations).toHaveProperty('fault');
});

test('a no-op recovery cannot pass while a fault domain remains unavailable', async () => {
  const { result, output } = await scenario({ observe: true, fault: 'faulted', recover: 'noop' });
  expect(result.status).not.toBe(0);
  expect(output?.passed).toBe(false);
  expect(output?.observations).toHaveProperty('recovered');
});

test('an observed failover verifies every confirmed ID and the restored redundant topology', async () => {
  const { result, output } = await scenario({ observe: true, fault: 'faulted' });
  expect(result.status).toBe(0);
  expect(output?.passed).toBe(true);
  expect(Object.keys(output?.observations ?? {})).toEqual(['before', 'fault', 'recovered']);
  expect(output).toMatchObject({
    production_ha_verified: false,
    fencing_verified: false,
    n_minus_one_capacity_verified: false,
    missing_confirmed_ids: 0,
  });
  expect(output).toHaveProperty('confirmed_ids');
});

test('regression: restored topology cannot hide confirmed data lost by recovery', async () => {
  const { result, output } = await scenario({
    observe: true,
    fault: 'faulted',
    loseOnRecovery: true,
  });
  expect(result.status).not.toBe(0);
  expect(output?.passed).toBe(false);
  expect(output).toMatchObject({ missing_after_recovery: 21 });
});

test('regression: a command descendant holding stdout cannot keep the HA process alive past its deadline', async () => {
  const { result, output, faultStarted } = await scenario({
    observe: true,
    fault: 'faulted',
    holdOutput: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(output?.passed).toBe(false);
  expect(faultStarted).toBe(false);
});
