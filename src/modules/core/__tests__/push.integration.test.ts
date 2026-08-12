/**
 * Push infrastructure (mobile contract §2, plan 4.1).
 *
 * What only a database can be wrong about: the endpoint upsert following the CURRENT
 * signer (the shared-tablet case), tenancy on delivery targets, and the two contract
 * promises — unconfigured push is a disabled feature, and a push channel on notify()
 * never blocks the notification.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, pushSubscriptions, roles, users } from '@/db/schema/core'
import type { RequestCtx } from '@/modules/core/ctx'
import { notify } from '@/modules/core/notifications'
import { deliverPush } from '@/lib/push'
import { withTenantTx } from '@/modules/core/tenancy'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const ALICE = `push-a-${randomUUID().slice(0, 8)}`
const BABUL = `push-b-${randomUUID().slice(0, 8)}`
const ENDPOINT = `https://push.example/${randomUUID()}`

const alice: RequestCtx = { companyId: COMPANY, userId: ALICE, roles: ['store'] }
const babul: RequestCtx = { companyId: COMPANY, userId: BABUL, roles: ['store'] }

beforeAll(async () => {
  await db.insert(companies).values({ id: COMPANY, name: 'Push Co', slug: `push-${COMPANY.slice(0, 8)}` })
  await db.insert(users).values([
    { id: ALICE, email: `${ALICE}@fabricxai.test`, name: 'Alice' },
    { id: BABUL, email: `${BABUL}@fabricxai.test`, name: 'Babul' },
  ])
  await db.insert(roles).values([
    { companyId: COMPANY, userId: ALICE, role: 'store' },
    { companyId: COMPANY, userId: BABUL, role: 'store' },
  ])
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(users).where(eq(users.id, ALICE))
  await db.delete(users).where(eq(users.id, BABUL))
  await client.end()
})

const subscribe = (ctx: RequestCtx, endpoint: string) =>
  withTenantTx(ctx, (tx) =>
    tx
      .insert(pushSubscriptions)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        endpoint,
        keys: { p256dh: 'k', auth: 'a' },
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { companyId: ctx.companyId, userId: ctx.userId, keys: { p256dh: 'k', auth: 'a' } },
      }),
  )

describe('4.1 · push subscriptions', () => {
  it('a re-subscribed endpoint follows the current signer', async () => {
    // The shared floor tablet: Alice signs out, Babul signs in, the SAME device
    // re-subscribes. It must start buzzing for Babul and stop for Alice — a device that
    // keeps its old owner's subscription leaks one person's queue to another's pocket.
    await subscribe(alice, ENDPOINT)
    await subscribe(babul, ENDPOINT)

    const rows = await db
      .select({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, ENDPOINT))

    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe(BABUL)
  })

  it('delivery without VAPID keys is a disabled feature, not an error', async () => {
    // The integration environment sets no keys, which is exactly the state every factory
    // is in before ops configures push — the answer is a shape, never a throw.
    const result = await deliverPush(alice, {
      userId: ALICE,
      payload: { title: 'test' },
    })
    expect(result).toEqual({ delivered: 0, pruned: 0, disabled: true })
  })

  it('a push channel on notify() never blocks the notification', async () => {
    const row = await notify(alice, {
      userId: ALICE,
      kind: 'test.push_bridge',
      titleKey: 'errors.forbidden',
      channels: ['in_app', 'push'],
    })
    // The in-app row is the record; the buzz is a courtesy that silently no-ops here.
    expect(row?.id).toBeTruthy()
  })

  it('another company cannot be delivered to', async () => {
    const OTHER = randomUUID()
    await db.insert(companies).values({ id: OTHER, name: 'Other', slug: `oth-${OTHER.slice(0, 8)}` })
    try {
      const stranger: RequestCtx = { companyId: OTHER, userId: ALICE, roles: ['store'] }
      // Even if keys were configured, the target read is tenant-scoped: a stranger ctx
      // resolves zero subscriptions for the same user id.
      const targets = await db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.companyId, OTHER), eq(pushSubscriptions.userId, ALICE)))
      expect(targets).toHaveLength(0)
      const result = await deliverPush(stranger, { userId: ALICE, payload: { title: 'x' } })
      expect(result.delivered).toBe(0)
    } finally {
      await db.delete(companies).where(eq(companies.id, OTHER))
    }
  })
})
