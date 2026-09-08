/**
 * Routing filesystem: the plugin's `ctx.fs` provider.
 *
 * Routes by the session cwd OR by the path itself. Remote triggers:
 *   - an `ssh://[user@]host[:port]/path` cwd (URI form),
 *   - a LOCAL anchor directory registered in the remote-workspace registry
 *     (`anchors.json`), whose real content lives on the remote host, and
 *   - any absolute path that IS a registered anchor or sits under one (the
 *     anchor path is the remote world's local alias — the Files tree lists,
 *     expands and opens entirely in this spelling, so routing must answer it
 *     with or without an anchor cwd).
 * Everything else goes to the local backend (with the workspace-write fence).
 *
 * The world identity is ENCODED into the target key (`ssh://host/path` for
 * remote, bare absolute path for local) and decoded on every later operation.
 *
 * Self-contained: it does not extend `@deepseek-ai/dsh-fs`'s `FileSystem`
 * (whose base class is a Service marker plus a `sandboxMode` getter only), so
 * the bundle resolves with no harness dependency. Consumers read the service
 * structurally (`ctx.fs.resolve/readText/…` and `ctx.fs.sandboxMode`), never
 * via `instanceof`.
 */

import { isAbsolute, posix } from 'node:path'
import { LocalBackend } from './local-backend.js'
import { SftpBackend } from './fs-sftp.js'
import { isRemoteCwd, parseSshUri } from './ssh-uri.js'
import { findByCwd } from './registry.js'
import { fsError } from './errors.js'

export class RoutingFileSystem {
  constructor({ getPolicy, clientForRemote } = {}) {
    this.getPolicy = getPolicy
    this.local = new LocalBackend({ getPolicy })
    this.clientForRemote = clientForRemote
    this.remoteBackends = new Map()
  }

  /**
   * Report a DEFINED `sandboxMode` so the tool layer treats this provider as
   * confining: it resolves the per-session policy, stamps every mutation with
   * it, and advertises escalation. Only definedness is read — the value itself
   * is a stand-in; the real per-call mode rides `sandboxPolicy`. The local
   * half fences writes in `LocalBackend.checkedTarget`; the remote half is
   * fenced here (`read-only` denies, `workspace-write` contains to the remote
   * workspace root, `danger-full-access` delegates). The SSH account's own
   * permissions remain the outer boundary.
   */
  get sandboxMode() {
    return 'workspace-write'
  }

  remoteBackend(host, user, port) {
    const key = `${user ?? ''}@${host}:${port ?? 22}`
    if (!this.remoteBackends.has(key)) {
      this.remoteBackends.set(key, new SftpBackend(this.clientForRemote(host, user, port)))
    }
    return this.remoteBackends.get(key)
  }

  /**
   * Resolve the remote execution-world cwd for a session cwd: either the
   * `ssh://` URI form or a registered anchor directory. Returns
   * `{ host, user, port, remoteCwd }` or null for a local cwd.
   */
  remoteCwd(cwd) {
    if (isRemoteCwd(cwd)) {
      const parsed = parseSshUri(cwd)
      if (parsed !== null) return { host: parsed.host, user: parsed.user, port: parsed.port, remoteCwd: parsed.path }
      return null
    }
    const hit = findByCwd(cwd)
    if (hit === undefined) return null
    const remoteCwd = hit.remoteSubpath === '' ? hit.remotePath : posix.join(hit.remotePath, hit.remoteSubpath)
    return { host: hit.host, user: hit.user, port: hit.port, remoteCwd }
  }

  encodeTarget(host, user, port, subKey) {
    return `ssh://${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}${subKey}`
  }

  /**
   * Anchor alias of an absolute LOCAL path: a registered anchor dir — or any
   * path under one — is the remote world's local spelling, so the registry
   * lookup that maps a session cwd maps the path itself. Returns the remote
   * origin (`{ host, user, port, remotePath }`) when `path` is an anchor dir or
   * a descendant of one, else null. This is what lets the right Sidebar Files
   * tree (which roots at the anchor path and joins children with `/`) reach the
   * remote: those strings ARE remote aliases.
   */
  aliasOfPath(path) {
    if (typeof path !== 'string' || path === '') return null
    const hit = findByCwd(path)
    if (hit === undefined) return null
    return {
      host: hit.host,
      user: hit.user,
      port: hit.port,
      remotePath: hit.remoteSubpath === '' ? hit.remotePath : posix.join(hit.remotePath, hit.remoteSubpath),
    }
  }

  /** Remote routing params for a call, from its cwd first and its path second. */
  routeRemote(path, cwd) {
    const byCwd = this.remoteCwd(cwd)
    if (byCwd !== null) return byCwd
    const byPath = this.aliasOfPath(path)
    return byPath === null ? null : { ...byPath, remoteCwd: byPath.remotePath }
  }

  /** The path argument translated to the remote world when it is itself an alias. */
  remotePathArg(path) {
    const alias = this.aliasOfPath(path)
    return alias === null ? path : alias.remotePath
  }

  /** Decode a target key into { backend, target } using the encoded world prefix. */
  splitTarget(target) {
    const key = String(target.targetKey)
    if (key.startsWith('ssh://')) {
      const parsed = parseSshUri(key)
      if (parsed !== null) {
        return {
          backend: this.remoteBackend(parsed.host, parsed.user, parsed.port),
          target: { targetKey: parsed.path, displayPath: target.displayPath ?? parsed.path },
        }
      }
    }
    return { backend: this.local, target }
  }

