---
title: "OPC — Your AI Review Team in One Slash Command"
description: "I built a Claude Code skill that dispatches 11 specialist AI agents to review code from different perspectives. Here's what I learned — and an honest comparison with just asking Claude directly."
date: 2026-03-28
draft: false
---

I built [OPC (One Person Company)](https://github.com/iamtouchskyer/opc) — a Claude Code skill that gives you an AI review team. Type `/opc review` and 11 specialists (Security Engineer, PM, New User, DevOps, etc.) review your code in parallel, then a coordinator filters out the noise.

Sounds cool. But is it actually better than just asking Claude to review your code?

## The Honest Test

I ran both approaches on the same codebase — OPC's own repo:

**Single Claude prompt** ("review these files for issues"): **14 findings**. Variable shadowing, DRY violations, missing exit codes, edge cases. Thorough, precise, code-focused.

**OPC** (3 agents: new-user, security, devops): **9 findings**. Fewer code bugs. But it caught 5 things Claude completely missed:

- A new user would run `opc review` in their terminal (not Claude Code) and get confused — no hint it's a skill, not a CLI command
- The install symlink command in README assumes you're in the parent directory — muscle memory says `cd` into the repo first, which breaks it silently
- The postinstall failure message doesn't tell you what a failure looks like
- The Claude Code link goes to a marketing page, not install docs

These aren't code bugs. They're **perspective bugs** — issues you only find when you think like a specific person.

## What I Actually Built

OPC isn't magic. Under the hood it's:

1. **11 markdown files** — each defines a specialist role with expertise areas and anti-patterns ("don't flag missing auth on local tools")
2. **Parallel Claude calls** — 2-5 agents run simultaneously, each with a different system prompt
3. **A coordinator pass** — verifies facts, deduplicates, dismisses false positives

The agents don't talk to each other. There's no "collaboration." The coordinator is the same Claude instance reading all outputs. I'm not going to pretend this is some breakthrough in multi-agent systems.

What it IS: a structured way to get multiple review perspectives without writing the prompt every time. `/opc review` vs. typing "review from security, new user, and devops perspectives" — the former is 10 characters, the latter is a paragraph you'll never write consistently.

## The Parts That Actually Work Well

**Anti-patterns per role.** Each role file says what NOT to flag. The security agent won't flag "no auth" on a local CLI tool. The new-user agent won't suggest hand-holding for a developer tool. This is the single most impactful design choice — it prevents the generic checklist problem that kills most AI review tools.

**Verification gate.** The coordinator doesn't just merge agent outputs. It has explicit checks: "Does this finding have a file:line reference? Does the severity match the actual impact? Did the agent actually read the files in scope?" This catches lazy agent outputs.

**JSON reports.** Every review saves structured JSON to `~/.opc/reports/`. You can track findings over time, compare reviews, or browse them in a web viewer (`npx @touchskyer/opc-viewer`).

## Try It

```bash
npm install -g @touchskyer/opc
# Then in Claude Code:
/opc review
```

Zero dependencies. Just markdown files. Works in 30 seconds.

[GitHub](https://github.com/iamtouchskyer/opc) — star it if you find a bug OPC catches that Claude alone wouldn't.

---

# OPC — 一个斜杠命令召唤你的 AI Review 团队

我做了一个 Claude Code skill 叫 [OPC (One Person Company)](https://github.com/iamtouchskyer/opc)。输入 `/opc review`，11 个 AI 专家（安全工程师、产品经理、新用户、DevOps 等）并行 review 你的代码，然后一个 coordinator 过滤噪音。

听起来不错。但真的比直接问 Claude "帮我 review" 好吗？

## 诚实的对比测试

同一个代码库（OPC 自己的 repo），两种方式：

**直接让 Claude review**：找到了 **14 个问题**。变量 shadowing、DRY 违反、exit code 缺失。细致、精准、聚焦代码层面。

**OPC**（3 个 agent：新用户、安全、DevOps）：找到了 **9 个问题**。代码 bug 更少。但抓到了 5 个 Claude 完全看不到的东西：

- 新用户会在 terminal 里直接跑 `opc review`（以为是 CLI 命令），结果只看到帮助信息，不知道要在 Claude Code 里用
- README 里的 symlink 命令假设你在父目录——但正常人 clone 完会 cd 进去，symlink 就断了
- Claude Code 的链接指向营销页，不是安装文档

这些不是代码 bug，是**视角 bug** — 只有当你切换到某个特定角色的思维时才会发现。

## OPC 到底是什么

说白了：

1. **11 个 markdown 文件** — 每个定义一个专家角色，包括专业领域和 anti-patterns（"不要在本地工具上标记缺少认证"）
2. **并行 Claude 调用** — 2-5 个 agent 同时跑，各有不同 system prompt
3. **Coordinator 验证** — 检查 agent 输出的事实、质疑严重程度、去重、过滤误报

Agent 之间不互相通信。没有真正的"协作"。我不会假装这是什么 multi-agent 突破。

但它解决了一个真实问题：`/opc review` 10 个字符，比每次手写"从安全、新用户、DevOps 角度 review"的 prompt 省事太多。省事 = 会真正用起来。

## 真正有用的设计

**Anti-patterns**：每个角色文件定义了"不要做什么"。安全 agent 不会对本地 CLI 工具标记"缺少认证"。新用户 agent 不会对开发者工具要求"新手引导"。这个设计避免了 AI review 工具最大的问题——generic checklist。

**结构化输出**：每次 review 存 JSON 到 `~/.opc/reports/`，可以用 `npx @touchskyer/opc-viewer` 在浏览器里看。

## 试试

```bash
npm install -g @touchskyer/opc
# 在 Claude Code 里：
/opc review
```

零依赖，30 秒搞定。

[GitHub](https://github.com/iamtouchskyer/opc)
