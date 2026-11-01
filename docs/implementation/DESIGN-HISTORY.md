# 初始设计评审历史

本文件仅归档实施前的设计检查与探针，不代表当前功能或验收状态。当前状态见 [验收记录](ACCEPTANCE.md)。

## 初始设计评审证据

已读取目标项目状态和全部现有设计；该项目没有运行时源代码、package.json、测试配置、CI 或迁移。没有其他 AGENTS 对此目录增加约束。OneAster Client 仅作只读接入依据，其未提交改动不属于本项目交付。

已核对官方 PostgreSQL、Patroni、Fastify、Node、Zod、ClickHouse、SQLite 与 Beacon 资料，以及 OneAster Client 当前安装版本的 Next.js 文档。实际本机版本只读检查为 Node v26.9.0、Bun 1.4.4；先前 SQLite 内存探针为 3.51.0。这些结果不能替代目标镜像兼容性、生产补丁或容量验证。

先前独立只读审查曾核对权限传播、严格协议字段和数据库后端清理；后续设计评审另发现 COMMIT 超时前提、WARNING 过滤、过期收据类别授权和详情快照四处缺口。本次已修正文档机制，并扩展 M1、C06、C10、C15、C18、C19，增加 C29/C30；这些是设计修正及待执行验收，不能据此宣称目标实现已经通过。

设计评审在本机 PostgreSQL 17.9 的临时隔离实例中验证了两个反例：statement_timeout=150ms 后超过 1 秒仍处于 active/SyncRep；主动取消同步等待后，两种消息级别均返回 COMMIT，但 client_min_messages=warning 有 WARNING，ERROR 无 WARNING，记录仅在本地提交。临时实例与目录已清理。PostgreSQL 18 对应源码支持上述判断，但本机结果不能替代 PostgreSQL 18/pg 目标版本及真实 HA 拓扑验收。

本次文档修正另外在 PostgreSQL 17.9 临时单机实例的最小 SQL 模型中核对：事件与收据 kind 不一致被外键以 SQLSTATE 23503 拒绝；仅剩过期收据时，error-only RLS 仍隐藏普通事件；同一 REPEATABLE READ 快照在到期 DELETE 后仍可读取原事件，而后续读取看到到期收据与空事件结果；reader 的父表 ACCESS SHARE 锁使 DROP 和普通 DETACH 在 100ms 锁等待上限后以 55P03 退出。临时实例与目录已清理。这些是 SQL 机制探针，未验证完整应用角色、HTTP 分类、驱动取消、目标 PostgreSQL 18 或生产拓扑。

本次机械核对通过：6 份 Markdown、21 处本地链接及锚点、4 个 JSON 样例，代码围栏与空白检查通过；四项机制的跨文档规则和 30 个计划契约场景已核对。机械检查与隔离探针不计为项目运行测试或覆盖率；尚无源代码、依赖、lint/typecheck/build/单元/集成/E2E/负载/高可用演练结果。独立提交截止、目标版本协议通知、完整权限、快照与分区锁、真实 fencing、N-1 恢复时间和容量仍须按 M1/M3/M8 实测，设计修正不能证明 99.99% 或 RPO=0。

未决输入为真实事件量与分布、查询并发、保留期、三区主机与网络条件、现有入口和秘密分发能力、备份目标。这些不阻止形成完整设计，但在形成生产容量和验收结论前必须落实；当前使用运行方案中明确标注的验证基线。

## 初始依赖选型核对

2026-11-01 对 npm 官方 latest 元数据的只读核对如下，是实施选型起点，不是已安装清单：

| 包         | 核对版本 | 声明许可证 |
| ---------- | -------- | ---------- |
| Fastify    | 5.12.7   | MIT        |
| pg         | 8.23.1   | MIT        |
| Zod        | 4.6.7    | MIT        |
| TypeScript | 7.0.2    | Apache-2.0 |
| Vitest     | 5.0.5    | MIT        |
| oxlint     | 1.90.0   | MIT        |
| oxfmt      | 0.75.0   | MIT        |

元数据来源示例：[Fastify registry](https://registry.npmjs.org/fastify/latest)、[pg registry](https://registry.npmjs.org/pg/latest)、[Zod registry](https://registry.npmjs.org/zod/latest)。运行时、基础设施和镜像还需在实施制品中记录完整版本、许可证和摘要；软件开源不免除计算、存储和运维成本。

Node 官方 2026-10-28 的发布记录将 26.13.0 列为 LTS，支持采用 26 LTS 主版本，不表示本机已安装同一补丁。[Node 官方发布](https://nodejs.org/en/blog) Zod Mini 提供可裁剪 API，实际 SDK 体积需构建测量。[Zod Mini](https://zod.dev/packages/mini)

## 初始 SQLite 探针

本机只读探针的结果为 Bun 1.4.4、SQLite 3.51.0。这不是目标生产版本，也不代表完成了兼容性或容量验证。若启用 SQLite WAL，需要核对实际引擎的修复版本；SQLite 官方记录了相关 WAL-reset 修复，不能仅依据 Bun 版本推断引擎补丁状态。[SQLite 版本说明](https://www.sqlite.org/wal.html#walresetbug)
