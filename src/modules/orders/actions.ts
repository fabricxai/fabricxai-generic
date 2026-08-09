'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { propose } from '@/modules/core/pending-changes'
import { requireRole } from '@/modules/core/session'

import {
  actualizeMilestone as actualizeMilestoneIn,
  createOrder as createOrderIn,
  generateTna,
  previewRipple,
  saveBreakdown,
  setOrderStatus as setOrderStatusIn,
  type OrderStatus,
} from './service'
import type { RipplePreview } from './tna'

/**
 * 1.3 Order Desk — the write surface (plan 5.1, audit FE-B2 + BE-B6).
 *
 * The services here are complete and were, until now, reachable only from a BullMQ consumer
 * and from the approve inbox's commit handlers. So the product could ADVANCE an order that
 * arrived from a won RFQ or a drafted PO, and could not originate one — and the TNA, which
 * is the artefact a merchandiser opens this screen for, could be read and never moved. The
 * timeline component has had an `onActualize` prop since it was written, with no caller.
 *
 * Thin by contract (CLAUDE.md rule 1): auth → zod → service. The zod lives in the services,
 * which parse their own input, so what these add is the role gate and the revalidation.
 *
 * Roles follow `nav.ts`'s `writeRoles` for `/orders` exactly — merchandiser, commercial,
 * planner — plus the supervisory pair `requireRole` adds. Production reads this screen for
 * dates and the breakdown; it does not change what the buyer ordered.
 */

const WRITERS = ['merchandiser', 'commercial', 'planner'] as const

function refresh(orderId?: string): void {
  revalidatePath('/orders')
  if (orderId) revalidatePath(`/orders/${orderId}`)
}

/**
 * Open an order and its first style.
 *
 * One call, because an order with no style is an order nothing can be cut, costed or
 * planned against — `createOrder` refuses an empty list rather than leaving a shell for
 * somebody to fill in later.
 */
export async function createOrder(input: {
  order: {
    buyerId: string
    poNumbers: string[]
    totalValue?: string
    currency?: string
    plannedExFactoryDate?: string
  }
  styles: {
    styleCode: string
    description?: string
    contractedQty?: number
    unitPrice?: string
    currency?: string
  }[]
}): Promise<{ orderId: string }> {
  const ctx = await requireRole(await headers(), ...WRITERS)

  const result = await createOrderIn(ctx, { order: input.order, styles: input.styles })

  refresh(result.orderId)
  return { orderId: result.orderId }
}

/**
 * What moving this milestone would do to the rest of the schedule.
 *
 * A READ, and it is separate on purpose. Actualising `pp_approval` four days late pushes
 * cutting, sewing and the ship date, and a merchandiser is entitled to see that before they
 * commit it rather than after. The same `previewRipplePure` runs on both sides, so the
 * preview and the write cannot disagree about what happens.
 */
export async function previewMilestoneRipple(input: {
  milestoneId: string
  actualDate: string
}): Promise<RippleView & { milestoneName: string }> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const preview = await previewRipple(ctx, input)

  return { ...rippleView(preview), milestoneName: preview.milestoneName }
}

/**
 * The ripple, as the screen needs it.
 *
 * `readonly` arrays and the module's own `MilestoneChange` do not cross a server-action
 * boundary usefully — what comes back is serialised, and a client component reading a type
 * it cannot import is how a screen ends up trusting a field that is no longer there. This
 * is the flattening, in one place, used by both the preview and the write.
 */
export interface RippleView {
  orderId: string
  /** Every milestone whose planned date moves, with how far. */
  shifted: { name: string; fromDate: string; toDate: string; slipDays: number; critical: boolean }[]
  /** Days the SHIP date moves. Zero when declared slack absorbed the slip entirely. */
  exFactorySlipDays: number
  newExFactoryDate: string | null
  affectsCriticalPath: boolean
}

function rippleView(preview: RipplePreview & { orderId: string }): RippleView {
  return {
    orderId: preview.orderId,
    shifted: preview.changes.map((change) => ({ ...change })),
    exFactorySlipDays: preview.exFactorySlipDays,
    newExFactoryDate: preview.newExFactoryDate,
    affectsCriticalPath: preview.affectsCriticalPath,
  }
}

/**
 * Record that a milestone actually happened.
 *
 * The ripple is recomputed server-side and returned, so the screen reports what the write
 * did rather than what the preview said it would — those agree today and a caller that
 * assumed it would be told otherwise.
 */
export async function actualizeMilestone(input: {
  milestoneId: string
  actualDate: string
}): Promise<RippleView> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const result = await actualizeMilestoneIn(ctx, input)

  refresh(result.orderId)
  // Cutting reads the PP gate this can open, and the floor board reads the dates.
  revalidatePath('/cutting')

  return rippleView(result)
}

