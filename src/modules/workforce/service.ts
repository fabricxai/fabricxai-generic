/**
 * 10.1 Workforce & Wage Engine — service layer ⚖ 🔒
 *
 * Two things make this module different from every other one:
 *
 * **The gazette is uploaded, not coded.** `uploadGazette` takes whatever grade table the
 * factory transcribes from its government notification; `activateGazette` makes it the
 * live one from a given period. A payroll run pins the gazette id it used, so recomputing
 * June next year — after two wage revisions — reproduces June's figures exactly.
 *
 * **Access is hr + owner, and a refusal says nothing.** Everyone else gets a 403 with no
 * body: not "forbidden: payroll_lines", not a count, not a shape. A refusal that leaks
 * the shape of the data tells an attacker what exists and tells a curious colleague what
 * to ask for. Every successful read of `payroll_lines` is audited (rule 9).
 */
import { asc, desc, eq, lte, ne, sql } from 'drizzle-orm'

import { recordChange, recordRead, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx, Role } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { type TenantDb, withTenantRead, withTenantTx } from '../core/tenancy'

import { WORKFORCE_EVENTS } from './events'
import {
  computePayroll,
  PayrollError,
  totalNet,
  type PayrollLine,
  type PayrollRules,
  type WageGrade,
  type WorkerPayrollInput,
} from './payroll'
import {
  attendance,
  leaves,
  payrollLines,
  payrollRuns,
  wageGazettes,
  wageGrades,
  workers,
} from './schema'
import { attendanceImport, gazetteUpload, payrollRules } from './zod'

registerAuditedTables('payroll_runs', 'payroll_lines', 'wage_gazettes', 'workers', 'attendance')

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 Access
// ─────────────────────────────────────────────────────────────────────────────

/** Only these two roles ever see a wage figure (brief §Roles). */
const PAYROLL_ROLES: readonly Role[] = ['hr', 'owner']

/**
 * The 🔒 gate. Throws a 403 carrying NOTHING — no message key, no details, no hint that
 * the thing being refused is payroll at all.
 *
 * That emptiness is the point and it is why this does not use the shared `forbidden()`
 * helper, which attaches the roles it wanted. Telling a `member` "you need hr or owner"
 * confirms the endpoint exists and names the role worth phishing. PLAYBOOK §3 requires a
 * test proving this body is empty.
 */
export function assertPayrollAccess(ctx: AnyCtx): void {
  if (PAYROLL_ROLES.some((role) => ctx.roles.includes(role))) return
  throw new AppError('forbidden', '', {}, 'payroll access denied')
}

/**
 * A wage gazette's life (audit BE-M1).
 *
 * Uploaded as `draft` because transcribing a government notification is exactly the kind of
 * typing that needs a second pair of eyes; activated when it takes effect; superseded when a
 * newer one does. Superseded is NOT "no longer applies" — the old gazette still governs
 * every period before the new one's effective date, which is why completed runs pin the
 * gazette id they were computed against.
 */
export const gazetteMachine = defineStateMachine({
  field: 'status',
  initial: 'draft',
  transitions: {
    draft: ['active'],
    active: ['superseded'],
    // Terminal: a superseded gazette is history, and history is what recomputing June next
    // year depends on.
    superseded: [],
  },
})

export type GazetteStatus = (typeof gazetteMachine.states)[number]

export const payrollRunMachine = defineStateMachine({
  field: 'status',
  initial: 'draft',
  transitions: {
    draft: ['computed'],
    // Recompute is legal until it is approved: attendance corrections arrive late.
    computed: ['computed', 'approved'],
    // Once approved the figures are fixed; a change means a fresh period adjustment.
    approved: ['disbursed'],
    disbursed: [],
  },
})

export type PayrollRunStatus = (typeof payrollRunMachine.states)[number]

// ─────────────────────────────────────────────────────────────────────────────
// The gazette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload a wage gazette. Lands as `draft` — transcribing a government notification is
 * exactly the kind of typing that needs a second pair of eyes before anybody is paid on
 * it.
 */
/**
 * Land a biometric device export as attendance (live-test finding, Phase 9).
 *
 * Attendance is deliberately not a pending target — a drafted attendance row is a drafted
 * wage — and the missing consequence was that attendance had no way IN at all: zero rows,
 * so payroll could never compute. This is the human door for the device's own record: hr
 * imports the export file, the punches land verbatim, and the exceptions (missed punch,
 * late) arrive as data a person resolves rather than silently normalised.
 *
 * Idempotent per (worker, date): re-importing the same export replaces that day's rows
 * rather than doubling anybody's month. An unknown employee number refuses the WHOLE
 * import — half a floor's attendance landing silently is a payroll short for the other
 * half, discovered on payday.
 */
