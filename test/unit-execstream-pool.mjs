/**
 * Local (offline) test for the exec connection pool shared by `run()`,
 * `execShell()` and `execStream()`.
 *
 * A REAL ssh2 client talks to an IN-PROCESS ssh2 server bound to 127.0.0.1 —
 * no external host, no sshd, no credentials. The server counts the connections
 * it accepts, which is exactly the property under test: N parallel background
 * jobs (execStream) must multiplex over at most `EXEC_POOL_MAX_CONNS`
 * connections instead of opening one SSH session each, and terminating one job
 * must not tear down the connection its siblings are using.
 *
 * The fake host answers the profile probe the way a PowerShell-default Windows
 * remote does, so the Windows-only PID-marker/taskkill path is exercised too.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, timeoutMs = 4000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

// --- in-process fake SSH host ------------------------------------------------
let accepted = 0
let live = 0
let maxLive = 0
let taskkillSeen = 0
const heldStreams = []

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  accepted += 1
  live += 1
  maxLive = Math.max(maxLive, live)
  let gone = false
  const onGone = () => { if (!gone) { gone = true; live -= 1 } }
  client.on('close', onGone)
  client.on('end', onGone)
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        const stream = acceptExec()
        const cmd = String(info.command ?? '')
        const done = (code, text) => {
          if (text) stream.write(text)
          stream.exit(code)
          stream.end()
        }
        // Profile probe: uname/ver fail, the nested cmd probe proves Windows,
        // $PSVersionTable picks PowerShell as the default shell.
        if (cmd.startsWith('uname -s')) return done(1)
        if (cmd.trim() === 'ver') return done(1)
        if (cmd.includes('cmd /c "ver"')) return done(0, 'Microsoft Windows [Version 10.0.19045]\r\n')
        if (cmd.includes('$PSVersionTable')) return done(0, '5.1.26100\r\n')
        if (cmd.includes('taskkill')) { taskkillSeen += 1; return done(0) }
        if (cmd.includes('DWSH_PID')) {
          // The PID marker is the FIRST line, exactly like the real script.
          stream.write('DWSH_PID=4242\r\n')
          if (cmd.includes('CAUSE_DROP')) {
            // Drop the whole connection without a DISCONNECT packet.
            setTimeout(() => { try { client.end() } catch {} }, 20)
            return
          }
          if (cmd.includes('SHELL_HOLD')) { stream.write('held-shell\r\n'); heldStreams.push(stream); return }
          const hold = /HOLD_OPEN-(\w+)/.exec(cmd)
          if (hold !== null) {
            stream.write(`held-${hold[1]}\r\n`)
            heldStreams.push(stream)
            return
          }
          const job = /JOB-(\w+)/.exec(cmd)
          return done(0, `out-${job === null ? 'x' : job[1]}\r\n`)
        }
        return done(0, 'ok\r\n')
      })
    })
  })
})

const port = await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const client = new SshClient({ host: '127.0.0.1', port, user: 'tester' })

// --- 1. probe is pooled ------------------------------------------------------
const profile = await client.profile()
check('probe resolves the fake Windows host', profile.family === 'windows' && profile.shell === 'powershell', JSON.stringify(profile))
check('the profile probe used exactly one connection', accepted === 1 && live === 1, `accepted=${accepted} live=${live}`)

// --- 2. a dropped connection is evicted --------------------------------------
const dropped = await client.execStream('echo CAUSE_DROP')
const droppedExit = await dropped.exit
check('a dropped connection surfaces an error to the job', typeof droppedExit.error === 'string' && droppedExit.error.length > 0, JSON.stringify(droppedExit))
check('the dropped connection is evicted from the pool', await waitFor(() => live === 0), `live=${live}`)

// --- 3. the next job reconnects ---------------------------------------------
const reconnected = await client.execStream('echo JOB-reconnect')
const reconnectedExit = await reconnected.exit
check('the next background job reconnects and succeeds', reconnectedExit.exitCode === 0, JSON.stringify(reconnectedExit))
check('the reconnect opened exactly one fresh connection', accepted === 2 && live === 1, `accepted=${accepted} live=${live}`)

// --- 4. short-lived ops reuse the pooled connection --------------------------
const shells = await Promise.all(Array.from({ length: 6 }, () => client.execShell('echo ok', { timeoutMs: 10000 })))
check('6 parallel execShell calls all succeed', shells.every((r) => r.ok && r.exitCode === 0), JSON.stringify(shells.map((r) => r.exitCode)))
check('6 parallel execShell calls stay within the pool cap', accepted <= 3, `accepted=${accepted}`)
check('the Windows PID marker is stripped from execShell stdout', shells.every((r) => !String(r.stdout?.text ?? '').includes('DWSH_PID')), JSON.stringify(shells.map((r) => r.stdout?.text)))

// --- 5. background jobs multiplex over the pool ------------------------------
const jobs = await Promise.all(Array.from({ length: 6 }, (_, i) => client.execStream(`echo JOB-${i}`)))
const jobExits = await Promise.all(jobs.map((ctl) => ctl.exit))
const jobOut = jobs.map((ctl) => ctl.readOut().delta)
check('6 parallel background jobs all finish with exit 0', jobExits.every((e) => e.exitCode === 0), JSON.stringify(jobExits))
check('each job sees only its own output (marker stripped)', jobOut.every((text, i) => text.includes(`out-${i}`) && !text.includes('DWSH_PID')), JSON.stringify(jobOut))
check('background jobs stay within the pool cap', maxLive <= 3, `maxLive=${maxLive}`)
check('6 background jobs did not open one connection each', accepted <= 4, `accepted=${accepted}`)

const acceptedAfterBatch1 = accepted
const batch2 = await Promise.all(Array.from({ length: 6 }, (_, i) => client.execStream(`echo JOB-b${i}`)))
const batch2Exits = await Promise.all(batch2.map((ctl) => ctl.exit))
check('a second background batch succeeds too', batch2Exits.every((e) => e.exitCode === 0), JSON.stringify(batch2Exits))
check('a second background batch adds no connection at all', accepted === acceptedAfterBatch1, `before=${acceptedAfterBatch1} after=${accepted}`)

// --- 6. terminate() must not tear down the shared connection -----------------
const heldJob = await client.execStream('echo HOLD_OPEN-A')
let heldDelta = ''
const sawHeld = await waitFor(() => { heldDelta += heldJob.readOut().delta; return heldDelta.includes('held-A') })
check('held job starts and reports output (PID marker parsed)', sawHeld, heldDelta.trim())

const acceptedBeforeKill = accepted
const liveBeforeKill = live
const sibling = await client.execStream('echo JOB-sib')
const siblingExit = await sibling.exit
check('a sibling job on the same connection still completes', siblingExit.exitCode === 0, JSON.stringify(siblingExit))

heldJob.terminate()
const heldExit = await heldJob.exit
check('terminate() settles the terminated job', heldExit.exitCode === null, JSON.stringify(heldExit))
check('terminate() reaps the remote tree via taskkill /PID', await waitFor(() => taskkillSeen > 0), `taskkillSeen=${taskkillSeen}`)
check('terminate() kept the shared connection alive', accepted === acceptedBeforeKill && live === liveBeforeKill, `accepted=${accepted} live=${live}`)

const afterTerminate = await client.execStream('echo JOB-after')
const afterTerminateExit = await afterTerminate.exit
check('a later job still works on that connection', afterTerminateExit.exitCode === 0, JSON.stringify(afterTerminateExit))
check('that later job needed no new connection', accepted === acceptedBeforeKill, `accepted=${accepted}`)

// --- 7. the agent/user error-audience split is real -------------------------
{
  const { createServer } = await import('node:net')
  const deadPort = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  const offline = new SshClient({ host: '127.0.0.1', port: deadPort, user: 'tester' })
  const en = await offline.run('echo ok', { agentFacing: true, timeoutMs: 4000 })
  const zh = await offline.run('echo ok', { timeoutMs: 4000 })
  check('agentFacing: true yields the unified ENGLISH connect failure with stage', /^SSH connection failed \(target: tester@127\.0\.0\.1:\d+, stage: connect\): .*ECONNREFUSED/.test(String(en.error)), String(en.error))
  check('the default (USER-facing) error stays Chinese with target + stage', /^SSH 连接失败（目标：tester@127\.0\.0\.1:\d+，阶段：连接）/.test(String(zh.error)), String(zh.error))
}

// --- 8. a timed-out foreground command is reaped by PID ---------------------
{
  const before = taskkillSeen
  const timed = await client.execShell('echo SHELL_HOLD', { cwd: '/C:/Windows/Temp', timeoutMs: 700 })
  check('a foreground timeout is reported as timedOut', timed.ok === true && timed.timedOut === true, JSON.stringify({ ok: timed.ok, timedOut: timed.timedOut, exit: timed.exitCode }))
  check('the timeout taskkills the remote tree by the self-reported PID', await waitFor(() => taskkillSeen > before), `taskkillSeen=${taskkillSeen}`)
  const afterTimeout = await client.execShell('echo JOB-after-timeout', { cwd: '/C:/Windows/Temp', timeoutMs: 10000 })
  check('the pooled connection survives that timeout', afterTimeout.ok && afterTimeout.exitCode === 0, JSON.stringify({ ok: afterTimeout.ok, exit: afterTimeout.exitCode }))
}

for (const s of heldStreams) { try { s.close() } catch {} }
server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
