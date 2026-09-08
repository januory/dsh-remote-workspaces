/**
 * Routing filesystem unit tests.
 *
 * Two worlds:
 *   1. Local routing — no anchors registered, everything resolves to the local
 *      backend (with the workspace-write fence).
 *   2. Remote routing by anchor-path aliasing — once a local anchor directory is
 *      registered, both an anchor session cwd AND an absolute path under the
 *      anchor resolve to the remote SFTP world. The remote is faked by a temp
 *      directory standing in for the SFTP target: no SSH host, no credentials.
 *
 * All fixtures use neutral placeholders (example host/user/paths).
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RoutingFileSystem } from '../src/routing-fs.js'
import { registerAnchor } from '../src/registry.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

/** Neutral remote fixture: host/user/path are placeholders. */
const REMOTE = Object.freeze({
  host: 'remote-a',
  user: 'alice',
  port: 2222,
  root: '/srv/work',
})
const sshTarget = (subpath) => `ssh://${REMOTE.user}@${REMOTE.host}:${REMOTE.port}${subpath}`

const home = mkdtempSync(join(tmpdir(), 'dsh-routing-'))
process.env.DSH_HOME = home

// ── 1. local routing (no anchors registered) ──────────────────────────────────
const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'a.txt'), 'hello routing')

const localPolicy = () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws }) })
const rfsLocal = new RoutingFileSystem({ getPolicy: localPolicy, clientForRemote: () => { throw new Error('no remote') } })

try {
  const t1 = await rfsLocal.resolve('a.txt', { cwd: ws })
  check('resolve relative target', t1.displayPath === join(ws, 'a.txt'), t1.displayPath)
  const info = await rfsLocal.stat(t1)
  check('stat target', info !== undefined && info.type === 'file', JSON.stringify(info))
  const text = await rfsLocal.readText(t1)
  check('readText', text === 'hello routing', JSON.stringify(text))
  const list = await rfsLocal.listDir(await rfsLocal.resolve('.', { cwd: ws }))
  check('listDir', list.some((e) => e.name === 'a.txt'))
  const w = await rfsLocal.writeText(t1, 'updated', undefined, undefined, { mode: 'workspace-write', workspaceRoot: ws })
  check('writeText', w.operation === 'update' && readFileSync(join(ws, 'a.txt'), 'utf8') === 'updated')
} catch (e) {
  check('local routing flow no throw', false, e && (e.stack || e.message))
}

// ── 2. anchor-path aliasing reaches the (faked) remote ─────────────────────────
const anchor = join(home, 'remote-workspaces', `${REMOTE.host}-${REMOTE.user}-${REMOTE.port}`, 'srv--work')
const anchorFlat = anchor.replace(/\\/g, '/')
registerAnchor({
  anchorPath: anchor,
  machineId: 'machine-1',
  host: REMOTE.host,
  port: REMOTE.port,
  user: REMOTE.user,
  remotePath: REMOTE.root,
})

// A local temp dir stands in for the remote filesystem at REMOTE.root.
const remoteFs = join(home, 'mirror', 'work')
mkdirSync(join(remoteFs, 'sub'), { recursive: true })
writeFileSync(join(remoteFs, 'b.txt'), 'remote file content')
writeFileSync(join(remoteFs, 'sub', 'c.txt'), 'nested content')

