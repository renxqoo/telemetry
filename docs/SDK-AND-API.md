# SDK、事件协议与 HTTP API

状态：首期已实现的 v1 契约。选型与部署见 [架构](ARCHITECTURE.md)，数据库规则见 [服务端设计](BACKEND.md)。以下名称和字段属于本项目公共契约，外部业务项目接入须显式配置。

## 1. 项目、身份与权限

一个项目对应一个独立数据域，项目内区分环境。服务帐号凭证固定绑定一个项目、允许的环境和服务，以及 `write:server`、`read:events`、`read:errors` 权限子集。浏览器公开写入标识绑定项目、环境、服务和允许的 Origin；不具有查询权限。

环境、服务等请求字段必须与认证范围匹配。服务端根据端点与有效凭证设置 `source=browser|server`；载荷不得自行指定可信来源、接收时间或认证主体。浏览器的用户 ID、请求 ID 仅作不可信关联信息，不能作为身份认证依据。

私密凭证使用至少 32 字节随机秘密，包含非秘密 key ID，配置保存秘密摘要，比较使用恒定时间机制。读写凭证分别生成。CLI 从权限为 0600 的凭证文件或秘密注入读取，禁止把秘密作为命令行参数、日志或游标输出。

## 2. 事件信封

项目 ID 在服务配置、SDK 预期身份和 ACK 中使用同一 UUID 校验规则，支持 v4、v7 等版本，并按配置中的字符串匹配。事件 ID 和服务生成的请求 ID 保持小写 UUID v4。配置的 event_days、receipt_days、audit_days 均为 1–3660 的整数；无效热更新保留旧配置。

一个请求只含同一项目、环境、服务、发布和构建的事件，字段如下。字符串长度均按 UTF-8 字节限制；事件和批次大小按最终 JSON 字节限制，超限以更严格条件为准。

| 字段 | 类型及约束 | 来源 |
| --- | --- | --- |
| `schema_version` | 固定字符串 `1` | SDK |
| `project_key` | 浏览器请求必需，服务端请求不得提供 | 公开项目配置 |
| `environment` | 1–32 字节，注册环境标识 | SDK 配置，服务端校验 |
| `service` | 1–64 字节，注册服务标识 | SDK 配置，服务端校验 |
| `release` | 1–128 字节，不包含用户数据 | 构建配置 |
| `build_id` | 1–128 字节，构建产物标识 | 构建配置 |
| `events` | 1–20 项，批内事件 ID 不重复 | SDK |

每项事件：

| 字段 | 类型及约束 |
| --- | --- |
| `id` | UUID v4，小写规范形式；SDK 创建后重试保持不变 |
| `occurred_at` | UTC ISO 时间，毫秒精度，例如 `2026-11-01T02:00:00.000Z`；是客户端时间，非排序权威 |
| `kind` | `event` 或 `error` |
| `name` | 1–64 字节，匹配 `[a-z][a-z0-9_.-]*`；普通事件名须在项目配置注册 |
| `properties` | 最多 32 个注册键，整个对象 ≤ 2 KiB；值为有限安全数字、布尔、≤256 字节字符串或 null，不允许任意嵌套对象 |
| `context` | 可选的 `request_id`、`trace_id`、`span_id`、`user_id`、`session_id`、`route`；trace/span 配对规则见下文，其余字段 ≤128 字节，route ≤256 字节 |
| `truncated` | 可选布尔值，表示 SDK 已裁剪允许裁剪的字段，默认 false |
| `sample_rate` | 可选有限数字，0 < 值 ≤ 1，表示显式配置的采样比例，默认 1；不作为可信计费或自动放大计数依据 |
| `error` | 仅 error 事件必需，event 事件不得提供 |

未知结构字段拒绝。项目属性按注册类型与值约束检查。金额只可作为明确单位的分析属性发送，不作为账务依据。客户端发生时间偏差单独标记，接收时间与保留期限由存储事务确定。

