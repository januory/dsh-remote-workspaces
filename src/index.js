import { existsSync } from 'node:fs'
import { SshClient, defaultSshConfigPath, hostsFromConfig, shellQuote, clientForHost } from './transport.js'
import { loadMachines, sanitizeMachine, upsertMachine, removeMachine, machineById, machineForRemote, ensureSecretsEncrypted } from './machine-store.js'
import { ensureAnchor } from './anchor.js'
import { RoutingFileSystem } from './routing-fs.js'
import { SshShellExecutor } from './shell-exec.js'
import { registerAnchor, unregisterAnchor, findByCwd, updateAnchorOs } from './registry.js'
import { applySearchTools } from './search.js'
import { createShellSessions } from './shell-sessions.js'

export { parseSshConfig, expandTilde } from './ssh-config.js'
export { SshClient, hostsFromConfig, shellQuote, defaultSshConfigPath, clientForHost } from './transport.js'
export { SftpBackend } from './fs-sftp.js'
export { LocalBackend } from './local-backend.js'
export { parseSshUri, isRemoteCwd } from './ssh-uri.js'
export { fsError } from './errors.js'
export { RoutingFileSystem } from './routing-fs.js'
export { SshShellExecutor } from './shell-exec.js'
export { loadMachines, sanitizeMachine, upsertMachine, removeMachine, machinesPath } from './machine-store.js'
export { registerAnchor, unregisterAnchor, findByCwd, loadAnchors } from './registry.js'

/**
 * Host half of the SSH remote workspace bundle (`dsh-remote-workspaces`).
 *
 * Publishes the routing `ctx.fs` and `ctx.shell` (local half sandboxed through
 * the harness's policy/sandbox/subprocess services; remote half SFTP/ssh2 exec),
 * plus the `remoteWorkspaces` Remote namespace for the "远程工作区" settings
 * page: a persistent multi-machine SSH registry, `~/.ssh/config` import,
 * connection test, remote directory browsing, and opening a remote directory
 * as a workspace (an empty LOCAL anchor directory registered in the routing
 * registry — all file/command I/O then lands on the remote, never the anchor).
 */

export const name = 'dsh-remote-workspaces'

// ---------------------------------------------------------------------------
// Remote contract. The client half (src/client.js) keeps an identical copy.
// ---------------------------------------------------------------------------
const PACKAGE = 'dsh-remote-workspaces'
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
  invocation('openRemoteWorkspace', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('openShellLocal', [jsonParameter('opts')]),
  invocation('shellWrite', [jsonParameter('id'), jsonParameter('data')]),
  invocation('shellRead', [jsonParameter('id')]),
  invocation('shellClose', [jsonParameter('id')]),
  invocation('shellList'),
]

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

/** Directory flag from an SFTP attrs record (protocol-level, locale-free). */
function attrsIsDir(st) {
  if (st && typeof st.isDirectory === 'function') return st.isDirectory()
  if (st && typeof st.mode === 'number') return (st.mode & 0o170000) === 0o040000
  return false
}

/**
 * Build an `SshClient` for a remote host, preferring a saved machine's
 * credentials (password/identityFile/passphrase) and falling back to
 * `~/.ssh/config`. The routing fs + shell providers use this so remote I/O
 * authenticates exactly like the settings "test connection" path.
 */
function clientForRemote(host, user, port) {
  const machine = machineForRemote({ host, port, user })
  return machine ? sshClientFor(machine) : clientForHost(host)
}

const OS_BACKFILL_QUEUED = new Set()

/**
 * Lazily backfill the `os` profile on an anchor row that predates B4 (kicked
 * once per anchor per process, fire-and-forget). Prompt hints re-read the
 * registry on every render, so the next prompt after the probe sees the OS.
 */
