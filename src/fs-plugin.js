/**
 * The `ctx.fs` mount entry (`remote-workspaces/fs`).
 *
 * Provides `ctx.sshClient` (transport) and replaces `ctx.fs` with the
 * self-contained `RoutingFileSystem`, which routes `ssh://…` cwds to the SFTP
 * backend and everything else to the local backend. No harness imports — it
 * resolves from the bundle checkout alone.
 */

import { SshClient } from './transport.js'
import { RoutingFileSystem } from './routing-fs.js'

export const name = 'ssh-remote-fs'

export function apply(ctx) {
  ctx.provide('sshClient', new SshClient())
  ctx.provide('fs', new RoutingFileSystem())
}

export default apply
