/**
 * Session 3b services against real infrastructure: MinIO, Redis/BullMQ, Postgres.
 *
 * These are the pieces that are easy to write and easy to get subtly wrong — a presigned
 * URL that does not actually work, an "idempotent" replay that inserts twice, a relay
 * that marks events published before delivering them. None of that shows up in a
 * typecheck, so it gets exercised for real here.
 */
import { randomUUID } from 'node:crypto'

import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, notifications, offlineKeys, outbox, users } from '@/db/schema/core'
import type { RequestCtx } from '@/modules/core/ctx'
import { AppError } from '@/modules/core/errors'
import { createDownloadUrl, createUploadUrl, confirmUpload } from '@/modules/core/documents'
import { dismiss, notify, listUnread, markRead } from '@/modules/core/notifications'
import {
  __resetSyncHandlers,
  registerSyncHandler,
  refusedRows,
  refusedSummary,
  syncBatch,
} from '@/modules/core/offline-sync'
import { emit } from '@/modules/core/outbox'
import { withTenantTx } from '@/modules/core/tenancy'
import { relayOnce } from '@/worker/processors/outbox-relay'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
/** A second tenant, so the report's tenancy can be asked rather than assumed. */
const OTHER = randomUUID()
const USER = `svc-user-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }
/** A second person in the same company, for the alerts that are addressed by name. */
const OTHER_USER = `svc-other-${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  await db
    .insert(companies)
    .values([
      { id: COMPANY, name: 'Services Co', slug: `svc-${COMPANY.slice(0, 8)}` },
      { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
    ])
    .onConflictDoNothing()
  await db
    .insert(users)
    .values([
      { id: USER, email: `${USER}@fabricxai.test`, name: 'Service Tester' },
      { id: OTHER_USER, email: `${OTHER_USER}@fabricxai.test`, name: 'Somebody Else' },
    ])
    .onConflictDoNothing()

  await db.execute(sql`
    create table if not exists demo_sync_rows (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete cascade,
      note text not null
    )`)
  await db.execute(sql`alter table demo_sync_rows enable row level security`)
  await db.execute(sql`alter table demo_sync_rows force row level security`)
  await db.execute(sql`drop policy if exists demo_sync_tenant on demo_sync_rows`)
  await db.execute(sql`
    create policy demo_sync_tenant on demo_sync_rows for all to fabricxai_app
      using (company_id = app.current_company_id())
      with check (company_id = app.current_company_id())`)
  await db.execute(sql`grant select, insert, update, delete on demo_sync_rows to fabricxai_app`)
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(inArray(users.id, [USER, OTHER_USER]))
  await db.execute(sql`drop table if exists demo_sync_rows`)
  __resetSyncHandlers()
  await client.end()
})

