<h1 align="center">midflight</h1>

<p align="center">
  <b>把一条已经结束的 AI 编码 agent 会话，变成一个能拖动、能贴进 PR 评论、且不碰你工作区的单文件。</b>
</p>

<p align="center">
  <a href="https://github.com/kevindurant735rocket-creator/midflight-replay/actions/workflows/ci.yml"><img src="https://github.com/kevindurant735rocket-creator/midflight-replay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/kevindurant735rocket-creator/midflight-replay/actions/workflows/self-replay.yml"><img src="https://github.com/kevindurant735rocket-creator/midflight-replay/actions/workflows/self-replay.yml/badge.svg" alt="self-replay"></a>
  <a href="https://www.npmjs.com/package/midflight-replay"><img src="https://img.shields.io/npm/v/midflight-replay.svg" alt="npm version"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/node-%3E%3D20-5FA04E" alt="node >= 20"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <a href="#看它动起来">16s 回放</a> ·
  <a href="#安装">安装</a> ·
  <a href="#两种输出">两种输出</a> ·
  <a href="#放到-pr-上">action</a> ·
  <a href="#诚实的覆盖度">诚实的覆盖度</a> ·
  <a href="#隐私">隐私</a> ·
  <a href="#为什么不是另外八个工具">竞品定位</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/images/replay-codex-109mb.png" alt="midflight 回放一条 109 MiB 的真实 Codex 会话" width="880">
</p>

---

## 看它动起来

本机一条真实 Claude Code 会话——**原始 JSONL 31 MiB，解析出 3,111 步，10 次第一手压缩事件**——压进 16 秒回放。不是 mock 数据，也不是手写 demo 素材：视频里的文件就是 `midflight replay` 对着一条真实会话日志跑出来的。

<p align="center">
  <img src="docs/demo/demo.webm" alt="32MB Claude Code 会话 16 秒回放：时间轴拖动、上下文锯齿、before-image diff" width="880" controls loop>
</p>

<p align="center">
  <a href="docs/demo/poster.png"><img src="docs/demo/poster.png" alt="midflight 回放海报帧" width="880"></a>
</p>

画面里的每个数字都可复现：

- 左侧主轴是 **3,111 步里显示的 3,000 步**；抽稀横幅直接写明，不假装文件是完整的
- 绿色面积是**上下文锯齿**：每轮对话往上爬，宿主压缩时掉下来。其中 10 次标了 `⇣ 第一手压缩事件`
- 右侧是一次真实 `Edit` 的 **before-image**，能看到 agent 实际打进去的补丁，带行号
- 覆盖度条显示 **52%**：那条会话 244 处编辑里只有 127 处带 before-image，其余只能看到 agent 自述

自己复现：

```bash
midflight replay ~/.claude/projects/-Users-zhangfengrui/<session>.jsonl --out replay.html
open replay.html
```

`docs/demo/` 由 `node scripts/record-demo.mjs <report.html> --out docs/demo` 重新生成。

## 问题在哪

这是本机一条真实会话，用 `midflight doctor` 量出来的，没有四舍五入、没有示意图：

| | |
|---|---|
| 日志体积 | **109 MiB** |
| 步数 | **14,905** |
| 工具调用 | **3,689** |
| 其中改动文件 | **1,720** 次 —— 全部由 shell 命令承载 |
| 记录了改前内容的 | **0** 次 |
| 上下文压缩 | **22** 次 |

也就是说：日志知道这 1,720 个文件被改过、也知道是哪条命令改的，却不知道任何一个文件
改之前长什么样。上下文被压缩了 22 次，日志记下了"发生过"，但没记下"什么活了下来"。

从这次会话里产出的代码，现在只剩一个 diff。而产生这个 diff 的 109 MiB 推理过程，
没有哪个 PR 评审人会去打开。于是他们像陌生人一样读 diff，评论一句"这个怎么测"，翻篇。
想解释？重跑一次 agent —— 得到的是一个**新**会话，和当初写出代码的那条已经不是同一条。

