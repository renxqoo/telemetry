# POST /v1/traces 功能规格

状态：首版已实施的功能契约。SDK、采集、存储、API、CLI 与本地验证证据见 [实施与验收](../implementation/TRACES.md)。自行实现 OTLP，不引入 OpenTelemetry SDK。

配套：[技术架构](TRACES-ARCHITECTURE.md)、[独立审查记录](TRACES-REVIEW.md)。本文是功能与外部契约的唯一规格；架构文档负责实现机制。

## 1. 范围与交付边界

首版交付一个服务端链路追踪闭环：业务通过自研 Node.js SDK 创建 span、跨异步调用及 HTTP 传播上下文，经 OTLP/HTTP 上传，Collector 持久化，Query API 与 CLI 检索。接收端同时接受符合本项目鉴权和资源约束的外部 OTLP/HTTP 客户端。

| 功能 | 首版要求                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 接收 | `POST /v1/traces`，OTLP/HTTP JSON 和 Binary Protobuf，identity/gzip                                   |
| 数据 | ResourceSpans、ScopeSpans、Span、Event、Link、Status、AnyValue、schemaUrl、flags、上游 dropped counts |
| SDK  | 新增服务端 tracing 入口，手工 span、异步上下文、父子关系、异常状态、传播、采样、有界导出              |
| 检索 | span 列表、按 trace ID 分页读取 span，保留跨服务父子及 link 信息                                      |
| CLI  | `traces list`、`traces get`，JSON/NDJSON 输出                                                         |
| 关联 | event/error 的现有 `context.trace_id` 与新的 `context.span_id`；不把 span 写成 event                  |
| 隔离 | 服务端秘密凭证、项目/环境/服务权限、查询审计、限流、保留期                                            |

首版不包含 OTLP/gRPC、metrics/logs 接口、OpenTelemetry SDK/API/exporter/自动插桩依赖、浏览器 tracing、React/Next 自动追踪、全局 fetch/http/数据库 monkey patch、tail sampling、service map、分析聚合或产品 UI。浏览器 event/error 的现有 trace_id 透传继续可用，但不因此获得向 `/v1/traces` 写入的权限。

这些是本方案的首版范围选择，尚无吞吐和 trace 大小的业务实测；限制值是可调的保护基线，不能视为容量承诺。

## 2. 领域不变量

1. 一个 span 的身份是 `(project_id, environment, trace_id, span_id)`；service 是不可变载荷，不能用 service 变化制造第二个同身份 span。
2. span 仅在结束后导出；同身份同规范载荷重复发送只保留一条，不改变首次接收时间、策略版本、安全投影和保留期限。同身份异载荷永久拒绝，不能覆盖。
3. 全成功和部分成功中所有被接受的 span 均已完成当前 profile 要求的持久化；内存、SDK 队列和 SQL 已执行均不是成功确认。
4. 一个请求可包含同项目、同环境、多个已授权服务；不跨项目或环境。身份与授权来自凭证和已校验资源信息，不能由 span attributes 越权指定。
5. 父 span 可晚到、缺失、在其他服务或根本未采样。接收不能依赖父记录已存在，也不能因跨机器时钟偏差要求子 span 包含在父时间区间内。
6. trace 没有“已经完整”的可靠终态。读取返回当前可见、当前授权范围内的片段，不能宣称已收到全部 span。
7. trace/span ID 是关联信息，不是授权凭据；相同 ID 的其他项目、环境和未授权服务不可见。
8. 未结束、未发送、被采样、队列溢出及没有收到确认的 span 分别计数；只对已确认数据沿用平台保留期内持久性目标。

## 3. OTLP/HTTP 契约

### 3.1 请求入口和身份

路径固定为 Collector 的 `POST /v1/traces`；继续使用现有 Collector 端口配置，不额外占用 gRPC 4317 或更改现有 4320 默认端口。生产使用 HTTPS。

| Header                   | 规则                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `Authorization`          | 必填，沿用 `Bearer <key_id>.<secret>`，要求新增 `write:traces` 权限                                 |
| `X-OneAster-Environment` | 新增、必填，项目已注册且帐号被授权的环境；不从资源缺省推断                                          |
| `Content-Type`           | `application/json` 或 `application/x-protobuf`，允许大小写无关的 `charset=utf-8` 参数；其他类型 415 |
| `Content-Encoding`       | 缺省、`identity` 或单层 `gzip`；其他编码或多层编码 415                                              |
| `Accept-Encoding`        | 可发送 gzip；首版响应不压缩                                                                         |

响应统一带 `X-Request-Id` 和 `Cache-Control: no-store`。已知请求编码时，成功与错误响应均使用同一种编码；无法识别 Content-Type 时以 JSON Status 返回 415。不使用现有 event 接口的 acknowledged 数组或 ApiErrorBody。

公开 browser key、仅有 `write:server` 的帐号、读帐号均不能写 trace。该路径不提供 CORS 放行；携带 Cookie 或 Origin 的请求以 403 拒绝。合法服务器 exporter 不需要这些头。

资源规则：

