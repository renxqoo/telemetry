# 链路追踪闭环实施与验收

日期：2026-11-01。目标契约为 [TRACES-SPEC](../design/TRACES-SPEC.md)，机制为 [TRACES-ARCHITECTURE](../design/TRACES-ARCHITECTURE.md)。本记录保存实施与检查证据，不代表生产部署或跨可用区容量认证。

## 已实施范围

- 独立 Span/AnyValue/Resource/Scope/Event/Link/Status 模型，OTLP JSON 与 Binary Protobuf、identity/gzip、数值精度、严格 JSON 与有界 wire 校验。官方 proto、固定来源 commit、SHA256 和许可证保存在 `packages/protocol/proto`，protobufjs 8.8.1 从校验后的来源生成 descriptor。没有引入 OTel SDK/API/exporter。
- 配置 schema 2，显式 write:traces/read:traces，分层安全属性规则、静态名称/消息/版本/schemaURL 白名单、精确 tracestate 值规则、独立配额、采集/查询预算和 trace 保留期。离线转换保留事件策略与原帐号权限，不在线双收 schema 1/2。
- 独立 span 收据、分区 trace_spans 和 trace_query_audit，身份不包含 service。纳秒 start/end/duration 为受约束的 numeric(20,0)，kind/status 为 int32，flags 为 uint32 范围 bigint。有序批量写入、受限 SECURITY DEFINER nonce 确认、幂等/冲突/墓碑、读写 RLS、同步提交与查询审计，复用现有连接、超时和 unknown 保护。连续前缀分页先窄投影后有界批量取正文，审计提交前复核载荷字节、可信元数据和身份。
- 自研 tracing/server SDK：密码学 ID、每实例 ALS、W3C 显式传播、确定性采样、单调时间、受限 recording/队列、同批重试、partial success、flush 快照互斥计数、close 清理。event/error 通过显式 traceId/spanId 关联，旧 trace_id 文本保持兼容。
- Collector `/v1/traces`，Query `/v1/spans` 与 `/v1/traces/:trace_id`，CLI traces list/get、单页 JSON 和沿游标 NDJSON、独占文件输出、背压等待和不完整导出非零退出。无产品 UI 或自动插桩。

## 验证映射

| 验收编号        | 实际入口与证据                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01/T02/T03/T17 | protocol trace 单测、独立 `golden`/`values` JSON 与 protoc/Python 产出的 binary，手工期望验证 123456789ns、uint64/int64、全部 AnyValue、flags、非法枚举/oneof/JSON/varint/UTF8 和 base64 规范化 |
| T04/T05/T06/T08 | 真实 HTTP/PG system 用例：全资源鉴权、独立权限、并发重放、同批冲突全部拒绝、好坏混批、两服务父子和显式关联、授权片段与 unknown 完整性                                                           |
| T07             | lost durable response 真实重试；三节点 TLS 探针覆盖 trace 新写、重复、隐藏服务冲突及查询审计在同步复制阻断时返回 unknown，并保持连接数量有界                                                    |
| T09/T10         | 真实保留/维护与缺失状态、原始敏感值摘要冲突、投影删除；tracestate 精确值规则、只读配置、消息/属性/名称安全和无敏感指标标签                                                                      |
| T11/T12         | SDK ALS 并发、两实例、原异常重抛、采样阈值两侧/等号、父采样继承、单调时钟、录制预算、递归值、幂等 end；gzip 膨胀、并发槽持有、响应/重试/关闭反例                                                |
| T13/T15         | 审计失败不返回数据、游标过滤/权限绑定、派生字节损坏在审计前拒绝；64 个各带 32×4096-byte 属性的 span 经真实 HTTP→PG→CLI 跨短页无漏重输出                                                         |
| T14             | paired span_id 约束与大小写规范化、旧 trace_id 不收紧；真实 SDK→事件 API 关联；现有双模式浏览器测试回归                                                                                         |
| T16             | 快照一次统计、未知后成功、flush 超时后结果冻结、close 在途/未发送分类、partial 与 partial=0、重叠 flush、后来入队不跨边界合批                                                                   |
| T18             | 构建包 tracing/server 参与真实闭环，独立 Node 进程 flush/close 后自然退出；浏览器图禁止 tracing/Node 服务端/OTel 依赖；真实数据库兼容窗口与收口不删除已确认数据                                 |

