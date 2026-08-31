/**
 * Local filesystem backend (the "local path" half of the routing provider).
 *
 * Self-contained over `node:fs` so the plugin does not depend on the
 * `deepseek-harness` local backend (which would register `ctx.fs` and conflict
 * with the routing provider). Implements the same 12 operations as the
 * `@deepseek-ai/dsh-fs` `FileSystem` seam, on plain `{ targetKey, displayPath }`
 * targets and plain version strings.
 */

import { readFile, readdir, rename, rm, stat, lstat, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, dirname, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fsError } from './errors.js'

function versionOf(st) {
  return `mtime:${Math.round(st.mtimeMs)}:size:${st.size}`
}

function typeOf(st) {
  if (st.isDirectory()) return 'directory'
  if (st.isFile()) return 'file'
  return 'other'
}

export class LocalBackend {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd
  }

  async resolve(path, opts = {}) {
    const base = opts.cwd ?? this.cwd
    const displayPath = isAbsolute(path) ? resolve(path) : resolve(base, path)
    let targetKey = displayPath
    try {
      targetKey = await realpath(displayPath)
    } catch {
      // A path about to be created has no canonical form yet; keep the resolved path.
    }
    return { targetKey, displayPath }
  }

  processPath(target) {
    return target.targetKey
  }

  fileUrl(target) {
    return pathToFileURL(target.targetKey).href
  }

  contains(parent, child) {
    const rel = relative(parent.targetKey, child.targetKey)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  async stat(target) {
    try {
      const st = await stat(target.targetKey)
      return { version: versionOf(st), type: typeOf(st), ...(st.isFile() ? { size: st.size } : {}) }
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      throw fsError('FS_IO_ERROR', `cannot stat "${target.displayPath}": ${error.message}`, error)
    }
  }

  async lstat(path, opts = {}) {
    const base = opts.cwd ?? this.cwd
    const full = isAbsolute(path) ? path : resolve(base, path)
    try {
      const st = await lstat(full)
      const type = st.isSymbolicLink() ? 'symlink' : typeOf(st)
      return { version: versionOf(st), type, ...(st.isFile() ? { size: st.size } : {}) }
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      throw fsError('FS_IO_ERROR', `cannot lstat "${full}": ${error.message}`, error)
    }
  }

  async readText(target) {
    try {
      const text = await readFile(target.targetKey, 'utf8')
      if (text.includes('\0')) throw fsError('FS_NOT_TEXT', `cannot read "${target.displayPath}": binary file`)
      return text
    } catch (error) {
      if (error && error.code) throw error
      throw fsError('FS_IO_ERROR', `cannot read "${target.displayPath}": ${error.message}`, error)
    }
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
    try {
      return await readFile(target.targetKey)
    } catch (error) {
      throw fsError('FS_IO_ERROR', `cannot read "${target.displayPath}": ${error.message}`, error)
    }
  }

  async listDir(target) {
    try {
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          target: {
            targetKey: join(target.targetKey, entry.name),
            displayPath: join(target.displayPath, entry.name),
          },
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      if (error && error.code === 'ENOENT') throw fsError('FS_NOT_FOUND', `cannot list "${target.displayPath}": not found`, error)
      throw fsError('FS_IO_ERROR', `cannot list "${target.displayPath}": ${error.message}`, error)
    }
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
    await this.atomicWrite(target.targetKey, content)
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
    const content = await this.readText(target)
    const oldString = edit.oldString
    if (!oldString) throw fsError('FS_EDIT_NOT_FOUND', `cannot edit "${target.displayPath}": old_string must be non-empty`)
    let matches = 0
    let offset = 0
    while (true) {
      const found = content.indexOf(oldString, offset)
      if (found < 0) break
      matches += 1
      offset = found + oldString.length
    }
    if (matches === 0) throw fsError('FS_EDIT_NOT_FOUND', `cannot edit "${target.displayPath}": old_string was not found`)
    if (!edit.replaceAll && matches !== 1) {
      throw fsError('FS_AMBIGUOUS_EDIT', `cannot edit "${target.displayPath}": old_string matched ${matches} times`)
    }
    const next = edit.replaceAll ? content.split(oldString).join(edit.newString) : content.replace(oldString, edit.newString)
    await this.atomicWrite(target.targetKey, next)
    const after = await this.stat(target)
    return { version: after.version, before: content, after: next }
  }

  async atomicWrite(targetKey, content) {
    const tmp = join(dirname(targetKey), `.dsh-${basename(targetKey)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, targetKey)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw fsError('FS_IO_ERROR', `cannot write "${targetKey}": ${error.message}`, error)
    }
  }
}

export default LocalBackend
