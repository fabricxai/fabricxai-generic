'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal, Toast } from '@/components/fx/feedback'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { MilestoneTimeline, type Milestone } from '@/components/fx/tna'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import {
  actualizeMilestone,
  generateOrderTna,
  previewMilestoneRipple,
  type RippleView,
} from '@/modules/orders/actions'
import { Select } from '@/components/fx/forms'

/**
 * The TNA, moved rather than read (plan 5.1, audit FE-B2).
 *
 * `MilestoneTimeline` has carried an `onActualize` prop since it was written and no caller
 * ever passed one, so the one artefact a merchandiser opens this screen for was a report.
 * The order detail page is a server component; this is the thin client shell that gives the
 * timeline a hand to move it with.
 *
 * ## The preview is the point
 *
 * Actualising `pp_approval` four days late does not move one row. It pushes cutting, sewing
 * and — often — the date the buyer was promised. A merchandiser is entitled to see that
 * before they commit it, not after, so the dialog asks the server what WOULD happen and
 * shows every milestone that moves and whether the ship date is one of them.
 *
 * The preview and the write run the same `previewRipplePure` on the same schedule, so they
 * cannot disagree — and the write returns its own ripple anyway, which is what the
 * confirmation reports. A screen that echoed the preview would be telling somebody what it
 * expected rather than what happened.
 */