**midflight 回放的是真正写出那份代码的那条会话。** 不是摘要，不是报告 ——
是一条可以来回拖动的时间轴，带真实的 diff、真实的上下文用量，以及一句诚实的
话：这个会话到底有多少比例能重建。

一条命令：

```bash
npx midflight-replay replay ~/.codex/sessions/2026/09/27/rollout-....jsonl --out replay.html
```

`replay.html` 是单个自包含文件。不用起服务、不用 CDN、不用构建、不发任何网络请求 ——
从 `file://` 打开能用，贴成 PR 附件能用，断网笔记本能用，2030 年还能用。

零依赖、零构建、零网络请求、零遥测。

---

## 安装

需要 **Node 20+**，别的都不要。

```bash
npx midflight-replay replay <session.jsonl> --out replay.html
```

或者装到全局 —— 注意二进制命令叫 `midflight`，就像 `@angular/cli` 装出来的是 `ng`：

```bash
npm i -g midflight-replay
midflight doctor <session.jsonl>
```

工具本身不需要 `npm install` —— 运行时依赖是 0 个。仓库里的 devDependencies 只用于
编译和测试源码。

---

## 我的会话日志在哪

midflight 读的是 agent 本来就在写的 JSONL。它不要求你打开任何开关，也**不碰你的工作区**。

| Agent | 默认位置 | 文件 |
|---|---|---|
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-*.jsonl` |
| Claude Code | `~/.claude/projects/<转义后的工作目录>/` | `<session-uuid>.jsonl` |

```bash
# 最新的 Codex 会话
npx midflight-replay replay "$(ls -t ~/.codex/sessions/2026/09/27/*.jsonl | head -1)" --out replay.html

# 最新的 Claude Code 会话
npx midflight-replay replay "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" --out replay.html
```

格式靠第一条完整记录**结构上**识别，不看文件名、不看目录名。两种都不认的话，
会带行号报错退出。

---

## 两种输出

GitHub 会把粘进评论里的 `<script>` 和 `<style>` 全部剥掉。所有 HTML 导出器都死在这。
所以 midflight 有两种形态，你选：

### 1. `--out replay.html` —— 交互件

完整体验，单文件全内联。

- **主轴** —— 会话时间轴，每步一根条，按类型着色
- **副轴** —— 堆叠的上下文构成（消息 / 推理 / 工具调用 / 工具输出）。点色块或图例，
  直接跳到第一个含该类别的步
- **播放器** —— 可拖动；`空格` 播放/暂停，`←/→` 或 `j/k` 单步，
  `PageUp/PageDown` 跳 20 步，`Home/End` 首尾。也可直接点
- **单步详情** —— payload、token 用量；编辑步给**带行号的 unified diff**
- **压缩标记** —— 上下文在哪里被 compact，画在轴上
- **诚实覆盖条** —— 见下

实测（真实数据）：109 MiB 会话里保留 14,905 步中的 4,016 步，输出 3.38MB，
每步 scrub 延迟 <100ms。

### 2. `--paste` —— GitHub 安全块

```bash
npx midflight-replay replay session.jsonl --paste > digest.html
```

≤60KB，只含 `details / summary / table / pre / code / div`。零 `<script>`、
零 `<style>`、零 `on*=` 内联事件、零外部引用 —— 这些由测试机检断言，不是口头承诺。
它按设计就是无 CSS 的：即使宿主把所有 style 属性剥光，仍然可读。

它是一份事后解剖摘要，**不假装**自己是可交互回放。放不下的时候按优先级倒序丢段，
并且**明说丢了多少**。

---

## 放到 PR 上

大部分审阅者不会去找一个 CLI。action 把摘要放到他们本来就在的地方。

```yaml
# .github/workflows/agent-audit.yml
name: agent audit
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kevindurant735rocket-creator/midflight-replay@v0.1.0
        with:
          session: auto              # .agent-sessions/ 下最新的 .jsonl
          # session: logs/last-run.jsonl
