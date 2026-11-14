# Business Blueprint: memento

<!-- memento:business-index:start (自动生成，勿手改) -->
> 先读这一段定位；要细节时按下表行号只读对应章节。改了「代码位置」里的文件，先看对应条目还成不成立。

- 汇总：规则 34（✅ 34 · ⚠️ 0 · ❌ 0）· 流程 9 · 术语 11 · 状态 9
- 核对：全部通过（详见末尾「自动核对」）

| 章节 | 行号 |
| :--- | :--- |
| 1. 业务对象与术语 | L21-L65 |
| 2. 关键流程 | L67-L124 |
| 3. 业务规则 | L126-L317 |
| 4. 状态归属 | L319-L364 |
| 自动核对 (Auto Check) | L367-L441 |
<!-- memento:business-index:end -->
> 业务蓝图：memento 应该做成什么样，每一条落在哪段代码、由哪个测试或检查保证。和 [PROJECT_BLUEPRINT.md](PROJECT_BLUEPRINT.md)（代码长什么样）配合看：代码蓝图回答"在哪里"，这份回答"应该怎样、为什么"。
> 规则来自用户的原话和纠正（CLAUDE.md、长期记忆、每晚复盘），不是从代码里反推的；代码和这里对不上，先当成代码的问题查。
> 维护方式：改了某条「代码」里列的文件，看一眼这条还成不成立；新增一条用户定下的规则，按下面的格式加进来并挂上代码和测试。生成器（`scripts/project_blueprint.mjs`）每次提交都核对一遍，结果写在末尾「自动核对」，PROJECT_BLUEPRINT.md 第 11 节列出最近提交碰到了哪些条目；CI 遇到 ❌ 会拦下部署。

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
- 定义: 三种。代码蓝图 PROJECT_BLUEPRINT.md（生成器扫代码得来）；业务蓝图 BUSINESS_BLUEPRINT.md（本文件，人和智能体写、生成器核对）；个人蓝图 USER_BLUEPRINT.md（服务端综合用户所有项目得来）。前两种只来自设备上传，服务端从多份设备副本里挑最新的。
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
2. 找到或新建绑定这个会话的对话（按用户+会话加锁，不重复建） — `server/server/api/ask_conversations.py#ensure_conversation_by_session`
3. 打开这个对话，恢复当时的工具、设备、项目、会话配置 — `apps/web/src/app/ask/page.tsx#openSessionConversation`, `apps/web/src/app/ask/page.tsx#applyCachedCascade`, `apps/web/src/lib/ask/cascade.ts#cascadeOf`
4. 等服务端确认对话没有回合，才显示会话最近消息的预览 — `apps/web/src/app/ask/page.tsx#emptyConvId`
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
- 说明: 根因是守护进程把 app_storage.json 的 lastCreatedProjectId（最后新建的项目）当成 ANTIGRAVITY_PROJECT_ID 传下去。
- 代码: `packages/daemon/src/agy-runner/runner.ts#projectForFolder`, `packages/daemon/src/antigravity.ts#discoverAntigravityEnv`
- 测试: `packages/daemon/test/agy-project-folder.test.ts#takes the project whose resources name the folder, not the one made last`, `packages/daemon/test/agy-project-folder.test.ts#makes a project for a folder no project names`
- 禁止: `lastCreatedProjectId` @ `packages/daemon/src/antigravity.ts`, `packages/daemon/src/agy-runner/`
- 要求: `ANTIGRAVITY_PROJECT_ID = ` @ `packages/daemon/src/agy-runner/runner.ts`

### R-TRACK-BACKGROUND 后台任务跟踪到结束，不提前收尾
- 来源: CLAUDE.md（memento）「后台任务要跟踪到结束，不要提前结束」；用户 2026-11-14「antigravity经常会出现任务还没完成……不能精准的判断到任务是否结束吗」
- 说明: 不能用固定的安静时长判定结束。Antigravity 的定时器到点前日志为空，按定时时长等到点再加宽限。
- 代码: `packages/daemon/src/agy-runner/runner.ts#timerSeconds`, `packages/daemon/src/agy-runner/runner.ts#backgroundQuietMs`
- 测试: `packages/daemon/test/antigravity-runner.test.ts#waits for a timer Antigravity set and ends on the work it wakes up for, not at the quiet limit`, `packages/daemon/test/agy-project-folder.test.ts#reads how long a schedule timer waits from its task description`, `packages/daemon/test/still-running.test.ts#detects Antigravity active background task`
- 要求: `timerSeconds(` @ `packages/daemon/src/agy-runner/runner.ts`

