/**
 * Turn a MARBIM answer string into a small block tree the UI can render.
 *
 * Chat answers arrive as plain text that the model formats with light markdown
 * (paragraphs, `#` headings, `-` / `1.` lists, `**bold**`). `AnswerText` used to
 * dump that string into a `<div>`, so HTML collapsed every newline into a wall
 * of text and the markdown markers showed up literally.
 *
 * This is deliberately a subset — not CommonMark. Enough structure for a desk
 * answer, nothing that needs a dependency, and no HTML passthrough (the model
 * is not a trusted author).
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }

/** Split a model answer into renderable blocks. */
export function parseAnswerProse(source: string): Block[] {
  const text = source.replace(/\r\n/g, '\n').trim()
  if (!text) return []

  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = line.match(/^```/)
    if (fence) {
      i += 1
      const body: string[] = []
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        body.push(lines[i]!)
        i += 1
      }
      if (i < lines.length) i += 1 // closing fence
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        inlines: parseInlines(heading[2]!),
      })
      i += 1
      continue
    }

    const bullet = line.match(/^[-*•]\s+(.+)$/)
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const items: Inline[][] = []
      while (i < lines.length) {
        const current = lines[i]!
        const nextBullet = current.match(/^[-*•]\s+(.+)$/)
        const nextNumbered = current.match(/^\d+[.)]\s+(.+)$/)
        if (ordered ? nextNumbered : nextBullet) {
          items.push(parseInlines((ordered ? nextNumbered![1] : nextBullet![1])!))
          i += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // Paragraph: consecutive non-blank, non-special lines, joined with spaces
    // unless a soft break was intentional (single newline inside a paragraph
    // becomes a space — blank lines already split paragraphs above).
    const parts: string[] = []
    while (i < lines.length) {
      const current = lines[i]!
      if (current.trim() === '') break
      if (/^```/.test(current)) break
      if (/^#{1,3}\s+/.test(current)) break
      if (/^[-*•]\s+/.test(current)) break
      if (/^\d+[.)]\s+/.test(current)) break
      parts.push(current.trim())
      i += 1
    }
    if (parts.length > 0) {
      blocks.push({ kind: 'paragraph', inlines: parseInlines(parts.join(' ')) })
    }
  }

  return blocks
}

/**
 * Inline markers: `**bold**`, `*italic*` / `_italic_`, `` `code` ``.
 * Unmatched markers stay as literal text — better than eating half a sentence.
 */
export function parseInlines(source: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) {
      out.push({ kind: 'text', text: source.slice(last, match.index) })
    }
    const token = match[0]!
    if (token.startsWith('**') && token.endsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) })
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      out.push({ kind: 'em', text: token.slice(1, -1) })
    } else if (token.startsWith('`') && token.endsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) })
    } else {
      out.push({ kind: 'text', text: token })
    }
    last = match.index + token.length
  }

  if (last < source.length) {
    out.push({ kind: 'text', text: source.slice(last) })
  }

  return out.length > 0 ? out : [{ kind: 'text', text: source }]
}
