# Mission Gate lite：开发计划与验收合同

日期：2026-09-14。基线：upstream `f36f483`（0.11.0）。
本轮只交付本地代码、测试及审核；不 push，不创建/更新 PR，不替换本地已安装 Skill。

## 目标与范围

让 `/opc <flow> --mission <task>` 在保留 flow 拓扑的同时，能够察觉重复修复、
投入耗尽或关键假设变化，暂停局部推进并作一次有界的全局判断。
不声称机制能消除模型过度思考；速度/成功率改善需要另做真实任务对照。

采用最新 main 为基础，移植旧 PR 的决策分类及有界重试语义，复用上游
repairEdgeCounts、file-lock、原子写、flow 验证和 model-route。
不复制旧 PR 的跨会话事务、签名账本、第二套路由或安装改造。

### 支持边界

- 单个串行控制者管理一个 flow；子 Agent 只返回产物，不写 flow-state。
- Mission 为 flow-state 的可选字段；无 Mission 的调用保持原有结果和语义。
- 合同包含目标、至少一个 outcome、非目标、最大修复次数和时长；冻结在 init。
- 修复总量来自原有计数；同一修复边第二次出现是检查信号，不是无进展的证明。
- ARTIFACT / PLAN / ENVIRONMENT / GOAL_SPEC 分类交给新上下文评审；机器不猜语义。
- CONTINUE_CURRENT / RESHAPE_SMALLER 合计最多放行一次特定转换；RECON 最多一次，
  仅允许读取/诊断，仍保持暂停。HUMAN_REBET 不授予新权限，STOP 保留成果。
- 时长耗尽或原有 flow 限制到达后不允许通过 Mission 重试豁免。
  修复预算 N 表示最多完成 N 次修复：第 N 次成功后可按原有证据验收，但不得开始 N+1 次。
- 最终 outcome 审查在已有终验职责内进行；若 flow 只有执行前的 test-design 评审，
  则明确增加一次终态 outcome-review 调用，不添加图节点或重跑全部角色。
  结果绑定当前 flow 进度、Git 工作树和证据文件。
  既有测试/握手/结构安全门仍必须通过；Mission 自报 PASS 不能替代它们。
- 绑定防止误用旧结果，不提供抵抗有写权限进程恶意改盘的安全边界。
- 首版仅支持有 HEAD 的 Git 仓库，不支持 submodule 证据绑定。
  不支持 Mission loop、parent-session、旧事务版 Mission 状态的自动迁移。
  不支持的入口必须明确失败，不能静默降级成普通 flow。
- 中断保留最后完整状态；恢复须先核验当前证据。不增加自动回滚、命令重放或
  exactly-once 副作用保证。现有副作用安全边界不变。

## 最短执行链

| 输入 → 动作 | 输出 → 消费者 | 失败去向 |
| --- | --- | --- |
| 用户任务 → 宿主形成简短合同；init 校验并冻结 | flow-state.mission + 启用回执 → 宿主 | 输入无效则不建 flow |
| 当前状态/拟走边 → 原有预算检查 + Mission 检查 | allow 或具体 trigger → 调度者 | 停止派发；读取 mission status |
| 原任务、合同、当前证据、trigger → fresh reviewer | 分类、建议、理由、证据 → mission decide | 坏结构/旧绑定拒绝；无法支持则停 |
| 合法建议 → 单状态锁内应用 | 一次转换授权或保持暂停 → 原 flow | 预算/旧安全门仍拒绝 |
| 当前成果与 outcome → 既有终验 reviewer | outcome→证据映射 → mission accept | 缺失/旧证据拒绝完成 |
| Mission 验收绑定 + 原有终验 | completed → 用户 | 任一失败不完成 |

## 开发步骤