export function OrderTna({
  orderId,
  milestones,
  canWrite,
  templates = [],
  defaultExFactory = null,
}: {
  orderId: string
  milestones: readonly Milestone[]
  /** False for a role that may read the schedule but not move it — the prop simply goes. */
  canWrite: boolean
  /** Active templates, for the generate control. Passed only when the schedule is empty. */
  templates?: readonly { id: string; name: string; productType: string }[]
  defaultExFactory?: string | null
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [target, setTarget] = useState<Milestone | null>(null)
  const [actualDate, setActualDate] = useState(() => factoryToday())
  const [preview, setPreview] = useState<RippleView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  function open(milestone: Milestone) {
    setTarget(milestone)
    setPreview(null)
    setFailure(null)
    // Today, in the factory's timezone — not the browser's. A supervisor on a tablet whose
    // clock says UTC would otherwise file the night shift's milestone against yesterday.
    const today = factoryToday()
    setActualDate(today)
    void load(milestone, today)
  }

  function load(milestone: Milestone, date: string) {
    setFailure(null)
    startTransition(async () => {
      try {
        setPreview(await previewMilestoneRipple({ milestoneId: milestone.id, actualDate: date }))
      } catch (error) {
        setPreview(null)
        setFailure(actionErrorMessage(error, t('ui.orders.ripple_unavailable'), locale))
      }
    })
  }

  function commit() {
    if (!target) return
    const milestone = target

    startTransition(async () => {
      try {
        const result = await actualizeMilestone({
          milestoneId: milestone.id,
          actualDate,
        })

        setTarget(null)
        // What the WRITE did, not what the preview said. They agree today; a screen that
        // reported the preview would still be reporting an expectation.
        setToast(
          result.exFactorySlipDays === 0
            ? t('ui.orders.actualized_no_slip', { count: result.shifted.length })
            : t('ui.orders.actualized_slipped', {
                count: result.shifted.length,
                days: result.exFactorySlipDays,
                date: result.newExFactoryDate ?? '—',
              }),
        )
        setTimeout(() => setToast(null), 5200)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.orders.actualize_failed'), locale))
      }
    })
  }

  return (
    <>
      {milestones.length === 0 && canWrite ? (
        <GenerateSchedule
          orderId={orderId}
          templates={templates}
          defaultExFactory={defaultExFactory ?? null}
        />
      ) : null}

      <MilestoneTimeline
        milestones={milestones}
        locale={locale}
        {...(canWrite ? { onActualize: open } : {})}
      />

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={t('ui.orders.actualize_title')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
              {t('ui.orders.actual_date')}
            </span>
            <input
              type="date"
              value={actualDate}
              onChange={(e) => {
                setActualDate(e.target.value)
                if (target && e.target.value) load(target, e.target.value)
              }}
              style={{
                font: "400 15px/1.2 var(--fx-font-mono)",
                padding: '10px 12px',
                minHeight: 'var(--fx-tap-min)',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-md)',
                background: 'var(--fx-bg-surface)',
                color: 'var(--fx-text-primary)',
              }}
            />
          </label>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          {preview ? <RippleSummary preview={preview} /> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              {t('ui.common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={commit}
              // Not while the preview is still loading: the whole point of the dialog is
              // that nobody commits a ship-date change they have not been shown.
              disabled={pending || preview === null}
            >
              {t('ui.orders.actualize_confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', left: 28, bottom: 28, zIndex: 50, maxWidth: 460 }}>
          <Toast message={toast} />
        </div>
      ) : null}
    </>
  )
}

/**
 * What this date does to the rest of the schedule.
 *
 * The ship date is called out separately from the count, because those are two different
 * questions and only one of them is a conversation with the buyer. "Six milestones move" is
 * housekeeping; "six move and the vessel date goes back four days" is a phone call.
 */
function RippleSummary({ preview }: { preview: RippleView }) {
  const t = useT()
  const slipped = preview.exFactorySlipDays > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <InlineAlert tone={slipped ? 'danger' : preview.shifted.length > 0 ? 'warning' : 'info'}>
        {slipped
          ? t('ui.orders.ripple_slips', {
              count: preview.shifted.length,
              days: preview.exFactorySlipDays,
              date: preview.newExFactoryDate ?? '—',
            })
          : preview.shifted.length > 0
            ? t('ui.orders.ripple_absorbed', { count: preview.shifted.length })
            : t('ui.orders.ripple_none')}
      </InlineAlert>

      {preview.shifted.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          {preview.shifted.map((change) => (
            <li
              key={change.name}
              style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
            >
              <span style={{ color: 'var(--fx-text-primary)', fontWeight: 500 }}>
                {t(`orders.milestones.${change.name}`)}
              </span>
              {change.critical ? (
                <span
                  style={{
                    font: "500 10px/1 var(--fx-font-mono)",
                    letterSpacing: '.05em',
                    color: 'var(--fx-text-tertiary)',
                    marginLeft: 6,
                  }}
                >
                  CP
                </span>
              ) : null}
              {' — '}
              <span data-mono style={{ font: "400 12px/1.4 var(--fx-font-mono)" }}>
                {change.fromDate} → {change.toDate}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The hand that fills an empty schedule.
 *
 * `generateOrderTna` has existed since the desk was built — its docblock even says it is
 * "available from the desk" — and no screen ever called it. An order booked from a PO drop
 * therefore had a permanently empty schedule tab, while an RFQ-won order got its TNA from
 * the consumer. The control renders ONLY when the schedule is empty and the caller can
 * write: once milestones exist, regenerating belongs to a deliberate decision, not a
 * button next to real dates.
 */
function GenerateSchedule({
  orderId,
  templates,
  defaultExFactory,
}: {
  orderId: string
  templates: readonly { id: string; name: string; productType: string }[]
  defaultExFactory: string | null
}) {
  const t = useT()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [exFactory, setExFactory] = useState(defaultExFactory ?? '')
  const [failure, setFailure] = useState<string | null>(null)

  if (templates.length === 0) {
    // No active templates is a Settings problem, and saying so beats a disabled control.
    return <InlineAlert tone="info">{t('ui.orders.tna_no_templates')}</InlineAlert>
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        background: 'var(--fx-bg-surface)',
      }}
    >
      <span style={{ font: "400 13.5px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
        {t('ui.orders.tna_generate_body')}
      </span>

      <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <Select
          label={t('ui.orders.tna_template')}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} · {tpl.productType}
            </option>
          ))}
        </Select>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 12px/1 var(--fx-font-mono)", letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--fx-text-tertiary)' }}>
            {t('ui.orders.tna_ex_factory')}
          </span>
          <input
            type="date"
            value={exFactory}
            onChange={(e) => setExFactory(e.target.value)}
            style={{
              font: "400 14px/1.2 var(--fx-font-sans)",
              padding: '10px 12px',
              minHeight: 'var(--fx-tap-min)',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-md)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
            }}
          />
        </label>

        <Button
          variant="primary"
          disabled={pending || !templateId || !exFactory}
          onClick={() =>
            startTransition(async () => {
              try {
                unwrap(await generateOrderTna({ orderId, templateId, exFactoryDate: exFactory }))
                setFailure(null)
                router.refresh()
              } catch (error) {
                setFailure(actionErrorMessage(error, t('ui.orders.tna_generate_failed')))
              }
            })
          }
        >
          {t('ui.orders.tna_generate')}
        </Button>
      </div>

      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
    </div>
  )
}
