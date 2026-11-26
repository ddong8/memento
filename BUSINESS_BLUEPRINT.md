# Business Blueprint: memento

<!-- memento:business-index:start (自动生成，勿手改) -->
> 先读这一段定位；要细节时按下表行号只读对应章节。改了「代码位置」里的文件，先看对应条目还成不成立。

- 汇总：规则 75（✅ 75 · ⚠️ 0 · ❌ 0）· 流程 9 · 术语 11 · 状态 9
- 核对：全部通过（详见末尾「自动核对」）

| 章节 | 行号 |
| :--- | :--- |
| 1. 业务对象与术语 | L21-L65 |
| 2. 关键流程 | L67-L124 |
| 3. 业务规则 | L126-L597 |
| 4. 状态归属 | L599-L644 |
| 自动核对 (Auto Check) | L647-L762 |
<!-- memento:business-index:end -->
> 业务蓝图：memento 应该做成什么样，每一条落在哪段代码、由哪个测试或检查保证。和代码蓝图 [CODE_BLUEPRINT.md](CODE_BLUEPRINT.md)（代码长什么样）配合看：代码蓝图回答"在哪里"，这份回答"应该怎样、为什么"。
> 规则来自用户的原话和纠正（CLAUDE.md、长期记忆、每晚复盘），不是从代码里反推的；代码和这里对不上，先当成代码的问题查。
> 维护方式：改了某条「代码」里列的文件，看一眼这条还成不成立；新增一条用户定下的规则，按下面的格式加进来并挂上代码和测试。生成器（`scripts/project_blueprint.mjs`）每次提交都核对一遍，结果写在末尾「自动核对」，CODE_BLUEPRINT.md 第 11 节列出最近提交碰到了哪些条目；CI 遇到 ❌ 会拦下部署。

## 1. 业务对象与术语

### T-DEVICE 设备
- 定义: 一台装了 memento 客户端（守护进程）的电脑或无界面 Linux 执行机。一台电脑只算一台设备，换 token、重装都合并到同一条记录。设备的标识是采集 token 的哈希（`device_id`），网页上显示主机名。
- 代码: `server/server/db/models.py#Machine`, `server/server/services/device_merge.py`, `server/server/services/device_dispatch.py#ws_alias`

### T-CONVERSATION 对话
- 定义: AI 执事里的一串问答，属于用户，记着当时的工具、设备、目录、项目、会话、模型（config）。对话是 memento 自己的东西，和智能体工具里的「会话」不是一回事：一个对话可以接着一个会话聊，也可以第一句时让智能体新建一个。
- 代码: `server/server/db/models.py#AskConversation`, `server/server/services/ask_store.py#append_conversation_turns`

### T-SESSION 会话
- 定义: 智能体工具自己的会话：Claude Code 的 session、Antigravity 的 cascade、Codex 的 thread、WorkBuddy 的 session。存在设备本机，由采集上传；对话的 config.session_id 记着它接着哪个会话。
- 代码: `apps/web/src/lib/ask/sessions.ts#sessionMessagesToTurns`, `server/server/services/ask_stream.py#_next_session`

### T-RESUME 续接（续）
- 定义: 用户从历史会话列表里挑了一个会话，让对话接着它聊。只有这种才叫「续」。对话第一句时智能体新建的会话是这个对话自己的会话，标「会话:」/「本对话的会话」，不叫续。
- 代码: `apps/web/src/app/ask/page.tsx#sessionPicked`, `apps/web/src/components/ask/SessionResumeBanner.tsx#SessionResumeBanner`

### T-AGY-PROJECT Antigravity 项目
- 定义: Antigravity 2.x 的工作区单位（~/.gemini/config/projects/<id>.json，资源里是文件夹 URI）。它和 memento 的「项目」不是一回事。Antigravity 新建会话不认 cwd，只认环境变量 ANTIGRAVITY_PROJECT_ID 指的项目。
- 代码: `packages/daemon/src/agy-runner/runner.ts#projectForFolder`, `packages/daemon/src/agy-runner/runner.ts#agyFolderUri`

### T-QUOTA 额度
- 定义: 智能体账号还能用多少。Antigravity 按模型分开算（Gemini 4 Argon 和 Orchestrator 按周重置，Hydrogen、Flash、Claude、GPT-OSS 几小时重置）；Claude Code、Codex 各模型共用一份账号额度。设备探测上报，服务端只转存。
- 代码: `packages/daemon/src/quotas.ts#probeAntigravityQuota`, `apps/web/src/lib/ask/model-limits.ts#modelQuotaOf`, `server/server/services/device_reports.py#get_cached_device_quotas`

### T-FOLLOWUP 追问
- 定义: 回答还在跑时用户又发的话。智能体能中途读输入的，送进去（steer），它下一步读到；送不进去的（没任务、工具不支持、晚了）由服务端按对话保管，本轮结束后合成下一条消息发。
- 代码: `apps/web/src/lib/ask/followups.ts#FollowUp`, `server/server/services/ask_followups.py`, `packages/daemon/src/task-runner.ts#input`

### T-BACKGROUND-TASK 后台任务
- 定义: 智能体在回答写完后还挂着的后台命令或定时器（Antigravity 的 schedule 定时复查、Claude 的后台 Bash）。一轮回答以它们结束为准，不是以正文写完为准。
- 代码: `packages/daemon/src/agy-runner/runner.ts#timerSeconds`, `packages/daemon/src/agy-runner/runner.ts#backgroundQuietMs`

### T-RUN 运行
- 定义: 一次提问的执行过程。它比发起它的 HTTP 请求活得长：页面关了、手机切后台、服务端发版，运行照常进行，任何副本都能续看和停止（Redis stream 镜像）。
- 代码: `server/server/services/ask_runs.py`, `server/server/api/ask.py#list_active_runs`

### T-PLAN 协作任务
- 定义: 一个大任务拆成多步，按设备、智能体、模型分派到多台设备并行执行。规划阶段就定好每步用哪台设备的哪个智能体和模型，额度不够的模型直接不派。
- 代码: `server/server/services/plan_service.py#normalize_steps`, `server/server/services/plan_service.py#model_roster`

### T-BLUEPRINT 蓝图
- 定义: 三种。代码蓝图 CODE_BLUEPRINT.md（生成器扫代码得来；1.0.134 之前叫 PROJECT_BLUEPRINT.md）；业务蓝图 BUSINESS_BLUEPRINT.md（本文件，人和智能体写、生成器核对）；个人蓝图 USER_BLUEPRINT.md（服务端综合用户所有项目的代码蓝图、业务蓝图、画像和记忆得来）。前两种只来自设备上传，服务端从多份设备副本里挑最新的。
- 代码: `packages/daemon/src/blueprint/content.ts#buildBlueprintContent`, `packages/daemon/src/blueprint/business.ts#checkBusinessBlueprint`, `server/server/services/blueprint_pick.py#pick_freshest`

## 2. 关键流程

### F-ASK 提问到收尾
1. 网页发出提问，带上当前对话的工具、设备、目录、项目、会话、模型 — `apps/web/src/app/ask/page.tsx#sendWithText`
2. 服务端收下，开一个运行（同一对话同时只有一个） — `server/server/api/ask.py#ask`, `server/server/services/ask_runs.py`
3. 按选的设备和会话准备参数：会话在别的设备上就搬过去或另开，模型、额度预检 — `server/server/services/ask_stream.py#_prepare_agent_args`, `server/server/services/ask_stream.py#_session_elsewhere`
4. 建任务行并经设备的 WebSocket 发下去（设备可能连在另一个副本上） — `server/server/services/device_dispatch.py#deliver_task`, `server/server/services/ws_manager.py#send_task`
5. 设备上的守护进程起智能体（Claude Code / Codex / Antigravity 执行脚本 / WorkBuddy） — `packages/daemon/src/task-runner.ts#execute`
6. 过程以事件和输出块回传，带序号、断线补发 — `packages/daemon/src/task-runner.ts#sendChunk`, `packages/daemon/src/task-runner.ts#emitEvent`
7. 服务端把事件推给正在看的页面（SSE），任何副本都能续看 — `server/server/services/ask_stream.py#direct_agent_stream`
8. 设备报 task_finished，服务端记下终态 — `server/server/api/tasks.py#_save_finished`
9. 回合写进对话（写不进分级瘦身重试） — `server/server/services/ask_stream.py#_append_turns_or_slim`, `server/server/services/ask_store.py#append_conversation_turns`
10. 运行结束：灵动岛撤掉、排队的追问合成下一条发出 — `apps/web/src/components/agent/ActiveRunsMonitor.tsx#ActiveRunsMonitor`, `apps/web/src/lib/ask/followups.ts#nextMessage`

### F-RESUME 挑历史会话续接
1. 会话列表里点一个会话 — `apps/web/src/app/ask/page.tsx#handleSelectSession`
2. 找到或新建绑定这个会话的对话（按用户+会话加锁，不重复建），把会话最近的问答并进对话 — `server/server/api/ask_conversations.py#ensure_conversation_by_session`, `server/server/services/session_timeline.py#sync_conversation`
3. 打开这个对话，恢复当时的工具、设备、项目、会话配置 — `apps/web/src/app/ask/page.tsx#openSessionConversation`, `apps/web/src/app/ask/page.tsx#applyCachedCascade`, `apps/web/src/lib/ask/cascade.ts#cascadeOf`
4. 会话还没采集到、对话没有回合时，才显示会话最近消息的预览 — `apps/web/src/app/ask/page.tsx#emptyConvId`
5. 下一句带上会话 id，设备上接着这个会话跑（Claude 的会话不在本机就先拉过来） — `packages/daemon/src/session-sync.ts#fetchClaudeSession`

### F-AGY-NEW Antigravity 新建会话
1. 执行脚本收到任务，没有会话 id — `packages/daemon/src/agy-runner/runner.ts`
2. 按任务目录找 Antigravity 项目：资源里有这个文件夹的项目 → 历史会话用过的项目 → 新建一个（自己给 id），家目录和盘符根不建 — `packages/daemon/src/agy-runner/runner.ts#projectForFolder`
3. 设好 ANTIGRAVITY_PROJECT_ID，调 agentapi new-conversation — `packages/daemon/src/agy-runner/runner.ts#projectForFolder`
4. 跟踪步骤直到真正结束，包括它设的定时复查 — `packages/daemon/src/agy-runner/runner.ts#timerSeconds`

### F-FOLLOWUP 回答中追问
1. 运行中在主输入框发话：能 steer 的送进运行中的智能体任务，否则排队 — `apps/web/src/app/ask/page.tsx#sendFollowUp`, `apps/web/src/lib/ask/followups.ts#steerableTaskId`
2. 服务端转给设备；任务已结束或设备离线就按对话保管 — `server/server/api/tasks.py#send_task_input`, `server/server/services/ws_manager.py#send_input`
3. 设备写给智能体并上报 steer 事件（sent / late / unsupported），late、unsupported 再交回服务端保管 — `packages/daemon/src/task-runner.ts#input`, `server/server/services/ask_followups.py#note_steer`
4. 送达的从输入区移走，显示在回答气泡里；排队的本轮结束后合成一条发出 — `apps/web/src/components/ask/bubbles.tsx#AssistantBubble`, `apps/web/src/lib/ask/followups.ts#deliveredFollowUps`, `apps/web/src/lib/ask/followups.ts#nextMessage`

### F-STOP 停止运行
1. 页面点停止 — `apps/web/src/app/ask/page.tsx#stopRun`
2. 服务端停运行，把取消发给任务所在设备（设备离线就等它回来再发） — `server/server/api/ask.py#cancel_run`, `server/server/services/ws_manager.py#send_cancel`, `server/server/services/ws_manager.py#cancel_when_back`
3. 设备杀掉整棵进程树（WorkBuddy 还要停网关里的会话），立刻报 cancelled — `packages/daemon/src/task-runner.ts#cancel`

### F-DELETE 删除对话
1. 页面先记下这个 id，之后拉回的列表都滤掉它，再调删除 — `apps/web/src/app/ask/page.tsx#deleteConversation`, `apps/web/src/app/ask/page.tsx#deletedConversationIds`
2. 服务端删行并清对话列表缓存 — `server/server/api/ask_conversations.py#delete_conversation`, `server/server/services/ask_store.py#bust_conv_list`
3. 清缓存广播给所有 api 副本，各自丢掉自己的进程内副本 — `server/server/services/cache.py#cache_delete_prefix`, `server/server/services/cache.py#_on_l1_bust`

### F-PLAN 协作任务
1. 一句话发起，服务端让大模型拆步骤 — `server/server/services/plan_service.py#normalize_steps`
2. 规划前现查各设备额度，列出每个智能体可用的模型，用完的排除 — `server/server/services/plan_service.py#model_roster`
3. 每步派给选定设备的智能体和模型，多机并发，失败的换下一个 — `server/server/services/plan_service.py#choose_assignment`

### F-CLIENT-UPGRADE 客户端升级
1. 检查到新版本，下载 — `apps/desktop/src/main.ts#setupUpdater`
2. 本机还有智能体任务在跑就等它们结束再装 — `apps/desktop/src/main.ts#runningAgentTasks`
3. 守护进程报告运行中的任务，服务端收尾没人跟进的旧任务 — `server/server/services/agent_limits.py`

### F-BLUEPRINT 蓝图生成与核对
1. 提交时 git 钩子跑生成器：重写代码蓝图，核对业务蓝图 — `packages/daemon/src/blueprint/repo.ts#writeBlueprint`, `packages/daemon/src/blueprint/business.ts#refreshBusinessBlueprint`
2. 守护进程把两份蓝图上传到服务端 — `packages/daemon/src/daemon.ts`
3. 服务端从多台设备的副本里挑代码最新的一份，给项目页、MCP、心领神会用 — `server/server/services/blueprint_pick.py#pick_freshest`
4. CI 核对业务蓝图，有 ❌ 不部署 — `.github/workflows/ci.yml`

## 3. 业务规则

### R-AGY-WORKDIR 选了哪个目录，Antigravity 就在那个目录干活
- 来源: 用户 2026-11-14「我的配置里选的是easy-copilot 怎么antigravity识别去开的是chem-vision」
- 说明: 根因是守护进程把 app_storage.json 的 lastCreatedProjectId（最后新建的项目）当成 ANTIGRAVITY_PROJECT_ID 传下去。2026-11-16 又查实服务端派发时用 `"win" in 设备名` 判断 Windows，「(Darwin)」里含 win，Mac 上选的目录被当成别的平台的路径，换成项目文档里排序最大的路径（一份对话的 walkthrough.md），守护进程认不出是目录就退回家目录：这台 Mac 近 30 天 302 个 Antigravity 任务都不在选的目录里跑。
- 代码: `packages/daemon/src/agy-runner/runner.ts#projectForFolder`, `packages/daemon/src/antigravity.ts#discoverAntigravityEnv`, `server/server/services/orchestrator.py#_device_cwd`, `server/server/services/agent_ids.py#device_os`
- 测试: `packages/daemon/test/agy-project-folder.test.ts#takes the project whose resources name the folder, not the one made last`, `packages/daemon/test/agy-project-folder.test.ts#makes a project for a folder no project names`, `server/tests/test_agent_ids.py#test_a_macs_folder_is_kept_as_asked`, `server/tests/test_agent_ids.py#test_another_platforms_folder_becomes_the_one_most_of_the_projects_documents_name`
- 禁止: `lastCreatedProjectId` @ `packages/daemon/src/antigravity.ts`, `packages/daemon/src/agy-runner/`; `"win" in` @ `server/server/services/orchestrator.py`
- 要求: `ANTIGRAVITY_PROJECT_ID = ` @ `packages/daemon/src/agy-runner/runner.ts`