### R-STOP-ALL-AGENTS Antigravity、Claude Code、Codex 运行中的任务都必须能停
- 来源: CLAUDE.md（memento）「必须能停止 Antigravity、Claude Code、Codex 运行中的任务」
- 代码: `packages/daemon/src/task-runner.ts#cancel`, `server/server/api/ask.py#cancel_run`, `server/server/services/ws_manager.py#cancel_when_back`
- 测试: `server/tests/test_ask_runs.py#test_cancel_stops_the_generator`, `server/tests/test_ask_runs.py#test_cancel_before_the_run_starts_still_closes_it`, `server/tests/test_agent_run_states.py#test_stopped_by_the_user_is_saved_as_stopped_not_done`, `packages/daemon/test/antigravity-runner.test.ts#gives up at the task timeout and stops on a signal`
- 要求: `killProcessTree(` @ `packages/daemon/src/task-runner.ts`

### R-ISLAND-CLEANUP 任务结束必须清掉灵动岛状态
- 来源: CLAUDE.md（memento）「任务结束清理灵动岛状态」；记忆「灵动岛任务状态必须以底层工具真实终态为准，任务完成后必须同步清理」
- 代码: `apps/web/src/components/agent/ActiveRunsMonitor.tsx#ActiveRunsMonitor`, `server/server/api/ask.py#list_active_runs`, `packages/daemon/src/task-runner.ts#cancel`
- 测试: `apps/web/test/run-status.test.ts#is forgotten when a run start or end is pushed`, `server/tests/test_ask_runs.py#test_finished_run_is_dropped_after_retention`, `server/tests/test_agent_limits.py#test_old_daemons_still_running_on_quota_is_failed`

### R-MULTI-DEVICE-STABLE 多机任务并发执行，过程和结果稳定回传
- 来源: CLAUDE.md（memento）「多机任务并发执行，过程和结果稳定回传」；心领神会「单台设备离线不得拖垮整体」
- 代码: `packages/daemon/src/task-runner.ts#sendChunk`, `packages/daemon/src/task-runner.ts#resendBufferedChunks`, `server/server/services/device_dispatch.py#deliver_task`, `server/server/services/plan_service.py#choose_assignment`
- 测试: `packages/daemon/test/task-resilience.test.ts#TaskRunner generates monotonic sequence numbers and buffers chunks for idempotent resend`, `packages/daemon/test/task-resilience.test.ts#WsTaskClient preserves strict FIFO message order when pending messages exist and new message arrives`, `server/tests/test_device_dispatch.py#test_an_offline_device_fails_the_task_at_once`, `server/tests/test_plan_service.py#test_choose_assignment_prefers_asked_agent_and_skips_tried_and_spent`

### R-RUN-OUTLIVES-PAGE 运行不因页面关闭、切后台、发版而中断
- 来源: 记忆「智能体运行状态容易丢的根因与交接修法」（10-28 查实四个根因）；CLAUDE.md「发版时旧 pod 会先等进行中的回答跑完」
- 代码: `server/server/services/ask_runs.py`, `server/server/services/ask_stream.py#_resume_direct_agent`
- 测试: `server/tests/test_ask_runs.py#test_run_keeps_going_after_reader_disconnects`, `server/tests/test_ask_runs.py#test_reattach_resumes_after_last_seen_id`, `server/tests/test_agent_run_states.py#test_resume_follows_the_task_already_on_the_device`, `server/tests/test_agent_run_states.py#test_attach_picks_up_a_task_that_ended_during_the_handover`

### R-QUOTA-PER-MODEL 额度按当前对话用的模型显示
- 来源: 用户 2026-11-14「额度能根据当前会话使用的模型显示吗，有的会话，像antigravity 里的多个模型额度是不一样的」
- 代码: `apps/web/src/lib/ask/model-limits.ts#modelQuotaOf`, `apps/web/src/app/ask/page.tsx#quotaModelId`, `apps/web/src/components/quota/AgentQuotaPopover.tsx#AgentQuotaPopover`
- 测试: `apps/web/test/model-limits.test.ts#gives the quota of the model a conversation runs on, not the default model's`
- 要求: `modelQuotaOf(quotasData` @ `apps/web/src/app/ask/page.tsx`

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

