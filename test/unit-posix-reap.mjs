/**
 * Local (offline) test for POSIX process-TREE reaping: the unit-level half of
 * the fix for "job_kill / timeout leaves the real command running on a Linux
 * remote".
 *
 * Why the tree has to be reaped at all (measured on a real Linux host):
 * `remoteStart` used to launch `nohup sh -c '<cmd>' … &` and record `$!`, but
 * `sh` FORKS for a simple command instead of exec'ing it, so `$!` was the dash
 * wrapper — killing it reparented the real command to init, where it kept
 * running (closing the exec channel does not HUP it: no controlling terminal,
 * no session teardown). The launcher now runs the command under `setsid`, so
 * the recorded pid leads a session/process GROUP of its own and a NEGATIVE-pid
 * kill reaches the whole tree. The same marker + negative-pid reap covers a
 * timed-out foreground `execShell`, where the orphaned command was observed
 * still running after the tool had already reported `timed out`.
 *
 * A REAL ssh2 client talks to an IN-PROCESS ssh2 server bound to 127.0.0.1 —
 * no external host, no sshd, no credentials. The server answers the profile
 * probe the way a Linux remote does and RECORDS the exact scripts it receives,
 * which is the property under test: the launcher detaches the job into its own
 * group, and both the background kill and the foreground timeout reap that
 * group rather than a single wrapper pid. (That the group kill really removes
 * the descendants is verified on real hardware — a fake host cannot fork.)
 */
import ssh2 from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { SshClient, pidMarkerCommand, reapPidCommand } from '../src/transport.js'

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

// --- the pure helpers: what a dialect is told to report and to reap ---------
check('POSIX marker asks the shell for its own pid', pidMarkerCommand('pwd', 'posix') === 'echo DWSH_PID=$$\npwd', JSON.stringify(pidMarkerCommand('pwd', 'posix')))
check('Windows marker keeps the PowerShell form', pidMarkerCommand('pwd', 'windows') === "Write-Output ('DWSH_PID=' + $PID)\npwd", JSON.stringify(pidMarkerCommand('pwd', 'windows')))
check('POSIX reap kills the process GROUP, with a single-pid fallback', reapPidCommand(4242, 'posix') === 'kill -TERM -4242 2>/dev/null || kill -TERM 4242 2>/dev/null || true', reapPidCommand(4242, 'posix'))
check('Windows reap still tree-kills by pid', reapPidCommand(4242, 'windows') === 'taskkill /PID 4242 /T /F', reapPidCommand(4242, 'windows'))

// --- in-process fake POSIX SSH host -----------------------------------------
const JOB_PID = 4242
const SHELL_PID = 5150
let accepted = 0
let launchScript = ''
let groupKillCommand = ''
let shellKillCommand = ''
let markerScript = ''
let jobAlive = true
const heldStreams = []

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  accepted += 1
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
        // Profile probe: a Linux remote answers `uname -s`.
        if (cmd.startsWith('uname -s')) return done(0, 'Linux\n')
        // A held foreground command: reports its group leader, then hangs.
        if (cmd.includes('SHELL_HOLD')) {
          stream.write(`DWSH_PID=${SHELL_PID}\n`)
          heldStreams.push(stream)
          return
        }
        // The reaper of a foreground command's group.
        if (cmd.includes(`kill -TERM -${SHELL_PID}`)) { shellKillCommand = cmd; return done(0) }
        // The reaper of a background job's group, and that job's liveness poll.
        if (cmd.includes(`kill -TERM -${JOB_PID}`)) { groupKillCommand = cmd; jobAlive = false; return done(0) }
        if (cmd.includes('kill -0')) return done(0, jobAlive ? 'yes\n' : 'no\n')
        // The POSIX background launcher; it prints the detached pid like `$!`.
        if (cmd.includes('setsid')) { launchScript = cmd; return done(0, `${JOB_PID}\n`) }
        if (cmd.includes('tail -c')) return done(0, 'JOB-OUT\n')
        // A normal foreground command: the shell's own `echo DWSH_PID=$`
        // produces the marker line ahead of the command's output.
        if (cmd.includes('echo DWSH_PID=$')) { markerScript = cmd; return done(0, `DWSH_PID=${SHELL_PID}\nhi\n`) }
        return done(0, 'ok\n')
      })
    })
  })
})

