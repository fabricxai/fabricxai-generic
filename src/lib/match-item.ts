/**
 * A supplier's words for a material, against this factory's own item list.
 *
 * Every document a store or a procurement desk reads names materials in somebody else's
 * vocabulary. A challan says "Cotton Yarn 30/1 Combed"; a mill's proforma says "12 OZ
 * STRETCH DENIM, 98PCT COTTON 2PCT SPANDEX, CUTTABLE WIDTH 58IN, INDIGO"; the factory set
 * them up as "30/1 combed cotton yarn" and "12oz stretch denim". Those are the same
 * materials to everyone except a string comparison.
 *
 * ## Why the tokeniser splits digits from letters
 *
 * Textile descriptions are full of them: 12oz, 180gsm, 40s, 30/1, 58". One person writes
 * `12oz` and the next writes `12 OZ`, and a naive split makes those two different words —
 * so `{12oz, stretch, denim}` fails against `{12, oz, stretch, denim, ...}` and a
 * perfectly obvious match is reported as unknown. Splitting the boundary makes both sides
 * `12 oz` and the comparison works on what a person would call the same words.
 *
 * ## Why a near-match is never good enough
 *
 * Matching on partial overlap would make "cotton yarn" hit every cotton item in the store.
 * A wrongly-resolved material is a receipt against the wrong stock or a price against goods
 * nobody quoted — both silent, both discovered weeks later. So the rule is exact code, then
 * exact name, then the item's OWN words all present in the document's longer description.
 * Anything less returns null, and every caller says so on screen rather than guessing.
 */

export interface MatchableItem {
  id: string
  code: string
  name: string
}

/** Lowercase words, with digit/letter boundaries opened up. `12oz` → `12 oz`. */
export function itemTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/[^a-z0-9/.]+/g, ' ')
      .split(' ')
      .filter(Boolean),
  )
}

export function matchItem<T extends MatchableItem>(
  items: readonly T[],
  code: string | undefined,
  name: string | undefined,
): T | null {
  const wantedCode = (code ?? '').trim().toLowerCase()
  if (wantedCode) {
    const byCode = items.find((item) => item.code.toLowerCase() === wantedCode)
    if (byCode) return byCode
  }

  const wantedName = (name ?? '').trim().toLowerCase()
  if (!wantedName) return null

  const exact = items.find((item) => item.name.toLowerCase() === wantedName)
  if (exact) return exact

  /*
   * The item's own words, all present in the document's description.
   *
   * One direction, deliberately: a supplier's description is verbose and a master-list name
   * is short, so "12oz stretch denim" fits inside the mill's sentence and never the reverse.
   * Requiring it both ways would refuse every real document; requiring neither would match
   * on a single shared word.
   */
  const said = itemTokens(wantedName)
  const candidates = items.filter((item) => {
    const mine = itemTokens(item.name)
    if (mine.size === 0) return false
    for (const token of mine) if (!said.has(token)) return false
    return true
  })

  // Two items whose names both fit is not a match, it is a question — "denim" and "12oz
  // stretch denim" would both fit the same sentence, and picking the shorter silently is how
  // stock lands against the wrong material.
  return candidates.length === 1 ? candidates[0]! : null
}
