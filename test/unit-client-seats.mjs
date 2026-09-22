/**
 * Offline test for the client half's right-Sidebar SEATS: the Shell tab type
 * must register its body AND its chip title under the same type `id`.
 *
 * Why this is worth a test: a tab chip's leading glyph comes from the keyed
 * `sidebar.right.pane.tab.title` seat, not from the type definition — the
 * definition's `guide[].icon` only draws the 开始-page entry box. Registering
 * the body alone therefore leaves the chip with the bare label, silently: the
 * pane renders, nothing throws, and only a human looking at the strip notices.
 * (Same wiring as the harness's own files type: `FilesBody` + `FilesTitle`.)
 *
 * The client source is bundled with esbuild the way `scripts/build-client.mjs`
 * does, except that `@xterm/xterm` and its fit addon are aliased to stubs: this
 * test asserts the SLOT REGISTRATIONS, and a terminal emulator has no part in
 * them. What it cannot see is pixels — that the glyph is the right size and
 * spacing on the strip is verified in the browser, by eye.
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

// --- bundle the client half with the terminal stubbed out -------------------
const scratch = mkdtempSync(join(tmpdir(), 'dsh-rw-client-'))
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
      // The stylesheet is NOT stubbed: the `.css` text loader must keep handling
      // it, exactly as the real build does.
      build.onResolve({ filter: /^@xterm\// }, (args) => (
        /\.css$/.test(args.path) ? undefined : { path: args.path, namespace: 'xterm-stub' }
      ))
      build.onLoad({ filter: /.*/, namespace: 'xterm-stub' }, () => ({ contents: XTERM_STUB, loader: 'js' }))
    },
  }],
  banner: { js: 'window.__ModuleLoader__.load({ id: "test", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})

// --- load it the way the browser does, with a fake React --------------------
const React = {
  Fragment: Symbol('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  // Minimal hooks: ShellTitle subscribes to the live shell-label store through
  // useState/useEffect. The store is empty in this offline test, so the chip
  // falls back to the captured title — asserted below.
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
check('the bundle registers itself through window.__ModuleLoader__', loaded !== null && loaded.id === 'test')
const plugin = loaded.factory(requireStub)
check('the client half exposes an apply()', typeof plugin.apply === 'function')
check('the client half still injects the sidebar seats', Array.isArray(plugin.inject) && plugin.inject.includes('sidebarRightTabs'), JSON.stringify(plugin.inject))

// --- run apply() against a recording context --------------------------------
const registrations = []
const tabTypes = []
const disposed = []
// DSH 0.1.7 removed `current` from the session-list snapshot; the selection now
// lives on `ctx.uiSession`. Both sources are mutable so the fallback and the
// no-session case can be exercised below.
let uiSession = { adapter: { current: { getSnapshot: () => ({ key: 'sess-9' }) } } }
let sessionSnapshot = { ids: ['sess-9'], byId: { 'sess-9': { id: 'sess-9', cwd: '/remote/workspace' } } }
const ctx = {
  effect: (fn) => { const d = fn(); disposed.push(d); return () => { if (typeof d === 'function') d() } },
  get: (name) => (name === 'uiSession' ? uiSession : undefined),
  remote: { $mount: () => ({}) },
  sessions: { list: { getSnapshot: () => sessionSnapshot } },
  sidebarRightTabs: { register: (spec) => { tabTypes.push(spec); return () => {} } },
  slots: {
    inject: (_name, fn) => { fn(); return () => {} },
    register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
  },
}
plugin.apply(ctx)

const SHELL_ID = 'dsh-remote-workspaces/shell'
const shellType = tabTypes.find((t) => t.id === SHELL_ID)
check('the Shell tab type registers under its id', shellType !== undefined, JSON.stringify(tabTypes.map((t) => t.id)))
check('the sidebar tab label is RW终端', shellType !== undefined && shellType.title() === 'RW终端', shellType && shellType.title())
check('the Shell tab type creates independent content per open (＋ 新建 works)',
  shellType !== undefined && shellType.multiple === true, shellType && String(shellType.multiple))
check('the guide entry carries an id (the registry requires one per provider)',
  shellType !== undefined && typeof shellType.guide[0].id === 'string' && shellType.guide[0].id !== '',
  JSON.stringify(shellType === undefined ? null : shellType.guide[0].id))
check('the 开始-page guide entry is RW终端 + the unchanged description',
  shellType !== undefined && shellType.guide[0].title() === 'RW终端'
  && shellType.guide[0].description() === '打开当前工作区的交互终端',
  JSON.stringify(shellType === undefined ? null : { title: shellType.guide[0].title(), description: shellType.guide[0].description() }))
const shellBody = registrations.find((r) => r.spec.name === 'sidebar.right.pane.tab' && r.spec.key === SHELL_ID)
const shellTitle = registrations.find((r) => r.spec.name === 'sidebar.right.pane.tab.title' && r.spec.key === SHELL_ID)
check('the Shell body registers into sidebar.right.pane.tab', shellBody !== undefined, registrations.map((r) => `${r.spec.name}:${r.spec.key}`).join(' | '))
check('the Shell chip title registers into sidebar.right.pane.tab.title', shellTitle !== undefined, JSON.stringify(shellTitle === undefined ? null : shellTitle.spec))
check('both seats use the SAME type id (the seat dispatches on it, not on the kind)', shellBody !== undefined && shellTitle !== undefined)
check('the chip title seat injects getSessionId (keys the live shell label)',
  typeof shellTitle.spec.inject === 'function' && typeof shellTitle.spec.inject().getSessionId === 'function')

// --- the current session actually resolves (0.1.7 removed snapshot.current) --
// Regression: `sessions.list.getSnapshot().current` no longer exists, so the
// seats silently saw no session, sent `cwd: ''`, and the host opened a LOCAL
// shell instead of one on the remote workspace.
const titleInject = shellTitle.spec.inject()
const bodyInject = shellBody.spec.inject()
check('the seat reads the current session from ctx.uiSession',
  titleInject.getSessionId() === 'sess-9', String(titleInject.getSessionId()))
check('the shell body sends that session\'s cwd to openShellAt',
  bodyInject.getCwd() === '/remote/workspace', String(bodyInject.getCwd()))
check('the body and title agree on the session key', titleInject.getSessionId() === bodyInject.getSessionId())
// A composition without uiSession falls back to the same retention marker the
// core's own publishMain uses (`retainedBy.mainView`).
uiSession = undefined
sessionSnapshot = {
  ids: ['sess-1', 'sess-2'],
  byId: {
    'sess-1': { id: 'sess-1', cwd: '/other', retainedBy: { mainView: 0 } },
    'sess-2': { id: 'sess-2', cwd: '/main', retainedBy: { mainView: 1 } },
  },
}
check('without uiSession the main-view retention marker still resolves the session',
  titleInject.getSessionId() === 'sess-2' && bodyInject.getCwd() === '/main',
  JSON.stringify({ id: titleInject.getSessionId(), cwd: bodyInject.getCwd() }))
// No session at all: undefined, which the body spells as '' for the gateway.
sessionSnapshot = { ids: [], byId: {} }
check('with no session selected the seats report nothing (cwd falls back to \'\')',
  titleInject.getSessionId() === undefined && bodyInject.getCwd() === undefined,
  JSON.stringify({ id: titleInject.getSessionId(), cwd: bodyInject.getCwd() }))

// --- the title really draws a glyph before the live label -------------------
// One element→component pass, the way React resolves a function component
// before painting it (the fake React returns hook values without re-rendering,
// so one pass is enough). Without this the fake `createElement` would hand back
// the component itself instead of the `<svg>` it returns.
const render = (node) => (node && typeof node.type === 'function' ? node.type(node.props) : node)
const title = shellTitle.component({ useTabInfo: () => ({ tab: { title: 'RW终端', id: 'tab-1' } }), getSessionId: () => 'sess-1' })
check('the chip title renders the terminal glyph and the tab label', title.type === React.Fragment && title.children.length === 2, JSON.stringify(title.children.map((c) => (typeof c === 'string' ? c : typeof c.type))))
const glyph = render(title.children[0])
check('the glyph is an inline svg', glyph.type === 'svg' && glyph.props.width === 16 && glyph.props.height === 16, JSON.stringify({ type: glyph.type, width: glyph.props.width }))
check('the glyph draws on currentColor at the strip\'s ink', glyph.props.stroke === 'currentColor' && glyph.props.fill === 'none', JSON.stringify({ stroke: glyph.props.stroke, fill: glyph.props.fill }))
check('the glyph is a fixed-width flex child (the strip spaces it)', glyph.props.style && glyph.props.style.flex === 'none', JSON.stringify(glyph.props.style))
check('the label is the tab title captured by the registry', title.children[1] === 'RW终端', JSON.stringify(title.children[1]))
const fallback = shellTitle.component({ useTabInfo: () => ({ tab: {} }), getSessionId: () => 'sess-1' })
check('a tab record without a title still shows the type label', fallback.children[1] === 'RW终端', JSON.stringify(fallback.children[1]))

rmSync(scratch, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