### R-AGY-APP-CSRF Antigravity 应用不给会话接口令牌时，任务改走 Google 官方 agy 命令行并共用桌面会话库保持双向同步
- 来源: 用户 2026-11-21 客户端对话报错「failed to fetch available models: rpc error: code = Unauthenticated desc = unauthenticated: missing CSRF token」，四个档位依次失败；用户 2026-11-26「现在 antigravity 怎么不是双向同步了」
- 说明: Antigravity 2.34 起桌面应用的 language_server 以 hub 模式启动，CSRF 令牌经 host bridge 只交给应用自己启动的进程（命令行不再带 --csrf_token，页面里 csrfToken 为空），守护进程调 agentapi 一律被拒。不去绕这个限制：取不到令牌就视为应用不可用，改用 Google 官方 agy 命令行（官方文档：同一台机器上应用和命令行共用登录）；没装就用官方安装脚本自动装（30 分钟内最多试一次），~/.local/bin/agy 上 memento 自己的包装脚本给它让位。ACP 通道（`agy_acp.mjs`）必须按会话归属与本机桌面存储动态传 `--app-data-dir`：续接桌面会话或本机装有桌面版新开会话时传 `--app-data-dir antigravity`，原地读写 `~/.gemini/antigravity/`（不再把桌面会话拆成独立的 `antigravity-cli` 续接分支）并将新建会话绑定到对应桌面项目 `project_id`；续接已有 CLI 会话或无桌面版的服务器继续走 `antigravity-cli`。执行脚本遇到 CSRF 拒绝不再逐个档位重试；已经用应用跑起来的任务遇到它，自动换命令行重跑一次。
- 代码: `packages/daemon/src/antigravity.ts#discoverAntigravityEnv`, `packages/daemon/src/antigravity.ts#ensureOfficialAgyCli`, `packages/daemon/src/antigravity.ts#isAppAuthRejection`, `packages/daemon/src/antigravity.ts#selectAntigravityAppDataDir`, `packages/daemon/src/antigravity.ts#bindAntigravitySessionProject`, `packages/daemon/src/task-runner.ts#execute`, `packages/daemon/src/agy-acp-runner/main.ts`, `packages/daemon/src/agy-runner/runner.ts`
- 测试: `packages/daemon/test/antigravity-csrf.test.ts#tells the language server's CSRF rejection from other failures`, `packages/daemon/test/antigravity-official-cli.test.ts`, `packages/daemon/test/antigravity-acp.test.ts#resumes Antigravity Desktop sessions in-place via --app-data-dir antigravity (no forking), preserves CLI sessions, and binds new Desktop sessions to the matching project`
- 要求: `if (!ls.csrf) return null;` @ `packages/daemon/src/antigravity.ts`; `selectAntigravityAppDataDir(` @ `packages/daemon/src/task-runner.ts`

### R-TRACK-BACKGROUND 后台任务跟踪到结束，不提前收尾
- 来源: CLAUDE.md（memento）「后台任务要跟踪到结束，不要提前结束」；用户 2026-11-14「antigravity经常会出现任务还没完成……不能精准的判断到任务是否结束吗」；用户 2026-11-23「antigravity 的后台任务没有完整的跟踪而提前退出了。实际上任务没有完成」
- 说明: 不能用固定的安静时长判定结束。Antigravity 的定时器到点前日志为空，按定时时长等到点再加宽限。用 Google 的 agy 命令行跑的任务，ACP 通道（`agy_acp.mjs`）在后台任务/定时器/子智能体结束后不得用 2.5s/6s 固定静默超时提前收尾，必须结合 `conversation_summaries.db` 的 Cascade 引擎实时运行状态（`CASCADE_RUN_STATUS_RUNNING` / `not_fully_idle`）与唤醒后的 `PLANNER_RESPONSE`（无 `tool_calls`）确认真正空闲，并支持唤醒中接力启动下一波后台任务与静默保活；后台命令是否跑完按会话记录里每个后台任务自己的结束消息判断，不看回复里的字眼（2026-11-19 vps3 误报、2026-11-23 filmkit 8/8 后台唤醒被 6s/2.5s 提前终止）。
- 代码: `packages/daemon/src/agy-runner/runner.ts#timerSeconds`, `packages/daemon/src/agy-runner/runner.ts#backgroundQuietMs`, `packages/daemon/src/agy-acp-runner/main.ts#evaluateWakeupCompletion`, `packages/daemon/src/agy-acp-runner/helpers.ts#readAgyConversationState`, `packages/daemon/src/antigravity.ts#openBackgroundTasks`, `packages/daemon/src/antigravity.ts#agyCliOpenBackgroundTasks`
- 测试: `packages/daemon/test/antigravity-runner.test.ts#waits for a timer Antigravity set and ends on the work it wakes up for, not at the quiet limit`, `packages/daemon/test/agy-project-folder.test.ts#reads how long a schedule timer waits from its task description`, `packages/daemon/test/still-running.test.ts#detects Antigravity active background task`, `packages/daemon/test/antigravity-official-cli.test.ts#background commands: done once the transcript says they ended, whatever the reply says; one still going leaves the task running`, `packages/daemon/test/agy-background.test.ts#none once each one's own message says it finished (the run on vps3 that read as still running)`, `packages/daemon/test/antigravity-acp.test.ts#tracks slow-thinking (>6s) and multi-step (>2.5s gaps) autonomous wakeups to completion without exiting early`, `packages/daemon/test/antigravity-acp.test.ts#tracks chained multi-wave background tasks launched during an autonomous wakeup turn`
- 要求: `timerSeconds(` @ `packages/daemon/src/agy-runner/runner.ts`; `readAgyConversationState(` @ `packages/daemon/src/agy-acp-runner/main.ts`
- 禁止: `quietMs >= 6000` @ `packages/daemon/src/agy-acp-runner/main.ts`; `quietMs >= 2500` @ `packages/daemon/src/agy-acp-runner/main.ts`

### R-STOP-ALL-AGENTS Antigravity、Claude Code、Codex 运行中的任务都必须能停
- 来源: CLAUDE.md（memento）「必须能停止 Antigravity、Claude Code、Codex 运行中的任务」
- 代码: `packages/daemon/src/task-runner.ts#cancel`, `server/server/api/ask.py#cancel_run`, `server/server/services/ws_manager.py#cancel_when_back`
- 测试: `server/tests/test_ask_runs.py#test_cancel_stops_the_generator`, `server/tests/test_ask_runs.py#test_cancel_before_the_run_starts_still_closes_it`, `server/tests/test_agent_run_states.py#test_stopped_by_the_user_is_saved_as_stopped_not_done`, `packages/daemon/test/antigravity-runner.test.ts#gives up at the task timeout and stops on a signal`
- 要求: `killProcessTree(` @ `packages/daemon/src/task-runner.ts`

### R-ISLAND-CLEANUP 任务结束必须清掉灵动岛状态
- 来源: CLAUDE.md（memento）「任务结束清理灵动岛状态」；记忆「灵动岛任务状态必须以底层工具真实终态为准，任务完成后必须同步清理」；用户 2026-11-23「antigravity 的后台任务，灵动岛展示任务已完成？」
- 说明: 运行中（含后台任务、子智能体、工具调用）严禁根据 `currentStep` 文案是否含「完成 / 已结束 / 已停止」判定为已完成，终态只认显式 `status`（`done` / `error` / `cancelled`）。服务端与前端推送非终态进度时一律改写上述触发词（立即保护已安装的旧版 iOS 客户端），不把用户原始提问塞进 `currentStep`，并同步推送 `task_event`（`background` / `subagent` / `tool`）。前端切换设备、刷新对话列表、切换页面或 `finishStream` 清理时，不得向仍在运行的任务发送 `action: "end", status: "done"`；任务真正结束后立即清理灵动岛。
- 代码: `apps/web/src/components/agent/ActiveRunsMonitor.tsx#ActiveRunsMonitor`, `apps/web/src/lib/ask/live-activity.ts#sanitizeLiveActivityStep`, `apps/web/src/lib/ask/live-activity.ts#formatLiveActivityTaskEvent`, `server/server/services/notify_service.py#sanitize_live_activity_step`, `server/server/services/ask_runs.py`, `server/server/api/ask.py#list_active_runs`, `packages/daemon/src/task-runner.ts#cancel`, `apps/mobile/targets/MementoLiveActivity/MementoLiveActivity.swift`, `apps/mobile/plugins/withLiveActivity.js`
- 测试: `apps/web/test/run-status.test.ts#is forgotten when a run start or end is pushed`, `apps/web/test/live-activity.test.ts#rewrites completion words for non-terminal updates while preserving terminal steps`, `apps/web/test/live-activity.test.ts#never sends a bogus done end from ask page effect cleanup`, `server/tests/test_ask_runs.py#test_finished_run_is_dropped_after_retention`, `server/tests/test_ask_runs.py#test_background_task_and_prompt_completion_word_never_mark_live_activity_done`, `server/tests/test_agent_limits.py#test_old_daemons_still_running_on_quota_is_failed`
- 禁止: `currentStep.contains("完成")` @ `apps/mobile/targets/MementoLiveActivity/MementoLiveActivity.swift`, `apps/mobile/plugins/withLiveActivity.js`
- 要求: `sanitize_live_activity_step(` @ `server/server/services/notify_service.py`; `sanitizeLiveActivityStep(` @ `apps/web/src/app/ask/page.tsx`

### R-MULTI-DEVICE-STABLE 多机任务并发执行，过程和结果稳定回传
- 来源: CLAUDE.md（memento）「多机任务并发执行，过程和结果稳定回传」；心领神会「单台设备离线不得拖垮整体」
- 代码: `packages/daemon/src/task-runner.ts#sendChunk`, `packages/daemon/src/task-runner.ts#resendBufferedChunks`, `server/server/services/device_dispatch.py#deliver_task`, `server/server/services/plan_service.py#choose_assignment`
- 测试: `packages/daemon/test/task-resilience.test.ts#TaskRunner generates monotonic sequence numbers and buffers chunks for idempotent resend`, `packages/daemon/test/task-resilience.test.ts#WsTaskClient preserves strict FIFO message order when pending messages exist and new message arrives`, `server/tests/test_device_dispatch.py#test_an_offline_device_fails_the_task_at_once`, `server/tests/test_plan_service.py#test_choose_assignment_prefers_asked_agent_and_skips_tried_and_spent`

### R-WS-BIG-UNTRACKED 跨设备改代码时，没进 .gitignore 的大文件不让任务失败
- 来源: 用户 11-16 用 vps3 改 Windows 上的 pubchem 时报「有未被 .gitignore 忽略的大文件」（79MB 的 xlsx）；心领神会「开发机不必是本地机器，任何需要每台设备手工配置的方案都视为不合格」
- 说明: 源设备打快照时，单个超过 50MB、或合计超过 300MB 的未跟踪文件留在源设备上不带过去，同步照常；任务过程里列出没带上的文件。补丁回来不会动这些文件。
- 代码: `packages/daemon/src/workspace.ts#untrackedToLeave`, `packages/daemon/src/workspace.ts#exportWorkspace`, `packages/daemon/src/workspace-sync.ts#prepareWorkspace`, `apps/web/src/components/TaskTimeline.tsx`
- 测试: `packages/daemon/test/workspace.test.ts#leaves an untracked file too big to send on the source instead of failing, and says which`
- 禁止: `加进 .gitignore 后再试` @ `packages/daemon/src/workspace.ts`

### R-WS-EDIT-ONLY 远程执行机只改代码，测试、构建、提交、推送等其余工作都在代码所在的设备上做
- 来源: 用户 11-17「改代码也要可以」（直接改本机任意文件）；「远程机 vps3 只改代码，其它的所有工作，测试，提交，等等工作都由本地机完成」「包括调用浏览器，其它软件，安卓模拟器，ios 发到 testflight 等等操作」
- 说明: 跨设备任务里执行机只读和改代码。测试、构建、装依赖、运行程序、浏览器、模拟器、iOS 上传等用 memento-source 在代码所在的设备上执行（带着当前改动，在单独的检出目录里，用那台设备的依赖、钥匙串和已登录工具）；提交用 memento-source commit 在那台设备上真正 git commit（它的钩子照常运行，钩子失败把输出交回智能体，钩子改的文件同步回执行机），只提交智能体改过的文件；推送在任务结束、改动写回后由那台设备做；那边的文件用 memento-source get 取回看；那台设备上项目以外的任意文件（别的仓库、配置）用 get 取回改好再 memento-source put 写回，原文件先备份到 ~/.memento/source-edits，.ssh、.env、/etc、shell 启动脚本、凭据文件等敏感位置照常写并推送提醒（11-19 起，见 R-WS-EXEC-REMIND），本项目里的文件不走 put（用户 11-17「改代码也要可以」→ 选「直接改本机任意文件」）。执行机副本装拒绝 commit/push 的 git 钩子，Claude Code 在执行机直接跑测试、构建、装依赖、提交、推送会被拦下并指向 memento-source；绕过拦截在执行机上做的提交只带回文件改动。Codex、Antigravity 没有追加系统提示，规则放在任务开头。
- 代码: `packages/daemon/src/source-exec.ts#commitOnSource`, `packages/daemon/src/source-exec.ts#readOnSource`, `packages/daemon/src/source-exec.ts#writeOnSource`, `packages/daemon/src/source-exec.ts#executorOnlyEdits`, `packages/daemon/src/source-exec.ts#sourceExecHint`, `packages/daemon/src/workspace.ts#refuseCommitsHere`, `packages/daemon/src/workspace-sync.ts#finishWorkspace`, `packages/daemon/src/hook-bridge.ts#denyReply`, `server/server/services/workspace_relay.py`
- 测试: `packages/daemon/test/workspace.test.ts#commits on the source with its hooks, takes in what they changed, and lands the commits on the branch`, `packages/daemon/test/workspace.test.ts#hands a failing hook's output back to the agent and commits nothing`, `packages/daemon/test/workspace.test.ts#only files come back when the agent forced a commit through on the executor`, `packages/daemon/test/source-exec.test.ts#turns down tests, builds, installs, commits and pushes run there, and lets memento-source and reading through`, `packages/daemon/test/hook-bridge.test.ts#reports every call and turns down the ones it is told to, with the reason for the model`, `server/tests/test_workspace_relay.py#test_the_agents_commit_is_made_on_the_source_and_an_old_source_is_told_to_upgrade`, `server/tests/test_workspace_relay.py#test_a_file_outside_the_project_is_written_on_the_source_and_a_sensitive_one_tells_the_phone`, `packages/daemon/test/workspace.test.ts#edits a file on the source outside the project: get it, change it here, put it back, the old one backed up`
- 要求: `"source_commit"` @ `packages/daemon/src/capabilities.ts`; `"commit": _commit` @ `server/server/services/workspace_relay.py`


### R-BIZ-AUTO 画像里有项目规则的项目自动生成业务蓝图，不靠手动点按钮
- 来源: 用户 11-18「为什么除了memento 项目，其它项目都没有业务蓝图啊」；心领神会「希望工具能越用越了解用户，具备自进化能力」
- 说明: 画像里有某个项目的专属规则、设备上传过它的代码蓝图、但还没有业务蓝图（或有规则没写进去）时，主动执事每小时看一次，仓库所在的设备在线就派智能体去写或补全，每次最多派一个，每个项目一周最多一次；设备不在线不占这一周的次数。智能体不提交 git。关掉「自动蓝图」开关就不派；不采集的项目跳过。项目页仍可点按钮立即生成。
- 代码: `server/server/services/business_blueprint.py#auto_generate`, `server/server/services/business_blueprint.py#needs_generation`, `server/server/services/business_blueprint.py#dispatch_generation`, `server/server/services/pulse_service.py#_pulse_user`, `server/server/api/projects.py#generate_business_blueprint`
- 测试: `server/tests/test_business_blueprint.py#test_sends_one_for_a_project_with_rules_and_none_yet_on_an_online_device`, `server/tests/test_business_blueprint.py#test_offline_device_or_switch_off_sends_nothing_and_keeps_the_weeks_turn`, `server/tests/test_business_blueprint.py#test_which_projects_need_one`
- 要求: `business_blueprint.auto_generate` @ `server/server/services/pulse_service.py`

