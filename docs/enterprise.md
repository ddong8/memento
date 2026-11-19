# memento 企业私有化部署指南

本文说明如何在企业内部部署 memento，以及部署后怎么做账号、权限、审计、数据合规和员工电脑的管控。所有设置都通过环境变量配置，服务端变量见 `server/server/config.py`，部署模板见 `deploy/enterprise/.env.example`。

## 1. 部署形态

一家企业部署一套独立的 memento：数据库、对象存储、缓存、接口、后台任务和网页都在企业自己的服务器上，数据不经过 memento 官方服务器。需要服务多家客户时，给每家客户各部署一套，各套之间的数据天然隔离。

| 组件 | 作用 | 数据 |
| :--- | :--- | :--- |
| postgres（含 pgvector） | 账号、对话、记忆、审计日志、向量 | 卷 `pgdata` |
| minio | 大文件、图片、附件 | 卷 `miniodata` |
| redis | 缓存、任务队列、多副本协调 | 卷 `redisdata` |
| api | 接口服务 | 无 |
| celery-worker / celery-beat | 后台整理、定时任务（含审计日志清理） | 无 |
| web | 网页端 | 无 |
| proxy（Caddy） | 统一入口与 HTTPS：`/api`、`/health`、`/install` 转给接口，其余转给网页 | 证书在卷 `caddydata` |

规模参考：几十人的团队用 4 核 8G 内存、100G 磁盘的服务器即可；人数更多时，可以把数据库换成企业已有的 PostgreSQL（需要 pgvector 扩展），也可以改用 `deploy/k8s` 里的 Kubernetes 清单部署多副本。

## 2. 单机安装（docker compose）

前提：一台 Linux 服务器，装好 Docker 24+ 和 Docker Compose 2.24+；员工能访问的一个域名。

```bash
git clone https://github.com/ddong8/memento.git
cd memento/deploy/enterprise
./memento.sh init --domain memento.example.com   # 生成 .env：随机密码与密钥，以及当前发布的镜像版本
vi .env                                           # 填模型服务、单点登录等（见第 3～6 节）
./memento.sh up                                   # 拉取镜像并启动
./memento.sh status                               # 检查各服务和接口是否正常
```

启动后访问 `https://memento.example.com`。第一个注册或用企业账号登录的人会成为所有者（最高管理员）。

HTTPS 的三种情况：

1) 公网可解析的域名：`MEMENTO_SITE` 写域名，入口会自动申请并续期证书。
2) 只在内网使用：`MEMENTO_TLS="tls internal"`，入口用自签根证书签发证书，需要把根证书（在入口容器里的 `/data/caddy/pki/authorities/local/root.crt`，可用 `docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt .` 取出）下发到员工电脑。
3) 前面已有公司负载均衡做 HTTPS：`MEMENTO_SITE=:80`，`MEMENTO_TLS` 留空，由负载均衡转发到这台机器的 80 端口。

### 无外网的服务器

在一台能上网的机器上打离线包，复制到服务器后导入：

```bash
./memento.sh init --domain memento.example.com   # 确定版本
./memento.sh bundle                               # 生成 memento-images-<版本>.tar.gz
# 复制整个 deploy/enterprise 目录和离线包到服务器
./memento.sh load memento-images-<版本>.tar.gz
./memento.sh up
```

使用公司内网镜像仓库（如 Harbor）时，把镜像推上去，在 `.env` 里设置 `MEMENTO_SERVER_IMAGE`、`MEMENTO_WEB_IMAGE`（以及 `POSTGRES_IMAGE`、`REDIS_IMAGE`、`MINIO_IMAGE`、`CADDY_IMAGE`）。

### 备份、恢复、升级

```bash
./memento.sh backup                 # 数据库（pg_dump，备份后校验）、对象存储和 .env 写到 backups/<时间>/
./memento.sh restore backups/<时间>  # 恢复前会先自动备份当前数据
./memento.sh upgrade                # 先备份，再升级到仓库里当前发布的版本；也可 --server-tag / --web-tag 指定
```

建议用 cron 每天执行一次 `backup`，并把 `backups/` 同步到另一台机器或对象存储上。`.env` 里的 `MEMENTO_SECRET_KEY` 和 `MEMENTO_DATA_KEY` 要和数据一起妥善保存：丢了它们，员工已保存的模型密钥就无法解开。

## 3. 账号与登录

### 单点登录（OpenID Connect）

支持任何标准 OpenID Connect 身份平台，例如 Keycloak、Authing、Azure AD（Entra ID）、Okta、Google Workspace。公司的 LDAP / AD 可以先接到 Keycloak 上；企业微信、钉钉、飞书可以先接入 Authing、Keycloak 这类身份平台，再由它们统一对接 memento。

