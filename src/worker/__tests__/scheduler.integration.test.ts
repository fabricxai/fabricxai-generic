/**
 * Scheduler integration — against real Redis and Postgres.
 *
 * A cron that compiles is not a cron that runs. What matters here is the fan-out: the
 * right number of jobs, deterministic ids so a double-fire is a no-op, and the derive
 * handler doing real per-tenant work under RLS.
 */
import { randomUUID } from 'node:crypto'

import type { Job, Queue } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies } from '@/db/schema/core'
import { env } from '@/lib/env'
import { getQueue, QUEUE, closeQueues } from '@/worker/queues'
import {
  activeScheduledTasks,
  fanOutScheduledTask,
  registerSchedules,
  runDeriveTask,
  SCHEDULED_TASKS,
  type DeriveJobData,
  type ScheduledTask,
} from '@/worker/processors/scheduler'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const COMPANY_INACTIVE = randomUUID()

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY_A, name: 'Sched A', slug: `sched-a-${COMPANY_A.slice(0, 8)}` },
    { id: COMPANY_B, name: 'Sched B', slug: `sched-b-${COMPANY_B.slice(0, 8)}` },
    {
      id: COMPANY_INACTIVE,
      name: 'Sched Dormant',
      slug: `sched-x-${COMPANY_INACTIVE.slice(0, 8)}`,
      isActive: false,
    },
  ])
})

afterAll(async () => {
  const derive = getQueue(QUEUE.derive)
  await derive.drain()
  // Completed AND failed. `drain()` only takes waiting and delayed, so a job left in either
  // terminal state keeps its id — and these tests assert on job COUNTS after a fan-out that
  // dedupes on exactly that id. A `pnpm worker:dev` running against the same Redis (the
  // normal way to work on this) processes these jobs and leaves them terminal, which made
  // the next run of the suite come up short and fail somewhere unrelated to its own cause.
  await derive.clean(0, 1000, 'completed')
  await derive.clean(0, 1000, 'failed')

  const schedule = getQueue(QUEUE.schedule)
  for (const task of SCHEDULED_TASKS) {
    await schedule.removeJobScheduler(task.id).catch(() => undefined)
  }

  await db.execute(sql`delete from audit_log where company_id in (${COMPANY_A}, ${COMPANY_B})`)
  for (const id of [COMPANY_A, COMPANY_B, COMPANY_INACTIVE]) {
    await db.delete(companies).where(eq(companies.id, id))
  }

  await closeQueues()
  await client.end()
})

/**
 * `timestamp` is what identifies one FIRE of a cron. Two calls with the same timestamp are
 * the same fire retried; two with different ones are two fires, and the distinction is the
 * whole basis of the fan-out's deduplication.
 */
const fakeJob = (task: ScheduledTask, timestamp = Date.now()) =>
  ({ data: { task }, timestamp }) as Job<{ task: ScheduledTask }>

/**
 * A fire time unique to THIS run.
 *
 * Job ids are `task:company:slot`, and the slot comes from the fire's timestamp. Fixed
 * timestamps meant every run produced the same ids, so a job left behind in a terminal
 * state by an earlier run silently deduped the next run's fan-out — the first fire would
 * enqueue seven where the second enqueued ten, and the test failed with arithmetic that
 * looked like the scheduler was wrong. Distinct-per-run timestamps make the ids unique, so
 * the assertion measures this run and nothing else. The test only ever needed two DIFFERENT
 * fire times, never two particular ones.
 */
// Offset by a random number of MINUTES, not milliseconds: the slot is minute-resolution,
// so two runs in the same minute would otherwise still collide — which is exactly what
// happened while iterating on this file.
const RUN_BASE = Date.now() + Math.floor(Math.random() * 1_000_000) * 60_000
const fireAt = (offsetMinutes: number) => RUN_BASE + offsetMinutes * 60_000

