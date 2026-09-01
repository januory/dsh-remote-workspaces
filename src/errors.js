/**
 * A minimal error shape the backends throw, mirroring `@deepseek-ai/dsh-fs`
 * `FsError` (`name` + stable `code` + `message`). It is a PLAIN `Error`, not an
 * instance of the harness's `FsError`/`HarnessError` (the plugin cannot import
 * `@deepseek-ai/*` packages without dual-packaging the Cordis context), so the
 * tool layer's `instanceof FsError` enrichments (the `[sandbox: …]` marker, the
 * escalation hint, the stale-version remedy) do not apply — a denial surfaces
 * as the plain error message. Consumers that read `.code` structurally still
 * get the stable code.
 */

export function fsError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = 'FsError'
  error.code = code
  return error
}
