# 同类产品能力与验证对照

核对日期：2026-11-01。比较对象为 Sentry、PostHog 和 GlitchTip 的官方资料；产品能力不等于本项目应完整复制的范围。本项目保持无头、显式白名单采集、API/CLI 检索的定位。

## 采集与排障能力

| 能力               | 官方参考                                                                                                                                                                | 本项目实现证据                                                                 | 判断                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 采集前过滤         | [Sentry beforeSend](https://docs.sentry.io/platforms/javascript/configuration/options/#beforeSend)、[PostHog before_send](https://posthog.com/docs/libraries/js/config) | SDK 的规范化、白名单与队列位于 `packages/sdk/src/core.ts`、`normalize.ts`      | 同步 `eventFilter` 按安全事件决定是否采集                          |
| 分类采样和关闭采集 | [Sentry sampleRate](https://docs.sentry.io/platforms/javascript/configuration/options/#sampleRate)                                                                      | SDK 已有 event/error 独立比例和采样诊断                                        | 允许 0；保留事件的协议比例须大于 0                                 |
| 用户同意与撤回     | [PostHog opt_out_capturing_by_default](https://posthog.com/docs/libraries/js/config)                                                                                    | BrowserClient 只有 setUser/reset/close，没有运行时同意状态                     | 尚无内置同意管理；业务可在获得同意后创建客户端，用 close 结束采集  |
| 错误分组与问题处理 | [GlitchTip 错误跟踪](https://glitchtip.com/documentation)                                                                                                               | 接收端生成 fingerprint，查询/CLI 支持按 fingerprint 筛选                       | 有分组标识；尚无分组统计、首次/末次出现、已解决/忽略状态与回归判定 |
| 链路与性能         | [GlitchTip 性能监控](https://glitchtip.com/documentation)                                                                                                               | 独立 tracing/server SDK、`/v1/traces`、span 收据/载荷、Query API 与 traces CLI | 已具备服务端手工 span、OTLP 接收、跨异步上下文和 API/CLI 闭环      |
| 事件分析           | [PostHog 产品分析](https://posthog.com/docs/product-analytics)                                                                                                          | Query API 和 CLI 提供有界事件列表、详情与实时分页导出                          | 尚无时间桶聚合、漏斗、留存和去重用户指标                           |
| 告警               | [GlitchTip 告警与可用性监控](https://glitchtip.com)                                                                                                                     | `ops/production/alerts.yml` 是平台运行告警，`ops/probe.ts` 验证平台写读        | 尚无业务错误阈值、新错误/回归通知及持久化投递机制                  |

## SDK 采集控制契约

采集控制由 SDK 的公共类型、配置和采集/队列实现，不涉及 HTTP/DTO、持久化、服务端配置、数据库模式、异步任务或前端入口。

`eventFilter` 是可选同步函数，接收深度只读且已规范化的 `CaptureEvent`，返回 true 才允许入队，false 丢弃并计 `filtered`。执行在白名单校验和采样之后、队列准入之前；没有原始 Error、message、stack 或凭证；函数独立调用，不绑定 SDK 私有配置。抛错或返回非布尔值计 `filter_failure` 并拒绝该事件，不向业务抛错；Promise 不被等待，其拒绝会被处理。嵌套采集被拒绝，过滤期间关闭客户端后不再入队。过滤每次候选采集执行一次，重试和 Beacon 使用已经接受的相同快照，不再执行过滤。

过滤器仅用于接受/拒绝；业务应在调用 track/captureError 前准备允许的属性。它不能修改已冻结的事件，也不能绕过 SDK 和 Collector 的白名单。默认不配置过滤器，保留现有采集行为。

`sampleRate.event` 与 `sampleRate.error` 接受有限数字 [0, 1]，默认均为 1。0 对应类别不创建事件、不入队、不调用过滤器，计 `sampled`；另一类别不受影响。发送的 sample_rate 仍属于 (0, 1]，不改变 HTTP 协议或存储数据。

## 验证与后续优先级

公开 SDK 入口验证普通事件/错误过滤、规范化隐私边界、过滤抛错/异步误用、递归采集、关闭竞态、过滤拒绝不淘汰已排队事件、重试/Beacon 快照、分类 0 采样与配置边界，并验证普通函数的 this 不携带 SDK 私有配置。真实 HTTP → PostgreSQL → Query API 用例核对拒绝项不落库。同时加强 ACK 反例，确保合法结构中的重复 ID、范围错配和后续项目身份变化无法产生假确认。

TRACES 闭环与本地 T01–T18 功能证据见 [链路验收](implementation/TRACES.md)；后续错误聚合/问题状态和业务告警需要先定义查询预算、权限、状态持久化与可靠投递。用户同意管理需要明确撤回时队列、在途请求和身份清理语义。漏斗/留存需要独立统计契约，不能把当前实时分页当作一致性统计快照。

| 仍缺少的验证       | 现有证据与建议范围                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 链路协议与生命周期 | 已有独立 OTLP 夹具、并发异步上下文、传播/采样、partial success、重试和真实数据库往返；生产容量及跨故障域验证仍需完成 |
| 浏览器兼容矩阵     | Playwright 仅配置 Chromium；Firefox/WebKit 的全局异常、Promise 拒绝、页面隐藏和清理行为尚未验证                      |
| React 边界恢复     | 当前浏览器冒烟验证捕获与 fallback；resetKey 改变后恢复，以及 resetKey 不变时保持 fallback 的行为尚无用例             |
| 生产故障与恢复     | 本机三节点 TLS 测试不能覆盖真实可用区隔离、Patroni/fencing、备份还原、N-1 容量和长期 SLO                             |

采集控制本轮实施和完整检查证据见 [验证记录](implementation/PRODUCT-HARDENING.md)。

现有单测、PG 集成、三节点 TLS 故障验证和开发/生产浏览器冒烟均应保留。真实三区故障、N-1 容量、备份还原和长期 SLO 尚待生产环境验收，不能以本机测试替代；测试入口与边界见 [交付与验收](DELIVERY.md)。