```

它读仓库里已提交的会话日志，生成可直接粘贴的摘要，在 PR 上留 **一条** 评论 ——
原地更新、不堆叠，所以 40 个 commit 的 PR 不会攒出 40 份一模一样的摘要。
完整的可交互回放仍然由你自己手动附上；action 只发读得懂的那一半。

**它做不到什么：** CI runner 从来没跑过 Codex 或 Claude Code，所以除非你把日志
提交进仓库，否则它没有会话可读。把 `session:` 指向仓库里的文件，或者用 `dir:`
指到你自己的日志目录。

**它花多少：** 一次 `npm ci` 加一次 `tsc`，项目零运行时依赖。本机真实的
109 MiB（114,325,714 字节）/ 30,736 行 / 14,905 步 Codex 会话解析耗时 **< 500ms**，产出 9,381 字节摘要。

这个仓库在自己的 PR 上跑这个 action ——
见 [`.github/workflows/self-replay.yml`](.github/workflows/self-replay.yml)。

---

## 诚实的覆盖度

这是整个项目最重要的一个设计决定。

会话日志不一定包含足够信息来重建磁盘上发生的事。Codex 只写 `cmd` 和 `path` 参数 ——
在实测的那条会话里，3,689 次 tool_call、30,736 行日志中，`old_string` / `patch` 出现次数为**零**。
Claude Code 的 `Edit` 带 `old_string` + `new_string`，`Write` 带完整 `content`。

所以诚实的答案因 agent 而异。midflight 把它印出来，而不是给你看一个空 diff 却什么都不说：

| 判定 | 含义 |
|---|---|
| `full` 全可逆放 | 每个编辑步都有 before-image，会话可重建 |
| `partial` 部分可逆放 | 部分编辑步有 before-image，覆盖条显示比例 |
| `diff-only` 仅 diff | 日志记了"写过这个文件"，但没记之前的内容 |
| `no-edits` 无编辑 | 这条会话根本没改文件 |

实测数据，不是推测：

| 会话 | 大小 | 解析 | 输出 | 步数 | 覆盖判定 |
|---|---|---|---|---|---|
| Codex rollout | 109 MiB | ~0.4 s | 3.38 MiB | 4,016 / 14,905 | `diff-only` —— 1,720 处 shell 改动，0 处 before-image |
| Claude Code | 31 MiB | ~0.13 s | 2.19 MiB | 3,000 / 3,111 | `partial` —— 244 次编辑，127 次带 before-image |

第二条诚实规则：适配器无法分类的步会被**标注、计数并渲染**，绝不静默丢弃。Claude Code 会写入
会话元数据记录（`file-history-snapshot` / `ai-title` / `permission-mode` 等），它们不承载
agent 动作 —— 所以 midflight 现在**认得出**它们，而不是丢进一个桶里：`ai-title` 与
`agent-name` 直接变成会话标题，`file-history-delta` 归为 chrome，`compact_boundary`
变成一等的压缩事件。最后这条以前是个沉默的谎报：上面那条 32MB 会话里有 **10** 个
`compact_boundary`，早期版本把它们当 chrome 吞掉，于是报告写「未观测到压缩事件」。

现在那条会话的 `unknownCount: 0`，全部 3,111 步分布是：1,040 工具调用、1,040 工具输出、
424 assistant、415 reasoning、121 user、61 note、10 次压缩。**故意不读**的部分写在
[`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md) —— 包括为什么不解码 `~/.claude/file-history`，
以及证明这件事的命令。接下来做什么、明确不做什么，排序在
[`docs/BACKLOG.md`](docs/BACKLOG.md)。

两行都可以自己复现：

```bash
npx midflight-replay doctor <session.jsonl> --json   # steps / byKind / parseErrors / unknownSteps
/usr/bin/time -l npx midflight-replay replay <session.jsonl> --out /tmp/r.html --json  # RSS
```

那个 109 MiB 的文件峰值 RSS **273MB**（`286,736,384` 字节）。解析是逐行流式的，从不整文件读进内存。

---

## 隐私

**midflight 不写你的工作区、不读你的 git 历史、不发任何网络请求。** 一次都没有，
任何代码路径都没有。生成的报告有浏览器验收断言：零外部请求。

脱敏**默认开启**，在任何东西进入报告之前就跑完：

