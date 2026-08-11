/**
 * Per-tenant export — everything one company owns, as files it can keep.
 *
 *   pnpm export:tenant -- --company=<uuid> --out=./exports/acme --documents
 *
 * WHY THIS EXISTS, since the backup layer already protects the data:
 *
 *   · **Offboarding.** A factory that leaves is entitled to its own records, and the
 *     alternative to a script is somebody writing ad-hoc SELECTs against production at
 *     the end of a commercial relationship — which is when a mistake is least likely to
 *     be forgiven and a cross-tenant row is most likely to be missed.
 *   · **A restore is all-or-nothing.** pgBackRest recovers the whole cluster to a
 *     moment. When ONE company's data needs to go somewhere — an auditor, a buyer's
 *     compliance team, a lawyer — restoring a 4h RTO's worth of everything to extract
 *     one tenant is the wrong tool.
 *   · **It is the tenancy model, checked.** The export enumerates tables by the presence
 *     of a `company_id` column and filters every one of them on it. A table that holds
 *     tenant data without that column would silently not appear here, which makes this
 *     script a periodic audit of the rule CLAUDE.md §2 states.
 *
 * WHAT IT DOES NOT DO. It does not delete anything, ever. "Export then erase" is two
 * decisions and only one of them is reversible; erasure belongs behind a separate,
 * deliberate procedure that a script run by habit must not be able to reach.
 *
 * Runs as the OWNER role (DIRECT_DATABASE_URL) because it must read across every table
 * without an RLS session context, and filters explicitly rather than relying on the
 * policy — the one place in this codebase where that is the correct choice, and the
 * reason every query below carries its `where company_id` in plain sight.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import 'dotenv/config'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'

import { createDirectClient } from '../src/db/direct'

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
  company: string
  out: string
  documents: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (!match) continue
    flags.set(match[1]!, match[2] ?? 'true')
  }

  const company = flags.get('company')
  const out = flags.get('out')

  if (!company || !out) {
    console.error(
      [
        'usage: pnpm export:tenant -- --company=<uuid> --out=<dir> [--documents]',
        '',
        '  --company    the company id. A UUID, not a name: names are not unique and an',
        '               export of the wrong tenant is a data breach, not a typo.',
        '  --out        an empty or non-existent directory.',
        '  --documents  also download every uploaded file from object storage. Without',
        '               it you get the documents TABLE (filenames, kinds, checksums) and',
        '               no bytes — often what is actually wanted, and much smaller.',
      ].join('\n'),
    )
    process.exit(2)
  }

  // Validated before it goes anywhere near a query. This value is interpolated into SQL
  // (COPY cannot take bind parameters), so "it is a UUID" is load-bearing rather than
  // tidy — see the copyOut() comment.
  const parsed = z.uuid().safeParse(company)
  if (!parsed.success) {
    console.error(`[export] --company must be a UUID, got: ${company}`)
    process.exit(2)
  }

  return { company: parsed.data, out, documents: flags.get('documents') === 'true' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

interface TableResult {
  table: string
  rows: number
  file: string
  sha256: string
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()

  // Refuse to write into a directory that already has anything in it. Two exports
  // merged in one folder is a manifest that describes one of them and files from both.
  await mkdir(opts.out, { recursive: true })
  const existing = await readdir(opts.out)
  if (existing.length > 0) {
    console.error(`[export] ${opts.out} is not empty — point --out at a fresh directory`)
    process.exit(1)
  }

  const sql = createDirectClient()

  try {
    const [company] = await sql<{ id: string; name: string; created_at: Date }[]>`
      select id, name, created_at from companies where id = ${opts.company}
    `

    if (!company) {
      console.error(`[export] no company with id ${opts.company}`)
      process.exit(1)
    }

    console.log(`[export] ${company.name} (${company.id})`)

    // ── Which tables belong to a tenant ──────────────────────────────────────
    //
    // Discovered, not listed. A hardcoded list is a list that goes stale the first time
    // a module adds a table, and the failure mode is silent under-export — the tenant
    // receives files that look complete.
    const tenantTables = await sql<{ table_name: string }[]>`
      select c.table_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public'
         and c.column_name = 'company_id'
         and t.table_type = 'BASE TABLE'
       order by c.table_name
    `

    console.log(`[export] ${tenantTables.length} tenant-scoped tables`)

    const dataDir = path.join(opts.out, 'data')
    await mkdir(dataDir, { recursive: true })

    const results: TableResult[] = []

    // The company row itself, which is keyed by `id` rather than `company_id` and would
    // otherwise be the one record missing from its own export.
    results.push(
      await copyOut(sql, dataDir, 'companies', `select * from companies where id = '${opts.company}'`),
    )

    for (const { table_name: table } of tenantTables) {
      results.push(
        await copyOut(
          sql,
          dataDir,
          table,
          // `${table}` is an identifier out of information_schema — it cannot be
          // attacker-controlled — and the UUID was validated at parse time. COPY takes
          // no bind parameters, so this is interpolation by necessity, kept to exactly
          // two values whose provenance is stated.
          `select * from "${table}" where company_id = '${opts.company}'`,
        ),
      )
    }

    // The people. `users` is global (one account can belong to several companies), so
    // it is scoped through the membership table rather than by a column it does not
    // have. Only users who actually hold a role here, and only the account fields — no
    // password hashes, no session tokens, both of which live in tables this skips.
    results.push(
      await copyOut(
        sql,
        dataDir,
        'users',
        `select u.id, u.name, u.email, u.email_verified, u.created_at
           from users u
          where exists (select 1 from roles r
                         where r.user_id = u.id and r.company_id = '${opts.company}')`,
      ),
    )

    // ── Documents ────────────────────────────────────────────────────────────
    const [docStats] = await sql<{ files: number; bytes: string }[]>`
      select count(*)::int as files, coalesce(sum(size_bytes), 0)::text as bytes
        from documents
       where company_id = ${opts.company} and deleted_at is null
    `

    let documentsDownloaded = 0
    if (opts.documents && docStats && docStats.files > 0) {
      documentsDownloaded = await downloadDocuments(sql, opts, Number(docStats.bytes))
    } else if (docStats && docStats.files > 0) {
      console.log(
        `[export] ${docStats.files} documents (${mb(Number(docStats.bytes))}) NOT downloaded — pass --documents for the bytes`,
      )
    }

    // ── Manifest ─────────────────────────────────────────────────────────────
    //
    // Row counts and per-file checksums, so the recipient can verify what they got and
    // we can answer "what exactly did we send them" months later without guessing.
    const manifest = {
      company: { id: company.id, name: company.name, createdAt: company.created_at },
      exportedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      schema: { migrationsApplied: await migrationCount(sql) },
      tables: results,
      totalRows: results.reduce((sum, r) => sum + r.rows, 0),
      documents: {
        files: docStats ? docStats.files : 0,
        bytes: docStats ? Number(docStats.bytes) : 0,
        downloaded: documentsDownloaded,
      },
    }

    await writeFile(path.join(opts.out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(path.join(opts.out, 'README.txt'), readme(manifest))

    console.log(
      `[export] done · ${manifest.totalRows} rows across ${results.length} files · ${Math.round(manifest.durationMs / 1000)}s`,
    )
    console.log(`[export] ${opts.out}`)
  } finally {
    await sql.end()
  }
}

/**
 * One table to one CSV, streamed.
 *
 * COPY rather than SELECT-and-serialise: Postgres's CSV writer already handles the
 * embedded newlines in an address, the commas in a buyer's legal name and the quoting
 * rules a hand-rolled writer gets wrong on the one row nobody tested. Streaming matters
 * too — `hourly_outputs` for a year does not want to be an array in memory first.
 */