function kickOsBackfill(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return
  let hit
  try { hit = findByCwd(cwd) } catch { return }
  if (hit === undefined || (hit.os && hit.os.family !== undefined)) return
  if (OS_BACKFILL_QUEUED.has(hit.anchorPath)) return
  OS_BACKFILL_QUEUED.add(hit.anchorPath)
  void (async () => {
    try {
      const client = clientForRemote(hit.host, hit.user, hit.port)
      const profile = await client.profile()
      if (profile !== undefined && (profile.family === 'posix' || profile.family === 'windows')) {
        updateAnchorOs(hit.anchorPath, { family: profile.family, os: profile.os, shell: profile.shell })
        return
      }
      // Unknown / undetectable: leave the dedupe queue so the NEXT prompt
      // render re-kicks the probe (failed probes are not cached, so a later
      // attempt really does re-probe instead of reusing a stale unknown).
      OS_BACKFILL_QUEUED.delete(hit.anchorPath)
      console.warn(`[dsh-remote-workspaces] os backfill probe failed for ${hit.host} (family unknown); will retry on next render`)
    } catch (error) {
      OS_BACKFILL_QUEUED.delete(hit.anchorPath)
      console.warn(`[dsh-remote-workspaces] os backfill probe errored for ${hit.host}: ${messageOf(error)}`)
    }
  })()
}

/**
 * Resolve a raw browse path (home, `~`, `~/x`, relative, or absolute) to an
 * absolute remote path so the client can navigate "up" past home to `/` and
 * display a real path. Accepts an optional open SFTP facade to reuse across
 * resolve + listing; otherwise opens its own channel. Resolution goes over
 * SFTP (`realpath`), so it works identically on POSIX and Windows targets and
 * never parses localized shell output.
 */
async function resolveRemotePath(client, raw, sharedSftp) {
  const trimmed = raw === undefined || raw === null ? '' : String(raw).trim()
  let owned
  const sftp = async () => {
    if (sharedSftp !== undefined) return sharedSftp
    owned = owned ?? await client.sftp()
    return owned
  }
  try {
    if (trimmed === '' || trimmed === '~' || trimmed === '~/') {
      return await (await sftp()).realpath('.')
    }
    if (trimmed.startsWith('~/')) {
      const s = await sftp()
      const home = String(await s.realpath('.')).replace(/\/+$/, '')
      return `${home}/${trimmed.slice(2)}`
    }
    if (!trimmed.startsWith('/')) {
      return await (await sftp()).realpath(trimmed)
    }
    return trimmed
  } finally {
    if (owned !== undefined) owned.end()
  }
}

/**
 * Host owner of the `remoteWorkspaces` Remote namespace. Every method returns
 * only lossless-JSON data and never echoes stored secrets back to the browser.
 */
