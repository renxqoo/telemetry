# Application HTTP services

`createCollector({ store, config, now? })` and `createQueryApi({ store, config, cursorKeys, now? })` synchronously return a Fastify instance. Use `listen`, `inject`, and `close` normally. The caller owns the store and closes it after the HTTP server drains. `store` implements `TelemetryStore`. `config` is the return value of `createConfigManager(input, { now? })`. `cursorKeys` is a nonempty array of `{ id, secret }`; the first key signs, all keys verify. Each secret requires at least 32 UTF-8 bytes. Keys remain in memory, outside the configuration file.

The manager fully validates and freezes configuration, atomically replaces it with `update(input)`, refuses revision or creation-time rollback, and rejects new requests at expiry. An invalid update leaves the old valid configuration active. `status()` reports `active_revision`, configuration `digest`, `expires_at`, and `valid`. HTTP `/live`, `/ready`, and `/metrics` contain no credentials or event data. `/ready` checks the driver as well as the current configuration. The per-instance concurrency gate retains its slot until a timed-out or disconnected store operation exits. A disconnected request without pending store work immediately releases its slot and cancels its deadline timer. HTTP success and error envelopes use a server-generated UUID v4 request_id compatible with SDK validation. The body receive timeout applies only until parsing finishes; storage and COMMIT continue under the shared request deadline. Deadlines abort store work; write confirmation at a deadline is reported as unknown. No response body or request query is logged.

Configuration is strictly validated; unknown fields are rejected. All fields below are required unless marked optional. The exported `Configuration` TypeScript type is authoritative:

Project IDs use the shared UUID validator and may use UUID versions such as v4 or v7; SDK expected identity and ACK validation use the same rule. Event and request IDs remain lowercase UUID v4. All three retention day counts must be integers from 1 through 3660. Invalid initial configuration is rejected, and invalid updates retain the previous active configuration.

```ts
const configuration = {
  schema_version: '2',
  revision: 1,
  created_at: '2026-11-01T00:00:00.000Z',
  not_before: '2026-11-01T00:00:00.000Z',
  expires_at: '2026-11-02T00:00:00.000Z',
  profile: 'development',
  endpoints: ['http://127.0.0.1:4320'],
  trusted_proxies: [],
  limits: {
    max_concurrent: 10,
    request_timeout_ms: 3000,
    body_timeout_ms: 750,
    shutdown_timeout_ms: 15000,
    latency_buckets_ms: [10, 50, 100, 250, 500, 1000, 2000, 3000],
  },
  retention: { event_days: 30, receipt_days: 7, audit_days: 90 },
  projects: [
    {
      id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f',
      environments: ['production'],
      services: ['web'],
      events: { model_viewed: { model_id: { type: 'string', nullable: false } } },
      error_policy: {
        properties: { operation: { type: 'string', nullable: false, values: ['generate'] } },
        codes: ['generation_failed'],
        safe_messages: [],
      },
      browser_keys: [
        {
          key: 'pub_example',
          environment: 'production',
          service: 'web',
          origins: ['https://example.com'],
        },
      ],
      service_accounts: [
        {
          key_id: 'reader',
          secret_sha256: '<64 lowercase SHA-256 hex characters>',
          environments: ['production'],
          services: ['web'],
          permissions: ['read:events', 'read:errors'],
        },
      ],
      quota: { events_per_second: 500, burst: 1000 },
    },
  ],
};
const config = createConfigManager(configuration);
const collector = createCollector({ store, config });
const query = createQueryApi({
  store: queryStore,
  config,
  cursorKeys: [{ id: 'current', secret: injectedCursorSecret }],
});
```

This example requires a current validity window and a real secret digest. Service tokens are `key_id.secret`, where secret is at least 32 UTF-8 bytes and has no whitespace. Store only SHA-256 of the secret portion in `secret_sha256`. Digest comparisons use constant-time equality. A browser key binds one environment/service and exact Origin. Browser requests carrying Cookie or Authorization are rejected. `ha` requires HTTPS endpoints and HA driver capabilities. Trusted proxy entries are Fastify proxy trust entries, supplied explicitly.

Property policies support `type: string | number | boolean`, `nullable`, optional same-type `values`, and optional numeric `min`/`max`. Unregistered properties, names, and error codes yield indexed `invalid_event`. Error safe messages are retained only when explicitly enumerated. Frames accept only file paths, credential-free http/https/file URLs, Node built-in module identifiers and webpack/webpack-internal URLs. HTTP, HTTPS and file URLs become paths, query and fragment text is removed, and frames using other schemes or credentialed URLs are dropped. Payload digest is calculated before this projection. The fingerprint uses a v1 prefix and the authenticated project, environment, service, source, release, type, code and first three projected frames. Quotas are event token buckets per project per receiving instance; 429 carries Retry-After. No global quota is claimed.