在身份平台创建一个「机密客户端」（需要客户端密钥），回调地址填：

```
https://memento.example.com/api/auth/oidc/callback
```

然后在 `.env` 里配置：

| 变量 | 说明 |
| :--- | :--- |
| `MEMENTO_OIDC_ISSUER` | 身份平台的 Issuer 地址，例如 Keycloak 是 `https://sso.example.com/realms/<realm>` |
| `MEMENTO_OIDC_CLIENT_ID` / `MEMENTO_OIDC_CLIENT_SECRET` | 客户端编号和密钥 |
| `MEMENTO_OIDC_DISPLAY_NAME` | 登录按钮上的名字，默认「企业账号」 |
| `MEMENTO_OIDC_ALLOWED_DOMAINS` | 只允许这些邮箱域名，例如 `example.com,example.cn` |
| `MEMENTO_OIDC_AUTO_CREATE` | 第一次登录自动开通账号（关掉后只有管理员邀请或 SCIM 开通的人能进） |
| `MEMENTO_OIDC_ADMIN_GROUP` | 这个组的成员登录后是管理员，其他人是普通成员；每次登录按组同步，所有者不受影响 |

登录流程使用授权码加 PKCE，会校验身份令牌的签名、签发方、受众和一次性随机数。账号按身份平台的用户标识对应；已有账号只在邮箱经身份平台确认（或属于允许的公司域名）时才会自动关联，防止有人用同名邮箱冒充。

全员改用企业账号后，设置 `MEMENTO_PASSWORD_LOGIN=false`：普通成员和管理员不能再用密码、GitHub、微信登录，注册入口也会关闭。只有所有者还能用密码登录，用于身份平台出问题时进入系统。

### 账号同步与离职停用（SCIM 2.0）

设置 `MEMENTO_SCIM_TOKEN`（一串足够长的随机字符）后，身份平台可以通过 SCIM 自动开通和停用账号：

- 地址：`https://memento.example.com/api/scim/v2`
- 认证：`Authorization: Bearer <MEMENTO_SCIM_TOKEN>`
- 支持：`/Users` 的查询（`userName eq "..."` 过滤）、创建、修改（PUT / PATCH）、删除，以及 `/ServiceProviderConfig`、`/ResourceTypes`

员工离职时，身份平台把账号设为停用（或删除），memento 会立即停用该账号：网页登录、接口令牌和他电脑上设备的同步、远程任务全部失效。停用只改账号状态，不删除数据，便于审计和工作交接；确实需要删除时，由所有者在管理后台删除（审计记录会保留）。

## 4. 权限与数据隔离

`MEMENTO_ADMIN_SCOPE` 决定管理员能看到什么：

| 取值 | 管理员和所有者 |
| :--- | :--- |
| `own`（企业推荐） | 和普通成员一样，只能看到、操作自己的设备、对话、记忆和任务；仍可管理账号、邀请码、项目权限，查看审计日志。用户列表不显示别人的采集令牌，因为凭它可以冒充那个人登录 |
| `all`（默认，个人或家庭部署） | 能看到所有人的数据，也能向所有人的设备派发任务 |

无论哪种模式，普通成员之间的数据都是隔离的。需要让某人查看特定项目时，由管理员在管理后台的「权限」里单独授予。

## 5. 审计日志

以下操作会记录操作人、对象、时间、来源地址和关键信息，在管理后台的「审计」页查看，默认只显示这些操作：

- 登录：密码登录（成功和失败）、GitHub 登录、企业账号登录和被拒原因
- 账号：批准、修改角色或状态、重置采集令牌、删除、转让所有者，以及身份平台的开通、启用、停用
- 邀请码的创建和作废；项目权限的授予和收回
- 向设备派发命令（含命令前 300 字），访问他人的设备
- 修改模型配置（记录服务地址，不记录密钥）

审计记录保留 `MEMENTO_AUDIT_RETENTION_DAYS` 天（默认 365，0 为永久），每天 04:20 清理过期记录。删除账号时，这个人的审计记录会保留下来。

## 6. 模型与数据合规

- 员工的对话、代码片段会发给配置的大模型服务。企业部署建议用公司内网部署的模型：`MEMENTO_AI_BASE_URL`、`MEMENTO_AI_MODEL` 指向内网的 OpenAI 兼容接口；`MEMENTO_AI_FALLBACK_BASE_URL`、`MEMENTO_AI_FALLBACK_API_KEY` 都留空，就不会使用默认的备用模型服务。
- 向量模型同样用 OpenAI 兼容接口：`MEMENTO_EMBEDDING_API_URL` 指向内网部署的 bge-m3 等模型。
- `MEMENTO_ALLOWED_MODEL_HOSTS` 限定员工能自己配置的模型服务，例如 `llm.example.com,*.ai.example.com`。不在名单里的服务，保存和测试都会被拒绝；以前已保存的也不再使用。
- 员工自己填的模型 API 密钥在数据库里加密保存（`MEMENTO_DATA_KEY`），接口只返回遮住后的形式。启动时会把旧版本明文保存的密钥补加密。
- 员工可以在设置里导出自己的全部数据，也可以把某个项目设为「不采集」，并清除已采集的内容。所有者可以在管理后台整体删除一个人的账号和数据。