- `resource.attributes[service.name]` 必须是非空 stringValue，UTF-8 最长 64 字节，且精确匹配项目及帐号注册的 service。任一非空服务未授权时整个请求 403，零写入。
- 缺失或类型错误的 service.name 为该 ResourceSpans 内各 span 的永久语义拒绝；不根据 scope.name 推导服务。
- `deployment.environment.name` 若存在，必须是与环境头一致的 stringValue；不一致或类型错误时整个请求 400，零写入。只识别该名称，不兼收其他环境属性别名。
- 不读取 resource 中的 project_id、tenant 或自述权限作为身份；未知属性仅受安全策略管理。
- `service.version` 是可选发布信息；不要求 OTLP 客户端提供现有 event 信封的 release/build_id。

### 3.2 请求数据与兼容边界

请求模型采用官方 `ExportTraceServiceRequest`，即 `resourceSpans → scopeSpans → spans`。空对象、空 resourceSpans、只有空资源组的消息和零字节 Binary Protobuf 均为合法空导出，鉴权和环境校验后返回全成功；零字节 JSON 不是合法 JSON，返回 400。

OTLP 特有 JSON 规则及响应语义按 [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)；精确消息字段按固定版本的 [TraceService](https://github.com/open-telemetry/opentelemetry-proto/blob/40cb2e516c60dd91796d909c7277e36a20c38b55/opentelemetry/proto/collector/trace/v1/trace_service.proto) 与 [Trace](https://github.com/open-telemetry/opentelemetry-proto/blob/40cb2e516c60dd91796d909c7277e36a20c38b55/opentelemetry/proto/trace/v1/trace.proto) 定义。

| 项目             | 本接口要求                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| JSON 字段        | lowerCamelCase；未知字段忽略并不进入摘要。snake_case 不是别名，按未知字段处理；缺少必需数据仍会拒绝                           |
| traceId          | 大小写均可的 32 位十六进制，非全零；规范化为小写；Binary 为 16 bytes                                                          |
| spanId           | 16 位十六进制，非全零；Binary 为 8 bytes                                                                                      |
| parentSpanId     | 未设置或空 bytes 表示根；非空需合法 8 bytes，且不能等于自身 spanId                                                            |
| kind/status.code | JSON 仅数字枚举，不接受名称字符串；已知 kind 0–5、status 0–2；未知整数保留，并按 unknown 展示                                 |
| flags            | uint32，完整保留；查询 sampled 由最低位导出，不把其余位清零                                                                   |
| 时间             | startTimeUnixNano/endTimeUnixNano 为 uint64，必须非零、end≥start；零时长允许；不限制父子机器时间关系                          |
| 64 位 JSON 数    | 字符串按十进制/指数精确解析，不经过 Number；裸数值先按标准 binary64 解释、再校验整数与范围并转 BigInt；输出始终为十进制字符串 |
| name             | 必填，非空，UTF-8≤256 bytes；作为操作名，不承载请求参数、用户 ID 或原始 URL                                                   |
| traceState       | 允许缺省；非空按 W3C 语法校验，最多 32 项、总计 512 bytes；安全保存规则见第 5 节                                              |
| Span Event       | timeUnixNano 为 uint64；事件不强制位于 span 区间内；name 非空、UTF-8≤256 bytes                                                |
| Link             | traceId/spanId 同样校验；允许跨 trace；不要求被引用 span 存在；保留 traceState/flags/attributes                               |
| dropped counts   | 上游 uint32 原样保存，不用 Collector 的删除数覆盖                                                                             |

AnyValue 支持 string、bool、int64、double、bytes、array、kvlist 和未设置值；内部保留类型，int64 用十进制字符串，bytes 用规范 base64，非有限 double 用类型内的 `NaN`/`Infinity`/`-Infinity` 字符串。只含 profiling string index 的值按空值处理并计入诊断，不作为 trace 内容解释；相同规则适用于 key_strindex。依据：[AnyValue 定义](https://github.com/open-telemetry/opentelemetry-proto/blob/40cb2e516c60dd91796d909c7277e36a20c38b55/opentelemetry/proto/common/v1/common.proto)。

Resource.entityRefs 属于上游 development 字段，首版按不支持的扩展忽略、计诊断且不进入摘要；不假称支持实体图。[Resource 定义](https://github.com/open-telemetry/opentelemetry-proto/blob/40cb2e516c60dd91796d909c7277e36a20c38b55/opentelemetry/proto/resource/v1/resource.proto)

ProtoJSON 的 null 按未设置处理，repeated 中的 null 元素非法；重复 JSON 对象键、多个已设置 oneof 分支、非法 UTF-8、错误长度、溢出和不可解码数据返回 400。标准数值解析规则依据 [ProtoJSON](https://protobuf.dev/programming-guides/json/)，OTLP 的 ID/枚举/字段名偏差优先。

发送方需要纳秒或int64精确值时必须使用JSON字符串或Binary Protobuf。按ProtoJSON裸数值语义，`1793491200123456789`被解释为`1793491200123456768`，而字符串`"1793491200123456789"`保持原值，两者摘要不同；`"1000"`、裸数值`1000`和Protobuf的1000摘要相同。不把裸数值舍入后的值虚称为无损；uint64最大值字符串合法，而相同裸数值经binary64变成2^64后应因越界400。

同一 attributes/kvlist 内业务 key 不允许重复；该规则及非法 ID、时间逆序、无 name、错误 Link 等可定位到 span 的语义问题，仅永久拒绝受影响 span。Resource 或 Scope 的语义错误影响其全部后代 span。不可解码/错误消息形状无法安全划分 span 时整请求 400。

### 3.3 成功、部分成功和失败

全成功返回 HTTP 200；JSON body 为 `{}`，Binary body 为合法的零字节 ExportTraceServiceResponse。全部已存在的相同 span 仍为全成功。

只有可安全定位的永久数据问题使用部分成功；先保证其余 span 完成持久化，再返回：

```json
{
  "partialSuccess": {
    "rejectedSpans": "1",
    "errorMessage": "1 span rejected: invalid_span."
  }
}
```

rejectedSpans 按输入 span 出现次数计数；同身份同载荷出现多次均视为被接受，实际只持久化一条；同请求内同身份异载荷的所有出现均拒绝，不按到达顺序挑赢家。与已存记录冲突时拒绝冲突的输入，不覆盖历史。全部 span 永久拒绝时允许 200，rejectedSpans 等于全部数量。

安全策略删除了字段但没有拒绝 span 时，返回 rejectedSpans=`"0"`、固定英文警告；客户端将批次视为完成。错误信息仅包含固定原因类别和数量，最长 512 bytes，不包含输入正文、属性值、未知服务名称或其他租户记录。

HTTP 4xx/5xx body 使用 [google.rpc.Status](https://github.com/googleapis/googleapis/blob/master/google/rpc/status.proto) 的 JSON/Binary 编码，首版仅输出固定英文 message、可选 code，不输出 details。例如 JSON：`{"code":14,"message":"Storage confirmation unavailable."}`。重试判断以 HTTP 状态为准。

| 情况                                              | HTTP               | 是否重试原批次     | 数据结果                 |
| ------------------------------------------------- | ------------------ | ------------------ | ------------------------ |
| 解码失败、错误结构、环境头缺失或资源环境不符      | 400                | 否                 | 未写入                   |
| 没有有效凭证                                      | 401                | 否                 | 未写入                   |
| 无 trace 权限、未授权环境/服务、Cookie/Origin     | 403                | 否                 | 未写入                   |
| 压缩前后请求字节或总 span 数超限                  | 413                | 否，发送方调整批次 | 未写入                   |
| 不支持媒体类型/压缩                               | 415                | 否                 | 未写入                   |
| 实例项目 trace 配额不足                           | 429 + Retry-After  | 是                 | 未写入                   |
| 并发槽耗尽、配置不可用、存储/分区不可用、确认未知 | 503 + Retry-After  | 是                 | 未提交或结果未知         |
| 网络断开、客户端超时                              | 无可信结果         | 是                 | 未知                     |
| span 数据或身份冲突、原 span 已到期但收据尚在     | 200 partialSuccess | 否                 | 仅永久有效的其余项已确认 |

外部 exporter 还可能经过代理收到 502/504，按可重试处理；其余 4xx/5xx 不重试。partialSuccess 无论 rejectedSpans 是否为零都不重试；不能据 rejectedSpans 猜测具体哪条未写入。数据库超时/故障绝不能伪装成部分成功。

### 3.4 请求示例

以下示例要求项目注册 production/web，帐号有 write:traces；时间是任意合法采样数据，不作为当前时间限制。

```http
POST /v1/traces HTTP/1.1
Authorization: Bearer <key_id>.<secret>
X-OneAster-Environment: production
Content-Type: application/json

{
  "resourceSpans": [{
    "resource": {"attributes": [
      {"key": "service.name", "value": {"stringValue": "web"}}
    ]},
    "scopeSpans": [{
      "scope": {"name": "oneaster.manual", "version": "1"},
      "spans": [{
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "00f067aa0ba902b7",
        "name": "checkout.create",
        "kind": 2,
        "startTimeUnixNano": "1793491200000000000",
        "endTimeUnixNano": "1793491200123456789",
        "flags": 1,
        "status": {"code": 1}
      }]
    }]
  }]
}
```

成功响应为 200、Content-Type: application/json、`{}`，不增加 OTLP 未定义的批次回执字段。

## 4. 查询与 CLI 契约

查询在现有独立 Query API 上新增，仍用项目 ApiErrorBody、签名游标与持久化审计，要求新权限 `read:traces`。只拥有 read:events/read:errors 不隐式获得 trace 读取能力。

| 入口                             | 行为                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `GET /v1/spans`                  | 按接收时间分页检索 span；用于发现 traceId，不假装是 trace 聚合列表 |
| `GET /v1/traces/:trace_id`       | 返回指定 trace 当前授权范围内的 span，按接收时间分页               |
| CLI `traces list`                | 调用 `/v1/spans`，每项代表一个 span，保留 trace_id/span_id         |
| CLI `traces get --id <trace_id>` | 调用 trace 详情，可逐页 NDJSON 导出，流式打印、不无限缓存在内存    |

共同参数：environment 必填；from/to 为 UTC 毫秒 ISO 时间，过滤首次 received_at 的半开区间 `[from,to)`；缺省最近 24 小时，最大 7 天；limit 缺省 100、范围 1–500；cursor 为不透明签名值。详情也使用有限范围，调用方查旧 trace 需明确时间范围，不能无界全库扫描。

limit 是每页最多条数。另设 `limits.trace_queries.page_bytes`，缺省4 MiB、配置范围4–8 MiB，限制整个未压缩UTF-8 JSON响应体，包括items、游标和其他元数据；达到任一预算即截页，不保证填满limit。CLI固定接受最多8 MiB解压后响应体，与API上限一致；采集响应的64 KiB限制不用于查询。

为保证每条已接受span均可查询，安全投影按最终StoredSpan去除可信接收元数据后的紧凑JSON计量，`max_safe_span_bytes`缺省1 MiB、可配置范围1 byte–1 MiB；可信接收元数据上界16 KiB。入库前超安全投影预算的span按永久原因 `span_too_large` 拒绝，不写新收据、不截断已接受内容。查询每项按 `safe_payload_bytes + 16 KiB` 保守计费，另预留16 KiB页信封；这些硬上限取自统一协议定义。最小合法页预算也能容纳任何已接受单项。异常存量项或编码结果无法满足预算时返回503 storage_unavailable，不跳项、不返回伪空页。

列表允许 `service`、`trace_id`、`span_id`、`name`、`status_code`、`min_duration_ns`、`max_duration_ns` 精确筛选；纳秒筛选为无符号十进制字符串，min≤max。详情仅允许共同参数及可选 service。不提供任意 attributes 查询、SQL 或正则。未知、重复或类型错误参数返回 400。ID 大小写输入均规范化小写；status_code 为 int32 整数，包含未知枚举。

每项 StoredSpan 输出：可信 project_id/environment/service、trace_id/span_id/parent_span_id、name/kind/flags/status、start_time_unix_nano/end_time_unix_nano/duration_ns、类型化 attributes/events/links、resource/scope 与 schema_url、上游 dropped counts、collector_dropped、received_at/retain_until/policy_version。所有纳秒数和 int64 为字符串；空 parent_span_id 输出 null。name/status.message/事件名及资源字符串输出安全投影。

分页响应固定为 `{items,next_cursor,query_id,consistency,range,pagination,scope}`；consistency=`primary_committed`，pagination=`live-pagination`，scope=`authorized_services`。items 按 `(received_at DESC,trace_id DESC,span_id DESC)` 排序，游标绑定项目、环境、当前授权服务集合、全部过滤器、limit、范围、排序、page_bytes与存储契约版本。首次from/to缺省值只计算一次；后续省略时取游标内固定范围，不重新取当前时间。后续请求改变参数、权限或page_bytes时400 invalid_cursor，重新从第一页查询。

条数或字节截页时，next_cursor只指向最后实际返回项；有尚未返回的匹配项才生成游标，不指向探测项或首个放不下的项。每页返回满足顺序和两项预算的连续前缀，不跨过大项挑选后面的数据；审计row_count只记本页选定输出的数量，探测项不计入，也不作为客户端收件证明。存在匹配项时不得因字节截页返回空页。CLI继续沿next_cursor获取，不能把items.length小于limit当作结束。

详情额外返回 `trace_id`、`completeness:"unknown"`，且不返回全项目 span 总数、服务总数、全局 root 或全链路耗时。无可见记录（包括不存在、已到期、全部无服务权限、范围不包含）统一 404 not_found；不借部分权限区分这些状态。列表无结果返回 200 空页。所有结果与空结论都需要审计提交成功；审计失败返回 503。

客户端可按 ID 构造图；缺失父节点只显示引用，不生成虚构 span。跨服务时钟偏差、多根、自引用之外的环或恶意远端关系不会导致无限遍历；树形渲染并非首版 CLI 必需功能。分页不是时间点快照，迟到项可能出现在已读页面之前，需要重新查询才能看到。

CLI 复用当前凭证文件和环境变量，不新增明文 token 参数。`traces list` 使用与 API 相同的下划线过滤名；`traces get` 使用 `--id` 对应 path 参数，接受 environment/from/to/service/limit；两者支持新增 `--format json|ndjson`，get 支持 `--out <path>` 流式导出、同现有导出的文件安全规则。JSON 只返回一页，NDJSON 沿游标输出各项；失败和取消退出非零，不能把部分输出当完整导出成功。

## 5. 安全投影与关联

项目配置新增 trace_policy；默认拒绝保存任意自由属性值。service.name/environment 参与 scope 校验，不因安全投影丢失。允许业务配置分别声明 resource、scope、span、event、link 的属性白名单、类型和值范围；未声明或不符合规则的属性整项删除，不导致整 span 丢失。array/kvlist 若允许，递归子值必须满足同一规则和预算，否则删除整个属性。

首版属性策略支持 string/bool/int/double/bytes/array/kvlist/empty、UTF-8 或 bytes 长度上限、有限枚举、数值 min/max；int 的边界以 int64 十进制字符串配置，double 支持 finite 约束，array 声明 items 规则及 max_items，kvlist 声明 children 白名单。不可表达为完整安全规则的值默认删除。所有规则随配置原子校验，无“允许任意对象”开关。

name/scope.name/scope.version/service.version/schemaUrl 不做任意文本透传：项目分别配置允许的 span_names、event_names、scope_names、scope_versions、service_versions、schema_urls；缺省 span name 替换为 `span`、event name 为 `event`，其余未知字符串清空；name 的原始值仍受输入上限保护。status.message 只保留项目 safe_messages 精确匹配项，否则清空。持久化traceState使用项目tracestate_rules，按vendor key逐项声明非空safe_values精确白名单及max_value_bytes；必须同时命中key、value和长度才保留，缺省删除全部，link同规则。仅允许vendor key不足以证明任意值可安全保存。schemaUrl只存字符串，不联网请求。

Collector 删除数独立存为 collector_dropped，包含各层属性删除数、重写字符串数和 traceState 删除项数；不篡改上游 dropped counts。安全规则变化不会重投影已经存储的 span。原始 payload 仅用于内存校验与摘要，禁止保存为审计、请求日志、错误消息、磁盘 spool 或调试附件。

现有 event/error 新增可选 `context.span_id`，仅在同一 context 有合法 32 位 trace_id 时允许；span_id 必须为非零 16 位十六进制，二者规范化为小写。未携带 span_id 的现有 trace_id 仍按当前契约接受，不回填、不改写历史文本 ID。`/v1/events` 原有 trace_id 过滤可关联；新增 span_id 精确筛选必须与 trace_id 同时提供。关联查询仍各自检查 event/trace 权限，不做未授权跨表拼接。SDK 使用显式 context 传参关联，不让 event 客户端隐式依赖 tracing 模块。

## 6. 自研服务端 SDK

新增独立包导出 `@oneaster/telemetry/tracing/server`，公开函数 `createTracer`、`extractTraceContext`、`injectTraceContext`；不修改现有 createServerClient 返回类型。tracer 公开 startSpan、withSpan、currentContext、flush、close、getDiagnostics；span handle 公开 context、setAttribute、addEvent、setStatus、end。新增导出与构建产物需同步 package.json 和构建脚本。

```ts
const tracer = createTracer({
  endpoints: ['https://telemetry.example.com'],
  environment: 'production',
  service: 'web',
  writeToken,
  sampleRate: 1,
});
const remoteParent = extractTraceContext(request.headers);
const result = await tracer.withSpan(
  { name: 'checkout.create', kind: 2, parent: remoteParent },
  async (span) => {
    const headers = injectTraceContext(span.context);
    const response = await fetch(internalUrl, { headers });
    return response;
  },
);
```

参数类型与行为：

- createTracer 要求 endpoints/environment/service/writeToken/sampleRate；可选 resourceAttributes、scope（name/version）、traceStateRules及本节limits，类型化AttributeValue使用与接收端相同的AnyValue表示。traceStateRules与服务端tracestate_rules采用相同key/safe_values/max_value_bytes语义，缺省为空；endpoints沿用SDK的HTTPS/loopback约束。
- startSpan/withSpan 接受 name、kind（缺省 INTERNAL=1）、parent、attributes、links。parent 缺省继承本 tracer 的当前上下文，显式 null 强制新 trace。startSpan 不激活上下文；withSpan 在回调及其异步后代激活，返回回调相同值/Promise 或抛出原异常。
- `SpanContext={traceId,spanId,traceFlags,traceState,isRemote}`不可变。只自动添加关联字段，不自动添加用户、token或项目秘密；外部traceState是不可信输入，必须经过值规则过滤。
- 本地 trace/span ID 由密码学随机源生成，长度分别 16/8 bytes，拒绝全零，不使用 UUID 截断、时间戳或计数器。
- withSpan 成功保留 UNSET 状态；异常设置 ERROR，在 finally 结束，并原样重抛；不自动保存异常 message/stack，也不额外创建 error 事件。setStatus 接受数字 code 与可选安全 message；end 后所有修改不改变待发或已发载荷，重复 end 不重复入队。
- start/end 以单调时钟差值计算 duration，并用创建时 Unix 时间锚点得到纳秒时间；不要用两次 Date.now 相减。墙钟变化不能使 duration 变负。
- 本地 root 按 trace ID 确定性比例采样，sampleRate∈[0,1]；有合法 parent 时继承 sampled 位，不按本地比例重新决定。未采样也创建可传播的 context，不进入导出队列；Collector 不根据 sampled 位再丢弃有效上传。
- root 采样算法固定为 traceId 低 64 bits 与 `floor(sampleRate × 2^64)` 的无符号比较，0 永不采样、1 全采样；计算阈值避免浮点乘法越界。同 trace 决策一致。
- 上下文使用每个 tracer 的 AsyncLocalStorage；并发请求不能共享可变当前 span。withSpan 结束后已经派生的异步任务仍可能持有父 context，应显式开新 span；不偷偷为它们延长父 span 或业务生命周期。
- close 不等待业务 withSpan 回调；已进入的回调保持上下文到完成，最后一个回调退出后释放 AsyncLocalStorage。关闭后 withSpan 的回调同样获得局部上下文并在完成后清理，不重新开始记录。
- extract/inject 处理 [W3C Trace Context](https://www.w3.org/TR/trace-context/)：traceparent 非法时返回无 parent、丢弃 tracestate；非法 tracestate 单独丢弃。支持 00 格式及 W3C 的未来版本解析规则，拒绝 ff；始终输出 00，使用本次 span ID 作 parent-id，保留 sampled、清零输出中未知 flag bits。多值 traceparent 拒绝，tracestate 按标准顺序合并与限制处理。
- extractTraceContext(headers, options?)与injectTraceContext(context, options?)均接受traceStateRules，执行与持久化相同的vendor key/精确safe_values/长度规则，缺省删除全部tracestate；tracer对传入parent/link同样执行本实例规则。inject仅返回traceparent与通过值规则的tracestate，不自动转发Authorization、Cookie或baggage。业务显式决定目标是否可信，不做跨域自动传播。有效vendor名下的任意邮箱、token或其他非白名单文本也必须删除。

### 6.1 flush与close的快照和结果

`flush(options?: {timeoutMs?: number})`、`close(options?: {timeoutMs?: number})`的timeoutMs缺省5000，必须为1–30000的整数毫秒；非法参数在调用时拒绝，不启动发送任务。截止使用单调时钟，包含本次等待已有在飞请求、后续网络和退避；不会刷新批次既有retryBudgetMs或maxAttempts。

flush只观察调用时已结束且仍处于queued/in_flight/retry_wait的span快照S，N为其中的span数；此前已完成或已丢弃的数据、未结束span、调用后才入队的数据不属于S。flush触发该快照尽快发送，但不能绕过Retry-After；到调用截止时停止等待并返回不可变结果，不取消共享发送器、不清空队列、不阻止其他快照或后续数据继续有界重试。

close的S为首次调用时同样定义的待处理快照；首次调用立即停止接收新span，排空到完成或close截止，然后取消网络、计时器和退避，清空待处理队列；不强行结束业务span。多次close共享首次操作、截止和结果，不能用后来的timeoutMs延长它。关闭后startSpan返回nonrecording handle，withSpan仍执行回调；关闭后新flush返回空快照结果。close期间已有flush只统计各自原快照，新flush只观察当时仍待处理数据，均不延长close截止。

返回 `{confirmedSpans,rejectedSpans,unconfirmedSpans,pendingSpans,droppedSpans,timedOut}`。五个数量都是对S中span的最终处置计数，互斥且满足 `N=confirmedSpans+rejectedSpans+unconfirmedSpans+pendingSpans+droppedSpans`；一次逻辑span不因尝试次数重复计数。getDiagnostics提供实例累计值，不能用来填充单次调用结果；重叠flush可以各自统计同一span，但不能重复累加实例诊断。

| 字段             | 在本次结果中的含义                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| confirmedSpans   | 收到有效全成功或部分成功响应后，服务端明确接受的数量；重复确认也计入，不等于新增数据库行数                                    |
| rejectedSpans    | 有效partialSuccess的拒绝数量；或从未发生未知尝试、最终收到不可重试HTTP响应的数量。不表示历史上绝未存储过                      |
| unconfirmedSpans | 已终止本地处理，但曾有网络/超时/畸形200/502/503/504等未知结果且没有后续有效200解决的数量；重试预算耗尽、close取消在飞等归此类 |
| pendingSpans     | 调用返回时仍在队列/在飞/退避中、可以继续处理的数量；flush超时可非零，完成后的close必须为0                                     |
| droppedSpans     | 因本地编码/体积错误、close清理未发送数据或仅有明确未提交尝试后耗尽预算而终止，且没有未解决未知结果的数量                      |
| timedOut         | 本调用在自己的截止到达时仍未完成S，或被close截止提前终止等待；非“历史上曾经有一次网络超时”                                    |

若已有未知尝试后才收到401等永久HTTP失败，未被有效200解决的span计unconfirmed而非rejected；明确429未提交本身不产生unknown。有效200包括partialSuccess，按该响应对整批的处置结算；partial的rejected计数不能映射为具体span ID，rejected=0的警告仍完成批次、不重试。

为使无逐项ID的partial计数仍能归属S，批次不能跨过尚在等待的flush快照边界混入更晚入队的span。已在飞批次整体包含于其后建立的快照；发送器仍最多一批在飞，重叠flush共享网络操作而各自等待，不重复导出同一队列项。快照结果返回后冻结，之后的重试成功不会回写旧结果。

下表记结果为 `(confirmed,rejected,unconfirmed,pending,dropped;timedOut)`，未列出的数量为0：

| 前置与动作                                            | 独立预期                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| 仅A待处理，第一次flush收到200；无新数据再次flush      | 第一次 `(1,0,0,0,0;false)`；第二次 `(0,0,0,0,0;false)`         |
| A第一次网络未知，预算内重试收到200                    | `(1,0,0,0,0;false)`，不能重复计unknown或confirmed              |
| flush的A到截止仍在退避，随后后台成功                  | 旧结果固定 `(0,0,0,1,0;true)`；成功后无新数据再次flush为空快照 |
| A已在飞且结果未知、B尚未发送，close到截止取消并清空   | `(0,0,1,0,1;true)`，重复close返回同一结果                      |
| A/B在同批，收到200 partialSuccess rejected=1          | `(1,1,0,0,0;false)`，不返回哪条失败、不重试                    |
| A先结束，B未结束；调用flush后才结束B并加入C，A收到200 | 首次结果 `(1,0,0,0,0;false)`，不等待B/C；A不可与B/C合批        |

### 6.2 SDK资源与导出预算

SDK limits 为新增 tracing 专用配置，与 event transport 分开：queueCapacity=2048、queueBytes=8 MiB、batchSize=256、batchBytes=1 MiB、flushIntervalMs=1000、maxAttempts=5（含首次）、retryBudgetMs=30000、retryBaseMs=200、retryMaxMs=5000、requestTimeoutMs=5000、responseBytes=64 KiB。均允许显式覆盖并交叉校验；queueBytes 必须覆盖 batchBytes，batchSize≤接收端 max_spans，batchBytes≤接收端 body_bytes。

recording阶段另设增量预算：maxActiveSpans=1024、recordingBytes=8 MiB（每tracer汇总）、resourceBytes=64 KiB、maxSpanBytes=256 KiB、maxAttributes=128、maxEvents=128、maxLinks=128、maxValueDepth=8、maxValueNodes=4096、maxKeyBytes=128、maxValueBytes=4096、maxNameBytes=256。resource/scope初始化先校验并有界复制，超限初始化抛错；startSpan的初始attributes/links与每次setAttribute/addEvent都在复制前验证循环引用、深度/节点/数量/字节预算，拒绝新增超限内容并累加对应上游dropped counts及本地诊断，不等到end才检查。替换属性释放原占用后重新计费；一个超长string或array不能先整体复制/序列化再判断。

两个系统 resource 属性参与数量、节点和字节计费；maxAttributes 至少为 2，默认最多允许 126 个用户 resource 属性。double 的非有限数值在 SDK 快照复制时转为 NaN/Infinity/-Infinity 字符串，避免 JSON 编码为空值。

达到active或recordingBytes预算时新span返回保留合法传播context的nonrecording handle，计active_limit/recording_bytes，不改变父sampled决定、不抛业务错误。已存在span扩充超限时只丢此次内容；tracer只持有聚合计数，不持有无限handle列表。end时将recording配额转交队列预算，若队列满则丢弃并释放recording配额；重复end不能二次释放。close之后所有handle停止记录，end仍幂等释放自身引用；没有为未结束span安装自动结束计时器。

计入队列容量的数据包括in-flight与retry-wait；同时最多一个批次在飞。队列满时丢新span，给出累计诊断，不阻塞业务；未入队的丢弃不进入后续flush/close快照。超batchBytes的已入队单span不发送，按6.1计dropped。定时器unref，只有close取消后停止整个发送器；flush截止只结束该调用的等待。只在网络错误、429/502/503/504重试相同冻结批次，指数退避full jitter，并等待至少Retry-After（支持秒数和HTTP日期）；超过总预算则按6.1终止结算。200响应需通过编码和结构校验；格式错误作为unknown，在预算内重试；partialSuccess批次完成、不重试。

新 span 入队不延后已有自动发送截止；flush 可提前调度，实际发送仍遵守既有批次的重试就绪时间。

429 的实例冷却独立于批次保存；当前批次因尝试或总预算终止后，后续批次、新入队 span 和 flush/close 均不能提前发送或轮换端点。超长冷却使用有界分段定时器等待；close 截止仍取消定时器、清空队列并按快照结算。

## 7. 默认边界、保留与验收

Collector 新配置默认基线：body_bytes=4 MiB（压缩前后分别执行）、response_bytes=64 KiB、max_spans=512（首版配置范围1–512）、max_resource_spans=64、max_scope_spans=128、max_attributes=128/每个属性集合、max_events=128/span、max_links=128/span、max_value_depth=8、max_value_nodes=4096/span、max_span_bytes=256 KiB（包含该 span 的 resource/scope 分摊前内容）、max_attribute_key_bytes=128、max_value_bytes=4096。未知字段也受字节/深度预算保护。超全请求预算 413，超可定位的单 span 限制按永久拒绝；不静默截断 span/events/links。

limits.traces另包含第4节max_safe_span_bytes；limits.trace_queries.page_bytes独立控制查询，不能复用64 KiB采集响应预算。所有字节计量包含实际JSON转义和UTF-8多字节，不用JS字符串length代替。可信接收元数据和页信封各16 KiB硬预算在配置及编码路径核验，不能在查询阶段才发现一个正常接受的span永远放不进合法页。

所有限制均有配置定义和启动校验；沿用 limits.request_timeout_ms/body_timeout_ms/shutdown_timeout_ms/max_concurrent，不增加第二套 HTTP 超时变量。trace 增加 max_concurrent 子配额且≤全局，防止占满 event 槽位。trace 项目配额按输入 span 数扣费，包括无效与重复项，独立于 events；burst 必须≥max_spans，避免最大合法批次永远无法补满。配额是每实例保障，不宣称全局精确限流。

保留新增 retention.trace_days，建议 30 天，范围 1–3660；沿用 receipt_days 作为到期后额外去重窗口、audit_days 作为审计期。retain_until 由首次数据库接收时间加 trace_days 得到，与客户端 start time 无关；迟到 span 不因开始时间旧而被当成已到期。到期收据存续时拒绝复活；收据最终清除后不承诺识别曾用 ID。

下列为验收要求；实际执行入口、结果和环境边界见 [实施记录](../implementation/TRACES.md)：

| 编号 | 可观察结果与关键反例                                                                                                                                                          | 验证入口                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| T01  | JSON/Protobuf×identity/gzip 等价，合法空导出；用独立官方 codec 夹具验证请求与 Status/成功响应                                                                                 | protocol 单测、HTTP 契约                 |
| T02  | 字符串/Binary纳秒1793491200123456789、uint64边界、int64负边界无损；裸数值按binary64得到1793491200123456768，及uint64裸数值越界；摘要按解释后值等价                            | protocol 单测、真实 PG 往返              |
| T03  | 未知字段兼容；枚举名称拒绝、整数未知保留；null、oneof、重复键、AnyValue 全类型与嵌套边界                                                                                      | protocol 单测                            |
| T04  | 任一跨环境/未授权服务整请求零写入；browser key/write:server/读帐号不可写，trace ID 不能跨租户读                                                                               | HTTP、PG RLS 集成                        |
| T05  | 同批与跨实例同身份同载荷仅一行；异载荷不覆盖；同 ID 不同 service 也冲突，不能生成两个图节点                                                                                   | PG 并发集成                              |
| T06  | 1 好+1 坏返回200/rejected=1且好项已确认；全部坏、重复次数计数、投影警告；DB失败不能200                                                                                        | HTTP、PG 集成                            |
| T07  | COMMIT 后响应丢失原样重试；新同步屏障后确认、首次时间/投影/保留不变；同步取消 WARNING 不假成功                                                                                | system、TLS HA 集成                      |
| T08  | 父晚到/缺失、跨服务、跨 trace link、时钟偏差、未知枚举及环引用不阻断合法采集，不宣称完整                                                                                      | system 查询旅程                          |
| T09  | 到期不可见、墓碑拒绝复活、维护与读并发不提前删除活数据，缺分区 fail closed                                                                                                    | PG 维护集成                              |
| T10  | 名称、message、属性、scope/resource/link/tracestate均安全投影，允许vendor下的非白名单敏感值也从持久化和inject删除，原始敏感文本不进日志或响应                                 | security 单测、HTTP 集成                 |
| T11  | 两个并发请求和两个tracer的ALS不串链；嵌套/异常/重复end/close/定时器清理、采样及W3C向量；recording持续addEvent、循环对象、初始巨大links/resource、active数量与字节预算不可突破 | SDK 单测、真实 Node 进程                 |
| T12  | 429+Retry-After/503/网络未知有界重试，partial 不重试；body/响应/解压炸弹、深嵌套、连接取消资源有界                                                                            | HTTP socket、SDK 集成                    |
| T13  | 有限查询/排序/游标/权限变更/审计失败/局部授权/404；CLI NDJSON分页与中断不假成功                                                                                               | PG、CLI、system                          |
| T14  | event/error 可显式关联 span_id；旧 event ID 契约不收紧，现有所有 SDK/浏览器能力不退化                                                                                         | protocol/SDK 单测、现有 E2E              |
| T15  | 64个span各含32个允许的4096-byte字符串，可分批接收并经默认查询/CLI完整导出；每页按字节截断、末尾游标不跳项，短页仍继续；全部响应体≤page_bytes≤8 MiB                            | PG、真实HTTP→CLI                         |
| T16  | 6.1的六组数值算例逐项断言，覆盖重叠flush、快照后入队、partial=0警告、未知后永久失败、close清空与结果冻结                                                                      | SDK公开接口、受控时钟/网络、真实Node退出 |
| T17  | Binary golden与OTLP JSON golden具有独立来源；hex/base64、数字枚举/名称、camel/snake、重复键原文反例能区分错误实现；不能以生产codec互相同意代替人工预期                        | protocol单测、HTTP契约                   |
| T18  | 从发布产物导入tracing/server并执行闭环；browser/react/next-client图无Node tracing及OTel运行包；真实版本切换与回退不删除已确认span                                             | 构建产物、配置/PG、现有E2E               |

实施完成需通过仓库四项检查，覆盖率按当前配置的 statements≥75%、branches≥65%、functions≥75%、lines≥75% 分别报告；不可仅用 trace 局部覆盖率代替全配置范围门禁。trace 容量/HA 需另有真实负载与故障证据，参见架构验收。
