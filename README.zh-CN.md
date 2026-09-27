<h1 align="center">midflight</h1>

<p align="center">
  <b>把一条已经结束的 AI 编码 agent 会话，变成一个能拖动、能贴进 PR 评论、且不碰你工作区的单文件。</b>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#两种输出">两种输出</a> ·
  <a href="#诚实的覆盖度">诚实的覆盖度</a> ·
  <a href="#隐私">隐私</a> ·
  <a href="#为什么不是另外八个工具">竞品定位</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/images/replay-codex-109mb.png" alt="midflight 回放一条 109MB 的真实 Codex 会话" width="880">
</p>

---

## 问题在哪

你的 agent 在 90 分钟里改了 40 个文件、写了 1400 行。PR 开了。评审的人看不到：

- 第 12→19 步是同一个失败的 `pytest` 调用，重复了 7 次
- agent 花掉 24 万 token 重新读了一遍它早就读过的文件
- 第 900 步发生了上下文压缩，之后它的推理方式变了

于是评审只能像陌生人一样看 diff，评论一句"这个怎么测"，然后翻篇。你为了解释，
重跑一次 agent，于是得到一个**新**会话 —— 和当初写出这份代码的那个已经不是同一条了。

**midflight 回放的是真正写出那份代码的那条会话。** 不是摘要，不是报告 ——
是一条可以来回拖动的时间轴，带真实的 diff、真实的上下文用量，以及一句诚实的
话：这个会话到底有多少比例能重建。

一条命令：

```bash
npx midflight replay ~/.codex/sessions/2026/09/27/rollout-....jsonl --out replay.html
```

`replay.html` 是单个自包含文件。不用起服务、不用 CDN、不用构建、不发任何网络请求 ——
从 `file://` 打开能用，贴成 PR 附件能用，断网笔记本能用，2030 年还能用。

零依赖、零构建、零网络请求、零遥测。

---

## 安装

需要 **Node 20+**，别的都不要。

```bash
npx midflight replay <session.jsonl> --out replay.html
```

或者装到全局：

```bash
npm i -g midflight
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
npx midflight replay "$(ls -t ~/.codex/sessions/2026/09/27/*.jsonl | head -1)" --out replay.html

# 最新的 Claude Code 会话
npx midflight replay "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" --out replay.html
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

实测（真实数据）：109MB 会话里保留 14,905 步中的 3,716 步，输出 3.2MB，
每步 scrub 延迟 <100ms。

### 2. `--paste` —— GitHub 安全块

```bash
npx midflight replay session.jsonl --paste > digest.html
```

≤60KB，只含 `details / summary / table / pre / code / div`。零 `<script>`、
零 `<style>`、零 `on*=` 内联事件、零外部引用 —— 这些由测试机检断言，不是口头承诺。
它按设计就是无 CSS 的：即使宿主把所有 style 属性剥光，仍然可读。

它是一份事后解剖摘要，**不假装**自己是可交互回放。放不下的时候按优先级倒序丢段，
并且**明说丢了多少**。

---

## 诚实的覆盖度

这是整个项目最重要的一个设计决定。

会话日志不一定包含足够信息来重建磁盘上发生的事。Codex 只写 `cmd` 和 `path` 参数 ——
在实测的那条会话里，3,684 次 function_call 中 `old_string` / `patch` 出现次数为**零**。
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
| Codex rollout | 109 MB | 378 ms | 3.24 MB | 3,716 / 14,905 | `diff-only`（识别出 1,720 处 shell 改动） |
| Claude Code | 32 MB | 115 ms | 2.05 MB | 3,000 / 3,622 | `partial` —— 244 次编辑，127 次有 before-image，205 处 shell 改动 |

那个 109MB 的文件峰值 RSS 253MB。解析是逐行流式的，从不整文件读进内存。

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
