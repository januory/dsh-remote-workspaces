/**
 * Registry os-profile storage: registerAnchor/updateAnchorOs persist the
 * probed remote profile and findByCwd exposes it; rows without it stay safe.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerAnchor, updateAnchorOs, findByCwd, loadAnchors } from '../src/registry.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-regos-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const anchor = join(home, 'remote-workspaces', 'win-test-22', 'x--work')
const BASE = { anchorPath: anchor, machineId: 'm1', host: 'win-test', port: 22, user: 'admin' }

// Row registered before B4 has no os field.
registerAnchor({ ...BASE, remotePath: '/X:/work' })
let hit = findByCwd(anchor)
check('legacy row exposes no os', hit !== undefined && hit.os === undefined, JSON.stringify(hit && hit.os))

// Row registered with an os profile stores + exposes it.
const anchor2 = join(home, 'remote-workspaces', 'win-test-22', 'x--work2')
registerAnchor({ ...BASE, anchorPath: anchor2, remotePath: '/X:/work2', os: { family: 'windows', os: 'windows', shell: 'powershell' } })
hit = findByCwd(join(anchor2, 'sub', 'dir'))
check('row with os exposes profile through findByCwd', hit !== undefined && hit.os?.family === 'windows' && hit.os?.shell === 'powershell', JSON.stringify(hit && hit.os))
check('row persists os to disk', loadAnchors()[anchor2]?.os?.family === 'windows')

// updateAnchorOs backfills a legacy row.
const updated = updateAnchorOs(anchor, { family: 'windows', os: 'windows', shell: 'powershell' })
check('updateAnchorOs returns updated row', updated !== undefined && updated.os?.shell === 'powershell')
check('backfill visible to findByCwd', findByCwd(anchor)?.os?.family === 'windows')
check('updateAnchorOs on unknown row is a no-op', updateAnchorOs(join(home, 'nope'), { family: 'windows' }) === undefined)

// registerAnchor os stays optional / non-os rows unaffected by update of others.
check('non-os anchor unaffected elsewhere', findByCwd(anchor2)?.os?.shell === 'powershell')

rmSync(home, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
