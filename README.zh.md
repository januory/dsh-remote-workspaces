# dsh-remote-workspaces

[English](README.md) | 中文

通过 SSH 把远程主机上的目录，像打开本地文件夹一样，作为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工作区打开——
**无需修改 harness 本身**。

整个仓库本身就是一个非侵入式 DSH **bundle**，不改动 `deepseek-harness` 的任何源码。

## 功能特性

- **把远程目录当作工作区打开** —— 浏览远程文件系统、选中目录，harness 会像对待本地
  目录一样接纳它。
- **多主机注册表** —— 增删改 SSH 主机（别名 / 主机 / 端口 / 用户 / 密钥或密码）。
  凭据只保存在本地磁盘，绝不会回传到浏览器。
- **`~/.ssh/config` 导入** —— 列出已配置的别名并自动填充连接表单。
- **连接测试** —— 使用前先验证主机连通性。
- **双向同步（远程优先）** —— 把远程目录镜像到真实的本地目录，基于三方清单、
  SHA-256 变更检测，以及 `fs.watch` 自动推送（带防抖）。
- **同步历史** —— 追加式、有上限的 JSONL 日志（只记元数据，绝不记录文件内容或凭据）。
- **工作区清理** —— 检测已被删除的工作区对应的镜像，并在设置页里手动清理。
- **模型工具** —— 让 agent 可以读取同步历史。

## 工作原理

bundle 分为宿主机侧（host）和浏览器侧（browser）两半：

- **Host**（`src/index.js`）—— 基于
  [`ssh2`](https://github.com/mscdex/ssh2) 的 SSH/SFTP 传输、持久化主机存储、
  镜像/同步引擎，以及通过 Typert 暴露的 `remoteWorkspaces` Remote 命名空间。
- **Browser**（`src/client.js`）—— “远程工作区”设置页（按主机分组、镜像列表、
  同步日志、孤儿清理）以及一个“添加工作区”的选择器。

远程目录会被镜像到 DSH 家目录下的一个真实本地目录：

```
$DSH_HOME/remote-workspaces/
├── machines.json              # 主机注册表（凭据保存在本地）
├── .dsh-sync-log.jsonl        # 同步历史（仅元数据，有上限）
└── <host>-<user>-<port>/      # 每台主机的镜像
    └── <encoded-path>/        # 每个远程路径对应一个镜像
```

远程完整路径会被编码进镜像目录名（路径分隔符和 Windows 非法字符变成 `--`），
因此 `/home/test` 和 `/data/test` 会落到不同的目录（`home--test` vs `data--test`）。

## 环境要求

- 一个 DeepSeek Harness 安装（插件在运行时解析其宿主服务）。
- Node.js ≥ 18（harness 本身运行在 Node 22+）。
- `ssh2` 是唯一的传输依赖；不需要外部 `ssh` 命令。

## 安装

从本仓库在线安装：

```sh
dsh plugin --profile web add github:januory/dsh-remote-workspaces
```

本地开发时，从源码 checkout 安装：

```sh
# 在仓库根目录执行
pnpm install                 # 安装 ssh2 传输依赖
dsh plugin --profile web add .
```

卸载：

```sh
dsh plugin --profile web remove remote-workspaces
```

## 使用

1. 打开 **设置 → 远程工作区**。
2. 添加一台 SSH 主机（或从 `~/.ssh/config` 导入），然后点 **测试连接**。
3. 在“添加工作区”流程里选择远程主机、浏览到某个目录并打开。harness 会把本地镜像
   接纳为工作区。
4. 修改会自动同步回去。设置页会展示每台主机的镜像、同步日志，以及可清理的
   已删除工作区。

## Remote API

宿主通过 Typert 暴露 `remoteWorkspaces` Remote 命名空间，包含这些调用：
`listMachines`、`saveMachine`、`deleteMachine`、`listSshAliases`、
`sshAliasDetail`、`testConnection`、`listRemoteDir`、`mirrorRemote`、
`listMirrors`、`syncMirror`、`listSyncLog`、`clearSyncLog`、`removeMirror`、
`cleanOrphans`。

## 目录结构

```
src/                          # DSH bundle 源码
  index.js                    # 宿主入口（Remote 命名空间、监听器、工具）
  client.js                   # 浏览器入口（设置页 UI + 选择器）
  transport.js                # ssh2 传输（SshClient）
  sync.js                     # 三方清单同步（远程优先）
  mirror.js                   # 本地镜像布局
  sync-log.js                 # 同步历史日志
  machine-store.js            # 主机注册表
  ssh-config.js               # ~/.ssh/config 解析
  ssh-uri.js                  # ssh:// URI 解析与识别
  fs-sftp.js                  # SFTP 文件系统后端
  local-backend.js            # 本地文件系统后端
  routing-fs.js               # 分流文件系统（本地 + ssh://）
  fs-plugin.js                # ctx.fs 挂载入口（第二阶段，暂未启用）
  errors.js                   # 错误码
cordis.patch.yml              # DSH bundle patch（挂载宿主半边）
package.json                  # 包 + dsh 清单
test/                         # 单元 + 集成测试
```

## 测试

测试位于 `test/`。纯逻辑测试（无需任何主机）可在任意环境运行：

```sh
node test/unit-mirror-path.mjs
```

其余测试需要访问真实 SSH 主机，且需先配置好主机注册表。

## 开源协议

[MIT](./LICENSE)
