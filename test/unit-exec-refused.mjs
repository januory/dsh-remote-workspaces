/**
 * Local (offline) test for a remote-REFUSED exec request — sshd answering the
 * SSH exec request with CHANNEL_FAILURE, which ssh2 flattens into its bare
 * `Error('Unable to exec')` (`reqExec` in ssh2's client.js: it is emitted ONLY
 * for `had_err === true`, i.e. a real CHANNEL_FAILURE reply).
 *
 * Reproduced on real hardware (Windows OpenSSH 8.1, 2026-09-10) before this test
 * was written: the refusal is deterministic FOR A GIVEN PAYLOAD — two payloads
 * of identical length differing by ONE base64 character were consistently
 * refused / consistently accepted, five wrappers around the SAME script split
 * 2 accept / 3 refuse, and re-running the same command produced the same payload
 * and failed 5/5. A 6828-byte payload was accepted, so length is not the rule.
 * The command never runs (the request is refused before `do_exec` spawns), so a
 * retry is safe — but it must carry different bytes.
 *
 * A REAL ssh2 client talks to an IN-PROCESS ssh2 server bound to 127.0.0.1 —
 * no external host, no sshd, no credentials — and the server answers
 * `rejectExec()` for the requests under test.
 */
import ssh2 from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { SshClient, isExecRequestRefused, retryVariantOf } from '../src/transport.js'

const { Server } = ssh2

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/**
 * A fake Windows SSH host. `shell` selects the dialect the profile probe must
 * detect ('powershell' = raw script payloads, 'cmd' = base64 envelope
 * payloads). `refuseExec(command, attempt)` answers CHANNEL_FAILURE instead of
 * running the command; `seen` records every payload that reached the server.
 */
function fakeHost({ shell, refuseExec = () => false }) {
  const seen = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, rejectExec, info) => {
          const cmd = String(info.command ?? '')
          const reply = (code, text) => {
            const stream = acceptExec()
            if (text) stream.write(text)
            stream.exit(code)
            stream.end()
          }
          // --- the profile probe, never refused and never counted as a command
          if (cmd.startsWith('uname -s')) return reply(1)
          if (cmd.trim() === 'ver') return shell === 'cmd' ? reply(0, 'Microsoft Windows [Version 10.0.19045]\r\n') : reply(1)
          if (cmd.includes('cmd /c "ver"')) return reply(0, 'Microsoft Windows [Version 10.0.19045]\r\n')
          if (cmd.includes('$PSVersionTable')) return reply(0, '5.1.26100\r\n')
          // --- a real command
          seen.push(cmd)
          if (refuseExec(cmd, seen.length)) { rejectExec(); return }
          reply(0, 'DWSH_PID=4242\r\nok\r\n')
        })
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => { try { server.close() } catch {} },
      })
    })
  })
}

const clientFor = (port) => new SshClient({ host: '127.0.0.1', port, user: 'tester' })

const ENVELOPE_PREFIX = 'powershell -NoProfile -NonInteractive -Command "& { iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(\''

/** The script inside the plugin's cmd envelope (base64 UTF-16LE). */
function decodeEnvelope(payload) {
  const match = /FromBase64String\('([^']+)'\)/.exec(payload)
  return match === null ? '' : Buffer.from(match[1], 'base64').toString('utf16le')
}

/** The payload's statements, ignoring the blank lines the retry adds. */
function compact(text) {
  return text.split('\n').filter((line) => line !== '').join('\n')
}

// --- 1. the refusal is recognised, and the retry payload really differs ------
{
  check('the ssh2 fallback for a refused exec request is recognised', isExecRequestRefused(new Error('Unable to exec')))
  check('an already-annotated message is not mistaken for the raw one', !isExecRequestRefused(new Error('Unable to exec (target: a@b:22)')))
  check('an unrelated exec error is not mistaken for a refusal', !isExecRequestRefused(new Error('Channel is not open')))
  check('the first attempt keeps the payload untouched', retryVariantOf('echo hi', 0) === 'echo hi')
  check(
    'a retry pads the payload with blank lines only',
    retryVariantOf('echo hi', 1) === '\necho hi\n',
    JSON.stringify(retryVariantOf('echo hi', 1)),
  )
  check('each retry is a different payload', retryVariantOf('echo hi', 1) !== retryVariantOf('echo hi', 2))
}

