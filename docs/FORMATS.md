# 会话格式实测契约（DATA 部实测，2026-09-27）

> 本文件是**适配器的唯一真源**。所有字段名从本机真实数据逐行统计得出，不是文档抄的。
> 取数命令见文末"取证方式"。适配器实现与测试都必须以本文件为准；格式变了先改本文件再改代码。

## 1. Codex rollout JSONL

- 位置：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>[_<uuid>].jsonl`
- 本机实测：**580 个文件，单文件 8KB ~ 109 MiB**（最大 `2026/09/23/rollout-2026-09-23T16-24-08-…jsonl` = 114,325,714 B）
- 结构：**JSON Lines**。每行顶层恒为 `{timestamp, ordinal, type, payload}`，无例外。

### 行类型全表（实测 10 种）
| 顶层 type | payload.type | 关键字段 | 适配器用途 |
|---|---|---|---|
| `session_meta` | — | `session_id, id, timestamp, cwd, originator, source, thread_source, cli_version, model_provider, history_mode, git{}, context_window{}, base_instructions{}` | 会话头：cwd / 版本 / git 分支 / 上下文窗口 |
| `turn_context` | — | `turn_id, cwd, workspace_roots[], current_date, timezone, approval_policy, approvals_reviewer, sandbox_policy, permission_profile, collaboration_mode{}, model, effort, personality, realtime_active, multi_agent_version, comp_hash, summary` | 每个 turn 的模型/effort/审批策略 → 时间轴分段 |
| `world_state` | — | `full: bool, state: {}` | 全量世界状态快照（P1 time-travel 依赖，需先探明 state 结构） |
| `response_item` | `message` | `role, content[]` | 用户/助手正文 |
| `response_item` | `reasoning` | `content[], summary[], encrypted_content` | 推理摘要（`encrypted_content` 不可解，只显示 `summary`） |
| `response_item` | `function_call` | `name, arguments(JSON字符串), call_id, id` | **工具调用**：名字+参数+call_id |
| `response_item` | `function_call_output` | `call_id, output` | **工具输出**（`output` 是字符串，可能极大） |
| `event_msg` | `task_started` | `turn_id, started_at, model_context_window, collaboration_mode_kind` | turn 起点 |
| `event_msg` | `token_count` | `info{total_token_usage{input,cached_input,output,reasoning_output,total}, last_token_usage{同上}, model_context_window}, rate_limits{...}` | **token 增量 + 上下文占用**（增量=last，总量=total） |
| `token_usage_record` (顶层) | — | `turn_id, response_id, usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens}, turn_token_usage, thread_token_usage` | **每次 API 响应的精确用量**（`event_msg/token_count` 的上游；同一响应两条流会重复，靠 2s 窗口去重） |
| `compacted` (顶层) | — | `message` | **真实压缩事件**（第一手证据，非靠 token 下降推断） |
| `response_item` | `web_search_call` | `id, status, action{type,query,queries}` | 联网检索，按 `tool_call` 处理 |
| `event_msg` | `turn_aborted` | `turn_id, reason, started_at, completed_at, duration_ms` | turn 中断（`reason=interrupted`） |
| `event_msg` | `thread_settings_applied` | `thread_id, thread_settings{model,reasoning_effort,cwd,...}` | 线程设置；**仅在 model/effort 变化时**产出 note，否则静默 |
| `event_msg` | `item_completed` / `task_complete` | `item{}, completed_at_ms, duration_ms, time_to_first_token_ms, last_agent_message` | 步骤时长 / 首 token 延迟 |

### 已验证的关键事实
- `function_call` 与 `function_call_output` 通过 **`call_id` 配对**（实测 `fc_call_<hex>` 与 `call_<hex>` 前缀不同但 `call_id` 字段可配对）。
- `token_count` 只在部分行出现，**必须按 `last_token_usage` 差分**，不能假设每步都有。
- **token 键名是 `*_tokens` 后缀，不是 `input/cached_input`**（文档早期版本写错，会让解析器静默返回 0）——
  实测键：`input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens`。
- `session_meta.context_window` 真实值是 `{"window_id":"..."}`，**不是数字、不含 `.effective`**；上下文容量取 `turn_context.model_context_window` 或 `event_msg/token_count.info.model_context_window`。
- `model_context_window` 实测值 `2432000`（与 AGENTS.md 记载的硬截断线 243200 一致，注意这是该会话当时快照，**不要硬编码**）。
- `base_instructions.text` 是系统提示词全文 → **体积大头**，报告里必须默认折叠。
- `function_call.name` 实测出现过 `exec_command`；参数是 `arguments` 里的 **JSON 字符串**（需二次 parse，失败要降级为原文）。

## 2. Claude Code JSONL

- 位置：`~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl`
- 本机实测：**172 个文件，927 B ~ 32,639,599 B**
- 结构：JSON Lines，**无 `timestamp/ordinal/type.payload` 包裹层**，行本身就是对象（这与 Codex 是两种形状，适配器必须分治）。

### 行类型全表（实测）
`assistant` / `user` / `system` / `mode` / `permission-mode` / `last-prompt` / `atis-latch` / `queue-operation` / `attachment` / `cost-state` / `file-history-snapshot`

### 消息体约定（实测）
- `assistant.message.content[]` 块类型：`text` / `tool_use` / `redacted_thinking`
- `user.message.content[]` 块类型：`tool_result` / `text`
- 其它顶层字段实测：`sessionId, uuid, parentUuid, isSidechain, timestamp, cwd, version, requestId`
- **`file-history-snapshot`**：Claude Code 自带的文件历史快照 → P1 time-travel 的现成数据源（Codex 侧没有等价物）
- **`cost-state`**：自带成本状态 → 成本展示的现成数据源

## 3. 适配器必须满足的通用契约（两种格式归一到这里）
```ts
type ReplayStep =
  | { kind:'user';        ts:number; text:string }
  | { kind:'assistant';   ts:number; text:string }
  | { kind:'reasoning';   ts:number; summary:string }
  | { kind:'tool_call';   ts:number; callId:string; name:string; args:unknown; rawArgs:string }
  | { kind:'tool_output'; ts:number; callId:string; output:string; truncated:boolean }
  | { kind:'turn_start';  ts:number; turnId:string; model?:string; contextWindow?:number }
  | { kind:'turn_end';    ts:number; turnId:string; durationMs?:number; ttftMs?:number }
  | { kind:'usage';       ts:number; input:number; cachedInput:number; output:number; reasoning:number; contextWindow?:number }
  | { kind:'file_event';  ts:number; path:string; op:'create'|'modify'|'delete'; tool:string; text?:string }  // P1
  | { kind:'unknown';     ts:number; raw:string; sourceLine:number }   // 未知事件必须透传，不许丢
```
硬性要求：
1. **未知事件不许吞掉**，落成 `unknown` 并带原文行号 → 这是 R1（格式漂移）的主要防线。
2. 坏行不许让整个文件解析失败：记录 `{line, error}` 进 `parseErrors[]`，`afr doctor` 据此给退出码。
3. 解析必须是**流式**的（按行读，不整文件载入），否则 109 MiB 文件会打爆内存。
4. 时间戳缺失/非法时用上一条合法时间戳兜底，并在 `warnings[]` 记一笔。

## 4. 取证方式（可复跑）
```bash
# Codex 行类型分布
python3 -c "import json,sys;from collections import Counter;c=Counter()
[json.loads(l) for l in open(sys.argv[1])]" <rollout.jsonl>
# Claude Code 顶层类型分布 + content 块类型
python3 - <<'PY'
import json,glob,os
from collections import Counter
c=Counter()
for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True):
    for l in open(f,errors='replace'):
        try:o=json.loads(l)
        except:continue
        c[o.get('type')]+=1
        m=o.get('message')
        if isinstance(m,dict):
            for b in (m.get('content') or []):
                if isinstance(b,dict): c['block/'+str(b.get('type'))]+=1
print(c.most_common(20))
PY
```
