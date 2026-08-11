/**
 * Text out of the office files a factory actually sends.
 *
 * ## Why this exists
 *
 * The extract model reads PDFs and photographs natively — the vendor renders the pages and
 * per-field confidence measures the whole journey from pixels to value. It cannot read a
 * Word document or a spreadsheet, and those are not exotic: a buyer's PP comment sheet and
 * an auditor's findings arrive as `.docx`, an attendance export as `.csv`, a costing
 * breakdown as `.xlsx`.
 *
 * Until now the product ACCEPTED all of them at upload and then did nothing with them, in
 * silence — no chips, no sentence, no draft. The file was stored and forgotten. This turns
 * those bytes into text, which is the one thing the pipeline needed: from there they take
 * exactly the same path a pasted transcription takes, with the same measured confidence and
 * the same trip through somebody's approve inbox.
 *
 * ## Why no library
 *
 * `.docx` and `.xlsx` are ZIP archives of XML, and every entry Word and Excel write is
 * either stored or deflated — both of which `node:zlib` already does. The reader below is
 * the central directory and nothing else. A dependency here would be a third party inside
 * the path that parses untrusted uploads, on a runtime image whose Dockerfile goes out of
 * its way to delete npm itself; ninety lines that fail closed are the smaller risk.
 *
 * ## Failing closed
 *
 * Every function returns `null` rather than throwing or guessing. A corrupt archive, a
 * ZIP64 file, an encrypted one, a `.doc` from 1997 — all of them are "cannot read this",
 * which the caller turns into a sentence telling the person to paste the text instead.
 * Half-parsed text would be worse than none: it becomes a draft, wearing confidence.
 */
import { inflateRawSync } from 'node:zlib'

/**
 * Types this file can turn into text, as MIME strings.
 *
 * Kept beside the extractor rather than in the module that calls it, because the two must
 * agree: a type advertised here and unhandled below is a chip that queues a job which then
 * refuses, which is the failure the silence at least did not have.
 */
export const TEXT_EXTRACTABLE_MIME: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
])

/**
 * The text inside an uploaded document, or `null` when this file cannot produce any.
 *
 * `null` covers both "the type is not supported" and "the bytes did not parse". The caller
 * cannot act differently on the two — either way there is nothing to read — and collapsing
 * them keeps a corrupt `.docx` from being reported as an unsupported type, which would send
 * somebody to convert a file that was simply damaged.
 */