### R-ENT-ADMIN-SCOPE 企业部署里管理员只管账号，不看别人的对话、记忆和设备
- 来源: 用户 11-18「我这个系统给企业部署你觉得可行吗」→「全部做完吧」（排查发现管理员和所有者能看所有人的对话、往任何人的电脑派命令）
- 说明: 部署设置 MEMENTO_ADMIN_SCOPE=own 时，管理员和所有者跟普通用户一样只看得到、只操作得了自己的设备、对话、记忆和任务，仍可管理账号、邀请码、权限和看审计日志；用户列表也不再给出别人的采集令牌（凭它能以那人的身份登录）。默认 all 保持个人部署原来的样子。账号停用后它的采集令牌立即失效，设备不再能同步和接收命令。
- 代码: `server/server/services/enterprise_policy.py#sees_all`, `server/server/services/user_filter.py#user_machine_ids`, `server/server/api/tasks.py#_authorize_device`, `server/server/api/admin.py#list_users`, `server/server/middleware/auth.py#verify_collector_token`
- 测试: `server/tests/test_enterprise.py#test_admins_see_everyone_by_default_and_only_their_own_under_own`, `server/tests/test_enterprise.py#test_under_own_an_admin_cant_send_commands_to_someone_elses_device`, `server/tests/test_enterprise.py#test_under_own_the_user_list_doesnt_hand_out_other_peoples_collector_tokens`, `server/tests/test_enterprise.py#test_a_disabled_accounts_collector_token_stops_working`
- 要求: `admin_scope: str = "all"` @ `server/server/config.py`; `if not sees_all(user):` @ `server/server/api/tasks.py`

### R-ENT-SSO 企业员工用公司统一账号登录，离职由身份平台自动停用
- 来源: 用户 11-18「全部做完吧」（企业部署缺单点登录和离职自动停用）
- 说明: 配好 OpenID Connect（Keycloak、Authing、Azure AD、Okta 等，公司目录可经 Keycloak 接入）后登录页出现「使用企业账号登录」。按身份平台的主体标识认账号，邮箱经身份平台确认（或在公司域名内）才能关联已有账号；可限定邮箱域名，可按组决定管理员。关掉密码登录后，只有所有者还能用密码登录（身份平台出问题时进得来），GitHub、微信登录同样关闭。SCIM 接口供身份平台开通和停用账号，停用只改状态不删数据。
- 代码: `server/server/api/sso.py#resolve_user`, `server/server/api/sso.py#oidc_callback`, `server/server/api/scim.py#patch_user`, `server/server/api/auth.py#login`, `apps/web/src/app/auth/github-login.tsx#SsoLoginButton`, `apps/web/src/app/auth/login/page.tsx`
- 测试: `server/tests/test_enterprise.py#test_full_code_flow_verifies_signature_nonce_and_pkce`, `server/tests/test_enterprise.py#test_other_email_domains_are_turned_away`, `server/tests/test_enterprise.py#test_an_existing_account_is_linked_by_a_vouched_email_and_its_role_follows_the_groups`, `server/tests/test_enterprise.py#test_with_password_login_off_only_the_owner_still_signs_in_with_a_password`, `server/tests/test_enterprise.py#test_deactivating_disables_the_account_without_deleting_it`
- 要求: `"code_challenge_method": "S256"` @ `server/server/api/sso.py`; `app.include_router(scim.router)` @ `server/server/main.py`

### R-ENT-AUDIT 谁登录、改了账号和权限、往设备派了命令都留审计记录
- 来源: 用户 11-18「全部做完吧」（审计日志原来只记文档访问）
- 说明: 登录（成功、失败、企业账号、被拒）、批准和修改账号、重置令牌、删除账号、转让所有者、邀请码、授权和收权、向设备派命令（带命令前 300 字）、访问他人设备、修改模型配置、身份平台开通和停用，都记操作人、对象、来源地址。删除账号时保留它的审计记录。按 MEMENTO_AUDIT_RETENTION_DAYS（默认 365 天）每天清理过期记录。记录失败不影响操作本身。管理后台的审计页默认只看这些操作。
- 代码: `server/server/services/audit_service.py#record`, `server/server/tasks/audit_retention.py#purge_old_audit_entries`, `server/server/api/admin.py#get_audit_log`, `apps/web/src/lib/audit-labels.ts#auditSummary`
- 测试: `server/tests/test_enterprise.py#test_an_entry_records_actor_target_and_details`, `server/tests/test_enterprise.py#test_recording_never_breaks_the_action`, `server/tests/test_enterprise.py#test_changing_a_role_is_audited`, `server/tests/test_device_dispatch.py#test_dispatch_endpoint_sends_the_task_it_creates`, `apps/web/test/audit-labels.test.ts#sums an entry up`
- 要求: `"device_task.dispatch"` @ `server/server/api/tasks.py`; `"server.tasks.audit_retention"` @ `server/server/tasks/celery_app.py`

### R-ENT-SECRETS 用户填的模型密钥加密存库，只能用管理员允许的模型服务
- 来源: 用户 11-18「全部做完吧」（模型密钥明文存在数据库里，员工可以把内容发给任意模型服务）
- 说明: 用户的模型 API 密钥加密后存入数据库，接口只返回遮住的形式；启动时把以前明文存的密钥补加密。部署设置 MEMENTO_ALLOWED_MODEL_HOSTS 列出允许的模型服务域名后，填别的服务保存和测试都会被拒，以前存的也不再使用。
- 代码: `server/server/services/secret_box.py#seal`, `server/server/services/secret_box.py#seal_existing`, `server/server/api/llm.py#update_llm_settings`, `server/server/services/ai_provider.py#get_ai_providers`, `server/server/services/enterprise_policy.py#model_endpoint_violation`
- 测试: `server/tests/test_enterprise.py#test_saving_model_settings_stores_the_key_encrypted_and_never_returns_it`, `server/tests/test_enterprise.py#test_saving_an_endpoint_the_deployment_doesnt_allow_is_refused`, `server/tests/test_enterprise.py#test_a_users_own_endpoint_outside_the_allowed_ones_isnt_used`, `server/tests/test_enterprise.py#test_seal_reveal_roundtrip_and_plaintext_passthrough`
- 要求: `user.llm_settings = seal_llm_settings(data)` @ `server/server/api/llm.py`; `seal_existing` @ `server/server/main.py`

### R-ENT-DEVICE-POLICY 公司 IT 下发的策略文件管住员工电脑：固定服务器、限定远程任务和目录
- 来源: 用户 11-18「全部做完吧」（守护进程能在员工电脑上执行命令、读写文件，企业安全审查要能管住；客户端默认连官方服务器）
- 说明: 系统级的 managed.json（macOS /Library/Application Support/Memento、Windows %ProgramData%\Memento、Linux /etc/memento）由 MDM 或组策略下发。server_url 固定连接的服务器，应用里不能切换；remote_tasks 为 agent 时只接收智能体任务、不直接执行命令，为 none 时什么都不接收；allowed_roots 限定任务运行目录，以及服务端能读、写、打包的文件范围。文件格式错误时忽略出错的字段，不会让员工用不了。
- 代码: `packages/daemon/src/managed-policy.ts#managedPolicy`, `packages/daemon/src/managed-policy.ts#taskRefusal`, `packages/daemon/src/managed-policy.ts#pathAllowed`, `packages/daemon/src/task-runner.ts`, `packages/daemon/src/ws-client.ts`, `packages/daemon/src/config.ts#loadConfig`, `apps/desktop/src/main.ts`
- 测试: `packages/daemon/test/managed-policy.test.ts#reaches only inside the allowed directories, not a sibling that shares a prefix`, `packages/daemon/test/managed-policy.test.ts#the server it names wins over the user's own setting`, `packages/daemon/test/managed-policy.test.ts#a refused task is reported failed, with the reason, and nothing runs`, `packages/daemon/test/managed-policy.test.ts#a task outside the allowed directories doesn't start`
- 要求: `assertPathAllowed(deviceFilePath(path))` @ `packages/daemon/src/ws-client.ts`; `taskRefusal(action)` @ `packages/daemon/src/task-runner.ts`; `managedPolicy().serverUrl` @ `apps/desktop/src/main.ts`

### R-ENT-DEPLOY 企业能在自己的服务器上一键部署、备份恢复、离线安装，安装包可正式签名
- 来源: 用户 11-18「全部做完吧」（生产只在自己的 NAS 集群上部署，没有给企业的安装包；安装包没有正式签名）
- 说明: deploy/enterprise 下的 compose、入口代理和 memento.sh：init 生成随机密码密钥并取当前发布的镜像版本，up 启动，backup/restore 备份恢复（恢复前先备份），upgrade 先备份再升级，bundle/load 做离线镜像包。仓库配了签名证书时发版自动做 Mac Developer ID 签名加公证、Windows 签名，没配时和原来一样。说明在 docs/enterprise.md。
- 代码: `deploy/enterprise/docker-compose.yml`, `deploy/enterprise/memento.sh`, `deploy/enterprise/Caddyfile`, `.github/workflows/desktop-release.yml`, `apps/desktop/scripts/after-sign.cjs`, `docs/enterprise.md`
- 要求: `cmd_backup` @ `deploy/enterprise/memento.sh`; `MAC_CSC_LINK` @ `.github/workflows/desktop-release.yml`; `MEMENTO_DEVELOPER_ID` @ `apps/desktop/scripts/after-sign.cjs`; `Authority=Developer ID Application` @ `apps/desktop/src/main.ts`

### R-WS-EXEC-STOP 代码所在设备上一条慢命令或停掉的任务不卡住后面的命令
- 来源: 用户 11-17「我发现有时候远程任务执行命令会卡住啊」（vps3 上 Antigravity 在 Mac 上跑 `find ~ -maxdepth 4` 没结束，任务停掉后它还在跑，后面的 `ls -d` 和别的任务的命令都排在它后面等到 30 分钟超时）
- 来源补充: 用户 11-18「vps3上调用Mac mini执行命令有时还是会卡住」（一条在 ~/.memento 等目录里逐个文件搜密钥的 python 跑了 10 分钟，同一仓库后面的命令全在等）
- 来源补充: 用户 11-18「感觉远程执行任务还是有点问题，有些命令还是会卡住」（命令在那台设备上早跑完了，结果却没回来：它跑命令期间和服务器重连过，答复落到另一个 api 副本上被丢掉，执行机一直等到 32 分钟超时）
- 说明: 代码所在设备上同一仓库最多 4 个检出目录同时跑命令：一个检出目录有命令在跑，下一条（不论哪个任务）用空闲的那个，任务尽量回到上次用的检出目录，`memento-source get` 先在任务用过的检出目录里找；4 个都忙才排队，结果里注明等了多久。提交仍一次一个。执行机上的任务结束或被停掉时，通知那台设备结束这个任务正在跑的命令、跳过还在排队的；智能体放弃某一条命令（工具调用被停、memento-source 进程被杀）只结束那一条，任务后面的命令照常执行。命令跑着时那台设备重连到了别的 api 副本，答复按请求号里的副本名转回发出请求的副本；服务端等答复期间每分钟问一次那台设备这条命令的状态：已跑完就用它留着的答复（原答复丢了也拿得到），那边没有这条命令（Memento 重启过）立刻报错，设备断开超过 2 分钟也报错，不再等满 30 分钟。那台设备在替别的设备跑命令时不切换内网/公网线路。
- 代码: `packages/daemon/src/source-exec.ts#acquireCheckout`, `packages/daemon/src/source-exec.ts#cancelSourceExec`, `packages/daemon/src/source-exec.ts#execOnSource`, `packages/daemon/src/source-exec.ts#SourceExecBridge`, `packages/daemon/src/ws-client.ts`, `server/server/services/workspace_relay.py#_exec_cancel`, `server/server/services/workspace_relay.py#_await_source`, `server/server/services/ws_manager.py#handle_file_response`, `packages/daemon/src/source-exec.ts#execStatus`
- 测试: `packages/daemon/test/source-exec.test.ts#tells the server, waiting on a command, whether it still runs here and its answer once done`, `server/tests/test_workspace_relay.py#test_an_answer_over_a_newer_connection_on_another_replica_reaches_the_one_that_asked`, `server/tests/test_workspace_relay.py#test_a_command_whose_answer_will_never_come_ends_the_wait`, `packages/daemon/test/source-exec.test.ts#a slow command takes one checkout; other commands, of any task, run beside it in another`, `packages/daemon/test/source-exec.test.ts#get finds a file a task's command made in whichever checkout it ran in`, `packages/daemon/test/source-exec.test.ts#a timed-out command's children die with it`, `packages/daemon/test/source-exec.test.ts#giving up on one command stops just that one; the task's next command still runs`, `server/tests/test_workspace_relay.py#test_a_stopped_tasks_commands_are_stopped_on_the_source`
- 要求: `"exec_cancel": _exec_cancel` @ `server/server/services/workspace_relay.py`; `"workspace_exec_cancel"` @ `packages/daemon/src/ws-client.ts`; `"workspace_exec_status"` @ `packages/daemon/src/ws-client.ts`; `cl.op("ws.reply", self._op_reply)` @ `server/server/services/ws_manager.py`

### R-WS-EXEC-REMIND 远程智能体在代码所在设备上的命令默认不拦截，有风险的推送提醒
- 来源: 用户 11-19「执行命令权限能放开吗，有些没法操作」「全部改成推送提醒吧，尽量不拦截」（Antigravity 在 vps3 上经 memento-source 读 VPS 上的证书配置、写 nginx 配置，都因「以 root 权限执行」「修改系统全局配置」被服务端拒绝）
- 说明: `MEMENTO_REMOTE_EXEC_POLICY` 默认 off：memento-source 的命令和 put 写项目以外的文件都不拦，风险规则判为 danger / critical 的（sudo、改 /etc、rm -rf、写 .ssh/.env 等）照常执行，同时记到智能体的任务上并推送到手机（找不到任务就直接推送）。catastrophic 另外拦下会毁掉那台电脑的命令（格式化磁盘、删整个主目录或系统目录、让它关机重启；`ssh 主机 "…"` 引号里在别的主机上执行的部分不算）；strict 是 11-19 以前的做法，有风险的命令和敏感位置一律拒绝。企业部署模板设为 catastrophic。
- 代码: `server/server/services/workspace_relay.py#_refusal`, `server/server/services/workspace_relay.py#_tell_risky`, `server/server/services/workspace_relay.py#_put`, `server/server/services/risk_policy.py#classify_catastrophic`, `server/server/config.py`
- 测试: `server/tests/test_workspace_relay.py#test_only_what_wrecks_the_source_is_refused_unless_the_deployment_says_otherwise`, `server/tests/test_workspace_relay.py#test_a_file_outside_the_project_is_written_on_the_source_and_a_sensitive_one_tells_the_phone`, `server/tests/test_workspace_relay.py#test_a_risky_command_is_recorded_on_the_task_and_pushed`, `server/tests/test_workspace_relay.py#test_a_strict_deployment_still_refuses_sensitive_files`
- 要求: `remote_exec_policy: str = "off"` @ `server/server/config.py`; `notify_service.spawn(_tell_risky(` @ `server/server/services/workspace_relay.py`

### R-PROJECT-EXCLUDE 测试用的项目可以不采集，已采集的数据和从中学到的东西一并清掉
- 来源: 用户 11-17「目前默认是所有项目都抓取的，如果用户有些项目是用来测试的，不想它被抓取……对应的记忆，画像等也要删除」
- 说明: 在项目页点「不再采集」或在 设置 → 采集配置 里加项目名（支持 test-* 这样一次排除一类，名字按画像作用域的口径比，忽略大小写、空格、- 和 _）。所有设备、所有工具、任何版本的采集端都立即生效：服务端入库时丢弃，并在 sync_state 上标记，后续增量照收照丢、不要求整段重传。已采集的会话文件连同消息、检索索引、向量、知识图谱观察删除；相关记忆和避坑、技能、项目范围的纠正、自动待办停用，画像（发布版和草稿）里的「## 项目：」小节移除，这些都记在名单里，「恢复采集」时放回；恢复后设备上的会话有新内容时整段重新采上来。删除前弹窗列出会删什么、停用什么。
- 代码: `server/server/services/project_exclusion.py#purge`, `server/server/services/project_exclusion.py#restore`, `server/server/services/project_exclusion.py#drop_excluded`, `server/server/services/project_exclusion.py#dropped_slice`, `server/server/api/collect_exclusions.py`, `server/server/api/ingest.py#_ingest_one`, `apps/web/src/components/collector/ProjectExclusion.tsx#ExcludeProjectDialog`, `apps/web/src/components/collector/ProjectExclusion.tsx#ExcludedProjectsCard`
- 测试: `server/tests/test_project_exclusion.py#test_excluding_a_project_takes_away_what_it_left_and_stops_collecting_it`, `server/tests/test_project_exclusion.py#test_a_star_takes_every_project_it_fits`, `apps/web/test/project-exclusion.test.tsx#shows the preview first and excludes only on confirm`
- 要求: `drop_excluded(` @ `server/server/services/ingest_service.py`; `<ExcludeProjectDialog` @ `apps/web/src/app/projects/[id]/page.tsx`; `<ExcludedProjectsCard />` @ `apps/web/src/components/collector/CollectorView.tsx`

