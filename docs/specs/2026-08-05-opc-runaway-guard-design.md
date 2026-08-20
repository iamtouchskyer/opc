# OPC Runaway Guard 最小改动设计

## 目标

用最小机械 guard 封住两类 accidental runaway：

1. auto flow 内同一条 repair edge 持续执行 review → fix → review；
2. 单个 node 内持续调用 tool/subagent，迟迟不 transition。

本设计是 **accidental-runaway circuit breaker**：它约束 Claude Code 官方 tool execution path，不是防御同一 OS 用户下 malicious process 的 security boundary。

## 非目标

- 不实现 human authorization、nonce、TTY 判断、Touch ID、signed grant 或独立 broker。
- 不防御蓄意绕过、预先启动的 background process 或直接修改本地文件的同 UID process。
- 不重构 finding lifecycle、review/test/extension 协议或 flow template schema。
- 不新增 flow-level `blocked` lifecycle、`block`、`unblock` 或 budget reset command。
- 不改变现有 `maxLoopsPerEdge`、`maxTotalSteps`、`maxNodeReentry`。
- 不设置 Agent、model、flow 或 tool-specific budget。
- 不限制 interactive flow 的人工 repair 次数。
- 不顺带重构 multi-session ownership 或 takeover。

## 设计概览

增加两个 guard，共用一个 run-scoped stop marker：

1. **Flow guard：auto repair-edge budget**
   - 只统计成功的 `FAIL` / `ITERATE` transition；
   - 每条 exact repair edge 在一个 flow 中最多自动执行一次；
   - 第二次执行时拒绝 transition，并在当前 node/run 写 `guard-stop.json`。
2. **Node guard：PreToolUse budget**
   - 每个 node/run 最多 30 分钟、100 次 aggregate tool calls；
   - 使用 `O_CREAT | O_EXCL` atomic slots，parallel calls 不丢计数；
   - 超限时在当前 node/run 写同一个 `guard-stop.json`。

`PreToolUse` 发现当前 node/run 已有 stop marker 后，拒绝该 Claude session 的所有后续 tools，包括 Bash。外部 terminal 使用现有 `stop`、`goto`、`skip` 或 `pass` 进入其他状态后，旧 marker 因 runKey 不再匹配而自然失效。

不增加 recovery token，也不尝试证明调用者是人。

## Session Registry

### 目的

Hook 不能依赖 `latest` symlink：同 repo 的另一个窗口 init 会覆盖它。也不需要扫描所有 canonical、legacy 和 `.harness*` 目录。

默认 `/opc` auto init 写一个 session registry：

```text
~/.opc/runtime/<sha256(claudeSessionId)>.json
```

内容：

```json
{
  "sessionId": "<Claude Code session_id>",
  "sessionDir": "<absolute OPC session dir>",
  "projectRoot": "<canonical absolute project root>",
  "registeredAt": "<ISO timestamp>"
}
```

文件名使用 session ID 的 SHA-256，不把未经验证的 input 直接拼入路径。读取后仍必须精确比较文件内 `sessionId` 与 hook input。

### Init contract

默认 `/opc` 路径必须调用：

```text
opc-harness init --auto --claude-session-id "${CLAUDE_SESSION_ID}" ...
```

`${CLAUDE_SESSION_ID}` 是 Claude Code skill string substitution，不是 shell environment variable。

`/opc -i` interactive 路径不传 `--auto`，不创建 registry，也不受新 guard 影响。

`init --auto` 必须：

1. 验证 PreToolUse hook 已安装；
2. 要求非空 `--claude-session-id`；
3. 拒绝同一 session ID 同时绑定第二个 active auto flow；
4. 在新 flow state 中写入 `autoMode: true`、`_claudeSessionId`、`flowStartedAt` 和空 `autoRepairCounts`；
5. atomic write registry；registry 创建失败时回滚本次新建的 session dir/state，init 不得报告成功。

registry 不在 `stop` 或 `finalize` 时立即删除：hook 读取 state 后会对 stopped/completed flow allow；同一 session 再次 init 时可覆盖指向 stopped/completed flow 的旧 registry。Session GC 必须保留仍由 matching registry 指向的 active auto flow；清理 stopped/completed auto flow 时，必须先在同一个 registry lock 下验证并删除 matching registry，registry lock 或 cleanup 失败则保留 session dir。这样 GC 不会留下指向缺失 state 的 stale registry，也不会删除仍受 guard 约束的 active flow。process crash 留下的 active registry/session 由 external stop 后的后续 GC 清理。

