/**
 * Byte-window normalization shared by both filesystem backends.
 *
 * `readByteRange` is handed `{ offset, length }` by the harness's
 * `workspace-files` byte routes, which already validate the request; a backend
 * only has to stay safe if a caller hands it something else (a direct plugin
 * consumer, a test). Anything that is not a positive safe integer counts as
 * zero, which yields the empty window at or past the end of a file rather than
 * an unbounded read.
 */

/** Clamp one window field to a non-negative safe integer. */
function toIndex(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Normalize `{ offset, length }`; a missing or invalid field becomes `0`. */
export function byteWindow(range) {
  return { offset: toIndex(range?.offset), length: toIndex(range?.length) }
}

export default byteWindow
