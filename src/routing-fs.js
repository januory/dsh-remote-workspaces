/**
 * Routing filesystem: the plugin's `ctx.fs` provider.
 *
 * Routes by the session cwd. Two remote triggers:
 *   - an `ssh://[user@]host[:port]/path` cwd (URI form), and
 *   - a LOCAL anchor directory registered in the remote-workspace registry
 *     (`anchors.json`), whose real content lives on the remote host.
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

export class RoutingFileSystem {
  constructor({ getPolicy, clientForRemote } = {}) {
    this.local = new LocalBackend({ getPolicy })
    this.clientForRemote = clientForRemote
    this.remoteBackends = new Map()
  }

  /**
   * The local half confines under `workspace-write`; reporting it keeps the
   * tool layer wiring the per-session sandbox policy (the correct workspace
   * root) into every mutation. The remote half ignores that policy — the SSH
   * account's permissions are the boundary.
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
    const remote = this.remoteCwd(cwd)
    if (remote !== null) {
      const backend = this.remoteBackend(remote.host, remote.user, remote.port)
      const sub = await backend.resolve(path, { cwd: remote.remoteCwd })
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
    const remote = this.remoteCwd(cwd)
    if (remote !== null) {
      const backend = this.remoteBackend(remote.host, remote.user, remote.port)
      return backend.lstat(path, { cwd: remote.remoteCwd })
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

  writeText(target, content, expected, signal, sandboxPolicy) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.writeText(sub, content, expected, signal, sandboxPolicy)
  }

  editText(target, edit, expected, signal, sandboxPolicy) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.editText(sub, edit, expected, signal, sandboxPolicy)
  }
}

export default RoutingFileSystem
