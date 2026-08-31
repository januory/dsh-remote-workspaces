import { homedir } from 'node:os'

/**
 * Expand a leading `~` against the home directory (OpenSSH `~` expansion).
 */
export function expandTilde(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return home + value.slice(1)
  return value
}

/**
 * Parse an OpenSSH client config file into host blocks.
 *
 * Handles the subset SSH remote workspaces needs: `Host` (first alias),
 * `HostName`, `User`, `Port`, `IdentityFile`, plus a passthrough options list
 * for everything else. Wildcard/pattern hosts and `Include` are intentionally
 * out of scope for the P0 prototype.
 *
 * @param {string} text - raw `~/.ssh/config` content.
 * @param {string} [home] - home directory used for `~` expansion.
 * @returns {Array<{alias:string, host:string|null, user:string|null, port:number|null, identityFile:string|null, options:Array<{key:string,value:string}>}>}
 */
export function parseSshConfig(text, home = homedir()) {
  const hosts = []
  let current = null
  const flush = () => {
    if (current !== null && current.alias) hosts.push(current)
    current = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      flush()
      const alias = value.split(/\s+/)[0]
      current = { alias, host: null, user: null, port: null, identityFile: null, options: [] }
    } else if (current !== null) {
      if (key === 'hostname') current.host = value
      else if (key === 'user') current.user = value
      else if (key === 'port') current.port = Number.parseInt(value, 10)
      else if (key === 'identityfile') current.identityFile = expandTilde(value, home)
      else current.options.push({ key, value })
    }
  }
  flush()
  return hosts
}