async function copyOut(
  sql: ReturnType<typeof createDirectClient>,
  dir: string,
  table: string,
  select: string,
): Promise<TableResult> {
  const file = `${table}.csv`
  const target = path.join(dir, file)

  const hash = createHash('sha256')
  let bytes = 0

  const source = await sql
    .unsafe(`copy (${select}) to stdout with (format csv, header)`)
    .readable()

  source.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    bytes += chunk.length
  })

  await pipeline(source, createWriteStream(target))

  // Rows = lines minus the header. Counted from the bytes we just wrote rather than by
  // a second `count(*)`, which would be a different query against a table that may have
  // changed underneath — the manifest should describe the FILE, not the table.
  const rows = await countRows(target)

  console.log(`[export]   ${table.padEnd(32)} ${String(rows).padStart(8)} rows  ${mb(bytes)}`)

  return { table, rows, file, sha256: hash.digest('hex') }
}

async function countRows(file: string): Promise<number> {
  const { createReadStream } = await import('node:fs')
  let newlines = 0
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      for (const byte of chunk) if (byte === 0x0a) newlines++
    }
    yield ''
  })
  return Math.max(0, newlines - 1)
}

/**
 * The uploaded files themselves.
 *
 * Written under `documents/<object_key>` — the key, not the filename, because two
 * challans can both be `challan.jpg` and the key is what the exported `documents.csv`
 * points at. The original filename is a column in that CSV.
 */