### R-RESTORE-CONFIG 选中历史会话恢复当时的工具、项目、会话配置
- 来源: CLAUDE.md（memento）「选中历史会话要恢复当时的工具、项目、会话配置」
- 代码: `apps/web/src/lib/ask/cascade.ts#cascadeOf`, `apps/web/src/app/ask/page.tsx#applyCachedCascade`
- 测试: `apps/web/test/cascade.test.ts#takes every field from the conversation, empty ones included`, `apps/web/test/cascade.test.ts#tells a cleared project or session from one never saved`, `server/tests/test_ask_cascade.py#test_cleared_session_is_not_inferred_back_from_earlier_turns`

### R-DEVICE-SESSION-MAP 设备与会话映射正确：会话只在它所在的设备上续
- 来源: CLAUDE.md（memento）「设备与会话映射正确」
- 代码: `server/server/services/ask_stream.py#_session_elsewhere`, `server/server/services/ask_stream.py#_can_carry_session`
- 测试: `server/tests/test_ask_cascade.py#test_session_on_another_device_is_not_resumed_there`, `server/tests/test_ask_cascade.py#test_session_on_the_device_picked_is_resumed`, `server/tests/test_ask_cascade.py#test_session_of_another_tool_is_not_resumed`, `server/tests/test_ask_ensure_by_session.py#test_looks_up_and_creates_under_a_lock_per_user_and_session`

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
- 说明: 只有用户自己往上滚才算离开底部；内容后来长高（代码高亮、图片、工具卡片）也要跟。输入区上方的配置和会话上下文限高内部滚动。
- 代码: `apps/web/src/app/ask/page.tsx#chatScrollRef`, `apps/web/src/app/ask/page.tsx#userScrolledAwayRef`
- 要求: `ro.observe(content)` @ `apps/web/src/app/ask/page.tsx`; `ask-footer-extras` @ `apps/web/src/app/ask/page.tsx`
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

