import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncMirror, recordInitialBase } from '../src/sync.js'

// Point DSH_HOME at a temp dir so the sync log written by syncMirror stays out
// of the real ~/.dsh (this test uses a mock host, not a real machine).
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-race-home-'))
process.env.DSH_HOME = dshHome

/**
 * A faithful-enough mock of the transport.js sftp facade for a FLAT remote dir,
 * so the delete-guard logic can be tested deterministically (no network timing).
 */
function makeMockSftp(remotePath, entries) {
  const norm = remotePath.replace(/\/+$/, '')
  const full = (rel) => `${norm}/${rel}`
  const files = new Map(entries.map((e) => [full(e.rel), { ...e }]))
  const log = { unlinked: [], read: [] }
  return {
    files,
    log,
    async readdir(dir) {
      const d = String(dir).replace(/\/+$/, '')
      const prefix = d + '/'
      const out = []
      for (const [p, e] of files) {
        if (p.startsWith(prefix)) {
          const name = p.slice(prefix.length)
          if (!name.includes('/')) {
            out.push({ filename: name, attrs: { size: e.size, mtime: e.mtime, isDirectory: () => false } })
          }
        }
      }
      return out
    },
    async stat(p) {
      const e = files.get(String(p))
      if (!e) throw new Error('ENOENT: ' + p)
      return { size: e.size, mtime: e.mtime, isDirectory: () => false }
    },
    async readFile(p) {
      log.read.push(String(p))
      const e = files.get(String(p))
      if (!e) throw new Error('ENOENT: ' + p)
      return Buffer.from(e.content)
    },
    async writeFile() {},
    async mkdir() {},
    async unlink(p) { log.unlinked.push(String(p)); files.delete(String(p)) },
    async rename() {},
    async realpath(p) { return p },
    end() {},
  }
}

function setup(localDir, remotePath, entries) {
  const sftp = makeMockSftp(remotePath, entries)
  mkdirSync(localDir, { recursive: true })
  writeFileSync(join(localDir, '.dsh-remote-meta.json'), JSON.stringify({
    host: 'example.test', port: 22, username: 'tester', remotePath, createdAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8')
  return sftp
}

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// ---- C1: transient absence (save window) must NOT delete the remote file ----
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-race-'))
  const remotePath = '/remote/test'
  const sftp = setup(tmp, remotePath, [{ rel: 'a.txt', content: 'hello', size: 5, mtime: 1700000000 }])
  const lp = join(tmp, 'a.txt')
  writeFileSync(lp, 'hello')
  await recordInitialBase(sftp, remotePath, tmp, { maxDepth: 2, maxFiles: 100 })

  rmSync(lp, { force: true }) // walkLocal will see it missing
  const restore = setTimeout(() => writeFileSync(lp, 'hello'), 300)

  const r = await syncMirror(sftp, tmp, { deleteConfirmMs: 1000, maxDepth: 2, maxFiles: 100 })
  clearTimeout(restore)

  check('C1 transient window: remote NOT unlinked', sftp.log.unlinked.length === 0, `unlinked=${JSON.stringify(sftp.log.unlinked)}`)
  check('C1 transient window: local file present again', existsSync(lp), `pushed=${r.pushed}`)
  rmSync(tmp, { recursive: true, force: true })
}

// ---- C2: genuine local delete still propagates to remote ----
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-race-'))
  const remotePath = '/remote/test'
  const sftp = setup(tmp, remotePath, [{ rel: 'a.txt', content: 'hello', size: 5, mtime: 1700000000 }])
  const lp = join(tmp, 'a.txt')
  writeFileSync(lp, 'hello')
  await recordInitialBase(sftp, remotePath, tmp, { maxDepth: 2, maxFiles: 100 })

  rmSync(lp, { force: true }) // genuine delete — stays absent
  const r = await syncMirror(sftp, tmp, { deleteConfirmMs: 100, maxDepth: 2, maxFiles: 100 })

  check('C2 genuine delete: remote unlinked once', sftp.log.unlinked.length === 1, `unlinked=${JSON.stringify(sftp.log.unlinked)}`)
  check('C2 genuine delete: pushed==1', r.pushed === 1, `pushed=${r.pushed}`)
  rmSync(tmp, { recursive: true, force: true })
}

// ---- C3: a remote edit racing in during the confirm window wins (no unlink) ----
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-race-'))
  const remotePath = '/remote/test'
  const sftp = setup(tmp, remotePath, [{ rel: 'a.txt', content: 'hello', size: 5, mtime: 1700000000 }])
  const lp = join(tmp, 'a.txt')
  writeFileSync(lp, 'hello')
  await recordInitialBase(sftp, remotePath, tmp, { maxDepth: 2, maxFiles: 100 })

  rmSync(lp, { force: true }) // local absent
  const remoteEntry = sftp.files.get('/remote/test/a.txt')
  const mutate = setTimeout(() => { remoteEntry.size = 99; remoteEntry.mtime = 1800000000; remoteEntry.content = 'remote-edited' }, 200)
  const r = await syncMirror(sftp, tmp, { deleteConfirmMs: 1000, maxDepth: 2, maxFiles: 100 })
  clearTimeout(mutate)

  check('C3 remote race: remote NOT unlinked', sftp.log.unlinked.length === 0, `unlinked=${JSON.stringify(sftp.log.unlinked)}`)
  check('C3 remote race: remote content preserved', sftp.files.get('/remote/test/a.txt').content === 'remote-edited')
  rmSync(tmp, { recursive: true, force: true })
}

rmSync(dshHome, { recursive: true, force: true })

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