  async resolve(path, opts) {
    const cwd = opts && opts.cwd
    // Remote by cwd (session anchor), or by the path itself when no remote cwd
    // is given — the Files endpoint resolves the workspace root WITHOUT a cwd,
    // and the root is the anchor path, so the path must trigger routing alone.
    const remote = this.routeRemote(path, cwd)
    if (remote !== null) {
      const backend = this.remoteBackend(remote.host, remote.user, remote.port)
      // An anchor-absolute path (the Files vocabulary) is translated to its
      // remote spelling here; a relative path under an anchor cwd passes
      // through unchanged so the backend's cwd resolution applies as before.
      const arg = this.remotePathArg(path)
      const sub = await backend.resolve(arg, { cwd: remote.remoteCwd })
      return {
        targetKey: this.encodeTarget(remote.host, remote.user, remote.port, sub.targetKey),
        displayPath: sub.displayPath,
      }
    }
    return this.local.resolve(path, opts)
  }

  processPath(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.processPath(sub)
  }

  processPathFromHostPath(hostPath) {
    // Attachments and other host-owned files live in the LOCAL world; the
    // remote world has no host path. Mirror `fs-local`: absolute identity.
    return isAbsolute(hostPath) ? hostPath : undefined
  }

  fileUrl(target) {
    const key = String(target.targetKey)
    if (key.startsWith('ssh://')) return key
    return this.local.fileUrl(target)
  }

  contains(parent, child) {
    const p = this.splitTarget(parent)
    const c = this.splitTarget(child)
    if (p.backend !== c.backend) return false
    return p.backend.contains(p.target, c.target)
  }

  stat(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.stat(sub)
  }

  lstat(path, opts, signal) {
    const cwd = opts && opts.cwd
    const remote = this.routeRemote(path, cwd)
    if (remote !== null) {
      const backend = this.remoteBackend(remote.host, remote.user, remote.port)
      const arg = this.remotePathArg(path)
      return backend.lstat(arg, { cwd: remote.remoteCwd })
    }
    return this.local.lstat(path, opts)
  }

  readText(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.readText(sub)
  }

  streamText(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.streamText(sub)
  }

  readBytes(target, signal, maxBytes) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.readBytes(sub, signal, maxBytes)
  }

  async listDir(target) {
    const key = String(target.targetKey)
    const isRemote = key.startsWith('ssh://')
    const { backend, target: sub } = this.splitTarget(target)
    const entries = await backend.listDir(sub)
    if (!isRemote) return entries
    // Re-encode child target keys as `ssh://…` so later ops on them route back
    // to the SFTP backend (the backend returns bare POSIX keys).
    const parsed = parseSshUri(key)
    return entries.map((e) => ({
      ...e,
      target: {
        targetKey: this.encodeTarget(parsed.host, parsed.user, parsed.port, e.target.targetKey),
        displayPath: e.target.displayPath,
      },
    }))
  }

  /** POSIX containment: `path` is `root` or a descendant of it. */
  posixUnder(path, root) {
    const rel = posix.relative(root, path)
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  /**
   * Enforce the per-call sandbox policy on a REMOTE mutation (the local half
   * fences itself in `LocalBackend.checkedTarget`). `read-only` denies;
   * `workspace-write` contains the target under the session's remote workspace
   * root (the anchor's remote origin, plus the POSIX temp dirs); a
   * `danger-full-access` policy — or none — delegates unfenced. The target key
   * is already SFTP-canonicalized by `resolve`, so no re-resolve is needed.
   */
  remoteCheckedTarget(sub, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.getPolicy?.()?.resolve?.()
    if (policy === undefined) return sub
    const { mode } = policy
    if (mode === 'danger-full-access') return sub
    if (mode === 'read-only') {
      throw fsError('FS_SANDBOX_DENIED', `cannot write "${sub.displayPath}": file access denied under read-only mode`)
    }
    // workspace-write: the policy's workspace root is the LOCAL anchor path;
    // its remote origin is the containment boundary.
    const hit = findByCwd(policy.workspaceRoot)
    const remoteRoot = hit === undefined
      ? undefined
      : (hit.remoteSubpath === '' ? hit.remotePath : posix.join(hit.remotePath, hit.remoteSubpath))
    if (remoteRoot === undefined) {
      throw fsError('FS_SANDBOX_DENIED', `cannot write "${sub.displayPath}": file access denied under workspace-write mode`)
    }
    const writable = [remoteRoot, '/tmp', '/var/tmp']
    if (!writable.some((root) => this.posixUnder(sub.targetKey, root))) {
      throw fsError('FS_SANDBOX_DENIED', `cannot write "${sub.displayPath}": file access denied under workspace-write mode`)
    }
    return sub
  }

  writeText(target, content, expected, signal, sandboxPolicy) {
    const { backend, target: sub } = this.splitTarget(target)
    if (backend === this.local) return backend.writeText(sub, content, expected, signal, sandboxPolicy)
    return backend.writeText(this.remoteCheckedTarget(sub, sandboxPolicy), content, expected)
  }

  editText(target, edit, expected, signal, sandboxPolicy) {
    const { backend, target: sub } = this.splitTarget(target)
    if (backend === this.local) return backend.editText(sub, edit, expected, signal, sandboxPolicy)
    return backend.editText(this.remoteCheckedTarget(sub, sandboxPolicy), edit, expected)
  }
}

export default RoutingFileSystem