错误结构包含 ≤64 字节的安全 `type`、`mechanism`、布尔 `handled`、可选的已注册 code（≤64 字节）和 safe_message（≤256 字节），以及最多 30 个规范化位置帧。机制为 manual、window_error、unhandled_rejection、react_boundary、next_request 或 handled_result。帧文件标识 ≤512 字节、函数名 ≤128 字节，行号为 1 起始、列号为 0 起始的安全整数；未知位置省略，不填造假位置。

错误消息使用已注册的静态安全文案。SDK 不读取调用方原始 message、stack、cause，不从文本生成栈帧，SDK 错误的 frames 数组为空；错误类型、安全 code/message 和请求、用户、trace/span 关联信息仍可采集。SDK 对任意抛出值、循环对象、getter 和不可序列化值做有界处理，不能因采集本身使业务抛错。

Collector 仍接收符合本节约束的结构化 ErrorFrame，CLI 仍可对该类数据执行本地符号化。SDK 省略未采集的原始栈不设置 truncated，上下文裁剪仍设置该标记。

下例是一条 error 事件片段，放入相同的信封 events 数组；operation 属性需要在项目中注册：

```json
{
  "id": "77abe2c3-69cb-4830-9b4e-6521d7c64fe8",
  "occurred_at": "2026-11-01T02:00:00.000Z",
  "kind": "error",
  "name": "runtime.error",
  "properties": {"operation": "generate"},
  "context": {"request_id": "request-example"},
  "error": {
    "type": "Error",
    "mechanism": "manual",
    "handled": true,
    "frames": [{"file": "/_next/static/chunks/studio-example.js", "function": "run", "line": 120, "column": 8}]
  }
}
```

单事件最终 JSON ≤8 KiB，批次 ≤32 KiB。SDK 在创建不可变待发送快照前裁剪可裁剪的上下文字段，并记录 `truncated` 系统标记；无法形成有效事件时丢弃并计数。服务端不静默裁剪超限请求后确认一个不同事件。

## 3. SDK 公共能力与生命周期

SDK 包名为 `@oneaster/telemetry`，工作区与 dist/telemetry-sdk 均提供构建入口，尚未发布到公共包仓库。browser、server、react、next/client、next/server 分入口导出。

```ts
const telemetry = createBrowserClient({
  endpoints: ['/_telemetry/v1/ingest/browser'],
  projectKey: publicProjectKey,
  environment: 'production',
  service: 'web',
  release: buildRelease,
  buildId,
  events: {
    model_viewed: { model_id: { type: 'string', maxBytes: 128 } },
  },
  errorProperties: {
    operation: { type: 'string', enum: ['generate'] },
  },
});

telemetry.track('model_viewed', { model_id: modelId });
telemetry.captureError(error, { requestId, operation: 'generate' });
const result = await telemetry.flush({ timeoutMs: 5000 });
await telemetry.close({ timeoutMs: 2000 });
```

配置错误在创建客户端时明确抛出。生产 endpoints 可提供多可用区受控地址，节点故障时在总重试预算内轮换；429 不通过换端点规避。`track`、`captureError` 返回事件 ID 或 null，不能表示持久化成功；运行时采集失败进入有限诊断计数，不向业务路径抛错。`operation` 映射为已注册安全属性，不允许任意自由文本上下文。

绝对 SDK 端点只允许 HTTPS 或 loopback HTTP（127.0.0.1、localhost、[::1]）；浏览器允许同源相对路径，并在创建时按实际 location.origin 固定为绝对地址，fetch 与 Beacon 共用该地址。相对端点沿用页面协议，不依赖 document.baseURI 或后续 base 标签；缺失或 opaque origin 时拒绝相对配置。反斜杠、控制字符、凭证、查询和片段不允许进入端点。事件调度、重试预算、Error 对象去重窗口和 flush/close 截止采用单调时钟；墙钟只用于发生时间及 HTTP 日期换算。

