/**
 * Reading the office files a factory sends.
 *
 * The archives here are BUILT in the test rather than committed as fixtures, so what is
 * being asserted is visible in the same screen as the assertion — a binary `.docx` in the
 * repo would make "why does this expect a tab there" unanswerable without a hex editor.
 * The ZIP writer below is the minimum Word and Excel actually emit: local header, data,
 * central directory, end record, entries either stored or deflated.
 *
 * The one thing a fixture cannot prove is that a REAL document works, so the last block
 * reads the live-test kit's own files when they are present on the machine and skips when
 * they are not.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { extractDocumentText } from '@/lib/document-text'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** A ZIP holding the given entries, deflated like Word writes them. */
function zip(entries: Record<string, string>, { store = false } = {}): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8')
    const data = store ? raw : deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    // Extra length 0 here; the reader must take the LOCAL header's own value, not the
    // central one, which is why the next test gives them different lengths on purpose.
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const entry = Buffer.alloc(46 + nameBuf.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(store ? 0 : 8, 10)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    nameBuf.copy(entry, 46)
    central.push(entry)

    offset += local.length + data.length
  }

  const body = Buffer.concat(locals)
  const dir = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(body.length, 16)

  return new Uint8Array(Buffer.concat([body, dir, eocd]))
}

const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

describe('Word', () => {
  it('reads paragraphs as lines', () => {
    const doc = zip({
      'word/document.xml': `<w:document><w:body>${paragraph('Overall status: REJECTED')}${paragraph('Resubmit required')}</w:body></w:document>`,
    })

    expect(extractDocumentText(doc, DOCX)).toBe('Overall status: REJECTED\nResubmit required')
  })

  it('keeps a table readable as columns and rows', () => {
    // The failure this prevents: a flattened table lets an extractor pair a size with its
    // neighbour's column — which is exactly how the first live measurement chart came out
    // shifted, at high confidence, and was approved before anyone compared it to the page.
    const doc = zip({
      'word/document.xml':
        '<w:tbl>' +
        `<w:tr><w:tc>${paragraph('Sleeve')}</w:tc><w:tc>${paragraph('+1.2')}</w:tc></w:tr>` +
        `<w:tr><w:tc>${paragraph('Chest')}</w:tc><w:tc>${paragraph('52.0')}</w:tc></w:tr>` +
        '</w:tbl>',
    })

    const text = extractDocumentText(doc, DOCX)!
    const rows = text.split('\n').filter((l) => l.trim() !== '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Sleeve')
    expect(rows[0]).toContain('+1.2')
    expect(rows[1]).toContain('Chest')
  })

  it('decodes entities without eating the text after them', () => {
    // `&amp;` must decode LAST. Otherwise `&amp;lt;` — a document containing the literal
    // characters "&lt;" — becomes a `<` and the tag-stripper swallows the rest of the line.
    const doc = zip({
      'word/document.xml': paragraph('H&amp;M &amp;lt; buyer &#8217;s note &quot;ok&quot;'),
    })

    expect(extractDocumentText(doc, DOCX)).toBe('H&M &lt; buyer ’s note "ok"')
  })

  it('reads a stored (uncompressed) entry too', () => {
    const doc = zip({ 'word/document.xml': paragraph('Stored, not deflated') }, { store: true })
    expect(extractDocumentText(doc, DOCX)).toBe('Stored, not deflated')
  })
})

describe('Excel', () => {
  it('resolves shared strings instead of reporting their indexes', () => {
    // Without the shared-strings table every text cell reads as an integer — a sheet of
    // buyer names rendered as 0, 1, 2. Plausible, and completely wrong.
    const book = zip({
      'xl/sharedStrings.xml':
        '<sst><si><t>Bestseller A/S</t></si><si><t>Navy</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>36000</v></c></row>' +
        '</sheetData></worksheet>',
    })

    expect(extractDocumentText(book, XLSX)).toBe('Bestseller A/S\tNavy\t36000')
  })

  it('joins a styled string split across runs', () => {
    const book = zip({
      'xl/sharedStrings.xml': '<sst><si><r><t>PO-BF-</t></r><r><t>2044</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
    })

    expect(extractDocumentText(book, XLSX)).toBe('PO-BF-2044')
  })

  it('drops rows that are only spacing', () => {
    const book = zip({
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row><c><v>1</v></c></row><row><c/></row><row><c><v>2</v></c></row>' +
        '</sheetData></worksheet>',
    })

    expect(extractDocumentText(book, XLSX)).toBe('1\n2')
  })
})

describe('CSV', () => {
  it('strips the byte-order mark Excel exports', () => {
    const bytes = new Uint8Array(Buffer.from('﻿employee,date\nBF-0001,01/08/2026', 'utf8'))
    expect(extractDocumentText(bytes, 'text/csv')).toBe('employee,date\nBF-0001,01/08/2026')
  })
})

describe('failing closed', () => {
  it('returns null rather than guessing', () => {
    const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
      ['not an archive at all', new Uint8Array([1, 2, 3, 4]), DOCX],
      ['an archive without the document part', zip({ 'docProps/app.xml': '<x/>' }), DOCX],
      ['an empty document body', zip({ 'word/document.xml': '<w:document/>' }), DOCX],
      ['a workbook with no sheets', zip({ 'xl/sharedStrings.xml': '<sst/>' }), XLSX],
      ['an empty csv', new Uint8Array(Buffer.from('   \n')), 'text/csv'],
      ['a type nothing here handles', zip({ 'a': 'b' }), 'application/msword'],
    ]

    for (const [what, bytes, mime] of cases) {
      expect(extractDocumentText(bytes, mime), what).toBeNull()
    }
  })

  it('refuses a truncated archive without throwing', () => {
    // Half an upload. The caller turns null into "paste the text instead"; an exception
    // here would fail the whole extraction job with a stack trace nobody can act on.
    const whole = zip({ 'word/document.xml': paragraph('half a file') })
    expect(() => extractDocumentText(whole.slice(0, whole.length - 10), DOCX)).not.toThrow()
    expect(extractDocumentText(whole.slice(0, whole.length - 10), DOCX)).toBeNull()
  })
})

/**
 * The kit's real documents, when this machine has them.
 *
 * Everything above is a fixture this file wrote, and a fixture proves only that the reader
 * agrees with the writer. Word's own output carries a `docProps` tree, an extra field on the
 * local header that the central directory does not repeat, and paragraph markup far richer
 * than `<w:p><w:r><w:t>` — none of which a hand-built archive exercises.
 */
const KIT = join(homedir(), 'Downloads/fabricxai-live-test-kit/documents')
const COMMENT_SHEET = join(KIT, '06-quality/12-HM-PP-comment-sheet-ST-2712.docx')

describe.skipIf(!existsSync(COMMENT_SHEET))('a document Word actually wrote', () => {
  it('reads the buyer’s verdict and the findings table out of the kit’s comment sheet', () => {
    const text = extractDocumentText(new Uint8Array(readFileSync(COMMENT_SHEET)), DOCX)!

    // The verdict the sampling module's PP gate turns on.
    expect(text).toContain('REJECTED')
    // A findings row, with its severity still attached to its observation.
    expect(text).toContain('Sleeve length measuring +1.2 cm')
    expect(text).toContain('MAJOR')
    // Rows stayed rows: the table did not collapse into one line.
    expect(text.split('\n').length).toBeGreaterThan(10)
  })
})
