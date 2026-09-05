# memento — 项目须知(给 AI)

## 部署 / CI-CD 铁律(GitOps,勿手动操作集群)

本项目通过 **GitOps** 自动部署到 NAS 上的 k3s 集群(命名空间 `memento`),由 Rancher Fleet 拉取式部署,对外 mem.ihasy.com。
**禁止**用手动 `docker build` / `kubectl apply` / `kubectl set image` / 手改 kustomization 镜像 tag 的方式上线。

正确流程:**改代码 → push 到 main → GitHub Actions 自动构建镜像推 GHCR → 自动回写 kustomization 镜像 tag → Fleet 检测到 → 集群拉新镜像滚动。** 你只需提交代码。

- 触发路径:push main 改 `server/**` / `web/**` / `mcp_server/**`。
- 构建镜像:`ghcr.io/ddong8/memento-{server,web}`(**公开** GHCR)。
- **公开仓库 → 不要往仓库里放任何 Secret**;postgres / redis / minio 与 Secret 都在集群内手工维护、不进仓库,deploy/k8s 里只引用。

### 关键约束(改 CI/部署相关时务必遵守)
- 集群拉 GHCR 镜像、以及 Fleet 克隆 github,**都经 Mac 的 Clash 代理(`192.168.1.87:10808`)** 绕开国内限速。部署时需这台 Mac 的 Clash 在线(已缓存镜像/已同步代码不受影响)。
- CI 装 kustomize 用「release CDN 直接下载固定版」(`releases/download/.../kustomize_v5.4.3_...`),**不要改回 `install_kustomize.sh`**——它查 GitHub API,共享 runner 上会撞限流导致部署失败。
- 镜像 tag 由 CI 自动 bump,**不要手改**。
- bot 回写提交带 `[skip ci]`(GitHub 上真生效、不是装饰),避免触发死循环。

### 查状态 / 排障
- 构建:`gh run list --workflow=deploy.yml`
- 集群:`kubectl -n fleet-local get gitrepo memento`、`kubectl -n memento get pods`
- push 后迟迟不部署(gitrepo 显示 `Stalled` / `GitPolling=False`),强制重同步:
  `kubectl -n fleet-local patch gitrepo memento --type merge -p '{"spec":{"forceSyncGeneration":<当前值+1>}}'`
