/**
 * Local-directory listing unit tests (src/local-browse.js): pure path logic
 * (fully-qualified fence, `~` expansion, platform forms) over deterministic
 * platform params, plus a real temp-directory listing (sorting, dir/file rows,
 * truncation, missing-directory errors).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  localFullyQualified, expandLocalTarget, localLevelListing, localListError, localHome,
  localDriveRoots, LOCAL_DRIVES,
} from '../src/local-browse.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// ── 1. fully-qualified fence (deterministic platform) ─────────────────────────
check('posix absolute is fully qualified', localFullyQualified('/a/b', 'posix'))
check('posix relative is not', !localFullyQualified('a/b', 'posix'))
check('posix backslash name is not absolute', !localFullyQualified('\\a', 'posix'))
check('win drive absolute is fully qualified', localFullyQualified('C:\\Users\\u', 'win32'))
check('win drive forward slash is fully qualified', localFullyQualified('C:/Users/u', 'win32'))
check('win UNC is fully qualified', localFullyQualified('\\\\srv\\share\\dir', 'win32'))
check('win drive-relative rejected', !localFullyQualified('C:x', 'win32'))
check('win rooted drive-less rejected', !localFullyQualified('\\foo', 'win32'))
check('win relative rejected', !localFullyQualified('Users\\u', 'win32'))
check('non-string rejected', !localFullyQualified(undefined, 'posix'))

// ── 2. expandLocalTarget (expansion + absolute normalization) ─────────────────
const posixHome = '/home/user'
check('empty expands to home', expandLocalTarget('', posixHome, 'posix') === posixHome)
check('tilde expands to home', expandLocalTarget('~', posixHome, 'posix') === posixHome)
check('tilde slash expands under home', expandLocalTarget('~/proj/a', posixHome, 'posix') === '/home/user/proj/a')
check('absolute stays (.. resolved)', expandLocalTarget('/data/x/..', posixHome, 'posix') === '/data')
check('relative rejects with DSH_NOT_ABSOLUTE', (() => {
  try { expandLocalTarget('rel/dir', posixHome, 'posix'); return false } catch (e) { return e && e.code === 'DSH_NOT_ABSOLUTE' }
})())

const winHome = 'C:\\Users\\u'
check('win empty expands to home', expandLocalTarget('', winHome, 'win32') === 'C:\\Users\\u')
check('win tilde expands to home', expandLocalTarget('~', winHome, 'win32') === 'C:\\Users\\u')
check('win drive absolute normalizes', expandLocalTarget('C:/Users/u/x', winHome, 'win32') === 'C:\\Users\\u\\x')
check('win .. walks up', expandLocalTarget('C:\\Users\\u\\x\\..', winHome, 'win32') === 'C:\\Users\\u')
check('win relative rejects', (() => {
  try { expandLocalTarget('x', winHome, 'win32'); return false } catch (e) { return e && e.code === 'DSH_NOT_ABSOLUTE' }
})())

// ── 3. localLevelListing over a real temp directory ───────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-local-browse-'))
const root = join(home, 'browse-root')
mkdirSync(join(root, 'dir-a'), { recursive: true })
mkdirSync(join(root, 'dir-b'), { recursive: true })
mkdirSync(join(root, '.hidden-dir'), { recursive: true })
writeFileSync(join(root, 'zeta.txt'), 'z')
writeFileSync(join(root, 'alpha.txt'), 'a')
try {
  const level = await localLevelListing(root)
  check('listing resolves its own path', level.path === root, level.path)
  check('no dot entries', !level.entries.some((e) => e.name === '.' || e.name === '..'))
  const names = level.entries.map((e) => e.name)
  check('directories flagged', level.entries.filter((e) => e.name === 'dir-a' || e.name === 'dir-b').every((e) => e.dir))
  check('files flagged non-dir', level.entries.filter((e) => e.name === 'alpha.txt').every((e) => !e.dir))
  check('hidden dot-dir kept as a row', level.entries.some((e) => e.name === '.hidden-dir' && e.dir))
  check('name-sorted', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), JSON.stringify(names))
  check('not truncated at this size', level.truncated === false)

  const capped = await localLevelListing(root, { maxEntries: 2 })
  check('cap bounds the rows', capped.entries.length === 2, JSON.stringify(capped.entries.length))
  check('cap marks truncated', capped.truncated === true)

  const missing = join(home, 'no-such-dir')
  let missingCode = null
  try { await localLevelListing(missing) } catch (e) { missingCode = e && e.code }
  check('missing directory rejects ENOENT', missingCode === 'ENOENT', String(missingCode))
} catch (e) {
  check('local listing flow no throw', false, e && (e.stack || e.message))
}

// ── 3.5 drive-selection level ────────────────────────────────────────────────
check('drives sentinel is not a real path', (() => {
  try { expandLocalTarget(LOCAL_DRIVES, posixHome, 'posix'); return false } catch (e) { return e && e.code === 'DSH_NOT_ABSOLUTE' }
})())
const posixRoots = await localDriveRoots('linux')
check('non-win32 has no drive list', Array.isArray(posixRoots) && posixRoots.length === 0)
const winRoots = await localDriveRoots('win32')
// The 'win32' platform argument only opens the enumeration branch — the probe
// still hits the REAL filesystem ('C:\', …), which only exists on a win32 host.
// On a POSIX host an empty result is expected, so only shape is asserted there.
const winShape = Array.isArray(winRoots) && winRoots.every((r) => /^[A-Za-z]:\\$/.test(r))
if (process.platform === 'win32') {
  check('win32 host lists drive roots', winShape && winRoots.length > 0, JSON.stringify(winRoots.slice(0, 6)))
} else {
  check('win32-mode probe shape (empty on posix host)', winShape)
}

// ── 4. error message mapping ──────────────────────────────────────────────────
check('ENOENT maps to 目录不存在', localListError(Object.assign(new Error('x'), { code: 'ENOENT' }), '/nope').startsWith('目录不存在：/nope'))
check('DSH_NOT_ABSOLUTE surfaces message', localListError(Object.assign(new Error('不是完整路径（需要绝对路径或以 ~ 开头）：rel'), { code: 'DSH_NOT_ABSOLUTE' }), '').includes('不是完整路径'))
check('EACCES maps to 无权限', localListError(Object.assign(new Error('x'), { code: 'EACCES' }), '/x').startsWith('无权限读取：/x'))
check('generic maps to 无法读取', localListError(new Error('boom'), '/x').startsWith('无法读取目录：/x'))

check('localHome returns a string', typeof localHome() === 'string')

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
