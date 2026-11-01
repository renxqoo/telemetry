# OneAster Telemetry

独立、无头的数据埋点与错误采集平台，通过 SDK 接入业务代码，集中保存数据，通过 API 和 CLI 检索。

仓库包含 Browser/Server/React/Next SDK、Collector、Query API、PostgreSQL 驱动、CLI、迁移维护工具及生产部署工件。生产可用性目标为 99.99%，单节点或单可用区故障下已确认数据不丢；真实三区部署、容量、fencing、备份还原与长期 SLO 尚未完成生产验收。实际证据见 [验收记录](docs/implementation/ACCEPTANCE.md)。

## 当前能力

- 手工埋点、显式错误上报、浏览器全局异常与 Promise 拒绝、React 错误边界、Next 服务端错误钩子。
- 有界 SDK 队列、批量发送、分类采样与采集前过滤、相同事件身份重试、ACK 校验、身份切换和关闭清理。
- 项目、环境、服务和类别隔离，浏览器 Origin 约束，独立服务端读写凭证，配置热更新和到期拒绝。
- PostgreSQL 幂等收据、同步提交确认、错误指纹、审计查询、签名游标、保留期与分区维护。
- CLI 列表、详情、NDJSON 导出、doctor 和本地 source map 还原；显式多端点有界切换。
- 服务端手工 span、异步上下文和 W3C 传播；OTLP JSON/Protobuf/gzip 采集、幂等存储、受审计 API 与 CLI 链路检索。
- Collector 与 Query API 独立运行，无产品管理 UI，不接入其他业务仓库。

首期存储为 PostgreSQL 18。SQLite 与 ClickHouse 尚无驱动；生产 HA 需要真实独立故障域、严格同步复制和可靠旧主隔离，不能由单机 profile 替代。

## 开发与验证

使用 Node.js 26、Bun 1.4.4 和 PostgreSQL 18。依赖版本见 package.json 与 bun.lock，容器镜像见 Dockerfile。

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build
bun run test
```

测试会创建并清理临时数据库；PostgreSQL 18 不在默认路径时设置 `TELEMETRY_PG_BIN`。浏览器测试需要已安装 Playwright Chromium。`bun run test:integration` 包含真实数据库及三节点 TLS 回归，`bun run test:e2e` 验证开发与生产模式的 Next 接入。

服务通过 `bun run collector` 与 `bun run query` 启动，配置、秘密、数据库角色及迁移步骤见 [运行指南](docs/implementation/RUNNING.md)。构建后的 CLI 入口为 `node dist/packages/cli/src/main.js`；完整参数见 [CLI 文档](packages/cli/README.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [链路追踪 SDK](packages/sdk/TRACING.md) | 服务端 span、传播、采样与生命周期 |
| [链路验收](docs/implementation/TRACES.md) | 协议、闭环、迁移与验证证据 |
| [SDK 接入](packages/sdk/README.md) | 导出入口、事件白名单、采集与生命周期 |
| [HTTP 服务配置](packages/application/README.md) | 配置、鉴权、查询、指标与独立服务入口 |
| [PostgreSQL 驱动](packages/storage-postgres/README.md) | 持久化、连接预算、维护与 HA 前提 |
| [系统架构](docs/ARCHITECTURE.md) | 模块职责、依赖边界、数据库选择 |
| [SDK 与 API 契约](docs/SDK-AND-API.md) | 事件模型、权限、重试、分页和 CLI |
| [服务端与存储](docs/BACKEND.md) | 幂等事务、确认、审计、保留与恢复 |
| [生产运行](docs/OPERATIONS.md) | 拓扑、SLO、容量、备份和发布要求 |
| [交付与验收](docs/DELIVERY.md) | 功能矩阵、验证入口与未完成验收 |
| [审查修复记录](docs/implementation/REPAIR.md) | 本轮范围、回归与检查证据 |
| [同类产品对照](docs/PRODUCT-COMPARISON.md) | 官方参考、实现证据、能力与验证缺口 |

软件采用免费开源基础设施并自行托管；跨故障域计算、存储、网络、备份和维护仍需要实际资源。