- 汇总：规则 34（✅ 34 · ⚠️ 0 · ❌ 0）· 流程 9 · 术语 11 · 状态 9

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
| `F-RESUME` | 挑历史会话续接 | 7/7 | — | — | ✅ |
| `F-AGY-NEW` | Antigravity 新建会话 | 4/4 | — | — | ✅ |
| `F-FOLLOWUP` | 回答中追问 | 9/9 | — | — | ✅ |
| `F-STOP` | 停止运行 | 5/5 | — | — | ✅ |
| `F-DELETE` | 删除对话 | 6/6 | — | — | ✅ |
| `F-PLAN` | 协作任务 | 3/3 | — | — | ✅ |
| `F-CLIENT-UPGRADE` | 客户端升级 | 3/3 | — | — | ✅ |
| `F-BLUEPRINT` | 蓝图生成与核对 | 5/5 | — | — | ✅ |
| `R-AGY-WORKDIR` | 选了哪个目录，Antigravity 就在那个目录干活 | 2/2 | 2/2 | 2/2 | ✅ |
| `R-TRACK-BACKGROUND` | 后台任务跟踪到结束，不提前收尾 | 2/2 | 3/3 | 1/1 | ✅ |
| `R-STOP-ALL-AGENTS` | Antigravity、Claude Code、Codex 运行中的任务都必须能停 | 3/3 | 4/4 | 1/1 | ✅ |
| `R-ISLAND-CLEANUP` | 任务结束必须清掉灵动岛状态 | 3/3 | 3/3 | — | ✅ |
| `R-MULTI-DEVICE-STABLE` | 多机任务并发执行，过程和结果稳定回传 | 4/4 | 4/4 | — | ✅ |
| `R-RUN-OUTLIVES-PAGE` | 运行不因页面关闭、切后台、发版而中断 | 2/2 | 4/4 | — | ✅ |
| `R-QUOTA-PER-MODEL` | 额度按当前对话用的模型显示 | 3/3 | 1/1 | 1/1 | ✅ |
| `R-MODEL-SWITCH` | 某个模型额度用完，能换同一工具的其它模型，三个工具都要支持 | 4/4 | 3/3 | — | ✅ |
| `R-MODELS-DYNAMIC` | 模型列表从工具实际能力动态获取，不硬编码过时模型 | 3/3 | 2/2 | — | ✅ |
| `R-QUOTA-NO-RETRY` | 账号额度用完就停，不反复重试 | 2/2 | 2/2 | — | ✅ |
| `R-PLAN-QUOTA-GATE` | 协作任务启动前定好设备、智能体、模型，额度不够的模型不派 | 2/2 | 3/3 | — | ✅ |
| `R-RESUME-LABEL` | 只有从历史里挑的会话才叫「续」 | 2/2 | — | 2/2 | ✅ |
| `R-PREVIEW-ONLY-EMPTY` | 会话预览只在服务端确认对话没有回合时显示 | 2/2 | 2/2 | 1/1 | ✅ |
| `R-RESTORE-CONFIG` | 选中历史会话恢复当时的工具、项目、会话配置 | 2/2 | 3/3 | — | ✅ |
| `R-DEVICE-SESSION-MAP` | 设备与会话映射正确：会话只在它所在的设备上续 | 2/2 | 4/4 | — | ✅ |
| `R-TITLE-CONSISTENT` | 会话标题所有设备一致，以用户提问提取的标题为准 | 3/3 | 3/3 | — | ✅ |
| `R-DELETE-GONE-EVERYWHERE` | 删除的对话立即在所有页面、所有副本都看不到 | 3/3 | 2/2 | 2/2 | ✅ |
| `R-REPLICA-STATE` | 会变的状态不放进单个 api 副本的内存 | 3/3 | 1/1 | 2/2 | ✅ |
| `R-FOLLOWUP-NOT-LOST` | 追问不丢；送达的显示在回答里，不留在输入区 | 4/4 | 5/5 | 1/1 | ✅ |
| `R-REPLY-VISIBLE` | 回答区不被输入区遮住，回答时跟到最底部 | 2/2 | — | 3/3 | ✅ |
| `R-SHOW-TIMES` | 对话显示发送和回复时间 | 2/2 | 2/2 | — | ✅ |
| `R-NO-STDERR` | 回复里不输出无用的 stderr | 2/2 | 2/2 | — | ✅ |
| `R-CLAUDE-TUI-SYNC` | memento 里的 Claude Code 对话要能在 Claude Code 的 TUI 里续上 | 3/3 | 2/2 | 1/1 | ✅ |
| `R-NEWCHAT-WORKS` | 新建对话用最新配置，并保证能成功 | 2/2 | 2/2 | — | ✅ |
| `R-UPGRADE-SAFE` | 客户端升级要成功，不打断运行中的任务，升级后移除旧版本 | 3/3 | 3/3 | — | ✅ |
| `R-CLIENT-VERSION-REAL` | 侧边栏显示客户端实际版本，不被服务端最新版本盖掉 | 1/1 | 1/1 | — | ✅ |
| `R-APP-NAME` | 客户端名称不带 desktop 后缀 | 2/2 | — | 1/1 | ✅ |
| `R-MOBILE-DEVICE-SCOPED` | 手机端切换设备只拉该设备的项目和对话 | 1/1 | 1/1 | — | ✅ |
| `R-BLUEPRINT-NEWEST` | 蓝图只来自设备上传，多份设备副本取代码最新的那份 | 2/2 | 2/2 | — | ✅ |
| `R-DOCS-WRITE-LIGHT` | documents 表上不加大的 GIN / 表达式索引 | 3/3 | — | 2/2 | ✅ |
| `R-PUBLIC-REPO-CLEAN` | 公开仓库里没有内网地址和密钥 | 2/2 | — | 2/2 | ✅ |
| `R-NO-CONFIGMAP-HOTFIX` | 不用 ConfigMap 挂载覆盖镜像里的代码 | 1/1 | — | 1/1 | ✅ |
| `R-CI-KUSTOMIZE-PINNED` | CI 装 kustomize 用固定版直链，不用 install_kustomize.sh | 1/1 | — | 1/1 | ✅ |
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
