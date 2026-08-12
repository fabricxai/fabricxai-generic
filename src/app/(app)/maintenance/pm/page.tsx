import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs, StatTile } from '@/components/fx/data'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Figure } from '@/components/fx/format'
import { SectionHeading } from '@/components/fx/signature'
import { FloorScreen } from '@/components/fx/floor'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { pmWorklist, registry } from '@/modules/maintenance/queries'
import { pmSchedulesWithReach } from '@/modules/maintenance/service'

import { PmChecklist } from './pm-checklist'
import { ScheduleEditor } from './schedule-editor'
import { factoryToday } from '@/lib/dates'

/**
 * 9.1 Preventive maintenance.
 *
 * `pmDue` and `completePm` were written, tested, and read by nothing — no screen, no job.
 * A factory could not see what was due, and could not sign one off if it did.
 *
 * **A machine with no record at all is due today, and says so.** That is not a bug in the
 * schedule; it is the honest reading of "we have never serviced this". Showing it as
 * "due in 90 days" would let a machine nobody has ever touched sit quietly at the bottom of
 * the list forever.
 *
 * **The checklist is the record.** `completePm` refuses an empty one, because a PM entry
 * with no checks is what an auditor finds after a machine that was "serviced" throws a
 * needle through somebody's hand. So the steps are rendered individually and each is ticked
 * — there is no "mark all done" button, which is the same signature with less thought
 * behind it.
 */
export const dynamic = 'force-dynamic'


export default async function PmPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const today = factoryToday()
  const [due, schedules, fleet] = await Promise.all([
    pmWorklist(ctx, today),
    pmSchedulesWithReach(ctx),
    registry(ctx),
  ])

  // The registry's own vocabulary — machine types are free text, and the schedule match is
  // exact, so the editor offers what actually exists rather than letting somebody invent a
  // near-miss.
  const machineTypes = [...new Set(fleet.map((m) => m.machineType))].sort()

  const overdue = due.filter((d) => d.daysOverdue > 0)
  const neverServiced = due.filter((d) => d.neverServiced)
  const noChecklist = due.filter((d) => d.checklist.length === 0)

  return (
    <FloorScreen>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[
            { label: 'Maintenance', href: '/maintenance' },
            { label: 'Preventive maintenance' },
          ]}
        />
      </div>

      <PageHeader
        back={{ href: '/maintenance', label: 'Maintenance' }}
        eyebrow="Maintenance · preventive"
        title={
          due.length === 0
            ? 'Nothing is due'
            : `${due.length} ${due.length === 1 ? 'service' : 'services'} due`
        }
        meta={overdue.length > 0 ? `${overdue.length} already overdue` : `as of ${today}`}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 14,
          }}
        >
          <StatTile
            label="Overdue"
            value={<Figure value={overdue.length} />}
            basis={overdue.length > 0 ? 'past the day they fell due' : 'nothing has slipped'}
            status={overdue.length > 0 ? 'late' : undefined}
            asOf={today}
          />
          <StatTile
            label="Never serviced"
            value={<Figure value={neverServiced.length} />}
            basis={
              neverServiced.length > 0
                ? 'no record of a service, ever — due from the day they were registered'
                : 'every machine has a history'
            }
            status={neverServiced.length > 0 ? 'at-risk' : undefined}
          />
          <StatTile
            label="Schedules with no steps"
            value={<Figure value={noChecklist.length} />}
            basis={
              noChecklist.length > 0
                ? 'cannot be signed off until somebody writes the checks'
                : 'every schedule has its checks'
            }
            status={noChecklist.length > 0 ? 'at-risk' : undefined}
          />
        </div>

        {/*
          A schedule with an empty checklist cannot be completed at all — `completePm`
          requires at least one check. Without saying so, the row simply has no button and
          the mechanic concludes the screen is broken.
        */}
        {noChecklist.length > 0 ? (
          <InlineAlert tone="warning">
            {noChecklist.length}{' '}
            {noChecklist.length === 1 ? 'schedule has' : 'schedules have'} no checks written
            against them, so nothing can be signed off on them. That is deliberate — a service
            record with no checks is a signature on nothing — but it means somebody has to
            write the steps before these machines can be serviced on the record.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow="most overdue first">Due now</SectionHeading>

          {due.length === 0 ? (
            <EmptyState
              title="Nothing due today"
              body="Every machine with a schedule has been serviced within its cadence. Machines with no PM schedule for their type never appear here at all — worth checking the registry if that seems too quiet."
            />
          ) : (
            <PmChecklist rows={due} today={today} />
          )}
        </section>

        <section>
          <SectionHeading eyebrow="per machine type — twenty-four heads share one checklist">
            What gets checked, and how often
          </SectionHeading>

          {/*
            Nothing could define a schedule before this. With none, `pmDue` returns an empty
            list, so a factory with forty-eight machines saw "nothing is due" every day —
            correctly, and uselessly. The list above is only as real as this one.
          */}
          {schedules.length === 0 ? (
            <InlineAlert tone="warning">
              No preventive maintenance is scheduled at all, so nothing will ever appear above.
              A schedule says what to check on a type of machine and how often; every machine
              of that type inherits it, and one with no service on record is due immediately.
            </InlineAlert>
          ) : null}

          <div style={{ marginTop: schedules.length === 0 ? 14 : 0 }}>
            <ScheduleEditor schedules={schedules} machineTypes={machineTypes} />
          </div>
        </section>
      </div>
      <FloorTabs
        tabs={[
          { href: '/maintenance', label: 'Tickets' },
          { href: '/maintenance/pm', label: 'PM' },
          { href: '/maintenance/machines', label: 'Registry' },
        ]}
      />
    </FloorScreen>
  )
}