function remoteWorkspacesService(remote) {
  const shells = createShellSessions(() => remote.getSubprocess())
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
      // Pure-SFTP listing (readdir + attrs) — the SAME channel the fs backend
      // uses, so Windows targets work: no `ls`, no localized output parsing,
      // no dependency on the remote's default shell.
      const client = sshClientFor(machine)
      let sftp
      try {
        sftp = await client.sftp()
      } catch (error) {
        return { ok: false, error: `无法建立 SFTP 连接：${messageOf(error)}` }
      }
      try {
        const absPath = await resolveRemotePath(client, path, sftp)
        let list
        try {
          list = await sftp.readdir(absPath)
        } catch (error) {
          const missing = error && (error.code === 2 || /no such file|not exist|找不到/i.test(String(error.message)))
          return { ok: false, error: missing ? `目录不存在：${absPath}` : `无法读取目录：${messageOf(error)}` }
        }
        const entries = (Array.isArray(list) ? list : [])
          .filter((e) => e && e.filename !== '.' && e.filename !== '..')
          .map((e) => ({ name: e.filename, dir: attrsIsDir(e.attrs) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, entries, path: absPath }
      } catch (error) {
        return { ok: false, error: `无法解析目录：${messageOf(error)}` }
      } finally {
        sftp.end()
      }
    },

    /**
     * Open a remote directory as a workspace: create an EMPTY local anchor
     * directory (the harness's workspace identity — `fs.realpath` must resolve
     * it) and register it in the routing registry. The caller then adopts the
     * anchor through `workspaceRegistry.create`; all file/command I/O routes
     * to the remote. No mirroring, no sync.
     */
    async openRemoteWorkspace(machine, path) {
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
        const anchorPath = ensureAnchor(machine, remotePath)
        // Probe the remote profile once so prompt/dialect hints can declare
        // the actual shell (PowerShell on Windows remotes). Failure to probe
        // only leaves the hint off — never fails the open.
        let os
        try {
          const profile = await client.profile()
          if (profile !== undefined && (profile.family === 'posix' || profile.family === 'windows')) {
            os = { family: profile.family, os: profile.os, shell: profile.shell }
          }
        } catch { /* os stays undefined */ }
        registerAnchor({
          anchorPath,
          machineId: machine?.id,
          host: machine?.host ?? null,
          port: machine?.port ?? null,
          user: machine?.user ?? null,
          remotePath,
          ...(os !== undefined ? { os } : {}),
        })
        return { ok: true, localDir: anchorPath, remotePath }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      } finally {
        sftp.end()
      }
    },

    // Shell tool (S0: interactive local shell over ctx.subprocess.spawnTerminal).
    async openShellLocal(opts) {
      try {
        const session = await shells.openLocal(opts ?? {})
        return { ok: true, ...session }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    async shellWrite(id, data) {
      try {
        await shells.write(id, data)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    shellRead(id) {
      try {
        return { ok: true, ...shells.read(id) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    async shellClose(id) {
      try {
        return { ok: true, ...(await shells.close(id)) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    shellList() {
      return { ok: true, sessions: shells.list() }
    },
  }
}

export function apply(ctx) {
  // Migrate any legacy plaintext secrets to the encrypted form once, at load.
  try { ensureSecretsEncrypted() } catch { }

  ctx.provide('sshClient', new SshClient())

  // Routing providers. Their harness services are captured via inject
  // (deferred until available) because the plugin's own `ctx.get` may not
  // resolve root-scoped services directly.
  const deps = { policy: undefined, sandbox: undefined, subprocess: undefined }
  const remote = {
    getPolicy: () => deps.policy,
    getSandbox: () => deps.sandbox,
    getSubprocess: () => deps.subprocess,
    clientForRemote,
  }
  ctx.inject(['sandbox', 'subprocess', 'sandboxPolicy'], (sctx) => {
    deps.policy = sctx.get('sandboxPolicy')
    deps.sandbox = sctx.get('sandbox')
    deps.subprocess = sctx.get('subprocess')
    return () => { deps.policy = deps.sandbox = deps.subprocess = undefined }
  })
  ctx.provide('fs', new RoutingFileSystem(remote))
  ctx.provide('shell', new SshShellExecutor(remote))

  const service = remoteWorkspacesService(remote)
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  ctx.provide(NAMESPACE, service)

  // Remote-aware grep/glob (replace the local ripgrep tool-fs-search), deferred
  // until `tools` is available.
  ctx.inject(['tools'], (toolsCtx) => {
    applySearchTools(toolsCtx, remote)
  })

  // Shadow the harness's global `cwd` prompt variable per-agent so a remote
  // workspace's persona line ("Your working directory is {{cwd}}") shows the
  // REMOTE path instead of the empty local anchor. Local agents keep their cwd
  // unchanged. Routing still uses `session.header.cwd` — this only rewrites the
  // prompt text.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.variable('cwd', (context) => {
        const cwd = context.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return cwd
        const hit = findByCwd(cwd)
        if (hit === undefined) return cwd
        // Side effect: backfill the os profile on rows registered before B4.
        kickOsBackfill(cwd)
        return hit.remoteSubpath === '' ? hit.remotePath : `${hit.remotePath.replace(/\/+$/, '')}/${hit.remoteSubpath}`
      })
    })
  })

  // Clarify remote workspaces to the model — only when the session's cwd is a
  // registered remote anchor (empty text hides the section for local sessions).
  ctx.inject(['systemPrompt'], (sctx) => {
    const systemPrompt = sctx.get('systemPrompt')
    if (systemPrompt === undefined) return
    systemPrompt.section({
      name: 'dsh-remote-workspaces:notice',
      order: 10,
      text: (context) => {
        const cwd = context.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return ''
        const hit = findByCwd(cwd)
        if (hit === undefined) return ''
        // Side effect: backfill the os profile on rows registered before B4.
        kickOsBackfill(cwd)
        const host = hit.user ? `${hit.user}@${hit.host}` : hit.host
        const base = `Remote workspace over SSH (${host}): file/search tools and shell commands run on the remote host; use relative paths (they route to the remote automatically).`
        if (hit.os?.family === 'windows') {
          return base + ' The remote shell is PowerShell — write PowerShell syntax (built-in aliases like ls/cat/cd/pwd work; bash-only syntax such as && or 2>/dev/null does not).'
        }
        return base
      },
    })
  })

  // The typert registry activates after this dependency-free plugin, so the
  // strict Remote contribution is deferred until `typert` is available.
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
