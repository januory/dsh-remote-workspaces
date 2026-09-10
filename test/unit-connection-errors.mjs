/**
 * Local (offline) test for channel-open failure messages: the audience (agent =
 * English, user = Chinese), the target, and the STAGE the open died at.
 *
 * No remote host is needed. Two failures are reproduced on loopback:
 *   - a closed port                                  -> stage 'connect'   (TCP refused)
 *   - a listener that accepts TCP but never speaks SSH -> stage 'handshake' (ready timeout)
 *
 * This is the diagnostic that was missing when a killed sshd listener surfaced
 * as a bare "SFTP 连接超时" and failed a whole turn.
 */
import { createServer } from 'node:net'
import { SshClient } from '../src/transport.js'
import { SftpBackend } from '../src/fs-sftp.js'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

async function rejection(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

/** A port that is free right now (bound, then released). */
async function closedPort() {
  const probe = createServer()
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)))
  await new Promise((resolve) => probe.close(() => resolve()))
  return port
}

// --- 1. refused TCP connect: stage 'connect' --------------------------------
{
  const client = new SshClient({ host: '127.0.0.1', port: await closedPort(), user: 'tester', readyTimeoutMs: 3000 })
  const en = await rejection(() => client.sftp({ agentFacing: true }))
  check('agent-facing SFTP failure is English with target + stage', /^SFTP connection failed \(target: tester@127\.0\.0\.1:\d+, stage: connect\)/.test(String(en?.message)), String(en?.message))
  check('the refused-connect cause is preserved', /ECONNREFUSED/i.test(String(en?.message)), String(en?.message))
  // The harness's project-root marker walk rethrows anything that is not
  // FS_NOT_FOUND, which used to abort the whole turn on an unreachable remote.
  check('the channel-open failure is tagged FS_NOT_FOUND for provider probes', en?.code === 'FS_NOT_FOUND', String(en?.code))
  check('the original error is kept as the cause', en?.cause !== undefined, String(en?.cause))
  const zh = await rejection(() => client.sftp())
  check('user-facing SFTP failure stays Chinese with target + stage', /^SFTP 连接失败（目标：tester@127\.0\.0\.1:\d+，阶段：连接）/.test(String(zh?.message)), String(zh?.message))
}

// --- 2. TCP accepted but no SSH banner: stage 'handshake' -------------------
{
  const silent = createServer(() => { /* accept and stay silent */ })
  const port = await new Promise((resolve) => silent.listen(0, '127.0.0.1', () => resolve(silent.address().port)))
  const client = new SshClient({ host: '127.0.0.1', port, user: 'tester', readyTimeoutMs: 600 })
  const started = Date.now()
  const en = await rejection(() => client.sftp({ agentFacing: true }))
  const elapsed = Date.now() - started
  check('a stalled handshake reports stage handshake (agent, English)', /^SFTP connection timed out \(target: tester@127\.0\.0\.1:\d+, stage: handshake\)$/.test(String(en?.message)), String(en?.message))
  check('the handshake failure is the ready timeout, not a hang', elapsed >= 500 && elapsed < 3000, `elapsed=${elapsed}ms`)
  const zh = await rejection(() => client.sftp())
  check('the same failure stays Chinese for the user', /^SFTP 连接超时（目标：tester@127\.0\.0\.1:\d+，阶段：握手）$/.test(String(zh?.message)), String(zh?.message))
  silent.close()
}

// --- 3. the interactive shell keeps the user-facing Chinese + context -------
{
  const client = new SshClient({ host: '127.0.0.1', port: await closedPort(), user: 'tester', readyTimeoutMs: 3000 })
  const err = await rejection(() => client.openShell())
  check('the Shell tab error is Chinese with target + stage', /^SSH shell 连接失败（目标：tester@127\.0\.0\.1:\d+，阶段：连接）/.test(String(err?.message)), String(err?.message))
}

// --- 4. the agent-backed file backend asks for the English wording ----------
{
  let seen
  const fake = {
    host: 'test-host',
    sftp: async (opts) => { seen = opts; return { alive: true, readdir: async () => [] } },
  }
  const backend = new SftpBackend(fake)
  await backend.sftp()
  check('SftpBackend requests the agent-facing (English) message', seen?.agentFacing === true, JSON.stringify(seen))
}

// --- 5. the exec path tags the target for the agent only --------------------
{
  const client = new SshClient({ host: '127.0.0.1', port: await closedPort(), user: 'tester' })
  const en = await client.run('echo ok', { agentFacing: true, timeoutMs: 4000 })
  check('agent-facing exec failure carries the target', /\(target: tester@127\.0\.0\.1:\d+\)$/.test(String(en.error)), String(en.error))
  const zh = await client.run('echo ok', { timeoutMs: 4000 })
  check('user-facing exec failure stays Chinese and untagged', /连接被拒绝|连接超时/.test(String(zh.error)) && !/\(target:/.test(String(zh.error)), String(zh.error))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