## 7. 员工电脑的管控

员工电脑上的 memento 客户端会采集 AI 编程工具的对话，并接收服务端派发的智能体任务和命令。企业可以从两层进行管控。

服务端（对全公司生效）：`MEMENTO_REMOTE_EXEC=0` 关闭远程任务，所有设备都不再接收命令和智能体任务。

跨设备任务里，智能体在另一台电脑上改代码，测试、构建等命令回到代码所在的电脑上执行（`memento-source`）。`MEMENTO_REMOTE_EXEC_POLICY` 决定这些命令和它写的项目以外的文件拦不拦：

| 取值 | 效果 |
| :--- | :--- |
| `off`（不设时的默认） | 都不拦。有风险的命令（sudo、改 /etc、rm -rf、重启服务等）和写敏感位置（.ssh、.env、系统配置、shell 启动脚本、凭据）照常执行，同时记到任务上并推送提醒 |
| `catastrophic`（企业部署模板的设置） | 另外拦下会毁掉那台电脑的命令：格式化磁盘、删除整个主目录或系统目录、让它关机或重启。经 ssh 发到别的服务器上执行的部分不算 |
| `strict` | 拦下所有有风险的命令和敏感位置的文件 |

单台电脑（由 IT 通过 MDM、组策略统一下发）：放一个只有管理员能修改的策略文件：

| 系统 | 路径 |
| :--- | :--- |
| macOS | `/Library/Application Support/Memento/managed.json` |
| Windows | `%ProgramData%\Memento\managed.json` |
| Linux | `/etc/memento/managed.json` |

```json
{
  "server_url": "https://memento.example.com",
  "remote_tasks": "agent",
  "allowed_roots": ["~/work", "/srv/repos"]
}
```

| 字段 | 说明 |
| :--- | :--- |
| `server_url` | 固定连接公司的服务器，员工在应用里不能切换到别的服务器 |
| `remote_tasks` | `all`：智能体任务和命令都接收（默认）；`agent`：只接收智能体任务，不直接执行命令；`none`：不接收任何远程任务 |
| `allowed_roots` | 远程任务只能在这些目录里运行；服务端读取文件、为其他设备打包代码、写入文件也只限于这些目录。不写则不限制 |

策略文件在应用启动时读取，修改后重启应用生效。文件格式错误时会忽略出错的字段，不会让员工无法使用。

## 8. 安装包签名

官方发布的安装包没有正式签名，员工安装时可能看到「无法验证开发者」的提示。企业要分发正式签名的安装包时，在自己 fork 的仓库里配置以下 GitHub Actions Secrets，发版流水线（`.github/workflows/desktop-release.yml`）会自动签名：

| Secret | 说明 |
| :--- | :--- |
| `MAC_CSC_LINK` | Developer ID Application 证书（.p12）的 base64 内容 |
| `MAC_CSC_KEY_PASSWORD` | 证书密码 |
| `MAC_CSC_NAME` | 证书名称，例如 `Developer ID Application: Example Co., Ltd. (TEAMID)` |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 用于苹果公证（Apple ID、App 专用密码、团队编号） |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows 代码签名证书（.pfx 的 base64 内容）和密码 |

配置了 Mac 证书后，安装包会启用 hardened runtime（使用 `apps/desktop/build/entitlements.mac.plist`）并提交公证；应用自动更新时会保留正式签名。没有配置时，构建方式和现在完全一样。

## 9. 上线前检查清单

1) `.env` 里的密码和密钥都是 `init` 生成的随机值，`.env` 和备份目录只有管理员可读。
2) `MEMENTO_ADMIN_SCOPE=own`，`MEMENTO_REGISTRATION_MODE` 设为 `closed` 或 `invite_only`。
3) 单点登录测试通过后，设置 `MEMENTO_PASSWORD_LOGIN=false`；身份平台配置 SCIM 停用账号。
4) 模型和向量服务指向内网，备用模型服务留空；按需设置 `MEMENTO_ALLOWED_MODEL_HOSTS`。
5) 通过 MDM 下发 `managed.json`，固定服务器地址，并按公司安全要求设置 `remote_tasks` 和 `allowed_roots`。
6) 配置每日备份，并实际演练一次 `restore`。
7) 管理后台「审计」页能看到登录和管理操作的记录。
