'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { importAttendance, makeGazetteActive, recordGazette } from '@/modules/workforce/actions'

/**
 * The two doors payroll was missing (live-test finding, Phase 9).
 *
 * The gazette: `recordGazette`/`makeGazetteActive` existed with no screen, and the page
 * itself said "payroll cannot be computed without one". Recorded and activated in one
 * gesture here, because a recorded-but-inactive gazette pays nobody and the person doing
 * this is hr transcribing the government notice in front of them.
 *
 * Attendance: the device's export lands as data, exceptions and all. The dialect parsing
 * (ZK punch columns, P/P-LATE/P-MISS) happens HERE, at the transcription boundary — the
 * server contract is normalised rows, so a different device tomorrow is a new parser, not
 * a new API.
 */

interface GradeRow {
  key: string
  grade: string
  basic: string
  houseRent: string
  medical: string
  transport: string
  food: string
}

export function GazetteDoor() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [rows, setRows] = useState<GradeRow[]>([blankGrade('1'), blankGrade('2'), blankGrade('3'), blankGrade('4')])

  const ready =
    version.trim() !== '' &&
    effectiveFrom !== '' &&
    rows.some((r) => r.grade.trim() && r.basic.trim())

  function patch(key: string, p: Partial<GradeRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }

  function submit() {
    if (!ready) return
    setFailure(null)
    startTransition(async () => {
      try {
        const filled = rows.filter((r) => r.grade.trim() && r.basic.trim())
        const { gazetteId } = unwrap(
          await recordGazette({
            version: version.trim(),
            effectiveFrom,
            grades: filled.map((r) => ({
              grade: r.grade.trim(),
              basic: r.basic.trim(),
              houseRent: r.houseRent.trim() || '0',
              medical: r.medical.trim() || '0',
              transport: r.transport.trim() || '0',
              food: r.food.trim() || '0',
            })),
          }),
        )
        unwrap(await makeGazetteActive({ gazetteId }))
        setOpen(false)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The gazette was not recorded.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Record the gazette
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Record a wage gazette">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 170px', gap: 12 }}
          >
            <TextInput
              label="Gazette version"
              mono
              placeholder="v-2023-12"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Effective from</span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                style={control}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={gradeGrid}>
              {['Grade', 'Basic', 'House', 'Medical', 'Transport', 'Food'].map((h) => (
                <span
                  key={h}
                  style={{ font: "500 11px/1 var(--fx-font-mono)", letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--fx-text-tertiary)' }}
                >
                  {h}
                </span>
              ))}
            </div>
            {rows.map((r) => (
              <div key={r.key} style={gradeGrid}>
                <input value={r.grade} onChange={(e) => patch(r.key, { grade: e.target.value })} style={cell} />
                <input inputMode="decimal" value={r.basic} onChange={(e) => patch(r.key, { basic: e.target.value })} style={cell} />
                <input inputMode="decimal" value={r.houseRent} onChange={(e) => patch(r.key, { houseRent: e.target.value })} style={cell} />
                <input inputMode="decimal" value={r.medical} onChange={(e) => patch(r.key, { medical: e.target.value })} style={cell} />
                <input inputMode="decimal" value={r.transport} onChange={(e) => patch(r.key, { transport: e.target.value })} style={cell} />
                <input inputMode="decimal" value={r.food} onChange={(e) => patch(r.key, { food: e.target.value })} style={cell} />
              </div>
            ))}
            <Button variant="ghost" onClick={() => setRows((c) => [...c, blankGrade(String(c.length + 1))])}>
              ＋ grade
            </Button>
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            Recorded and put in force together. The gazette is versioned law — a run computed
            under it names it forever, and a later gazette supersedes rather than edits.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Record and put in force
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const blankGrade = (n: string): GradeRow => ({
  key: crypto.randomUUID(),
  grade: n,
  basic: '',
  houseRent: '',
  medical: '',
  transport: '',
  food: '',
})

/** ZK-style device export → normalised rows. Returns what it could not read, honestly. */
function parseZkCsv(text: string): {
  rows: {
    employeeNo: string
    date: string
    in?: string
    out?: string
    status: 'present' | 'absent' | 'leave' | 'holiday'
    exception?: string
    otHours: string
  }[]
  unreadable: string[]
} {
  const rows: ReturnType<typeof parseZkCsv>['rows'] = []
  const unreadable: string[] = []

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const cols = line.split(',').map((c) => c.trim())
    if (cols.length < 9) {
      unreadable.push(line)
      continue
    }
    const [, empNo, , rawDate, p1, p2, p3, p4, status] = cols

    const dm = rawDate!.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (!empNo || !dm) {
      unreadable.push(line)
      continue
    }
    const date = `${dm[3]}-${dm[2]}-${dm[1]}`

    const punches = [p1, p2, p3, p4].filter((p): p is string => Boolean(p))
    const first = punches[0]
    const last = punches.length > 1 ? punches[punches.length - 1] : undefined

    let mapped: 'present' | 'absent' | 'leave' | 'holiday' = 'present'
    let exception: string | undefined
    if (status === 'A') mapped = 'absent'
    else if (status === 'L') mapped = 'leave'
    else if (status === 'H') mapped = 'holiday'
    else if (status === 'P-LATE') exception = `late arrival ${first ?? ''}`.trim()
    else if (status === 'P-MISS' || punches.length < 4) exception = 'missing punches'

    // OT beyond the 8-hour day and the hour of lunch, from the device's own punches.
    // Two decimal places; a day with unreadable punches contributes no OT rather than a
    // guessed one.
    let otHours = '0'
    if (first && last) {
      const [ih, im] = first.split(':').map(Number)
      const [oh, om] = last.split(':').map(Number)
      const worked = oh! * 60 + om! - (ih! * 60 + im!) - 60
      const ot = Math.max(0, worked - 8 * 60)
      otHours = (Math.round((ot / 60) * 100) / 100).toFixed(2)
    }

    rows.push({
      employeeNo: empNo,
      date,
      ...(first ? { in: first } : {}),
      ...(last ? { out: last } : {}),
      status: mapped,
      ...(exception ? { exception } : {}),
      otHours,
    })
  }

  return { rows, unreadable }
}

export function AttendanceImport() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  const [failure, setFailure] = useState<string | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  function handleFile(file: File) {
    setFailure(null)
    setNoted(null)
    startTransition(async () => {
      try {
        const { rows, unreadable } = parseZkCsv(await file.text())
        if (rows.length === 0) {
          setFailure('Nothing in that file could be read as attendance.')
          return
        }
        const result = unwrap(await importAttendance({ rows }))
        setNoted(
          `${result.imported} day-records imported.` +
            (result.exceptions.length > 0
              ? ` ${result.exceptions.length} need a person: ${result.exceptions
                  .map((e) => `${e.employeeNo} (${e.exception})`)
                  .join(', ')}.`
              : ' No exceptions.') +
            (unreadable.length > 0 ? ` ${unreadable.length} line(s) were unreadable and skipped.` : ''),
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The attendance was not imported.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />
      <span>
        <Button variant="secondary" disabled={pending} onClick={() => fileRef.current?.click()}>
          {pending ? 'Importing…' : 'Import the device export'}
        </Button>
      </span>
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
    </div>
  )
}

const control: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}

const gradeGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '60px repeat(5, 1fr)',
  gap: 8,
}

const cell: React.CSSProperties = {
  ...control,
  minHeight: 38,
  padding: '7px 9px',
  font: "400 13.5px/1.2 var(--fx-font-mono)",
}
