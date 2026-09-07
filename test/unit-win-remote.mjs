/**
 * Pure unit tests for the Windows-remote compatibility layer: path
 * normalization, PowerShell quoting/encoding, and per-profile exec-script
 * building. No network — every case is a pure function.
 *
 * All paths are neutral fixtures (never a real host's drive layout).
 */
import { toWinPath, psQuote, psCommandEnvelope, buildExecScript, stripPsProgressClixml, shellQuote } from '../src/transport.js'
import { remoteRgCommand } from '../src/search.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const decodeEnvelope = (line) => {
  const m = /FromBase64String\('([^']+)'\)/.exec(line)
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : null
}

// --- toWinPath --------------------------------------------------------------
check('toWinPath strips drive prefix', toWinPath('/X:/work/demo') === 'X:/work/demo')
check('toWinPath strips drive root', toWinPath('/X:/') === 'X:/')
check('toWinPath keeps lowercase drive', toWinPath('/x:/work') === 'x:/work')
check('toWinPath leaves POSIX path alone', toWinPath('/data/test') === '/data/test')
check('toWinPath leaves bare drive path alone', toWinPath('X:/work') === 'X:/work')
check('toWinPath leaves relative alone', toWinPath('rel/path') === 'rel/path')

// --- psQuote ----------------------------------------------------------------
check('psQuote basic', psQuote('X:/work') === `'X:/work'`)
check('psQuote escapes apostrophe', psQuote("it's") === `'it''s'`)

// --- psCommandEnvelope round-trip -------------------------------------------
{
  const inner = `Set-Location -LiteralPath 'X:/work'\necho hi\nif ($?) { exit $LASTEXITCODE } else { exit 1 }`
  const wrapped = psCommandEnvelope(inner)
  check('psCommandEnvelope has -Command prefix', wrapped.startsWith('powershell -NoProfile -NonInteractive -Command "& { iex ('), wrapped.slice(0, 60))
  check('psCommandEnvelope round-trips utf16le', decodeEnvelope(wrapped) === inner)
  check('psCommandEnvelope line is cmd/PS-safe (no % ! ^ $ chars)', !/[%!^$]/.test(wrapped), wrapped.slice(0, 60))
}

// --- buildExecScript --------------------------------------------------------
{
  const posix = buildExecScript({ family: 'posix', os: 'linux', shell: 'posix' }, 'echo hi', '/data/x')
  check('posix keeps cd && form', posix === `cd '/data/x' || exit 1\necho hi`, posix)
  const posixNoCwd = buildExecScript({ family: 'posix', os: 'linux', shell: 'posix' }, 'echo hi', undefined)
  check('posix without cwd is raw', posixNoCwd === 'echo hi')
  const unknown = buildExecScript({ family: 'unknown' }, 'echo hi', '/data/x')
  check('unknown family falls back to posix form', unknown === `cd '/data/x' || exit 1\necho hi`)
}

{
  const winPs = buildExecScript({ family: 'windows', os: 'windows', shell: 'powershell' }, 'Write-Output hi', '/X:/work/demo')
  check('win/powershell is raw script (not encoded)', !winPs.startsWith('powershell -NoProfile'))
  check('win/powershell Set-Location with stripped drive path', winPs.startsWith(`Set-Location -LiteralPath 'X:/work/demo'`), winPs)
  check('win/powershell carries the command', winPs.includes('Write-Output hi'))
  check('win/powershell ends with exit-code glue', winPs.trimEnd().endsWith('if ($?) { exit $LASTEXITCODE } else { exit 1 }'))
  const winPsNoCwd = buildExecScript({ family: 'windows', os: 'windows', shell: 'powershell' }, 'Write-Output hi', undefined)
  check('win/powershell without cwd has no Set-Location', !winPsNoCwd.includes('Set-Location'))
}

{
  const winCmd = buildExecScript({ family: 'windows', os: 'windows', shell: 'cmd' }, 'Write-Output hi', '/X:/work/demo')
  check('win/cmd is -Command envelope', winCmd.startsWith('powershell -NoProfile -NonInteractive -Command "& { iex ('), winCmd.slice(0, 60))
  const decoded = decodeEnvelope(winCmd)
  check('win/cmd script content survives encoding', decoded !== null && decoded.includes(`Set-Location -LiteralPath 'X:/work/demo'`) && decoded.includes('Write-Output hi'))
  check('win/cmd script ends with glue', decoded !== null && decoded.trimEnd().endsWith('if ($?) { exit $LASTEXITCODE } else { exit 1 }'))
}

// --- stripPsProgressClixml --------------------------------------------------
{
  const blob = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">\r\n<Obj S="progress" RefId="0">\r\n</Obj>\r\n</Objs>\r\n'
  const plain = "Get-Content : Cannot find path 'X:/NOPE.txt' because it does not exist.\r\n"
  const stripped = stripPsProgressClixml(blob + plain)
  check('strips full CLIXML blob, keeps plain error', stripped === plain, JSON.stringify(stripped))
  const partial = stripPsProgressClixml('#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">\r\n' + plain)
  check('strips unterminated partial CLIXML tail', partial === plain, JSON.stringify(partial))
  check('leaves non-CLIXML text untouched', stripPsProgressClixml(plain) === plain)
}

// --- remoteRgCommand --------------------------------------------------------
{
  const POSIX = { family: 'posix', os: 'linux', shell: 'posix' }
  const posixCmd = remoteRgCommand(POSIX, ['--json', '--regexp=x', '--glob=*.ts', '--', '/data/x'])
  check('rg command posix keeps shellQuote form', posixCmd === `'rg' '--json' '--regexp=x' '--glob=*.ts' '--' '/data/x'`, posixCmd)

  const WIN = { family: 'windows', os: 'windows', shell: 'powershell' }
  const winCmd = remoteRgCommand(WIN, ['--json', '--regexp=foo bar', '--glob=*.ts', '--', '/X:/work/demo'])
  check('rg command windows quotes every token + path separator', winCmd === `rg '--path-separator=/' '--json' '--regexp=foo bar' '--glob=*.ts' '--' 'X:/work/demo'`, winCmd)
  check('rg command windows strips drive prefix on the root', winCmd.includes(`'--' 'X:/work/demo'`), winCmd)
  check('rg command windows root "." stays "."', remoteRgCommand(WIN, ['--files', '--', '.']).endsWith(`'--' '.'`))
  const apostrophe = remoteRgCommand(WIN, ['--json', "--regexp=it's", '--', '/X:/w'])
  check('rg command windows escapes apostrophes', apostrophe.includes(`'--regexp=it''s'`), apostrophe)
}

// shellQuote still sane (regression guard)
check('shellQuote still quotes posix', shellQuote('/data/x') === `'/data/x'`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
