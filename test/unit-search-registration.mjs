import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applySearchTools, createSearchTools } from '../src/search.js'
import { registerAnchor } from '../src/registry.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-search-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// --- verify createSearchTools exposes the two tool definitions ---
const deps = {
  getSubprocess: () => { throw new Error('not used at registration') },
  clientForRemote: () => { throw new Error('not used at registration') },
}
const { grep, glob } = createSearchTools(deps)
check('grep tool has correct name', grep.name === 'grep', grep.name)
check('glob tool has correct name', glob.name === 'glob', glob.name)

// --- mock cordis ctx: global tools registry + agent/created event bus ---
const globalTools = []
const createdListeners = []
const mockCtx = {
  tools: {
    register(def) {
      globalTools.push(def.name)
      return () => {}
    },
  },
  on(event, listener) {
    if (event === 'agent/created') createdListeners.push(listener)
  },
}

applySearchTools(mockCtx, deps)

check('registers grep globally', globalTools.includes('grep'), globalTools.join(','))
check('registers glob globally', globalTools.includes('glob'), globalTools.join(','))
check('registers an agent/created listener', createdListeners.length === 1, String(createdListeners.length))

// --- fire agent/created with a mock agent whose scope has its own tools layer ---
const scopedTools = []
const mockAgent = {
  ctx: {
    inject(depsList, callback) {
      const scope = {
        tools: {
          register(def) {
            scopedTools.push(def.name)
            return () => {}
          },
        },
      }
      callback(scope)
      return { dispose: () => {} }
    },
  },
}

createdListeners[0]({ agent: mockAgent })

check('registers grep into the agent scope (shadows preset)', scopedTools.includes('grep'), scopedTools.join(','))
check('registers glob into the agent scope (shadows preset)', scopedTools.includes('glob'), scopedTools.join(','))

// ---------------------------------------------------------------------------
// World resolution: the session cwd decides, a registered anchor named by the
// search path is the fallback — the same precedence `ctx.fs` applies. Without
// the fallback `read` reached a remote anchor while `grep`/`glob` ran the LOCAL
// ripgrep against a directory that only exists on the remote.
// ---------------------------------------------------------------------------
const anchored = join(home, 'remote-workspaces', '10.0.0.9-root', 'data--project')
const other = join(home, 'remote-workspaces', '10.0.0.8-root', 'srv--other')
registerAnchor({ anchorPath: anchored, machineId: 'm1', host: '10.0.0.9', port: 22, user: 'root', remotePath: '/data/project' })
registerAnchor({ anchorPath: other, machineId: 'm2', host: '10.0.0.8', port: null, user: 'root', remotePath: '/srv/other' })

const calls = []
function fakeClient(host) {
  return {
    profile: async () => ({ family: 'posix', os: 'linux', shell: 'posix' }),
    execShell: async (command, opts) => {
      calls.push({ host, command, cwd: opts.cwd })
      return { ok: true, exitCode: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    },
  }
}
const localSpawns = []
const routed = createSearchTools({
  getSubprocess: () => ({
    spawn: (spec) => {
      localSpawns.push(spec)
      const read = () => ({ text: '', nextOffset: 0, lossy: false })
      return {
        collected: { stdout: { readFrom: read }, stderr: { readFrom: read } },
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate() {},
      }
    },
  }),
  clientForRemote: (host) => fakeClient(host),
})
const localSession = { agent: { session: { header: { cwd: '/tmp' } } }, signal: undefined }

await routed.grep.execute({ pattern: 'x', path: anchored }, localSession)
check('a search path under an anchor routes the search to that host',
  calls.length === 1 && calls[0].host === '10.0.0.9', JSON.stringify(calls.map((c) => c.host)))
check('the anchor path is translated to its remote spelling',
  calls.length === 1 && calls[0].command.includes('/data/project')
  && !calls[0].command.includes(home), JSON.stringify(calls[0]?.command))
check('the remote search keeps the anchor cwd', calls[0]?.cwd === '/data/project', String(calls[0]?.cwd))
check('no local ripgrep ran for the anchor path', localSpawns.length === 0, `spawned=${localSpawns.length}`)

calls.length = 0
await routed.glob.execute({ pattern: '*.txt', path: anchored }, localSession)
check('glob honours the same path-alias routing', calls.length === 1 && calls[0].host === '10.0.0.9', JSON.stringify(calls.map((c) => c.host)))

// The session cwd still WINS over a path naming another anchor (the precedence
// `RoutingFileSystem.routeRemote` uses), so a remote session never searches a
// different machine because of a path argument.
calls.length = 0
const remoteSession = { agent: { session: { header: { cwd: anchored } } }, signal: undefined }
await routed.grep.execute({ pattern: 'x', path: other }, remoteSession)
check('the session cwd outranks a path naming another anchor',
  calls.length === 1 && calls[0].host === '10.0.0.9', JSON.stringify(calls.map((c) => c.host)))

// No anchor anywhere: the local ripgrep still serves an ordinary local session.
calls.length = 0
await routed.grep.execute({ pattern: 'x', path: '/tmp' }, localSession)
check('a plain local path still uses the local subprocess',
  localSpawns.length === 1 && calls.length === 0, `spawned=${localSpawns.length} remote=${calls.length}`)

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
