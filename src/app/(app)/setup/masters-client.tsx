'use client'

import { useState } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { Field, Select, TextInput } from '@/components/fx/forms'
import { Badge, Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { saveLine } from '@/modules/planning/actions'
import { saveItem, saveLocation } from '@/modules/store/actions'
import { saveWorker } from '@/modules/workforce/actions'

/**
 * The four doors a factory needs open on its first morning (finding D1).
 *
 * The day-one walkthrough found that nothing in this product created an item, a location, a
 * worker or a sewing line — not an action, not a screen, not a MARBIM tool. The only writer
 * was the seed script. Every screen that reads them rendered perfectly and had nothing to
 * offer, which is why it went unnoticed for twenty-three modules: a factory only discovers
 * it when it tries to receive its first delivery and finds the item dropdown empty.
 *
 * They are gathered on ONE screen on purpose. These are four different modules and would
 * naturally live in four places, but the person doing this is doing one job — setting the
 * factory up — and sending them to four screens is four chances to stop.
 */

interface Row {
  id: string
  code: string
  name: string
  detail?: string
}

export function MastersClient({
  items,
  locations,
  workers,
  lines,
  canWriteWorkers,
}: {
  items: Row[]
  locations: Row[]
  workers: Row[]
  lines: Row[]
  /** Payroll is hr+owner; the roster is not, but the screen still says which is which. */
  canWriteWorkers: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <ItemPanel rows={items} />
      <LocationPanel rows={locations} />
      <LinePanel rows={lines} />
      <WorkerPanel rows={workers} lines={lines} canWrite={canWriteWorkers} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function Panel({
  title,
  blurb,
  count,
  rows,
  empty,
  action,
  children,
}: {
  title: string
  blurb: string
  count: number
  rows: Row[]
  empty: string
  action: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section
      style={{
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        backgroundColor: 'var(--fx-bg-surface)',
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ font: "600 15px/1.2 var(--fx-font-sans)", color: 'var(--fx-text-primary)', margin: 0 }}>
              {title}
            </h2>
            <Badge tone={count === 0 ? 'warning' : 'neutral'}>{count}</Badge>
          </div>
          <p style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)', margin: '5px 0 0' }}>
            {blurb}
          </p>
        </div>
        {action}
      </header>

      {rows.length === 0 ? (
        <p style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)', margin: 0 }}>
          {empty}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.slice(0, 8).map((row) => (
            <li
              key={row.id}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'baseline',
                font: "400 13px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              <span style={{ fontFamily: 'var(--fx-font-mono)', color: 'var(--fx-text-primary)' }}>
                {row.code}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
              {row.detail ? <span style={{ color: 'var(--fx-text-tertiary)' }}>{row.detail}</span> : null}
            </li>
          ))}
          {rows.length > 8 ? (
            <li style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              and {rows.length - 8} more
            </li>
          ) : null}
        </ul>
      )}
      {children}
    </section>
  )
}