Lists use exact registered HTTP filters and received-time bounds, at most 7 days and 500 rows. A missing range defaults to the previous 24 hours. Page cursors bind current permissions, services, kinds, endpoint category, normalized filters, order, driver and contract version, and expire after 15 minutes. Store page cursors are internal JSON `PageKey` values; only the application HMAC-signed token is sent to HTTP clients. The driver performs lookup, expiry/category/service filtering, and audit atomically.

Metrics expose bounded route-template/method/status request counters, request-duration histograms using the configured strictly increasing `latency_buckets_ms` (1–32 buckets), controlled rejection codes, active requests, active configuration revision/digest, validity and expiry timestamp. Changing histogram boundaries clears in-process duration counters. No user/event/request identifiers or raw query strings become labels.

## Node entry points

`apps/collector/src/main.ts` and `apps/query-api/src/main.ts` call `startService(role, createStore)` from the application runtime. Provide `TELEMETRY_CONFIG` as a structured configuration file path and `TELEMETRY_SECRETS_FILE` as an owner-only 0600 JSON file. Its schema is `{ database_url, cleanup_database_url?, cursor_keys?, store_options }`, where `store_options` contains required `instanceId`, `nodeId` and optional PostgreSQL pool/statement/lock/commit/response/cleanup budgets. HA includes `requireTls: true` and `physicalNodes: [{ id, connectionString, cleanupConnectionString }]` for the driver's physical-node contract. Query requires cursor keys. `TELEMETRY_INSTANCE_ID` overrides the stable instance identity for StatefulSet replicas. `HOST` defaults to loopback; public container listeners explicitly inject `HOST=0.0.0.0`. `PORT` defaults to 4320 (collector) or 4321 (query).

Instead of a secret file, inject `DATABASE_URL`, optional `TELEMETRY_CLEANUP_DATABASE_URL`, optional `TELEMETRY_CURSOR_KEYS_JSON` and `TELEMETRY_STORE_OPTIONS_JSON`. No secrets are accepted as process arguments. The runtime checks storage readiness before listening, polls configuration every 15 seconds, and preserves valid active configuration on update failure. SIGINT/SIGTERM stop admission and drain HTTP/store work under one shutdown deadline. `startService` returns `{ app, config, close }` for controlled lifecycle embedding. Production HA and SLO still require the independent topology/fault exercises described by the operational design.

Stored query events include `clock_skew_ms = received_at - occurred_at` in milliseconds. It is an observed client/server time difference including transit delay, and is not a clock-accuracy or latency guarantee.

Service account keys have separate write and read roles: a key combining `write:server` with any `read:*` permission is rejected during configuration validation. Generate independent secrets for the writer and reader accounts.

## 链路采集与查询

配置 schema 为 2。新增权限 write:traces/read:traces，任一 write:* 与任一 read:* 不得混在一个帐号；旧事件权限不会隐式授权 trace。项目 trace_policy 默认为空白名单，trace_quota 默认每秒 2000、burst 4000；limits.traces 为有界采集预算及 trace 子并发配额，limits.trace_queries.page_bytes 为 4–8 MiB，retention.trace_days 默认为 30。默认子并发 10，不能大于全局 max_concurrent。所有配置均原子校验，过期和无效更新按现有规则拒绝。

POST /v1/traces 接受 OTLP JSON/Protobuf 与 identity/gzip，需要 Bearer 秘密和 X-OneAster-Environment。Cookie/Origin 不放行。成功/部分成功使用 OTLP 响应；失败包括提前的鉴权、正文、并发和截止错误都使用同编码 google.rpc.Status，未知媒体类型用 JSON。200 仅在当前持久化 profile 的提交确认后返回，临时数据库故障不是 partial success。

GET /v1/spans 与 GET /v1/traces/:trace_id 使用 read:traces、固定筛选、签名游标和同步审计。按接收时间分页，默认最近 24 小时、最大 7 天，每页最多 500 项，同时按完整响应字节截连续前缀。详情只展示授权服务片段，completeness 为 unknown，无可见记录统一审计后 404。纳秒和 int64 为字符串。

/metrics 包含固定名字的 telemetry_traces_*_total 接收/接受/拒绝/重复/冲突、投影删除、未支持扩展、压缩/解压字节、解码/写入时长计数，以及 telemetry_active_trace_requests；无 trace ID、操作名、属性或秘密标签。

完整字段、默认限制和安全策略见 [链路协议](../../docs/design/TRACES-SPEC.md)。旧配置须通过 `bun run config:convert input-v1.json output-v2.json` 离线转换，不提供在线双格式解析。
