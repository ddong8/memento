# memento — 项目须知(给 AI)

## 部署 / CI-CD 铁律(GitOps,勿手动操作集群)

本项目通过 **GitOps** 自动部署到 NAS 上的 k3s 集群(命名空间 `memento`),由 Rancher Fleet 拉取式部署,对外 mem.ihasy.com。
**禁止**用手动 `docker build` / `kubectl apply` / `kubectl set image` / 手改 kustomization 镜像 tag 的方式上线。

正确流程:**改代码 → push 到 main → GitHub Actions 自动构建镜像推 GHCR → 自动回写 kustomization 镜像 tag → Fleet 检测到 → 集群拉新镜像滚动。** 你只需提交代码。

- 触发路径:push main 改 `server/**` / `web/**` / `packages/**` / `deploy/bootstrap/**` 等(完整列表见 deploy.yml 的 `on.push.paths`)。
- 构建镜像:`ghcr.io/ddong8/memento-{server,web}`(**公开** GHCR)。
- **公开仓库 → 不要往仓库里放任何 Secret**;postgres / redis / minio 与 Secret 都在集群内手工维护、不进仓库,deploy/k8s 里只引用。

### 关键约束(改 CI/部署相关时务必遵守)
- Fleet 克隆 github 走集群内的代理 `fleet-proxy`(`cattle-fleet-system` 命名空间,gitjob 的 HTTP(S)_PROXY 指向它),不再经 Mac 上的 Clash。拉 GHCR 镜像以集群实际配置为准(2026-10-17 旧的 Mac 代理地址已不通,拉镜像照常)。代理地址等不写进公开仓库。
- GitHub 偶发超时后 gitrepo 会停在 `Stalled` / `GitPolling=False`,之后不再自动拉新提交,要按下面的办法强制重同步(2026-10-17 实测有效)。
- CI 装 kustomize 用「release CDN 直接下载固定版」(`releases/download/.../kustomize_v5.4.3_...`),**不要改回 `install_kustomize.sh`**——它查 GitHub API,共享 runner 上会撞限流导致部署失败。
- 镜像 tag 由 CI 自动 bump,**不要手改**。
- 服务端 Python 依赖锁在 `server/uv.lock`,Docker 安装的是由它导出的 `server/requirements.lock`(带哈希)。改了 `server/pyproject.toml` 的依赖后:`cd server && uv lock && uv export --frozen --no-dev --no-emit-project --no-header --format requirements-txt -o requirements.lock`;升级依赖用 `uv lock --upgrade` 再导出。CI 会检查两者一致。
- bot 回写提交带 `[skip ci]`(GitHub 上真生效、不是装饰),避免触发死循环。
- **不要用 ConfigMap 挂载覆盖镜像里的代码文件做热修复。** 2026-10-13 有人这样给 api 挂了 projects.py、ingest_service.py、user_filter.py,补丁一直没撤,之后这三个文件的改动在线上全部不生效(镜像照常更新,文件被挂载盖住)。Fleet 不把这类手动加的挂载算作漂移,不会自动清掉。确实要紧急止血,也要在修复随镜像上线后立刻删掉挂载和 ConfigMap。

### api 是多副本(deploy/k8s/api.yaml 的 replicas)
- 请求和设备 WebSocket 会落到任意一个副本。副本之间经 Redis 协调,全在 `server/server/services/cluster.py`:跨副本调用、键归属(设备连在哪个副本)、有序写、锁/互斥/租约、共享字典。设备连接见 `ws_manager.py`,提问运行(镜像到 Redis stream,任一副本可续看/停止)见 `ask_runs.py`。
- **新代码不要把需要跨请求共享的状态放进模块级 dict / `asyncio.Lock` / 进程内后台循环**:会在副本间各自为政。共享状态用 Redis(`cluster.redis`、`SharedDict`),互斥用 `cluster.mutex` / `try_lock`,只该跑一份的后台任务包在 `cluster.leased(...)` 里。纯缓存(丢了能重算)可以留在进程内。
- 发版时旧 pod 会先等进行中的回答跑完(最多 `MEMENTO_SHUTDOWN_DRAIN_SECONDS`,默认 600 秒)再退出,期间客户端自动改连新 pod 继续看。所以旧 pod 停在 `Terminating` 几分钟是正常的;改这个时长要同步改 api.yaml 的 `terminationGracePeriodSeconds`。

### 查状态 / 排障
- 构建:`gh run list --workflow=deploy.yml`
- 集群:`kubectl -n fleet-local get gitrepo memento`、`kubectl -n memento get pods`
- 已部署但改动没生效:先看 api 有没有被挂载覆盖,`kubectl -n memento get deploy api -o jsonpath='{.spec.template.spec.volumes}'`,正常为空。
- push 后迟迟不部署(gitrepo 显示 `Stalled` / `GitPolling=False`),强制重同步:
  `kubectl -n fleet-local patch gitrepo memento --type merge -p '{"spec":{"forceSyncGeneration":<当前值+1>}}'`