### R-RUN-OUTLIVES-PAGE 运行不因页面关闭、切后台、发版而中断
- 来源: 记忆「智能体运行状态容易丢的根因与交接修法」（10-28 查实四个根因）；CLAUDE.md「发版时旧 pod 会先等进行中的回答跑完」
- 代码: `server/server/services/ask_runs.py`, `server/server/services/ask_stream.py#_resume_direct_agent`
- 测试: `server/tests/test_ask_runs.py#test_run_keeps_going_after_reader_disconnects`, `server/tests/test_ask_runs.py#test_reattach_resumes_after_last_seen_id`, `server/tests/test_agent_run_states.py#test_resume_follows_the_task_already_on_the_device`, `server/tests/test_agent_run_states.py#test_attach_picks_up_a_task_that_ended_during_the_handover`

### R-QUOTA-PER-MODEL 额度按当前对话用的模型显示
- 来源: 用户 2026-11-14「额度能根据当前会话使用的模型显示吗，有的会话，像antigravity 里的多个模型额度是不一样的」
- 代码: `apps/web/src/lib/ask/model-limits.ts#modelQuotaOf`, `apps/web/src/app/ask/page.tsx#quotaModelId`, `apps/web/src/components/quota/AgentQuotaPopover.tsx#AgentQuotaPopover`
- 测试: `apps/web/test/model-limits.test.ts#gives the quota of the model a conversation runs on, not the default model's`
- 说明: 输入框上方收起的配置栏里，点智能体胶囊（如「Claude Code 94%」）打开额度详情，点栏的其它地方才展开配置；3b1f1013 曾去掉胶囊的点击，导致点它弹出配置表单（用户 2026-11-16 截图反馈）。
- 要求: `modelQuotaOf(quotasData` @ `apps/web/src/app/ask/page.tsx`; `/onClick=\{\(e\) => \{ if \(isAgentMode\) \{ e\.stopPropagation\(\)[^}]*setQuotaOpen\(true\)/` @ `apps/web/src/app/ask/page.tsx`

### R-QUOTA-AGY-GROUPS Antigravity 每个模型都显示额度，并显示各组的周额度和 5 小时额度
- 来源: 用户 2026-11-19「为什么antigravity的有些模型额度没显示，而且没有周额度使用量呢」（vps3 截图：Gemini 4 Neon/Argon 显示「额度未公开」）
- 说明: Gemini 4 Neon、Hydrogen、Orchestrator (Neon)、Gemini 3.8 Flash 共用 Gemini 模型的周额度和 5 小时额度，Claude 和 GPT 共用一组，Gemini 4 Argon 单独一个周额度。模型显示所在组里更紧的那个。没有桌面应用的设备按 agy 命令行 `agy -p /usage --output-format json` 读（retrieveUserQuotaSummary 只给 Claude 和 GPT 一组）；有应用的读它语言服务的 RetrieveUserQuotaSummary。过了重置时间的额度算满。
- 代码: `packages/daemon/src/quotas.ts#agyUsageSummary`, `packages/daemon/src/quotas.ts#quotaGroups`, `packages/daemon/src/quotas.ts#probeAntigravityCliQuota`, `apps/web/src/components/quota/AgentQuotaPopover.tsx#AgyQuotaGroup`
- 测试: `packages/daemon/test/quotas.test.ts#reads the Gemini models' and Gemini 4 Argon's weekly limits from the CLI's /usage (the quota API only has Claude and GPT)`, `packages/daemon/test/antigravity-language-server.test.ts#reads per-model quotas from the server the lookup found`
- 要求: `"/usage"` @ `packages/daemon/src/quotas.ts`; `quota_groups` @ `apps/web/src/components/quota/AgentQuotaPopover.tsx`

### R-MODEL-SWITCH 某个模型额度用完，能换同一工具的其它模型，三个工具都要支持
- 来源: 用户 2026-11-11「antigravity有多个模型可以选择啊……是不是应该可以切换模型？」「还有你目前只处理了antigravity，codex和Claude处理了吗」
- 代码: `packages/daemon/src/model-limits.ts#nextModel`, `packages/daemon/src/model-limits.ts#claudeModelLimit`, `packages/daemon/src/model-limits.ts#codexModelLimit`, `packages/daemon/src/agy-models.ts#agyQuotaMessage`
- 测试: `packages/daemon/test/model-limits.test.ts#next model: skips the family that ran out and ones still out, never Fable for Claude`, `packages/daemon/test/model-limits.test.ts#Codex: a model the account can't use is skipped for a day, like one that ran out`, `packages/daemon/test/antigravity-failover.test.ts#verifies getModelCandidates ordering for default, flash, and pro tiers`

### R-MODELS-DYNAMIC 模型列表从工具实际能力动态获取，不硬编码过时模型
- 来源: 记忆「模型列表须从工具实际能力动态获取，不得硬编码过时模型」；CLAUDE.md「模型版本信息不能硬编码，需随官方更新」
- 说明: 网页的 FALLBACK_AGENT_MODELS 只在设备还没上报能力时兜底。
- 代码: `packages/daemon/src/model-limits.ts#codexModels`, `packages/daemon/src/agy-models.ts#parseAgyModels`, `apps/web/src/lib/ask/cache.ts#FALLBACK_AGENT_MODELS`
- 测试: `packages/daemon/test/model-limits.test.ts#Codex models come from its cache in its own order, hidden ones left out`, `packages/daemon/test/antigravity-failover.test.ts#dynamically discovers Gemini 4 Argon and active default model from Antigravity Language Server RPC and caches locally`

### R-QUOTA-NO-RETRY 账号额度用完就停，不反复重试
- 来源: 避坑记录「Claude Code 会话额度耗尽后反复重试同一任务，全部失败……看到 session limit 提示后不要继续重试」
- 代码: `server/server/services/agent_limits.py#usage_limit_message`, `server/server/services/agent_limits.py#mark_usage_limit`
- 测试: `server/tests/test_agent_limits.py#test_the_quota_message_is_read_from_the_agents_errors`, `server/tests/test_agent_run_states.py#test_out_of_quota_says_so_and_keeps_the_session`

### R-PLAN-QUOTA-GATE 协作任务启动前定好设备、智能体、模型，额度不够的模型不派
- 来源: 心领神会「协作任务必须在启动前就把设备、agent、模型规划清楚，额度不够的模型直接不派发」；记忆（11-12）「规划/派发前现查额度」
- 代码: `server/server/services/plan_service.py#model_roster`, `server/server/services/plan_service.py#normalize_steps`
- 测试: `server/tests/test_plan_service.py#test_normalize_drops_limited_or_unknown_model`, `server/tests/test_plan_service.py#test_refresh_quotas_asks_stale_devices_and_waits_for_their_reports`, `server/tests/test_plan_service.py#test_model_roster_a_fresh_quota_read_outranks_a_noted_limit`

### R-RESUME-LABEL 只有从历史里挑的会话才叫「续」
- 来源: 用户 2026-11-14「我选择antigravity的项目新建一个回话，怎么会出现续会话的？」
- 代码: `apps/web/src/app/ask/page.tsx#sessionPicked`, `apps/web/src/components/ask/SessionResumeBanner.tsx#SessionResumeBanner`
- 要求: `sessionPicked ? (isZh ? "续: "` @ `apps/web/src/app/ask/page.tsx`; `picked ?` @ `apps/web/src/components/ask/SessionResumeBanner.tsx`

### R-PREVIEW-ONLY-EMPTY 会话预览只在服务端确认对话没有回合时显示
- 来源: 用户 2026-11-14「为什么初次选择续接某个设备某个项目某个会话时，会出现这种前续会话，要根治这种问题」
- 说明: 加载中的对话回合也是空的，不能拿它当"没有回合"；GET 缓存会让预览比回合先到。
- 代码: `apps/web/src/app/ask/page.tsx#emptyConvId`, `apps/web/src/lib/ask/sessions.ts#sessionMessagesToTurns`
- 测试: `apps/web/test/session-preview.test.ts#puts tool calls and their output on the assistant turn before them`, `apps/web/test/session-tool-cards.test.ts`
- 要求: `sessionPreview.convId === emptyConvId` @ `apps/web/src/app/ask/page.tsx`

### R-SESSION-TIMELINE 在工具自己的应用里接着聊的，也出现在续接它的对话里
- 来源: 用户 2026-11-16「能在两边接续，确实算是 memento 的一项实用功能」；issue #20：先在 Memento 发起 Antigravity 会话、再到 Antigravity 应用里接着聊，回到 Memento 后那些回合看不到，换会话再切回来也补不回来
- 说明: 会话（设备采集的完整记录，Memento 发的提问也在里面）是唯一完整的时间线；对话只多出 Memento 自己运行时才知道的东西。会话里不是 Memento 自己运行的问答，按时间并进对话、标上在哪个工具里说的；按运行的时间窗口（设备时钟差几分钟时按同一句问题）认出 Memento 自己的运行，不重复。并进来的回答和 Memento 自己的回答长得一样：一问一答，命令是一张卡片里「过程」的各步（用户 11-16「antigravity 里的对话每个命令都占一行，和 memento 里的不一样」）。会话一有新内容（采集）、对话一打开就对齐；对话正在运行时不并。
- 代码: `server/server/services/session_timeline.py#merge_session`, `server/server/services/session_timeline.py#fold_exchange`, `server/server/services/session_timeline.py#sync_conversation`, `server/server/services/session_timeline.py#schedule_for_document`, `server/server/api/ask_conversations.py#get_conversation`, `server/server/services/ask_store.py#append_conversation_turns`, `apps/web/src/components/ask/bubbles.tsx#OriginChip`
- 测试: `server/tests/test_session_timeline.py#test_an_answer_in_the_app_shows_as_one_answer_with_its_commands_as_steps_like_memento_s`, `server/tests/test_session_timeline.py#test_exchanges_in_the_app_go_in_between_mementos_runs_by_time`, `server/tests/test_session_timeline.py#test_a_device_clock_a_few_minutes_off_still_knows_memento_s_question`, `server/tests/test_session_timeline.py#test_turns_copied_from_the_session_before_are_not_copied_again`, `server/tests/test_session_timeline.py#test_an_exchange_still_being_written_is_rebuilt_not_repeated`, `server/tests/test_session_timeline.py#test_a_run_saved_after_its_copy_was_merged_replaces_the_copy`, `server/tests/test_session_timeline.py#test_the_app_s_exchange_comes_in_once_and_not_while_a_run_goes`
- 要求: `session_timeline.sync_quietly(cid` @ `server/server/api/ask_conversations.py`; `schedule_for_document(` @ `server/server/api/ingest.py`; `new_turns = fold_exchange(messages_to_turns(group)` @ `server/server/services/session_timeline.py`

### R-RESTORE-CONFIG 选中历史会话恢复当时的工具、项目、会话配置
- 来源: CLAUDE.md（memento）「选中历史会话要恢复当时的工具、项目、会话配置」
- 说明: 工具以回答记下的模式为准，AI 编排也算：AI 编排派出的任务带 binary claude / action shell，不能当成这个对话用的是 Claude Code 或终端（3b1f1013 曾这样把 AI 编排对话存成 Claude Code）。只有没记模式的老回答才从工具调用推断。
- 代码: `apps/web/src/lib/ask/cascade.ts#cascadeOf`, `apps/web/src/app/ask/page.tsx#applyCachedCascade`, `server/server/services/ask_store.py#infer_conversation_config`, `server/server/services/ask_store.py#append_conversation_turns`
- 测试: `apps/web/test/cascade.test.ts#takes every field from the conversation, empty ones included`, `apps/web/test/cascade.test.ts#tells a cleared project or session from one never saved`, `server/tests/test_ask_cascade.py#test_cleared_session_is_not_inferred_back_from_earlier_turns`, `server/tests/test_ask_cascade.py#test_an_answer_saved_as_ai_is_not_read_as_the_agent_it_dispatched`, `server/tests/test_conversation_page_recovery.py#test_an_ai_orchestrated_answer_keeps_the_conversation_in_ai_mode`

### R-CONFIG-LOCK 对话开始后不能再换智能体、设备、项目和会话
- 来源: 用户 2026-11-20「当我新起了一个会话以后，并有对话后是不是配置区域就不应该让用户换agent,项目，会话了，因为这样上下文会乱」
- 说明: 对话有了回合，它的回合就是这个智能体在这台设备、这个目录里的会话。之后智能体、设备、代码所在设备、项目、会话和工作目录都固定，不能再选；模型和思考强度照常能换（同一个会话可以换模型接着跑）。配置区显示一行说明和「新建对话」按钮，要用别的就新建对话。打开历史对话时按 R-RESTORE-CONFIG 恢复当时的配置，同样固定。
- 代码: `apps/web/src/lib/ask/config-lock.ts#conversationConfigLocked`, `apps/web/src/app/ask/page.tsx#handleSelectMode`, `apps/web/src/app/ask/page.tsx#handleDeviceChange`, `apps/web/src/components/ask/SessionResumeBanner.tsx#SessionResumeBanner`
- 测试: `apps/web/test/config-lock.test.ts#is locked once it has a turn, open to any choice before`, `apps/web/test/config-lock.test.ts#the agent, device, code device, project, session and folder can't be switched; model and effort still can`
- 要求: `conversationConfigLocked(turns)` @ `apps/web/src/app/ask/page.tsx`; `if (configLockedRef.current) return;` @ `apps/web/src/app/ask/page.tsx`

### R-DEVICE-SESSION-MAP 设备与会话映射正确：会话只在它所在的设备上续
- 来源: CLAUDE.md（memento）「设备与会话映射正确」
- 说明: 会话号只认智能体自己报的（执行脚本在 stderr 上的「session id:」一行），不从回答和工具输出里找；不是会话号的值不续接、改开新会话。2026-11-16 Antigravity 读到的源码里有 `session_id: ""`，守护进程把 `\"\"` 当成会话号，之后每一轮都卡 20 秒报「Timed out waiting for Antigravity response log」。
- 代码: `server/server/services/ask_stream.py#_session_elsewhere`, `server/server/services/ask_stream.py#_can_carry_session`, `packages/daemon/src/agent-stream.ts#cleanSessionId`, `packages/daemon/src/agy-runner/runner.ts#conversationExists`, `server/server/services/agent_ids.py#clean_session_id`, `server/server/services/agent_ids.py#reported_session_id`
- 测试: `packages/daemon/test/antigravity-task.test.ts#Antigravity task: ids the reply quotes never become the session; the runner's own report does`, `packages/daemon/test/antigravity-task.test.ts#Antigravity task: a conversation this device doesn't have goes on in a new one instead of waiting out a reply`, `packages/daemon/test/antigravity-runner.test.ts#doesn't resume what isn't a conversation here: says so in words the daemon takes for a missing session`, `server/tests/test_agent_ids.py#test_a_conversation_never_goes_on_in_text_taken_for_its_session`, `server/tests/test_agent_ids.py#test_a_turn_asked_with_a_broken_session_starts_a_new_one`, `server/tests/test_ask_cascade.py#test_session_on_another_device_is_not_resumed_there`, `server/tests/test_ask_cascade.py#test_session_on_the_device_picked_is_resumed`, `server/tests/test_ask_cascade.py#test_session_of_another_tool_is_not_resumed`, `server/tests/test_ask_ensure_by_session.py#test_looks_up_and_creates_under_a_lock_per_user_and_session`

