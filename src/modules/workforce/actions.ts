'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import {
  activateGazette,
  approvePayrollRun,
  computePayrollRun,
  importDeviceAttendance,
  uploadGazette,
  upsertWorker,
} from './service'

/**
 * Compute a payroll period.
 *
 * Recomputable until it is approved, deliberately: attendance corrections arrive late, and
 * a run that had to be deleted and rebuilt would lose the record of what was computed
 * before. The state machine allows `computed → computed` for exactly that.
 *
 * Access is checked in the service, not here, and it throws with an EMPTY body — telling a
 * `member` "you need hr or owner" confirms the endpoint exists and names the role worth
 * phishing for.
 */
export async function runPayroll(input: {
  period: string
  festival?: string | null
}): Promise<
  { runId: string; lines: number; totalNet: string; flagged: number } | ActionFailure
> {
  const ctx = await requireRole(await headers(), 'hr')
  return surfaced(async () => {
    const result = await computePayrollRun(ctx, {
      period: input.period,
      ...(input.festival ? { festival: input.festival } : {}),
    })

    revalidatePath('/workforce')
    return result
  })
}

/**
 * Approve a run — the owner's signature.
 *
 * Computing is HR's job; signing off what two thousand people are paid is the owner's, and
 * the service enforces that separately from payroll access. After approval the figures are
 * fixed: a change means a fresh period adjustment, not an edit, because a payslip already
 * handed to somebody cannot be quietly rewritten.
 */
export async function approveRun(input: {
  runId: string
}): Promise<{ from: string; to: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'hr')
  return surfaced(async () => {
    const result = await approvePayrollRun(ctx, input.runId)

    revalidatePath('/workforce')
    return { from: String(result.from), to: String(result.to) }
  })
}

/**
 * Record a new wage gazette.
 *
 * Versioned and dated, never edited. The gazette is law: a payroll run computed under the
 * 2023 grades was correct under the 2023 grades, and rewriting the table in place would
 * retroactively make every historic payslip wrong.
 */
export async function recordGazette(input: {
  version: string
  effectiveFrom: string
  grades: { grade: string; basic: string; houseRent: string; medical: string; transport: string; food: string }[]
}): Promise<{ gazetteId: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'hr')
    const result = await uploadGazette(ctx, input)
    revalidatePath('/workforce')
    return result
  })
}

/** Make a recorded gazette the one payroll computes against. */
export async function makeGazetteActive(input: { gazetteId: string }): Promise<void | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'hr')
    await activateGazette(ctx, input.gazetteId)
    revalidatePath('/workforce')
  })
}

/**
 * Import a biometric device's attendance export (live-test finding, Phase 9).
 *
 * The screen parses the device's own CSV dialect and sends normalised rows; the service
 * refuses the whole file on any employee number the register does not know. hr only —
 * attendance is a wage input, and the payroll gate below is the model.
 */
export async function importAttendance(input: {
  rows: {
    employeeNo: string
    date: string
    in?: string
    out?: string
    status: 'present' | 'absent' | 'leave' | 'holiday'
    exception?: string
    otHours: string
  }[]
}): Promise<
  | { imported: number; exceptions: { employeeNo: string; date: string; exception: string }[] }
  | ActionFailure
> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'hr')
    const result = await importDeviceAttendance(ctx, input)
    revalidatePath('/workforce')
    return result
  })
}

/**
 * Register a worker, or update one already on the roster.
 *
 * The absence this closes is total: nothing anywhere created a worker, so a new factory had
 * no attendance to import against — `importAttendance` refuses the whole file on an unknown
 * employee number, and every number was unknown — and therefore no payroll, ever. The
 * screen said "No workers on file" and offered nothing to change it.
 *
 * hr, plus owner and admin for the person setting the factory up on day one. Not the
 * payroll gate: registering somebody is not seeing what they are paid, and putting the
 * roster behind the wage wall is what would push a factory back to the spreadsheet.
 */
export async function saveWorker(input: {
  employeeNo: string
  name: string
  nameBn?: string
  grade: string
  designation?: string
  section?: string
  lineId?: string
  joinDate: string
  exitDate?: string
  disbursementType?: 'bank' | 'bkash' | 'nagad' | 'cash'
  disbursementRef?: string
  status?: 'active' | 'on_leave' | 'exited'
}): Promise<{ workerId: string; created: boolean } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'hr', 'owner', 'admin')
    const result = await upsertWorker(ctx, input)
    revalidatePath('/workforce')
    return result
  })
}