describe('documents · MinIO round trip', () => {
  it('presigned upload and download actually work against real storage', async () => {
    const body = Buffer.from('%PDF-1.4 pretend buyer PO\n')

    const { documentId, uploadUrl } = await createUploadUrl(ctx, {
      filename: 'buyer-po.pdf',
      mimeType: 'application/pdf',
      sizeBytes: body.byteLength,
      kind: 'buyer_po',
    })

    // A presigned URL that has never been exercised is a guess, not a feature.
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'content-length': String(body.byteLength) },
      body,
    })
    expect(put.status, await put.text()).toBe(200)

    const confirmed = await confirmUpload(ctx, documentId)
    expect(confirmed.status).toBe('ready')
    // Size comes from storage, not from what the client claimed.
    expect(confirmed.sizeBytes).toBe(body.byteLength)

    const { url } = await createDownloadUrl(ctx, documentId)
    const got = await fetch(url)
    expect(got.status).toBe(200)
    expect(Buffer.from(await got.arrayBuffer())).toEqual(body)
  })

  it('refuses a disallowed mime type and an oversized upload', async () => {
    await expect(
      createUploadUrl(ctx, {
        filename: 'payload.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ messageKey: 'errors.document_type_not_allowed' })

    await expect(
      createUploadUrl(ctx, {
        filename: 'huge.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 40 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ messageKey: 'errors.document_too_large' })
  })

  it('marks a document failed when the bytes never arrived', async () => {
    const { documentId } = await createUploadUrl(ctx, {
      filename: 'never-uploaded.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
    })

    // Confirm without ever PUTting — the row must not be allowed to claim 'ready'.
    await expect(confirmUpload(ctx, documentId)).rejects.toMatchObject({
      messageKey: 'errors.document_not_uploaded',
    })
  })
})

describe('notifications · dedupe makes jobs re-runnable', () => {
  it('collapses repeats on dedupeKey but keeps distinct ones', async () => {
    const dedupeKey = `test:lc-expiry:${randomUUID()}`

    const first = await notify(ctx, {
      userId: USER,
      kind: 'lc.expiry_near',
      severity: 'critical',
      titleKey: 'notifications.lc.expiry_near.title',
      params: { daysLeft: 6 },
      dedupeKey,
    })
    expect(first).not.toBeNull()

    // The nightly scan runs again and re-emits the same thing.
    const second = await notify(ctx, {
      userId: USER,
      kind: 'lc.expiry_near',
      titleKey: 'notifications.lc.expiry_near.title',
      dedupeKey,
    })
    expect(second).toBeNull()

    const rows = await db.select().from(notifications).where(eq(notifications.companyId, COMPANY))
    expect(rows.filter((r) => r.dedupeKey === dedupeKey)).toHaveLength(1)
  })

  it('lists unread and marks read', async () => {
    await notify(ctx, {
      userId: USER,
      kind: 'system.test',
      titleKey: 'notifications.system.test.title',
    })

    const unread = await listUnread(ctx)
    expect(unread.length).toBeGreaterThan(0)

    const marked = await markRead(ctx, unread.map((n) => n.id))
    expect(marked).toBe(unread.length)
    // Marking again is a no-op — the first read time is the one that matters.
    expect(await markRead(ctx, unread.map((n) => n.id))).toBe(0)
  })

  it('will not let one person clear another person’s alert', async () => {
    /*
     * `listUnread` scoped to the recipient and `markRead` scoped only to the company, so any
     * signed-in person could mark any alert in the factory read — including one addressed to
     * somebody else BY NAME. Hard to reach (ids are uuids and you only receive your own) and
     * still the wrong wall: an alert somebody else cleared is one its owner never sees, and
     * the LC countdown and the UD expiry both arrive this way.
     */
    const [addressed] = await db
      .insert(notifications)
      .values({
        companyId: COMPANY,
        userId: OTHER_USER,
        kind: 'system.private',
        titleKey: 'notifications.system.test.title',
        severity: 'info',
      })
      .returning({ id: notifications.id })

    // A colleague in the same company, holding a role the alert was not sent to.
    const colleague: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['store'] }

    expect(await markRead(colleague, [addressed!.id])).toBe(0)
    expect(await dismiss(colleague, [addressed!.id])).toBe(0)

    const [row] = await db.select().from(notifications).where(eq(notifications.id, addressed!.id))
    expect(row?.readAt, 'still unread for the person it was for').toBeNull()
    expect(row?.dismissedAt).toBeNull()

    // And its owner can still clear it.
    const owner: RequestCtx = { companyId: COMPANY, userId: OTHER_USER, roles: ['store'] }
    expect(await markRead(owner, [addressed!.id])).toBe(1)
  })

  it('lets a role-addressed alert be cleared by anyone holding that role', async () => {
    // The other half: a notification sent to `role: 'store'` belongs to whoever is on that
    // desk today, and clearing it is the whole point of addressing a role rather than a name.
    const [toRole] = await db
      .insert(notifications)
      .values({
        companyId: COMPANY,
        role: 'store',
        kind: 'system.desk',
        titleKey: 'notifications.system.test.title',
        severity: 'info',
      })
      .returning({ id: notifications.id })

    const storekeeper: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['store'] }
    expect(await markRead(storekeeper, [toRole!.id])).toBe(1)
  })
})

describe('offline sync · replay is a no-op', () => {
  it('applies once and returns the same row on replay', async () => {
    __resetSyncHandlers()
    let handlerCalls = 0

    registerSyncHandler('__demo__', 'record_note', { roles: ['store'] }, async (c, tx, row) => {
      handlerCalls += 1
      const result = await tx.execute<{ id: string }>(
        sql`insert into demo_sync_rows (company_id, note) values (${c.companyId}, ${String(row.payload.note)}) returning id`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return { rowId: (rows[0] as { id: string }).id }
    })

    const batch = [
      {
        offlineKey: `ok-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'record_note',
        payload: { note: 'line 3 hour 14' },
      },
    ]

    const first = await syncBatch(ctx, batch)
    expect(first[0]?.status).toBe('applied')
    const rowId = (first[0] as { rowId: string }).rowId

    // The tablet lost the response and sent the whole batch again.
    const replay = await syncBatch(ctx, batch)
    expect(replay[0]?.status).toBe('duplicate')
    // Same row returned, so the device reconciles against what actually landed.
    expect((replay[0] as { rowId: string }).rowId).toBe(rowId)

    expect(handlerCalls).toBe(1)

    const count = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from demo_sync_rows where company_id = ${COMPANY}`,
    )
    const rows = Array.isArray(count) ? count : ((count as { rows?: unknown[] }).rows ?? [])
    expect(Number((rows[0] as { n: string }).n)).toBe(1)
  })

  it('rejects an unknown operation without poisoning the rest of the batch', async () => {
    const results = await syncBatch(ctx, [
      {
        offlineKey: `bad-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'not_registered',
        payload: {},
      },
      {
        offlineKey: `good-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'record_note',
        payload: { note: 'still lands' },
      },
    ])

    // One bad row must not discard the operator's other forty-nine.
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('applied')
  })

  it('remembers a rejection so a replay is not retried forever', async () => {
    const offlineKey = `fail-${randomUUID()}`
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'always_fails', { roles: ['store'] }, async () => {
      throw new Error('handler blew up')
    })

    const row = {
      offlineKey,
      moduleId: '__demo__',
      operation: 'always_fails',
      payload: {},
    }

    const first = await syncBatch(ctx, [row])
    expect(first[0]?.status).toBe('rejected')

    const replay = await syncBatch(ctx, [row])
    expect(replay[0]?.status).toBe('rejected')

    const ledger = await db.select().from(offlineKeys).where(eq(offlineKeys.offlineKey, offlineKey))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.status).toBe('rejected')
  })

  it('refuses a caller without the handler’s role — and does NOT remember it as terminal', async () => {
    // BE-H4: /api/sync is the one door for every floor write, and until this gate any
    // authenticated member could issue bonded stock or record the feedback that opens
    // the PP gate. A role refusal is a verdict on the CALLER, not the row: the same key
    // replayed after the role is granted must apply.
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'record_note', { roles: ['store'] }, async (c, tx, row) => {
      const result = await tx.execute<{ id: string }>(
        sql`insert into demo_sync_rows (company_id, note) values (${c.companyId}, ${String(row.payload.note)}) returning id`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return { rowId: (rows[0] as { id: string }).id }
    })

    const clerk: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['hr'] }
    const row = {
      offlineKey: `role-${randomUUID()}`,
      moduleId: '__demo__',
      operation: 'record_note',
      payload: { note: 'entered by the wrong badge' },
    }

    const refused = await syncBatch(clerk, [row])
    expect(refused[0]).toMatchObject({ status: 'rejected', errorKey: 'errors.sync_role_forbidden' })

    // No offline_keys row was burned by the refusal …
    const ledger = await db
      .select()
      .from(offlineKeys)
      .where(eq(offlineKeys.offlineKey, row.offlineKey))
    expect(ledger).toHaveLength(0)

    // … so the SAME key applies once the operator holds the role.
    const storekeeper: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['store'] }
    const applied = await syncBatch(storekeeper, [row])
    expect(applied[0]?.status).toBe('applied')
  })
})