/** Shared submit plumbing: a refusal is shown, never swallowed, and never thrown as #441. */
function useSave<T>(run: () => Promise<T>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(onDone: () => void) {
    setBusy(true)
    setError(null)
    try {
      unwrap(await run())
      onDone()
      // The lists come from the server component, so the refreshed data arrives with the
      // navigation the action's revalidatePath already queued.
      window.location.reload()
    } catch (e) {
      // Never `e.message` — a service refusal carries a message KEY, and printing it raw
      // shows somebody `store.errors.item_uom_locked` where a sentence belongs.
      setError(actionErrorMessage(e, 'Could not save that.'))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, submit, setError }
}

// ─────────────────────────────────────────────────────────────────────────────

function ItemPanel({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', kind: 'fabric', uom: 'yds' })
  const { busy, error, submit } = useSave(() =>
    saveItem({
      code: form.code.trim(),
      name: form.name.trim(),
      kind: form.kind as 'fabric' | 'trim' | 'accessory' | 'yarn' | 'greige',
      uom: form.uom.trim(),
    }),
  )

  return (
    <Panel
      title="Items"
      blurb="Yarn, greige, dyed fabric, trims and accessories. The store cannot receive anything until at least one exists — a GRN line names an item."
      count={rows.length}
      rows={rows}
      empty="Nothing on the master list yet. Add the first fabric and the receive form will accept a delivery."
      action={<Button onClick={() => setOpen(true)}>Add item</Button>}
    >
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add an item"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !form.code || !form.name} onClick={() => submit(() => setOpen(false))}>
              {busy ? 'Saving…' : 'Save item'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <TextInput
            label="Code"
            mono
            required
            hint="What the storekeeper types off the challan. Entering it again edits this item."
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
          <TextInput
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Select
            label="Kind"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            <option value="yarn">Yarn</option>
            <option value="greige">Greige (knitted, undyed)</option>
            <option value="fabric">Fabric (dyed, ready to cut)</option>
            <option value="trim">Trim</option>
            <option value="accessory">Accessory</option>
          </Select>
          <TextInput
            label="Unit of measure"
            required
            mono
            hint="Fixed once stock exists — quantities already recorded are in this unit, and reinterpreting them silently is a stock figure nobody can see is wrong."
            value={form.uom}
            onChange={(e) => setForm({ ...form, uom: e.target.value })}
          />
        </div>
      </Modal>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function LocationPanel({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', kind: 'general' })
  const { busy, error, submit } = useSave(() =>
    saveLocation({
      code: form.code.trim(),
      name: form.name.trim(),
      kind: form.kind as 'bonded' | 'general' | 'floor',
    }),
  )

  return (
    <Panel
      title="Store locations"
      blurb="Where a roll physically sits. A bonded location holds duty-free material that may only leave against a UD."
      count={rows.length}
      rows={rows}
      empty="No locations yet. A receipt has to put the goods somewhere."
      action={<Button onClick={() => setOpen(true)}>Add location</Button>}
    >
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a store location"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !form.code || !form.name} onClick={() => submit(() => setOpen(false))}>
              {busy ? 'Saving…' : 'Save location'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <TextInput
            label="Code"
            mono
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
          <TextInput
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Select
            label="Kind"
            required
            hint="Not editable afterwards. Rolls already here were received under this customs status, and changing it would claim duty-free treatment retroactively."
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            <option value="general">General — duty paid</option>
            <option value="bonded">Bonded — duty-free, governed by a UD</option>
            <option value="floor">Floor — issued material at the line</option>
          </Select>
        </div>
      </Modal>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function LinePanel({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    code: '',
    name: '',
    manpower: '',
    machines: '',
    floorCode: '',
    floorName: '',
    unitCode: '',
    unitName: '',
  })
  const { busy, error, submit } = useSave(() =>
    saveLine({
      code: form.code.trim(),
      name: form.name.trim(),
      ...(form.manpower ? { capacityManpower: Number(form.manpower) } : {}),
      ...(form.machines ? { machinesCount: Number(form.machines) } : {}),
      floor: {
        code: form.floorCode.trim(),
        name: form.floorName.trim() || form.floorCode.trim(),
        factoryUnit: {
          code: form.unitCode.trim(),
          name: form.unitName.trim() || form.unitCode.trim(),
        },
      },
    }),
  )

  return (
    <Panel
      title="Sewing lines"
      blurb="The board, the hourly tracker and every capacity promise are computed per line. A line belongs to a floor, and a floor to a factory unit — all three go in together."
      count={rows.length}
      rows={rows}
      empty="No lines yet, so the planning board and the hourly tracker have nothing to show."
      action={<Button onClick={() => setOpen(true)}>Add line</Button>}
    >
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a sewing line"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !form.code || !form.name || !form.floorCode || !form.unitCode}
              onClick={() => submit(() => setOpen(false))}
            >
              {busy ? 'Saving…' : 'Save line'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <TextInput
              label="Line code"
              mono
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
            <TextInput
              label="Line name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextInput
              label="Nominal manpower"
              inputMode="numeric"
              hint="The day plan carries what is actually rostered."
              value={form.manpower}
              onChange={(e) => setForm({ ...form, manpower: e.target.value.replace(/\D/g, '') })}
            />
            <TextInput
              label="Machines"
              inputMode="numeric"
              value={form.machines}
              onChange={(e) => setForm({ ...form, machines: e.target.value.replace(/\D/g, '') })}
            />
          </div>

          <Field label="Where it sits" hint="Re-using a code attaches to the existing floor or unit rather than creating a second one.">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <TextInput
                label="Floor code"
                mono
                required
                value={form.floorCode}
                onChange={(e) => setForm({ ...form, floorCode: e.target.value })}
              />
              <TextInput
                label="Floor name"
                value={form.floorName}
                onChange={(e) => setForm({ ...form, floorName: e.target.value })}
              />
              <TextInput
                label="Unit code"
                mono
                required
                value={form.unitCode}
                onChange={(e) => setForm({ ...form, unitCode: e.target.value })}
              />
              <TextInput
                label="Unit name"
                value={form.unitName}
                onChange={(e) => setForm({ ...form, unitName: e.target.value })}
              />
            </div>
          </Field>
        </div>
      </Modal>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function WorkerPanel({ rows, lines, canWrite }: { rows: Row[]; lines: Row[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    employeeNo: '',
    name: '',
    nameBn: '',
    grade: '',
    designation: '',
    section: '',
    lineId: '',
    joinDate: '',
    disbursementType: 'cash',
    disbursementRef: '',
  })
  const { busy, error, submit } = useSave(() =>
    saveWorker({
      employeeNo: form.employeeNo.trim(),
      name: form.name.trim(),
      ...(form.nameBn ? { nameBn: form.nameBn.trim() } : {}),
      grade: form.grade.trim(),
      ...(form.designation ? { designation: form.designation.trim() } : {}),
      ...(form.section ? { section: form.section.trim() } : {}),
      ...(form.lineId ? { lineId: form.lineId } : {}),
      joinDate: form.joinDate,
      disbursementType: form.disbursementType as 'bank' | 'bkash' | 'nagad' | 'cash',
      ...(form.disbursementRef ? { disbursementRef: form.disbursementRef.trim() } : {}),
    }),
  )

  const needsRef = form.disbursementType !== 'cash'

  return (
    <Panel
      title="Workers"
      blurb="The roster. Attendance imports match on employee number, and payroll pays against the gazette grade — so a factory with no workers has no attendance and no payroll, ever."
      count={rows.length}
      rows={rows}
      empty="No workers on file. Register one and the attendance import will have somebody to match."
      action={canWrite ? <Button onClick={() => setOpen(true)}>Add worker</Button> : null}
    >
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Register a worker"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !form.employeeNo ||
                !form.name ||
                !form.grade ||
                !form.joinDate ||
                (needsRef && !form.disbursementRef)
              }
              onClick={() => submit(() => setOpen(false))}
            >
              {busy ? 'Saving…' : 'Register'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <TextInput
              label="Employee number"
              mono
              required
              hint="What the attendance device sends."
              value={form.employeeNo}
              onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
            />
            <TextInput
              label="Grade"
              mono
              required
              hint="From the gazette table. Resolved at payroll time."
              value={form.grade}
              onChange={(e) => setForm({ ...form, grade: e.target.value })}
            />
            <TextInput
              label="Name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextInput
              label="নাম (Bangla)"
              hint="The payslip leads in Bangla."
              value={form.nameBn}
              onChange={(e) => setForm({ ...form, nameBn: e.target.value })}
            />
            <TextInput
              label="Designation"
              value={form.designation}
              onChange={(e) => setForm({ ...form, designation: e.target.value })}
            />
            <TextInput
              label="Section"
              value={form.section}
              onChange={(e) => setForm({ ...form, section: e.target.value })}
            />
            <Select
              label="Line"
              value={form.lineId}
              onChange={(e) => setForm({ ...form, lineId: e.target.value })}
            >
              <option value="">— not on a line —</option>
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.code} · {line.name}
                </option>
              ))}
            </Select>
            <TextInput
              label="Join date"
              type="date"
              required
              value={form.joinDate}
              onChange={(e) => setForm({ ...form, joinDate: e.target.value })}
            />
            <Select
              label="Paid by"
              value={form.disbursementType}
              onChange={(e) => setForm({ ...form, disbursementType: e.target.value })}
            >
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              <option value="bkash">bKash</option>
              <option value="nagad">Nagad</option>
            </Select>
            <TextInput
              label="Account or wallet"
              mono
              required={needsRef}
              hint={needsRef ? 'Without it the payroll line cannot be paid — and that is found on payday.' : 'Not needed for cash.'}
              disabled={!needsRef}
              value={form.disbursementRef}
              onChange={(e) => setForm({ ...form, disbursementRef: e.target.value })}
            />
          </div>
        </div>
      </Modal>
    </Panel>
  )
}
