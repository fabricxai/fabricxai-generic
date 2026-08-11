'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import {
  allocate as allocateIn,
  compareScenario as compareScenarioIn,
  forkScenario as forkScenarioIn,
  moveAllocation as moveAllocationIn,
  proposeScenarioApply as proposeScenarioApplyIn,
  recordSmv as recordSmvIn,
  setAllocationStatus as setAllocationStatusIn,
  upsertLine,
  type AllocateResult,
  type AllocationStatus,
  type PlanningPolicy,
  type ScenarioComparison,
} from './service'

/**
 * 4.1 Capacity & Line Planning — the write surface (plan 5.4, audit FE-S7).
 *
 * The board rendered committed pieces per line-day and offered no way to commit any. Every
 * service here was reachable only from the approve inbox's scenario commit handler, so a
 * planner could see a line was over-committed and could not move the work off it.
 *
 * ## The policy is fetched here, and it is not a default
 *
 * `PlanningPolicy` carries the expected efficiency and the shift length, and there is
 * deliberately **no built-in fallback efficiency** — planning against clock minutes rather
 * than earnable ones is the single most common way a factory over-commits, and a service
 * that invented 100% to keep going would do exactly that. The action fetches the tenant's
 * own numbers because a service never reaches for Settings.
 *
 * ## Nothing writes unless it fits, or somebody says otherwise
 *
 * `allocate` and `moveAllocation` return the violations and write nothing when the plan does
 * not fit. `acceptViolations` is the planner's explicit statement that they are over-
 * committing on purpose, and it is stored on the row so the next reader knows the overload
 * was a decision rather than an accident.
 */

const WRITERS = ['planner', 'merchandiser'] as const

function refresh(): void {
  revalidatePath('/planning')
  // The line board and the order desk both read what is committed to a line.
  revalidatePath('/lines')
  revalidatePath('/orders')
}

/**
 * Put a sewing line on the board — creating its floor and factory unit if they are new.
 *
 * `lines` was read by five screens and written by the seed alone, so a factory that opened
 * a new line could not record it and a factory that had never been seeded had no board at
 * all. Owner and admin as well as planner, because this is also the day-one act of drawing
 * the factory's own shape.
 */
export async function saveLine(input: {
  code: string
  name: string
  capacityManpower?: number
  machinesCount?: number
  floorId?: string
  floor?: { code: string; name: string; factoryUnitId?: string; factoryUnit?: { code: string; name: string } }
  isActive?: boolean
}): Promise<{ lineId: string; floorId: string; created: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS, 'owner', 'admin')
  return surfaced(async () => {
    const result = await upsertLine(ctx, input)
    refresh()
    return result
  })
}

/**
 * Put an order on a line.
 *
 * `preview` is not a parameter here on purpose — `allocate` writes only when the plan fits
 * or the violations are accepted, so a caller that wants to look first calls it without
 * `acceptViolations` and reads the result. Two code paths for "check" and "do" is how a
 * preview and a write end up disagreeing.
 */
export async function allocate(input: {
  orderId: string
  orderStyleId?: string
  lineId: string
  startDate: string
  endDate: string
  plannedDaily: Record<string, number>
  acceptViolations?: boolean
  productType?: string
}): Promise<AllocateResult> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<PlanningPolicy>(ctx, 'planning')

  const result = await allocateIn(
    ctx,
    {
      orderId: input.orderId,
      ...(input.orderStyleId === undefined ? {} : { orderStyleId: input.orderStyleId }),
      lineId: input.lineId,
      startDate: input.startDate,
      endDate: input.endDate,
      plannedDaily: input.plannedDaily,
    },
    {
      policy,
      ...(input.acceptViolations === undefined
        ? {}
        : { acceptViolations: input.acceptViolations }),
      ...(input.productType === undefined ? {} : { productType: input.productType }),
    },
  )

  if (result.allocationId) refresh()
  return result
}

/**
 * Move an allocation, or reshape its days.
 *
 * `preview: true` asks what would happen without doing it — the one place a preview flag is
 * right, because moving work off an overloaded line is a decision made by comparing two
 * boards, and a planner should be able to see the second one before committing to it.
 */