### R-DEVICE-ENV-PROFILE 新会话拿到的环境信息是它实际所在设备的
- 来源: CLAUDE.md（memento）「设备与会话映射正确」；2026-11-17 设备选「自动」的任务落到 Mac 上，系统提示里的「目标设备就绪环境指纹画像」写的却是 vps3 的 linux (arm64)、用户 opc，还叫智能体不必再用 which/--version 核对
- 说明: 问答入口在选设备之前就取环境指纹，没指定设备或选「自动」时能力缓存返回第一台设备的数据。现在由 run_on_device 选定设备后按实际设备注入，只给新会话；没指定设备时一律不出指纹。
- 代码: `server/server/services/device_reports.py#get_device_environment_summary`, `server/server/services/orchestrator.py#_tool_run_on_device`
- 测试: `server/tests/test_device_env_fingerprint.py#test_no_profile_without_a_named_device`, `server/tests/test_device_env_fingerprint.py#test_auto_dispatch_tells_the_task_about_the_device_it_landed_on`, `server/tests/test_device_env_fingerprint.py#test_a_resumed_session_is_not_told_again`
- 禁止: `get_device_environment_summary` @ `server/server/services/ask_stream.py`

### R-TITLE-CONSISTENT 会话标题所有设备一致，以用户提问提取的标题为准
- 来源: CLAUDE.md（memento）「会话标题所有设备一致」；记忆「会话标题以用户提问提取的标题为唯一事实源，由守护进程写回 Antigravity 本地 SQLite 与注解文件并同步平台」
- 代码: `packages/daemon/src/antigravity.ts#extractUserTitleFromText`, `packages/daemon/src/antigravity.ts#updateAntigravitySessionTitle`, `server/server/services/ingest_service.py#_title_from_user_messages`
- 测试: `packages/daemon/test/antigravity-title.test.ts#updates SQLite db and annotations file and heals title`, `server/tests/test_title_healing.py#test_picks_first_real_message`, `server/tests/test_title_healing.py#test_real_titles_are_kept`

### R-DELETE-GONE-EVERYWHERE 删除的对话立即在所有页面、所有副本都看不到
- 来源: 用户 2026-11-14「会话列表里删除会话后，不会刷新，而且好像没有删除成功」
- 说明: 删除其实成功了；0.03 秒后的列表请求落到另一个 api 副本，拿回它进程内缓存里的旧列表。
- 代码: `server/server/services/cache.py#cache_delete_prefix`, `server/server/services/cache.py#_on_l1_bust`, `apps/web/src/app/ask/page.tsx#deletedConversationIds`
- 测试: `server/tests/test_cache_l1_bust.py#test_delete_prefix_tells_the_other_replicas`, `server/tests/test_cache_l1_bust.py#test_a_bust_from_another_replica_drops_this_ones_copy`
- 要求: `cluster.publish(_L1_BUST_CHANNEL` @ `server/server/services/cache.py`; `deletedConversationIds.has(` @ `apps/web/src/app/ask/page.tsx`

### R-REPLICA-STATE 会变的状态不放进单个 api 副本的内存
- 来源: CLAUDE.md（memento）「新代码不要把需要跨请求共享的状态放进模块级 dict / asyncio.Lock / 进程内后台循环……纯缓存（丢了能重算）可以留在进程内」
- 说明: 2026-11-14 按这条核对时查出微信扫码登录票据：票据经 L1 缓存读写，扫码回调落到另一个副本时，轮询的副本最多 15 秒还读到「待扫码」。已改为票据不走 L1。
- 代码: `server/server/services/cluster.py#publish`, `server/server/services/cache.py#cache_set`, `server/server/api/auth.py#_get_ticket_data`
- 测试: `server/tests/test_cache_l1_bust.py#test_a_login_ticket_scanned_on_another_replica_is_seen_here_at_once`
- 要求: `l1_ttl_seconds=0` @ `server/server/api/auth.py`; `l1=False` @ `server/server/api/auth.py`

### R-FOLLOWUP-NOT-LOST 追问不丢；送达的显示在回答里，不留在输入区
- 来源: 记忆（11-13）「修了追问丢失……没送达的改由服务端按对话保管」；用户 2026-11-14「追问送达以后怎么输入区还有那个追问的问题，及已送达，下一步读到」
- 代码: `server/server/services/ask_followups.py#add`, `server/server/services/ask_followups.py#note_steer`, `apps/web/src/lib/ask/followups.ts#deliveredFollowUps`, `apps/web/src/app/ask/page.tsx#waitingFollowUps`
- 测试: `server/tests/test_ask_followups.py#test_late_and_unsupported_are_kept_for_the_conversation`, `server/tests/test_ask_followups.py#test_finished_task_queues_it`, `server/tests/test_ask_followups.py#test_device_offline_queues_it`, `apps/web/test/followups.test.ts#lists what the agent took, from its steer events, then what's delivered but not reported yet`, `apps/web/test/followups.test.ts#puts a follow-up the agent could not take back into the queue, once`
- 要求: `deliveredFollowUps(` @ `apps/web/src/components/ask/bubbles.tsx`

### R-REPLY-VISIBLE 回答区不被输入区遮住，回答时跟到最底部
- 来源: 用户 2026-11-14「有后台任务的时候撑高的输入区域会遮盖回答区域」「回答问题时怎么不会自动滑动到页面最底下啊，有时还要手动往上滑一下」
- 说明: 只有用户自己往上滚才算离开底部；内容后来长高（代码高亮、图片、工具卡片）也要跟。展开的配置完整显示（用户 2026-11-16「展开配置项只弹开一半，下面的要向下滑动才能看到」），会话上下文的消息列表在自己 170px 里滚动，外层只兜底（桌面 72dvh、手机键盘弹起 40dvh）。
- 代码: `apps/web/src/app/ask/page.tsx#chatScrollRef`, `apps/web/src/app/ask/page.tsx#userScrolledAwayRef`
- 要求: `ro.observe(content)` @ `apps/web/src/app/ask/page.tsx`; `ask-footer-extras` @ `apps/web/src/app/ask/page.tsx`; `maxHeight: viewportBottomOffset > 0 ? "40dvh" : "min(72dvh, 760px)"` @ `apps/web/src/app/ask/page.tsx`; `maxHeight: "min(170px, 25vh)"` @ `apps/web/src/components/ask/SessionResumeBanner.tsx`
- 禁止: `/distFromBottom > 80\) \{$/` @ `apps/web/src/app/ask/page.tsx`

### R-SHOW-TIMES 对话显示发送和回复时间
- 来源: CLAUDE.md（memento）「对话显示发送和回复时间」
- 代码: `apps/web/src/components/ask/bubbles.tsx#replyTime`, `apps/web/src/components/ask/bubbles.tsx#startTime`
- 测试: `apps/web/test/turns.test.ts#normalizes and formats ISO timestamp`, `apps/web/test/conversation-agent.test.ts#handles standard ISO strings with timezone offsets`

### R-NO-STDERR 回复里不输出无用的 stderr
- 来源: CLAUDE.md（memento）「回复里不要输出无用的 stderr」
- 代码: `server/server/services/ask_stream.py#_clean_stderr_noise`, `apps/web/src/lib/ask/sessions.ts#cleanToolOutput`
- 测试: `packages/daemon/test/console-text.test.ts`, `apps/web/test/session-tool-cards.test.ts`

### R-CLAUDE-TUI-SYNC memento 里的 Claude Code 对话要能在 Claude Code 的 TUI 里续上
- 来源: CLAUDE.md（memento）「Claude Code 在 memento 里的对话要同步到 Claude Code 的 TUI 会话」；记忆「sdk-cli 会话被 resume 列表隐藏」
- 代码: `packages/daemon/src/task-runner.ts#claudeClientEnv`, `packages/daemon/src/session-sync.ts#fetchClaudeSession`, `packages/daemon/src/session-sync.ts#claudeProjectDirName`
- 测试: `packages/daemon/test/session-sync.test.ts#fetches the session into this directory's folder so claude -r resumes it`, `packages/daemon/test/session-sync.test.ts#Claude Code's folder for a directory dashes everything but letters and digits`
- 禁止: `CLAUDE_CODE_ENTRYPOINT: "sdk-cli"` @ `packages/daemon/src/task-runner.ts`

### R-NEWCHAT-WORKS 新建对话用最新配置，并保证能成功
- 来源: CLAUDE.md（memento）「新建对话用最新配置并保证成功」
- 代码: `apps/web/src/app/ask/page.tsx#startNewChat`, `server/server/api/ask.py#ask`
- 测试: `apps/web/test/cache-writes.test.ts#does not bring back a snapshot cleared for a new chat`, `server/tests/test_ask_cascade.py#test_not_sent_uses_the_conversations`

### R-UPGRADE-SAFE 客户端升级要成功，不打断运行中的任务，升级后移除旧版本
- 来源: CLAUDE.md（memento）「检查更新升级必须成功，升级后移除旧版本」；记忆（11-14 v1.0.129）「升级把运行中任务甩成孤儿进程」
- 代码: `apps/desktop/src/main.ts#runningAgentTasks`, `apps/desktop/src/main.ts#setupUpdater`, `packages/daemon/src/self-update.ts`
- 测试: `packages/daemon/test/self-update.test.ts#builds a new release beside the running one, waits for tasks, then swaps it in`, `packages/daemon/test/running-tasks-report.test.ts#counts a task from receipt to its end, not only while its process runs`, `server/tests/test_agent_limits.py#test_stop_orphaned_agent_tasks_cancels_on_the_device`

### R-CLIENT-VERSION-REAL 侧边栏显示客户端实际版本，不被服务端最新版本盖掉
- 来源: 记忆「侧边栏版本号必须渲染客户端实际版本，不得被服务端最新版本覆盖」
- 代码: `apps/web/src/components/layout/Sidebar.tsx#appVersion`
- 测试: `apps/web/test/build-update.test.ts`

### R-APP-NAME 客户端名称不带 desktop 后缀
- 来源: CLAUDE.md（memento）「名称不带 desktop 后缀」
- 代码: `apps/desktop/package.json`, `apps/desktop/electron-builder.yml`
- 禁止: `/productName.*[Dd]esktop/` @ `apps/desktop/package.json`, `apps/desktop/electron-builder.yml`

### R-MOBILE-DEVICE-SCOPED 手机端切换设备只拉该设备的项目和对话
- 来源: CLAUDE.md（memento）「手机端切换设备只拉该设备的项目和对话」
- 代码: `apps/web/src/lib/api-client.ts#listProjects`
- 测试: `server/tests/test_device_filter.py`

### R-BLUEPRINT-NEWEST 蓝图只来自设备上传，多份设备副本取代码最新的那份
- 来源: 记忆（11-09）「每台设备给自己的检出上传一份 PROJECT_BLUEPRINT.md……旧检出会盖过新的」
- 代码: `server/server/services/blueprint_pick.py#pick_freshest`, `server/server/services/blueprint_pick.py#is_fresher`
- 测试: `server/tests/test_blueprint_pick.py#test_newest_code_wins_over_last_synced`, `server/tests/test_blueprint_pick.py#test_project_api_takes_the_newest_of_its_own_copies`

### R-CODE-BLUEPRINT-NAME 代码蓝图叫 CODE_BLUEPRINT.md，和业务蓝图成对；旧名字照常能读，旧客户端不被打断
- 来源: 用户 2026-11-15「project blueprint 改为code blueprint吧」
- 说明: 读取方（服务端、MCP、个人蓝图、心领神会）两个名字都认，同一项目两份时取代码最新的；1.0.134 之前的客户端只认旧名字，服务端按 X-Collector-Version 给它们最后一版写旧名字的生成器（scripts/legacy/），否则它们的守护进程每轮都找不到蓝图、反复重建、也不再上传。新生成器把自己以前写的 PROJECT_BLUEPRINT.md 挪成新名字（手写的不动），已入库的在下次提交时由钩子一起提交。由旧客户端的守护进程（MEMENTO_DESKTOP_VERSION < 1.0.134）启动时，新生成器按旧方式写旧名字、不往 ~/.memento/scripts 同步：memento 仓库自带的新生成器曾借着旧守护进程把整台设备换成新名字，旧守护进程随即反复重建、停止上传。
- 代码: `packages/daemon/src/blueprint/meta.ts#BLUEPRINT_FILE`, `packages/daemon/src/blueprint/meta.ts#drivenByOldDaemon`, `packages/daemon/src/blueprint/repo.ts#writeBlueprint`, `server/server/services/blueprint_pick.py#code_blueprint_path`, `server/server/api/profile.py#_wants_legacy_generator`, `packages/mcp/src/server.ts#isCodeBlueprintPath`
- 测试: `server/tests/test_code_blueprint_rename.py#test_clients_before_1_0_134_keep_the_generator_that_writes_the_old_name`, `server/tests/test_code_blueprint_rename.py#test_both_names_by_the_whole_file_name`, `packages/daemon/test/blueprint-auto.test.ts#moves a committed PROJECT_BLUEPRINT.md to CODE_BLUEPRINT.md in the next commit`, `packages/daemon/test/blueprint-generator.test.ts#moves its own untracked PROJECT_BLUEPRINT.md to CODE_BLUEPRINT.md`, `packages/daemon/test/blueprint-generator.test.ts#run by an old client's daemon, writes the old name and title and leaves ~/.memento/scripts alone`
- 禁止: `/ilike\("%PROJECT_BLUEPRINT\.md"\)/` @ `server/server/`
- 要求: `COPY scripts/legacy/` @ `server/Dockerfile`

### R-USER-BLUEPRINT-BUSINESS 个人蓝图读各项目的业务蓝图
- 来源: 用户 2026-11-15「做吧」（接上文：个人蓝图的核心业务版图要用业务蓝图里的术语和流程，比按项目简介套通用分类准）
- 说明: 业务蓝图的术语、流程参与主领域判断（权重 1.5，介于项目简介 2 和技术栈 1 之间），第 3 节列出每个项目的业务蓝图核对结果、术语和流程，画像里有规则但还没有业务蓝图的项目也列出来。
- 代码: `server/server/services/user_blueprint_service.py#_business_digest`, `server/server/services/user_blueprint_service.py#_business_portfolio_lines`
- 测试: `server/tests/test_code_blueprint_rename.py#test_per_project_business_lines_and_the_new_code_blueprint_name`

### R-DOCS-WRITE-LIGHT documents 表上不加大的 GIN / 表达式索引
- 来源: CLAUDE.md（memento）「不要往 documents 上加大的 GIN / 表达式索引……要索引文档内容就放到单独的表里」
- 说明: documents 每次同步都改 synced_at，更新做不了 HOT，每个索引都要写。全文索引在 document_search 表；documents 上只留标题、路径两个短字段的三元组 GIN（启动 SQL 里建）。
- 代码: `server/server/db/models.py#DocumentSearch`, `server/server/services/fulltext.py`, `server/server/main.py`
- 禁止: `/Index\("idx_documents_[^"]*".*postgresql_using\s*=\s*"(gin|gist)"/` @ `server/server/db/models.py`; `/ON documents USING (gin|gist) \((?!title gin_trgm_ops\)|relative_path gin_trgm_ops\))/i` @ `server/server/`

### R-PUBLIC-REPO-CLEAN 公开仓库里没有内网地址和密钥
- 来源: CLAUDE.md「公开仓库 → 不要往仓库里放任何 Secret」；全局铁律「公开文件中不得包含内网 IP 等内部基础设施信息」
- 代码: `deploy/k8s/kustomization.yaml`, `CLAUDE.md`
- 禁止: `/\b192\.168\.\d{1,3}\.\d{1,3}\b/` @ `deploy/`, `.github/`, `CLAUDE.md`, `README.md`, `server/server/`, `apps/web/src/`, `packages/daemon/src/`; `/\b10\.42\.\d{1,3}\.\d{1,3}\b/` @ `deploy/`, `CLAUDE.md`

### R-NO-CONFIGMAP-HOTFIX 不用 ConfigMap 挂载覆盖镜像里的代码
- 来源: CLAUDE.md「不要用 ConfigMap 挂载覆盖镜像里的代码文件做热修复」（2026-10-13 的补丁让三个文件的改动长期不生效）
- 代码: `deploy/k8s/api.yaml`
- 禁止: `/^\s*configMap:/` @ `deploy/k8s/`