export function extractDocumentText(bytes: Uint8Array, mimeType: string): string | null {
  try {
    switch (mimeType) {
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return docxText(bytes)
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return xlsxText(bytes)
      case 'text/csv':
        return plainText(bytes)
      default:
        return null
    }
  } catch {
    // Any malformed archive lands here. See the note on failing closed.
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Word
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `.docx`'s visible text, one paragraph per line.
 *
 * Paragraph and break tags become newlines BEFORE the tags are stripped — otherwise a
 * document collapses into one line, and a table of measurements read as a single run of
 * numbers is how an extractor pairs a size with its neighbour's column. The live test met
 * exactly that failure with a browser's select-all, so the layout is worth preserving here
 * even though it is only approximately a layout.
 */
function docxText(bytes: Uint8Array): string | null {
  const xml = readZipEntry(bytes, 'word/document.xml')
  if (!xml) return null

  const flattened = Buffer.from(xml)
    .toString('utf8')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    /*
     * Cells first, and this order is the whole trick.
     *
     * Every table cell wraps its contents in a paragraph, so treating `</w:p>` as a line
     * break globally puts each CELL on its own line and a two-column row arrives as two
     * rows — the exact shape that lets an extractor pair a size with the next size's
     * measurement. Inside a cell a paragraph end is a space; the cell boundary is the tab
     * that makes it a column, and only `</w:tr>` ends the line.
     */
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => `\t${cell.replace(/<\/w:p>/g, ' ')}`)
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')

  const text = decodeXmlText(flattened)
    .split('\n')
    // The leading tab is the first column's separator with nothing to its left.
    .map((line) => line.replace(/^\t+/, '').trimEnd())
    .join('\n')
    .trim()

  return text === '' ? null : text
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `.xlsx`'s cells as tab-separated rows, sheet by sheet.
 *
 * Excel stores repeated text once in `sharedStrings.xml` and refers to it by index, so a
 * sheet read without that table is a grid of integers — every buyer name rendered as `7`.
 * Cells carrying `t="s"` are those references; everything else is a literal.
 *
 * Sheets are read by their conventional file names rather than through the workbook's
 * relationship graph. That gets the order wrong in the rare book whose sheets were
 * reordered after creation, and it avoids parsing two more XML files to learn something the
 * reader is about to hand to a human for approval anyway.
 */
function xlsxText(bytes: Uint8Array): string | null {
  const sharedXml = readZipEntry(bytes, 'xl/sharedStrings.xml')
  const shared: string[] = []
  if (sharedXml) {
    const source = Buffer.from(sharedXml).toString('utf8')
    for (const si of source.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []) {
      // A styled string is split across several <t> runs; joined, they are one value.
      const runs = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []
      shared.push(decodeXmlText(runs.join('')))
    }
  }

  const sheets: string[] = []
  for (let n = 1; n <= 24; n += 1) {
    const sheetXml = readZipEntry(bytes, `xl/worksheets/sheet${n}.xml`)
    if (!sheetXml) break
    const rendered = renderSheet(Buffer.from(sheetXml).toString('utf8'), shared)
    if (rendered.trim() !== '') sheets.push(rendered)
  }

  if (sheets.length === 0) return null
  return sheets.join('\n\n').trim() || null
}

function renderSheet(xml: string, shared: readonly string[]): string {
  const lines: string[] = []

  for (const row of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = []
    for (const cell of row.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const type = /\st="([^"]+)"/.exec(cell)?.[1]
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? '')
        cells.push(shared[index] ?? '')
      } else if (type === 'inlineStr') {
        cells.push(decodeXmlText(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1] ?? ''))
      } else {
        cells.push(decodeXmlText(/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? ''))
      }
    }
    // A wholly empty row is spacing in the sheet and noise in the transcript.
    if (cells.some((c) => c !== '')) lines.push(cells.join('\t'))
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain text
// ─────────────────────────────────────────────────────────────────────────────

/** A text file, minus the byte-order mark Excel puts on every CSV it exports. */
function plainText(bytes: Uint8Array): string | null {
  // Spelled as an escape, not as the character: a literal BOM in source is invisible to
  // whoever reads this next, and lint bans irregular whitespace for exactly that reason.
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')
  return text.trim() === '' ? null : text
}

// ─────────────────────────────────────────────────────────────────────────────
// The ZIP reader — central directory only
// ─────────────────────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** The comment field is 16-bit, so the record cannot start further back than this. */
const MAX_COMMENT = 0xffff

/**
 * One entry's bytes, by exact path, or `null` if the archive does not contain it.
 *
 * Deliberately not a general ZIP implementation: no ZIP64, no encryption, no streaming, no
 * data descriptors read from the local header. Office writes neither, and every one of
 * those absences is a `null` rather than a wrong answer.
 */
function readZipEntry(zip: Uint8Array, path: string): Uint8Array | null {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)

  // The end-of-central-directory record sits at the very end, behind an optional comment.
  let eocd = -1
  const floor = Math.max(0, buf.length - MAX_COMMENT - 22)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  const entries = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < entries; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null

    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (name === path) {
      // 0xFFFFFFFF is ZIP64's "look in the extra field", which this reader does not read.
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return null
      if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null

      // The local header repeats the name and carries its OWN extra field, which is
      // routinely a different length from the central one — reading the central copy's
      // length here lands mid-file, which is a subtle way to get plausible garbage.
      const localNameLength = buf.readUInt16LE(localOffset + 26)
      const localExtraLength = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const data = buf.subarray(start, start + compressedSize)

      if (method === 0) return new Uint8Array(data)
      if (method === 8) return new Uint8Array(inflateRawSync(data))
      return null
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// XML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tags out, entities in.
 *
 * The order matters: `&amp;` is decoded LAST, or `&amp;lt;` — a document that contains the
 * literal text "&lt;" — turns into a `<` and takes the rest of the line with it.
 */
function decodeXmlText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      // A hex CHARACTER REFERENCE — `&#x2019;` is a right quote. Not a quantity and not
      // money; the money lint rule cannot tell the difference from the call alone.
      // eslint-disable-next-line fabricxai/no-float-money
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}
