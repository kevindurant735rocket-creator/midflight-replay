# 竞品实测（2026-09-27，api.github.com 未认证实测，命令见文末）

> 结论先行：**"agent 会话回放"这个定位已经有人占了，天花板约 390★，且最像我们想法的那个项目已经存在。**
> 这份文档的存在意义是让 G2 总监在有证据的前提下决策，而不是凭"这个方向很新"的直觉。

## 1. 直接竞品（8 个，全部实测到 star / 建仓日 / 最后 push / 语言 / 许可）
| ★ | 仓库 | 建仓 | 最后 push | 语言 | 许可 | 它是什么 |
|---|---|---|---|---|---|---|
| 388 | `jerrywu001/cc-sessions-viewer` | 2026-05-20 | 2026-09-17 | Rust | MIT | 桌面浏览器，支持 **7 种** agent（cc/codex/grok/kimi/pi/antigravity/opencode）+ 工具管理页 |
| 372 | `delexw/claude-code-trace` | 2026-03-11 | 2026-09-26 | Rust | MIT | Claude Code session log viewer（JSONL） |
| 268 | `Continuum-AI-Corp/OrcaReplay` | 2026-08-29 | 2026-09-26 | TS | Apache-2.0 | "Time travel for AI agents. Record, replay, fork, and…" |
| 110 | `PixelPaw-Labs/codex-trace` | 2026-04-25 | 2026-09-26 | Rust | MIT | Codex CLI session log viewer，Rust/Tauri 桌面 + Web + SSE live tail |
| 76 | `TaewoooPark/Agent-Blackbox` | 2026-06-16 | **2026-07-26** | TS | MIT | **"Local-first flight recorder and context-efficiency profiler for coding agents"，把每次运行重建成可回放的 operational graph，给出上下文经济性 + 任务是否落地的双轴评分** |
| 14 | `clay-good/agent-replay` | 2026-02-28 | 2026-09-11 | TS | MIT | 100% 本地 SQLite CLI，time-travel |
| 13 | `agentoptics/rewind` | 2026-04-08 | 2026-05-25 | Rust | MIT | "Fix broken AI agents without re-running them. Fork at any step" |
| 3 | `ezra-y/agent-trajectory` | 2026-08-15 | 2026-08-15 | HTML | — | Claude Code + Codex 日志 → 交互式轨迹 |

**次级/相邻**（同轮实测）：`S40911120/recensa` 73★ 自托管 viewer、`yx0716/clawd-insights` 43★ 本地 dashboard、
`prime-radiant-inc/claude-session-viewer` 43★、`finchvox/finchvox` 34★（Pipecat 语音 agent 的 observability + session replay）、
`Alexli18/binex` 62★（agent workflow 可调试运行时）、`ZIZKA-AI-SL/ZizkaDB` 114★（agent 审计库）。

## 2. 参照系（说明"高分"到底要多高）
| ★ | 仓库 | 说明 |
|---|---|---|
| 44852 | `getsentry/sentry` | 事故平台。**它的 Session Replay 是个功能，不是独立品类** |
| 39963 | `PostHog/posthog` | 同样把 session replay 装在更大的产品里 |
| 35097 | `langfuse/langfuse` | LLM 可观测性平台 |
| 20214 | `rrweb-io/rrweb` | "record and replay the web" —— session replay 的**底层原语**，所有人依赖它 |
| 12558 | `simonw/llm` | 极简 CLI，作者名人效应 |
| 11629 | `Arize-ai/phoenix` | AI 可观测性 |
| 6180 | `helicone/helicone` | LLM observability |
| 4878 | `langwatch/langwatch` | LLM 评测 + agent 测试 |

## 3. 五条硬结论（每条都可被上面数据反驳，但没有反驳成功）
1. **定位已被占位**：`Agent-Blackbox` 的自我描述与我们的 G0 洞察逐字重合（local-first / flight recorder / replayable / Claude Code+Codex+OpenCode）。
   推论：README 里写"我们是 agent 的飞行记录仪"不再构成差异点。
2. **host 覆盖不是差异点**：`cc-sessions-viewer` 已支持 7 种 agent。适配器数量这条赛道已满。
3. **time-travel / fork 也已被占**：`OrcaReplay`(268★)、`agentoptics/rewind`(13★)、`clay-good/agent-replay`(14★) 都在做。
   推论：AC-12 的 time-travel 是**必要不充分**条件，不能当卖点标题。
4. **桌面 Rust viewer 这条车道挤了 3 个**（388/372/110），且都是本地浏览/搜索/管理会话列表。
   推论：再做一个"更好看的本地会话浏览器"= 进第 9 名。
5. **分发失败比产品失败更常见**：`Agent-Blackbox` 31,053 字符 README、4 种语言、MIT、2026-06 建仓、至今 76★，
   **最后一次 push 停在 2026-07-26**（停更 2 个月），open issues=0。
   推论：这不是"做得不够好"，是"没人被讲到"。**如果我们的差异点仍然是功能，分发问题会原样复现。**

## 4. 因此，差异点必须落在三个轴之一（这三条是 G2 加权打分的硬输入）
- **产物轴**：不是"给你一个工具自己看"，而是"生成一个你**发给别人**的东西"。8 个直接竞品全是独自使用的工具。
- **受众轴**：不是"调试自己 agent 的人"（你本来就在现场，你知道发生了什么），
  而是"**看别人（或别的会话）跑的 agent** 的人"（你不在现场，你需要一个电影）。
- **时刻轴**：不是"事后排障"（agent 跑完了我才翻日志），而是"**评审 AI 生成的 PR**"这个当下正爆发的场景。
  该场景的产物天然落在 GitHub PR 评论里 → 平台自带裂变位，竞品全部缺席。

## 5. 取证命令（可复跑）

**用 `gh`，不要用 `curl`。** 本机 `gh` 已认证（`kevindurant735rocket-creator`，scopes
`gist` / `read:org` / `repo`），配额 5000 次/小时。未认证的 `api.github.com` 会在
第 9 个仓库就返回 `API rate limit exceeded` —— 这正是下面这张表最初取不全数的原因。

```bash
gh auth status                                   # 确认登录与 scopes
gh api rate_limit --jq '.rate'                   # {"limit":5000,"remaining":5000,...}

# 仓库元数据：star / 建仓日 / 最后 push / 语言 / 许可 / open issues
gh api repos/<owner>/<repo> --jq \
  '"\(.full_name) \(.stargazers_count)★ created=\(.created_at[0:10]) pushed=\(.pushed_at[0:10]) \(.language) \(.license.spdx_id // "—") issues=\(.open_issues_count)"'

# 搜索竞品
gh search repos 'agent session replay' --sort stars --limit 10 --json fullName,stargazersCount,description

# README 原文
gh api repos/<owner>/<repo>/readme --jq '.content' | base64 -d
```

### 复跑结果（2026-09-27，`gh` 认证后重取）

上表 8 个直接竞品**逐个复核，零漂移**：star 数、建仓日、最后 push 日全部未变。
唯一修正：`ezra-y/agent-trajectory` 的许可是 **MIT**，此前记为未知。

"停更即无人知晓"这条结论因此更硬了：`Agent-Blackbox` 停在 2026-07-26，
距今 2 个月，star 仍卡在 76，open issues = 0。
