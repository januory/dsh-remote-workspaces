/**
 * Stage a publish-ready copy of this package under its SCOPED alias name.
 *
 * Why a staged copy instead of publishing twice from the repo root: the
 * installed name is baked into two artifacts DSH reads by name, so the scoped
 * alias cannot ship them verbatim.
 *   - `lib/client.js` registers through `window.__ModuleLoader__.load({id})`,
 *     and DSH's client-modules rejects a bundle whose id is not the manifest
 *     name (`loaded without registering "<name>"`) — the browser half would
 *     silently disappear.
 *   - `cordis.patch.yml` inserts a loader row by module name; a row naming the
 *     unscoped package cannot resolve from a profile that installed the alias.
 *
 * Both names go to npmjs, same version, same code — the alias only differs in
 * those two places plus its own `name`.
 *
 * Usage: node scripts/prepare-alias.mjs <name> <outDir>
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from './build-client.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Write the alias build of this package into `outDir`, bundle included.
 * @param options - target package name and output directory.
 */
export async function prepareAlias({ name, outDir }) {
  stageAlias({ name, outDir })
  await buildClient({ id: name, outfile: join(resolve(outDir), 'lib', 'client.js') })
}

/**
 * Copy the package into `outDir` under `name`: sources, manifest and the
 * renamed loader row. The client bundle is rebuilt by {@link prepareAlias},
 * since its registration id has to change with the name.
 * @param options - target package name and output directory.
 */
export function stageAlias({ name, outDir }) {
  const from = resolve(root)
  const to = resolve(outDir)
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))

  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const entry of manifest.files) {
    // The client artifact is rebuilt under the alias id, never copied.
    if (entry === 'lib/client.js') continue
    cpSync(join(from, entry), join(to, entry), { recursive: true })
  }
  // npm always packs these even when `files` omits them; copy them so the
  // alias tarball matches the unscoped one.
  for (const entry of ['LICENSE', 'README.md', 'README.zh.md']) {
    cpSync(join(from, entry), join(to, entry))
  }

  const patchFile = join(to, 'cordis.patch.yml')
  const patch = readFileSync(patchFile, 'utf8')
  const original = `name: '${manifest.name}'`
  if (!patch.includes(original)) throw new Error(`${patchFile}: no ${JSON.stringify(original)} loader row to rename`)
  writeFileSync(patchFile, patch.replace(original, `name: '${name}'`))

  // Both halves declare the SAME `PACKAGE` constant and pass it as their Remote
  // identity (host: typert.register, client: remote.$mount). Replacing only one
  // side would leave them describing different packages: the settings section
  // would fail to mount its namespace. Rewrite both, or neither.
  for (const [file, keyword] of [['index.js', 'const'], ['client.js', 'var']]) {
    const target = join(to, 'src', file)
    const source = readFileSync(target, 'utf8')
    const declaration = `${keyword} PACKAGE = '${manifest.name}'`
    if (!source.includes(declaration)) {
      throw new Error(`${target}: no ${JSON.stringify(declaration)} to rename`)
    }
    writeFileSync(target, source.replace(declaration, `${keyword} PACKAGE = '${name}'`))
  }

  // Publish-only manifest: `scripts` would re-run the default build over the
  // alias artifact, and `devDependencies` are not installed in this copy.
  const { scripts, devDependencies, ...publishable } = manifest
  writeFileSync(join(to, 'package.json'), `${JSON.stringify({ ...publishable, name }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, outDir] = process.argv.slice(2)
  if (name === undefined || outDir === undefined) {
    throw new Error('usage: node scripts/prepare-alias.mjs <name> <outDir>')
  }
  await prepareAlias({ name, outDir })
}
