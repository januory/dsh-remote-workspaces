import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-watch-map-'))
process.env.DSH_HOME = tmp

const { mirrorForChange } = await import('../src/sync.js')

// Build a fake mirror layout under <tmp>/remote-workspaces:
//   mac-root/home
//   naotigames.com-january-62222/data--test
const root = join(tmp, 'remote-workspaces')
const a = join(root, 'mac-root', 'home')
const b = join(root, 'naotigames.com-january-62222', 'data--test')
for (const d of [a, b]) {
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.dsh-remote-meta.json'), JSON.stringify({ remotePath: '/x', host: 'h', username: 'u' }))
}

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

check('maps file under mirror (forward slashes)', mirrorForChange('naotigames.com-january-62222/data--test/testfile.txt') === b)
check('maps file under mirror (backslashes)', mirrorForChange('naotigames.com-january-62222\\data--test\\testfile.txt') === b)
check('maps the mirror dir itself', mirrorForChange('mac-root/home') === a)
check('maps nested file to correct mirror', mirrorForChange('mac-root/home/sub/dir/f.txt') === a)
check('bare basename is ambiguous → undefined', mirrorForChange('testfile.txt') === undefined)
check('empty name → undefined', mirrorForChange('') === undefined)
check('unknown path → undefined', mirrorForChange('other/data/test.txt') === undefined)

rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