| SDK 入口 | 设计签名与语义 |
| --- | --- |
| createBrowserClient | 初始化 endpoints、公开 projectKey、environment、service、release、buildId，默认安装可清理全局错误监听 |
| createServerClient | 相同构建与范围配置，使用私密 writeToken，不提供全局用户设置方法，不自动修改进程致命错误处理 |
| track | `track(name, properties, context?) -> string 或 null`，只接受注册事件与属性 |
| captureError | `captureError(error: unknown, context?) -> string 或 null`，接受任意抛出值并安全规范化 |
| context | 可选 requestId、traceId、spanId、userId、sessionId、route、operation；ID 字段映射 snake_case，operation 映射注册属性 |
| setUser | 仅浏览器提供 `setUser(id: string 或 null)`，按协议限制校验；服务端每调用显式传 userId |
| reset | 仅浏览器提供，清理用户并生成新内存 session；已排队事件保留捕获时的不可变上下文，不重标为新用户 |
| flush / close | 都接受 timeoutMs，返回 FlushResult；close 还完成关闭状态与资源清理 |

通用 SDK 只公开调用方需要的采集和生命周期能力；框架适配自行设置受支持的 mechanism，不向业务开放任意来源覆盖。所有事件在入队时复制并冻结逻辑快照，调用方后续修改 properties/context 不能改变重试载荷。

浏览器实例允许设置不透明用户上下文，退出或切换帐号时必须 reset。匿名 session 默认仅驻留内存，不使用 Cookie 或持久存储。服务端 SDK 禁止使用跨请求可变用户上下文，每次调用显式传入请求上下文。

| 阶段 | 行为 |
| --- | --- |
| active | 接收事件；正常间隔约 1 秒批量发送；错误优先调度 |
| flushing | 每实例同一时刻最多一个上报请求；新事件仍受队列上限约束 |
| closing | 拒绝新事件；在关闭预算内尝试排空 |
| closed | 解除监听、清理定时器、取消请求、释放引用；后续采集返回 null |

默认队列上限 200 事件且总计 256 KiB，包含重试保留与在途事件。错误预留 50 个位置，且仍受整体字节上限限制；满载优先淘汰普通事件。任何丢弃都增加按原因统计的诊断计数。正常事件与错误默认均不采样，`sampleRate.event`/`sampleRate.error` 可分别配置 [0, 1]；0 在本地关闭该类别并计 `sampled`，保留事件的协议比例仍为 (0, 1]。

可选 `eventFilter: (event: CaptureEvent) => boolean` 在规范化、白名单检查及采样后、入队前同步执行。参数为深度冻结的安全事件，无原始 Error 和凭证。true 接受，false 拒绝并计 `filtered`；抛错或非布尔返回计 `filter_failure` 并拒绝，Promise 不被等待且拒绝被处理。过滤器中的递归采集被拒绝，期间关闭客户端后不再入队。重试和 Beacon 复用已接受快照，不重新调用过滤器；已入队 Error 的对象去重仍复用原 ID。过滤器不能修改事件或绕过 Collector 校验。

每事件从首次发送开始最多 5 次 HTTP 尝试、总重试预算 60 秒，指数退避加抖动，单次等待上限 16 秒。超过队列或重试预算的未确认事件允许丢失；这是 SDK 明确能力边界，不计为服务端已确认事件丢失。

`flush` 返回 `acknowledgedIds`、`pendingIds`、`droppedCount` 和 `timedOut`。只有完整校验过成功响应的 ID 才进入 acknowledged；Beacon 入队只进入未知送达状态，不算已确认。close 截止后释放剩余内存，记录未确认丢弃数量。

## 4. 接收 API、成功与重试