export async function moveAllocation(input: {
  allocationId: string
  lineId?: string
  startDate: string
  endDate: string
  plannedDaily: Record<string, number>
  preview?: boolean
  acceptViolations?: boolean
  productType?: string
}): Promise<AllocateResult> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<PlanningPolicy>(ctx, 'planning')

  const result = await moveAllocationIn(ctx, { ...input, policy })

  if (!input.preview) refresh()
  return result
}

/**
 * planned → active → done, and never backwards.
 *
 * The machine refuses the rest with a typed 409 (rule 5). An allocation moved back to
 * `planned` after the line has started on it would put work back on a board that is already
 * being cut to.
 */
export async function setAllocationStatus(input: {
  allocationId: string
  status: AllocationStatus
}): Promise<void> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  await setAllocationStatusIn(ctx, input)

  refresh()
}

/**
 * Copy the live board into a scenario nobody is working to yet.
 *
 * The point of a fork is that the floor keeps running to the current plan while a planner
 * tries a different one — so this writes a `scenarios` row and touches no allocation. What
 * turns it into the plan is `proposeScenarioApply`, and that goes through the approve inbox.
 */
export async function forkScenario(input: {
  name: string
  lineIds?: string[]
  from?: string
  to?: string
}): Promise<{ scenarioId: string; allocationCount: number }> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const result = await forkScenarioIn(ctx, input)

  refresh()
  return result
}

/**
 * What this scenario does to the board, against what is committed now.
 *
 * A read. `compareScenario` needs a COMPLETE policy — both the efficiency and the shift
 * length — because a comparison run against different assumptions on each side is not a
 * comparison. The defaults filled in here are the ones the seeded policy ships with, and
 * they are stated rather than hidden so a factory that has set neither can still look.
 */
export async function compareScenario(input: {
  scenarioId: string
}): Promise<ScenarioComparison> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<PlanningPolicy>(ctx, 'planning')

  return compareScenarioIn(ctx, {
    scenarioId: input.scenarioId,
    policy: completePolicy(policy),
  })
}

/**
 * Send a scenario to the approve inbox.
 *
 * Applying a scenario re-plans lines the floor is already working to, which is why it is the
 * one planning operation that needs a second signature — and why the ASSUMPTIONS travel on
 * the draft. Approval re-runs the overload check against the board as it is at approve time,
 * and re-running it against whatever the company default happens to be by then would check a
 * different plan from the one the planner submitted.
 */
export async function proposeScenarioApply(input: {
  scenarioId: string
}): Promise<{ pendingChangeId: string }> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<PlanningPolicy>(ctx, 'planning')

  const result = await proposeScenarioApplyIn(ctx, {
    scenarioId: input.scenarioId,
    policy: completePolicy(policy),
  })

  revalidatePath('/approve')
  refresh()
  return result
}

/**
 * Record a style's SMV.
 *
 * Every capacity promise in this module is computed from it, and planning REFUSES a style
 * with no record rather than assuming one — "about twelve minutes" is a ship date. So this
 * is the way the number gets in when there is no IE sheet to extract from.
 */
export async function recordSmv(input: {
  styleCode: string
  smv: string
  source: 'ie_study' | 'estimate'
  measuredAt?: string
}): Promise<{ smvRecordId: string }> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const result = await recordSmvIn(ctx, input)

  refresh()
  return result
}

/**
 * The two assumptions a comparison cannot run without.
 *
 * Stated here rather than defaulted inside the capacity maths, which refuses to invent an
 * efficiency for exactly the right reason. These are the seeded policy's own values, so a
 * factory that has configured neither sees the same numbers the rest of the module uses —
 * and one that has configured them sees theirs.
 */
function completePolicy(policy: PlanningPolicy): Required<PlanningPolicy> {
  return {
    defaultEfficiencyPct: policy.defaultEfficiencyPct ?? '60',
    defaultShiftMinutes: policy.defaultShiftMinutes ?? 480,
  }
}
