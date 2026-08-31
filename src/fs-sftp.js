/**
 * SFTP remote backend (the "ssh:// path" half of the routing provider).
 *
 * A plain backend over `SshClient` — does NOT extend the `FileSystem` service,
 * so it can be held by the routing provider without registering `ctx.fs`.
 * Implements the same 12 operations on plain targets and version strings.
 */

import { posix } from 'node:path'
import { fsError } from './errors.js'

export class SftpBackend {
  constructor(client) {
    this.client = client
  }

  async resolve(path, opts = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw fsError('FS_NOT_FOUND', 'file_path must be a non-empty string')
    }
    const base = opts.cwd ?? '/'
    const displayPath = posix.resolve(base, path)
    const canonical = await this.client.canonicalPath(displayPath)
    const targetKey = canonical.ok ? canonical.stdout.trim() : displayPath
    return { targetKey, displayPath }
  }

  processPath(target) {
    return target.targetKey
  }

  fileUrl(target) {
    return `ssh://${this.client.host}${target.targetKey}`
  }

  contains(parent, child) {
    const rel = posix.relative(parent.targetKey, child.targetKey)
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  async stat(target) {
    const res = await this.client.stat(target.targetKey)
    if (!res.ok) {
      if (/no such file|not exist/i.test(`${res.stderr} ${res.error ?? ''}`)) return undefined
      throw fsError('FS_IO_ERROR', `cannot stat "${target.displayPath}": ${res.error ?? res.stderr}`)
    }
    const type = res.type === 'directory' ? 'directory' : res.type === 'file' ? 'file' : 'other'
    return {
      version: `mtime:${res.mtimeMs}:size:${res.size}`,
      type,
      ...(type === 'file' ? { size: res.size } : {}),
    }
  }

  async lstat(path, opts = {}) {
    // This transport has no no-follow stat; map to resolve + stat.
    const target = await this.resolve(path, opts)
    return this.stat(target)
  }

  async readText(target) {
    const res = await this.client.readFile(target.targetKey)
    if (!res.ok) throw fsError('FS_IO_ERROR', `cannot read "${target.displayPath}": ${res.error ?? res.stderr}`)
    if (res.stdout.includes('\0')) throw fsError('FS_NOT_TEXT', `cannot read "${target.displayPath}": binary file`)
    return res.stdout
  }

  async streamText(target) {
    const text = await this.readText(target)
    return {
      async *[Symbol.asyncIterator]() {
        yield text
      },
    }
  }

  async readBytes(target, signal, maxBytes) {
    const info = await this.stat(target)
    if (info === undefined) throw fsError('FS_NOT_FOUND', `cannot read "${target.displayPath}": not found`)
    if (info.type !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `cannot read "${target.displayPath}": not a regular file`)
    if (info.size !== undefined && info.size > maxBytes) {
      throw fsError('FS_TOO_LARGE', `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`)
    }
    // Text-decode only for now: raw binary transfer is a documented P1.1 limit.
    const text = await this.readText(target)
    return new TextEncoder().encode(text)
  }

  async listDir(target) {
    const res = await this.client.listDir(target.targetKey)
    if (!res.ok) throw fsError('FS_IO_ERROR', `cannot list "${target.displayPath}": ${res.error ?? res.stderr}`)
    return res.entries.map((name) => ({
      name,
      type: 'other',
      target: {
        targetKey: posix.join(target.targetKey, name),
        displayPath: posix.join(target.displayPath, name),
      },
    }))
  }

  async writeText(target, content, expected) {
    const existing = await this.stat(target)
    if (existing !== undefined && existing.type !== 'file') {
      throw fsError('FS_NOT_REGULAR_FILE', `cannot write "${target.displayPath}": not a regular file`)
    }
    if (expected && expected.kind === 'createIfAbsent' && existing !== undefined) {
      throw fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${target.displayPath}" without reading it first`)
    }
    if (expected && expected.kind === 'replaceIfVersion') {
      if (existing === undefined || existing.version !== expected.version) {
        throw fsError('FS_STALE_VERSION', `cannot write "${target.displayPath}": file changed since it was read`)
      }
    }
    const res = await this.client.writeAtomic(target.targetKey, content)
    if (!res.ok) throw fsError('FS_IO_ERROR', `cannot write "${target.displayPath}": ${res.error ?? res.stderr}`)
    const after = await this.stat(target)
    return { operation: existing === undefined ? 'create' : 'update', version: after.version }
  }

  async editText(target, edit, expected) {
    const existing = await this.stat(target)
    if (existing === undefined) throw fsError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`)
    if (existing.type !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `cannot edit "${target.displayPath}": not a regular file`)
    if (expected && existing.version !== expected.version) {
      throw fsError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`)
    }
    const res = await this.client.editText(target.targetKey, edit.oldString, edit.newString, edit.replaceAll === true)
    if (!res.ok) {
      const reason = res.error ?? res.stderr ?? ''
      if (/old_string not found/.test(reason)) {
        throw fsError('FS_EDIT_NOT_FOUND', `cannot edit "${target.displayPath}": old_string was not found`)
      }
      if (/matched \d+ times/.test(reason)) {
        throw fsError('FS_AMBIGUOUS_EDIT', `cannot edit "${target.displayPath}": ${reason}`)
      }
      throw fsError('FS_IO_ERROR', `cannot edit "${target.displayPath}": ${reason}`)
    }
    const after = await this.stat(target)
    return { version: after.version }
  }
}

export default SftpBackend