- OpenAI / Anthropic key、GitHub PAT、Slack token、AWS key、Google API key
- PEM 私钥块、`Bearer` 头、JWT
- `api_key` / `secret` / `password` / `token = ...` 赋值
- 邮箱地址
- 你的家目录 → `/HOME`，`/Users/<你>` → `/Users/USER`

如果你是故意在调试某个密钥，用 `--no-redact` 关掉。没有任何东西被上传，所以
"被上传"不构成失败模式。报告里只显示**哪条规则命中了几次**，永远不显示值。

---

## 命令

```
midflight replay <session.jsonl> [options]   生成自包含回放
midflight doctor <session.jsonl> [--json]    解析并体检；输入有问题时 exit 1
midflight stats  <session.jsonl> [--json]    解析并打印步数统计
midflight redact                            对 stdin 跑脱敏
midflight --version                          打印已安装的版本
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `--out <file>` | stdout | HTML 写到这里 |
| `--paste` | 关 | 改输出 GitHub 安全块 |
| `--max-steps <n>` | 3000 | 工具调用和压缩事件**永不丢弃** |
| `--per-step-chars <n>` | 1200 | 每步 payload 上限 |
| `--no-redact` | 关 | 关脱敏 |
| `--json` | 关 | 机器可读摘要走 stderr |

文件可疑的时候跑 `doctor`。它会报出**第一条坏记录的行号**，并以非零码退出。
可以放进 CI。

---

## 为什么不是另外八个工具

现在已经有八个项目在做"agent 会话回放"（实测星标：388 / 372 / 268 / 110 / 76 /
14 / 13 / 3）。把八个都看过一遍之后，三条结论：

1. **会话回放是功能，不是品类。** Sentry 和 PostHog 都把它当更大产品里的一个功能。
   底层原语 `rrweb` 有 2 万星。独立 viewer 是在抢边角料。
2. **"本地优先飞行记录仪"这个说法已经有人占了。** 有一个项目自己的描述和这句话
   几乎逐字重合 —— 76 星、四种语言、31,000 字符的 README、MIT 许可，
   停更两个月，开源 issue 数为零。这不是产品失败，是分发失败。
3. **八个全是"你自己一个人用"的工具。** 没有一个的产物是为"发出去"设计的。

midflight 押的是第三条。产物是一个**发给不在场的人**的文件。场景是评审 AI 生成的 PR
—— 此刻正在大规模发生 —— 而且这个场景自带一个裂变位，那八个都没有：PR 评论。

逐仓库的实测数据和可复跑的取证命令：[docs/COMPETITIVE.md](docs/COMPETITIVE.md)。

---

## 路线图

刻意做小。已发货 7 项，接下来的两项背后都有实测证据支撑。

- [x] Codex + Claude Code 适配器，自动识别
- [x] 双轴时间轴 + 可点击的上下文构成
- [x] 编辑步的 unified diff，带行号
- [x] 双输出：交互 HTML + GitHub 安全块
- [x] 每份报告都带诚实覆盖判定
- [x] 默认脱敏、零网络
- [x] `doctor` 行级失败定位
- [ ] **事后解剖检测** —— 标出循环、反复改同一处、上下文将满
- [ ] **补丁集导出** —— 重建第 N 步的文件状态，可 `git apply -R`
- [ ] 更多适配器，等真实日志里出现再加

**刻意不做**：服务端、账号、数据库、托管看板、重跑/分叉。每一个都需要一次网络调用，
而"不发网络请求"正是这个项目存在的理由。

---

## 开发

```bash
npm install          # 只有 devDeps：typescript、vitest、playwright
npm run build        # tsc -> dist/
npm test             # 39 个单测
node scripts/browser-check.mjs out.html out2.html   # 60 条浏览器断言
```

浏览器验收是单独一条命令，这是故意的：它要下载 Chromium，CI 不该每次提交都付这个成本。

两种 agent 格式的内部结构见 [docs/FORMATS.md](docs/FORMATS.md)。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。一句话版本：零依赖和零网络不是偏好，是产品本身 ——
加了运行时依赖的 PR 不会合。

## 许可

MIT
