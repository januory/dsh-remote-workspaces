/**
 * Offline test for the hand-rolled Remote CONTRACT both halves publish.
 *
 * Why this is worth a test: this plugin ships no generated typert artifact —
 * src/index.js (host half) and src/client.js (browser half) each hand-roll the
 * same 17 invocation descriptors, and the two must stay identical. DSH
 * validates every `mode: 'strict'` codec at registration (`validateCodec` in
 * @deepseek-ai/dsh-typert-registry) by reading `codec.schema.parse`, and both
 * gateways decode boundary values the same way. When that field is missing the
 * registry throws a bare
 *
 *   TypeError: Cannot read properties of undefined (reading 'parse')
 *
 * which the settings section surfaces as 「Remote 命名空间挂载失败：…」 while the
 * whole remoteWorkspaces namespace stays unmounted. DSH has spelled this
 * contract both as `schema.parse` and as a `create()` factory across releases,
 * so this test pins the current shape and the older compatibility field, in
 * BOTH halves, at the level the registry actually reads.
 *
 * What it cannot see: the real TypertRegistry (DSH is not a dependency of this
 * bundle). The host half runs against a recording context, and the client half
 * is bundled with esbuild the way scripts/build-client.mjs does — with
 * `@xterm/xterm` aliased to a stub, since a terminal emulator has no part in
 * the contract. `DSH_HOME` is redirected to a scratch directory so the host
 * half's startup migration never touches a real machine registry.
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-rw-codec-home-'))
process.env.DSH_HOME = scratchHome

// --- the host half: capture what it hands to typert.register() --------------
const host = await import('../src/index.js')
let hostContribution
const hostCtx = {
  provide() {},
  on() {},
  effect(fn) { const disposer = fn?.(); return () => { if (typeof disposer === 'function') disposer() } },
  inject(deps, callback) {
    // Only the typert registration is under test; the fs/shell/search
    // injections would need the whole harness and add nothing here.
    if (deps.includes('typert')) {
      callback({ get: (key) => (key === 'typert'
        ? { register: (contribution) => { hostContribution = contribution; return () => {} } }
        : undefined) })
    }
    return () => {}
  },
  get() { return undefined },
}
host.apply(hostCtx)

// --- the client half: bundle it, then capture its $mount contribution -------
const scratch = mkdtempSync(join(tmpdir(), 'dsh-rw-codec-'))
const outfile = join(scratch, 'client.cjs')
const XTERM_STUB = [
  'export class Terminal {',
  '  constructor() { this.cols = 80; this.rows = 24 }',
  '  onData() {} onResize() {} open() {} write() {} writeln() {} dispose() {} focus() {} loadAddon() {}',
  '}',
  'export class FitAddon { fit() {} }',
].join('\n')

await build({
  entryPoints: [join(root, 'src', 'client.js')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
  plugins: [{
    name: 'stub-xterm',
    setup(build) {
      build.onResolve({ filter: /^@xterm\// }, (args) => (
        /\.css$/.test(args.path) ? undefined : { path: args.path, namespace: 'xterm-stub' }
      ))
      build.onLoad({ filter: /.*/, namespace: 'xterm-stub' }, () => ({ contents: XTERM_STUB, loader: 'js' }))
    },
  }],
  banner: { js: 'window.__ModuleLoader__.load({ id: "test", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})

const React = {
  Fragment: Symbol('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
let loaded = null
const windowStub = { __ModuleLoader__: { load: (def) => { loaded = def } } }
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected platform module: ${name}`)
}
// eslint-disable-next-line no-new-func
new Function('window', 'require', (await import('node:fs')).readFileSync(outfile, 'utf8'))(windowStub, requireStub)
const client = loaded === null ? null : loaded.factory(requireStub)

const mounts = []
const clientCtx = {
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: () => undefined,
  remote: { $mount: (contribution) => { mounts.push(contribution); return Promise.resolve(async () => {}) } },
  sessions: {},
  sidebarRightTabs: { register: () => () => {} },
  slots: { inject: (_name, fn) => { fn(); return () => {} }, register: () => () => {} },
}
client.apply(clientCtx)

// --- assertions -------------------------------------------------------------
const endpoint = (descriptor) => `${descriptor.namespace}/${descriptor.method}`
const hostDescriptors = hostContribution === undefined ? [] : hostContribution.invocations
const clientDescriptors = mounts.length === 0 ? [] : mounts[0].descriptors

check('the host half registers a Remote contribution under the bundle package',
  hostContribution !== undefined && hostContribution.package === 'dsh-remote-workspaces',
  hostContribution && hostContribution.package)
check('the client half mounts the same package',
  mounts.length === 1 && mounts[0].package === 'dsh-remote-workspaces',
  JSON.stringify(mounts.map((m) => m.package)))
check('both halves carry the same 17 endpoints, in the same order',
  hostDescriptors.length === 17 && clientDescriptors.length === 17
  && hostDescriptors.map(endpoint).join('|') === clientDescriptors.map(endpoint).join('|'),
  `${hostDescriptors.length} host vs ${clientDescriptors.length} client`)

/**
 * Every codec the registry reads: strict mode, a nonempty type symbol, and the
 * `schema.parse` boundary function the current DSH validates and decodes with.
 */
function codecProblem(codec) {
  if (codec === undefined || codec === null) return 'missing codec'
  if (codec.mode !== 'strict') return `mode ${JSON.stringify(codec.mode)}`
  if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol === '') return 'empty typeSymbol'
  if (typeof codec.schema?.parse !== 'function') return 'no schema.parse — the registry TypeErrors here'
  return null
}

function inspect(halfName, descriptors) {
  const problems = []
  for (const descriptor of descriptors) {
    for (const parameter of descriptor.parameters) {
      const problem = codecProblem(parameter.codec)
      if (problem !== null) problems.push(`${endpoint(descriptor)} parameter ${parameter.wire}: ${problem}`)
    }
    const problem = codecProblem(descriptor.result)
    if (problem !== null) problems.push(`${endpoint(descriptor)} result: ${problem}`)
  }
  check(`${halfName} declares a strict, parseable codec on every parameter and result`,
    problems.length === 0, problems.slice(0, 3).join(' | '))
  return problems
}

const hostProblems = inspect('host', hostDescriptors)
const clientProblems = inspect('client', clientDescriptors)

const sample = hostDescriptors[0]?.result
// Probed defensively: a codec that lost its `schema` must FAIL this check
// rather than crash the test with the same TypeError the registry throws.
let probe
try { probe = sample?.schema?.parse?.({ a: [1, 'x'] }) } catch { probe = undefined }
check('the schema parses pass-through JSON (the contract is a JSON wire)',
  probe !== undefined && JSON.stringify(probe) === JSON.stringify({ a: [1, 'x'] }),
  probe === undefined ? String(sample?.schema) : JSON.stringify(probe))
check('the 0.1.5-line create() factory still yields that same schema (cross-version compatibility)',
  sample !== undefined && typeof sample.create === 'function' && sample.create() === sample.schema,
  sample === undefined ? 'no descriptors' : typeof sample.create)
check('both halves spell the codec the same way',
  hostProblems.length === 0 && clientProblems.length === 0
  && JSON.stringify(Object.keys(hostDescriptors[0].result).sort()) === JSON.stringify(Object.keys(clientDescriptors[0].result).sort()),
  JSON.stringify(Object.keys(clientDescriptors[0]?.result ?? {}).sort()))

// --- the optional-argument contract (`missing "cwd"`) ------------------------
/**
 * `openShellAt(cwd, opts)` takes an OPTIONAL `cwd`: the host opens the harness
 * process cwd when it is absent. The gateway builds `args` from the positional
 * call and DROPS a parameter whose value is `undefined`
 * (`prepareInvocation`, packages/api/gateway/src/client/index.ts), and the host
 * then rejects a request whose declared field is absent. On DSH
 * 0.1.6-alpha.2 that surfaced, from the terminal seat's cwd-less call, as
 *
 *   typert gateway: remoteWorkspaces/openShellAt: args fields do not match the
 *   descriptor: missing "cwd"
 *
 * so an omissible field MUST be declared (`acceptsUndefined: true`), or the
 * client must never send `undefined`. Both halves are pinned for both.
 *
 * `assertExactArguments` (packages/api/gateway/src/index.ts, the running
 * harness's own gate) is transcribed below: DSH is not a dependency of this
 * bundle, so the negative control is what keeps the transcription honest.
 */
function missingFields(descriptor, args) {
  const expected = new Set(descriptor.parameters.map((parameter) => parameter.wire))
  if (descriptor.invocation.kind === 'context') expected.add(descriptor.invocation.wire)
  const acceptsMissing = new Set(descriptor.parameters
    .filter((parameter) => parameter.source === 'json'
      && (parameter.acceptsUndefined === true || parameter.codec.mode === 'src-json'))
    .map((parameter) => parameter.wire))
  return [...expected].filter((key) => !Object.hasOwn(args, key) && !acceptsMissing.has(key))
}

const findEndpoint = (descriptors, wanted) => descriptors.find((d) => endpoint(d) === wanted)
const hostOpenAt = findEndpoint(hostDescriptors, 'remoteWorkspaces/openShellAt')
const clientOpenAt = findEndpoint(clientDescriptors, 'remoteWorkspaces/openShellAt')

for (const [halfName, descriptor] of [['host', hostOpenAt], ['client', clientOpenAt]]) {
  const cwd = descriptor?.parameters?.[0]
  check(`${halfName} declares openShellAt's cwd as omissible (acceptsUndefined)`,
    cwd?.wire === 'cwd' && cwd?.acceptsUndefined === true,
    JSON.stringify(descriptor?.parameters))
  // The gate accepts the exact cwd-less call the terminal seat makes once the
  // current session has no cwd yet, and `opts` stays required.
  check(`${halfName}'s cwd-less openShellAt call passes the host argument gate`,
    descriptor !== undefined && missingFields(descriptor, { opts: { rows: 24, cols: 80 } }).length === 0
    && missingFields(descriptor, { cwd: '/tmp', opts: {} }).length === 0
    && JSON.stringify(missingFields(descriptor, { cwd: '/tmp' })) === '["opts"]',
    descriptor === undefined ? 'no descriptor' : JSON.stringify(missingFields(descriptor, { opts: {} })))
}

// Negative control: the same transcribed gate still catches a genuinely
// missing required field, so a blanket "nothing is required" regression fails.
const hostWrite = findEndpoint(hostDescriptors, 'remoteWorkspaces/shellWrite')
check('the argument gate still rejects a missing required field (negative control)',
  hostWrite !== undefined && JSON.stringify(missingFields(hostWrite, { id: 'x' })) === '["data"]',
  hostWrite === undefined ? 'no descriptor' : JSON.stringify(missingFields(hostWrite, { id: 'x' })))

check('both halves spell the openShellAt parameters the same way',
  hostOpenAt !== undefined && clientOpenAt !== undefined
  && JSON.stringify(hostOpenAt.parameters) === JSON.stringify(clientOpenAt.parameters),
  JSON.stringify(clientOpenAt?.parameters))

// The seat itself: it must never hand the gateway an `undefined` positional
// argument, because the gateway would silently drop it and the host would
// reject the call. Pinned at the source level — the seat needs a live xterm,
// a session store and a mounted remote to run.
const seatSource = (await import('node:fs')).readFileSync(join(root, 'src', 'client.js'), 'utf8')
check('the terminal seat sends a defined cwd, never undefined',
  /var cwd = typeof wanted === 'string' \? wanted : ''/.test(seatSource)
  && !/var cwd = getCwd \? getCwd\(\) : undefined/.test(seatSource))

rmSync(scratch, { recursive: true, force: true })
rmSync(scratchHome, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
