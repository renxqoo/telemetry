# 服务端链路追踪 SDK

从 `@oneaster/telemetry/tracing/server` 导入 `createTracer`、`extractTraceContext` 和 `injectTraceContext`。该入口使用 Node.js AsyncLocalStorage 和密码学随机 ID，不自动改写 fetch、HTTP 或数据库，不依赖 OpenTelemetry SDK/API/exporter。

```ts
import {
  createTracer,
  extractTraceContext,
  injectTraceContext,
} from '@oneaster/telemetry/tracing/server';

const tracer = createTracer({
  endpoints: ['https://telemetry.example.com'],
  environment: 'production',
  service: 'web',
  writeToken,
  sampleRate: 1,
});

const parent = extractTraceContext(request.headers);
const result = await tracer.withSpan({ name: 'checkout.create', kind: 2, parent }, async (span) => {
  const headers = injectTraceContext(span.context);
  return fetch(trustedInternalUrl, { headers });
});
await tracer.flush({ timeoutMs: 5000 });
await tracer.close({ timeoutMs: 5000 });
```

endpoints 是根地址，服务端发送到 `/v1/traces`；使用 HTTPS，HTTP 仅允许 loopback。`writeToken` 需要 `write:traces` 权限。Collector 必须注册环境、服务和安全 trace_policy；未知名称会替换为 span/event，未知属性删除。配置 `resourceAttributes`、`scope` 及 `traceStateRules` 可提供资源、仪器库和精确安全 tracestate 值；保留的属性仍由 Collector 独立校验。

`startSpan({name,kind?,parent?,attributes?,links?})` 创建非激活的 handle。`withSpan` 在本实例异步上下文中激活，自动结束；异常设置 ERROR、原样抛出，不上传异常 message 或 stack。parent 省略时继承当前上下文，null 强制新 trace。`currentContext()` 只返回本实例当前不可变上下文。根按 trace ID 低 64 位确定性采样，sampleRate 为 [0,1]；合法父上下文继承 sampled 位。未采样 handle 仍可传播上下文。

handle 提供 context、setAttribute、addEvent、setStatus、end。时间使用 Unix 锚点加单调时钟差，纳秒用字符串输出。end 幂等，之后修改不影响导出内容。属性使用类型化 `{type:'string',value:'safe'}`、bool、int（十进制字符串）、double、bytes（base64）、array、kvlist 或 empty，属性集合是 `{key,value}[]`。double 的数值 NaN、Infinity、-Infinity 在快照中转成对应字符串；同名字符串和有限数值均可直接使用。resource 的 service.name/deployment.environment.name 由 SDK 添加，业务不得覆盖。event/error 关联使用现有 SDK 显式传入 `{traceId,spanId}`，不隐式读取 tracer。

extract/inject 支持 W3C traceparent，注入格式为 00，仅传播 sampled 位；非法 trace/span ID 丢弃。tracestate 语法非法时单独删除，合法 parent/link 的 ID 和 sampled 位继续生效。tracestate 默认全部删除，只有 traceStateRules 中 vendor、safe_values 和 max_value_bytes 同时匹配才保留。不转发 Authorization、Cookie 或 baggage，目标由业务显式决定。

`limits` 默认队列 2048 span/8 MiB、批次 256 span/1 MiB、间隔 1 秒、最多 5 次尝试/30 秒预算、请求 5 秒、响应 64 KiB。recording 默认最多 1024 活动 span/8 MiB、单 span 256 KiB、resource/scope 64 KiB；属性/事件/link 数量、值字节、深度、节点均有上限，复制前增量计费。超限只拒绝新增内容并计诊断，不阻塞业务。end 释放 recording 配额；关闭后的存量 handle 在 end 时释放自身引用。队列包含在途和退避项。

持续入队不会延后已安排的自动发送截止，flush 可提前调度，但发送仍受 Retry-After 约束。429 冷却独立于当前批次；当前批次因预算或尝试次数终止后，后续批次、新 span 和 flush/close 仍遵守实例冷却并保持当前端点。超长冷却通过有界分段定时器等待，close 截止仍可取消并清空队列。resource 的属性数量、节点和字节预算包含两个系统属性；默认最多配置 126 个用户 resource 属性，maxAttributes 至少为 2。初始化预算超限立即抛错。

flush/close 的 timeoutMs 默认 5000，必须为 1–30000 的整数。flush 只观察调用时已结束且仍待处理的快照；不会包含后来结束的 span，不延长既有重试预算，也不绕过 Retry-After。返回不可变 `{confirmedSpans,rejectedSpans,unconfirmedSpans,pendingSpans,droppedSpans,timedOut}`，五类数量互斥并等于快照总数。partial success 只提供批次拒绝数量，不猜测具体失败 ID。网络未知后收到永久失败仍计 unconfirmed；有效 200（包括 partial）才能解决未知结果。

flush 超时停止该调用的等待，后台继续有界重试，旧结果不再变化。close 立即停止新记录，排空到首次截止后取消网络/定时器并清空队列，重复 close 共享首次结果；不替业务强制结束未结束 span，也不等待业务 withSpan 回调。已进入的回调保留上下文，最后一个回调完成后释放 AsyncLocalStorage。关闭后 withSpan 仍执行回调并提供局部上下文，handle 不记录，回调结束后同样清理。getDiagnostics 返回累计处置计数及当前 recording/队列资源，累计数不代替单次快照结果。

仓库中的 `docs/design/TRACES-SPEC.md` 定义 HTTP、查询、CLI 和字段规则；`docs/implementation/TRACES.md` 保存实施验收证据。