本轮不实现跨 Claude session resume/claim。Claude process 重启后，用户可在 external terminal 停止旧 flow，再启动新 flow；compaction 不更换 session ID，继续正常工作。

## Current Run Identity

不改变现有 history semantics。current run 按以下规则解析：

```text
if history tail exists and tail.nodeId == currentNode:
    runId = tail.runId
    startedAt = tail.timestamp
    runKey = "history:" + (history.length - 1) + ":" + runId + ":" + startedAt
else if totalSteps == 0
        and history is empty
        and currentNode == entryNode:
    runId = "run_1"                 // display compatibility only
    startedAt = flowStartedAt
    runKey = "initial:" + entryNode + ":" + flowStartedAt
else:
    invalid state → fail closed
```

initial execution 与首次 re-entry 都可能显示 `run_1`；`initial:` 和 `history:` prefix 保证 budget identity 不碰撞，而不改变 run numbering。

## Flow Guard：Auto Repair-Edge Budget

### Repair attempt

当且仅当以下条件全部成立时，transition 是 auto repair attempt：

```text
state.autoMode == true
AND verdict IN {FAIL, ITERATE}
AND to != null
```

budget key 是 exact edge：

```text
from + "→" + to
```

`flow-state.json` 增加独立 counter：

```json
{
  "autoRepairCounts": {
    "code-review→build": 1
  }
}
```

不能复用 `edgeCounts`，因为 `goto`、`skip` 和普通 transition 也会递增它。旧 state 缺少 `autoRepairCounts` 时按空 object 处理。

### Transition contract

在 state lock 内完成以下顺序：

1. 校验 requested edge 和 current state；
2. 计算 exact repair edge count；
3. 若 count 已为 `1`，在任何 handshake、extension、history 或 target-directory side effect 前 atomic-create 当前 run 的 `guard-stop.json`，然后返回：

```json
{
  "allowed": false,
  "requiresHuman": true,
  "reason": "auto repair budget reached for 'code-review→build'"
}
```

4. 首次 repair transition 继续执行现有 validation 和 graph limits；
5. 只有 transition 最终成功时，才在同一 state lock 内递增 `autoRepairCounts[edgeKey]`。

validation failure、PASS、`goto`、`skip` 和 `pass` 不消耗 repair budget。不同 repair edge 独立计数，因此多阶段 flow 的每个 stage 都有一次自动修复机会。

如果 stop marker 创建失败，transition fail closed，不得继续 transition。

`cmdAdvance` 必须检查 nested transition result。`transition.allowed == false` 时返回 `advanced:false`，并透传 `requiresHuman` 和 reason。

## Node Guard：PreToolUse Budget

### Hook registration

扩展现有 `opc install-hooks`：

- 保留 `PreCompact`、`PostCompact`；
- 新增同步 `PreToolUse` command hook；
- 保留用户已有 hooks；
- 重复安装幂等；
- 写 settings 前验证全部 hook 文件存在；
- 使用 atomic replacement，失败时原 settings 保持完整。

Hook 使用 Node 实现，不依赖 `jq` 或 `flock`。

### Activation

每次 PreToolUse：

1. 读取 hook input `session_id` 对应的 registry；
2. registry 不存在时 allow，零副作用；
3. 精确校验 registry 内 `sessionId`；
4. canonicalize `cwd` 和 `projectRoot`，要求 cwd 等于 project root 或位于其下；
5. 读取 registry 指向的 `flow-state.json`；
6. completed、stopped 或 interactive flow allow；
7. 要求 state `_claudeSessionId` 与 hook `session_id` 精确相等；
8. 解析 current node/runKey。

registry 已存在且损坏、指向缺失 state、identity 不匹配或 current run 无法解析时，对该 session fail closed。没有 registry 的普通 Claude session、interactive flow 和其他 session 不受影响。

### Budget storage

每个 node/run 使用独立目录：

```text
$SESSION_DIR/node-budget/<sha256(nodeId,runKey)>/
  context.json
  guard-stop.json
  slots/
    000001.json
    000002.json
    ...
```

`context.json` 首次 atomic-create 后固定：

```json
{
  "nodeId": "code-review",
  "runId": "run_2",
  "runKey": "history:4:run_2:<timestamp>",
  "startedAt": "<resolved run timestamp>",
  "maxWallTimeSeconds": 1800,
  "maxToolCalls": 100
}
```