async function downloadDocuments(
  sql: ReturnType<typeof createDirectClient>,
  opts: Options,
  totalBytes: number,
): Promise<number> {
  // Built here rather than imported from lib/s3 on purpose: that module pulls in
  // `lib/env`, which validates the application's auth secret, model provider keys and
  // mail configuration. An ops script that exports a tenant's rows should need a
  // connection string and object-storage credentials, nothing else — the same reasoning
  // src/db/direct.ts states for migrations.
  const endpoint = process.env.S3_ENDPOINT
  const bucketFallback = process.env.S3_BUCKET
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.error('[export] --documents needs S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY')
    process.exit(1)
  }

  const s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })

  const docs = await sql<{ bucket: string; object_key: string }[]>`
    select bucket, object_key
      from documents
     where company_id = ${opts.company} and deleted_at is null
     order by created_at
  `

  console.log(`[export] downloading ${docs.length} documents (${mb(totalBytes)})`)

  let done = 0
  let failed = 0

  for (const doc of docs) {
    const target = path.join(opts.out, 'documents', doc.object_key)
    await mkdir(path.dirname(target), { recursive: true })

    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: doc.bucket || bucketFallback, Key: doc.object_key }),
      )
      if (!object.Body) throw new Error('empty body')
      await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(target))
      done++
    } catch (error) {
      // One missing object must not abandon an export of ten thousand. Counted and
      // reported at the end — a partial export the recipient knows is partial is worth
      // far more than no export, and the manifest records the difference.
      failed++
      console.warn(`[export]   MISSING ${doc.object_key}: ${(error as Error).message}`)
    }

    if (done % 200 === 0 && done > 0) console.log(`[export]   ${done}/${docs.length}`)
  }

  if (failed > 0) {
    console.warn(`[export] ⚠ ${failed} documents could not be downloaded — see MANIFEST.json`)
  }

  return done
}

async function migrationCount(sql: ReturnType<typeof createDirectClient>): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations
  `
  return row?.n ?? 0
}

function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function readme(manifest: { company: { name: string }; exportedAt: string }): string {
  return [
    `FabricXAI export · ${manifest.company.name}`,
    `Taken ${manifest.exportedAt}`,
    '',
    'data/         one CSV per table, UTF-8, RFC 4180 quoting, first row is the header.',
    'documents/    uploaded files, laid out by object key. Present only if the export',
    '              was taken with --documents. `data/documents.csv` maps each key to the',
    '              original filename, kind and the row it belongs to.',
    'MANIFEST.json row counts and a SHA-256 per file. Verify with:',
    '                sha256sum -c <(jq -r \'.tables[] | "\\(.sha256)  data/\\(.file)"\' MANIFEST.json)',
    '',
    'Money columns are exact decimal strings, never floats, and every amount has a',
    'currency column beside it. Timestamps are UTC; the factory works in Asia/Dhaka',
    '(UTC+6), so a 02:00 timestamp here is an 08:00 shift start there.',
    '',
  ].join('\n')
}

main().catch((error: unknown) => {
  console.error('[export] failed:', error)
  process.exit(1)
})
