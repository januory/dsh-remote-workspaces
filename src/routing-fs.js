/**
 * Routing filesystem: the plugin's `ctx.fs` provider.
 *
 * Routes by the session cwd — `ssh://…` cwds go to the SFTP backend, everything
 * else goes to the local backend. Only `resolve` sees the cwd, so the world
 * identity is ENCODED into the target key (`ssh://host/path` for remote, bare
 * absolute path for local) and decoded on every later operation.
 *
 * Self-contained: it does not extend `@deepseek-ai/dsh-fs`'s `FileSystem`
 * (whose base class is a Service marker plus a `sandboxMode` getter only), so
 * the bundle resolves with no harness dependency. Consumers read the service
 * structurally (`ctx.fs.resolve/readText/…` and `ctx.fs.sandboxMode`), never
 * via `instanceof`.
 */

import { LocalBackend } from './local-backend.js'
import { SftpBackend } from './fs-sftp.js'
import { clientForHost } from './transport.js'
import { isRemoteCwd, parseSshUri } from './ssh-uri.js'

export class RoutingFileSystem {
  constructor() {
    this.local = new LocalBackend()
    this.remoteBackends = new Map()
  }

  /** This provider confines nothing; `undefined` keeps the tool layer from showing escalation fields. */
  get sandboxMode() {
    return undefined
  }

  remoteBackend(host, user, port) {
    const key = `${user ?? ''}@${host}:${port ?? 22}`
    if (!this.remoteBackends.has(key)) {
      this.remoteBackends.set(key, new SftpBackend(clientForHost(host)))
    }
    return this.remoteBackends.get(key)
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
    if (isRemoteCwd(cwd)) {
      const parsed = parseSshUri(cwd)
      const backend = this.remoteBackend(parsed.host, parsed.user, parsed.port)
      const sub = await backend.resolve(path, { cwd: parsed.path })
      return {
        targetKey: `ssh://${parsed.host}${sub.targetKey}`,
        displayPath: sub.displayPath,
      }
    }
    return this.local.resolve(path, opts)
  }

  processPath(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.processPath(sub)
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
    if (isRemoteCwd(cwd)) {
      const parsed = parseSshUri(cwd)
      const backend = this.remoteBackend(parsed.host, parsed.user, parsed.port)
      return backend.lstat(path, { cwd: parsed.path })
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

  listDir(target) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.listDir(sub)
  }

  writeText(target, content, expected, signal) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.writeText(sub, content, expected, signal)
  }

  editText(target, edit, expected, signal) {
    const { backend, target: sub } = this.splitTarget(target)
    return backend.editText(sub, edit, expected, signal)
  }
}

export default RoutingFileSystem