本轮不提供 environment override 或 runtime configuration，避免 takeover、restart 或配置变化扩大既有 budget。

`startedAt` 使用 run timestamp，不以第一次 tool call 起算。30 分钟按绝对 wall clock 计算，Claude Code 关闭或离线时间也计入。

### Atomic slots

每次 tool call 依次尝试用 `O_CREAT | O_EXCL` 创建 slot `1..100`：

1. 第一个成功创建的 slot 是本次调用的唯一 claim；
2. `EEXIST` 时继续尝试下一个；
3. 全部存在时超限；
4. 空或损坏 slot 仍视为已消耗；
5. slot 永不删除，不使用共享 JSON read-modify-write counter。

slot evidence 至少包含：

```json
{
  "sessionId": "<PreToolUse session_id>",
  "toolUseId": "<tool_use_id>",
  "toolName": "Agent",
  "agentId": "<optional agent_id>",
  "claimedAt": "<ISO timestamp>"
}
```

Agent invocation 消耗一个 slot；Agent 内每个 child tool invocation 也触发 PreToolUse，并继续消耗同一 root session + node/run budget。`agent_id` 只用于 evidence，不进入 budget key。

### Decision order

1. 定位 registry 和 active auto flow；
2. 解析 current node/run 和 budget directory；
3. 若当前 run 的 `guard-stop.json` 已存在，deny；
4. atomic-create 或验证 frozen `context.json`；
5. 若 `now - startedAt >= 1800s`，atomic-create stop marker 并 deny；
6. 尝试 claim slot；成功则 allow；
7. 无 slot 可 claim时 atomic-create stop marker 并 deny。

第 100 次 aggregate tool call允许，第 101 次拒绝。Hook 只在下一次 tool call 前执行，不能中断已经运行中的 provider request、tool 或 subagent。

### Unified stop marker

Flow guard 和 node guard 都写同一格式：

```json
{
  "sessionId": "<Claude session ID>",
  "nodeId": "code-review",
  "runKey": "history:4:run_2:<timestamp>",
  "reason": "repair-edge-budget | wall-time-budget | tool-call-budget",
  "edgeKey": "<optional exact repair edge>",
  "createdAt": "<ISO timestamp>"
}
```

文件使用 `O_CREAT | O_EXCL`。多个并发 trigger 只保留第一个原因；已存在即表示当前 run 已 trip。

