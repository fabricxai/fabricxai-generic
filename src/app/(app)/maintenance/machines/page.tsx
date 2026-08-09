import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs, StatTile } from '@/components/fx/data'
import { EmptyState } from '@/components/fx/feedback'
import { Figure } from '@/components/fx/format'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { assignableLines, registry } from '@/modules/maintenance/queries'

import { MachineRegistry } from './registry-client'

/**
 * 9.1 Machine registry.
 *
 * The fleet was a read-only list on the maintenance page, so a factory could see the
 * machines the seed put there and add none of its own. `registerMachine` and
 * `assignMachineToLine` had been written, tested and reachable from nothing.
 *
 * **The line assignment is the point, not the inventory.** A machine's PM schedule travels
 * with the MACHINE, so a machine sitting on the wrong line still gets serviced — but every
 * downtime ticket it raises is attributed to whichever line the registry says it is on, and
 * that is what the owner dashboard reads when it asks which line keeps stopping. A fleet
 * nobody reassigns quietly poisons that number.
 *
 * **History is shown, not just the current line.** A machine that has moved between four
 * lines this quarter is often the reason it keeps breaking, or the reason nobody serviced
 * it — each line assuming the last one had.
 */
export const dynamic = 'force-dynamic'

export default async function MachinesPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const [machines, lines] = await Promise.all([registry(ctx), assignableLines(ctx)])

  const unassigned = machines.filter((m) => m.lineId === null)
  const withTickets = machines.filter((m) => m.openTickets > 0)
  const moved = machines.filter((m) => m.assignmentHistory.length > 2)
  const noSerial = machines.filter((m) => !m.serial)

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'Maintenance', href: '/maintenance' }, { label: 'Machine registry' }]}
        />
      </div>

      <PageHeader
        back={{ href: '/maintenance', label: 'Maintenance' }}
        eyebrow="Maintenance · machine registry"
        title={
          machines.length === 0
            ? 'No machines registered'
            : `${machines.length} ${machines.length === 1 ? 'machine' : 'machines'}`
        }
        meta={unassigned.length > 0 ? `${unassigned.length} on no line` : undefined}
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
            label="On no line"
            value={<Figure value={unassigned.length} />}
            basis={
              unassigned.length > 0
                ? 'their downtime is attributed to no line at all'
                : 'every machine is placed'
            }
            status={unassigned.length > 0 ? 'at-risk' : undefined}
          />
          <StatTile
            label="With an open ticket"
            value={<Figure value={withTickets.length} />}
            basis={withTickets.length > 0 ? 'already stopped or waiting on a mechanic' : 'none'}
          />
          <StatTile
            label="Moved more than once"
            value={<Figure value={moved.length} />}
            // Not a fault, and not nothing: a machine that keeps moving is often the one
            // nobody has serviced, because each line assumed the last one had.
            basis={moved.length > 0 ? 'worth checking their service history' : 'none'}
          />
          <StatTile
            label="No serial recorded"
            value={<Figure value={noSerial.length} />}
            basis={
              noSerial.length > 0
                ? 'cannot be told apart on a warranty claim'
                : 'every machine identifiable'
            }
          />
        </div>

        <section>
          <SectionHeading eyebrow="by type, then serial">The fleet</SectionHeading>

          {machines.length === 0 ? (
            <EmptyState
              title="Nothing registered yet"
              body="Add the first machine below. Until a machine is in the registry nothing can raise a ticket against it, and its preventive maintenance is not scheduled at all."
            />
          ) : null}

          <MachineRegistry machines={machines} lines={lines} />
        </section>
      </div>
    </>
  )
}
