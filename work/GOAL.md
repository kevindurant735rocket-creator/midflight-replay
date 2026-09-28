# GOAL — 对话目标（唯一方向锚）

- 需求: 把已发布的 midflight-replay 推到真实有人用的高星项目，npm 上线 + 冲星资产齐 + 屏幕输出全部人话化
- 目标: 把 midflight-replay 从『仓库已发布但 0 star、npm 未上线』推到『真实用户装得上、用得懂、愿意 star』：1) npm registry 可 npm view 到 0.1.2 且 tarball 装完能跑 replay/doctor；2) README 首屏 5 秒内看懂，无死链死徽章；3) 60 秒 demo 在干净机一条命令复现；4) 所有屏幕输出(--help/doctor/postmortem/revert/install/agents)人话化、零 AI 腔、零 stack trace 泄漏；5) 每轮三闸门 FAST-GATE-OK/DEAI-OK/BLOAT-OK；6) 195+ 测试、typecheck、link-check、claims 全绿；7) 竞品差异化首屏可读。判据全部为命令退出码，不接受未验证宣称。
- 轮次计划: R1..R5（每轮必须走 gigafactory 账 + 部门子智能体）
- 成功判据: AC1 npm view midflight-replay version = 0.1.2；AC2 README 首屏零死链零死徽章(机器可检)；AC3 demo-60s.sh 在干净目录一条命令 rc=0；AC4 全部 CLI 子命令输出人话化、负路径不吐 stack trace；AC5 每轮三闸门 rc=0 三 OK；AC6 测试+typecheck+link+claims 全 rc=0；AC7 star 数为真实分发结果不造假
- 非目标: 不做 docker/服务端/多用户后端；不引入任何运行时依赖；不改包名 midflight-replay 与二进制名 midflight 的分工；不自造 star/下载量数字；不改测试来迎合实现
- 对话目标 id: （未绑定：调 create_goal 后 bind-goal）

## CREATE_GOAL_ARG

```
把 midflight-replay 从『仓库已发布但 0 star、npm 未上线』推到『真实用户装得上、用得懂、愿意 star』：1) npm registry 可 npm view 到 0.1.2 且 tarball 装完能跑 replay/doctor；2) README 首屏 5 秒内看懂，无死链死徽章；3) 60 秒 demo 在干净机一条命令复现；4) 所有屏幕输出(--help/doctor/postmortem/revert/install/agents)人话化、零 AI 腔、零 stack trace 泄漏；5) 每轮三闸门 FAST-GATE-OK/DEAI-OK/BLOAT-OK；6) 195+ 测试、typecheck、link-check、claims 全绿；7) 竞品差异化首屏可读。判据全部为命令退出码，不接受未验证宣称。
```
