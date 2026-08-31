import { existsSync, mkdirSync, rmSync, watch } from 'node:fs'
import { basename } from 'node:path'
import { SshClient, defaultSshConfigPath, hostsFromConfig, shellQuote } from './transport.js'
import { loadMachines, sanitizeMachine, upsertMachine, removeMachine, machineById, machineForRemote, ensureSecretsEncrypted } from './machine-store.js'
import { ensureMirror, pullTree, remoteWorkspacesRoot } from './mirror.js'
import { syncMirror, recordInitialBase, enumerateMirrors, summaryOf, readMeta, mirrorForChange } from './sync.js'
import { appendSyncLog, readSyncLog, clearSyncLog } from './sync-log.js'

export { parseSshConfig, expandTilde } from './ssh-config.js'
export { SshClient, hostsFromConfig, shellQuote, defaultSshConfigPath, clientForHost } from './transport.js'
export { SftpBackend } from './fs-sftp.js'
export { LocalBackend } from './local-backend.js'
export { parseSshUri, isRemoteCwd } from './ssh-uri.js'
export { fsError } from './errors.js'
export { RoutingFileSystem } from './routing-fs.js'
export { loadMachines, sanitizeMachine, upsertMachine, removeMachine, machinesPath } from './machine-store.js'

/**
 * Host half of the SSH remote workspace bundle (`remote-workspaces`).
 *
 * Publishes a `remoteWorkspaces` Remote namespace for the "远程工作区"
 * settings page: a persistent multi-machine SSH registry (add / edit / delete,
 * secrets stored locally and never sent back), a `~/.ssh/config` convenience
 * (list aliases, fill one into the form), connection test, and remote
 * directory browsing. The namespace is registered through the Typert registry
 * with hand-written strict codecs (no build step, no zod).
 *
 * The `ctx.fs` routing swap is intentionally NOT mounted yet; that is a
 * separate, verified step.
 */

export const name = 'remote-workspaces'

// ---------------------------------------------------------------------------
// Remote contract. The client half (src/client.js) keeps an identical copy.
// ---------------------------------------------------------------------------
const PACKAGE = 'remote-workspaces'
const NAMESPACE = 'remoteWorkspaces'

const JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  schema: Object.freeze({ parse(value) { return value } }),
})

function jsonParameter(name) {
  return { name, wire: name, source: 'json', codec: JSON_CODEC }
}

