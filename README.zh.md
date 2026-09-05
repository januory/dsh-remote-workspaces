# dsh-remote-workspaces

[English](README.md) | 中文

通过 SSH 把远程主机上的目录，像打开本地文件夹一样，作为[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工作区打开工作。

## 它做了什么

远程目录一旦被打开为工作区，agent 的文件工具（`read` / `write` / `edit` /`grep` / `glob`）和 shell 命令都会**直接落到远主机**上执行，而不是本地镜像。这里没有镜像、没有同步：每个操作都在远端实时执行，而本地工作区仍保留 harness 自身的完整沙箱行为。

## 功能特性

- **把远程目录当作工作区打开** —— 浏览远程文件系统、选中目录，harness 会像对待本地目录一样接纳它；所有 I/O 都路由到远端。
- **多主机注册表** —— 增删改 SSH 主机（别名 / 主机 / 端口 / 用户 / 密钥或密码）。凭据在本地用 AES-256-GCM 加密落盘，绝不会回传到浏览器。
- **`~/.ssh/config` 导入** —— 列出已配置的别名并自动填充连接表单。
- **连接测试** —— 使用前先验证主机连通性。
- **透明的工具路由** —— `read`/`write`/`edit` 走 SFTP，`grep`/`glob` 在远端跑ripgrep，`bash`/`pwsh` 命令通过 ssh2 exec 执行。本地路径沿用 harness 自身的沙箱。
- **感知权限策略的远端写操作** —— harness 的文件策略同样作用于远程工作区：`read-only` 会拒绝 `write`/`edit` 和远程 shell 命令，`workspace-write` 把 `write`/`edit` 限制在远程工作区根目录（以及 `/tmp`）内、而远程 shell 命令需经 `danger-full-access` 审批后放行，`danger-full-access` 则交由 SSH 账号自身权限决定。

## 工作原理

bundle 分为宿主机侧（host）和浏览器侧（browser）两半：

- **Host**（`src/index.js`）—— 基于
  [`ssh2`](https://github.com/mscdex/ssh2) 的 SSH/SFTP 传输、加密主机存储、分流文件系统（`ctx.fs`）与 shell（`ctx.shell`）provider、远程感知的`grep`/`glob` 工具，以及通过 Typert 暴露的 `remoteWorkspaces` Remote 命名空间。
- **Browser**（`src/client.js`）—— “远程工作区”设置页（按主机分组）以及一个“添加工作区”的选择器。

打开远程目录会创建一个**锚点（anchor）**：一个被 harness 接纳为工作区身份的真实但为空的本地目录，外加一个记录其远程来源的元数据文件。注册表（`anchors.json`）把该锚点映射到远程主机与路径，所有文件/命令操作都据此查表路由到远端：

```
$DSH_HOME/remote-workspaces/
├── machines.json              # 主机注册表（凭据加密落盘）
├── anchors.json               # 锚点 → 远程来源 路由注册表
└── <host>-<user>-<port>/      # 每台主机的锚点
    └── <encoded-path>/        # 每个远程路径对应一个空锚点
    │   └── .dsh-remote-meta.json
```

远程完整路径会被编码进锚点目录名（路径分隔符和 Windows 非法字符变成 `--`），因此 `/home/test` 和 `/data/test` 会落到不同的目录（`home--test` vs `data--test`）。

## 环境要求

- 一个 DeepSeek Harness 安装（插件在运行时解析其宿主服务）。
- Node.js ≥ 18（harness 本身运行在 Node 22+）。
- `ssh2` 是唯一的传输依赖；不需要外部 `ssh` 命令。
- 远端主机需要 `rg`（ripgrep）以支持 `grep`/`glob`，以及 `sha256sum`（或`shasum`）用于写入后校验——二者缺失时都会优雅降级。

## 安装

从本仓库在线安装：

```sh
dsh plugin --profile web add github:januory/dsh-remote-workspaces
```

发布到 npm 后，也可以直接安装已发布的包：

```sh
dsh plugin --profile web add dsh-remote-workspaces
```

从源码安装：

```sh
git clone https://github.com/januory/dsh-remote-workspaces.git

cd dsh-remote-workspaces

pnpm install  # 安装 ssh2 传输依赖

dsh plugin --profile web add .
```

卸载：

```sh
dsh plugin --profile web remove dsh-remote-workspaces
```

> 维护者注：npm 包名现为 `dsh-remote-workspaces`（早期 git 安装时的包名是 `remote-workspaces`）；旧安装请先 `dsh plugin --profile <name> remove remote-workspaces`，再按新名安装。

## 使用

1. 打开 **设置 → 远程工作区**。
2. 添加一台 SSH 主机（或从 `~/.ssh/config` 导入），然后点 **测试连接**。
3. 在“添加工作区”流程里选择远程主机、浏览到某个目录并打开。harness 会把空锚点接纳为工作区，之后的读取、写入、搜索和 shell 命令都在远端执行。

## Remote API

宿主通过 Typert 暴露 `remoteWorkspaces` Remote 命名空间，包含这些调用：
`listMachines`、`saveMachine`、`deleteMachine`、`listSshAliases`、`sshAliasDetail`、`testConnection`、`listRemoteDir`、`openRemoteWorkspace`。

## 目录结构

```
src/                          # DSH bundle 源码
  index.js                    # 宿主入口（分流 fs/shell、搜索工具、Remote 命名空间）
  client.js                   # 浏览器入口（设置页 UI + 选择器）
  transport.js                # ssh2 传输（SshClient、exec、sha256）
  routing-fs.js               # 分流文件系统（远端 SFTP / 本地围栏）
  fs-sftp.js                  # SFTP 文件系统后端
  local-backend.js            # 本地文件系统后端
  containment.js              # 本地沙箱围栏
  shell-exec.js               # SshShellExecutor（远端 ssh2 exec / 本地 subprocess）
  search.js                   # 远程感知的 grep/glob 工具
  anchor.js                   # 本地锚点布局（空目录 + 元数据）
  registry.js                 # anchors.json 路由注册表
  machine-store.js            # 主机注册表（加密落盘）
  ssh-config.js               # ~/.ssh/config 解析
  ssh-uri.js                  # ssh:// URI 解析与识别
  errors.js                   # 错误码
cordis.patch.yml              # DSH bundle patch（换入分流 provider）
package.json                  # 包 + dsh 清单
test/                         # 单元 + 集成测试
```

## 测试

纯单元测试（无需任何主机）可在任意环境运行：

```sh
pnpm test
```

集成测试需要访问真实 SSH 主机，且需先配置好主机注册表（默认使用注册表里的第一台主机，或别名为 `test` 的那台）：

```sh
pnpm test:integration
```

## 发布（维护者）

发布完全手动触发、**零输入**：版本号直接取自 `package.json`，发布前先在 `main` 上提交改好的 `version`，然后 GitHub Actions → **release** → **Run workflow** 即可。工作流会自动执行：跑单元测试（`npm test`）→ 校验 `v<version>` tag 尚未存在（防止重复发布）→ `npm publish`（带 provenance）→ 打 `v<version>` tag 并推送 → 用 `--generate-notes` 创建 GitHub Release。

前提：在仓库 **Settings → Secrets and variables → Actions** 中配置名为 `NPM_TOKEN` 的 secret（npm automation token，或对该包有 publish 权限的 granular token）；发布账号须是持有该包名的 npm 用户。

等价的手工流程：

```sh
npm login

npm publish --provenance

git tag "v$(node -p \"require('./package.json').version\")"

git push origin --tags
```

## 开源协议

[MIT](./LICENSE)