Golden JSON 是按规格人工编写的原始文本；Binary 从固定官方 proto 和独立 grpcio-tools 1.78.0/Python text_format 生成。二者分别核对独立字段期望，未调用生产 encoder 生成 JSON oracle。来源、SHA256 和生成说明见 `tests/support/trace`。本机 Homebrew protoc 因 abseil 动态库缺失不可执行，因此使用隔离在 /tmp 的 Python 工具生成夹具，未加入运行时依赖。

独立只读审查发现并修正了 recording 预复制预算、有限大 double 摘要、base64 规范化、畸形 200 假确认、Binary 溢出、查询载荷长度复核、解压任务准入持有和环境长度边界。畸形 200 回归取得修复前 3 项失败证据，修复后通过；其他问题有审查者公开入口复现或对应行为用例。批量 SQL 与修正再次独立复核，无剩余阻断发现。

## 本地迁移与回退流程

配置、存储契约和数据库 schema 均使用 2；event HTTP schema_version 仍是 1。变更不把历史事件转换成 span，也不删除其数据。

1. `bun run config:convert input-v1.json output-v2.json` 独占创建 0600 输出，保存原配置。新旧实例使用独立配置路径。
2. 发布窗口内 `bun run db:migrate --prepare` 保留既有版本 1 记录并建立 2，新增 trace 对象；新实例只接受配置 2、readiness 只认可数据库 2。
3. 切入口后核对配置 revision/digest、event 成功率、trace 实际写读、旧实例活动请求为零。旧实例排空后，同一窗口执行 `bun run db:finalize`，仅保留版本 2 并收紧 CHECK。默认 `db:migrate` 直接收口，适合独立开发环境。
4. 必须回退旧事件入口时，先暂停 trace 写入口，`bun run db:migrate --event-rollback` 有界恢复版本 1 记录，保留 2 和全部 span 数据。trace 查询及维护仍由新版程序承担，前向修复后再 finalize；不运行旧 migrate、不删除 trace 表、不用旧备份覆盖已确认数据。

兼容窗口采用现有方案的一次发布排空窗口，目标不超过 30 分钟；观测不达标回退入口并取消开通 trace，不无限延长双配置。生产执行仍需独立部署授权，本轮只在临时 PostgreSQL 做迁移与回归。

## 检查结果

最终四项检查全部通过：

| 命令                | 实际结果                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| `bun run lint`      | 架构检查、类型感知 lint 和格式检查通过，零错误与警告                           |
| `bun run typecheck` | 通过                                                                           |
| `bun run build`     | 协议来源校验/descriptor、SDK/服务/CLI/声明文件、Next 生产构建通过              |
| `bun run test`      | 25 个 Vitest 文件，315 项全部通过；开发/生产 Chromium 冒烟各 2 项，共 4 项通过 |

本轮新增 87 项 Vitest 用例，另扩展既有三节点 TLS 探针中的 trace 同步确认与连接清理断言。最终集成覆盖率按 vitest.integration.config.ts 继承的 packages 源文件匹配范围报告，不等于全仓任意文件覆盖率：

| 指标       | 实际值              | 配置门禁 | 结果 |
| ---------- | ------------------- | -------- | ---- |
| statements | 85.83%（3261/3799） | 75%      | 通过 |
| branches   | 82.56%（2685/3252） | 65%      | 通过 |
| functions  | 88%（477/542）      | 75%      | 通过 |
| lines      | 89.62%（2979/3324） | 75%      | 通过 |

定向 Vitest 用例用于开发定位。选择单文件的 integration 命令保留全局覆盖率门禁，其所选行为用例通过后仍可能因未覆盖其他模块而退出 1；最终使用完整 test 命令验证全部适用路径。没有修改覆盖率范围、阈值或 skip。未再次单独运行 test:unit 的全局覆盖率门禁；其原有范围问题见此前 PRODUCT-HARDENING 记录。

尚未执行候选 500 spans/s×10 分钟容量压测、真实三区 Patroni/fencing、备份还原、生产回退演练及长期 SLO。这些环境验收不能由本机 TLS 与功能测试代替，也没有进行部署或发布。

工作区开始时全部项目文件未跟踪、无初始提交、无 remote；保留前轮修改及现有工程，交付只含本轮差异的补丁，不提交整份既有工作区。
