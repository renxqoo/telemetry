# 链路追踪方案独立审查记录

日期：2026-11-01。范围为[功能规格](TRACES-SPEC.md)和[技术架构](TRACES-ARCHITECTURE.md)，不包含产品实现或部署。

按用户要求启动全新上下文子agent `/root/traces_design_review`，初始上下文不继承主会话，独立读取AGENTS、方案、实际代码与官方协议资料；仅允许只读审查。主会话负责修订，reviewer再对修订稿复核。

架构复查已闭合本节发现。后续由全新上下文子agent `/root/traces_test_analysis` 使用workflow:test技能及其test-design/test-quality参考进行只读分析，提出第2节的三项测试可验证性缺口。主会话补充规格和架构后，同一测试子agent针对性复核确认三项均闭合、没有新增P1/P2行为矛盾；其建议的partial计数措辞也已同步。实施与生产可用性仍以真实验证条件为准。

## 1. 审查发现与处理

| 发现                                                | 影响                                                            | 最终规则与位置                                                                                           | 复核                                    |
| --------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P1 recording span只有结束后队列预算，没有结束前预算 | 长生命周期span持续addEvent或巨大初始参数可耗尽业务进程内存      | Spec6增加active/总bytes/单span/数量/深度/节点/循环引用预算，复制前增量执行；Arch7明确计费与释放          | reviewer确认闭合                        |
| P1 tracestate只按vendor key放行                     | 合法vendor下的任意邮箱/token可被持久化或传播                    | Spec5/6、Arch6/7按vendor+精确safe_values+长度规则过滤，默认全部清空，覆盖extract/inject/parent/link/入库 | reviewer确认闭合                        |
| P1 全部候选都是服务RLS隐藏冲突时没有nonce写入       | 唯一冲突不等于新同步WAL屏障，可能基于尚未安全确认的数据永久拒绝 | Arch5.2受限SECURITY DEFINER确认函数，全序锁定当前项目/环境候选并只更新nonce，普通服务RLS保持             | reviewer静态确认机制闭合；SQL探针见下节 |
| P2 裸JSON大整数的无损要求与引用ProtoJSON指引不同    | 不同实现可能对同一数值形成不同摘要                              | Spec3.2区分字符串/Binary精确整数与裸数值binary64语义，T02给独立期望                                      | reviewer确认闭合                        |
| P2 固定proto中的Resource.entityRefs未界定           | 开发态实体引用可能进入不受控摘要/存储或造成两编码不一致         | Spec3.2与Arch4显式忽略该development字段，不入摘要/存储并计诊断                                           | reviewer确认闭合                        |
| P2 确认函数512硬上限与可调max_spans没有一致范围     | 若配置1024，合法513项会在底层恒定503                            | Spec7明确首版max_spans范围1–512，Arch5.2要求各层从统一协议上限派生                                       | reviewer最终确认闭合                    |
| 检查清单仍写collector直接nonce UPDATE               | 与受限函数权限设计不一致                                        | Arch6 readiness核查函数owner/search_path/撤权/EXECUTE及普通服务RLS                                       | reviewer最终确认闭合                    |

主会话另核对并修订发布机制：当前schema_version确有CHECK(version=1)，不能直接INSERT2；采用单次发布窗口内显式扩展CHECK与短暂版本记录并存，旧实例排空后同次删除1记录并收紧为2，不保留无限期兼容路径。配置按两组实例独立挂载切换；已有trace数据时只能保留数据回退事件入口或前向修复。

## 2. 测试分析补充

| 发现                                         | 已补充的契约与验证                                                                                                                                                                                          | 补充稿复核          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| P1 合法大span页超过现有CLI 8 MiB响应上限     | Spec4：页预算默认4 MiB、范围4–8 MiB，安全投影≤1 MiB并预留元数据；按连续前缀截页和最后返回项游标。Arch5/6：派生字节列、先窄投影后有界取正文。T15验证64个大span分批入库、真实HTTP→CLI跨短页完整导出           | 测试子agent确认闭合 |
| P2 flush/close六字段缺少统计作用域与超时归类 | Spec6.1：每调用待处理快照、五类互斥守恒、默认/合法timeout、未知后永久失败、重叠flush和幂等close；六组独立数值算例。Arch7：打包不跨活跃快照边界，partial计数不伪造ID，flush截止不取消共享发送器。T16对应断言 | 测试子agent确认闭合 |
| P2 OTLP JSON oracle来源未独立定义            | Arch9.1分开Binary/protoc与OTLP JSON上游固定示例或人工审核原文，记录来源和SHA256；禁止生产adapter造期望，增加hex/base64、枚举名称/数字、字段名差异及重复键原文。T17对应互操作反例                            | 测试子agent确认闭合 |