| 端点 | 认证与结果 |
| --- | --- |
| `POST /v1/ingest/browser` | 公开 project_key；Origin、环境、服务约束；source 固定 browser |
| `POST /v1/ingest/server` | `Authorization: Bearer <write-token>`；要求 write:server；source 固定 server |

正常请求 `Content-Type: application/json`。首期不接受压缩请求体，避免解压资源不明确。浏览器可通过同源固定代理路径访问；代理剥离 Cookie、认证头和上游私密头，不给浏览器路径注入服务端写入凭证。跨域方式只开放明确 Origin，浏览器写入不使用 Cookie 认证。

请求示例中的标识全部为占位与样本数据：

```json
{
  "schema_version": "1",
  "project_key": "pub_example",
  "environment": "production",
  "service": "web",
  "release": "2026.11.01",
  "build_id": "web-example",
  "events": [{
    "id": "44bf94dc-17a7-4462-9528-dd16b4978cad",
    "occurred_at": "2026-11-01T02:00:00.000Z",
    "kind": "event",
    "name": "model_viewed",
    "properties": {"model_id": "example-model"}
  }]
}
```

`200` 只在所列事件全部达到跨故障域持久性后返回，不使用提前受理的 `202`：

```json
{
  "request_id": "ee31edb7-81b7-4c6d-afba-225a54f1c4b5",
  "project_id": "0fcff045-b764-4f86-a82d-5b999b4b8a4f",
  "environment": "production",
  "source": "browser",
  "service": "web",
  "acknowledged": [{
    "id": "44bf94dc-17a7-4462-9528-dd16b4978cad",
    "status": "stored",
    "received_at": "2026-11-01T02:00:01.000Z",
    "retain_until": "2026-12-01T02:00:01.000Z"
  }]
}
```

重复事件使用 `already_present`，返回原首次接收时间与截止时间；重试不延长保留期。SDK 校验响应身份、ID 全集、类型与字段约束。无效 200 响应视为未知结果，按相同 ID 重试。

错误统一为 `request_id` 与 `error` 对象，包含 `code`、安全 `message`、`retryable`、可选 `retry_after_ms`、`outcome=not_committed|unknown` 和仅引用输入 ID/索引的 `items`。不得回显原始载荷、凭证、已存载荷或摘要。

冲突响应样例。outcome 只描述当前尝试，不表示该身份从未存在过记录：

```json
{
  "request_id": "ee31edb7-81b7-4c6d-afba-225a54f1c4b5",
  "error": {
    "code": "event_conflict",
    "message": "Event identity conflicts with an existing payload.",
    "retryable": false,
    "outcome": "not_committed",
    "items": [{"index": 0, "id": "44bf94dc-17a7-4462-9528-dd16b4978cad", "reason": "payload_mismatch"}]
  }
}
```

| HTTP / code | 语义 | SDK 动作 |
| --- | --- | --- |
| 400 invalid_request / unsupported_schema | JSON、字段或协议版本错误 | 终止该请求，记录本地诊断 |
| 401 unauthenticated / 403 forbidden | 当前凭证无效或范围不符 | 停止自动重试，等待配置修正 |
| 409 event_conflict | 相同事件身份、不同规范载荷 | 丢弃明确冲突项；其余原事件可在总预算内重组一次 |
| 410 event_expired | 原事件已过保留期或处于删除收据状态 | 不重建、不重试该 ID |
| 413 payload_too_large | 字节或数量上限超出 | 合法事件可拆批一次；超大单事件丢弃 |
| 422 invalid_event | 项目事件或属性策略不符 | 按明确索引移除无效项；其余原事件可重组一次 |
| 429 quota_exceeded | 超出已声明项目配额 | 在总预算内遵循 Retry-After，不增加发送压力 |
| 503 overloaded / storage_unavailable / confirmation_unknown / audit_unavailable | 系统过载、依赖或确认失败 | 退避重试；unknown 不等于未写入 |
| 网络断开、超时或不完整响应 | 结果未知 | 相同 ID 和不可变载荷重试 |