/**
 * Count only THIS task's jobs, not everything in the queue.
 *
 * The derive queue is shared — by the relay's event consumers, by other suites, and by a
 * `pnpm worker:dev` somebody has running while they work. Asserting on the queue's total
 * length made these tests fail on whatever else happened to be in it, which is a test
 * reporting someone else's activity as this code being broken. Job ids are
 * `task:company:slot`, so the task's own jobs are countable exactly.
 */
/**
 * Every state a fanned-out job can be in by the time we look.
 *
 * Reading only `waiting` assumed nothing was consuming the queue — but `pnpm worker:dev`
 * against the same Redis is the normal way to work on this, and it picks jobs up within
 * milliseconds. The fan-out would enqueue nine and the test would see one, then report the
 * scheduler as broken. What is being asserted is what was ENQUEUED, so a job already picked
 * up or finished still counts.
 */
const ANY_STATE = ['waiting', 'delayed', 'prioritized', 'active', 'completed', 'failed'] as const

/**
 * Empty the derive queue completely before a test that counts.
 *
 * `drain()` only removes waiting and delayed jobs. A job left COMPLETED or FAILED keeps its
 * id, and BullMQ treats a re-added id as a duplicate — so a fan-out would report ten
 * companies while enqueuing one, and the test failed describing the scheduler as broken
 * when the queue was simply dirty. Anything that shares this Redis leaves such jobs behind:
 * another suite, a crashed run, or a `pnpm worker:dev` left running while somebody works.
 */
async function clearDerive(queue: Queue): Promise<void> {
  await queue.drain()
  await queue.clean(0, 5000, 'completed')
  await queue.clean(0, 5000, 'failed')
}

async function countJobsFor(queue: Queue, task: string): Promise<number> {
  const jobs = await queue.getJobs([...ANY_STATE])
  return jobs.filter((job) => (job.id ?? '').startsWith(`${task}:`)).length
}

