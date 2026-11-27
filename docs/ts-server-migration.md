# 服务端迁移到 TypeScript（单安装包）

2026-11-27 定：服务端从 Python 改写成 TypeScript，最终目标是一个桌面安装包装上就有完整功能，不需要 Docker、不需要服务器。
云端（mem.ihasy.com、企业部署）跑同一份 TypeScript 服务端。迁移期间线上不停，网页、手机、桌面端、守护进程、MCP 都不用改。

## 1. 现状（2026-11-27 统计）

| 部分 | Python 行数 | 内容 |
| --- | --- | --- |
| api/ | 19,392 | 44 个路由文件、351 个接口（含 SSE 与设备 WebSocket） |
| services/ | 37,523 | 业务：采集解析、检索、问答编排、梦境复盘、画像蓝图、跨副本协调等 |
| tasks/ | 1,823 | Celery：21 个定时任务（日报、梦境、补向量、合并暂存、学习纠正、评测…） |
| db/ | 1,949 | 42 个表（SQLAlchemy）、启动时自动迁移 |
| 测试 | 24,161 | 141 个文件 |
| 合计 | 约 6.1 万行 | |

特殊依赖与对应的 TypeScript 做法：

| Python | 用途 | TypeScript |
| --- | --- | --- |
| FastAPI + Pydantic | 接口、校验、OpenAPI | Hono + zod（@hono/zod-openapi 生成同一份 OpenAPI，packages/core 的类型照旧生成） |
| SQLAlchemy + asyncpg + pgvector | 数据库 | Drizzle ORM + postgres.js（Drizzle 自带 vector 类型）；表结构先从线上库反向生成，保证一模一样 |
| Celery + beat | 后台任务 | 进程内调度（croner），多副本时用现有的 Redis 租约只跑一份；重活放 worker_threads |
| Redis（cluster.py） | 跨副本协调 | ioredis，键名和频道与 Python 版完全一致（迁移期两边要互通）；单机时换成进程内实现 |
| boto3 / MinIO | 文件 | 存储接口两种实现：S3（@aws-sdk/client-s3）与本地文件夹（单安装包用） |
| jieba | 中文分词（全文索引） | @node-rs/jieba（预编译原生模块）；必须和 Python 版切出一样的词，否则老索引搜不到，P0 先做对照 |
| python-jose + bcrypt | 登录令牌、密码 | jose + bcryptjs，令牌和密码哈希与现有完全兼容，用户不用重新登录 |
| anthropic / openai | 大模型 | 官方 TypeScript SDK |
| Pillow / geoip2 | 图片、访客位置 | sharp / maxmind |

向量模型仍是外部服务（硅基流动或自建 BGE-M3 的 OpenAI 兼容接口），不进安装包。

## 2. 迁移方式：新旧并行，按路径逐块切换

1) 新建工作区 `packages/server`（TypeScript），和 Python 服务端连同一个 Postgres、同一个 Redis。
2) 入口按路径前缀分流：已迁移的前缀走 TypeScript，其余仍走 Python。k8s 里多一个 `api-ts` 部署，入口规则随迁移进度逐步改；单副本开发环境用同样的前缀表。
3) 迁移期间表结构只由 Python 的迁移代码负责（避免两边各改各的）；最后一个阶段再交给 TypeScript（drizzle-kit）。
4) 每块切换前要过三道检查：
   - 移植该块的 Python 测试（行为一致）；
   - 契约对照：同一组请求分别打到 Python 和 TypeScript，返回的 JSON 逐字段比对（时间格式、null 与缺省字段、错误格式都要一样）；
   - 线上影子流量：只读接口先双发、只比不用，差异为零再真正切过去。
5) 切过去后 Python 那块代码保留一个版本周期，出问题改一行路由就能切回；确认稳定再删。

## 3. 分阶段

