/**
 * Build the browser client bundle (`lib/client.js`) with esbuild.
 *
 * Mirrors the harness's own `tsdown.client.ts` clientConfig approach:
 *   - bundle = a closure factory that calls `window.__ModuleLoader__.load({id, factory})`;
 *   - `react` (and the other platform seed words) stay EXTERNAL, resolved by the
 *     factory's injected `require` (the module table seed from `PLATFORM_MODULES`);
 *   - everything else — notably `@xterm/xterm` and its CSS — is INLINED into the
 *     artifact, so the plugin never touches deepseek-harness source.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = 'dsh-remote-workspaces'

await build({
  entryPoints: [resolve(root, 'src/client.js')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  loader: { '.css': 'text' },
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