describe('scheduler', () => {
  it('registers repeatable jobs idempotently', async () => {
    await registerSchedules()
    await registerSchedules() // a worker restart, or a second worker

    const schedulers = await getQueue(QUEUE.schedule).getJobSchedulers()
    const ids = schedulers.map((s) => s.key ?? s.id)

    for (const task of activeScheduledTasks()) {
      // Registering twice must not produce two schedules — that is how a nightly
      // digest becomes four identical emails.
      expect(ids.filter((id) => id === task.id)).toHaveLength(1)
    }
  })

  it('does not schedule the copilot tasks when MARBIM is off (plan 6.1)', async () => {
    /*
     * This case used to iterate the FULL list and demand every entry be registered, which
     * is what the old behaviour was: `MARBIM_ENABLED` had no runtime consumers, so the
     * extraction runner was scheduled regardless — and `runQueuedExtractions` returns a
     * skip rather than throwing, which `recordRun` closed as succeeded. Job health reported
     * green for a task that had extracted nothing and never would.
     *
     * The flag is off by default, which is the honest setting today, and this asserts the
     * off case directly. A developer running the copilot against real models has it ON in
     * their own `.env` — so the case is SKIPPED there rather than failing, because a red
     * that only means "your environment differs from CI" teaches people to ignore reds.
     */
    if (env.MARBIM_ENABLED) {
      console.log('[scheduler] MARBIM_ENABLED is on in this environment — skipping the off case')
      return
    }

    const marbimTasks = SCHEDULED_TASKS.filter(
      (task) => !activeScheduledTasks().some((active) => active.id === task.id),
    )

    // Named, so a typo in `MARBIM_TASKS` is a failure rather than a filter that quietly
    // matches nothing. The first version of that list said `memory.style_embed_sweep`, which
    // is not a task — and the embed sweep went on being scheduled with the copilot off.
    expect(marbimTasks.map((task) => task.task).sort()).toEqual([
      'marbim.run_extractions',
      'memory.embed_styles',
    ])

    await registerSchedules()
    const ids = (await getQueue(QUEUE.schedule).getJobSchedulers()).map((s) => s.key ?? s.id)

    for (const task of marbimTasks) {
      expect(ids, `${task.task} scheduled with MARBIM off`).not.toContain(task.id)
    }
  })

  it('fans out to live companies only, skipping dormant ones', async () => {
    const derive = getQueue(QUEUE.derive)
    await clearDerive(derive)

    const count = await fanOutScheduledTask(fakeJob('orders.tna_scan', fireAt(120)))
    expect(count).toBeGreaterThanOrEqual(2)

    const jobs = await derive.getJobs([...ANY_STATE])
    const companyIds = jobs
      .filter((job) => (job.id ?? '').startsWith('orders.tna_scan:'))
      .map((job) => (job.data as DeriveJobData).companyId)

    expect(companyIds).toContain(COMPANY_A)
    expect(companyIds).toContain(COMPANY_B)
    // Deactivated tenants are not woken up every night forever.
    expect(companyIds).not.toContain(COMPANY_INACTIVE)
  })

  it('the SAME fire enqueues nothing extra — the job id is deterministic', async () => {
    const derive = getQueue(QUEUE.derive)
    await clearDerive(derive)

    const firedAt = fireAt(0)

    await fanOutScheduledTask(fakeJob('commercial.lc_countdown', firedAt))
    const after1 = await countJobsFor(derive, 'commercial.lc_countdown')

    // The same scheduled job, retried after a worker died mid-fan-out.
    await fanOutScheduledTask(fakeJob('commercial.lc_countdown', firedAt))
    const after2 = await countJobsFor(derive, 'commercial.lc_countdown')

    expect(after1).toBeGreaterThan(0)
    expect(after2).toBe(after1)
  })

  it('a SUB-DAILY task enqueues every fire, not just the first of the day', async () => {
    const derive = getQueue(QUEUE.derive)
    await clearDerive(derive)

    // Two fires of the five-minute extraction runner, twenty minutes apart on one day.
    await fanOutScheduledTask(
      fakeJob('marbim.run_extractions', fireAt(60)),
    )
    const afterFirst = await countJobsFor(derive, 'marbim.run_extractions')

    await fanOutScheduledTask(
      fakeJob('marbim.run_extractions', fireAt(80)),
    )
    const afterSecond = await countJobsFor(derive, 'marbim.run_extractions')

    // Keyed on the calendar date, the second fire and the 286 after it would have been
    // dropped as duplicates — the task would have run once a day and looked fine.
    expect(afterSecond).toBe(afterFirst * 2)
  })

  it('every registered task is one the health check can classify', async () => {
    const { expectedIntervalMinutes } = await import('@/modules/core/job-health')

    // The staleness check refuses a pattern shape it does not understand, which is right —
    // but it refuses at RUNTIME, once an hour, inside a job. Asserting it here means a
    // schedule added with an unclassifiable pattern fails the build instead of quietly
    // leaving that task unmonitored.
    for (const task of SCHEDULED_TASKS) {
      expect(() => expectedIntervalMinutes(task.pattern), task.task).not.toThrow()
    }
  })

  it('every registered task has a cron pattern and a handler', async () => {
    // The compiler already enforces the handler side. This catches the other direction: a
    // task added to the array with a pattern that does not parse would register a schedule
    // that never fires, and nothing else would notice.
    for (const task of SCHEDULED_TASKS) {
      expect(task.pattern).toMatch(/^[\d*/,\- ]+$/)
      expect(task.pattern.trim().split(/\s+/)).toHaveLength(5)
    }
  })

  it('the derive handler runs the real per-tenant job', async () => {
    const result = (await runDeriveTask({
      id: 'test-job',
      data: { companyId: COMPANY_A, task: 'orders.tna_scan' },
    } as Job<DeriveJobData>)) as { scanned: number }

    // Company A has no milestones, so zero scanned is the correct answer — what is being
    // asserted is that it ran, scoped, without throwing.
    expect(result.scanned).toBe(0)
  })

  it('refuses an unknown task instead of silently doing nothing every night', async () => {
    await expect(
      runDeriveTask({
        id: 'test-job',
        data: { companyId: COMPANY_A, task: 'orders.nonexistent' as ScheduledTask },
      } as Job<DeriveJobData>),
    ).rejects.toThrow(/no handler/i)
  })
})