1. 固定基线并记录主分支干净环境测试；写明范围与验收（本文）。
2. 实现纯判定与最小命令层，接到现有 init、预算检查及终验；不改路由/安装。
3. 补充短 Skill 入口、按需加载的 Mission 协议及真实可执行测试。
4. 运行 Node 18/20 隔离 HOME 的全量 suite；在相同环境比较 main 与修改版。
5. 独立新上下文执行一次真实 Mission 审查产物，并由程序消费；另做有界代码审核。
6. 仅修复有证据的范围内问题，复测受影响项，交付审核结果及未验证边界。

Appetite：不引入依赖、第二个调度器或恢复日志；新增运行时目标不超过约 800 行，
现有 transition 只留少量接入点。该规模是范围预警，不是以缩短代码牺牲校验的硬指标。
若修复需要父子状态事务或第三轮架构扩张，先停下来报告，不继续加层。

## 详细验收标准

| ID | 场景与应观察结果 | 验证方式 |
| --- | --- | --- |
| A01 | 普通 init/route/transition/finalize 不出现 Mission 干预；旧测试不变 | 全量现有 suite |
| A02 | build-verify 与 --mission 可组合；init 回执明确 flow、Mission 模式和预算 | CLI 集成测试 + Skill 检查 |
| A03 | 空目标、空 outcome、非法预算/未知 schema、缺参数拒绝；原状态不覆盖 | 反例 + 文件字节比较 |
| A04 | 首次修复按原 flow 执行；第二次同边修复暂停；读取状态不改变计数 | 纯函数 + CLI |
| A05 | N 次修复后第 N+1 次拒绝；第 N 次真实成功可交付；失败证据不能经 pass/skip/goto/finalize 绕过；时长耗尽对终态也拒绝 | 反例 + 现有 gate 测试 |
| A06 | PLAN/ENVIRONMENT/GOAL 可以显式暂停；坏分类、无理由或无证据建议拒绝 | CLI 反例 |
| A07 | 重试只能放行原进度的特定边一次；新进度不能重放；RECON 第二次拒绝 | 状态机最小用例 |
| A08 | HUMAN_REBET 仅暂停等待新授权；STOP 不标成功；Mission 不改目标/预算 | CLI + 字节比较 |
| A09 | 缺终验、空文件、缺 outcome、错误文件路径、旧 Git/证据/进度绑定拒绝；完成后重复核验成功，但真实证据变化仍拒绝 | 终验反例 + 幂等核验 |
| A10 | Mission outcome 通过后，原有失败测试或不合法握手仍阻止 finalize | 集成失败路径 |
| A11 | loop/parent/旧 Mission 格式明确拒绝；不创建子会话或修改父状态 | 反例 |
| A12 | 错误 JSON、锁争用或写失败不能伪报成功；advance 必须确认内层转换/终验成功；状态写复用已有锁/原子写 | 确定性失败注入 + 终态消费反例 |
| A13 | 一个真实 fresh reviewer 读阶段 prompt，写结构结果，由 CLI 校验消费 | 实际 Agent ID/文件/命令记录 |
| A14 | Node 18、20 全量通过；不靠已有用户配置、扩展、Git identity 或 key 文件 | 隔离 HOME、明确环境、测试日志 |
| A15 | 不增加 resolver，不改 hook/installer/版本/依赖；新运行时职责分离 | diff 审核 |
| A16 | 独立审核没有未处理的阻断问题；准确列出非阻断项、限制与证据 | 有界独立审核及报告；原定 Summer 的执行偏差见下 |

## 不属于本轮完成声明

Linux 容器结果仅在实际运行后声明。无可用容器时，macOS 隔离环境不能冒充 Linux CI。
远端 CI 因本轮禁止推送而不触发。模型 A/B、生产跨会话恢复、性能提升均未验证。
验收记录须保留失败和主分支环境问题，不能把两者混成修改版全绿。

## 执行偏差记录

Summer 在首次外部调用时因 TLS 证书不匹配暂停，未产生 accepted 审核结果。
保留其失败记录，不关闭证书校验；另由无作者历史的 Codex 原生独立 Agent 审核，
只对发现的两项实证问题做修复复核。原生审核不冒充 Summer 通过。
