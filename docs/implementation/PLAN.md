# 首期实施与验收

Space: https://chatgpt.com/space/page_6ae698b7631481918b634bf7420821cf

用户授权实现设计包的所有首期能力，采用仓库容量与保留基线。首期 PostgreSQL，后续 SQLite/ClickHouse 不进入当前实现。无外部业务仓库接入或生产部署授权。

影响面：公共协议及 SDK 导出、HTTP/DTO、PostgreSQL 持久化与迁移、版本配置、保留维护任务、独立 Node 入口、Next 浏览器验收入口及测试。系统没有管理 UI。

T01 主 agent：工具脚本、协议 types 与 storage-contract，定义共享边界。
T02 独立 agent：packages/protocol 和 packages/sdk，协议与采集/生命周期行为。
T03 独立 agent：packages/storage-postgres，真实迁移、幂等、审计、RLS、保留与确认保护。
T04 独立 agent：packages/application、packages/cli、apps/collector、apps/query-api，权限、配置、HTTP、游标及 CLI。
T05 主 agent：scripts、ops、tests/system、e2e、apps/smoke，集成验证及运维装置。
T06 主 agent：最终门禁与需求核对，新增只读 agent 独立审查。

T02/T03/T04 从共享契约基准并行，各自独立 worktree，不修改根配置与其他任务目录。基准包含本次新增文件，不包含初始未提交 AGENTS.md、README.md、docs 设计包。原始文档复制到工作树作为输入，不提交。主 agent 是唯一集成写入者，以点名文件复制集成并核对变更。

公共函数契约：protocol/index.ts 导出 parseEnvelope(input, source)、validateEvent(input)、canonicalize(value)、utf8Bytes(value) 及 types.ts 类型。解析错误抛出 ProtocolError，包含 code、items（可选）。采用严格 v1 结构；项目白名单校验在 application。存储只依赖 protocol/types 和 storage-contract。storage-postgres/index.ts 导出 createPostgresStore(options)、migrate(connectionString)、maintain(connectionString, options)，完整 Options 由驱动公开类型定义。

API 端输出 snake_case；内部存储端口 camelCase scope/access，查询筛选保持 wire snake_case。相对导入使用 .js 后缀，TypeScript bundler resolution；SDK 不引入 Node 内置模块。全仓不写代码注释。依赖与脚本仅由主 agent 管理。

提交前四项：lint、typecheck、build（含 Next 生产构建）、test（单测覆盖率、真实库集成及开发/生产浏览器冒烟）。初始覆盖门禁全生产 packages/src 指标 75/65/75/75，关键风险另以真实 DB 与行为证据验收，不把单测覆盖率作为 HA 证明。性能基线与 C01–C30 见设计包及 Space。没有满足的验收保持未完成。

仓库初始无 HEAD、无 remote。worktree 基准使用临时 commit-tree 对象，不更新当前分支、不暂存用户文件。只在最终门禁全部通过时提交自己点名的新增路径；无 remote 时报告 push 阻塞。
