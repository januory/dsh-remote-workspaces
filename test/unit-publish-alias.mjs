/**
 * Offline test for the dual-name release (`scripts/prepare-alias.mjs`).
 *
 * Why this is worth a test: this repository publishes the same version under
 * two names — the scoped `@januory/dsh-remote-workspaces` from `package.json`,
 * and the legacy unscoped `dsh-remote-workspaces` staged by this script so
 * existing installs keep upgrading. The installed name is baked into two
 * artifacts DSH reads BY NAME, and getting either wrong fails silently.
 *   - `lib/client.js` registers through `window.__ModuleLoader__.load({id})`;
 *     DSH's client-modules keys its module table by the manifest name and
 *     refuses a bundle registering any other id, so an alias shipped with the
 *     scoped id loses its entire browser half — the pane just never appears.
 *   - `cordis.patch.yml` inserts a loader row by module name; a row naming the
 *     scoped package cannot resolve from a profile that installed the alias,
 *     so the host half never loads either.
 *
 * What it cannot see: esbuild and npm. The staging logic is what this
 * repository owns, so it is asserted here; the rebuilt bundle is asserted only
 * by the banner source (`buildClient`), which needs esbuild and is therefore
 * covered separately by `npm run build:client`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageAlias } from '../scripts/prepare-alias.mjs'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ALIAS = 'dsh-remote-workspaces'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

check('the published name is the scoped package', manifest.name === '@januory/dsh-remote-workspaces',
  String(manifest.name))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-rw-alias-'))
try {
  const outDir = join(scratch, 'package')
  stageAlias({ name: ALIAS, outDir })

  // --- the publish manifest -------------------------------------------------
  const staged = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'))
  check('the alias manifest carries the unscoped legacy name', staged.name === ALIAS, staged.name)
  check('the alias manifest keeps the public access the scoped package publishes with',
    staged.publishConfig?.access === 'public', String(staged.publishConfig?.access))
  check('the alias manifest drops scripts (no prepack re-build over the alias client)',
    staged.scripts === undefined)
  check('the alias manifest drops devDependencies', staged.devDependencies === undefined)
  check('the alias manifest keeps the DSH bundle + client declarations',
    staged.dsh?.bundle?.patch === './cordis.patch.yml' && staged.dsh?.client?.platform === 'web')
  check('the alias manifest keeps the ssh2 runtime dependency',
    staged.dependencies?.ssh2 === manifest.dependencies.ssh2, String(staged.dependencies?.ssh2))
  check('the alias manifest keeps the repository link',
    staged.repository?.url === manifest.repository.url, String(staged.repository?.url))
  check('the alias manifest keeps every published file entry',
    JSON.stringify(staged.files) === JSON.stringify(manifest.files))
  check('the alias manifest keeps the version in lockstep with the scoped release',
    staged.version === manifest.version, String(staged.version))

  // --- the bundle patch row -------------------------------------------------
  const patch = readFileSync(join(outDir, 'cordis.patch.yml'), 'utf8')
  check('the alias patch row names the alias, not the scoped package',
    patch.includes(`name: '${ALIAS}'`) && !patch.includes(`name: '${manifest.name}'`))
  check('the patch keeps disabling the four base providers it replaces',
    (patch.match(/disabled: true/g) ?? []).length === 4)
  check('the patch row keeps its id', /- id: dsh-remote-workspaces/.test(patch))

  // --- the shipped sources --------------------------------------------------
  // Both halves carry the SAME `PACKAGE` constant, so the alias must rewrite
  // both or the namespace registration and the $mount disagree.
  const hostSrc = readFileSync(join(outDir, 'src', 'index.js'), 'utf8')
  const clientSrc = readFileSync(join(outDir, 'src', 'client.js'), 'utf8')
  check('the alias host half registers under the alias name',
    hostSrc.includes(`const PACKAGE = '${ALIAS}'`), /const PACKAGE = '([^']+)'/.exec(hostSrc)?.[1])
  check('the alias client half mounts under the same alias name',
    clientSrc.includes(`var PACKAGE = '${ALIAS}'`), /var PACKAGE = '([^']+)'/.exec(clientSrc)?.[1])
  check('the alias leaves no scoped identity in either half',
    !hostSrc.includes(`PACKAGE = '${manifest.name}'`) && !clientSrc.includes(`PACKAGE = '${manifest.name}'`))
  check('the repository keeps the scoped identity in both halves',
    readFileSync(join(root, 'src', 'index.js'), 'utf8').includes(`const PACKAGE = '${manifest.name}'`)
    && readFileSync(join(root, 'src', 'client.js'), 'utf8').includes(`var PACKAGE = '${manifest.name}'`))
  check('the alias host half is otherwise byte-identical to the repository copy',
    hostSrc.replace(`const PACKAGE = '${ALIAS}'`, `const PACKAGE = '${manifest.name}'`)
      === readFileSync(join(root, 'src', 'index.js'), 'utf8'))
  check('LICENSE and both READMEs ship with the alias',
    ['LICENSE', 'README.md', 'README.zh.md'].every((file) =>
      readFileSync(join(outDir, file), 'utf8') === readFileSync(join(root, file), 'utf8')))

  // --- the repository's own patch row ---------------------------------------
  const ownPatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  check('the published patch row names the scoped package',
    ownPatch.includes(`name: '${manifest.name}'`) && !ownPatch.includes(`name: '${ALIAS}'`))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
