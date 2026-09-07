/**
 * Pure unit tests for the Windows-remote compatibility layer: path
 * normalization, PowerShell quoting/encoding, and per-profile exec-script
 * building. No network — every case is a pure function.
 *
 * All paths are neutral fixtures (never a real host's drive layout).
 */
import { toWinPath, psQuote, psCommandEnvelope, buildExecScript, stripPsProgressClixml, crlfToLf, createCrlfToLf, shellQuote, probeRemoteProfile } from '../src/transport.js'
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
  let unknownThrew = false
  try {
    buildExecScript({ family: 'unknown' }, 'echo hi', '/data/x')
  } catch (e) {
    unknownThrew = /cannot determine the remote shell type/i.test(e.message)
  }
  check('unknown family throws instead of building a POSIX script', unknownThrew)
}

// --- probeRemoteProfile (cmd-aware detection chain, mocked client) ----------
{
  const runOf = (map) => async (cmd) => map[cmd] ?? { ok: false, exitCode: 1, stdout: '', stderr: '' }
  const probe = async (map) => probeRemoteProfile({ run: runOf(map) })

  const posix = await probe({ 'uname -s': { ok: true, stdout: 'Linux' } })
  check('probe posix linux', posix.family === 'posix' && posix.os === 'linux' && posix.shell === 'posix')
  const darwin = await probe({ 'uname -s': { ok: true, stdout: 'Darwin' } })
  check('probe posix darwin', darwin.family === 'posix' && darwin.os === 'darwin')
  const winCmd = await probe({ 'ver': { ok: true, stdout: 'Microsoft Windows [Version 10.0.20348]' } })
  check('probe windows/cmd via bare ver', winCmd.family === 'windows' && winCmd.shell === 'cmd', JSON.stringify(winCmd))
  const winPs = await probe({
    'ver': { ok: false, exitCode: 1 },
    'cmd /c "ver"': { ok: true, stdout: 'Microsoft Windows [Version 10.0.26200]' },
    '$PSVersionTable.PSVersion.ToString()': { ok: true, stdout: '5.1' },
  })
  check('probe windows/powershell via cmd /c "ver" + PSVersionTable', winPs.family === 'windows' && winPs.shell === 'powershell', JSON.stringify(winPs))
  const winPsNoCmd = await probe({ '$PSVersionTable.PSVersion.ToString()': { ok: true, stdout: '7.4' } })
  check('probe windows/powershell when cmd is absent', winPsNoCmd.family === 'windows' && winPsNoCmd.shell === 'powershell', JSON.stringify(winPsNoCmd))
  const unk = await probe({})
  check('probe unknown when every step fails', unk.family === 'unknown' && unk.shell === 'unknown')
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

// --- CRLF normalization -----------------------------------------------------
{
  check('crlfToLf folds CRLF pairs', crlfToLf('a\r\nb\r\n') === 'a\nb\n')
  check('crlfToLf leaves LF-only text', crlfToLf('a\nb') === 'a\nb')
  check('crlfToLf keeps a lone CR', crlfToLf('a\rX') === 'a\rX')

  const lf = createCrlfToLf()
  const first = lf.feed('a\r')
  const second = lf.feed('\nb')
  check('stream folds CRLF split across chunks', first + second === 'a\nb', JSON.stringify(first + second))
  check('stream empty tail chunk is a no-op', lf.feed('') === '')

  const lf2 = createCrlfToLf()
  const part1 = lf2.feed('x\r\ny')
  check('stream folds CRLF inside one chunk', part1 === 'x\ny', JSON.stringify(part1))
  const part2 = lf2.feed('end\r')
  check('stream holds a trailing CR for flush', part2 === 'end', JSON.stringify(part2))
  check('stream flush releases the trailing CR', lf2.flush() === '\r')
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
