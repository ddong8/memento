# deploy/k8s

GitOps 部署清单(Fleet 拉取,见仓库根 CLAUDE.md)。镜像 tag 由 CI 回写,勿手改。

## GitHub OAuth(可选)

client id / secret **不进仓库**,手工写进集群内 Secret(api 已 envFrom `memento-secret`,加了即生效):

```bash
kubectl -n memento patch secret memento-secret --type merge -p '{"stringData":{"MEMENTO_GITHUB_CLIENT_ID":"...","MEMENTO_GITHUB_CLIENT_SECRET":"..."}}'
```

GitHub OAuth App 的 callback URL 须设为 `https://mem.ihasy.com/api/auth/github/callback`。
