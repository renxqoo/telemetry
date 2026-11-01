# @oneaster/telemetry

浏览器、服务端与框架分别从 `@oneaster/telemetry/browser`、`/server`、`/react`、`/next/client`、`/next/server` 导入。通用入口不加载 React、Next、Node 或数据库运行时。

绝对 endpoints 只允许 HTTPS 或 loopback HTTP（127.0.0.1、localhost、[::1]）；浏览器还支持同源相对路径。相对端点在创建时按实际页面的 location.origin 固定为绝对地址，不受 document.baseURI 或后续 base 标签变化影响，并沿用页面协议；没有可用页面 origin 时须配置绝对端点。端点不得携带凭证、查询、片段、反斜杠或控制字符。

```ts
import { createBrowserClient } from '@oneaster/telemetry/browser';

const telemetry = createBrowserClient({
  endpoints: ['/_telemetry/v1/ingest/browser'],
  projectKey: 'pub_example',
  environment: 'production',
  service: 'web',
  release: '2026.11.01',
  buildId: 'web-example',
  events: {
    model_viewed: { model_id: { type: 'string', maxBytes: 128 } },
  },
  errorProperties: {
    operation: { type: 'string', enum: ['generate'] },
  },
});

telemetry.track('model_viewed', { model_id: 'model-example' });
telemetry.captureError(new Error('Private message'), { operation: 'generate' });
await telemetry.flush({ timeoutMs: 5000 });
await telemetry.close({ timeoutMs: 2000 });
```

`events` 是事件与属性的显式白名单；省略它时不接受普通事件。属性规则包含 `type`、`nullable`、`enum`、数字 `minimum`/`maximum` 和字符串 `maxBytes`。`__proto__` 为保留属性键。配置应与 Collector 项目策略一致，服务端仍独立校验。

`captureError` 不读取、复制或解析调用方的原始 message、stack 或 cause，错误的 frames 数组为空。错误类型取安全 name，仅 `errorCodes` 内的错误 code 可上传；`safeMessages` 将已注册 code 映射到静态安全文案。`operation` 仅映射到 `errorProperties` 中注册的 operation，其他上下文支持 requestId、traceId、spanId、userId、sessionId、route。

SDK 不从文本生成栈帧；Collector 的结构化 ErrorFrame 协议和 CLI 本地符号化能力独立保留。原始栈不属于 SDK 采集字段，省略它不设置 `truncated`；上下文发生裁剪时仍设置该标记。

服务端创建函数为 `createServerClient`，使用 `writeToken`，不接受 `projectKey`，不安装进程错误监听，不提供 setUser/reset。每次调用显式传入用户或请求上下文。浏览器 `setUser` 只接受不透明标识，帐号切换或退出调用 `reset`；已排队事件保留原用户与内存 session。

每次请求最多 20 事件、32 KiB，每事件最多 8 KiB。默认内存队列最多 200 事件/256 KiB，普通事件最多占 150 个位置，错误可淘汰未在途的普通事件。默认间隔 1 秒，错误立即调度；每实例同一时刻最多一个请求。`limits` 只允许在协议上界内调整队列、批次和重试预算。

默认不采样；`sampleRate.event` 和 `sampleRate.error` 可显式设置 0 到 1（含端点）。0 关闭对应类别的采集并计入 `sampled`，另一类别独立生效；只有保留事件才携带大于 0 的采样比例。每事件最多尝试 5 次，自首次发送起最多 60 秒，429 在实例范围遵守 Retry-After 与退避且保持当前端点；冷却同时约束已排队事件、新事件、flush 和 Beacon，仍受每事件重试总预算约束。其他未知结果轮换配置内端点，保留原 ID 与快照。

429 响应体为空、不是 JSON、不满足错误结构或在请求截止前未结束时，仍按已收到的响应头 Retry-After 等待并保留当前端点；未经完整校验的错误索引不用于丢弃事件。合法错误结构中的 retry_after_ms 与响应头取更长等待时间。超长冷却采用有界的分段定时器等待，不提前发送。

可选 `eventFilter` 在规范化、白名单检查和采样后、入队前同步执行。参数 `CaptureEvent` 从 browser/server/next 入口导出，包含深度冻结的安全事件，不包含原始 Error 或凭证。函数独立调用，不绑定 SDK 私有配置。返回 true 接受，false 丢弃并计 `filtered`；抛错或返回非布尔值（包括 Promise）拒绝事件并计 `filter_failure`，不向调用方抛错。Promise 不被等待，其拒绝会被处理。过滤器中的递归采集被拒绝；在过滤器内关闭客户端后不会继续入队。重试、Beacon 和已入队 Error 的重复采集不再执行过滤。

```ts
const telemetry = createBrowserClient({
  ...browserOptions,
  sampleRate: { event: 0, error: 1 },
  eventFilter: (event) => event.error?.type !== 'KnownNoiseError',
});
```

`browserOptions` 表示前例的项目、构建和白名单配置。过滤器仅决定接受或拒绝；在调用采集方法前准备允许发送的属性。浏览器同意状态由业务管理，可在获得同意后创建客户端，用 close 结束采集。

`projectId` 可配置预期 ACK 项目 UUID，采用与服务配置一致的 UUID 校验，支持 v4、v7 等版本；省略时首次完整有效 ACK 固定项目身份。ACK 还必须匹配环境、服务、来源、全部事件 ID、状态与毫秒 UTC 时间。`flush` 的 acknowledgedIds 只包含等待期间完整验证的确认，pendingIds 是未确认事件，droppedCount 是等待期间的丢弃数，timedOut 表示等待截止。页面隐藏时 Beacon 仅补发一个有界批次；其接受结果不会产生 ACK。`getDiagnostics()` 提供按原因丢弃计数、队列事件数/字节和状态。

`close` 先拒绝新采集并解除监听，然后在预算内排空，截止后取消请求、释放队列和定时器。返回的 pendingIds 记录关闭时仍未确认且已释放的事件。重复 close 返回同一关闭结果。

React 使用 `TelemetryErrorBoundary`，传入 client、children、fallback、可选 context/resetKey。边界捕获渲染失败并显示 fallback，resetKey 改变后尝试重建子树。

Next `instrumentation-client.ts` 同步调用 `initializeNextClient` 安装监听。服务端 instrumentation 使用 `createOnRequestError(client, { timeoutMs })`；它仅采集 routePath 模板，不读取原始请求 URL/headers，默认最多等待 2 秒。已有 register 启动校验应原样保留。业务主动转为失败结果的异常通过对应 Next 入口的 `captureHandledResult` 记录。AbortError、Next redirect 与 401/403/404 控制流被明确排除。

自动全局监听在同一页面仅注册一组；同项目、环境与服务范围由最近创建、未关闭且启用自动错误捕获的实例接收异常。离页补发交给最近创建且未关闭的实例，`captureGlobalErrors:false` 保留手工事件的页面生命周期补发；关闭后恢复此前实例。React 边界和全局监听观察同一个 Error 时，在默认 1 秒窗口内复用事件 ID；独立 Error 对象不会按文案合并。调度、重试预算、去重窗口及 flush/close 截止使用单调时钟，不受墙钟调整影响。

服务端链路追踪从独立 `@oneaster/telemetry/tracing/server` 入口导入，使用手工 span、异步上下文和显式 W3C 传播；详见 [tracing 接入](TRACING.md)。