错误响应不得确认部分事件。不同驱动发生失败时可能已部分写入，所以重组或重试仍须保持原 ID 与载荷。PostgreSQL 驱动提供更强的整批事务原子性。服务自身过载用 503；不能把它伪装为项目配额 429 来排除 SLO 失败。

## 5. 查询、游标与一致性

| API | 必需范围与能力 |
| --- | --- |
| `GET /v1/events` | read:events；environment、from、to；source、name、service、release、request_id、trace_id、span_id、user_id 为可选精确筛选 |
| `GET /v1/errors` | read:errors；environment、from、to；固定 error 类别，可筛选 code、fingerprint、service、release、request_id |
| `GET /v1/events/{source}/{id}` | read:events；指定 environment 和 service；error-only 凭证使用下面的错误详情端点 |
| `GET /v1/errors/{source}/{id}` | read:errors；指定 environment 和 service；只返回 kind=error 的记录 |

项目和 allowedServices 从当前凭证与有效配置取得。列表未指定 service 时，只查询允许服务集合；指定 service 必须属于该集合。allowedKinds 由端点和当前权限确定：events 端点允许 event/error，errors 端点固定只允许 error。详情、收据与到期判断同时受服务与类别范围限制，越范围记录统一视为 404，不能通过收据存在性泄漏另一服务或普通事件的数据。

详情在完成同事务审计后，把 found 映射为 200、expired 映射为 410 event_expired、absent 映射为 404 not_found。只有可见且类别匹配的过期收据可以产生 410；错误详情查询普通事件 ID 时始终返回 404，包括普通事件已删除、仅剩收据的情况。收据不再保留后返回 404，不承诺无限期判断到期；依赖或审计失败仍返回 503。

事件身份为 `(project_id, environment, service, source, event_id)`。时间范围为服务端 received_at 的左闭右开区间；默认最近 24 小时，单次最大 7 天，结果默认 100 条、最大 500 条。发生时间仅用于展示，不作为权威分页键。默认按 `(received_at DESC, service DESC, source DESC, event_id DESC)` 排序。

游标签名绑定项目、环境、有效 allowedServices 与 allowedKinds 集合、权限所需类别、规范筛选、排序、固定时间上界、最后一项键、驱动与契约版本、到期时间。凭证每页重新授权；权限集合改变后旧游标无效，游标不是访问许可。游标有效 15 分钟，过期或筛选不匹配返回 400 invalid_cursor；切换驱动后不重放旧游标。

每次列表或详情查询使用一个 REPEATABLE READ 数据库快照，并固定本次到期判定时刻 as_of；收据查找和事件读取共用它，不能依靠默认 Read Committed 的多次 SELECT。as_of 在快照建立后取得，之后到期的事件可在本请求总截止内按原快照返回；as_of 已到期的新查询隐藏事件。跨 HTTP 页不持有同一个 MVCC 快照，各页重新确定 as_of；并发的迟提交可能落在已经翻过的位置。

v1 分页与导出始终采用 live-pagination，不提供跨页严格快照。停写并排空在途事务只能消除迟提交，不能阻止各页 as_of 推进以及数据在翻页期间到期隐藏，因此停写也不能保证完整盘点同一时刻的数据。严格盘点需要另行设计跨页快照及覆盖导出期间的保留保护协议。CLI 导出清单必须写明 live-pagination 及其限制。

查询结果返回 items、next_cursor、query_id、consistency 和 range；不默认做昂贵 total count。首期走主库，已确认事件通过按 ID 读取可见；查询失败不伪装为成功空列表。查询数据与审计屏障在同一数据库连接事务完成后才返回结果，见服务端设计。

## 6. CLI 与版本演进

