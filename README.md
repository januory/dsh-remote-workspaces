# dsh-remote-workspaces

English | [中文](README.zh.md)

Open folders on remote hosts over SSH as first-class
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspaces —
without modifying the harness itself.

The whole repository is a non-invasive DSH **bundle**. No changes to the
`deepseek-harness` source tree are required.

## Features

- **Open a remote folder as a workspace** — browse the remote filesystem, pick a
  directory, and the harness adopts it as if it were local.
- **Multi-machine registry** — add, edit, and remove SSH hosts (alias, host,
  port, user, key or password). Credentials stay on disk and are never sent back
  to the browser.
- **`~/.ssh/config` import** — list configured aliases and pre-fill the
  connection form.
- **Connection test** — verify a host before using it.
- **Two-way sync (remote wins)** — mirror a remote directory to a real local
  directory, with a three-way manifest, SHA-256 change detection, and
  `fs.watch` auto-push (debounced).
- **Sync history** — an append-only, bounded JSONL log of sync runs (metadata
  only; never file contents or credentials).
- **Workspace cleanup** — detect mirrors whose workspace was deleted and remove
  them from settings.
- **Model tool** — lets the agent read sync history.

## How it works

The bundle has a host half and a browser half:

- **Host** (`src/index.js`) — an SSH/SFTP transport built on
  [`ssh2`](https://github.com/mscdex/ssh2), a persistent machine store, the
  mirror/sync engine, and a `remoteWorkspaces` Remote namespace exposed through
  Typert.
- **Browser** (`src/client.js`) — a "Remote Workspaces" settings section (hosts
  grouped by machine, mirrors, sync log, orphan cleanup) and a workspace-add
  picker.

A remote directory is mirrored to a real local directory under the DSH home:

```
$DSH_HOME/remote-workspaces/
├── machines.json              # host registry (credentials stored locally)
├── .dsh-sync-log.jsonl        # sync history (metadata only, bounded)
└── <host>-<user>-<port>/      # per-host mirrors
    └── <encoded-path>/        # one mirror per remote path
```

The full remote path is encoded into the mirror name (path separators and
Windows-illegal characters become `--`), so `/home/test` and `/data/test` map to
distinct directories (`home--test` vs `data--test`).

## Requirements

- A DeepSeek Harness installation (the plugin resolves its host services at
  runtime).
- Node.js ≥ 18 (the harness itself runs on Node 22+).
- `ssh2` is the only transport dependency; no external `ssh` binary is needed.

## Installation

Install from this repository:

```sh
dsh plugin --profile web add github:januory/dsh-remote-workspaces
```

For local development, install from a checkout:

```sh
# from the repository root
pnpm install                 # install the ssh2 transport dependency
dsh plugin --profile web add .
```

Remove it with:

```sh
dsh plugin --profile web remove remote-workspaces
```

## Usage

1. Open **Settings → Remote Workspaces**.
2. Add an SSH host (or import one from `~/.ssh/config`), then **Test
   connection**.
3. In the workspace-add flow, choose a remote host, browse to a directory, and
   open it. The harness adopts the local mirror as a workspace.
4. Edits sync back automatically. The settings section shows mirrors per host,
   the sync log, and any orphaned (deleted) workspaces to clean up.

## Remote API

The host exposes a `remoteWorkspaces` Remote namespace (Typert) with these
invocations: `listMachines`, `saveMachine`, `deleteMachine`, `listSshAliases`,
`sshAliasDetail`, `testConnection`, `listRemoteDir`, `mirrorRemote`,
`listMirrors`, `syncMirror`, `listSyncLog`, `clearSyncLog`, `removeMirror`, and
`cleanOrphans`.

## Repository structure

```
src/                          # the DSH bundle source
  index.js                    # host entry (Remote namespace, watchers, tool)
  client.js                   # browser entry (settings UI + picker)
  transport.js                # ssh2 transport (SshClient)
  sync.js                     # three-way manifest sync (remote wins)
  mirror.js                   # local mirror layout
  sync-log.js                 # sync history log
  machine-store.js            # host registry
  ssh-config.js               # ~/.ssh/config parser
  ssh-uri.js                  # ssh:// URI parsing + detection
  fs-sftp.js                  # SFTP filesystem backend
  local-backend.js            # local filesystem backend
  routing-fs.js               # routing filesystem (local + ssh://)
  fs-plugin.js                # ctx.fs mount entry (phase 2, not yet enabled)
  errors.js                   # error codes
cordis.patch.yml              # DSH bundle patch (mounts the host half)
package.json                  # package + dsh manifest
test/                         # unit + integration tests
```

## Testing

The suite lives under `test/`. The pure test (no host required) runs anywhere:

```sh
node test/unit-mirror-path.mjs
```

The remaining tests exercise a real SSH host and expect the machine registry to
be configured first.

## License

[MIT](./LICENSE)
