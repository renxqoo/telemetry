import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
const host = z.string().regex(/^[A-Za-z0-9.-]+$/);
const inventorySchema = z
  .strictObject({
    cluster: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    namespace: z.string().regex(/^[a-z][a-z0-9-]*$/),
    app_image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/),
    config_name: z.string().min(1),
    database_tls_secret: z.string().min(1),
    ingress_namespaces: z.array(z.string().min(1)).min(1),
    maintenance_secret: z.string().min(1),
    nodes: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[a-z][a-z0-9-]*$/),
          zone: z.string().min(1),
          host,
          etcd_host: host,
          collector_secret: z.string().min(1),
          query_secret: z.string().min(1),
          collector_host: host,
          query_host: host,
          ingress_class: z.string().min(1),
          ingress_tls_secret: z.string().min(1),
        }),
      )
      .length(3),
    database_cidrs: z.array(z.string().regex(/^[0-9a-fA-F:./]+$/)).min(1),
    tls: z.strictObject({
      ca: z.string().startsWith('/'),
      cert: z.string().startsWith('/'),
      key: z.string().startsWith('/'),
    }),
    postgres_bin: z.string().startsWith('/'),
    data_directory: z.string().startsWith('/'),
    backup: z.strictObject({
      repository: z.string().startsWith('/'),
    }),
  })
  .superRefine((value, context) => {
    for (const property of [
      'name',
      'zone',
      'host',
      'etcd_host',
      'collector_secret',
      'query_secret',
    ] as const)
      if (new Set(value.nodes.map((node) => node[property])).size !== 3)
        context.addIssue({ code: 'custom', message: `Three distinct ${property} values required` });
    if (new Set(value.nodes.flatMap((node) => [node.collector_host, node.query_host])).size !== 6)
      context.addIssue({ code: 'custom', message: 'Six distinct ingress hostnames required' });
  });
const input = process.argv[2],
  output = process.argv[3];
if (!input || !output)
  throw new Error('Usage: bun run ops/render.ts INVENTORY_JSON OUTPUT_DIRECTORY');
const inventory = inventorySchema.parse(JSON.parse(await readFile(input, 'utf8')));
const directory = resolve(output);
await mkdir(directory, { recursive: true, mode: 0o700 });
const json = async (name: string, value: unknown) =>
  writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