### R-CI-KUSTOMIZE-PINNED CI 装 kustomize 用固定版直链，不用 install_kustomize.sh
- 来源: CLAUDE.md「不要改回 install_kustomize.sh——它查 GitHub API，共享 runner 上会撞限流导致部署失败」
- 代码: `.github/workflows/deploy.yml`
- 禁止: `/^\s*[^#\s].*install_kustomize\.sh/` @ `.github/workflows/`

### R-COMMIT-CONVENTION 提交用中文 Conventional Commits，不加 Claude 共同作者尾注，历史保持线性
- 来源: CLAUDE.md（memento）「提交用中文 Conventional Commits，不加 Claude 共同作者尾注；历史保持线性，用 git rebase 不用 merge commit」
- 类型: 协作约定
- 说明: 推送前 `git pull --rebase`，不产生 merge commit；提交说明（含正文）里不写会让 GitHub 跳过流水线的那几个字。

### R-DEPLOY-AFTER-CI 部署流水线必须等 CI 通过
- 来源: CLAUDE.md（memento）「部署流水线必须等 CI 通过」
- 类型: 协作约定
- 说明: 镜像和 CI 同时构建，但回写镜像 tag（真正上线）的 bump 任务等 wait-ci 通过才跑。
- 代码: `.github/workflows/deploy.yml`
- 要求: `needs: [changes, wait-ci, build]` @ `.github/workflows/deploy.yml`

### R-DEPLOY-BUMP-RACE 回写镜像 tag 撞车时在最新 main 上重来，不把线上退回旧提交
- 来源: CLAUDE.md（memento）「部署流水线必须等 CI 通过」「改动需应用到所有 pod，并确认发布」；2026-11-17 被取消的旧 run 在取消前已推出 server 的回写，新 run 改的是同一行，rebase 冲突、三次重试都失败，03480911 的网页没上线
- 说明: bump 推送失败时放弃这次 rebase，在最新的 main 上重新改 tag；main 上已是更新提交的镜像不覆盖（用 compare 接口判断先后，判断不了就报错停下）；verify 只等实际回写成本次提交的镜像。
- 代码: `.github/workflows/deploy.yml`
- 测试: `server/tests/test_deploy_bump.py#test_goes_through_when_a_cancelled_run_pushed_the_same_line_first`, `server/tests/test_deploy_bump.py#test_a_late_older_run_never_moves_production_back`, `server/tests/test_deploy_bump.py#test_stops_when_it_cannot_tell_which_commit_is_newer`
- 要求: `pin check` @ `.github/workflows/deploy.yml`

### R-ALL-TYPESCRIPT 客户端全 TypeScript，Electron + React，不混入 Flutter、Tauri 等框架
- 来源: CLAUDE.md（memento）「全 TypeScript，Electron + React（参考 Paseo），不要混入 Flutter、Tauri 等框架」；记忆「客户端迁移 TypeScript」（阶段 5 起设备上不要 Python）
- 代码: `apps/desktop/package.json`, `packages/daemon/src/index.ts`
- 禁止: `/"@tauri-apps\//` @ `apps/desktop/package.json`, `apps/web/package.json`, `apps/mobile/package.json`, `packages/daemon/package.json`; `/^\s*flutter:/` @ `apps/`

### R-SELF-EVOLVE 越用越了解用户、能自进化
- 来源: CLAUDE.md（memento）「希望工具越用越了解用户、能自进化」；记忆「越用越聪明核查（10-27）」
- 说明: 纠正当场学习并跟踪是否学会，每晚复盘（dreaming）沉淀规则、避坑和技能，检索评测集每周回归（每天检查、缺了次日补跑、失败推送）。只有用户亲手打的话才算用户原话：memento 自己发给智能体的提示词（业务蓝图生成、执行机前言、续接桌面会话的前文历史）和 Antigravity 生图子任务的派活与回报不算纠正、不进提问数（11-23 查实上周 82 次纠正里 28 次是前者；11-24 查实 14 天里 378 条是后者）；没被用过也没再遇到的坑 30 天后休眠。
- 代码: `server/server/services/correction_service.py`, `server/server/services/dreaming_service.py`, `server/server/services/dreaming_voice.py#clean_user_voice`, `server/server/services/eval_service.py`, `server/server/services/guidance_service.py`, `server/server/services/memory_lifecycle.py#sweep_dormant`, `server/server/tasks/learning_tasks.py#_evaluate`
- 测试: `server/tests/test_title_healing.py`, `server/tests/test_dreaming_service.py#test_clean_user_voice_drops_prompts_memento_sends_itself`, `server/tests/test_dreaming_service.py#test_clean_user_voice_drops_antigravity_image_subagents`, `server/tests/test_corrections.py#test_a_daily_report_request_counts_as_upfront`, `server/tests/test_eval_grounding.py#test_checked_daily_but_run_once_a_week`, `server/tests/test_memory_sweep.py#test_pitfalls_never_used_sleep_sooner`
- 要求: `_GENERATED_PROMPT_RE` @ `server/server/services/dreaming_voice.py`; `_SUBAGENT_IMAGE_REPORT_RE` @ `server/server/services/dreaming_voice.py`; `GENERATED_PROMPT_SQL_RE` @ `server/server/services/learning_eval_service.py`; `SUBAGENT_IMAGE_SQL_RE` @ `server/server/services/learning_eval_service.py`

### R-PLAN-THEN-FINISH 规划周全后一次性全部完成，追求好用，界面高级精致
- 来源: CLAUDE.md（memento）「规划周全后一次性全部完成，追求好用；界面高级精致」
- 类型: 协作约定
- 说明: 做之前先把范围、改动点和验证方式想清楚，做完逐项验证再交付；界面字体只用系统字体（技能 system-ui-fonts）。

### R-UI-COMMERCIAL 界面像成熟商业产品：统一外壳、平实文案、不用 emoji 当图标
- 来源: 用户 11-16「要美观、大气、有质感，是一款成熟的商业化产品」「全部都做吧」
- 说明: 顶栏只放页面标题和本页操作，语言、界面风格收在头像菜单；可见文字不用 emoji 当图标（统一线性图标），不写「全息注入」「热守护」这类炫技词、不写死假数据；状态色用 --aurora-success/warn/danger/info；内容页统一 max-w-6xl；加载用骨架屏；隐私政策和帮助页也用应用内版式（TopBar + 卡片 + 主题色，11-17 起），不登录也能打开（登录页和 App Store 都链接它们），未登录时补品牌头和边距；存成 JSON 的记忆（场景心智）在准则树和 MEMORY.md 里按名称、心智、关键词排版，不直接显示原始 JSON（11-17）；头像菜单在网页、手机和桌面客户端都是同一个页面内面板（11-17 起不再弹系统原生菜单，原生菜单只能平铺一长串、改不了样式），面板挂在页面最外层、实底不透出侧栏，内容为身份卡、两列快捷入口、外观设置、底部切换服务器与退出登录。
- 代码: `apps/web/src/components/layout/Header.tsx`, `apps/web/src/components/UserMenu.tsx#SegmentRow`, `apps/web/src/app/not-found.tsx`, `apps/web/src/components/aurora/primitives.tsx#Skeleton`, `apps/web/src/components/layout/PublicPageFrame.tsx#PublicPageFrame`
- 测试: `apps/web/test/memory-entity.test.ts#reads the JSON as name, mindset, keywords and project instead of printing it`, `server/tests/test_readable_memory.py#test_a_scenario_reads_as_a_sentence`, `apps/web/test/ui-polish-guard.test.ts#visible text doesn't use emoji as icons`, `apps/web/test/ui-polish-guard.test.ts#the top bar has no language or skin switcher`, `apps/web/test/user-menu.test.tsx#opens the same panel in the desktop app, on top of the page, and closes on an outside click`
- 禁止: `popupNativeMenu` @ `apps/web/src/components/UserMenu.tsx`; `契合度 99.8%` @ `apps/web/src/app/memory/persona/page.tsx`; `<SkinPicker` @ `apps/web/src/components/layout/Header.tsx`; `bg-gradient-to-r` @ `apps/web/src/app/support/page.tsx`; `text-purple-400` @ `apps/web/src/app/privacy/page.tsx`
- 要求: `"/privacy",` @ `apps/web/src/lib/auth-context.tsx`; `"/support",` @ `apps/web/src/lib/auth-context.tsx`; `<PublicPageFrame>` @ `apps/web/src/app/privacy/page.tsx`; `<PublicPageFrame>` @ `apps/web/src/app/support/page.tsx`

### R-LOGIN-PERSIST 客户端登录永久记住
- 来源: CLAUDE.md（memento）「客户端登录永久记住」
- 说明: 网页和桌面端把登录凭据存在持久的 localStorage，过期前自动续期；桌面端窗口用持久分区，重启不丢。
- 代码: `apps/web/src/lib/auth-context.tsx#AuthProvider`, `apps/web/src/lib/api-client.ts#getApiBase`, `apps/desktop/src/main.ts#webToken`
- 要求: `/api/auth/refresh` @ `apps/web/src/lib/api-client.ts`

### R-MENU-KEEPALIVE 记住上次菜单状态，切换菜单不重新加载
- 来源: CLAUDE.md（memento）「记住上次菜单状态，切换不重新加载」
- 代码: `apps/web/src/components/layout/RouteKeepAlive.tsx`, `apps/web/src/app/client-layout.tsx`
- 测试: `apps/web/test/route-keepalive.test.tsx#keep a hidden page on the route it was left at, and tell it when it's back`, `apps/web/test/route-keepalive.test.tsx#pause hidden pages other than the ask page, keeping their state`

### R-MAC-TRAY Mac 客户端支持最小化到托盘，关窗口不退出
- 来源: CLAUDE.md（memento）「Mac 支持最小化到托盘」
- 代码: `apps/desktop/src/main.ts#refreshTray`
- 要求: `win.on("minimize"` @ `apps/desktop/src/main.ts`; `event.preventDefault();` @ `apps/desktop/src/main.ts`

### R-THINKING-FULL 思考过程始终铺满显示，回答正文字号统一
- 来源: CLAUDE.md（memento）「思考过程始终铺满全屏」「回答正文字号统一」；用户 11-16「思考左侧的紫色竖线要去掉，不好看」
- 说明: 思考块推演中和推演完都展开、宽度铺满，只有用户点胶囊才收起（还没有思考内容时只显示标题行，不画只有「…」的空框，11-26）；思考、回答正文、段落和列表都是 14px。10-31 的 5af514f1（无关的检索改动）曾把它改回"推演完自动收拢"，11-16 改回并补测试。
- 代码: `apps/web/src/components/ask/bubbles.tsx#ThinkingBlock`, `apps/web/src/components/ask/bubbles.tsx#AssistantBubble`, `apps/web/src/components/viewers/MarkdownViewer.tsx`
- 测试: `apps/web/test/ask-reading-and-persona-rules.test.tsx#shows the whole thinking text after thinking is done`, `apps/web/test/ask-reading-and-persona-rules.test.tsx#paragraphs and list items of an answer are all 14px`
- 禁止: `userToggled ? manualExpanded : Boolean(isLive)` @ `apps/web/src/components/ask/bubbles.tsx`; `borderLeft: "2.5px solid var(--aurora-accent)"` @ `apps/web/src/components/ask/bubbles.tsx`

### R-PASTE-IMAGE-ONCE 粘贴图片不重复
- 来源: CLAUDE.md（memento）「粘贴图片不重复」
- 说明: 输入框自己的粘贴处理和窗口级粘贴只走一个；同一张图（同 dataUrl）只附一次。
- 代码: `apps/web/src/app/ask/page.tsx#handlePaste`
- 要求: `!existingUrls.has(img.dataUrl)` @ `apps/web/src/app/ask/page.tsx`

### R-MEDIA-VIEW 图片可点击放大；视频可预览、全屏、播放后缓存；工作台能看图片和 ppt/excel/word/md 等产物
- 来源: CLAUDE.md（memento）「图片可点击放大；视频可预览、可全屏、播放后缓存；工作台能查看图片和 ppt/excel/word/md 等产物」
- 说明: 视频整片缓冲完或看完后才存进本地缓存，开播时不另起整片下载（11-24 查实它和播放抢公网入口约 3.25 Mbps 的带宽，演播台必卡）。
- 代码: `apps/web/src/components/viewers/ImageViewerModal.tsx#ImageViewerModal`, `apps/web/src/components/viewers/MediaPreview.tsx`, `apps/web/src/lib/video-cache.ts#cacheVideoInBackground`, `apps/web/src/components/viewers/OfficePreview.tsx`, `apps/web/src/lib/office-preview.ts`, `apps/web/src/components/viewers/MediaInspectorPanel.tsx`
- 测试: `apps/web/test/video-player-fullscreen.test.tsx#clicking center '点击放大全屏播放' badge triggers fullscreen toggle and playback`, `apps/web/test/video-cache.test.tsx#caches once after the first playback (not at play start)`, `apps/web/test/office-preview.test.ts#places shapes on the slide`, `apps/web/test/office-preview.test.ts#reads sheets with shared strings`, `apps/web/test/markdown-viewer.test.ts`, `apps/web/test/workbench-links.test.ts`

### R-LLM-IN-PROFILE 大模型配置放在个人设置里
- 来源: CLAUDE.md（memento）「大模型配置放在个人设置里」
- 代码: `apps/web/src/components/profile/LLMSettingsView.tsx#LLMSettingsView`, `apps/web/src/app/profile/page.tsx`
- 要求: `LLMSettingsView` @ `apps/web/src/app/profile/page.tsx`

### R-PERSONA-ONBOARD 个人画像首次进入引导设性别和卡通形象，可上传照片生成，默认全屏 3D 动画，手机端完整显示
- 来源: CLAUDE.md（memento）「个人画像首次进入引导设置性别和卡通形象，可上传照片生成，默认全屏动画，3D 默认不选中，手机端自动缩放完整显示」；11-16 用户改为默认 3D：「个人画像那里改成3d的吧，其它两个3d，这个2d的看着有点奇怪」
- 说明: 首次进入（服务端没形象、本机没跳过）弹一次引导，跳过后把默认形象存回服务端；舞台默认面板收起（全屏动画）、默认 3D（和长期记忆、技能进化一致），2D 可手动切换；3D 形象按选的预设现场搭出来（发型、服装、眼镜/目镜/耳机、形象环都跟预设的三个特点走，颜色用自己的主题色和服装色），只有硅基智能体用机器人模型（11-17 起，之前男女都是同一个通用盔甲人物）；弹窗在手机上可滚动、舞台高度按视口缩放。
- 代码: `apps/web/src/lib/persona/onboarding.ts#shouldOfferAvatarOnboarding`, `apps/web/src/lib/persona/onboarding.ts#PERSONA_STAGE_DEFAULTS`, `apps/web/src/components/persona/AvatarOnboardingModal.tsx#AvatarOnboardingModal`, `apps/web/src/components/persona/avatarPresets.ts#getPresetsByGender`, `apps/web/src/components/persona/CartoonAvatar3D.ts#buildCartoonAvatar`, `apps/web/src/app/memory/persona/page.tsx`
- 测试: `apps/web/test/ask-reading-and-persona-rules.test.tsx#opens once on first visit`, `apps/web/test/ask-reading-and-persona-rules.test.tsx#starts as a full-screen 3D animation, like the other two 3D pages`, `apps/web/test/ask-reading-and-persona-rules.test.tsx#has cartoon figures for every gender choice`, `apps/web/test/cartoon-avatar-3d.test.ts#is built from the preset the user picked, for every person preset`
- 要求: `PERSONA_STAGE_DEFAULTS.threeD` @ `apps/web/src/app/memory/persona/page.tsx`; `shouldOfferAvatarOnboarding(` @ `apps/web/src/app/memory/persona/page.tsx`; `accept="image/*"` @ `apps/web/src/components/persona/AvatarOnboardingModal.tsx`; `overflow-y-auto` @ `apps/web/src/components/persona/AvatarOnboardingModal.tsx`; `max-h-[30vh] sm:max-h-[42vh]` @ `apps/web/src/components/persona/CartoonPersonaStage.tsx`; `buildCartoonAvatar(` @ `apps/web/src/components/persona/DigitalTwinAvatar3D.tsx`

