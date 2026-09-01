/**
 * Remote-aware `grep` / `glob` tools (replace the harness's ripgrep-based
 * `tool-fs-search`, which spawns the LOCAL ripgrep against the LOCAL session
 * cwd and therefore only ever sees the empty remote-workspace anchor).
 *
 * These tools run ripgrep in the SAME world as the session cwd: a registered
 * remote anchor runs `rg` over ssh2 exec on the remote host (only matches/file
 * paths come back), while a local cwd spawns the system `rg` through
 * `ctx.subprocess` (plain argv — no shell quoting). The schemas and output
 * shapes mirror the built-in `grep`/`glob` so the model is unaware.
 */

import { posix } from 'node:path'
import { shellQuote } from './transport.js'
import { findByCwd } from './registry.js'

const GREP_MAX_MATCHES = 250
const GLOB_MAX_RESULTS = 1000
const RAW_OUTPUT_MAX_BYTES = 20 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 30_000
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 3_000

// ---------------------------------------------------------------------------
// ripgrep argv (mirrors @deepseek-ai/dsh-tool-fs-search)
// ---------------------------------------------------------------------------
function grepArgv(input) {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  // Explicit search root: ripgrep 14+ does NOT search the cwd when no path is
  // given, so a bare `rg --regexp=…` searches zero bytes.
  parts.push('--', input.path ?? '.')
  return parts
}