function missingError() {
  const error = new Error('no such file')
  error.code = 2
  return error
}
function mirrorOf(remotePath) {
  const prefix = REMOTE.root
  if (remotePath === prefix) return remoteFs
  if (typeof remotePath === 'string' && remotePath.startsWith(`${prefix}/`)) {
    return join(remoteFs, ...remotePath.slice(prefix.length + 1).split('/'))
  }
  throw missingError()
}
function attrsOf(st) {
  return {
    mode: st.mode,
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
    isDirectory: () => st.isDirectory(),
    isFile: () => st.isFile(),
  }
}
const fakeSftp = {
  async realpath(p) {
    if (!existsSync(mirrorOf(p))) throw missingError()
    return p
  },
  async stat(p) {
    let st
    try { st = statSync(mirrorOf(p)) } catch { throw missingError() }
    return attrsOf(st)
  },
  async readFile(p) {
    return Buffer.from(readFileSync(mirrorOf(p), 'utf8'))
  },
  async readdir(p) {
    if (!existsSync(mirrorOf(p))) throw missingError()
    return readdirSync(mirrorOf(p), { withFileTypes: true })
      .filter((d) => d.name !== '.' && d.name !== '..')
      .map((d) => {
        const st = statSync(join(mirrorOf(p), d.name))
        return { filename: d.name, attrs: attrsOf(st) }
      })
  },
}
const remotePolicy = () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: anchor }) })
const rfsRemote = new RoutingFileSystem({
  getPolicy: remotePolicy,
  clientForRemote: () => ({ host: REMOTE.host, sftp: async () => fakeSftp }),
})

try {
  // aliasOfPath: the anchor dir is the remote root's local spelling.
  const alias = rfsRemote.aliasOfPath(anchor)
  check('aliasOfPath maps the anchor to its remote origin', alias !== null && alias.remotePath === REMOTE.root, JSON.stringify(alias))

  // The Files endpoint resolves the workspace ROOT without a cwd.
  const rootT = await rfsRemote.resolve(anchor)
  check('resolve(anchor) routes remote with no cwd', rootT.targetKey === sshTarget(REMOTE.root), rootT.targetKey)
  const rootInfo = await rfsRemote.lstat(anchor)
  check('lstat(anchor) sees a remote directory', rootInfo !== undefined && rootInfo.type === 'directory', JSON.stringify(rootInfo))
  const rootList = await rfsRemote.listDir(rootT)
  check('listDir(remote root) lists remote children', rootList.some((e) => e.name === 'b.txt') && rootList.some((e) => e.name === 'sub'), JSON.stringify(rootList.map((e) => e.name)))

  // A child the Files tree spells as `<anchor>/<name>` (session cwd present).
  const child = await rfsRemote.resolve(join(anchor, 'b.txt'), { cwd: anchor })
  check('resolve(anchor/child, cwd=anchor) targets the remote file', child.targetKey === sshTarget(`${REMOTE.root}/b.txt`), child.targetKey)
  const childText = await rfsRemote.readText(child)
  check('readText reads the remote content', childText === 'remote file content', JSON.stringify(childText))
  check('contains(remote root, remote child)', rfsRemote.contains(rootT, child))

  // Slash-mixed spelling: Files joins with '/', anchor keys use the native sep.
  const childSlash = await rfsRemote.resolve(`${anchorFlat}/b.txt`, { cwd: anchor })
  check('resolve resolves slash-mixed anchor child', childSlash.targetKey === sshTarget(`${REMOTE.root}/b.txt`), childSlash.targetKey)

  // Drill into a subdirectory — with a cwd and without one (Files expand passes
  // only the absolute path).
  const subT = await rfsRemote.resolve(join(anchor, 'sub'), { cwd: anchor })
  check('resolve(anchor/sub) targets the remote subdir', subT.targetKey === sshTarget(`${REMOTE.root}/sub`), subT.targetKey)
  const deep = await rfsRemote.resolve(`${anchorFlat}/sub/c.txt`)
  check('resolve(anchor/sub/c) routes remote without a cwd', deep.targetKey === sshTarget(`${REMOTE.root}/sub/c.txt`), deep.targetKey)
  check('readText reads the nested remote file', (await rfsRemote.readText(deep)) === 'nested content')

  // Local pass-through: an absolute local path under NO anchor stays local even
  // on the remote-configured instance.
  const localT = await rfsRemote.resolve(join(ws, 'a.txt'))
  check('resolve(non-anchor abs path) stays local', (await rfsRemote.readText(localT)) === 'updated', localT.targetKey)
} catch (e) {
  check('remote aliasing flow no throw', false, e && (e.stack || e.message))
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
