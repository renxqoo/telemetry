import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
function inventory() {
  return {
    cluster: 'telemetry',
    namespace: 'telemetry',
    app_image: `registry.example/telemetry@sha256:${'a'.repeat(64)}`,
    config_name: 'telemetry-config',
    database_tls_secret: 'database-tls',
    ingress_namespaces: ['ingress'],
    maintenance_secret: 'maintenance',
    nodes: ['a', 'b', 'c'].map((slot) => ({
      name: slot,
      zone: `zone-${slot}`,
      host: `database-${slot}.example`,
      etcd_host: `etcd-${slot}.example`,
      collector_secret: `collector-${slot}`,
      query_secret: `query-${slot}`,
      collector_host: `collector-${slot}.example`,
      query_host: `query-${slot}.example`,
      ingress_class: `edge-${slot}`,
      ingress_tls_secret: `edge-${slot}`,
    })),
    database_cidrs: ['10.0.0.0/8'],
    tls: { ca: '/tls/ca.crt', cert: '/tls/server.crt', key: '/tls/server.key' },
    postgres_bin: '/usr/lib/postgresql/18/bin',
    data_directory: '/var/lib/postgresql/18/data',
    backup: { repository: '/backup' },
  };
}
interface Resource {
  kind: string;
  metadata: { name: string };
  spec: {
    selector: Record<string, string>;
    rules: { host: string; http: { paths: { backend: { service: { name: string } } }[] } }[];
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: { matchExpressions: { key: string; values: string[] }[] }[];
            };
          };
        };
      };
    };
  };
}
async function render(input: ReturnType<typeof inventory>) {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-render-'));
  directories.push(directory);
  const path = join(directory, 'inventory.json');
  await writeFile(path, JSON.stringify(input));
  execFileSync(process.execPath, ['--import', 'tsx', resolve('ops/render.ts'), path, directory], {
    timeout: 5000,
    stdio: 'pipe',
  });
  return JSON.parse(await readFile(join(directory, 'applications.json'), 'utf8')) as {
    items: Resource[];
  };
}
test('regression: PostgreSQL crash recovery cannot consume the 30 second failover budget', async () => {
  await render(inventory());
  const configuration = JSON.parse(
    await readFile(join(directories.at(-1)!, 'a.patroni.json'), 'utf8'),
  ) as {
    bootstrap: { dcs: { loop_wait: number; primary_start_timeout?: number } };
  };
  const dcs = configuration.bootstrap.dcs;
  const recoverySeconds = dcs.loop_wait + (dcs.primary_start_timeout ?? 300) + dcs.loop_wait;
  expect(recoverySeconds).toBeLessThanOrEqual(30);
});
test('a delayed watchdog keepalive must still expire inside the renewed leader lease', async () => {
  await render(inventory());
  const configuration = JSON.parse(
    await readFile(join(directories.at(-1)!, 'a.patroni.json'), 'utf8'),
  ) as {
    bootstrap: { dcs: { ttl: number } };
    watchdog: { mode: string; safety_margin: number };
  };
  const { ttl } = configuration.bootstrap.dcs;
  const { safety_margin: margin } = configuration.watchdog;
  const deviceTimeout = margin === -1 ? Math.floor(ttl / 2) : ttl - margin;
  expect(configuration.watchdog.mode).toBe('required');
  expect(deviceTimeout).toBeGreaterThan(0);
  expect(deviceTimeout * 2).toBeLessThanOrEqual(ttl);
});
test('regional ingress cannot route into another availability zone', async () => {
  const input = inventory();
  const { items } = await render(input);
  const services = new Map(
    items.filter((item) => item.kind === 'Service').map((item) => [item.metadata.name, item]),
  );
  const workloads = items.filter((item) => item.kind === 'StatefulSet');
  const ingresses = items.filter((item) => item.kind === 'Ingress');
  expect(ingresses).toHaveLength(6);
  for (const ingress of ingresses) {
    const rule = ingress.spec.rules[0]!;
    const expected = input.nodes.find(
      (node) => node.collector_host === rule.host || node.query_host === rule.host,
    )!;
    const service = services.get(rule.http.paths[0]!.backend.service.name)!;
    const selected = workloads.filter((workload) =>
      Object.entries(service.spec.selector).every(
        ([key, value]) => workload.spec.template.metadata.labels[key] === value,
      ),
    );
    expect(selected).toHaveLength(1);
    const terms =
      selected[0]!.spec.template.spec.affinity.nodeAffinity
        .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms;
    expect(
      terms.flatMap((term) =>
        term.matchExpressions
          .filter((expression) => expression.key === 'topology.kubernetes.io/zone')
          .flatMap((expression) => expression.values),
      ),
    ).toEqual([expected.zone]);
  }
});
test.each(['regional', 'read-write'])(
  'duplicate %s hostnames cannot produce competing ingress routes',
  async (kind) => {
    const input = inventory();
    if (kind === 'regional') input.nodes[1]!.collector_host = input.nodes[0]!.collector_host;
    else input.nodes[0]!.query_host = input.nodes[0]!.collector_host;
    await expect(render(input)).rejects.toThrow('Six distinct ingress hostnames required');
  },
);