const port = await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const client = new SshClient({ host: '127.0.0.1', port, user: 'tester' })
const profile = await client.profile()
check('the fake host probes as a POSIX remote', profile.family === 'posix', JSON.stringify(profile))

// --- 1. the background launcher detaches the job into its own group ---------
{
  const { SshShellExecutor } = await import('../src/shell-exec.js')
  const ex = new SshShellExecutor({
    clientForRemote: () => client,
    getPolicy: () => undefined,
    getSandbox: () => undefined,
    getSubprocess: () => undefined,
  })
  const proc = ex.start({ command: 'sleep 300', workdir: 'ssh://root@10.0.0.7:22/data/x', timeoutMs: 1000 })
  const launched = await waitFor(() => launchScript !== '')
  check('the POSIX launcher reached the remote', launched, launchScript.split('\n')[0])
  check('the launcher runs the command under setsid (own session + process group)', /(^|\n)setsid sh -c 'sleep 300' /.test(launchScript), JSON.stringify(launchScript))
  check('the launcher keeps a nohup fallback for hosts without setsid', launchScript.includes('command -v setsid') && launchScript.includes('nohup sh -c'), JSON.stringify(launchScript.split('\n').slice(0, 6)))
  check('the launcher still reports the pid it recorded', launchScript.trim().endsWith('echo $!'), JSON.stringify(launchScript.trim().split('\n').slice(-1)[0]))
  check('the job is detached from the exec channel stdin', launchScript.includes('</dev/null'), JSON.stringify(launchScript))
  check('the launcher still redirects the job log', /2>&1/.test(launchScript) && launchScript.includes('.dsh-bg-'), JSON.stringify(launchScript))
  check('the bare nohup-and-background launcher is gone', !/nohup sh -c [^\n]*&\necho \$!/.test(launchScript), JSON.stringify(launchScript))

  // --- 2. kill() reaps the GROUP of the recorded pid ------------------------
  const killed = proc.kill()
  check('kill() reports the job as killed', killed === true)
  const reaped = await waitFor(() => groupKillCommand !== '')
  check('kill() sends the negative-pid (group) kill for the recorded pid', reaped && groupKillCommand.includes(`kill -TERM -${JOB_PID}`), JSON.stringify(groupKillCommand))
  check('the group kill keeps the single-pid fallback', groupKillCommand.includes(`kill -TERM ${JOB_PID}`), JSON.stringify(groupKillCommand))
  check('the job ends as killed once the group is reaped', await waitFor(() => proc.status === 'killed'), proc.status)
}

// --- 3. a foreground command self-reports its group leader ------------------
{
  const before = accepted
  const ok = await client.execShell('echo hi', { cwd: '/tmp', timeoutMs: 10000 })
  check('a POSIX foreground command still succeeds', ok.ok && ok.exitCode === 0, JSON.stringify({ ok: ok.ok, exit: ok.exitCode }))
  check('execShell prefixes the POSIX pid marker', markerScript.includes('echo DWSH_PID=$$'), JSON.stringify(markerScript.split('\n')[1]))
  check('the cwd glue still lands the command in its directory', markerScript.includes("cd '/tmp' || exit 1"), JSON.stringify(markerScript.split('\n')[0]))
  check('the marker is stripped from the caller-visible stdout', ok.stdout.text === 'hi\n' && !ok.stdout.text.includes('DWSH_PID'), JSON.stringify(ok.stdout.text))
  check('the failed/killed paths added no connection', accepted === before, `accepted=${accepted}`)
}

// --- 4. a timed-out foreground command is reaped by GROUP -------------------
{
  const timed = await client.execShell('echo SHELL_HOLD', { cwd: '/tmp', timeoutMs: 700 })
  check('a POSIX foreground timeout is still reported as timedOut', timed.ok === true && timed.timedOut === true, JSON.stringify({ ok: timed.ok, timedOut: timed.timedOut, exit: timed.exitCode }))
  const reaped = await waitFor(() => shellKillCommand !== '')
  check('the timeout reaps the group of the self-reported shell pid', reaped && shellKillCommand.includes(`kill -TERM -${SHELL_PID}`), JSON.stringify(shellKillCommand))
  const after = await client.execShell('echo after', { cwd: '/tmp', timeoutMs: 10000 })
  check('the pooled connection survives the timeout reap', after.ok && after.exitCode === 0, JSON.stringify({ ok: after.ok, exit: after.exitCode }))
}

for (const s of heldStreams) { try { s.close() } catch {} }
server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