CLI 提供 events list、errors list、events get、errors get、export、symbolicate 和 doctor；源码入口为 `bun packages/cli/src/main.ts`，构建入口为 `node dist/packages/cli/src/main.js`。list/get 调用 HTTP API，详情必须携带环境、服务、来源和 ID。export 逐页写 NDJSON 和附属清单，记录时间范围、筛选摘要、条数、是否完成及 live-pagination 语义。退出状态为 0 完成、1 运行失败、2 参数错误、3 部分导出；半份文件不得标为完整导出。

symbolicate 仅从显式指定的本地构建目录读取，与 service/release/build_id 匹配；拒绝目录逃逸和任意网络下载。结构化帧使用行号从 1、列号从 0 开始的协议，CLI 转换成源码映射库要求的坐标并用人工样本验收。doctor 输出版本、端点连通性和权限范围，不输出秘密或完整连接串。

schema_version 与 HTTP 路径版本分别管理数据和 API 兼容性。v1 新增可选字段前先发布接收端兼容，再发布 SDK；收集到旧客户端退出证据后再移除旧协议。未知主版本明确拒绝，不静默推断。schema、派生类型、兼容样本与生成的接口文档在同一变更更新。

## 7. 安全采集与框架接入

同一份协议 schema 与规范化规则供 SDK 和接收端使用，数据库运行时类型不得外泄。浏览器 SDK bundle 不包含 Fastify、数据库、Node 内置模块或服务端凭证；框架适配通过可选 peer 依赖和独立入口提供。

属性白名单优先使用枚举、模型 ID、状态和数值，不开放任意自由文本。安全消息需项目显式允许；服务端仍执行二次安全投影，错误和拒绝日志不记录请求正文。Fastify 与入口日志仅记录路由模板/路径，不记录原始 query、Cookie、Bearer、SQL 参数或连接串；数据库错误日志只保留安全分类与 SQLSTATE。仅靠字段名或正则不能证明任意文本无敏感数据，因此默认不上传原始 message。

浏览器通过 error/unhandledrejection 建立轻量可清理监听；同一 Error 对象被边界和全局监听观察时，在有限窗口内复用一次逻辑事件，不把多次独立异常按相同文本合并。跨实例和热更新避免重复挂载监听。

captureGlobalErrors 仅控制自动错误采集；关闭后仍保留 pagehide/visibilitychange 的 Beacon 补发。同项目、环境与服务范围的全局异常交给最近启用自动捕获且未关闭的实例；页面生命周期交给最近创建且未关闭的实例，关闭后恢复此前接收者。

React 错误边界捕获渲染失败；Next 客户端在 instrumentation-client 同步安装必要监听；异步导入不保证在 hydration 前完成。服务端 onRequestError 有界等待确认或排空，保留原启动校验；已转为业务失败结果的异常主动记录。框架的预期控制流、主动取消与普通表单错误按明确分类处理，不全部当成系统故障。

Next.js 接入依据是 OneAster Client 当前安装包的本地文档；实际集成前必须按届时安装版本复核。业务 SDK/curl 直接访问 Core 的事实需要 Core 服务端采集，网站 SDK 无法替代。

Beacon 仅补发，不提供可读取的成功确认，也不能上传服务端私密 Bearer 凭证。[Beacon 规范](https://w3c.github.io/beacon/)

## 服务端链路与事件关联

tracing/server 导出、OTLP 接收、trace 查询及 CLI 的独立契约见 [链路规格](design/TRACES-SPEC.md)，接入见 [tracing SDK](../packages/sdk/TRACING.md)。trace 不是 event/error，不共享事件白名单或逐项 ACK；写读分别需要 write:traces/read:traces。

event/error 可显式传入 context.span_id，必须同时提供合法非零 32 位十六进制 trace_id，span_id 为非零 16 位十六进制，二者规范化小写。SDK 使用 `{traceId,spanId}`。省略 span_id 时，旧 trace_id 仍按宽松文本契约接受。`/v1/events` 的 span_id 精确筛选也必须配合法 trace_id；不会自动跨表拼接或扩大查询权限。