Arch9.2进一步把八组关键场景的独立预期、最小验证入口、替身边界和资源清理写清；T18覆盖发布产物与配置/数据库回退。修正测试目录为明确的`__test__/`路径。测试分析和本次文档补充没有执行产品测试，以下探针属于此前架构设计阶段的既有证据，不能作为新增用例通过结果。

## 3. 已执行的隔离探针

两组数据库探针均使用仓库[临时PostgreSQL工具](../../tests/support/postgres.ts)的startPostgres，通过`node --import tsx --input-type=module`调用；独立创建临时集群、探针角色和表，finally关闭连接并stop，未访问项目业务数据库、未执行产品migrate、未修改产品代码。实际版本为PostgreSQL `18.6 (Homebrew)`。

### 3.1 隐藏唯一冲突

建立以(project,environment,trace,span)为主键的收据表，开启ENABLE/FORCE RLS。collector策略限定项目p、环境prod、服务worker；预置相同身份的web记录，授collector SELECT/INSERT和nonce列UPDATE。以collector角色尝试worker同ID的INSERT ON CONFLICT DO NOTHING、SELECT及nonce UPDATE，再插入新span。

实际输出：

```json
{
  "version": "18.6 (Homebrew)",
  "hiddenConflict": { "inserted": 0, "visible": 0, "nonceUpdated": 0 },
  "authorizedFresh": { "inserted": 1 }
}
```

这证实原路径没有对隐藏收据进行nonce写入，不能把普通SELECT或唯一冲突当作确认屏障。

### 3.2 受限跨服务nonce确认

独立集群建立无LOGIN/无SUPERUSER/无BYPASSRLS的owner和collector，owner专属RLS策略允许函数管理收据，collector仍按project/environment/services过滤。函数SECURITY DEFINER、固定search_path、PUBLIC EXECUTE撤销，只授collector EXECUTE；根据transaction scope限定项目/环境，按身份全序FOR UPDATE后仅改nonce并返回数量。分别预置当前项目与其他项目同ID的web记录；collector只授权当前项目worker。

实际输出：

```json
{
  "touched": 1,
  "collectorVisible": 0,
  "postconditions": [
    { "project_id": "other", "nonce": 0 },
    { "project_id": "p", "nonce": 1 }
  ]
}
```

探针确认在保持collector正文不可见的同时可以产生当前项目的nonce更新，且不更新其他项目。本探针使用简化integer nonce验证权限路径，目标实现使用每操作新UUID；没有运行真实跨可用区复制、并发压力或故障切换，不把结果视为HA证明。

### 3.3 数值解释

reviewer运行只读Node算例，并对照[ProtoJSON的int64规则](https://protobuf.dev/programming-guides/json/#strings-for-int64s)：

| Node表达式                                               | 实际字符串结果        |
| -------------------------------------------------------- | --------------------- |
| `BigInt(JSON.parse('1793491200123456789')).toString()`   | `1793491200123456768` |
| `BigInt(JSON.parse('"1793491200123456789"')).toString()` | `1793491200123456789` |

最终选择标准裸数值语义，精确字符串与Binary值不经过Number。该算例没有调用待实现codec，避免用实现生成自己的期望值。

## 4. 交付验证与实施条件

本次仅新增3份方案文档，`bun fmt --check`针对这3份文件通过，26处本地文件链接全部可解析，未修改运行时代码、测试或配置。按仓库纯文档例外未运行`bun run lint`、`bun run typecheck`、`bun run build`、`bun run test`，也未运行单元/E2E/覆盖率：无本次产品测试用例数，statements/branches/functions/lines实际覆盖率均不适用。上述隔离探针不计为产品测试通过。

实施必须补齐协议golden、recording预算及隐私反例、真实PG并发/RLS、确认函数的同步复制故障、保留维护、查询审计、SDK关闭与CLI闭环，并执行四项门禁。压力、真实故障域及发布回退演练尚未执行；默认保护值与候选SLO不能当成实测容量。

当前仓库无初始提交、无remote，原有工程文件均为未跟踪；本轮不stage或提交这些文件，不push或发布。方案文件作为本轮独立交付保留，未安装新增依赖。
