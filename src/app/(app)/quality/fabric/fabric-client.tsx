'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { NumpadInput } from '@/components/fx/floor'
import { useLocale, useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import type { Translator } from '@/lib/i18n-ui'
import { recordFabricInspection } from '@/modules/quality/actions'
import { unwrap } from '@/lib/action-failure'

interface Roll {
  rollId: string
  rollNo: string
  lot: string | null
  shadeGroup: string | null
  qty: string
  unit: string
  itemName: string
  result: 'pass' | 'fail' | null
  pointsPer100SqYd: string | null
  inheritedFromGrn: boolean
}

interface Grn {
  grnId: string
  challanNo: string
  receivedAt: string
  inspectionStatus: string
  rolls: Roll[]
  uninspected: number
  failed: number
}

/** The four penalty bands. A band-3 fault is worth 3 points, and so on. */
const BANDS = [
  { key: '1', labelKey: 'ui.quality.band_1_label', hintKey: 'ui.quality.band_1_hint' },
  { key: '2', labelKey: 'ui.quality.band_2_label', hintKey: 'ui.quality.band_2_hint' },
  { key: '3', labelKey: 'ui.quality.band_3_label', hintKey: 'ui.quality.band_3_hint' },
  { key: '4', labelKey: 'ui.quality.band_4_label', hintKey: 'ui.quality.band_4_hint' },
] as const

/**
 * An `inspection_result` as the word on the badge, not as the column value.
 *
 * Falls back to the raw value so a third result added to the enum reads wrong rather than
 * as a missing key — legible is the safer failure at an inspection frame.
 */
const RESULT_COPY: Record<string, string> = {
  pass: 'ui.quality.verdict_pass',
  fail: 'ui.quality.verdict_fail',
}

function resultLabel(t: Translator, result: string): string {
  const key = RESULT_COPY[result]
  return key ? t(key) : result
}

type Bands = Record<string, string>

const EMPTY_BANDS: Bands = { '1': '', '2': '', '3': '', '4': '' }

/**
 * Grading a roll at the inspection frame.
 *
 * The screen previews the arithmetic — total points, the rate per hundred square yards, and
 * which side of the threshold it lands — but the preview is **not** what gets saved. The
 * server recomputes all of it from the band counts and the factory's own threshold, and its
 * answer is the one written. A client that could decide a verdict is a client that can be
 * asked to decide a convenient one, and 4-point results end up in claims against mills.
 */
export function FabricClient({
  grns,
  threshold,
  mandatory,
}: {
  grns: readonly Grn[]
  threshold: string
  mandatory: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [openGrn, setOpenGrn] = useState<string | null>(
    grns.find((g) => g.uninspected > 0)?.grnId ?? null,
  )
  const [grading, setGrading] = useState<{ grn: Grn; roll: Roll } | null>(null)
  const [bands, setBands] = useState<Bands>(EMPTY_BANDS)
  const [length, setLength] = useState('')
  const [width, setWidth] = useState('')
  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // eslint-disable-next-line fabricxai/no-float-money -- keypad defect-band tallies for the live 4-point preview, counts not money; NaN falls back to 0
  const counts = BANDS.map((b) => Number.parseInt(bands[b.key] ?? '', 10) || 0)
  const penaltyPoints = counts.reduce((sum, n, i) => sum + n * (i + 1), 0)
  // eslint-disable-next-line fabricxai/no-float-money -- keypad roll length in yards for the same preview; the server re-derives the stored grade
  const lengthYards = Number.parseFloat(length) || 0
  // eslint-disable-next-line fabricxai/no-float-money -- keypad fabric width in inches for the same preview; the server re-derives the stored grade
  const widthInches = Number.parseFloat(width) || 0
  // points / (length yd × width in ÷ 36) × 100 — the standard normalisation to 100 yd².
  const squareYards = lengthYards > 0 && widthInches > 0 ? (lengthYards * widthInches) / 36 : 0
  const per100SqYd = squareYards > 0 ? (penaltyPoints * 100) / squareYards : null
  const wouldPass = per100SqYd === null ? null : per100SqYd <= Number(threshold)

  const valid = lengthYards > 0 && widthInches > 0

  function startGrading(grn: Grn, roll: Roll) {
    setGrading({ grn, roll })
    setBands(EMPTY_BANDS)
    setLength(roll.unit.toLowerCase().startsWith('y') ? roll.qty : '')
    setWidth('')
    setFailure(null)
  }

  function save() {
    if (!grading || !valid) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await recordFabricInspection({
            grnId: grading.grn.grnId,
            rollId: grading.roll.rollId,
            points4: {
              1: counts[0]!,
              2: counts[1]!,
              3: counts[2]!,
              4: counts[3]!,
            },
            inspectedLengthYards: lengthYards.toFixed(2),
            widthInches: widthInches.toFixed(2),
          }),
        )

        setNoted(
          t('ui.quality.fabric_recorded', {
            roll: grading.roll.rollNo,
            points: result.pointsPer100SqYd,
            result: resultLabel(t, result.result),
          }),
        )
        setGrading(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.quality.fabric_not_saved'), locale))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {noted ? (
        <InlineAlert tone="success">
          {t('ui.quality.fabric_recorded_alert', { summary: noted })}
        </InlineAlert>
      ) : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {mandatory ? (
        <InlineAlert tone="info">{t('ui.quality.woven_gate_note')}</InlineAlert>
      ) : null}

      {/* ── Grading one roll ─────────────────────────────────────────────── */}
      {grading ? (
        <section
          style={{
            border: '1px solid var(--fx-border-default)',
            background: 'var(--fx-bg-surface)',
            padding: '22px 24px',
          }}
        >
          <SectionHeading
            eyebrow={t('ui.quality.grading_eyebrow', { challan: grading.grn.challanNo })}
          >
            {t('ui.quality.roll_heading', {
              roll: grading.roll.rollNo,
              item: grading.roll.itemName,
            })}
          </SectionHeading>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 14,
              marginTop: 16,
            }}
          >
            {BANDS.map((band) => (
              <label key={band.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <NumpadInput
                  label={t(band.labelKey)}
                  value={bands[band.key] ?? ''}
                  onChange={(v) => setBands((b) => ({ ...b, [band.key]: v }))}
                />
                <span
                  style={{
                    font: "400 11px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {t(band.hintKey)}
                </span>
              </label>
            ))}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 14,
              marginTop: 18,
            }}
          >
            <NumpadInput
              label={t('ui.quality.field_length_yd')}
              value={length}
              onChange={setLength}
            />
            <NumpadInput label={t('ui.quality.field_width_in')} value={width} onChange={setWidth} />
          </div>

          {/* ── The arithmetic, shown rather than trusted ───────────────── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 1,
              marginTop: 20,
              background: 'var(--fx-border-subtle)',
              border: '1px solid var(--fx-border-subtle)',
            }}
          >
            {[
              { label: t('ui.quality.stat_penalty_points'), value: String(penaltyPoints) },
              {
                label: t('ui.quality.stat_points_per_100'),
                value: per100SqYd === null ? '—' : per100SqYd.toFixed(2),
                tone: wouldPass === false ? 'var(--fx-danger)' : undefined,
              },
              {
                label: t('ui.quality.stat_threshold'),
                value: t('ui.quality.at_most', { value: threshold }),
              },
              {
                label: t('ui.quality.stat_would_be'),
                value:
                  wouldPass === null
                    ? '—'
                    : wouldPass
                      ? t('ui.quality.verdict_pass')
                      : t('ui.quality.verdict_fail'),
                tone: wouldPass === false ? 'var(--fx-danger)' : undefined,
              },
            ].map((cell) => (
              <div
                key={cell.label}
                style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}
              >
                <div
                  style={{
                    font: "400 10.5px/1 var(--fx-font-mono)",
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {cell.label}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    font: "600 24px/1.1 var(--fx-font-sans)",
                    color: cell.tone ?? 'var(--fx-text-primary)',
                  }}
                >
                  {cell.value}
                </div>
              </div>
            ))}
          </div>

          <p
            style={{
              marginTop: 12,
              font: "400 12px/1.5 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {t('ui.quality.fabric_rate_note')}
          </p>

          <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
            <Button variant="primary" size="lg" disabled={!valid || pending} onClick={save}>
              {pending ? t('ui.quality.recording') : t('ui.quality.record_result')}
            </Button>
            <Button variant="ghost" onClick={() => setGrading(null)}>
              {t('ui.quality.back')}
            </Button>
            {!valid ? (
              <span
                style={{
                  font: "400 12px/1.4 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {t('ui.quality.need_length_width')}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── The deliveries ───────────────────────────────────────────────── */}
      {grns.map((grn) => {
        const open = grn.grnId === openGrn
        return (
          <section key={grn.grnId}>
            <button
              onClick={() => setOpenGrn(open ? null : grn.grnId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                width: '100%',
                minHeight: 56,
                padding: '12px 18px',
                border: '1px solid var(--fx-border-default)',
                background: 'var(--fx-bg-surface)',
                color: 'var(--fx-text-primary)',
                cursor: 'pointer',
                textAlign: 'left',
                font: "500 15px/1.3 var(--fx-font-sans)",
              }}
            >
              <span>{t('ui.quality.challan_heading', { challan: grn.challanNo })}</span>
              <span
                style={{
                  font: "400 12px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {t.plural('ui.quality.received_rolls', grn.rolls.length, {
                  date: grn.receivedAt,
                })}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {grn.failed > 0 ? (
                  <Badge tone="danger">{t.plural('ui.quality.failed_count', grn.failed)}</Badge>
                ) : null}
                {grn.uninspected > 0 ? (
                  <Badge tone="warning">
                    {t.plural('ui.quality.not_graded_count', grn.uninspected)}
                  </Badge>
                ) : (
                  <Badge tone="success">{t('ui.quality.badge_graded')}</Badge>
                )}
              </span>
            </button>

            {open ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                {grn.rolls.map((roll) => (
                  <div
                    className="fx-stack-tablet"
                    key={roll.rollId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px minmax(0, 1fr) 150px 160px',
                      gap: 14,
                      alignItems: 'center',
                      padding: '10px 18px',
                      border: '1px solid var(--fx-border-subtle)',
                      background: 'var(--fx-bg-surface)',
                    }}
                  >
                    <span style={{ font: "600 14px/1.2 var(--fx-font-sans)" }}>{roll.rollNo}</span>
                    <span
                      style={{
                        font: "400 12.5px/1.3 var(--fx-font-mono)",
                        color: 'var(--fx-text-tertiary)',
                        minWidth: 0,
                      }}
                    >
                      {roll.qty} {roll.unit}
                      {roll.lot ? t('ui.quality.lot_suffix', { lot: roll.lot }) : ''}
                      {roll.shadeGroup
                        ? t('ui.quality.shade_suffix', { shade: roll.shadeGroup })
                        : ''}
                    </span>
                    <span>
                      {roll.result === null ? (
                        <Badge tone="warning">{t('ui.quality.badge_not_graded')}</Badge>
                      ) : (
                        <span
                          style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}
                        >
                          <Badge tone={roll.result === 'pass' ? 'success' : 'danger'}>
                            {t('ui.quality.roll_result_badge', {
                              result: resultLabel(t, roll.result),
                              points: roll.pointsPer100SqYd,
                            })}
                          </Badge>
                          {/* Says whose verdict it is. "This roll passed" and "the delivery
                              it came in on passed" are different degrees of assurance. */}
                          {roll.inheritedFromGrn ? (
                            <span
                              style={{
                                font: "400 10.5px/1.2 var(--fx-font-mono)",
                                color: 'var(--fx-text-tertiary)',
                              }}
                            >
                              {t('ui.quality.inherited_from_grn')}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Button variant="ghost" onClick={() => startGrading(grn, roll)}>
                        {roll.result === null
                          ? t('ui.quality.grade_roll')
                          : t('ui.quality.regrade')}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
