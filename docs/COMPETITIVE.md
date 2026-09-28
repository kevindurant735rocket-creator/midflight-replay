# 竞品实测（2026-09-28 更新，`gh api` 已认证实测，命令见文末）

> **2026-09-28 更正**：本文 09-27 版本写"天花板约 390★"，同一天用 `gh api` 复核就发现
> 两个 1300★ 级别的项目（`cosmtrek/mindwalk` 1362★、`ThousandBirdsInc/chidori` 1365★），
> 之前那版只搜了名字里带 replay/trace/viewer 的仓库，漏掉了不打这些词的。**天花板不是 390★，
> 是 1300★ 量级**，下面的定位与差异化必须按这个量级重新算。以下全部为实测值。
>
> 结论先行：**"agent 会话回放"这个定位已经有人占了，天花板 1300★ 量级，且最像我们想法的那个项目已经存在。**
> 这份文档的存在意义是让 G2 总监在有证据的前提下决策，而不是凭"这个方向很新"的直觉。

## 1. 直接竞品（8 个，全部实测到 star / 建仓日 / 最后 push / 语言 / 许可）
| ★ | 仓库 | 建仓 | 最后 push | 语言 | 许可 | 它是什么 |
|---|---|---|---|---|---|---|
| **1365** | `ThousandBirdsInc/chidori` | 2026 | **2026-09-24** | Rust/TS | Apache-2.0 | **agent 框架**：每个 LLM/工具/HTTP 调用都记成 host call，可 checkpoint、**零 LLM 调用逐字节重放**、崩溃后续跑。59 fork / 15 open issues |
| **1362** | `cosmtrek/mindwalk` | 2026 | 2026-08-10 | Go | MIT | 把仓库画成 3D 夜图，回放时"光"跟着 agent 走：**看它搜了哪、读了哪、改了哪**。读 Claude/Codex/pi 日志，纯本地，一个 Go 二进制。121 fork / 17 open issues |
| 93 | `TheAceTeam/CC-Flight` | 2026 | 2026-09-04 | — | Apache-2.0 | "Flight recorder for Claude Code, Codex & OpenCode" |
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

## 1b. npm 上的两个直接对手（2026-09-27 实测；这是选型的硬依据）

GitHub 搜竞品会漏掉**只在 npm 发过、GitHub 已删/未建**的那些。我们本来打算用
`midflight`、`agent-replay`、`flightrec` 三个名字，逐个探测的结果推翻了直觉：

| 候选名 | npm 实况 | GitHub 实况 | 月下载 | 判定 |
|---|---|---|---|---|
| `agent-replay` | **v0.1.1 已占**，`mttetc/agent-replay`；描述 = "DevTools for replaying AI agent sessions — browse, inspect, and debug Claude Code and Cursor sessions with a timeline-based UI" | `mttetc/agent-replay` → **404（仓库已删/转私有）** | **9** | 名字被一个**僵尸包**占了，最后发版 2026-02-16 |
| `flightrec` | **v0.9.0 已占**，`busminer/flightrec`；描述 = "A flight recorder for Codex sessions" | `busminer/flightrec` ★**0**，建仓日 = 最后 push 日 = 2026-07-15 | **16** | 一次性上传后**再没动过** |
| `midflight` | **404**（可注册） | 404（可建仓） | **名字合法但没用**：`gh search midflight` 是一堵广告/埋点仓库的墙，且"midflight"一个字不告诉浏览者这是什么 |
| **`midflight-replay`** | **404** | **404** | — | **选中** |

三条可复现的推论（每条都能被上面数字推翻）：

1. **这个品类在 npm 上没有一个活着的在位者。** 最贴脸的两个对手，
   一个仓库已 404、一个 ★0 且当天建当天停更，月下载个位数。
   也就是说：`npm 上没人占住这个位置`，不是"位置被抢了"。
2. **但名字是真的被占了。** `npm publish` 对 `agent-replay` 必然 `EPUBLISHCONFLICT`。
   我们在 2026-09-27 实测撞过这堵墙，所以最终取 `midflight-replay`：
   **repo 名 = npm 包名**（同一条 `gh repo create` / `npm publish` 命令不需要换算），
   **binary 仍叫 `midflight`**（对齐 `@angular/cli` → `ng` 的惯例）。
3. **这条证据反过来加固了 §3 的第 5 条结论。** 之前只有 GitHub 星数说明"分发失败"，
   现在有了分发侧的第二个独立指标：**月下载 9 / 16**。
   榜单上 388★ 的 `cc-sessions-viewer` 是 Rust 桌面应用（不进 npm），
   372★ 的 `claude-code-trace` 同理 —— 它们和我们在**分发渠道上根本不重叠**。
   推论：我们的对手不是那 388★，而是"npm 上一个月只有 9 次下载"这个事实本身。

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

### 复跑 §1b 的 npm 侧取证（2026-09-27）

```bash
# 名字是否被占：200=已占（有版本），404=可注册
for p in agent-replay flightrec midflight midflight-replay; do
  npm view "$p" name version description repository.url 2>&1 | head -5
done

# 最后发版时间（判断对手是否还活着）
npm view agent-replay time.modified        # 2026-02-16  ← 7 个月没动
npm view flightrec   time.modified        # 2026-07-15  ← 建仓当天

# GitHub 侧（注意 agent-replay 的仓库已 404）
gh api repos/mttetc/agent-replay --jq .full_name       # Not Found
gh api repos/busminer/flightrec  --jq '.stargazers_count, .created_at[0:10], .pushed_at[0:10]'

# 月下载量（npm 公开 API，无需 key）
curl -s https://api.npmjs.org/downloads/point/last-month/agent-replay,flightrec
# {"agent-replay":{"downloads":9},"flightrec":{"downloads":16}}
```

**这套探针就是 `docs/RELEASE.md` §2 的重跑脚本**——发布前必须确认
`midflight-replay` 仍是 404，否则 `npm publish` 会当场炸 `EPUBLISHCONFLICT`。