### R-ASK-INSTANT AI 执事区域刷新尽量零延迟
- 来源: CLAUDE.md（memento）「AI 执事区域刷新尽量零延迟」；全局技术偏好「要求交互零延迟」
- 说明: 打开页面先用本地快照和内存缓存立刻画出上次的对话，服务端结果到了再对齐（带 ETag）。
- 代码: `apps/web/src/lib/ask/cache.ts#getLocalConvSnapshot`, `apps/web/src/lib/ask/cache.ts#saveLocalConvSnapshot`, `apps/web/src/lib/api-client.ts#seedApiEtagCache`
- 测试: `apps/web/test/cache-writes.test.ts#reads back a snapshot that is still waiting to be written`, `apps/web/test/cache-writes.test.ts#writes the snapshot later, once, with long tool output cut`

### R-SESSION-PREVIEW-WHOLE 项目对话和时间线先带每个会话的一段，展开全部一条不丢
- 来源: 用户 11-17「全部都做吧」（同意「先显示每个会话最近的几十条，点展开全部再加载其余部分」）；原先代码注释「每个会话展示完整消息，不做截断」；CLAUDE.md「重视性能与速度优化，要求交互零延迟、避免页面卡死」
- 说明: 列表每个会话带 40 条（倒序看最近的，正序看最早的），会话数和消息总数照实显示；缺的那一头放「展开前面/其余 N 条」，点了按会话取全部消息原地换上。
- 代码: `apps/web/src/lib/session-preview.ts#sessionsUrl`, `apps/web/src/lib/session-preview.ts#fetchWholeSession`, `apps/web/src/components/viewers/MoreMessages.tsx#MoreMessages`, `server/server/api/projects.py#get_project_conversations`
- 测试: `apps/web/test/session-whole.test.tsx#loads the whole session when the reader asks for the rest`, `server/tests/test_project_placement.py#test_the_session_picker_gets_the_latest_few_messages_and_the_true_count`
- 要求: `sessionsUrl(` @ `apps/web/src/app/projects/[id]/timeline/page.tsx`; `sessionsUrl(` @ `apps/web/src/app/projects/[id]/conversations/page.tsx`

### R-WECHAT-DRAFT 工作台文本可多次润色，确认后推到公众号草稿，文章带官网链接
- 来源: CLAUDE.md（memento）「工作台文本支持多次编辑润色，确认无误后再推送到公众号草稿；文章带上官网链接」
- 代码: `apps/web/src/components/viewers/WeChatPublishModal.tsx#WeChatPublishModal`, `apps/web/src/components/viewers/MediaInspectorPanel.tsx`
- 要求: `/api/wechat/draft` @ `apps/web/src/components/viewers/WeChatPublishModal.tsx`; `官方网址` @ `apps/web/src/components/viewers/WeChatPublishModal.tsx`

### R-STUDIO-INLINE-PLAY 演播台成片归档支持 HTTP 206 流播，并可一键发送到对话中直接内联播放
- 来源: 用户 2026-11-20「将 memento 加入演播台功能，做成的视频直接在对话中展示播放」
- 说明: 工作台视窗及插件市场提供 `/studio` 演播台入口并接入 `RouteKeepAlive`（不占用左侧主导航栏）；后端 `/api/studio` 桥接 `filmkit` 制作管线，发布到对话时将 MP4 持久化归档至对象存储（本地无 S3 时落盘兜底），以 `/api/media/video/...` 写入对话回合，每次读取对话或分享页时自动重签 7~14 天有效期并通过 `HTTP 206 Range` 流播，对话气泡由 `MarkdownViewer` 原位渲染 `<VideoPlayer />` 播放并附带跳回演播台精修链接。
- 代码: `server/server/api/studio.py#publish_episode_to_chat`, `server/server/api/media.py#get_media_video`, `server/server/services/storage_service.py#store_video_bytes`, `server/server/services/storage_service.py#sign_video_links_in_text`, `apps/web/src/app/studio/page.tsx#StudioPage`, `apps/web/src/components/viewers/media-utils.ts#resolveMediaUrl`
- 测试: `server/tests/test_studio_media.py#test_get_media_video_range_206_and_auth`, `server/tests/test_studio_media.py#test_publish_episode_to_chat_archives_and_embeds_video_markdown`, `apps/web/test/studio-video-media.test.tsx#renders inline VideoPlayer directly inside MarkdownViewer chat bubble`
- 要求: `sign_video_links_in_text(` @ `server/server/services/ask_store.py`; `href="/studio"` @ `apps/web/src/components/viewers/MediaInspectorPanel.tsx`

### R-STUDIO-SMOOTH-PLAY 演播台成片默认播在线观看版，播放不卡
- 来源: 用户 2026-11-22「演播台的视频播放很卡」；2026-11-24「全部修复吧」
- 说明: 浏览器到演播台经阿里云入口机，实测出口约 3.25 Mbps，1080P 原片 6.7 Mbps 直接播必卡。播放页先问一次在线观看版（filmkit 后台压的短边 720、约 1.4 Mbps H.264）压好没有，压好就带 `quality=stream` 播它，没压好播原片、同时在后台开压；同一个地址播放途中不换文件。分镜候选小视频点了才加载（`preload="none"`）。原片只用于下载与分发。
- 代码: `server/server/api/studio.py#proxy_episode_latest_video`, `server/server/api/studio.py#episode_stream_status`, `apps/web/src/app/studio/page.tsx#StudioPage`, `apps/web/src/lib/studio-api.ts#studioEpisodeVideoUrl`
- 测试: `server/tests/test_studio_media.py#test_stream_quality_tries_online_copy_first_with_own_etag`, `server/tests/test_studio_media.py#test_stream_status_treats_missing_as_not_ready`
- 要求: `preload="none"` @ `apps/web/src/app/studio/page.tsx`; `getEpisodeStreamStatus` @ `apps/web/src/app/studio/page.tsx`

### R-STUDIO-PUBLISH-PULL 多平台分发由 Mac 上的代理主动领任务，结果如实回报
- 来源: 用户 2026-11-23「演播台接入多平台自动分发」；2026-11-24「那个一键发布到社交媒体的功能是不是完全可用」
- 说明: 账号登录态只留在 Mac 上。Mac 上的分发代理（filmkit `make_film.py publish-agent --pull`，launchd 开机自启）沿用 memento 客户端的设备令牌，经 `/api/studio/publish/agent/*` 心跳、领任务、回报进度，素材用同一令牌从 `/api/studio/assets` 拉；集群不需要能连到 Mac（原来的推模式默认地址指向容器自己，从未推成功过）。只有平台确认收下才算「已存草稿/已发布」，B站没有草稿接口时如实返回需改成发布。2026-11-24「怎么推送一直没有成功」：推送中途再点推送曾把任务重排、Mac 那份回报一直被拒（409）卡死；现在执行中的任务再推原样返回，代理只领本机已登录平台的任务（没登录就留在队列里，扫码后自动开始），拉成片显示进度条。同日「全部都优化」：Mac 拉素材优先走家里局域网直连集群入口（实测 112 MB/s，公网约 0.3 MB/s），不通自动回落公网；演播台更新重启期间断点续传、不判失败。
- 代码: `server/server/api/studio.py#publish_agent_heartbeat`, `server/server/api/studio.py#publish_agent_claim`, `server/server/api/studio.py#publish_agent_report`, `server/server/api/studio.py#_require_media_user`, `apps/web/src/components/studio/StudioPublishPanel.tsx#StudioPublishPanel`, `apps/web/src/lib/publish-progress.ts#parseDownloadProgress`
- 测试: `server/tests/test_studio_media.py#test_pull_agent_endpoints_forward_to_filmkit`, `apps/web/test/publish-progress.test.ts#parseDownloadProgress`, `server/tests/test_studio_media.py#test_media_user_accepts_device_token_for_the_mac_agent`
- 要求: `get_current_user_or_collector` @ `server/server/api/studio.py`; `publish-agent --pull` @ `apps/web/src/components/studio/StudioPublishPanel.tsx`

### R-PLUGIN-MARKETPLACE 演播台与公众号分发做成插件市场按需安装并配置后启用
- 来源: 用户 2026-11-20「把演播台和一键推送到公众号的两个服务做成插件吧，安装并配置后才能用」「对做成插件市场中安装」「演播台插件不应该出现在左侧菜单里吧，它和一键推送公众号一样，属于工作台的插件」
- 说明: 演播台（`studio`）与公众号一键分发（`wechat_publish`）均属于工作台插件，在插件市场（`/plugins`）按用户维度持久化安装状态与加密配置（`User.plugin_settings` + `secret_box`），绝不占用左侧主导航栏；安装并配置完成后仅在 AI 执事工作台区域（`AskTopBar` 工作台区、`MediaInspectorPanel` 工作台视窗）及插件市场卡片中解锁入口，未安装或未配置时自动隐藏且后端 `/api/studio/*` 返回 HTTP 412，避免自部署环境出现不可用入口或泄露硬编码个人服务地址。
- 代码: `server/server/services/plugin_service.py#resolve_studio_connection`, `server/server/services/plugin_service.py#get_user_plugins_payload`, `server/server/api/plugins.py#install_plugin`, `apps/web/src/lib/plugins-context.tsx#PluginProvider`, `apps/web/src/app/plugins/page.tsx#PluginsPage`
- 测试: `server/tests/test_plugins.py#test_uninstalled_plugins_are_hidden_and_blocked_for_self_hosted`, `server/tests/test_plugins.py#test_install_configure_seal_secrets_and_uninstall_lifecycle`, `apps/web/test/plugins-marketplace.test.tsx#uses pluginConfig api_base_url and default_cover_media_id instead of hardcoded personal URLs`, `apps/web/test/plugins-marketplace.test.tsx#keeps studio plugin inside workbench instead of left sidebar navigation`
- 要求: `resolve_studio_connection(` @ `server/server/api/studio.py`; `isPluginReady("studio")` @ `apps/web/src/components/ask/AskTopBar.tsx`; `isPluginReady("studio")` @ `apps/web/src/components/viewers/MediaInspectorPanel.tsx`; `isPluginReady("wechat_publish")` @ `apps/web/src/components/viewers/MediaInspectorPanel.tsx`
- 禁止: `https://wx.ihasy.com` @ `apps/web/src/components/viewers/WeChatPublishModal.tsx`; `https://wx.ihasy.com` @ `apps/web/src/components/viewers/MediaInspectorPanel.tsx`

### R-BUSINESS-CHECKED 业务规则挂到代码和测试上，每次提交自动核对
- 来源: 用户 2026-11-14「是不是也要增加业务类似的蓝图才能更加准确的反映业务和代码之间的联系，甚至是否有bug，是否有优化的空间也可以从这两个之间找」「做详细，做到完美，一次性做完」
- 说明: 本文件就是它。生成器随提交核对并写回结果，代码蓝图第 11 节列出最近提交碰到的条目，CI 有 ❌ 不部署；设备上传后项目页显示核对结果和还没写进来的项目规则，可以派智能体去写。
- 代码: `packages/daemon/src/blueprint/business.ts#checkBusinessBlueprint`, `packages/daemon/src/blueprint/business.ts#recentImpact`, `server/server/services/business_blueprint.py#uncovered_rules`, `server/server/api/projects.py#generate_business_blueprint`, `packages/mcp/src/server.ts#businessSection`, `apps/web/src/components/projects/BusinessBlueprintCard.tsx#BusinessBlueprintCard`
- 测试: `packages/daemon/test/business-blueprint.test.ts#fails a rule when its function is gone, its test renamed, the bug's pattern is back or the fix's is missing`, `packages/daemon/test/business-blueprint.test.ts#names the entries a change reached: by the symbol it touched, not just the file`, `server/tests/test_business_blueprint.py#test_a_rule_reworded_in_the_blueprint_still_counts`, `server/tests/test_business_blueprint.py#test_sends_an_agent_to_the_checkout_the_code_blueprint_came_from`
- 要求: `--business --root .` @ `.github/workflows/ci.yml`

## 4. 状态归属

### S-CONV-LIST 对话列表
- 事实源: `server/server/db/models.py#AskConversation`（ask_conversations 表）
- 副本: 每个 api 副本的进程内 L1（最多 15 秒） `server/server/services/cache.py#l1_cache_set`；Redis L2；网页 localStorage 与内存 `apps/web/src/lib/ask/cache.ts#CONVERSATIONS_CACHE_KEY`
- 同步: 写入后 `server/server/services/ask_store.py#bust_conv_list` → `server/server/services/cache.py#cache_delete_prefix` 广播到所有副本；网页删除时 `apps/web/src/app/ask/page.tsx#deletedConversationIds` 兜住还在路上的旧列表

### S-RUN-STATE 运行状态与灵动岛
- 事实源: 设备报的任务终态 `server/server/db/models.py#DeviceTask`（device_tasks.status）
- 副本: 运行镜像在 Redis stream `server/server/services/ask_runs.py`；网页的 streaming 状态与灵动岛 `apps/web/src/components/agent/ActiveRunsMonitor.tsx#ActiveRunsMonitor`
- 同步: task_finished 落库 `server/server/api/tasks.py#_save_finished`；开始、结束推送后网页忘掉缓存的运行状态 `apps/web/src/lib/api-client.ts#forgetRunStatus`

### S-QUOTA 额度
- 事实源: 设备现场探测 `packages/daemon/src/quotas.ts#probeAntigravityQuota`，用完的模型记在设备上 `packages/daemon/src/model-limits.ts#noteModelLimit`
- 副本: 服务端按设备缓存上报 `server/server/services/device_reports.py#get_cached_device_quotas`；网页 localStorage `apps/web/src/lib/ask/cache.ts#QUOTAS_CACHE_KEY`
- 同步: 设备定时和按需上报（协作任务规划前会现要一次） `server/server/services/plan_service.py#model_roster`

### S-MODEL-CHOICE 对话用的模型
- 事实源: 对话 config.model `server/server/db/models.py#AskConversation`；为空表示跟随客户端默认，实际跑的模型记在每个回答回合上
- 副本: 网页选择框 `apps/web/src/app/ask/page.tsx#selectedModel`；设备记的默认模型 `packages/daemon/src/model-limits.ts#noteDefaultModel`
- 同步: 每次提问随参数下发 `server/server/services/ask_stream.py#_prepare_agent_args`；额度用完自动换模型时以回合上记的实际模型为准

### S-CONV-TITLE 会话标题
- 事实源: 从用户提问提取的标题 `packages/daemon/src/antigravity.ts#extractUserTitleFromText`
- 副本: Antigravity 本地 SQLite 与注解文件 `packages/daemon/src/antigravity.ts#updateAntigravitySessionTitle`；平台文档标题 `server/server/services/ingest_service.py#_title_from_user_messages`
- 同步: 守护进程写回本地后随采集同步平台；垃圾标题（worker id、UUID、乱码）自愈 `server/server/services/ingest_service.py#_is_junk_or_uuid_title`

### S-FOLLOWUPS 追问
- 事实源: 排队的在 Redis（按用户+对话） `server/server/services/ask_followups.py#add`；送达的是设备上报的 steer 事件，随回合保存
- 副本: 网页本页的列表 `apps/web/src/app/ask/page.tsx#followUps`
- 同步: 本轮结束时取走服务端保管的、合并本页的 `apps/web/src/lib/ask/followups.ts#nextMessage`

### S-DEVICE-CONNECTION 设备连在哪个副本
- 事实源: Redis 里的键归属 `server/server/services/cluster.py#owner`
- 副本: 各副本的本地 WebSocket 表 `server/server/services/ws_manager.py#register`
- 同步: 发给设备的消息先查归属，不在本副本就跨副本调用 `server/server/services/ws_manager.py#send_task`

### S-LOGIN-TICKET 微信扫码登录票据
- 事实源: Redis `server/server/api/auth.py#_set_ticket_data`（没有 Redis 时才用本进程的字典）
- 副本: 无。票据会从「待扫码」变成「已登录」，不放进程内 L1 `server/server/services/cache.py#cache_set`
- 同步: 回调和轮询都直接读写 Redis `server/server/api/auth.py#_get_ticket_data`

