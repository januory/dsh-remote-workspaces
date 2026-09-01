# dsh-remote-workspaces

English | [中文](README.zh.md)

Open folders on remote hosts over SSH as first-class [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspaces.

## What it does

Once a remote directory is opened as a workspace, the agent's file tools (`read` / `write` / `edit` / `grep` / `glob`) and shell commands land **directly on the remote host** over SSH, not a local mirror. There is no mirroring and no sync: every operation is executed remotely in real time, and local workspaces keep their full sandbox behavior.

## Features

- **Open a remote folder as a workspace** — browse the remote filesystem, pick a directory, and the harness adopts it as if it were local. All I/O routes to the remote.
- **Multi-machine registry** — add, edit, and remove SSH hosts (alias, host, port, user, key or password). Credentials are AES-256-GCM encrypted at rest and never sent back to the browser.
- **`~/.ssh/config` import** — list configured aliases and pre-fill the connection form.
- **Connection test** — verify a host before using it.
- **Transparent tool routing** — `read`/`write`/`edit` go through SFTP, `grep`/`glob` run ripgrep on the remote, and `bash`/`pwsh` commands execute over ssh2 exec. Local paths keep the harness's own sandbox.

## How it works

The bundle has a host half and a browser half:

- **Host** (`src/index.js`) — an SSH/SFTP transport built on [`ssh2`](https://github.com/mscdex/ssh2), an encrypted machine store, the routing filesystem (`ctx.fs`) and shell (`ctx.shell`) providers, remote-aware `grep`/`glob` tools, and a `remoteWorkspaces` Remote namespace exposed through Typert.
- **Browser** (`src/client.js`) — a "Remote Workspaces" settings section (hosts grouped by machine) and a workspace-add picker.

Opening a remote directory creates an **anchor**: a real but empty local directory adopted by the harness as the workspace identity, plus a metadata file recording its remote origin. A registry (`anchors.json`) maps that anchor to its remote host and path, and every file/command operation is routed to the remote by that lookup:

```
$DSH_HOME/remote-workspaces/
├── machines.json              # host registry (credentials encrypted at rest)
├── anchors.json               # anchor → remote origin routing registry
└── <host>-<user>-<port>/      # per-host anchors
    └── <encoded-path>/        # one empty anchor per remote path
    │   └── .dsh-remote-meta.json
```

The full remote path is encoded into the anchor name (path separators and Windows-illegal characters become `--`), so `/home/test` and `/data/test` map to distinct directories (`home--test` vs `data--test`).

## Requirements

- A DeepSeek Harness installation (the plugin resolves its host services at runtime).
- Node.js ≥ 18 (the harness itself runs on Node 22+).
- `ssh2` is the only transport dependency; no external `ssh` binary is needed.
- The remote host needs `rg` (ripgrep) for `grep`/`glob`, and `sha256sum` (or `shasum`) for post-write verification — both degrade gracefully when absent.

## Installation

Install from this repository:

```sh
dsh plugin --profile web add github:januory/dsh-remote-workspaces
```

Install from source:

```sh
git clone https://github.com/januory/dsh-remote-workspaces.git

cd dsh-remote-workspaces

pnpm install  # install the ssh2 transport dependency

dsh plugin --profile web add .
```

Remove it with:

```sh
dsh plugin --profile web remove remote-workspaces
```

## Usage

1. Open **Settings → Remote Workspaces**.
2. Add an SSH host (or import one from `~/.ssh/config`), then **Test connection**.
3. In the workspace-add flow, choose a remote host, browse to a directory, and open it. The harness adopts the empty anchor as a workspace, and reads, writes, searches, and shell commands all execute on the remote.

## Remote API

The host exposes a `remoteWorkspaces` Remote namespace (Typert) with these invocations: `listMachines`, `saveMachine`, `deleteMachine`, `listSshAliases`, `sshAliasDetail`, `testConnection`, `listRemoteDir`, and `openRemoteWorkspace`.

## Repository structure

```
src/                          # the DSH bundle source
  index.js                    # host entry (routing fs/shell, search tools, Remote namespace)
  client.js                   # browser entry (settings UI + picker)
  transport.js                # ssh2 transport (SshClient, exec, sha256)
  routing-fs.js               # routing filesystem (remote SFTP / local fence)
  fs-sftp.js                  # SFTP filesystem backend
  local-backend.js            # local filesystem backend
  containment.js              # local sandbox containment fence
  shell-exec.js               # SshShellExecutor (remote ssh2 exec / local subprocess)
  search.js                   # remote-aware grep/glob tools
  anchor.js                   # local anchor layout (empty dir + meta)
  registry.js                 # anchors.json routing registry
  machine-store.js            # host registry (encrypted at rest)
  ssh-config.js               # ~/.ssh/config parser
  ssh-uri.js                  # ssh:// URI parsing + detection
  errors.js                   # error codes
cordis.patch.yml              # DSH bundle patch (swap in the routing providers)
package.json                  # package + dsh manifest
test/                         # unit + integration tests
```

## Testing

Pure unit tests (no host required) run anywhere:

```sh
pnpm test
```

The integration suite exercises a real SSH host and expects the machine registry to be configured first (it targets the first machine in the registry, or the one aliased `test`):

```sh
pnpm test:integration
```

## License

[MIT](./LICENSE)
