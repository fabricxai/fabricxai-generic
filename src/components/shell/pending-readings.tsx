import { headers } from 'next/headers'

import { myUnconfirmedDrafts } from '@/modules/approvals/queries'
import { getCtx } from '@/modules/core/session'

import { ConfirmReading } from './confirm-reading'

/**
 * Readings waiting on the person who asked for them.
 *
 * The server half of the confirm step: fetches this person's `drafted` rows and hands them
 * to the dialog. Renders nothing when there are none — a permanently empty "check your
 * readings" box would be furniture on every screen that mounts it.
 *
 * Mounted beside `RaisedDrafts` and deliberately ABOVE it: an unconfirmed reading is
 * something to do, and a raised draft is something to know. The two are the same person's
 * view of the same pipeline at its two ends.
 */
export async function PendingReadings() {
  const ctx = await getCtx(await headers())
  if (!ctx) return null

  const drafts = await myUnconfirmedDrafts(ctx, 5)
  if (drafts.length === 0) return null

  return (
    <ConfirmReading
      drafts={drafts.map((d) => ({
        id: d.id,
        moduleId: d.moduleId,
        targetTable: d.targetTable,
        model: d.model,
        fields: d.fields,
      }))}
    />
  )
}
