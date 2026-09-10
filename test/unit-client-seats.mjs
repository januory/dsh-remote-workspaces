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
const disposed = []
const ctx = {
  effect: (fn) => { const d = fn(); disposed.push(d); return () => { if (typeof d === 'function') d() } },
  get: () => undefined,
  remote: { $mount: () => ({}) },
  sessions: {},
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (_name, fn) => { fn(); return () => {} },
    register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
  },
}
plugin.apply(ctx)

const SHELL_ID = 'dsh-remote-workspaces/shell'
const shellBody = registrations.find((r) => r.spec.name === 'sidebar.right.pane.tab' && r.spec.key === SHELL_ID)
const shellTitle = registrations.find((r) => r.spec.name === 'sidebar.right.pane.tab.title' && r.spec.key === SHELL_ID)
check('the Shell body registers into sidebar.right.pane.tab', shellBody !== undefined, registrations.map((r) => `${r.spec.name}:${r.spec.key}`).join(' | '))
check('the Shell chip title registers into sidebar.right.pane.tab.title', shellTitle !== undefined, JSON.stringify(shellTitle === undefined ? null : shellTitle.spec))
check('both seats use the SAME type id (the seat dispatches on it, not on the kind)', shellBody !== undefined && shellTitle !== undefined)

// --- the title really draws a glyph before the live label -------------------
// One element→component pass, the way React resolves a function component
// before painting it (the components under test hold no hooks, so once is
// enough). Without this the fake `createElement` would hand back the component
// itself instead of the `<svg>` it returns.
const render = (node) => (node && typeof node.type === 'function' ? node.type(node.props) : node)
const title = shellTitle.component({ useTabInfo: () => ({ tab: { title: 'Shell', id: 'tab-1' } }) })
check('the chip title renders the terminal glyph and the tab label', title.type === React.Fragment && title.children.length === 2, JSON.stringify(title.children.map((c) => (typeof c === 'string' ? c : typeof c.type))))
const glyph = render(title.children[0])
check('the glyph is an inline svg', glyph.type === 'svg' && glyph.props.width === 16 && glyph.props.height === 16, JSON.stringify({ type: glyph.type, width: glyph.props.width }))
check('the glyph draws on currentColor at the strip\'s ink', glyph.props.stroke === 'currentColor' && glyph.props.fill === 'none', JSON.stringify({ stroke: glyph.props.stroke, fill: glyph.props.fill }))
check('the glyph is a fixed-width flex child (the strip spaces it)', glyph.props.style && glyph.props.style.flex === 'none', JSON.stringify(glyph.props.style))
check('the label is the tab title captured by the registry', title.children[1] === 'Shell', JSON.stringify(title.children[1]))
const fallback = shellTitle.component({ useTabInfo: () => ({ tab: {} }) })
check('a tab record without a title still shows the type label', fallback.children[1] === 'Shell', JSON.stringify(fallback.children[1]))

rmSync(scratch, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
