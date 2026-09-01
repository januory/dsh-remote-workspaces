/**
 * SFTP remote backend (the remote half of the routing provider).
 *
 * A plain backend over the ssh2 SFTP channel — does NOT extend the
 * `FileSystem` service, so the routing provider can hold it without registering
 * `ctx.fs`. Implements the same 12 operations on plain targets and version
 * strings, using SFTP primitives (readdir/stat/readFile/writeFile/rename) so
 * type detection and ENOENT handling are locale-independent (a shell `stat`
 * localized to the remote's locale broke type/absence detection).
 */

import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { fsError } from './errors.js'

function isMissing(error) {
  const code = error && error.code
  const message = error && error.message ? String(error.message) : ''
  return code === 2 || code === 'ENOENT' || /no such file|not exist/i.test(message)
}

/** File type from ssh2 Stats/attrs, with a mode-bits fallback. */
function typeOf(st) {
  if (st && typeof st.isDirectory === 'function' && st.isDirectory()) return 'directory'
  if (st && typeof st.isFile === 'function' && st.isFile()) return 'file'
  if (st && typeof st.mode === 'number') {
    if ((st.mode & 0o170000) === 0o040000) return 'directory'
    if ((st.mode & 0o170000) === 0o100000) return 'file'
  }
  return 'other'
}

export class SftpBackend {
  constructor(client) {
    this.client = client
    this._sftp = undefined
  }

  /** Lazily open ONE persistent SFTP channel per backend (host). */
  async sftp() {
    if (this._sftp === undefined) this._sftp = await this.client.sftp()
    return this._sftp
  }

  async resolve(path, opts = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw fsError('FS_NOT_FOUND', 'file_path must be a non-empty string')
    }
    const base = opts.cwd ?? '/'
    const displayPath = posix.resolve(base, path)
    const sftp = await this.sftp()
    let targetKey = displayPath
    try { targetKey = await sftp.realpath(displayPath) } catch { /* about-to-be-created path keeps its spelling */ }
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
    const sftp = await this.sftp()
    let st
    try {
      st = await sftp.stat(target.targetKey)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw fsError('FS_IO_ERROR', `cannot stat "${target.displayPath}": ${error.message}`, error)
    }
    const type = typeOf(st)
    const mtimeMs = Math.round((typeof st.mtime === 'number' ? st.mtime : 0) * 1000)
    return {
      version: `mtime:${mtimeMs}:size:${st.size ?? 0}`,
      type,
      ...(type === 'file' ? { size: st.size } : {}),
    }
  }

  async lstat(path, opts = {}) {
    // This facade has no no-follow stat; map to resolve + stat.
    const target = await this.resolve(path, opts)
    return this.stat(target)
  }

  async readText(target) {
    const sftp = await this.sftp()
    let buf
    try {
      buf = await sftp.readFile(target.targetKey)
    } catch (error) {
      throw fsError('FS_IO_ERROR', `cannot read "${target.displayPath}": ${error.message}`, error)
    }
    const text = Buffer.from(buf).toString('utf8')
    if (text.includes('\0')) throw fsError('FS_NOT_TEXT', `cannot read "${target.displayPath}": binary file`)
    return text
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
    const sftp = await this.sftp()
    const buf = await sftp.readFile(target.targetKey)
    return new Uint8Array(Buffer.from(buf))
  }

  async listDir(target) {
    const sftp = await this.sftp()
    let entries
    try {
      entries = await sftp.readdir(target.targetKey)
    } catch (error) {
      if (isMissing(error)) throw fsError('FS_NOT_FOUND', `cannot list "${target.displayPath}": not found`)
      throw fsError('FS_IO_ERROR', `cannot list "${target.displayPath}": ${error.message}`, error)
    }
    return (Array.isArray(entries) ? entries : [])
      .filter((e) => e && e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        type: typeOf(e.attrs ?? {}),
        target: {
          targetKey: posix.join(target.targetKey, e.filename),
          displayPath: posix.join(target.displayPath, e.filename),
        },
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
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
    let before = null
    if (existing !== undefined && existing.type === 'file') {
      try { before = await this.readText(target) } catch { before = null }
    }
    await this.atomicWrite(target, content)
    await this.verifyWrite(target, content)
    const after = await this.stat(target)
    return { operation: existing === undefined ? 'create' : 'update', version: after.version, before, after: content }
  }

  async editText(target, edit, expected) {
    const existing = await this.stat(target)
    if (existing === undefined) throw fsError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`)
    if (existing.type !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `cannot edit "${target.displayPath}": not a regular file`)
    if (expected && existing.version !== expected.version) {
      throw fsError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`)
    }
    const before = await this.readText(target)
    const oldString = edit.oldString
    if (!oldString) throw fsError('FS_EDIT_NOT_FOUND', `cannot edit "${target.displayPath}": old_string must be non-empty`)
    let matches = 0
    let offset = 0
    while (true) {
      const found = before.indexOf(oldString, offset)
      if (found < 0) break
      matches += 1
      offset = found + oldString.length
    }
    if (matches === 0) throw fsError('FS_EDIT_NOT_FOUND', `cannot edit "${target.displayPath}": old_string was not found`)
    if (!edit.replaceAll && matches !== 1) {
      throw fsError('FS_AMBIGUOUS_EDIT', `cannot edit "${target.displayPath}": old_string matched ${matches} times`)
    }
    const after = edit.replaceAll ? before.split(oldString).join(edit.newString) : before.replace(oldString, edit.newString)
    await this.atomicWrite(target, after)
    await this.verifyWrite(target, after)
    const st = await this.stat(target)
    return { version: st.version, before, after }
  }

  /** Atomic write: temp file in the same dir, then rename over the target. */
  async atomicWrite(target, content) {
    const sftp = await this.sftp()
    const tmp = posix.join(posix.dirname(target.targetKey), `.dsh-${posix.basename(target.targetKey)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await sftp.writeFile(tmp, Buffer.from(content, 'utf8'))
      try { await sftp.unlink(target.targetKey) } catch { /* target absent — first upload */ }
      await sftp.rename(tmp, target.targetKey)
    } catch (error) {
      await sftp.unlink(tmp).catch(() => {})
      throw fsError('FS_IO_ERROR', `cannot write "${target.targetKey}": ${error.message}`, error)
    }
  }

  /**
   * Post-write verification: compare the on-disk sha256 to the intended bytes
   * (mirrors hermes-agent's write_file check). A mismatch is a hard error, so
   * silent server-side truncation/corruption never reaches the caller. Skipped
   * when the remote has no `sha256sum`/`shasum`.
   */
  async verifyWrite(target, content) {
    const expected = createHash('sha256').update(content, 'utf8').digest('hex')
    const actual = await this.client.sha256(target.targetKey)
    if (actual !== undefined && actual !== expected) {
      throw fsError('FS_IO_ERROR', `post-write verification failed for "${target.displayPath}": on-disk content does not match what was written`)
    }
  }
}

export default SftpBackend
