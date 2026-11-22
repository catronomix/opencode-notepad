/**
 * Where notes live and how files are read and written.
 *
 * A note is keyed by session and kept in the TUI plugin's durable store: it is
 * written to disk by the host and never becomes part of the chat transcript.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export { NOTE_KEY_PREFIX, decodeSessionID, encodeSessionID, isStorageSegment, legacyNoteKey, noteKey } from "./keys.ts"

/** The largest file the note will load; anything bigger is refused. */
export const MAX_NOTE_BYTES = 1024 * 1024

/** Resolves a user-typed path against the project directory. */
export function resolveNotePath(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target)
}

/** A load that succeeded, or the reason it was refused (shown to the user). */
export type NoteFileRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

/**
 * Reads a file to load into the note, refusing anything that is not a small,
 * regular, text file. The checks run in this order on purpose: `stat` rejects
 * FIFOs and devices *before* they are opened (opening a FIFO would block
 * forever), the size check keeps a huge file from being read at all, and the
 * NUL scan keeps binary data out of the editor.
 */
export function readNoteFile(path: string): NoteFileRead {
  let size: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return { ok: false, reason: "not a regular file" }
    size = stats.size
  } catch {
    return { ok: false, reason: "file cannot be read" }
  }
  if (size > MAX_NOTE_BYTES) return { ok: false, reason: "file is larger than 1 MiB" }

  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return { ok: false, reason: "file cannot be read" }
  }
  // The file may have grown between `stat` and the read.
  if (bytes.length > MAX_NOTE_BYTES) return { ok: false, reason: "file is larger than 1 MiB" }
  if (bytes.includes(0)) return { ok: false, reason: "looks like a binary file" }
  return { ok: true, text: bytes.toString("utf8") }
}

export function writeNoteFile(path: string, text: string): string {
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
