# 初始交付验收记录

本文件归档首次交付的检查、负载和场景证据。本轮修复的最终检查与容量复测见 [审查修复记录](REPAIR.md)。

状态：运行时代码与工程门禁已交付，生产验收未通过。不能据此发布“高性能、高可用已达标”结论。用户已确认采用仓库负载基线，尚无真实三区环境访问方式。

需求在 [可验证需求 Space](https://chatgpt.com/space/page_6ae698b7631481918b634bf7420821cf)。本次实现协议、Browser/Server/React/Next SDK、Collector、Query API、PostgreSQL 驱动、CLI、配置与运维工件；没有接入其他业务仓库或部署生产服务。

## 工程检查

2026-11-01 最终集成版本按顺序执行四项，全部退出 0：

| 检查                | 实际结果                                                       |
| ------------------- | -------------------------------------------------------------- |
| `bun run lint`      | 架构边界、类型感知 oxlint、格式均通过；lint 错误和警告均为零   |
| `bun run typecheck` | 全部 TypeScript 通过                                           |
| `bun run build`     | Node/CLI/SDK 工件、类型声明和 Next.js 生产构建通过             |
| `bun run test`      | Vitest 13 文件、170 用例通过；Playwright 开发与生产 4 用例通过 |

覆盖率作用域为 `vitest.config.ts` 的 `packages/**/src`，排除类型和测试文件；不包括 apps、ops、scripts，也不包含浏览器或子进程的 V8 执行覆盖。不能称全仓覆盖率。

| 指标       | 实际覆盖率 | 命中/总数 | 门禁      |
| ---------- | ---------- | --------- | --------- |
| statements | 85.67%     | 1926/2248 | 75%，通过 |
| branches   | 81.89%     | 1488/1817 | 65%，通过 |
| functions  | 86.78%     | 289/333   | 75%，通过 |
| lines      | 88.93%     | 1769/1989 | 75%，通过 |

独立补充验证：三台本机 TLS PostgreSQL 18 节点探针 5/5 通过；Docker Linux Node 26.13 下 CLI 安全 source map 读取与 SDK close 通过；promtool 3.15.1 校验 8 条告警规则通过；探针失败时原子发布失败指标并保留非零退出已验证。部署路由的 3 个回归用例包含在 170 用例中，防止三区入口串区和重复域名冲突。CI 工件已提供，但没有远端运行记录。

## 容量结果

门禁保持零失败、确认数与数据库唯一计数一致、成功写入 p99≤1000ms、成功查询 p99≤2000ms，没有扩大超时、排除失败或改成异步确认。

最后一次 Linux 实测使用 Node 26.13.0、PostgreSQL 18.6、单故障域 development profile。整个应用、负载生成器与数据库共用 2 vCPU、约 4 GiB VM，使用独立 Linux 数据卷；低于设计包提出的单个 PostgreSQL 节点 4 vCPU/16 GiB 起点。因此这是本地开发环境结果，不是目标硬件或三区容量结论。

| 测量                 | 实际值                                    |
| -------------------- | ----------------------------------------- |
| 时长                 | 600.429 秒                                |
| 计划事件             | 300,000，500 事件/秒                      |
| 事件分布与载荷       | 95% event / 5% error，平均 1001.85 字节   |
| 已确认/落库/唯一     | 299,960 / 299,960 / 299,960               |
| 写入失败             | 2 批，共 40 事件，503 storage_unavailable |
| 查询                 | 6,000 次计划，5,999 次成功、1 次 503      |
| 成功写入 p50/p95/p99 | 9.25 / 16.25 / 43.90 ms                   |
| 成功查询 p50/p95/p99 | 5.21 / 10.84 / 20.44 ms                   |
| 进程最大 RSS         | 175.14 MiB                                |
| 结论                 | 未通过；入口退出 1                        |

[完整 Linux 结果](evidence/load-linux.json) 与 [原生 macOS 结果](evidence/load-native-macos.json) 均保留。macOS 同样未通过：300,000 计划事件、299,820 已确认/落库/唯一，9 批写入失败；成功写入/查询 p99 为 91.94/16.26ms。计数一致只能作为本次计数核对结果，不能代替跨故障域逐 ID 的 RPO 验收。

[Linux 时钟故障诊断结果](evidence/load-linux-clock-fault.json) 也保留：内部 NTP 与宿主同步冲突，Node 直接观测到单调时钟前进约 100ms 时墙钟变化 +1841/−1640/+2000ms，NTP 状态报告约 −1小时13分钟偏移。仅在本任务临时 VM 内停止冲突 NTP 后，35 秒与 20 秒观测窗口最大墙钟/单调时钟差异均小于 1ms，再执行上表完整复测。复测仍有超时，不能把全部失败归为时钟问题。

独立 agent 以实际 collector 角色、RLS 和 20-ID 批次测量完整性 SQL，计划为索引读取，0.369/0.522ms；独立统计矩阵没有复现退化。现场采样看到 COMMIT 的 WALWrite/WalSync 等待，但当时时钟异常污染墙钟耗时，不能把 2.68 秒直接当作真实单调耗时，也不能据此声称已定位最后 3 次请求失败的全部根因。下一步需在目标规格、稳定时钟和独立持久盘上复核并捕获连接准入、数据与提交阶段的单调耗时，保持现有安全预算。

## C01–C30 证据边界

“本地对应行为通过”只描述已列出的证据。原始完整场景要求更高保真度时，明确保留未执行部分。

| 场景               | 状态                 | 已有证据与边界                                                                                          | 入口                                                                                                                                           |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C01–C03            | 局部通过             | 真实 PostgreSQL 多 writer 并发、HTTP 并发重放与批次回滚；双独立 Collector 进程场景未单独执行            | `tests/system/pipeline.test.ts`；`packages/storage-postgres/src/__test__/postgres.integration.test.ts`                                         |
| C04                | 局部通过             | 持久化后模拟丢失响应并重试，原 ID、接收时间和保留期不变；TCP 故障代理场景未单独执行                     | `tests/system/pipeline.test.ts`                                                                                                                |
| C05、C06、C09、C29 | 本地复制探针通过     | 三台本机 TLS PG18 节点验证同步等待、独立截止、取消 WARNING、unknown 不反转；真实 Patroni/跨区故障未执行 | `packages/storage-postgres/probes/tls-cluster.ts`；`tests/system/synchronous-confirmation.test.ts`                                             |
| C07、C08           | 未执行               | 真实可用区永久失效、旧主 fencing、RPO/RTO、N-1 峰值负载需要三独立故障域                                 | `scripts/ha.ts`；`ops/render.ts`                                                                                                               |
| C10–C12            | 本地对应行为通过     | RLS、服务/类别与过期收据授权、凭证撤销、签名游标及读写凭证隔离                                          | `packages/application/src/__test__/http.test.ts`；`packages/storage-postgres/src/__test__/postgres.integration.test.ts`                        |
| C13                | 局部通过             | 配置完整性、修订回退、过期与热重载已测；多进程发布故障未执行                                            | `packages/application/src/__test__/runtime.test.ts`；`packages/application/src/__test__/http.test.ts`                                          |
| C14                | 局部通过             | 同连接读取/审计和审计失败关闭已测；两阶段之间真实主库切换未执行                                         | `packages/storage-postgres/src/__test__/postgres.integration.test.ts`                                                                          |
| C15、C18、C19      | 本地对应行为通过     | 固定快照/as_of、分页、立即到期隐藏、父表锁和分区维护冲突                                                | `packages/storage-postgres/src/__test__/postgres.integration.test.ts`                                                                          |
| C16                | 局部通过，容量未通过 | 连接/SQL/锁等待、请求中止和异步资源有界已测；10 分钟负载仍有超时                                        | `packages/storage-postgres/src/__test__/retry-admission.integration.test.ts`；`packages/application/src/__test__/timeouts.integration.test.ts` |
| C17、C20、C21、C22 | 局部通过             | 队列/字节、坏输入与 getter、重试 ACK、冷却期、close/reset/HMR、用户上下文；未单独执行所有浏览器离线场景 | `packages/sdk/src/__test__/sdk.test.ts`；`e2e/telemetry.spec.ts`                                                                               |
| C23、C24           | 局部通过             | Browser 全局错误/Promise 与 Next hook 真浏览器持久化、安全投影；未逐一执行每种 React/Next 控制流场景    | `e2e/telemetry.spec.ts`；`packages/sdk/src/__test__/sdk.test.ts`；`packages/application/src/__test__/http.test.ts`                             |
| C25                | 本地对应行为通过     | 构建绑定、行列算例、目录逃逸及叶文件/manifest/目录替换；Linux Node 容器安全读取实测                     | `packages/cli/src/__test__/cli.test.ts`                                                                                                        |
| C26                | 本地对应行为通过     | 存储能力不满足 HA 时拒绝；HA 要求验证 TLS、物理端点与受限 LOGIN                                         | `packages/storage-postgres/src/__test__/options.test.ts`；`packages/storage-postgres/probes/tls-cluster.ts`                                    |
| C27                | 工件完成，部署未执行 | 单轨 v1、独立迁移/维护工件、三区稳定 slot 和逐区发布说明；实际滚动与回退未演练                          | `ops/render.ts`；`docs/implementation/RUNNING.md`                                                                                              |
| C28                | 工件完成，还原未执行 | pgBackRest/WAL/加密备份和恢复步骤已提供；没有异故障域目标与实际还原结果                                 | ops/production；`docs/implementation/RUNNING.md`                                                                                               |
| C30                | 局部通过             | 真实库未决后端、精确世代、重启盘点、维护前驱及直连节点预算；持续网络隔离的跨区演练未执行                | `packages/storage-postgres/src/__test__/postgres.integration.test.ts`；`packages/storage-postgres/probes/tls-cluster.ts`                       |

## 并行集成与交付边界

SDK、存储、服务与 CLI 使用独立 managed git worktree；独立审查后由主 agent 逐文件集成。后续修复和性能分析也使用独立工作树或只读探针。原始未提交的 AGENTS.md、README.md 和五份设计输入保持原样，不纳入本次提交。

初始仓库没有 HEAD 或远端。由于容量门禁未通过且生产验收证据尚缺，主 agent 不批准最终交付，不执行自动提交/push；代码与报告保留供继续验收。没有执行部署、生产故障、对外通知或发布。

完成生产验收仍需要目标规格下的零失败基线和 N-1 负载、三个独立故障域的故障/fencing/RPO/RTO、真实备份还原与滚动回退，以及采集/查询分别滚动 30 天的 99.99% 证据。需要真实环境与秘密分发后才能执行，单机探针或通过工程检查不能替代。