| 阶段 | 内容 | 涉及 Python（约） | 完成标志 |
| --- | --- | --- | --- |
| P0 地基 | 工作区、Hono 应用骨架、配置、登录令牌兼容、表结构反向生成、错误格式、OpenAPI、测试与契约对照工具、入口分流；单安装包关键技术验证：内嵌 Postgres + 自己编译的 pgvector 在 Mac（Intel/Apple）、Windows、Linux 上跑通，jieba 分词对照一致 | 3k | /health 与登录接口由 TypeScript 提供，线上用户无感；三平台内嵌数据库验证通过 |
| P1 简单接口 | 待办、计划、定时任务、通知、额度、看板、层级、文档、媒体、技能、插件、工具、任务、作息、导入导出、更新、安装脚本等 | 5k | 这些前缀切到 TypeScript |
| P2 采集与检索 | ingest、会话解析、暂存合并、消息存储与核对、搜索、问答检索、向量化 | 7k | 设备上传与搜索走 TypeScript，检索评测分数不降（hit5 / MRR 对照现基线） |
| P3 设备与实时 | 设备 WebSocket、跨副本路由（ws_manager、cluster）、派活、终端、预览、Git、工作区中转 | 6k | 设备长连接整体切换（这块不能拆开切），旧版客户端照常连 |
| P4 问答 | ask、流式输出、运行续看与停止、对话存储、提示词、编排与工具、模型调用 | 8k | 问答页、AI 编排全部走 TypeScript |
| P5 后台智能 | 梦境、复盘、纠正学习、心领神会、个人蓝图、业务蓝图、知识图谱、记忆新陈代谢、评测、脉搏；21 个定时任务换成进程内调度 | 12k | Celery 下线 |
| P6 其余 | 项目、记忆、分享、演播台、单点登录 / SCIM / 微信 / GitHub、管理后台、导出导入 | 8k | Python 不再处理任何请求 |
| P7 收尾与单安装包 | 迁移代码交给 TypeScript；删 Python 服务端与镜像；桌面端内置服务端：主进程拉起服务端（utilityProcess）+ 内嵌 Postgres（数据在 ~/.memento/server-data）+ 本地文件存储 + 网页界面；首次打开默认就用本机，想连云端再切换 | — | 下载一个安装包、打开就能用全部功能 |

单安装包形态（P7）：
- 服务端、网页、守护进程都是 Node，同一个 Electron 里跑，不再有 Python、Docker、Redis、MinIO。
- 只有 Postgres 是原生二进制（加 pgvector），按平台随安装包分发，预计安装包 150 MB 左右（P0 验证后给准确数字）。
- 手机端连这台电脑：局域网直连，或者沿用云端中转（之后再定）。

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 接口返回和 Python 有细微差别（时间格式、null、错误结构），前端出 bug | 契约对照逐字段比，影子流量零差异才切 |
| 设备 WebSocket 协议有差别，老客户端掉线 | P3 整体切换，先在 vps3 执行机上灰度；协议测试覆盖所有消息类型 |
| 分词结果不同，老的全文索引搜不到 | P0 用线上真实文档做分词对照；不一致就把 Python 版的词典与规则原样移植，或者重建索引（先备份） |
| 两边同时跑时跨副本协调打架 | Redis 键名、频道、租约格式保持一致，有专门的互通测试 |
| 内嵌 Postgres 的 pgvector 没有现成三平台包 | P0 在 CI 里自己编译（与现在打安装包同一套流水线），验证不过就停下来重新评估 |
| 周期长，期间新功能两边都要写 | 新功能一律只写 TypeScript：所在前缀还没迁的，先把那块迁过来再加 |

## 5. 进度

- [ ] P0 地基与单安装包技术验证
- [ ] P1 简单接口
- [ ] P2 采集与检索
- [ ] P3 设备与实时
- [ ] P4 问答
- [ ] P5 后台智能（Celery 下线）
- [ ] P6 其余（Python 不再处理请求）
- [ ] P7 收尾与单安装包