function invocation(method, parameters = []) {
  return {
    id: `${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: JSON_CODEC,
  }
}

const INVOCATIONS = [
  invocation('listMachines'),
  invocation('saveMachine', [jsonParameter('machine')]),
  invocation('deleteMachine', [jsonParameter('id')]),
  invocation('listSshAliases'),
  invocation('sshAliasDetail', [jsonParameter('alias')]),
  invocation('testConnection', [jsonParameter('machine')]),
  invocation('listRemoteDir', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('mirrorRemote', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('listMirrors'),
  invocation('syncMirror', [jsonParameter('localDir')]),
  invocation('listSyncLog', [jsonParameter('query')]),
  invocation('clearSyncLog'),
  invocation('removeMirror', [jsonParameter('localDir')]),
  invocation('cleanOrphans'),
]

// Per-mirror concurrency guards: a mirror must never be deleted while a sync is
// in flight, otherwise the sync's next diff could read the local deletion as a
// "local delete" and delete remote files. `syncInFlight` holds the running sync
// promise per localDir; `removingSet` marks a mirror being torn down so no new
// sync starts for it.
const syncInFlight = new Map()
const removingSet = new Set()
let workspaceRegistry = undefined

/** Build an `SshClient` from a machine record (alias/host/port/user/identityFile). */
function sshClientFor(machine) {
  const m = machine ?? {}
  // Secrets never ride the browser wire (sanitizeMachine strips them), so a
  // connection for a saved machine recovers its password/passphrase from the
  // store by id. A machine being tested before saving may still carry them.
  const stored = m.id !== undefined ? machineById(m.id) : undefined
  return new SshClient({
    alias: m.alias,
    host: m.host,
    user: m.user,
    port: m.port,
    identityFile: m.identityFile,
    password: m.password ?? stored?.password,
    passphrase: m.passphrase ?? stored?.passphrase,
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reconnect to a mirror's origin and run one full bidirectional sync. The
 * mirror's `.dsh-remote-meta.json` records host/port/user, which are matched
 * back to a saved machine (and its secret) via `machineForRemote`. Successful
 * syncs are logged inside `syncMirror`; this wrapper logs the failure paths.
 */
async function syncLocalMirror(localDir, trigger = 'manual') {
  if (removingSet.has(localDir)) return { ok: false, error: '镜像正在删除，跳过同步' }
  if (syncInFlight.has(localDir)) return { ok: false, error: '同步进行中，跳过' }
  const run = syncLocalMirrorInner(localDir, trigger)
  syncInFlight.set(localDir, run)
  try {
    return await run
  } finally {
    syncInFlight.delete(localDir)
  }
}

async function syncLocalMirrorInner(localDir, trigger) {
  const meta = readMeta(localDir)
  if (meta === null) return { ok: false, error: '不是远程工作区镜像（缺少 .dsh-remote-meta.json）' }
  const machine = machineForRemote({ host: meta.host, port: meta.port, user: meta.username })
  if (machine === undefined) {
    const error = `未找到 ${meta.username}@${meta.host} 的主机配置，请在「设置 → 远程工作区」添加该主机`
    logSyncFailure(meta, localDir, trigger, error)
    return { ok: false, error }
  }
  const client = sshClientFor(machine)
  let sftp
  try {
    sftp = await client.sftp()
  } catch (error) {
    const msg = `无法建立 SFTP 连接：${messageOf(error)}`
    logSyncFailure(meta, localDir, trigger, msg)
    return { ok: false, error: msg }
  }
  try {
    return await syncMirror(sftp, localDir, { trigger })
  } catch (error) {
    const msg = messageOf(error)
    logSyncFailure(meta, localDir, trigger, msg)
    return { ok: false, error: msg }
  } finally {
    sftp.end()
  }
}

function logSyncFailure(meta, localDir, trigger, error) {
  appendSyncLog({
    ts: new Date().toISOString(),
    trigger,
    host: meta?.host ?? null,
    user: meta?.username ?? null,
    port: meta?.port ?? null,
    remotePath: meta?.remotePath ?? null,
    localDir: basename(localDir),
    durationMs: 0,
    ok: false,
    pulled: 0,
    pushed: 0,
    skippedLarge: 0,
    files: 0,
    changes: [],
    error,
  })
}

/**
 * Remove one mirror's local directory after any in-flight sync completes.
 * Waiting for the sync protects the remote: the sync writes are atomic
 * (temp + rename), so the server never sees a half-file; and because a dir
 * marked `removingSet` is skipped by `syncLocalMirror`, the local deletion
 * can never be misread by a later diff as a "local delete → delete remote".
 */
async function removeMirrorLocal(localDir) {
  if (removingSet.has(localDir)) return { ok: false, error: '正在删除' }
  const meta = readMeta(localDir)
  if (meta === null) return { ok: false, error: '不是远程工作区镜像（缺少 .dsh-remote-meta.json）' }
  // Safety: an rm -rf must only ever touch a mirror dir under the mirrors root.
  const root = remoteWorkspacesRoot()
  if (!localDir.startsWith(root)) return { ok: false, error: '路径不在远程工作区镜像目录内' }
  removingSet.add(localDir)
  try {
    const inFlight = syncInFlight.get(localDir)
    if (inFlight !== undefined) {
      try {
        await inFlight
      } catch {
        /* the sync already logged its own failure */
      }
    }
    rmSync(localDir, { recursive: true, force: true })
    appendSyncLog({
      ts: new Date().toISOString(),
      trigger: 'delete',
      host: meta?.host ?? null,
      user: meta?.username ?? null,
      port: meta?.port ?? null,
      remotePath: meta?.remotePath ?? null,
      localDir: basename(localDir),
      durationMs: 0,
      ok: true,
      pulled: 0,
      pushed: 0,
      skippedLarge: 0,
      failed: 0,
      files: 0,
      changes: [],
    })
    return { ok: true, removed: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  } finally {
    removingSet.delete(localDir)
  }
}

/**
 * Mirrors whose workspace registration no longer exists (deleted in the
 * "工作区" panel). These are the leftover local folders; they are NOT
 * auto-removed — the watcher skips syncing them and the settings page offers a
 * manual cleanup option.
 */
function orphanLocalDirs() {
  if (workspaceRegistry === undefined) return new Set()
  let registered
  try {
    registered = new Set(workspaceRegistry.list().map((w) => w.path))
  } catch {
    return new Set()
  }
  const orphans = new Set()
  for (const { localDir } of enumerateMirrors()) {
    if (!registered.has(localDir)) orphans.add(localDir)
  }
  return orphans
}

/** Remove every orphan mirror (workspace already deleted). */
async function cleanOrphansLocal() {
  const orphans = orphanLocalDirs()
  let removed = 0
  const failed = []
  for (const localDir of orphans) {
    const r = await removeMirrorLocal(localDir)
    if (r.ok) removed++
    else failed.push({ localDir: basename(localDir), error: r.error })
  }
  return { ok: true, orphans: orphans.size, removed, failed }
}

/**
 * Resolve a raw browse path (home, `~`, `~/x`, relative, or absolute) to an
 * absolute remote path so the client can navigate "up" past home to `/` and
 * display a real path. Home and `~` forms resolve through SFTP realpath;
 * relative paths resolve against the remote home.
 */
async function resolveRemotePath(client, raw) {
  const trimmed = raw === undefined || raw === null ? '' : String(raw).trim()
  let sftp
  try {
    if (trimmed === '' || trimmed === '~' || trimmed === '~/') {
      sftp = await client.sftp()
      return await sftp.realpath('.')
    }
    if (trimmed.startsWith('~/')) {
      sftp = await client.sftp()
      const home = String(await sftp.realpath('.')).replace(/\/+$/, '')
      return `${home}/${trimmed.slice(2)}`
    }
    if (!trimmed.startsWith('/')) {
      sftp = await client.sftp()
      return await sftp.realpath(trimmed)
    }
    return trimmed
  } finally {
    if (sftp) sftp.end()
  }
}

/**
 * Watch the mirrors root for local edits and auto-sync (debounced). Local
 * writes that the agent/tools make to a mirror trigger a push; the sync itself
 * is diff-based, so a no-op pass converges and stops.
 */
function setupSyncWatchers() {
  const root = remoteWorkspacesRoot()
  try {
    mkdirSync(root, { recursive: true })
  } catch {}

  // Mirrors queued for sync since the last pass (deduped).
  const dirty = new Set()
  let timer

  function schedule(localDir) {
    if (localDir === undefined) {
      // Couldn't map the change to one mirror — mark every mirror dirty so a
      // change is never silently dropped.
      for (const { localDir: d } of enumerateMirrors()) dirty.add(d)
    } else {
      dirty.add(localDir)
    }
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(run, 600)
  }

  async function run() {
    const targets = [...dirty]
    dirty.clear()
    const orphans = orphanLocalDirs()
    const toSync = targets.filter((localDir) => !orphans.has(localDir))
    // Sync different mirrors in PARALLEL so one slow mirror (e.g. a huge
    // /home tree) never blocks the others. Each mirror is still guarded by its
    // own syncInFlight entry, so concurrent runs for the SAME mirror serialize.
    await Promise.all(
      toSync.map((localDir) => syncLocalMirror(localDir, 'auto').catch(() => {}))
    )
  }

  let watcher
  try {
    watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      const name = filename ? String(filename) : ''
      if (name.includes('.dsh-') || name.endsWith('machines.json')) return
      schedule(mirrorForChange(name, root))
    })
  } catch {
    watcher = undefined
  }

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    dirty.clear()
    if (watcher !== undefined) {
      try {
        watcher.close()
      } catch {}
    }
  }
}

/**
 * Host owner of the `remoteWorkspaces` Remote namespace. Every method returns
 * only lossless-JSON data and never echoes stored secrets back to the browser.
 */
function remoteWorkspacesService() {
  return {
    listMachines() {
      return { ok: true, machines: loadMachines().map(sanitizeMachine) }
    },

    saveMachine(machine) {
      try {
        const saved = upsertMachine(machine ?? {})
        return { ok: true, machine: saved }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    deleteMachine(id) {
      removeMachine(id)
      return { ok: true }
    },

    listMirrors() {
      try {
        const orphans = orphanLocalDirs()
        return {
          ok: true,
          mirrors: enumerateMirrors().map(({ localDir, meta }) => ({
            ...summaryOf(localDir, meta),
            orphan: orphans.has(localDir),
          })),
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    syncMirror(localDir) {
      return syncLocalMirror(localDir, 'manual')
    },

    removeMirror(localDir) {
      return removeMirrorLocal(localDir)
    },

    cleanOrphans() {
      return cleanOrphansLocal()
    },

    listSyncLog(query) {
      try {
        const q = query && typeof query === 'object' ? query : {}
        return { ok: true, entries: readSyncLog({ limit: q.limit, host: q.host }) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    clearSyncLog() {
      return { ok: clearSyncLog() }
    },

    listSshAliases() {
      const path = defaultSshConfigPath()
      if (!existsSync(path)) return { ok: true, path, aliases: [] }
      try {
        return { ok: true, path, aliases: hostsFromConfig(path).map((entry) => entry.alias) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    sshAliasDetail(alias) {
      const host = hostsFromConfig(defaultSshConfigPath()).find((entry) => entry.alias === alias)
      if (host === undefined) return { ok: false, error: `未在 ~/.ssh/config 找到别名 "${alias}"` }
      return {
        ok: true,
        machine: sanitizeMachine({ ...host, id: undefined, password: undefined, passphrase: undefined }),
      }
    },

    async testConnection(machine) {
      const client = sshClientFor(machine)
      const result = await client.run('echo ok')
      if (result.ok) return { ok: true, ms: result.ms }
      return { ok: false, ms: result.ms, error: (result.stderr ?? '').trim() || result.error || '连接失败' }
    },

    async listRemoteDir(machine, path) {
      // `-A` hides `.`/`..`, `-p` appends `/` to directories, `-1` one per line.
      // The path is resolved to an absolute remote path first (home/`~`/relative
      // → absolute), then listed; the resolved path is returned so the client
      // can walk up past home to `/`.
      const client = sshClientFor(machine)
      let absPath
      try {
        absPath = await resolveRemotePath(client, path)
      } catch (error) {
        return { ok: false, error: `无法解析目录：${messageOf(error)}` }
      }
      const command = absPath === '' ? 'ls -1Ap' : `ls -1Ap ${shellQuote(absPath)}`
      const res = await client.run(command)
      if (!res.ok) return { ok: false, error: (res.stderr ?? '').trim() || res.error || '列出目录失败' }
      const entries = res.stdout
        .split('\n')
        .filter((name) => name !== '')
        .map((name) => ({ name: name.replace(/\/$/, ''), dir: name.endsWith('/') }))
      return { ok: true, entries, path: absPath }
    },

    /**
     * Mirror a remote directory into a local directory (SFTP pull) so the
     * caller can adopt it as a workspace. Does NOT register the workspace —
     * the workspace-add flow adopts the returned local path itself.
     */
    async mirrorRemote(machine, path) {
      const client = sshClientFor(machine)
      let sftp
      try {
        sftp = await client.sftp()
      } catch (error) {
        return { ok: false, error: `无法建立 SFTP 连接：${messageOf(error)}` }
      }
      try {
        const rel = path === undefined || path === '' ? '.' : path
        const remotePath = await sftp.realpath(rel)
        const localDir = ensureMirror(machine, remotePath)
        const synced = await pullTree(sftp, remotePath, localDir, { maxDepth: 4, maxFiles: 1000 })
        await recordInitialBase(sftp, remotePath, localDir, { maxDepth: 4, maxFiles: 1000 })
        appendSyncLog({
          ts: new Date().toISOString(),
          trigger: 'mirror',
          host: machine.host ?? null,
          user: machine.user ?? null,
          port: machine.port ?? null,
          remotePath,
          localDir: basename(localDir),
          durationMs: 0,
          ok: true,
          pulled: synced.files ?? 0,
          pushed: 0,
          skippedLarge: synced.skippedLarge ?? 0,
          files: synced.files ?? 0,
          changes: [],
        })
        return { ok: true, localDir, remotePath, synced }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      } finally {
        sftp.end()
      }
    },
  }
}

/**
 * Model tool so the agent can query sync history directly. Reads the bounded
 * JSONL log (metadata only — never file contents or credentials).
 */
function syncLogTool() {
  return {
    name: 'ssh_sync_log',
    description: '查看 SSH 远程工作区的同步历史：最近 N 次同步的时间、触发方式（auto 自动/manual 手动/mirror 首次镜像）、主机、远端路径、拉取/推送/跳过数量、变更文件路径和错误信息。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 20，最大 200' },
        host: { type: 'string', description: '按主机地址过滤，可选（如 192.168.1.10）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const raw = args && typeof args.limit === 'number' ? args.limit : 20
      const limit = Math.min(Math.max(1, Math.floor(raw)), 200)
      const host = args && typeof args.host === 'string' && args.host !== '' ? args.host : undefined
      return { ok: true, entries: readSyncLog({ limit, host }) }
    },
  }
}

export function apply(ctx) {
  // Migrate any legacy plaintext secrets to the encrypted form once, at load.
  try { ensureSecretsEncrypted() } catch {}

  ctx.provide('sshClient', new SshClient())

  const service = remoteWorkspacesService()
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  ctx.provide(NAMESPACE, service)

  // Auto-sync watcher lives for this plugin's whole lifetime.
  ctx.effect(() => setupSyncWatchers())

  // Workspace registry reference for orphan detection (deferred until the
  // registry service is available).
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const reg = wsCtx.get('workspaceRegistry')
    if (reg !== undefined) workspaceRegistry = reg
    return () => { workspaceRegistry = undefined }
  })

  // Model tool for the agent to read sync history (deferred until `tools` is up).
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return
    return tools.register(syncLogTool())
  })

  // The typert registry activates after this dependency-free plugin, so the
  // strict Remote contribution is deferred until `typert` is available. The
  // callback returns the registration disposer so the endpoints are withdrawn
  // exactly when this plugin unloads.
  ctx.inject(['typert'], (typertCtx) => {
    const typert = typertCtx.get('typert')
    if (typert === undefined) return
    return typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: INVOCATIONS,
    })
  })
}

export default apply
