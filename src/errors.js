/**
 * A minimal error shape the backends throw, mirroring `@deepseek-ai/dsh-fs`
 * `FsError` (`name` + stable `code` + `message`). The `RoutingFileSystem`
 * wrapper re-wraps these into the real `FsError` when composed in the harness,
 * so the tool layer reads the same stable codes either way.
 */

export function fsError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = 'FsError'
  error.code = code
  return error
}