// --- 2. PowerShell-default host: one refusal, then a byte-varied retry -------
{
  const host = await fakeHost({ shell: 'powershell', refuseExec: (_cmd, n) => n === 1 })
  const client = clientFor(host.port)
  const result = await client.execShell('echo hi', { timeoutMs: 8000 })
  check(
    'a refused exec request is retried with a varied payload and succeeds',
    result.ok === true && result.exitCode === 0 && String(result.stdout?.text ?? '').includes('ok'),
    JSON.stringify({ ok: result.ok, exit: result.exitCode, err: result.error }),
  )
  check('the retry sent exactly two exec requests', host.seen.length === 2, `seen=${host.seen.length}`)
  check(
    'the second payload only adds blank lines to the same command',
    host.seen.length === 2
      && host.seen[1] !== host.seen[0]
      && host.seen[1].length > host.seen[0].length
      && compact(host.seen[1]) === compact(host.seen[0])
      && host.seen[1].includes('echo hi'),
    JSON.stringify(host.seen.map((c) => c.slice(0, 30))),
  )
  check(
    'the PID marker is still stripped on the retried attempt',
    !String(result.stdout?.text ?? '').includes('DWSH_PID'),
    JSON.stringify(result.stdout?.text),
  )
  host.close()
}

// --- 3. a permanently refused request fails bounded, with target + stage -----
{
  const host = await fakeHost({ shell: 'powershell', refuseExec: () => true })
  const client = clientFor(host.port)
  const result = await client.execShell('echo hi', { timeoutMs: 8000 })
  const error = String(result.error)
  check(
    'a permanently refused exec request fails after the bounded retries',
    result.ok === false && host.seen.length === 3,
    `ok=${result.ok} seen=${host.seen.length}`,
  )
  check(
    'the failure carries the target and stage: exec',
    /target: tester@127\.0\.0\.1:\d+/.test(error) && /stage: exec/.test(error),
    error,
  )
  check(
    'the failure reports the attempt count and payload size',
    /attempts: 3/.test(error) && /payload: \d+ bytes/.test(error),
    error,
  )
  check('the failure no longer reads as a bare "Unable to exec"', !/^Unable to exec/.test(error), error)
  check('every attempt sent a different payload', new Set(host.seen).size === 3, `unique=${new Set(host.seen).size}`)
  host.close()
}

// --- 4. cmd-default host: the retried payload is a re-encoded envelope -------
{
  const host = await fakeHost({ shell: 'cmd', refuseExec: (_cmd, n) => n === 1 })
  const client = clientFor(host.port)
  const result = await client.execShell('echo hi', { timeoutMs: 8000 })
  check('a cmd-default host retries and succeeds', result.ok === true && result.exitCode === 0, JSON.stringify({ ok: result.ok, err: result.error }))
  check(
    'both attempts sent the quote-safe base64 envelope',
    host.seen.length === 2 && host.seen.every((c) => c.startsWith(ENVELOPE_PREFIX)),
    JSON.stringify(host.seen.map((c) => c.slice(0, 40))),
  )
  check(
    'the retry re-encoded the SCRIPT instead of wrapping the envelope itself',
    decodeEnvelope(host.seen[1]).includes('echo hi')
      && compact(decodeEnvelope(host.seen[1])) === compact(decodeEnvelope(host.seen[0]))
      && decodeEnvelope(host.seen[1]).length > decodeEnvelope(host.seen[0]).length,
    JSON.stringify(decodeEnvelope(host.seen[1]).slice(0, 40)),
  )
  check('the two envelope payloads differ for the same command', host.seen[0] !== host.seen[1])
  host.close()
}

// --- 5. run() renders the refusal per audience -------------------------------
{
  const host = await fakeHost({ shell: 'powershell', refuseExec: () => true })
  const client = clientFor(host.port)
  const zh = await client.run('echo hi', { timeoutMs: 8000 })
  check(
    'run() reports the user-facing Chinese exec refusal with target + stage',
    /目标：tester@127\.0\.0\.1:\d+/.test(String(zh.error)) && /阶段：执行请求/.test(String(zh.error)),
    String(zh.error),
  )
  const en = await client.run('echo hi', { agentFacing: true, timeoutMs: 8000 })
  check(
    'run() reports the agent-facing English exec refusal with target + stage',
    /target: tester@127\.0\.0\.1:\d+/.test(String(en.error)) && /stage: exec/.test(String(en.error)),
    String(en.error),
  )
  host.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