Hook deny 时 exit `0` 并输出 Claude Code 官方 decision JSON：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "OPC accidental-runaway circuit breaker tripped for the current node/run. Stop and report. Recovery requires an external terminal transition or stop."
  }
}
```

不使用 exit `2` 携带 JSON。

## Recovery

Trip 后，同一 Claude session 的下一次 tool call会被 hook 拒绝，因此不能通过该 session 的 Bash 自动恢复。

用户在 external terminal 使用现有命令：

```text
opc-harness stop --dir <session>
opc-harness goto <node> --dir <session>
opc-harness skip --dir <session>
opc-harness pass --dir <session>     // 仅 gate
```

`stop` 后 flow 不再 active；其他命令成功进入新的 node/run 后，runKey 改变，旧 stop marker 自动失效。不删除 marker、不增加 reset/unblock command。

这里的“external terminal”描述恢复路径，不是 human identity proof。设计不承诺阻止 malicious same-UID process 调用相同命令。

## Auto Mode 文案

删除现有无条件继续语义：

```text
do not pause, do not ask user, keep executing
```

替换为：

```text
auto mode — continue without confirmation only while node and repair-edge budgets remain;
when the circuit breaker trips, stop and report immediately;
do not retry or attempt recovery from the current Claude session
```

## Failure Handling

| 场景 | 行为 |
|---|---|
| session registry 不存在 | allow，零副作用 |
| interactive/completed/stopped flow | allow，零副作用 |
| registry 存在但损坏或 identity/run 无法验证 | 对该 session fail closed |
| context、slot 或 stop marker 无法创建 | 对该 session fail closed |
| slot 文件为空或损坏 | 按已占用处理 |
| wall time、slots 或 repair edge 耗尽 | 写 run-scoped stop marker并停止后续 tool execution |
| hook 脚本缺失 | `install-hooks` 失败；`init --auto` 拒绝启动 |

## 测试设计

### Flow guard

1. PASS 和 interactive transition 不受 repair guard 影响。
2. 首次 exact `FAIL` / `ITERATE` repair transition允许且只在成功后递增 counter。
3. 同一 edge 第二次 repair 在其他 side effect 前创建 stop marker并拒绝。
4. marker 创建失败时 transition fail closed。
5. validation failure、`goto`、`skip`、`pass` 不消耗 repair budget。
6. 不同 repair edge 独立计数。
7. `cmdAdvance` denial 返回 `advanced:false`。
8. 现有三个 graph limits 继续生效。

### Registry and activation

1. 默认 `/opc` 传 `--auto` 和 `${CLAUDE_SESSION_ID}`；`/opc -i` 不传。
2. `init --auto` 在 hook 缺失、session ID 缺失或 registry 写失败时不成功。
3. 同一 session ID 不能同时注册两个 active auto flow。
4. Hook 不使用 `latest`，只读取 session registry 指向的 flow。
5. 无 registry、interactive、completed、stopped 或 cwd 不匹配时 allow。
6. registry/state/identity/run 损坏时只对对应 session fail closed。
7. stopped/completed registry 静默 allow；同 session 的下一次 init 可覆盖旧 registry。
8. Session GC 保留 matching registry 指向的 active auto flow。
9. Session GC 只在持有 registry lock 且精确匹配 session dir 时删除 terminal flow 的 registry。
10. registry lock 或 cleanup 失败时，GC 保留 session dir 并报告 error。

### Hook budget

1. initial node 与首次 re-entry 使用不同 runKey。
2. context 首次创建后 budget 固定。
3. 第 100 次 aggregate call允许，第 101 次写 marker并拒绝。
4. Agent invocation 与所有 child tools 共享 aggregate slots。
5. 100+ parallel invocations 恰好最多 100 个 allow，无 lost update 或超发。
6. absolute wall time 超限写 marker并拒绝。
7. marker 存在后所有后续 tools，包括 Bash，持续拒绝。
8. 新 node/run 使用新 context，旧 marker 不生效。
9. deny JSON schema 和 exit code 符合 Claude Code hook contract。

### Recovery

1. repair-edge denial 返回前 marker 已 durable。
2. 同 session 不能用后续 Bash 调 recovery command。
3. external `goto` / `skip` / `pass` 进入新 run 后 hook恢复允许。
4. external `stop` 后 hook允许。
5. marker 和 slots 不被 recovery 删除。

所有新增 production code 必须 100% coverage；完整 test suite 无失败、无 skipped tests。

## 修改范围

预计涉及：

- `bin/lib/flow-core.mjs`：auto init、session registry、`flowStartedAt`、文案；
- `bin/lib/flow-transition.mjs`：repair-only counter、stop marker、`cmdAdvance` denial；
- `bin/lib/runaway-guard.mjs`：共享 run identity、registry path、budget path 和 atomic stop-marker helper；
- `bin/hooks/opc-pre-tool-budget.mjs`：新增 hook；
- `bin/opc.mjs`：安装 PreToolUse hook、atomic settings write；
- `SKILL.md`：默认 auto invocation、interactive invocation、文案；
- 对应 flow、registry、hook、install、recovery tests。

明确不修改：

- `bin/lib/flow-escape.mjs`；
- `bin/lib/driver-owner.mjs`；
- `bin/opc-harness.mjs` command surface；
- `bin/flow-templates.mjs`；
- evaluator、implementer、synthesize、finding parser 和 extension runtime。

## Acceptance Criteria

1. 默认 `/opc` auto flow 机械启用 guard；interactive flow不受影响。
2. 每条 exact `FAIL` / `ITERATE` repair edge 最多自动成功一次，多阶段 edge 互不影响。
3. 第二次 repair attempt 在其他 transition side effect 前 durable trip 当前 run。
4. 每个 node/run 最多 30 分钟和 100 aggregate tools；parallel calls 不丢计数、不超发。
5. Agent 与 child tools 共享同一个 aggregate budget，无独立 Agent cap。
6. repair、wall-time 或 tool-call guard trip 后，同 session 后续所有 tools均被拒绝。
7. Hook 通过 session registry 精确定位 flow，不依赖 `latest` 或全目录扫描。
8. external terminal 的现有 stop/transition 命令可恢复；不增加 reset、claim 或 authorization subsystem。
9. auto mode 不再包含无条件 `keep executing` 指令。
10. 文档明确本功能是 accidental-runaway circuit breaker，不是 malicious same-UID process 的 security boundary。
11. 所有新增代码 100% test coverage，现有 tests 全部通过且无 skipped tests。
