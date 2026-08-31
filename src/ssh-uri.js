/**
 * Parse an `ssh://[user@]host[:port]/abs/path` session cwd into its parts.
 * Returns null when the value is not a remote workspace URI.
 */
export function parseSshUri(uri) {
  const match = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?(\/.*)$/.exec(String(uri))
  if (match === null) return null
  return {
    user: match[1] || undefined,
    host: match[2],
    port: match[3] ? Number(match[3]) : undefined,
    path: match[4],
  }
}

/** True when a session cwd denotes a remote workspace. */
export function isRemoteCwd(cwd) {
  return typeof cwd === 'string' && cwd.startsWith('ssh://')
}