describe('offline sync · the refused rows are a record, not a badge (plan 4.5)', () => {
  /*
   * A floor write has three outcomes and only one of them loses work. Applied and duplicate
   * both end with the row in a table; refused ends with it on a tablet behind a Dismiss
   * link, and Dismiss deletes it. So a challan counted at the delivery bay and refused for a
   * UD balance existed nowhere the moment somebody tapped that link.
   *
   * The ledger always held the refusal. What it did not hold was WHAT was refused, which is
   * the difference between telling a storekeeper a GRN was lost and letting them enter it
   * again.
   */
  const since = new Date(Date.now() - 86_400_000)

  it('keeps the payload of a refused row, and only of a refused row', async () => {
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'always_fails', { roles: ['store'] }, async () => {
      throw new AppError('validation_failed', 'demo.errors.no', { challan: 'CH-8841' })
    })
    registerSyncHandler('__demo__', 'record_note', { roles: ['store'] }, async (c, tx, row) => {
      const result = await tx.execute<{ id: string }>(
        sql`insert into demo_sync_rows (company_id, note) values (${c.companyId}, ${String(row.payload.note)}) returning id`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return { rowId: (rows[0] as { id: string }).id }
    })

    const refusedKey = `pl-bad-${randomUUID()}`
    const appliedKey = `pl-ok-${randomUUID()}`

    await syncBatch(ctx, [
      {
        offlineKey: refusedKey,
        moduleId: '__demo__',
        operation: 'always_fails',
        payload: { challanNo: 'CH-8841', lines: [{ item: 'FAB-1', qty: '500.00' }] },
      },
      {
        offlineKey: appliedKey,
        moduleId: '__demo__',
        operation: 'record_note',
        payload: { note: 'this one landed' },
      },
    ])

    const [refusedLedger] = await db
      .select()
      .from(offlineKeys)
      .where(eq(offlineKeys.offlineKey, refusedKey))
    expect(refusedLedger?.payload).toMatchObject({ challanNo: 'CH-8841' })

    // Not on the applied path. That row is already in its own table, and copying every
    // floor write into a second place would double the write cost of the busiest endpoint
    // in the product to record something already recorded.
    const [appliedLedger] = await db
      .select()
      .from(offlineKeys)
      .where(eq(offlineKeys.offlineKey, appliedKey))
    expect(appliedLedger?.status).toBe('applied')
    expect(appliedLedger?.payload).toBeNull()
  })

  it('reports each refusal with its reason and both clocks', async () => {
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'always_fails', { roles: ['store'] }, async () => {
      throw new AppError('validation_failed', 'demo.errors.no', {})
    })

    const capturedAt = '2026-08-01T04:30:00.000Z'
    await syncBatch(ctx, [
      {
        offlineKey: `rep-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'always_fails',
        payload: { note: 'counted at the bay' },
        clientRecordedAt: capturedAt,
      },
    ])

    const rows = await refusedRows(ctx, { since })
    const mine = rows.find((r) => r.operation === 'always_fails')

    expect(mine?.error).toMatchObject({ messageKey: 'demo.errors.no' })
    expect(mine?.payload).toMatchObject({ note: 'counted at the bay' })
    // Both, because they can be days apart — a tablet that spent a weekend offline captured
    // on Friday and was refused on Monday, and one clock alone files it against the wrong day.
    expect(mine?.capturedAt?.toISOString()).toBe(capturedAt)
    expect(mine?.refusedAt).toBeInstanceOf(Date)
  })

  it('groups per day per handler, with the distinct reasons behind the count', async () => {
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'grouped', { roles: ['store'] }, async (_c, _tx, row) => {
      throw new AppError('validation_failed', String(row.payload.why), {})
    })

    await syncBatch(
      ctx,
      ['demo.errors.a', 'demo.errors.a', 'demo.errors.b'].map((why) => ({
        offlineKey: `grp-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'grouped',
        payload: { why },
      })),
    )

    const bucket = (await refusedSummary(ctx, { since })).find((b) => b.operation === 'grouped')

    // "store refused 14" is a number. "store / receive_grn refused 14, all of them
    // ud_balance.insufficient" is a morning's work with a cause attached.
    expect(bucket?.refused).toBe(3)
    expect([...(bucket?.reasons ?? [])].sort()).toEqual(['demo.errors.a', 'demo.errors.b'])
    expect(bucket?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows another company nothing', async () => {
    __resetSyncHandlers()
    registerSyncHandler('__demo__', 'always_fails', { roles: ['store'] }, async () => {
      throw new AppError('validation_failed', 'demo.errors.no', {})
    })
    await syncBatch(ctx, [
      {
        offlineKey: `ten-${randomUUID()}`,
        moduleId: '__demo__',
        operation: 'always_fails',
        payload: { note: 'ours' },
      },
    ])

    const outsider: RequestCtx = { companyId: OTHER, userId: USER, roles: ['store'] }
    expect(await refusedRows(outsider, { since })).toEqual([])
    expect(await refusedSummary(outsider, { since })).toEqual([])
  })

  it('does not reach back past the window it was asked for', async () => {
    // The report says "last 14 days" on the screen. A query that ignored `since` would show
    // a refusal from March under this month's heading.
    const future = new Date(Date.now() + 86_400_000)

    expect(await refusedRows(ctx, { since: future })).toEqual([])
    expect(await refusedSummary(ctx, { since: future })).toEqual([])
  })
})

