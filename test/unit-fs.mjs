import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { writableRoots, isPathUnder } from '../src/containment.js'
import { registerAnchor, findByCwd, loadAnchors } from '../src/registry.js'
import { LocalBackend } from '../src/local-backend.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-fs-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// ---- containment ----
{
  const root = mkdtempSync(join(tmpdir(), 'root-'))
  const policy = { mode: 'workspace-write', workspaceRoot: root }
  const roots = writableRoots(policy)
  check('workspace-write roots include workspaceRoot', roots.length >= 3 && (await isPathUnder(root, roots[0])))
  check('read-only roots empty', writableRoots({ mode: 'read-only', workspaceRoot: root }).length === 0)
  check('danger-full-access roots empty', writableRoots({ mode: 'danger-full-access', workspaceRoot: root }).length === 0)

  const inside = join(root, 'sub', 'file.txt')
  const outside = join(tmpdir(), 'elsewhere', 'file.txt')
  check('isPathUnder inside', await isPathUnder(inside, root))
  check('isPathUnder outside false', !(await isPathUnder(outside, root)))
  rmSync(root, { recursive: true, force: true })
}

// ---- registry ----
{
  const anchor = join(home, 'remote-workspaces', 'test-root-22', 'root--test')
  registerAnchor({ anchorPath: anchor, machineId: 'm1', host: '192.168.1.1', port: 22, user: 'root', remotePath: '/root/test' })
  const hit = findByCwd(anchor)
  check('findByCwd exact anchor', hit !== undefined && hit.remotePath === '/root/test')
  const sub = findByCwd(join(anchor, 'subdir'))
  check('findByCwd descendant', sub !== undefined && sub.remoteSubpath === 'subdir')
  check('findByCwd non-anchor undefined', findByCwd(join(home, 'other')) === undefined)
  check('anchors persisted', loadAnchors()[anchor] !== undefined)
}

// ---- local backend fence ----
{
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const policy = { mode: 'workspace-write', workspaceRoot: root }
  const getPolicy = () => ({ resolve: () => policy })
  const be = new LocalBackend({ cwd: root, getPolicy })

  const insideTarget = await be.resolve(join(root, 'a.txt'))
  const w = await be.writeText(insideTarget, 'hello', undefined, undefined, policy)
  check('write inside workspace root allowed', w.operation === 'create')
  check('content written', readFileSync(join(root, 'a.txt'), 'utf8') === 'hello')

  // A path OUTSIDE every writable root (workspaceRoot + /tmp + tmpdir()):
  // the user home dir is not under tmpdir on this machine.
  const outsideFile = join(homedir(), `.dsh-deny-${Date.now()}.txt`)
  const outsideTarget = await be.resolve(outsideFile)
  let denied = false
  try {
    await be.writeText(outsideTarget, 'x', undefined, undefined, policy)
  } catch (e) {
    denied = e && e.code === 'FS_SANDBOX_DENIED'
  }
  check('write outside workspace root denied', denied)

  // danger-full-access bypasses the fence (separate file, so the outcome is 'create').
  const wideFile = join(homedir(), `.dsh-wide-${Date.now()}.txt`)
  const wide = await be.writeText(await be.resolve(wideFile), 'x', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: root })
  check('danger-full-access bypasses fence', wide.operation === 'create')
  rmSync(outsideFile, { force: true })
  rmSync(wideFile, { force: true })

  // no policy service → no confinement (bare local, backward compatible)
  const bare = new LocalBackend({ cwd: root })
  const bareTarget = await bare.resolve(join(root, 'b.txt'))
  const bareW = await bare.writeText(bareTarget, 'b')
  check('bare backend (no policy) writes unconditionally', bareW.operation === 'create')
  rmSync(root, { recursive: true, force: true })
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
