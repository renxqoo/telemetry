# 运行与验收入口

需求与验收以 [Space](https://chatgpt.com/space/page_6ae698b7631481918b634bf7420821cf)、本目录的实现记录和公共模块 README 为准。上级设计包保留初始方案输入，具体配置 DTO 与导出以当前代码核对。

环境需要 Node 26、Bun 1.4.4 和 PostgreSQL 18。根依赖锁定具体补丁，安装使用 `bun install --frozen-lockfile`。本地 PostgreSQL 测试使用独立临时目录和动态端口，不连接现有业务数据库；Linux 默认从 `/usr/lib/postgresql/18/bin` 查找，macOS 从 `/opt/homebrew/opt/postgresql@18/bin` 查找，其他路径通过 `TELEMETRY_PG_BIN` 注入。以普通用户运行 initdb。

无Docker的Linux测试同样支持独立目录安装Node和PostgreSQL；必须先满足所选二进制的系统动态库依赖。三节点TLS夹具显式把Unix socket放入自己的临时目录，不依赖发行版的/var/run/postgresql或后台系统数据库服务。单机多进程验证只证明对应复制与进程故障行为，不作为跨可用区或整机故障验收。

## 工程检查

- `bun run lint` 执行模块依赖边界、类型感知 oxlint 和 bun fmt 检查；原始未提交设计文件不进行格式化。
- `bun run typecheck` 检查全部 TypeScript。
- `bun run build` 构建 Node 采集/查询/CLI/维护工件、SDK 与类型声明，并构建隔离 Next 验收应用。
- `bun run test` 启动临时 PostgreSQL，运行单元和真实库集成测试并统一收集覆盖率，随后运行开发和生产两模式 Playwright 冒烟。浏览器准备使用 `bun x playwright install chromium`。
- `bun run test:unit` 只执行模块定向测试；含真实事务和复制的验收使用 `bun run test:integration`。完整覆盖数字与门禁以 integrated 报告为准。
- `bun run test:e2e e2e/telemetry.spec.ts` 验证浏览器和 Next 实际适配；内部启动的服务和数据库在退出时清理。Next 应用只用于验收，不作为管理产品或生产入口。

覆盖门禁匹配所有 `packages/**/src/**/*.{ts,tsx}`，排除纯类型及测试文件；statements 75%、branches 65%、functions 75%、lines 75%。这些门禁不替代故障演练或业务正确性断言。

## 本地或生产服务

Collector 与 Query 分别使用 `bun run collector` 和 `bun run query`；Node 构建入口位于 `dist/apps/collector/src/main.js` 与 `dist/apps/query-api/src/main.js`。`HOST` 控制监听地址，`PORT` 控制端口。启动前必须提供有效项目配置 `TELEMETRY_CONFIG` 和秘密配置；具体结构见 [Application README](../../packages/application/README.md) 与 [驱动 README](../../packages/storage-postgres/README.md)。开发 profile 明确为单节点，不声明跨故障域持久性。

数据库迁移单独使用 `TELEMETRY_MIGRATION_DATABASE_URL` 与 `bun run db:migrate`；维护使用 `TELEMETRY_MAINTENANCE_DATABASE_URL` 与 `bun run db:maintain`。两者不能使用公网应用角色。运行时帐号只授予对应 collector/query/cleanup 角色。HA 每个实例使用独立、有连接上限的 LOGIN 和稳定实例名，所有物理节点提供直连数据与清理地址。服务启动先核对能力、权限、设置与遗留会话，不满足则停止准入。

CLI 使用 `node dist/packages/cli/src/main.js`。认证通过 `TELEMETRY_TOKEN`、逗号分隔的 `TELEMETRY_ENDPOINTS`，或当前用户所有、权限为 0600 的 `TELEMETRY_CREDENTIALS_FILE`。秘密不接受命令行参数。`events/errors list/get`、`export`、`symbolicate`、`doctor` 的完整参数见 CLI README。导出为 live-pagination；每页重新读取，不承诺跨页快照。

## 性能与故障装置

`bun run test:load --duration-ms 600000 --rate 500 --query-rate 10 --out artifacts/load.json` 启动隔离 PostgreSQL 和真实 API，以有界并发生成 95% 事件与 5% 错误，记录吞吐、失败、p50/p95/p99、内存和已确认与实际唯一事件数。这个入口测试本机单节点与当前实现；生产验收仍需要跨故障域 N-1 负载。通过秘密注入提供 TELEMETRY_LOAD_DATABASE_URL 时，改用调用方管理的隔离 PostgreSQL 测试库，可在目标 Linux 镜像和独立数据卷中测量；该库必须为空的可销毁测试库，入口会迁移并写入真实样本，不负责删除外部库。测量开始前执行与服务启动相同的存储 readiness，失败时不开始计时。报告同时记录客户端事件循环延迟与有界失败时间样本。

`bun run test:ha INVENTORY_JSON --execute-faults REPORT_JSON`在显式配置的三区端点执行故障与恢复命令，并核对全部已确认ID。凭证来自TELEMETRY_HA_WRITE_TOKEN与TELEMETRY_HA_READ_TOKEN。配置严格字段见scripts/ha.ts的schema；fault/recover/observe各提供binary和args，不经过shell；必须指定fault_target_domain且属于fault_domains。observe独立读取实际拓扑并输出JSON：`members`固定3项，每项包含`id`、`fault_domain`、`state`（running/unreachable）、`role`（primary/replica/unknown）、`synchronous`布尔值；不得仅复述已执行命令或期望状态。

故障前和恢复后要求3个域全部running、恰好一个primary且至少一个同步replica；故障生效要求目标域unreachable、其他域可用且仍满足唯一主和同步副本，原主位于故障域时必须换主。三次观察的成员身份及域绑定保持一致；没有独立观察时在执行故障前拒绝，no-op fault或未恢复冗余均失败。故障后和恢复后分别重新核对全部确认ID，报告两阶段缺失数量及缺失ID并集；未执行的阶段数量为null，不能解释为零缺失。拓扑恢复但数据回退同样失败。

命令在受控进程组中执行，输出流关闭之前保持截止，超时和退出时收敛派生进程；命令输出和HTTP响应均有界，探针ACK通过真实SDK传输校验。构建后的入口是`node dist/scripts/ha.js`。此入口只验证一次有观测的目标域失效和恢复，不自动证明故障域物理隔离、硬件fencing、N-1持续容量、备份或30天SLO；报告明确这些未验证项。真实三区部署仍需可信基础设施清单与专门演练证据。

`ops/render.ts INVENTORY_JSON OUTPUT_DIRECTORY` 生成三区各节点 Patroni/etcd 配置、Kubernetes Collector/Query StatefulSet、PDB、网络入口策略、双维护 CronJob 与 pgBackRest 配置。inventory schema 在该脚本中明确定义；需要真实主机、区名、TLS 路径、Secret 名、镜像摘要和备份路径。nodes 中每区分别提供 collector_secret 与 query_secret，六个实例各使用独立 LOGIN 与清理凭证；每区 collector_host、query_host、ingress_class 和 ingress_tls_secret 生成独立 HTTPS 入口，仅公开 /v1 路径，运维端点保留在私网；生成的稳定 slot 名覆盖 TELEMETRY_INSTANCE_ID，并通过节点区标签约束放置。只生成文件，不执行部署。节点与仲裁必须分别放在三个真实故障域，Linux watchdog required 模式不可省略。

Patroni 严格同步与 watchdog、etcd 双向 TLS、数据库验证 TLS、独立连接身份和低权限角色、外部探针以及备份恢复共同参与高可用。Bootstrap 之后动态参数通过 Patroni 管理，不能只修改 bootstrap 配置期待生效。[Patroni 配置](https://patroni.readthedocs.io/en/latest/yaml_configuration.html)

pgBackRest 配置与生产 systemd timer 位于 ops/production。秘密 EnvironmentFile 需注入 `PGBACKREST_STANZA`、`PGBACKREST_REPO1_CIPHER_PASS`；由部署系统从独立秘密通道注入，不将密码写入生成的配置。先执行 stanza-create/check 和首次 full backup，再启用 daily incremental/weekly full timer。仓库保留两条完整链，异故障域备份目标与加密密钥独立保存。每月在空隔离数据目录执行时间点还原，并核对已确认 ID、收据、配置和实际 RPO/RTO；未执行还原不宣称备份可恢复。

每区需要独立 TLS 入口，把 /v1/ingest 只路由到 collector，把查询端点只路由到 query；入口摘流、超时与最大请求体需与应用配置一致。监控读取私网 /metrics，公网入口不得暴露运维端点。生产发布按区逐实例进行，旧实例退出且连接预算盘点完成后再启动相同 slot；新镜像验证后继续下一区。回退只替换兼容应用镜像，数据库回滚另行核对数据。

独立网络探针使用 `bun run test:probe CONFIG_JSON`，在已注册事件名下执行真实写入与带审计的详情读取，并输出 Prometheus 成功与耗时指标。配置字段见 ops/probe.ts 的严格 schema；读写秘密分别从 TELEMETRY_PROBE_WRITE_TOKEN 和 TELEMETRY_PROBE_READ_TOKEN 注入。ops/production/probe.service 和 probe.timer 可放在独立故障域，配合 probe.sh 原子发布 node_exporter textfile；probe.env 注入 TELEMETRY_PROBE_ENTRY、TELEMETRY_PROBE_CONFIG、TELEMETRY_PROBE_METRICS 绝对路径与两个秘密。失败仍发布 success=0 并保留非零退出状态。Prometheus 和 Alertmanager 应与平台入口独立部署；仓库规则覆盖外部失败及发布停止，实际通知目标由部署负责人注入，不向未授权接收者发送消息。

探针timeouts默认total_ms=5000、write_ms=3000，均为正整数且write_ms<total_ms；total_ms上限60000，生产timer的TimeoutStartSec须覆盖所选总预算。写阶段按剩余端点分配单次截止，每个端点用真实SDK进行一次独立探针事件尝试；失败或未知后关闭该客户端再继续后续端点，不把未确认ID算作成功。读取同样保留后续端点预算，响应体读取也受截止保护。一次探针在故障期间可能产生多个不同ID的诊断事件，成功仅表示最后一个已确认ID经授权查询读回，不代表所有区域健康或30天SLO达标。