describe('outbox relay · at-least-once delivery', () => {
  it('delivers an event to BullMQ and marks it published exactly once', async () => {
    const eventId = await withTenantTx(ctx, (tx) =>
      emit(ctx, tx, {
        eventName: 'core.test.relayed',
        payload: { hello: 'floor' },
        aggregateTable: 'demo_sync_rows',
        aggregateId: randomUUID(),
      }),
    )

    const [before] = await db.select().from(outbox).where(eq(outbox.id, eventId))
    expect(before?.publishedAt).toBeNull()

    /*
     * Relay until THIS event is published, rather than once.
     *
     * `relayOnce` takes a batch of 100 oldest-first, so a single pass only reaches an event
     * emitted just now when the unpublished backlog is smaller than a batch. That made this
     * test pass on a clean database and fail on a real one — it failed after a session of
     * seeding and screen work left 84 events behind, and would fail in CI the moment the
     * seed grows. The assertion is about at-least-once delivery, not about batch size.
     */
    let relayed = 0
    for (let pass = 0; pass < 50; pass += 1) {
      const result = await relayOnce()
      relayed += result.relayed
      const [row] = await db.select().from(outbox).where(eq(outbox.id, eventId))
      if (row?.publishedAt) break
      // Nothing left to relay and still unpublished is a real failure, not a short batch.
      if (result.relayed === 0) break
    }
    expect(relayed).toBeGreaterThan(0)

    const [after] = await db.select().from(outbox).where(eq(outbox.id, eventId))
    expect(after?.publishedAt).not.toBeNull()

    // A second pass must not re-deliver an already-published event.
    const [firstRow] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, eventId))
    const publishedAt = firstRow?.publishedAt
    await relayOnce()
    const [again] = await db.select().from(outbox).where(eq(outbox.id, eventId))
    expect(again?.publishedAt).toEqual(publishedAt)
  })
})
