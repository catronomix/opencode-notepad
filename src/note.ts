/**
 * Where notes live and how files are read and written.
 *
 * A note is keyed by session and kept in the TUI plugin's durable store: it is
 * written to disk by the host and never becomes part of the chat transcript.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export { NOTE_KEY_PREFIX, noteKey } from "./keys.ts"

/** Resolves a user-typed path against the project directory. */
export function resolveNotePath(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target)
}

export function readNoteFile(path: string): string {
  return readFileSync(path, "utf8")
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