function globArgv(input) {
  const parts = ['--files', `--glob=${input.pattern}`, '--sort=modified', '--no-ignore', '--hidden']
  for (const name of ['.git', '.hg', '.svn']) {
    parts.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`)
  }
  parts.push('--', input.path ?? '.')
  return parts
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------
function parseGrepMatches(stdout) {
  const matches = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    let rec
    try { rec = JSON.parse(line) } catch { throw new Error('grep: malformed ripgrep --json output') }
    if (rec === null || typeof rec !== 'object' || rec.type !== 'match') continue
    const d = rec.data
    const path = d && d.path && typeof d.path.text === 'string' ? d.path.text : undefined
    if (path === undefined || typeof d.line_number !== 'number' || d.lines === null || typeof d.lines !== 'object') {
      throw new Error('grep: malformed ripgrep match record')
    }
    let lineText
    if (typeof d.lines.text === 'string') lineText = d.lines.text.replace(/\r?\n$/, '')
    else if (typeof d.lines.bytes === 'string') lineText = '(line is not valid UTF-8)'
    else throw new Error('grep: malformed ripgrep match record')
    matches.push({ path: path.replace(/^\.\//, ''), lineNumber: d.line_number, line: lineText })
  }
  return matches
}

function parseGlobPaths(stdout) {
  return stdout.split('\n').filter((p) => p !== '').map((p) => p.replace(/^\.\//, ''))
}

/**
 * Map a model-supplied search path to a remote path. A LOCAL anchor directory
 * (what the system prompt shows as the "working directory") is translated to
 * its remote origin; relative paths and already-remote POSIX paths pass
 * through unchanged (ripgrep resolves relative paths against the remote cwd).
 */
function translatePath(path) {
  if (path === undefined || path === '' || path === '.') return '.'
  const hit = findByCwd(path)
  if (hit !== undefined) {
    return hit.remoteSubpath === '' ? hit.remotePath : posix.join(hit.remotePath, hit.remoteSubpath)
  }
  return path
}

// ---------------------------------------------------------------------------
// Execution (local subprocess vs remote ssh2 exec)
// ---------------------------------------------------------------------------
async function localRg(deps, argv, cwd, signal) {
  const subprocess = deps.getSubprocess()
  if (!subprocess) throw new Error('grep/glob: subprocess service unavailable')
  const handle = subprocess.spawn({
    argv: ['rg', ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES },
      stderr: { maxBytes: STDERR_MAX_BYTES },
    },
    graceMs: GRACE_MS,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw new Error(`grep/glob: rg failed (exit ${outcome.exitCode}): ${stderr?.text ?? ''}`)
  }
  return stdout?.text ?? ''
}

async function remoteRg(client, argv, remoteCwd, signal) {
  const command = ['rg', ...argv].map(shellQuote).join(' ')
  const result = await client.execShell(command, {
    cwd: remoteCwd,
    timeoutMs: SEARCH_TIMEOUT_MS,
    stdoutMaxBytes: RAW_OUTPUT_MAX_BYTES,
    stderrMaxBytes: STDERR_MAX_BYTES,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!result.ok) throw new Error(`grep/glob: remote rg failed: ${result.error ?? ''}`)
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`grep/glob: remote rg failed (exit ${result.exitCode}): ${result.stderr.text}`)
  }
  return result.stdout.text
}

// ---------------------------------------------------------------------------
// Model-facing formatting
// ---------------------------------------------------------------------------
function formatGrep(matches) {
  if (matches.length === 0) return 'No matches found'
  const byFile = new Map()
  for (const m of matches) {
    const g = byFile.get(m.path)
    if (g) g.push(m)
    else byFile.set(m.path, [m])
  }
  const sections = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}\n\n${sections.join('\n\n')}`
}

function formatGlob(paths) {
  if (paths.length === 0) return 'No files found'
  return paths.join('\n')
}

// ---------------------------------------------------------------------------
// Tool construction + registration
// ---------------------------------------------------------------------------
export function createSearchTools(deps) {
  function resolveWorld(exec) {
    const cwd = exec.agent?.session.header.cwd
    const hit = cwd ? findByCwd(cwd) : undefined
    if (hit === undefined) return { local: true, cwd: cwd ?? process.cwd() }
    const remoteCwd = hit.remoteSubpath === '' ? hit.remotePath : posix.join(hit.remotePath, hit.remoteSubpath)
    return { local: false, remoteCwd, client: deps.clientForRemote(hit.host, hit.user, hit.port) }
  }

  async function runRg(exec, buildArgv, input) {
    const world = resolveWorld(exec)
    if (world.local) return localRg(deps, buildArgv(input), world.cwd, exec.signal)
    const remoteInput = input.path !== undefined
      ? { ...input, path: translatePath(input.path) }
      : input
    return remoteRg(world.client, buildArgv(remoteInput), world.remoteCwd, exec.signal)
  }

  const grep = {
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. '
      + `Returns up to ${GREP_MAX_MATCHES} matches. Use read on a matched file for surrounding context. `
      + 'On a remote workspace the search runs on the remote host.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax).' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
        include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                lineNumber: { type: 'integer' },
                line: { type: 'string' },
              },
              required: ['path', 'lineNumber', 'line'],
            },
          },
        },
        required: ['matches'],
      },
      render: (_args, value) => [{ type: 'text', text: formatGrep(value.matches) }],
    },
    async execute(args, exec) {
      const input = {
        pattern: args.pattern,
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.include !== undefined ? { include: args.include } : {}),
      }
      const stdout = await runRg(exec, grepArgv, input)
      return { matches: parseGrepMatches(stdout).slice(0, GREP_MAX_MATCHES) }
    },
  }

  const glob = {
    name: 'glob',
    description: 'Find files matching a glob pattern. Returns file paths, modification-time ordered. '
      + `Returns up to ${GLOB_MAX_RESULTS} paths. On a remote workspace the search runs on the remote host.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match file names against (e.g. "*.ts", "src/**/*.js").' },
        path: { type: 'string', description: 'Directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
      },
      render: (_args, value) => [{ type: 'text', text: formatGlob(value.paths) }],
    },
    async execute(args, exec) {
      const input = { pattern: args.pattern, ...(args.path !== undefined ? { path: args.path } : {}) }
      const stdout = await runRg(exec, globArgv, input)
      return { paths: parseGlobPaths(stdout).slice(0, GLOB_MAX_RESULTS) }
    },
  }

  return { grep, glob }
}

export function applySearchTools(ctx, deps) {
  const { grep, glob } = createSearchTools(deps)

  // Global registration: the fallback for a rosterless deployment (no agent
  // preset), where the model-facing rows sit in the host composition and the
  // built-in `tool-fs-search` is disabled by the patch layer. Under a preset
  // this registration is harmless — it lives in the farthest layer and every
  // nearer layer shadows it.
  ctx.tools.register(grep)
  ctx.tools.register(glob)

  // Per-agent registration: the model-facing grep/glob actually ship in the
  // agent PRESET (`tool-fs-search` in `agent.cordis.yml`), mounted under a
  // STANDING scope that is an ancestor of each agent's own scope. A host-plane
  // `disabled` patch cannot reach that composition — the web bundle already
  // disables the HOST row, and the preset row is a separate mount. Registering
  // in the agent's OWN scope layer (the nearest) shadows the preset's built-in
  // grep/glob without touching the preset. The inject fiber is owned by
  // `agent.ctx`, so it unwinds with the agent.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.inject(['tools'], (scope) => {
      scope.tools.register(grep)
      scope.tools.register(glob)
    })
  })
}

export default applySearchTools