export async function importDeviceAttendance(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ imported: number; exceptions: { employeeNo: string; date: string; exception: string }[] }> {
  assertPayrollAccess(ctx)
  const payload = attendanceImport.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const staff = await tx
      .select({ id: workers.id, employeeNo: workers.employeeNo })
      .from(workers)
      .where(scoped(workers, ctx, sql`true`))
    const byNo = new Map(staff.map((w) => [w.employeeNo, w.id]))

    const unknown = [...new Set(payload.rows.map((r) => r.employeeNo))].filter((no) => !byNo.has(no))
    if (unknown.length > 0) {
      throw new AppError('validation_failed', 'workforce.errors.unknown_employees', {
        reason: `${unknown.length} employee number(s) are not on the register: ${unknown
          .slice(0, 5)
          .join(', ')}${unknown.length > 5 ? '…' : ''}`,
        employeeNos: unknown,
      })
    }

    const exceptions: { employeeNo: string; date: string; exception: string }[] = []

    for (const row of payload.rows) {
      const workerId = byNo.get(row.employeeNo)!

      await tx
        .delete(attendance)
        .where(scoped(attendance, ctx, sql`${attendance.workerId} = ${workerId} and ${attendance.date} = ${row.date}`))

      await tx.insert(attendance).values({
        companyId: ctx.companyId,
        workerId,
        date: row.date,
        // The factory clock. The device prints wall time in Dhaka; storing it any other
        // way re-creates the +6 bug class the floor screens were cured of.
        inAt: row.in ? new Date(`${row.date}T${row.in}:00+06:00`) : null,
        outAt: row.out ? new Date(`${row.date}T${row.out}:00+06:00`) : null,
        status: row.status,
        source: 'device',
        exception: row.exception ?? null,
        otHours: row.otHours,
      })

      if (row.exception) {
        exceptions.push({ employeeNo: row.employeeNo, date: row.date, exception: row.exception })
      }
    }

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'attendance',
      after: {
        rows: payload.rows.length,
        days: [...new Set(payload.rows.map((r) => r.date))],
        exceptions: exceptions.length,
      },
    })

    return { imported: payload.rows.length, exceptions }
  })
}

export async function uploadGazette(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ gazetteId: string; grades: number }> {
  assertPayrollAccess(ctx)
  return withTenantTx(ctx, (tx) => uploadGazetteIn(ctx, tx, input))
}

/**
 * Commit a gazette transcribed from the government notification — MARBIM's intake path.
 *
 * Core's generic write would have refused `effectiveFrom` as an invalid identifier, but
 * the deeper reason for a handler is `wage_grades`: a gazette is a header AND its grade
 * table, and a row write would have inserted the header alone. A gazette with no grades
 * activates cleanly and then pays everybody nothing.
 *
 * **No `assertPayrollAccess` here.** The approve inbox already gates this: `wage_gazettes`
 * is approvable only by hr and the owner (`approvalDefaults` in this module's register), so
 * by the time a draft reaches this function the check has been made against the person who
 * signed it. Re-checking `ctx` would fail the job runner, which has no user.
 */
export async function commitGazetteFromScan(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // A gazette is superseded, never edited: rewriting the rates a past run was computed
    // against would silently change what people were told they were paid.
    throw new AppError('validation_failed', 'workforce.errors.gazette_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await uploadGazetteIn(ctx, tx, input.payload)
  return {
    rowId: result.gazetteId,
    before: null,
    after: { gazetteId: result.gazetteId, grades: result.grades },
  }
}

/** The insert itself, inside a transaction the caller owns. */
async function uploadGazetteIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ gazetteId: string; grades: number }> {
  const payload = gazetteUpload.parse(input)

  return (async () => {
    const [gazette] = await tx
      .insert(wageGazettes)
      .values({
        companyId: ctx.companyId,
        version: payload.version,
        effectiveFrom: payload.effectiveFrom,
        documentId: payload.documentId ?? null,
        notes: payload.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: wageGazettes.id })

    if (!gazette) throw new Error('wage_gazettes insert returned nothing')

    await tx.insert(wageGrades).values(
      payload.grades.map((grade) => ({
        companyId: ctx.companyId,
        gazetteId: gazette.id,
        grade: grade.grade,
        basic: grade.basic,
        houseRent: grade.houseRent,
        medical: grade.medical,
        transport: grade.transport,
        food: grade.food,
      })),
    )

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'wage_gazettes',
      targetId: gazette.id,
      after: { version: payload.version, effectiveFrom: payload.effectiveFrom, grades: payload.grades },
    })

    return { gazetteId: gazette.id, grades: payload.grades.length }
  })()
}

