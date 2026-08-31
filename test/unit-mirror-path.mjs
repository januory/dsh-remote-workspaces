import { basename } from 'node:path'
import { mirrorDirFor } from '../src/mirror.js'

const machine = { host: 'example.test', user: 'user', port: null }
const checks = []
function check(label, cond) { checks.push({ label, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`) }

const a = mirrorDirFor(machine, '/home/test')
const b = mirrorDirFor(machine, '/data/test')

check('same basename, different parents → different dirs', a !== b)
check('/home/test → …/home--test', a.endsWith('home--test'))
check('/data/test → …/data--test', b.endsWith('data--test'))
check('/home/test is idempotent', a === mirrorDirFor(machine, '/home/test'))
check('root / → workspace', mirrorDirFor(machine, '/').endsWith('workspace'))
check('single-segment /data → data', mirrorDirFor(machine, '/data').endsWith('data'))
check('windows-illegal chars sanitized', !/[:*?"<>|]/.test(basename(mirrorDirFor(machine, '/a:b*c?d"e'))))

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
