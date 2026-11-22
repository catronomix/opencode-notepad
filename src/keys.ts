/**
 * Storage key layout shared by the TUI and server halves of the plugin.
 *
 * Durable storage validates every key by splitting it on `.` and checking each
 * segment against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. A note key is therefore two
 * segments: the plugin's own name and the session. The session part is encoded
 * reversibly, so two session IDs can never share a key, and decoding a key
 * always gives the session ID back.
 */

export const NOTE_KEY_PREFIX = "opencode-notepad"

/** What one segment may contain, mirroring the host's validator. */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** True when `value` is a single storage segment the host accepts. */
export function isStorageSegment(value: string): boolean {
  return SEGMENT.test(value)
}

/**
 * The lossy encoding used before notes moved to `encodeSessionID`. It stays
 * only so a note written under the old layout can be found and migrated; no new
 * note is ever written under it.
 */
export function storageSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "-")
  if (!cleaned) return "empty"
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `s${cleaned}`
}

/**
 * Reversible single-segment encoding of a session ID: the ID's UTF-8 bytes as
 * lowercase hex. Hex letters and digits are all a segment may contain, the
 * first character is always alphanumeric, and the mapping is injective - two
 * different IDs cannot produce the same segment.
 */
export function encodeSessionID(sessionID: string): string {
  const encoded = Buffer.from(sessionID, "utf8").toString("hex")
  return encoded || "empty"
}

/** The session ID behind an `encodeSessionID` segment, or undefined. */
export function decodeSessionID(segment: string): string | undefined {
  if (segment === "empty") return ""
  if (!/^(?:[0-9a-f]{2})+$/.test(segment)) return undefined
  const decoded = Buffer.from(segment, "hex").toString("utf8")
  // Round-trip through the encoder so malformed UTF-8 cannot decode silently.
  return encodeSessionID(decoded) === segment ? decoded : undefined
}

/**
 * Durable key for one session's note, e.g. `opencode-notepad.7365735f65…`.
 * The TUI namespaces it further (`plugin.<id>.tui.<key>`), and every segment of
 * the resulting path must be valid.
 */
export function noteKey(sessionID: string): string {
  return `${NOTE_KEY_PREFIX}.${encodeSessionID(sessionID)}`
}

/** The pre-encoding key for a session, read only when migrating an old note. */
export function legacyNoteKey(sessionID: string): string {
  return `${NOTE_KEY_PREFIX}.${storageSegment(sessionID)}`
}

/**
 * Whether a session's old-key record can be trusted to belong to it. The old
 * segment was lossy (`a:b` and `a-b` both encoded to `a-b`), so a key that did
 * not survive the round trip could name a different chat and must be left
 * alone. Real session IDs (`ses_…`) pass unchanged.
 */
export function canMigrateLegacy(sessionID: string): boolean {
  return storageSegment(sessionID) === sessionID
}
