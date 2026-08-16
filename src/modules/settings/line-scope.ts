/**
 * What a role's scope object becomes when its lines change. Pure — no database.
 *
 * Two rules that are easy to get wrong and impossible to see afterwards, which is why they
 * are here rather than inline in a transaction (§9, F46).
 */

/**
 * **An empty list means the whole floor, and the key is REMOVED.**
 *
 * Not stored as `[]`. `session.ts` reads a role with no `lines` array as unnarrowed, so an
 * empty array would leave the difference between "everywhere" and "nowhere" resting on how
 * one reader happens to treat `[].every(...)` — a question nobody should ever have to ask of
 * a permissions record. Deleting the key says it once, in the data.
 *
 * **Everything else in the scope is left alone.** The lines picker owns one key. A scope that
 * also carries, say, a floor or a unit must survive somebody changing which lines a chief
 * covers, and a wholesale replace would quietly drop it.
 */
export function nextLineScope(
  current: Record<string, unknown> | null | undefined,
  lineCodes: readonly string[],
): Record<string, unknown> {
  const next = { ...(current ?? {}) }

  if (lineCodes.length > 0) next.lines = [...lineCodes]
  else delete next.lines

  return next
}

/**
 * Line codes as they were asked for, trimmed, de-duplicated and emptied of blanks.
 *
 * Order is the caller's: the screen sends them in board order so that two admins picking the
 * same three lines store the same thing, rather than two scopes that differ only by the order
 * somebody happened to click.
 */
export function cleanLineCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim()).filter((code) => code !== ''))]
}
