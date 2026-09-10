/**
 * Local (offline) test for the profile-cache self-heal.
 *
 * When the remote host's default shell changes under a long-lived DSH process,
 * the cached profile goes stale and every command fails on the dialect. A
 * dialect-mismatch signature must clear that cache so the NEXT call re-probes —
 * no DSH restart, no manual invalidation.
 *
 * An in-process ssh2 server on 127.0.0.1 plays a Windows host that is first
 * PowerShell-default and then flips to cmd-default mid-run. The cmd mode rejects
 * a RAW PowerShell script exactly the way cmd.exe does ('Set-Location' is not
 * recognized) and accepts the cmd envelope, which is how the transport tells
 * the two apart.
 */
import ssh2 from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { SshClient } from '../src/transport.js'

const { Server } = ssh2

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

let mode = 'powershell' // the host's CURRENT default shell
let probeSteps = 0
let rawScripts = 0
let envelopes = 0

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        const stream = acceptExec()
        const cmd = String(info.command ?? '')
        const done = (code, out, err) => {
          if (out) stream.write(out)
          if (err) stream.stderr.write(err)
          stream.exit(code)
          stream.end()
        }

        // --- profile probe steps, answered for the CURRENT mode -------------
        if (cmd.startsWith('uname -s')) { probeSteps += 1; return done(1) }
        if (mode === 'powershell') {
          if (cmd.trim() === 'ver') { probeSteps += 1; return done(1) }
          if (cmd.includes('cmd /c "ver"')) { probeSteps += 1; return done(0, 'Microsoft Windows [Version 10.0.19045]\r\n') }
          if (cmd.includes('$PSVersionTable')) { probeSteps += 1; return done(0, '5.1.26100\r\n') }
        } else if (cmd.trim() === 'ver') {
          probeSteps += 1
          return done(0, 'Microsoft Windows [Version 10.0.19045]\r\n')
        }

        // --- the cmd envelope is accepted by BOTH modes ---------------------
        const b64 = /FromBase64String\('([^']+)'\)/.exec(cmd)
        if (b64 !== null) {
          envelopes += 1
          const inner = Buffer.from(b64[1], 'base64').toString('utf16le')
          if (inner.includes('BOOM')) return done(1, '', 'boom: ordinary failure\r\n')
          return done(0, '')
        }

        // --- raw script ------------------------------------------------------
        if (mode === 'powershell') {
          rawScripts += 1
          if (cmd.includes('BOOM')) return done(1, '', 'boom: ordinary failure\r\n')
          return done(0, '')
        }
        // cmd-default host fed a raw PowerShell script: reject like cmd.exe.
        if (/^\s*Set-Location\b/m.test(cmd)) {
          rawScripts += 1
          return done(1, '', "'Set-Location' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n")
        }
        return done(0, '')
      })
    })
  })
})

const port = await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const client = new SshClient({ host: '127.0.0.1', port, user: 'tester' })
const cwd = '/C:/Windows/Temp'
const run = () => client.execShell('echo hi', { cwd, timeoutMs: 8000 })

// --- 1. PowerShell-default host: raw script works, profile cached -----------
const first = await run()
check('a PowerShell-default host runs the raw script', first.ok && first.exitCode === 0, JSON.stringify({ ok: first.ok, exit: first.exitCode }))
check('the probe ran before the first command', probeSteps >= 3, `probeSteps=${probeSteps}`)
const probeAfterFirst = probeSteps

// --- 2. an ordinary failure must NOT invalidate ----------------------------
const boom = await client.execShell('echo BOOM', { cwd, timeoutMs: 8000 })
check('an ordinary command failure stays a failure', boom.exitCode === 1, JSON.stringify({ exit: boom.exitCode, stderr: boom.stderr.text.trim() }))
const stillRaw = await run()
check('an ordinary failure does NOT invalidate the cached profile', probeSteps === probeAfterFirst && stillRaw.exitCode === 0 && envelopes === 0, `probeSteps=${probeSteps} envelopes=${envelopes}`)

// --- 3. the host flips to cmd under the cache ------------------------------
mode = 'cmd'
const rawBefore = rawScripts
const stale = await run()
check('the stale dialect fails (host flipped under the cache)', stale.exitCode === 1 && /not recognized/.test(stale.stderr.text), JSON.stringify({ exit: stale.exitCode, stderr: stale.stderr.text.trim().slice(0, 80) }))
check('the stale attempt really sent the raw script', rawScripts === rawBefore + 1, `rawScripts=${rawScripts}`)

// --- 4. the next call self-heals: re-probe, then the new dialect -----------
const healed = await run()
check('the next call re-probes the host', probeSteps > probeAfterFirst, `probeSteps=${probeSteps}`)
check('the healed call succeeds with the NEW dialect (cmd envelope)', healed.ok && healed.exitCode === 0 && envelopes === 1, JSON.stringify({ ok: healed.ok, exit: healed.exitCode, envelopes }))
const healedAgain = await run()
check('the healed profile is cached (no further probe)', probeSteps === probeAfterFirst + 2 && healedAgain.exitCode === 0 && envelopes === 2, `probeSteps=${probeSteps} envelopes=${envelopes}`)

server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