/**
 * Replace the colour × size grid.
 *
 * `buyerRevision` decides whether this is a correction or a new revision of what the buyer
 * ordered — and it is the caller's statement of fact, not a convenience. A buyer amendment
 * bumps `activeRevision`, which cutting reads to know what it is cutting to; recording one
 * as a correction would leave the floor cutting to a grid nobody agreed.
 */
export async function saveOrderBreakdown(input: {
  orderStyleId: string
  cells: { color: string; size: string; qty: number }[]
  buyerRevision?: boolean
  reason?: string
  documentId?: string
}): Promise<{
  orderId: string
  revision: number
  totalQty: number
  isNewRevision: boolean
}> {
  const ctx = await requireRole(await headers(), ...WRITERS)

  const result = await saveBreakdown(ctx, {
    orderStyleId: input.orderStyleId,
    cells: input.cells,
    buyerRevision: input.buyerRevision ?? false,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
  })

  refresh(result.orderId)
  // The cut plan is against a revision; a new one changes what the floor should be cutting.
  revalidatePath('/cutting')

  return {
    orderId: result.orderId,
    revision: result.revision,
    totalQty: result.totalQty,
    isNewRevision: result.isNewRevision,
  }
}

/**
 * Propose a buyer's amendment, rather than writing it.
 *
 * The difference from `saveOrderBreakdown` is who signs. A correction — a mistyped cell, a
 * colour entered twice — is the merchandiser's own authority and lands directly. A buyer
 * AMENDMENT changes what the cutting floor cuts to, and it goes through `pending_changes`
 * so a second person reads the diff before the grid moves under a floor that is already
 * working to the old one. `order_breakdowns` has had a commit handler and a registered
 * schema since 1.3 with nothing able to produce a draft for it.
 *
 * `documentId` is the amended PO. Optional, because a buyer amendment arrives by email as
 * often as by document, and refusing the write for want of an attachment would send people
 * back to writing it directly — which is the path with no second signature.
 */
export async function proposeOrderRevision(input: {
  orderStyleId: string
  cells: { color: string; size: string; qty: number }[]
  reason: string
  documentId?: string
}): Promise<{ pendingChangeId: string; status: 'pending' | 'committed' }> {
  const ctx = await requireRole(await headers(), ...WRITERS)

  const result = await propose(ctx, {
    moduleId: 'orders',
    targetTable: 'order_breakdowns',
    /*
     * `insert`, with no `targetId`, and the reason is what the reviewer sees.
     *
     * An amendment replaces a whole grid, so calling it an update and passing the STYLE id
     * as `targetId` would read naturally and break the approve inbox: `draftFields` fetches
     * the before with `currentRow(targetTable, targetId)`, which would look `order_styles`
     * up in `order_breakdowns`, find nothing, and show the reviewer the incoming grid with
     * no sign of the one it replaces. A missing before is honest; a lookup that silently
     * misses is not. Same shape the extraction path already proposes.
     */
    operation: 'insert',
    zodSchemaKey: 'order_revision_v1',
    // A person typed this. No field confidence, because there is no extractor to have had
    // one — and a constant would sail past the check the whole pending flow rests on.
    source: 'user_draft',
    payload: {
      orderStyleId: input.orderStyleId,
      cells: input.cells,
      reason: input.reason,
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
    },
  })

  revalidatePath('/approve')
  return { pendingChangeId: result.id, status: result.status }
}

/**
 * Build or rebuild the schedule from a template.
 *
 * Milestones already actualised are PRESERVED — the count comes back, because regenerating
 * a schedule over real dates would erase what the floor reported. Available from the desk
 * because an order created here has no TNA until somebody asks for one; an order from a won
 * RFQ gets its schedule from the `rfq.won` consumer.
 */
export async function generateOrderTna(input: {
  orderId: string
  templateId: string
  exFactoryDate: string
}): Promise<{ milestones: number; preserved: number } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  // Refusal as a VALUE (lib/action-failure): production masks anything thrown, and a
  // malformed template's "template_invalid" surfaced as React #441 on the live tenant.
  return surfaced(async () => {
    const result = await generateTna(ctx, input)

    refresh(input.orderId)
    return { milestones: result.milestones.length, preserved: result.preserved }
  })
}

/**
 * Move the order's status.
 *
 * Illegal moves are a typed 409 from the machine (rule 5), listing what IS legal — so the
 * screen can say "an order that has shipped in full cannot go back to production" rather
 * than refusing without a reason.
 */
export async function setOrderStatus(input: {
  orderId: string
  status: OrderStatus
}): Promise<{ from: OrderStatus; to: OrderStatus } | ActionFailure> {
  // Surfaced because an illegal transition is a sentence the person needs (rule 5's typed
  // 409), and production masks anything an action throws (live-test finding, Phase 8).
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), ...WRITERS)
    const result = await setOrderStatusIn(ctx, input)

    refresh(input.orderId)
    return result
  })
}
