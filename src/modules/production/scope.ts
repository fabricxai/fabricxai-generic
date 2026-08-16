/**
 * Which lines a caller may write to. Pure — no database, no ctx.
 *
 * The decision is separated from the lookup because the lookup is the boring half. What is
 * worth reading twice is the rule: a scope is a list of line CODES a person says out loud
 * ("L1"), payloads name uuids, and an id that resolves to no line at all must be refused
 * rather than ignored — a write to a line this company does not have is not a write that
 * quietly succeeds (§9, F45).
 */

export interface ScopeDecision {
  /** Line ids the caller may not write to, as codes where a code is known. */
  refused: string[]
}

/**
 * Compare the lines a payload names against the lines a role covers.
 *
 * `known` is what the database said those ids are — an id missing from it belongs to no line
 * of this company and is refused, named by its id since there is no code to give it.
 *
 * An empty `scope` never reaches here: `undefined` scope means the whole floor and the caller
 * returns before looking anything up. An empty ARRAY, though, would mean a person narrowed to
 * nothing, and this refuses everything for them — which is the honest reading and the reason
 * the settings screen removes the key instead of storing `[]`.
 */
export function refusedLines(input: {
  /** Line ids the write names, already de-duplicated by the caller or not. */
  lineIds: readonly string[]
  /** Line codes the role covers. */
  scope: readonly string[]
  /** What the database knows about those ids: id → code. */
  known: ReadonlyMap<string, string>
}): ScopeDecision {
  const covered = new Set(input.scope)
  const refused: string[] = []

  for (const id of new Set(input.lineIds)) {
    const code = input.known.get(id)
    // No code means the id is not a line of this company. Refusing by id is not helpful to
    // read, but the alternative — letting it through to be caught by a foreign key — reports
    // a database error where a permission answer belongs.
    if (code === undefined || !covered.has(code)) refused.push(code ?? id)
  }

  return { refused }
}