for (const node of inventory.nodes) {
  const etcdEndpoints = inventory.nodes.map((item) => `https://${item.etcd_host}:2379`);
  await json(`${node.name}.patroni.json`, {
    scope: inventory.cluster,
    namespace: '/oneaster/',
    name: node.name,
    restapi: {
      listen: `${node.host}:8008`,
      connect_address: `${node.host}:8008`,
      certfile: inventory.tls.cert,
      keyfile: inventory.tls.key,
      cafile: inventory.tls.ca,
      verify_client: 'required',
    },
    etcd3: {
      hosts: etcdEndpoints,
      cacert: inventory.tls.ca,
      cert: inventory.tls.cert,
      key: inventory.tls.key,
      protocol: 'https',
    },
    bootstrap: {
      dcs: {
        ttl: 30,
        loop_wait: 5,
        retry_timeout: 5,
        primary_start_timeout: 0,
        check_timeline: true,
        synchronous_mode: true,
        synchronous_mode_strict: true,
        synchronous_node_count: 1,
        postgresql: {
          use_pg_rewind: true,
          parameters: {
            wal_level: 'replica',
            hot_standby: 'on',
            synchronous_commit: 'on',
            fsync: 'on',
            full_page_writes: 'on',
            max_connections: 200,
            max_wal_senders: 10,
            max_replication_slots: 10,
            ssl: 'on',
            ssl_ca_file: inventory.tls.ca,
            ssl_cert_file: inventory.tls.cert,
            ssl_key_file: inventory.tls.key,
            archive_mode: 'on',
            archive_command: `pgbackrest --stanza=${inventory.cluster} archive-push %p`,
            archive_timeout: '60s',
          },
        },
      },
      initdb: ['data-checksums', { encoding: 'UTF8' }],
    },
    postgresql: {
      listen: `${node.host}:5432`,
      connect_address: `${node.host}:5432`,
      data_dir: inventory.data_directory,
      bin_dir: inventory.postgres_bin,
      authentication: {
        superuser: { username: 'postgres' },
        replication: {
          username: 'replicator',
          sslmode: 'verify-full',
          sslrootcert: inventory.tls.ca,
          sslcert: inventory.tls.cert,
          sslkey: inventory.tls.key,
        },
        rewind: { username: 'rewind_user' },
      },
      pg_hba: [
        ...inventory.database_cidrs.flatMap((cidr) => [
          `hostssl replication replicator ${cidr} scram-sha-256`,
          `hostssl all all ${cidr} scram-sha-256`,
        ]),
        'host all all 0.0.0.0/0 reject',
        'host all all ::/0 reject',
      ],
    },
    watchdog: { mode: 'required', device: '/dev/watchdog', safety_margin: -1 },
    tags: { availability_zone: node.zone },
  });
  await json(`${node.name}.etcd.json`, {
    name: node.name,
    'data-dir': `/var/lib/etcd/${inventory.cluster}`,
    'listen-client-urls': `https://${node.etcd_host}:2379`,
    'advertise-client-urls': `https://${node.etcd_host}:2379`,
    'listen-peer-urls': `https://${node.etcd_host}:2380`,
    'initial-advertise-peer-urls': `https://${node.etcd_host}:2380`,
    'initial-cluster': inventory.nodes
      .map((item) => `${item.name}=https://${item.etcd_host}:2380`)
      .join(','),
    'initial-cluster-state': 'new',
    'initial-cluster-token': inventory.cluster,
    'client-transport-security': {
      'cert-file': inventory.tls.cert,
      'key-file': inventory.tls.key,
      'trusted-ca-file': inventory.tls.ca,
      'client-cert-auth': true,
    },
    'peer-transport-security': {
      'cert-file': inventory.tls.cert,
      'key-file': inventory.tls.key,
      'trusted-ca-file': inventory.tls.ca,
      'client-cert-auth': true,
    },
  });
}
const resources: unknown[] = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: inventory.namespace } },
];
for (const role of ['collector', 'query'] as const) {
  const labels = { app: `telemetry-${role}` };
  const port = role === 'collector' ? 4320 : 4321;
  resources.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: role, namespace: inventory.namespace },
    spec: {
      clusterIP: 'None',
      selector: labels,
      ports: [{ name: 'http', port, targetPort: port }],
    },
  });
  for (const [slot, node] of inventory.nodes.entries()) {
    const slotName = `${role}-${['a', 'b', 'c'][slot]}`;
    const podLabels = { ...labels, 'telemetry-slot': slotName };
    resources.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: slotName, namespace: inventory.namespace },
      spec: {
        selector: podLabels,
        ports: [{ name: 'http', port, targetPort: port }],
      },
    });
    resources.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: slotName,
        namespace: inventory.namespace,
        annotations: {
          'nginx.ingress.kubernetes.io/proxy-body-size': '32k',
          'nginx.ingress.kubernetes.io/proxy-connect-timeout': '1',
          'nginx.ingress.kubernetes.io/proxy-read-timeout': '4',
          'nginx.ingress.kubernetes.io/proxy-send-timeout': '4',
          'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
        },
      },
      spec: {
        ingressClassName: node.ingress_class,
        tls: [
          {
            hosts: [role === 'collector' ? node.collector_host : node.query_host],
            secretName: node.ingress_tls_secret,
          },
        ],
        rules: [
          {
            host: role === 'collector' ? node.collector_host : node.query_host,
            http: {
              paths: [
                {
                  path: '/v1',
                  pathType: 'Prefix',
                  backend: { service: { name: slotName, port: { number: port } } },
                },
              ],
            },
          },
        ],
      },
    });
    resources.push({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: slotName, namespace: inventory.namespace },
      spec: {
        serviceName: role,
        replicas: 1,
        podManagementPolicy: 'OrderedReady',
        selector: { matchLabels: podLabels },
        template: {
          metadata: { labels: podLabels },
          spec: {
            terminationGracePeriodSeconds: 20,
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              fsGroup: 10001,
            },
            topologySpreadConstraints: [
              {
                maxSkew: 1,
                topologyKey: 'topology.kubernetes.io/zone',
                whenUnsatisfiable: 'DoNotSchedule',
                labelSelector: { matchLabels: labels },
              },
            ],
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        { key: 'topology.kubernetes.io/zone', operator: 'In', values: [node.zone] },
                      ],
                    },
                  ],
                },
              },
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  { labelSelector: { matchLabels: labels }, topologyKey: 'kubernetes.io/hostname' },
                ],
              },
            },
            containers: [
              {
                name: role,
                image: inventory.app_image,
                command: [
                  'node',
                  `dist/apps/${role === 'collector' ? 'collector' : 'query-api'}/src/main.js`,
                ],
                ports: [{ name: 'http', containerPort: port }],
                envFrom: [
                  {
                    secretRef: {
                      name: role === 'collector' ? node.collector_secret : node.query_secret,
                    },
                  },
                ],
                env: [
                  { name: 'HOST', value: '0.0.0.0' },
                  { name: 'PORT', value: String(port) },
                  { name: 'TELEMETRY_CONFIG', value: '/etc/telemetry/config.json' },
                  {
                    name: 'TELEMETRY_INSTANCE_ID',
                    valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
                  },
                ],
                resources: {
                  requests: { cpu: '2', memory: '2Gi' },
                  limits: { cpu: '2', memory: '2Gi' },
                },
                startupProbe: {
                  httpGet: { path: '/ready', port: 'http' },
                  periodSeconds: 2,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: '/ready', port: 'http' },
                  periodSeconds: 2,
                  timeoutSeconds: 2,
                },
                livenessProbe: {
                  httpGet: { path: '/live', port: 'http' },
                  periodSeconds: 10,
                  timeoutSeconds: 2,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'config', mountPath: '/etc/telemetry', readOnly: true },
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'database-tls', mountPath: '/etc/postgres', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'config', configMap: { name: inventory.config_name } },
              { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
              { name: 'database-tls', secret: { secretName: inventory.database_tls_secret } },
            ],
          },
        },
      },
    });
  }
  resources.push({
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: role, namespace: inventory.namespace },
    spec: { minAvailable: 2, selector: { matchLabels: labels } },
  });
}
resources.push({
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name: 'telemetry-ingress', namespace: inventory.namespace },
  spec: {
    podSelector: {},
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: inventory.ingress_namespaces.map((name) => ({
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
        })),
        ports: [
          { protocol: 'TCP', port: 4320 },
          { protocol: 'TCP', port: 4321 },
        ],
      },
    ],
  },
});
for (const slot of ['a', 'b'])
  resources.push({
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: `maintenance-${slot}`, namespace: inventory.namespace },
    spec: {
      schedule: '* * * * *',
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          activeDeadlineSeconds: 30,
          backoffLimit: 1,
          template: {
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
              },
              containers: [
                {
                  name: 'maintenance',
                  image: inventory.app_image,
                  command: ['node', 'dist/scripts/maintain.js'],
                  envFrom: [{ secretRef: { name: inventory.maintenance_secret } }],
                  volumeMounts: [
                    { name: 'database-tls', mountPath: '/etc/postgres', readOnly: true },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  resources: {
                    requests: { cpu: '100m', memory: '128Mi' },
                    limits: { cpu: '500m', memory: '256Mi' },
                  },
                },
              ],
              volumes: [
                { name: 'database-tls', secret: { secretName: inventory.database_tls_secret } },
              ],
            },
          },
        },
      },
    },
  });
await json('applications.json', { apiVersion: 'v1', kind: 'List', items: resources });
await writeFile(
  resolve(directory, 'pgbackrest.conf'),
  `[global]\nrepo1-path=${inventory.backup.repository}\nrepo1-retention-full=2\nrepo1-cipher-type=aes-256-cbc\nstart-fast=y\nprocess-max=2\n\n[${inventory.cluster}]\npg1-path=${inventory.data_directory}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `Rendered ${inventory.nodes.length} fault domains and application resources to ${directory}\n`,
);
