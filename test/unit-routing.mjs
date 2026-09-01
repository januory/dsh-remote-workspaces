import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RoutingFileSystem } from '../src/routing-fs.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-routing-'))
process.env.DSH_HOME = home
const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'a.txt'), 'hello routing')

const getPolicy = () => ({ resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws }) })
const rfs = new RoutingFileSystem({ getPolicy, clientForRemote: () => { throw new Error('no remote') } })

// resolve (relative + absolute) with session cwd
try {
  const t1 = await rfs.resolve('a.txt', { cwd: ws })
  check('resolve relative target', t1.displayPath === join(ws, 'a.txt'), t1.displayPath)
  const info = await rfs.stat(t1)
  check('stat target', info !== undefined && info.type === 'file', JSON.stringify(info))
  const text = await rfs.readText(t1)
  check('readText', text === 'hello routing', JSON.stringify(text))
  const list = await rfs.listDir(await rfs.resolve('.', { cwd: ws }))
  check('listDir', list.some((e) => e.name === 'a.txt'))
  const w = await rfs.writeText(t1, 'updated', undefined, undefined, { mode: 'workspace-write', workspaceRoot: ws })
  check('writeText', w.operation === 'update' && readFileSync(join(ws, 'a.txt'), 'utf8') === 'updated')
} catch (e) {
  check('routing flow no throw', false, e && (e.stack || e.message))
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