/**
 * Make a gazette live. Supersedes whichever one it replaces.
 *
 * Activation is all-or-nothing: activating half a gazette would pay some grades at new
 * rates and some at old ones inside a single run, which is both wrong and very hard to
 * spot on a payslip.
 */
export async function activateGazette(
  ctx: RequestCtx,
  gazetteId: string,
): Promise<{ activated: string; superseded: string[] }> {
  assertPayrollAccess(ctx)

  return withTenantTx(ctx, async (tx) => {
    const [gazette] = await tx
      .select()
      .from(wageGazettes)
      .where(scoped(wageGazettes, ctx, eq(wageGazettes.id, gazetteId)))
      .for('update')

    if (!gazette) throw notFound('workforce.errors.gazette_not_found', { gazetteId })
    if (gazette.status === 'superseded') {
      throw conflict('workforce.errors.gazette_superseded', { gazetteId })
    }

    const grades = await tx.select().from(wageGrades).where(scoped(wageGrades, ctx, eq(wageGrades.gazetteId, gazetteId)))
    if (grades.length === 0) {
      // An empty gazette would make every payroll run throw "grade not defined". Refuse
      // it here, where the message can say why.
      throw new AppError('validation_failed', 'workforce.errors.gazette_has_no_grades', {
        gazetteId,
      })
    }

    // `superseded` marks "no longer the newest", not "never applied": the old gazette
    // still governs every period before the new one takes effect, and completed runs keep
    // pointing at whichever gazette they were computed against.
    // The WHERE restricts this to `active`; the machine states the rule.
    gazetteMachine.assert('active', 'superseded')
    const superseded = await tx
      .update(wageGazettes)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        scoped(
          wageGazettes,
          ctx,
          eq(wageGazettes.status, 'active'),
          lte(wageGazettes.effectiveFrom, gazette.effectiveFrom),
        ),
      )
      .returning({ id: wageGazettes.id })

    gazetteMachine.assert(gazette.status as GazetteStatus, 'active')
    await tx
      .update(wageGazettes)
      .set({
        status: 'active',
        activatedBy: ctx.userId,
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(scoped(wageGazettes, ctx, eq(wageGazettes.id, gazetteId)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'wage_gazettes',
      targetId: gazetteId,
      before: { status: gazette.status },
      after: { status: 'active', supersededCount: superseded.length },
    })

    await emit(ctx, tx, {
      eventName: WORKFORCE_EVENTS.gazetteActivated,
      payload: {
        gazetteId,
        version: gazette.version,
        effectiveFrom: gazette.effectiveFrom,
        supersededCount: superseded.length,
      },
      aggregateTable: 'wage_gazettes',
      aggregateId: gazetteId,
    })

    return { activated: gazetteId, superseded: superseded.map((row) => row.id) }
  })
}

/**
 * The gazette in force for a period — the one a run pins.
 *
 * `superseded` is included deliberately. A gazette effective from December 2023 is
 * superseded the moment a July 2026 revision is activated, but it is still the gazette
 * that governs June 2026 and every period before July. Selecting only `active` would
 * make historic periods un-computable the instant a raise was announced — and would
 * quietly repay old months at new rates if the ordering were ever relaxed.
 *
 * So: the latest non-draft gazette effective on or before the period start wins. Draft
 * ones are excluded because nobody has checked them yet.
 */
async function gazetteForPeriod(
  ctx: AnyCtx,
  tx: TenantDb,
  period: string,
): Promise<{ id: string; version: string; grades: WageGrade[] }> {
  const [gazette] = await tx
    .select()
    .from(wageGazettes)
    .where(
      scoped(
        wageGazettes,
        ctx,
        ne(wageGazettes.status, 'draft'),
        lte(wageGazettes.effectiveFrom, `${period}-01`),
      ),
    )
    .orderBy(desc(wageGazettes.effectiveFrom))
    .limit(1)

  if (!gazette) {
    throw new AppError('validation_failed', 'workforce.errors.no_active_gazette', { period })
  }

  const grades = await tx
    .select()
    .from(wageGrades)
    .where(scoped(wageGrades, ctx, eq(wageGrades.gazetteId, gazette.id)))
    .orderBy(asc(wageGrades.grade))

  return {
    id: gazette.id,
    version: gazette.version,
    grades: grades.map((row) => ({
      grade: row.grade,
      basic: row.basic,
      houseRent: row.houseRent,
      medical: row.medical,
      transport: row.transport,
      food: row.food,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payroll
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather a period's attendance and leave into the shape the pure engine expects.
 *
 * Everything the engine needs is assembled here so that `computePayroll` stays testable
 * without a database — which is what let the gazette vectors be written before any of
 * this existed.
 */
async function gatherWorkerInputs(
  ctx: AnyCtx,
  tx: TenantDb,
  period: string,
  festival: string | null,
): Promise<WorkerPayrollInput[]> {
  const staff = await tx.select().from(workers).where(scoped(workers, ctx, eq(workers.status, 'active')))

  const attendanceRows = await tx
    .select()
    .from(attendance)
    .where(scoped(attendance, ctx, sql`to_char(${attendance.date}, 'YYYY-MM') = ${period}`))

  const leaveRows = await tx
    .select()
    .from(leaves)
    .where(scoped(leaves, ctx, sql`to_char(${leaves.fromDate}, 'YYYY-MM') = ${period}`))

  const byWorker = new Map<string, WorkerPayrollInput>()

  for (const worker of staff) {
    byWorker.set(worker.id, {
      workerId: worker.id,
      grade: worker.grade,
      joinDate: worker.joinDate,
      exitDate: worker.exitDate,
      presentDays: 0,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      absentDays: 0,
      otHours: '0',
      deductions: [],
      festival,
    })
  }

  for (const row of attendanceRows) {
    const input = byWorker.get(row.workerId)
    if (!input) continue

    if (row.status === 'present' || row.status === 'holiday') input.presentDays += 1
    else if (row.status === 'absent') input.absentDays += 1

    input.otHours = addHours(input.otHours, row.otHours)
  }

  for (const leave of leaveRows) {
    const input = byWorker.get(leave.workerId)
    if (!input) continue

    const days = dayCount(leave.fromDate, leave.toDate)
    if (leave.isPaid) input.paidLeaveDays += days
    else input.unpaidLeaveDays += days
  }

  return [...byWorker.values()]
}

const dayCount = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1

/** Exact hour addition — attendance OT is numeric(6,2) and must not go through a float. */
function addHours(a: string, b: string): string {
  const toMinor = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2))
  }
  const total = toMinor(a) + toMinor(b)
  const digits = total.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * Compute (or recompute) a period.
 *
 * Deterministic and idempotent: the run is keyed by period, and recomputing replaces its
 * lines rather than making a second run. Attendance corrections arrive late and a payroll
 * you cannot re-run is a payroll you fix by hand.
 */
export async function computePayrollRun(
  ctx: RequestCtx,
  input: { period: string; festival?: string | null; rules?: Partial<PayrollRules> },
): Promise<{ runId: string; lines: number; totalNet: string; flagged: number }> {
  assertPayrollAccess(ctx)

  return withTenantTx(ctx, async (tx) => {
    const gazette = await gazetteForPeriod(ctx, tx, input.period)
    const rules = payrollRules.parse({ ...defaultRules(), ...input.rules })

    const [existing] = await tx
      .select()
      .from(payrollRuns)
      .where(scoped(payrollRuns, ctx, eq(payrollRuns.period, input.period)))
      .for('update')

    if (existing && existing.status !== 'draft' && existing.status !== 'computed') {
      // An approved or disbursed run is a paid fact. Correcting it is a new period
      // adjustment, not a rewrite of what people were told they were getting.
      throw conflict('workforce.errors.run_not_recomputable', {
        period: input.period,
        status: existing.status,
      })
    }

    const workerInputs = await gatherWorkerInputs(ctx, tx, input.period, input.festival ?? null)

    let lines: PayrollLine[]
    try {
      lines = computePayroll({
        period: input.period,
        grades: gazette.grades,
        rules,
        workers: workerInputs,
      })
    } catch (error) {
      if (error instanceof PayrollError) {
        throw new AppError('validation_failed', 'workforce.errors.payroll_compute_failed', {
          period: input.period,
          reason: error.message,
        })
      }
      throw error
    }

    const runId =
      existing?.id ??
      (
        await tx
          .insert(payrollRuns)
          .values({
            companyId: ctx.companyId,
            period: input.period,
            gazetteId: gazette.id,
            rulesSnapshot: rules as unknown as Record<string, unknown>,
            status: 'computed',
            createdBy: ctx.userId,
          })
          .returning({ id: payrollRuns.id })
      )[0]!.id

    if (existing) {
      payrollRunMachine.assert(existing.status as PayrollRunStatus, 'computed')
      await tx.delete(payrollLines).where(scoped(payrollLines, ctx, eq(payrollLines.runId, runId)))
      await tx
        .update(payrollRuns)
        .set({
          gazetteId: gazette.id,
          rulesSnapshot: rules as unknown as Record<string, unknown>,
          status: 'computed',
          updatedAt: new Date(),
        })
        .where(scoped(payrollRuns, ctx, eq(payrollRuns.id, runId)))
    }

    if (lines.length > 0) {
      await tx.insert(payrollLines).values(
        lines.map((line) => ({
          companyId: ctx.companyId,
          runId,
          workerId: line.workerId,
          grade: line.grade,
          payableDays: line.payableDays,
          components: line.components,
          otHours: line.otHours,
          otAmount: line.otAmount,
          attendanceBonus: line.attendanceBonus,
          festivalBonus: line.festivalBonus,
          deductions: line.deductions as unknown[],
          totalDeductions: line.totalDeductions,
          gross: line.gross,
          net: line.net,
          deductionCarryForward: line.deductionCarryForward,
          currency: rules.currency,
          flags: line.flags as unknown[],
        })),
      )
    }

    const flagged = lines.filter((line) => line.flags.length > 0).length

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'payroll_runs',
      targetId: runId,
      after: {
        period: input.period,
        gazetteVersion: gazette.version,
        lines: lines.length,
        flagged,
      },
    })

    await emit(ctx, tx, {
      eventName: WORKFORCE_EVENTS.runComputed,
      payload: { runId, period: input.period, lines: lines.length, flagged },
      aggregateTable: 'payroll_runs',
      aggregateId: runId,
    })

    return { runId, lines: lines.length, totalNet: totalNet(lines, rules.currency), flagged }
  })
}

/** Factory policy defaults. Overridden per run and snapshotted onto it. */
function defaultRules(): PayrollRules {
  return {
    currency: 'BDT',
    monthDays: 30,
    attendanceBonus: null,
    attendanceBonusMaxAbsentDays: 0,
    festivalBonusBasicPct: '100',
    festivalBonusMinServiceMonths: 12,
  }
}

/**
 * Read a run's lines. 🔒 Audited — who looked at whose wages, and when, is itself
 * information worth keeping (rule 9).
 */
export async function getPayrollLines(
  ctx: RequestCtx,
  runId: string,
): Promise<(typeof payrollLines.$inferSelect)[]> {
  assertPayrollAccess(ctx)

  return withTenantTx(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(payrollLines)
      .where(scoped(payrollLines, ctx, eq(payrollLines.runId, runId)))
      .orderBy(asc(payrollLines.workerId))

    await recordRead(ctx, tx, {
      targetTable: 'payroll_lines',
      targetId: runId,
      scope: { runId, lines: rows.length },
    })

    return rows
  })
}

/** Approve a computed run. Routes through pending_changes to the owner in the UI flow. */
export async function approvePayrollRun(
  ctx: RequestCtx,
  runId: string,
): Promise<{ from: PayrollRunStatus; to: PayrollRunStatus }> {
  assertPayrollAccess(ctx)
  if (!ctx.roles.includes('owner')) {
    // Computing is HR's job; signing off what 2,400 people are paid is the owner's.
    throw new AppError('forbidden', '', {}, 'payroll approval requires owner')
  }

  return withTenantTx(ctx, async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(scoped(payrollRuns, ctx, eq(payrollRuns.id, runId))).for('update')
    if (!run) throw notFound('workforce.errors.run_not_found', { runId })

    const from = run.status as PayrollRunStatus
    payrollRunMachine.assert(from, 'approved')

    await tx
      .update(payrollRuns)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(scoped(payrollRuns, ctx, eq(payrollRuns.id, runId)))

    await recordChange(ctx, tx, {
      action: 'approve',
      targetTable: 'payroll_runs',
      targetId: runId,
      before: { status: from },
      after: { status: 'approved', approvedBy: ctx.userId },
    })

    await emit(ctx, tx, {
      eventName: WORKFORCE_EVENTS.runApproved,
      payload: { runId, period: run.period, approvedBy: ctx.userId },
      aggregateTable: 'payroll_runs',
      aggregateId: runId,
    })

    return { from, to: 'approved' }
  })
}

/** The active gazette and its grades — the screen an admin checks before running payroll. */
export async function getActiveGazette(
  ctx: RequestCtx,
  period: string,
): Promise<{ id: string; version: string; grades: WageGrade[] }> {
  assertPayrollAccess(ctx)
  return withTenantRead(ctx, (tx) => gazetteForPeriod(ctx, tx, period))
}
