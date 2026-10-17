# memento — 项目须知(给 AI)

## 部署 / CI-CD 铁律(GitOps,勿手动操作集群)

本项目通过 **GitOps** 自动部署到 NAS 上的 k3s 集群(命名空间 `memento`),由 Rancher Fleet 拉取式部署,对外 mem.ihasy.com。
**禁止**用手动 `docker build` / `kubectl apply` / `kubectl set image` / 手改 kustomization 镜像 tag 的方式上线。

正确流程:**改代码 → push 到 main → GitHub Actions 自动构建镜像推 GHCR → 自动回写 kustomization 镜像 tag → Fleet 检测到 → 集群拉新镜像滚动。** 你只需提交代码。

- 触发路径:push main 改 `server/**` / `web/**` / `packages/**` / `deploy/bootstrap/**` 等(完整列表见 deploy.yml 的 `on.push.paths`)。`mcp_server/**` 不在镜像里,改它不会触发部署。
- 构建镜像:`ghcr.io/ddong8/memento-{server,web}`(**公开** GHCR)。
- **公开仓库 → 不要往仓库里放任何 Secret**;postgres / redis / minio 与 Secret 都在集群内手工维护、不进仓库,deploy/k8s 里只引用。

### 关键约束(改 CI/部署相关时务必遵守)
- 集群拉 GHCR 镜像、以及 Fleet 克隆 github,**都经一台 Mac 上的 Clash 代理**绕开国内限速(地址在集群的代理配置里,不写进公开仓库)。部署时需这台 Mac 的 Clash 在线(已缓存镜像/已同步代码不受影响)。
- CI 装 kustomize 用「release CDN 直接下载固定版」(`releases/download/.../kustomize_v5.4.3_...`),**不要改回 `install_kustomize.sh`**——它查 GitHub API,共享 runner 上会撞限流导致部署失败。
- 镜像 tag 由 CI 自动 bump,**不要手改**。
- bot 回写提交带 `[skip ci]`(GitHub 上真生效、不是装饰),避免触发死循环。
- **不要用 ConfigMap 挂载覆盖镜像里的代码文件做热修复。** 2026-10-13 有人这样给 api 挂了 projects.py、ingest_service.py、user_filter.py,补丁一直没撤,之后这三个文件的改动在线上全部不生效(镜像照常更新,文件被挂载盖住)。Fleet 不把这类手动加的挂载算作漂移,不会自动清掉。确实要紧急止血,也要在修复随镜像上线后立刻删掉挂载和 ConfigMap。

### 查状态 / 排障
- 构建:`gh run list --workflow=deploy.yml`
- 集群:`kubectl -n fleet-local get gitrepo memento`、`kubectl -n memento get pods`
- 已部署但改动没生效:先看 api 有没有被挂载覆盖,`kubectl -n memento get deploy api -o jsonpath='{.spec.template.spec.volumes}'`,正常为空。
- push 后迟迟不部署(gitrepo 显示 `Stalled` / `GitPolling=False`),强制重同步:
  `kubectl -n fleet-local patch gitrepo memento --type merge -p '{"spec":{"forceSyncGeneration":<当前值+1>}}'`