### S-CLIENT-VERSION 客户端版本
- 事实源: 桌面端自己报的 app 版本 `apps/web/src/components/layout/Sidebar.tsx#appVersion`；设备记录 machines.collector_version `server/server/db/models.py#Machine`
- 副本: 服务端分发的最新版本信息 `data/updates/version.json`
- 同步: 侧边栏显示本机实际版本，最新版本只用来提示升级

<!-- memento:business-check:start (自动生成，勿手改) -->
## 自动核对 (Auto Check)

> 生成器随每次提交核对：代码位置还在不在、测试还在不在、禁止 / 要求的写法满不满足。✅ 通过 · ⚠️ 缺代码位置、测试或来源 · ❌ 位置失效或违反规则（CI 会拦下）。

- 汇总：规则 75（✅ 75 · ⚠️ 0 · ❌ 0）· 流程 9 · 术语 11 · 状态 9

| 编号 | 名称 | 代码位置 | 测试 | 检查 | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `T-DEVICE` | 设备 | 3/3 | — | — | ✅ |
| `T-CONVERSATION` | 对话 | 2/2 | — | — | ✅ |
| `T-SESSION` | 会话 | 2/2 | — | — | ✅ |
| `T-RESUME` | 续接（续） | 2/2 | — | — | ✅ |
| `T-AGY-PROJECT` | Antigravity 项目 | 2/2 | — | — | ✅ |
| `T-QUOTA` | 额度 | 3/3 | — | — | ✅ |
| `T-FOLLOWUP` | 追问 | 3/3 | — | — | ✅ |
| `T-BACKGROUND-TASK` | 后台任务 | 2/2 | — | — | ✅ |
| `T-RUN` | 运行 | 2/2 | — | — | ✅ |
| `T-PLAN` | 协作任务 | 2/2 | — | — | ✅ |
| `T-BLUEPRINT` | 蓝图 | 3/3 | — | — | ✅ |
| `F-ASK` | 提问到收尾 | 16/16 | — | — | ✅ |
| `F-RESUME` | 挑历史会话续接 | 8/8 | — | — | ✅ |
| `F-AGY-NEW` | Antigravity 新建会话 | 4/4 | — | — | ✅ |
| `F-FOLLOWUP` | 回答中追问 | 9/9 | — | — | ✅ |
| `F-STOP` | 停止运行 | 5/5 | — | — | ✅ |
| `F-DELETE` | 删除对话 | 6/6 | — | — | ✅ |
| `F-PLAN` | 协作任务 | 3/3 | — | — | ✅ |
| `F-CLIENT-UPGRADE` | 客户端升级 | 3/3 | — | — | ✅ |
| `F-BLUEPRINT` | 蓝图生成与核对 | 5/5 | — | — | ✅ |
| `R-AGY-WORKDIR` | 选了哪个目录，Antigravity 就在那个目录干活 | 4/4 | 4/4 | 3/3 | ✅ |
| `R-AGY-APP-CSRF` | Antigravity 应用不给会话接口令牌时，任务改走 Google 官方 agy 命令行并共用桌面会话库保持双向同步 | 8/8 | 3/3 | 2/2 | ✅ |
| `R-TRACK-BACKGROUND` | 后台任务跟踪到结束，不提前收尾 | 6/6 | 7/7 | 4/4 | ✅ |
| `R-STOP-ALL-AGENTS` | Antigravity、Claude Code、Codex 运行中的任务都必须能停 | 3/3 | 4/4 | 1/1 | ✅ |
| `R-ISLAND-CLEANUP` | 任务结束必须清掉灵动岛状态 | 9/9 | 6/6 | 3/3 | ✅ |
| `R-MULTI-DEVICE-STABLE` | 多机任务并发执行，过程和结果稳定回传 | 4/4 | 4/4 | — | ✅ |
| `R-WS-BIG-UNTRACKED` | 跨设备改代码时，没进 .gitignore 的大文件不让任务失败 | 4/4 | 1/1 | 1/1 | ✅ |
| `R-WS-EDIT-ONLY` | 远程执行机只改代码，测试、构建、提交、推送等其余工作都在代码所在的设备上做 | 9/9 | 8/8 | 2/2 | ✅ |
| `R-BIZ-AUTO` | 画像里有项目规则的项目自动生成业务蓝图，不靠手动点按钮 | 5/5 | 3/3 | 1/1 | ✅ |
| `R-ENT-ADMIN-SCOPE` | 企业部署里管理员只管账号，不看别人的对话、记忆和设备 | 5/5 | 4/4 | 2/2 | ✅ |
| `R-ENT-SSO` | 企业员工用公司统一账号登录，离职由身份平台自动停用 | 6/6 | 5/5 | 2/2 | ✅ |
| `R-ENT-AUDIT` | 谁登录、改了账号和权限、往设备派了命令都留审计记录 | 4/4 | 5/5 | 2/2 | ✅ |
| `R-ENT-SECRETS` | 用户填的模型密钥加密存库，只能用管理员允许的模型服务 | 5/5 | 4/4 | 2/2 | ✅ |
| `R-ENT-DEVICE-POLICY` | 公司 IT 下发的策略文件管住员工电脑：固定服务器、限定远程任务和目录 | 7/7 | 4/4 | 3/3 | ✅ |
| `R-ENT-DEPLOY` | 企业能在自己的服务器上一键部署、备份恢复、离线安装，安装包可正式签名 | 6/6 | — | 4/4 | ✅ |
| `R-WS-EXEC-STOP` | 代码所在设备上一条慢命令或停掉的任务不卡住后面的命令 | 9/9 | 8/8 | 4/4 | ✅ |
| `R-WS-EXEC-REMIND` | 远程智能体在代码所在设备上的命令默认不拦截，有风险的推送提醒 | 5/5 | 4/4 | 2/2 | ✅ |
| `R-PROJECT-EXCLUDE` | 测试用的项目可以不采集，已采集的数据和从中学到的东西一并清掉 | 8/8 | 3/3 | 3/3 | ✅ |
| `R-RUN-OUTLIVES-PAGE` | 运行不因页面关闭、切后台、发版而中断 | 2/2 | 4/4 | — | ✅ |
| `R-QUOTA-PER-MODEL` | 额度按当前对话用的模型显示 | 3/3 | 1/1 | 2/2 | ✅ |
| `R-QUOTA-AGY-GROUPS` | Antigravity 每个模型都显示额度，并显示各组的周额度和 5 小时额度 | 4/4 | 2/2 | 2/2 | ✅ |
| `R-MODEL-SWITCH` | 某个模型额度用完，能换同一工具的其它模型，三个工具都要支持 | 4/4 | 3/3 | — | ✅ |
| `R-MODELS-DYNAMIC` | 模型列表从工具实际能力动态获取，不硬编码过时模型 | 3/3 | 2/2 | — | ✅ |
| `R-QUOTA-NO-RETRY` | 账号额度用完就停，不反复重试 | 2/2 | 2/2 | — | ✅ |
| `R-PLAN-QUOTA-GATE` | 协作任务启动前定好设备、智能体、模型，额度不够的模型不派 | 2/2 | 3/3 | — | ✅ |
| `R-RESUME-LABEL` | 只有从历史里挑的会话才叫「续」 | 2/2 | — | 2/2 | ✅ |
| `R-PREVIEW-ONLY-EMPTY` | 会话预览只在服务端确认对话没有回合时显示 | 2/2 | 2/2 | 1/1 | ✅ |
| `R-SESSION-TIMELINE` | 在工具自己的应用里接着聊的，也出现在续接它的对话里 | 7/7 | 7/7 | 3/3 | ✅ |
| `R-RESTORE-CONFIG` | 选中历史会话恢复当时的工具、项目、会话配置 | 4/4 | 5/5 | — | ✅ |
| `R-CONFIG-LOCK` | 对话开始后不能再换智能体、设备、项目和会话 | 4/4 | 2/2 | 2/2 | ✅ |
| `R-DEVICE-SESSION-MAP` | 设备与会话映射正确：会话只在它所在的设备上续 | 6/6 | 9/9 | — | ✅ |
| `R-DEVICE-ENV-PROFILE` | 新会话拿到的环境信息是它实际所在设备的 | 2/2 | 3/3 | 1/1 | ✅ |
| `R-TITLE-CONSISTENT` | 会话标题所有设备一致，以用户提问提取的标题为准 | 3/3 | 3/3 | — | ✅ |
| `R-DELETE-GONE-EVERYWHERE` | 删除的对话立即在所有页面、所有副本都看不到 | 3/3 | 2/2 | 2/2 | ✅ |
| `R-REPLICA-STATE` | 会变的状态不放进单个 api 副本的内存 | 3/3 | 1/1 | 2/2 | ✅ |
| `R-FOLLOWUP-NOT-LOST` | 追问不丢；送达的显示在回答里，不留在输入区 | 4/4 | 5/5 | 1/1 | ✅ |
| `R-REPLY-VISIBLE` | 回答区不被输入区遮住，回答时跟到最底部 | 2/2 | — | 5/5 | ✅ |
| `R-SHOW-TIMES` | 对话显示发送和回复时间 | 2/2 | 2/2 | — | ✅ |
| `R-NO-STDERR` | 回复里不输出无用的 stderr | 2/2 | 2/2 | — | ✅ |
| `R-CLAUDE-TUI-SYNC` | memento 里的 Claude Code 对话要能在 Claude Code 的 TUI 里续上 | 3/3 | 2/2 | 1/1 | ✅ |
| `R-NEWCHAT-WORKS` | 新建对话用最新配置，并保证能成功 | 2/2 | 2/2 | — | ✅ |
| `R-UPGRADE-SAFE` | 客户端升级要成功，不打断运行中的任务，升级后移除旧版本 | 3/3 | 3/3 | — | ✅ |
| `R-CLIENT-VERSION-REAL` | 侧边栏显示客户端实际版本，不被服务端最新版本盖掉 | 1/1 | 1/1 | — | ✅ |
| `R-APP-NAME` | 客户端名称不带 desktop 后缀 | 2/2 | — | 1/1 | ✅ |
| `R-MOBILE-DEVICE-SCOPED` | 手机端切换设备只拉该设备的项目和对话 | 1/1 | 1/1 | — | ✅ |
| `R-BLUEPRINT-NEWEST` | 蓝图只来自设备上传，多份设备副本取代码最新的那份 | 2/2 | 2/2 | — | ✅ |
| `R-CODE-BLUEPRINT-NAME` | 代码蓝图叫 CODE_BLUEPRINT.md，和业务蓝图成对；旧名字照常能读，旧客户端不被打断 | 6/6 | 5/5 | 2/2 | ✅ |
| `R-USER-BLUEPRINT-BUSINESS` | 个人蓝图读各项目的业务蓝图 | 2/2 | 1/1 | — | ✅ |
| `R-DOCS-WRITE-LIGHT` | documents 表上不加大的 GIN / 表达式索引 | 3/3 | — | 2/2 | ✅ |
| `R-PUBLIC-REPO-CLEAN` | 公开仓库里没有内网地址和密钥 | 2/2 | — | 2/2 | ✅ |
| `R-NO-CONFIGMAP-HOTFIX` | 不用 ConfigMap 挂载覆盖镜像里的代码 | 1/1 | — | 1/1 | ✅ |
| `R-CI-KUSTOMIZE-PINNED` | CI 装 kustomize 用固定版直链，不用 install_kustomize.sh | 1/1 | — | 1/1 | ✅ |
| `R-COMMIT-CONVENTION` | 提交用中文 Conventional Commits，不加 Claude 共同作者尾注，历史保持线性 | — | — | — | ✅ 约定 |
| `R-DEPLOY-AFTER-CI` | 部署流水线必须等 CI 通过 | 1/1 | — | 1/1 | ✅ 约定 |
| `R-DEPLOY-BUMP-RACE` | 回写镜像 tag 撞车时在最新 main 上重来，不把线上退回旧提交 | 1/1 | 3/3 | 1/1 | ✅ |
| `R-ALL-TYPESCRIPT` | 客户端全 TypeScript，Electron + React，不混入 Flutter、Tauri 等框架 | 2/2 | — | 2/2 | ✅ |
| `R-SELF-EVOLVE` | 越用越了解用户、能自进化 | 7/7 | 6/6 | 4/4 | ✅ |
| `R-PLAN-THEN-FINISH` | 规划周全后一次性全部完成，追求好用，界面高级精致 | — | — | — | ✅ 约定 |
| `R-UI-COMMERCIAL` | 界面像成熟商业产品：统一外壳、平实文案、不用 emoji 当图标 | 5/5 | 5/5 | 9/9 | ✅ |
| `R-LOGIN-PERSIST` | 客户端登录永久记住 | 3/3 | — | 1/1 | ✅ |
| `R-MENU-KEEPALIVE` | 记住上次菜单状态，切换菜单不重新加载 | 2/2 | 2/2 | — | ✅ |
| `R-MAC-TRAY` | Mac 客户端支持最小化到托盘，关窗口不退出 | 1/1 | — | 2/2 | ✅ |
| `R-THINKING-FULL` | 思考过程始终铺满显示，回答正文字号统一 | 3/3 | 2/2 | 2/2 | ✅ |
| `R-PASTE-IMAGE-ONCE` | 粘贴图片不重复 | 1/1 | — | 1/1 | ✅ |
| `R-MEDIA-VIEW` | 图片可点击放大；视频可预览、全屏、播放后缓存；工作台能看图片和 ppt/excel/word/md 等产物 | 6/6 | 6/6 | — | ✅ |
| `R-LLM-IN-PROFILE` | 大模型配置放在个人设置里 | 2/2 | — | 1/1 | ✅ |
| `R-PERSONA-ONBOARD` | 个人画像首次进入引导设性别和卡通形象，可上传照片生成，默认全屏 3D 动画，手机端完整显示 | 6/6 | 4/4 | 6/6 | ✅ |
| `R-ASK-INSTANT` | AI 执事区域刷新尽量零延迟 | 3/3 | 2/2 | — | ✅ |
| `R-SESSION-PREVIEW-WHOLE` | 项目对话和时间线先带每个会话的一段，展开全部一条不丢 | 4/4 | 2/2 | 2/2 | ✅ |
| `R-WECHAT-DRAFT` | 工作台文本可多次润色，确认后推到公众号草稿，文章带官网链接 | 2/2 | — | 2/2 | ✅ |
| `R-STUDIO-INLINE-PLAY` | 演播台成片归档支持 HTTP 206 流播，并可一键发送到对话中直接内联播放 | 6/6 | 3/3 | 2/2 | ✅ |
| `R-STUDIO-SMOOTH-PLAY` | 演播台成片默认播在线观看版，播放不卡 | 4/4 | 2/2 | 2/2 | ✅ |
| `R-STUDIO-PUBLISH-PULL` | 多平台分发由 Mac 上的代理主动领任务，结果如实回报 | 6/6 | 3/3 | 2/2 | ✅ |
| `R-PLUGIN-MARKETPLACE` | 演播台与公众号分发做成插件市场按需安装并配置后启用 | 5/5 | 4/4 | 6/6 | ✅ |
| `R-BUSINESS-CHECKED` | 业务规则挂到代码和测试上，每次提交自动核对 | 6/6 | 4/4 | 1/1 | ✅ |
| `S-CONV-LIST` | 对话列表 | 6/6 | — | — | ✅ |
| `S-RUN-STATE` | 运行状态与灵动岛 | 5/5 | — | — | ✅ |
| `S-QUOTA` | 额度 | 5/5 | — | — | ✅ |
| `S-MODEL-CHOICE` | 对话用的模型 | 4/4 | — | — | ✅ |
| `S-CONV-TITLE` | 会话标题 | 4/4 | — | — | ✅ |
| `S-FOLLOWUPS` | 追问 | 3/3 | — | — | ✅ |
| `S-DEVICE-CONNECTION` | 设备连在哪个副本 | 3/3 | — | — | ✅ |
| `S-LOGIN-TICKET` | 微信扫码登录票据 | 3/3 | — | — | ✅ |
| `S-CLIENT-VERSION` | 客户端版本 | 3/3 | — | — | ✅ |

### 需要处理

- 没有。
<!-- memento:business-check:end -->
