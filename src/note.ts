/**
 * Where notes live and how files are read and written.
 *
 * A note is keyed by session and kept in the TUI plugin's durable store: it is
 * written to disk by the host and never becomes part of the chat transcript.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export { NOTE_KEY_PREFIX, canMigrateLegacy, decodeSessionID, encodeSessionID, isStorageSegment, legacyNoteKey, noteKey, storageSegment } from "./keys.ts"

/** The largest a note or a loaded file may be; anything bigger is refused. */
export const MAX_NOTE_BYTES = 1024 * 1024

/** The reason shown whenever the cap is hit, so every path words it the same. */
export const NOTE_TOO_LARGE = "file is larger than 1 MiB"

/** True when `text` is over the note cap as UTF-8. */
export function noteTooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES
}

/** Resolves a user-typed path against the project directory. */
export function resolveNotePath(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target)
}

/** A load that succeeded, or the reason it was refused (shown to the user). */
export type NoteFileRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

/**
 * Reads a file to load into the note, refusing anything that is not a small,
 * regular, text file.
 *
 * Everything is done on one open descriptor, so the checks and the read cannot
 * disagree (a path swapped between them is out of the picture): `O_NONBLOCK`
 * keeps a FIFO or device from blocking the render thread, `fstat` on that same
 * descriptor decides whether it is a regular file at all, the size is checked
 * before a single byte is read, and reading stops the moment the cap is passed.
 * The descriptor is closed in `finally`, whatever happens.
 */
export function readNoteFile(path: string): NoteFileRead {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stats = fstatSync(fd)
    if (!stats.isFile()) return { ok: false, reason: "not a regular file" }
    if (stats.size > MAX_NOTE_BYTES) return { ok: false, reason: NOTE_TOO_LARGE }

    const chunk = Buffer.allocUnsafe(64 * 1024)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const got = readSync(fd, chunk, 0, chunk.length, null)
      if (got === 0) break
      total += got
      // The file may grow while it is read; the cap still holds.
      if (total > MAX_NOTE_BYTES) return { ok: false, reason: NOTE_TOO_LARGE }
      chunks.push(Buffer.from(chunk.subarray(0, got)))
    }
    const bytes = Buffer.concat(chunks, total)
    if (bytes.includes(0)) return { ok: false, reason: "looks like a binary file" }
    return { ok: true, text: bytes.toString("utf8") }
  } catch {
    return { ok: false, reason: "file cannot be read" }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Nothing left to do with a descriptor that cannot be closed.
      }
    }
  }
}

/**
 * Writes the note to `path`. A symlink in place of the file is refused rather
 * than followed: the dialog names the file the user typed, and following a link
 * would write somewhere they did not choose.
 */
export function writeNoteFile(path: string, text: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("the target is a symbolic link")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
  return path
}

export function noteFileExists(cwd: string, name: string): boolean {
  try {
    return statSync(resolveNotePath(cwd, name)).isFile()
  } catch {
    return false
  }
}

export interface PathMatch {
  readonly path: string
  /** What the completion line shows, relative to the project directory. */
  readonly label: string
  readonly directory: boolean
}

/**
 * `@./`-style completion: the last path segment is the prefix, everything before
 * it names the directory to read. Hidden entries only appear once the prefix
 * starts with a dot, so a plain query is not flooded with dotfiles.
 */
export function listPathMatches(cwd: string, query: string, limit = 6): PathMatch[] {
  const normalized = query.replace(/\\/g, "/")
  const cut = normalized.lastIndexOf("/")
  const directoryPart = cut >= 0 ? normalized.slice(0, cut + 1) : ""
  const prefix = (cut >= 0 ? normalized.slice(cut + 1) : normalized).toLowerCase()
  let entries
  try {
    entries = readdirSync(resolve(cwd, directoryPart || "."), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => prefix.startsWith(".") || !entry.name.startsWith("."))
    .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((entry) => ({
      path: resolve(cwd, directoryPart + entry.name),
      label: `${directoryPart}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory: entry.isDirectory(),
    }))
}
