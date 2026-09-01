import { applySearchTools, createSearchTools } from '../src/search.js'

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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
