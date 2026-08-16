'use client'

import { factoryToday } from '@/lib/dates'
import { useEffect, useRef, useState } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { ReadIntoForm, type ReadFields } from '@/components/shell/read-into-form'
import { matchItem } from '@/lib/match-item'
import { SyncPill } from '@/components/fx/floor'
import { useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { DateInput } from '@/components/fx/forms'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import { compareQty, quantity, subtractQty, sumQty, zeroQty } from '@/lib/quantity'
import {
  documentLimits,
  humanBytes,
  uploadDocument,
  UploadError,
  type DocumentLimits,
  type UploadedDocument,
} from '@/lib/upload-document'
import { challanMaterials } from '@/modules/store/stock'

interface ItemOption {
  id: string
  code: string
  name: string
  uom: string
}

interface LocationOption {
  id: string
  code: string
  name: string
  kind: string
}

interface RollDraft {
  key: string
  rollNo: string
  qty: string
  lot: string
  dyeLot: string
  shadeGroup: string
}

const field: React.CSSProperties = {
  minHeight: 44,
  padding: '10px 12px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-sans)",
  width: '100%',
}

const label: React.CSSProperties = {
  font: "500 12.5px/1.3 var(--fx-font-sans)",
  color: 'var(--fx-text-secondary)',
}

/**
 * One challan, one item, its rolls.
 *
 * Deliberately single-item. A challan usually carries one fabric, and a form that lets a
 * storekeeper build an arbitrary multi-item receipt on a tablet at the delivery bay is a
 * form that gets abandoned halfway. Receiving a second item is a second GRN, which is also
 * how the paperwork works.
 *
 * The roll list is the part that matters: stock in this module is roll-level, so a receipt
 * that records a bulk quantity and no rolls produces stock nobody can issue. The total is
 * shown against the line quantity as they type, because the two disagreeing is the single
 * most common error in a receipt and the rack is where it can still be recounted.
 */
export function ReceiveClient({
  items,
  locations,
  uds,
}: {
  items: readonly ItemOption[]
  locations: readonly LocationOption[]
  /** Live declarations, for a bonded receipt to name. */
  uds: readonly { id: string; number: string }[]
}) {
  const t = useT()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  const [challanNo, setChallanNo] = useState('')
  const [receivedAt, setReceivedAt] = useState(() => factoryToday())
  const [itemId, setItemId] = useState(items[0]?.id ?? '')
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
  const [udId, setUdId] = useState('')
  const [qty, setQty] = useState('')
  /*
   * The price on the challan line (live-test finding, Phase 8). The zod has accepted an
   * optional `unitPrice` since 3.1 and this screen never offered the field — so no GRN
   * received through the product carried a price, and finance's actual-cost accrual,
   * which reads GRN line prices and refuses to invent what nobody recorded, accrued
   * zero for every order. Optional here too: a storekeeper without the price should
   * still receive the goods, but the blank now costs a decision instead of existing
   * invisibly.
   */
  const [unitPrice, setUnitPrice] = useState('')
  const [rolls, setRolls] = useState<RollDraft[]>([])
  const [received, setReceived] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** What the reading could not match to the master list, said plainly rather than dropped. */
  const [readNote, setReadNote] = useState<string | null>(null)

  // The challan itself. The paper in the storekeeper's hand is the document a supplier
  // will invoice against and a customs officer may ask for, and the typed fields are a
  // transcription of it — so the photo is attached to the GRN, not used and discarded.
  const [challanPhoto, setChallanPhoto] = useState<UploadedDocument | null>(null)
  const [photoState, setPhotoState] = useState<'idle' | 'uploading' | 'failed'>('idle')
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [limits, setLimits] = useState<DocumentLimits | null>(null)
  const photoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void documentLimits().then((value) => {
      if (!cancelled) setLimits(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function capturePhoto(file: File) {
    setPhotoError(null)
    setPhotoState('uploading')
    try {
      setChallanPhoto(await uploadDocument(file, { kind: 'challan', moduleId: 'store', limits }))
      setPhotoState('idle')
    } catch (e) {
      setPhotoState('failed')
      setPhotoError(
        e instanceof UploadError
          ? e.retryable
            ? t('ui.store.challan_upload_retryable', { reason: e.message })
            : e.message
          : t('ui.store.challan_upload_failed'),
      )
    }
  }

  const item = items.find((i) => i.id === itemId)
  const location = locations.find((l) => l.id === locationId)
  // Exact decimal arithmetic, not floats. A challan of 21,000 m across fourteen rolls
  // summed as doubles drifts, and the number this screen refuses to receive on is the one
  // the supplier will invoice against.
  const unit = item?.uom ?? 'unit'
  const rollTotal = sumQty(
    rolls.map((roll) => quantity(decimalOrZero(roll.qty), unit)),
    unit,
  )
  const lineQty = quantity(decimalOrZero(qty), unit)
  const difference = subtractQty(rollTotal, lineQty)
  const mismatch = rolls.length > 0 && compareQty(rollTotal, lineQty) !== 0

  const bonded = location?.kind === 'bonded'
  const complete =
    challanNo.trim() !== '' &&
    compareQty(lineQty, zeroQty(unit)) > 0 &&
    rolls.length > 0 &&
    !mismatch &&
    Boolean(item)

  function addRoll() {
    setRolls((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        rollNo: '',
        qty: '',
        lot: current[current.length - 1]?.lot ?? '',
        dyeLot: current[current.length - 1]?.dyeLot ?? '',
        shadeGroup: current[current.length - 1]?.shadeGroup ?? '',
      },
    ])
  }

  function patchRoll(key: string, patch: Partial<RollDraft>) {
    setRolls((current) => current.map((roll) => (roll.key === key ? { ...roll, ...patch } : roll)))
  }

  async function receive() {
    setError(null)
    if (!complete || !item) return

    if (bonded && !udId) {
      // The schema's check constraint refuses a bonded GRN with no UD. This screen used
      // to refuse ALL bonded receipts here — the picker below did not exist, so the one
      // thing a bonded warehouse does could not be recorded from the product at all
      // (live-test finding, Phase 4). Now only a bonded receipt with no declaration
      // NAMED is refused, which is the real rule.
      setError(t('ui.store.bonded_needs_ud'))
      return
    }

    await capture({
      moduleId: 'store',
      operation: 'receive_grn',
      payload: {
        challanNo: challanNo.trim(),
        receivedAt,
        bonded,
        ...(bonded && udId ? { udId } : {}),
        ...(challanPhoto ? { documentId: challanPhoto.documentId } : {}),
        lines: [
          {
            itemId: item.id,
            qty: lineQty.value,
            unit: item.uom,
            ...(unitPrice.trim() ? { unitPrice: unitPrice.trim() } : {}),
            rolls: rolls.map((roll) => ({
              rollNo: roll.rollNo.trim(),
              qty: quantity(decimalOrZero(roll.qty), unit).value,
              locationId,
              ...(roll.lot.trim() ? { lot: roll.lot.trim() } : {}),
              ...(roll.dyeLot.trim() ? { dyeLot: roll.dyeLot.trim() } : {}),
              ...(roll.shadeGroup.trim() ? { shadeGroup: roll.shadeGroup.trim() } : {}),
            })),
          },
        ],
      },
    })

    setReceived((done) => [...done, `${challanNo.trim()} · ${rolls.length} rolls · ${item.code}`])
    setChallanNo('')
    setQty('')
    setUnitPrice('')
    setRolls([])
    setChallanPhoto(null)
    setPhotoState('idle')
  }

  /**
   * The challan, read off the photograph the screen was already taking.
   *
   * This form has photographed the challan since it was built, attached it to the GRN, and
   * then asked the storekeeper to type what was in the photograph — every delivery, every
   * day, on a tablet, next to a truck. One drop now does both: the paper is kept as evidence
   * (a supplier invoices against it and customs may ask for it) and the fields fill in.
   *
   * Items are matched by CODE first, then by name, against this factory's master list —
   * a challan says "30/1 combed cotton yarn", never a uuid. A line that matches nothing is
   * SAID, not silently dropped: an unmatched material is usually an item nobody has set up
   * yet, and the storekeeper needs to know which one before they save a receipt missing it.
   *
   * Bonded and the UD are never read. Whether a receipt is duty-free is a customs position
   * rather than a line on a delivery note, and getting it wrong in either direction is a
   * legal problem, not a typing one — the storekeeper says so, deliberately, every time.
   */
  function fillFromChallan(read: ReadFields) {
    const v = read.values
    const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))

    setChallanPhoto(read.document)
    if (v.challanNo !== undefined) setChallanNo(str(v.challanNo))
    if (v.receivedAt !== undefined) setReceivedAt(str(v.receivedAt))

    /*
     * Rows that name nothing are the challan book restating itself — row 2 of ZJH-DC-8842
     * is row 1 again as a roll count. Dropped before anything is chosen, or the phantom
     * becomes the material and the fabric never arrives.
     */
    const lines = challanMaterials<Record<string, unknown> & { itemCode: string; itemName: string }>(
      (Array.isArray(v.lines) ? (v.lines as Record<string, unknown>[]) : []).map((line) => ({
        ...line,
        itemCode: str(line.itemCode),
        itemName: str(line.itemName),
      })),
    )
    const first = lines[0]
    if (!first) return

    /*
     * Several lines of the SAME material are lots, not materials.
     *
     * A yarn challan routinely lists one material three times — three lots off three
     * different machines, each with its own weight — and the kit's own says exactly that:
     * "3 lots, 10,600 kg reconciles". Treating those as three separate deliveries would have
     * the storekeeper receive a third of the truck and believe they were done. Summed when
     * they agree on the material; kept separate when they do not.
     */
    const sameMaterial = lines.every(
      (line) => str(line.itemName).trim().toLowerCase() === str(first.itemName).trim().toLowerCase(),
    )
    const lots = sameMaterial ? lines : [first]

    const match = matchItem(items, str(first.itemCode), str(first.itemName))
    if (match) setItemId(match.id)

    const total = lots.reduce((sum, line) => sum + (Number(str(line.qty)) || 0), 0)
    if (total > 0) setQty(String(total))

    const readRolls = Array.isArray(first.rolls) ? (first.rolls as Record<string, unknown>[]) : []
    if (readRolls.length > 0) {
      setRolls(
        readRolls.map((roll, i) => ({
          key: `read-${i}`,
          rollNo: str(roll.rollNo),
          qty: str(roll.qty),
          lot: str(roll.lot),
          dyeLot: str(roll.lot),
          shadeGroup: str(roll.shadeGroup),
        })),
      )
    }

    const notes: string[] = []
    if (!match) {
      notes.push(
        `The challan says “${str(first.itemName)}”, which is not on the item list — pick the right item, or add it in factory setup first.`,
      )
    }
    if (lines.length > 1 && sameMaterial) {
      notes.push(`It lists ${lines.length} lots of the same material, added up to ${total}.`)
    } else if (lines.length > 1) {
      // One GRN, one item on this screen. Saying so beats filling the first line and letting
      // somebody believe the whole delivery is entered.
      notes.push(
        `It lists ${lines.length} different materials. The first is filled in — receive it, then repeat for the rest.`,
      )
    }
    setReadNote(notes.length > 0 ? notes.join(' ') : null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {t.plural('ui.store.receive_refused', refused.length)}
          {refused.map((r) => (
            <button
              key={r.offlineKey}
              onClick={() => void clear(r.offlineKey)}
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                textDecoration: 'underline',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {t('ui.common.dismiss')}
            </button>
          ))}
        </InlineAlert>
      ) : null}

      {received.length > 0 ? (
        <InlineAlert tone="success">
          {t('ui.store.receive_done', { list: received.join(' · ') })}{' '}
          {online ? t('ui.store.receive_done_sent') : t('ui.store.receive_done_held')}
        </InlineAlert>
      ) : null}

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      <SectionHeading eyebrow={t('ui.store.challan_eyebrow')}>
        {t('ui.store.challan_heading')}
      </SectionHeading>

      {/* `capture="environment"` opens the rear camera straight away on a phone or tablet,
          which is what a storekeeper has in the delivery bay. On a desktop it degrades to
          an ordinary file picker, so a scanned PDF works from the office too. */}
      <input
        ref={photoRef}
        type="file"
        hidden
        accept={limits?.allowedMime.join(',') ?? 'image/*,application/pdf'}
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void capturePhoto(file)
        }}
      />

      <ReadIntoForm kindId="delivery_challan" prompt="the challan" onFilled={fillFromChallan} />
      {readNote ? <InlineAlert tone="warning">{readNote}</InlineAlert> : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          padding: '14px 16px',
          border: `1px ${challanPhoto ? 'solid' : 'dashed'} var(--fx-border-default)`,
          borderRadius: 'var(--fx-radius-md)',
          background: challanPhoto ? 'var(--fx-bg-surface)' : 'var(--fx-bg-sunken)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ font: "500 13.5px/1.3 var(--fx-font-sans)" }}>
            {challanPhoto ? t('ui.store.challan_attached') : t('ui.store.challan_photograph')}
          </span>
          <span
            style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
          >
            {challanPhoto
              ? `${challanPhoto.filename} · ${humanBytes(challanPhoto.sizeBytes)}`
              : photoState === 'uploading'
                ? t('ui.store.challan_sending')
                : t('ui.store.challan_why')}
          </span>
        </div>

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {challanPhoto ? (
            <Button variant="ghost" onClick={() => setChallanPhoto(null)}>
              {t('ui.common.remove')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={photoState === 'uploading'}
            onClick={() => photoRef.current?.click()}
          >
            {photoState === 'uploading'
              ? t('ui.store.challan_sending_button')
              : challanPhoto
                ? t('ui.store.challan_replace')
                : t('ui.store.challan_take_photo')}
          </Button>
        </span>
      </div>

      {photoError ? (
        <InlineAlert tone={photoState === 'failed' ? 'warning' : 'danger'}>{photoError}</InlineAlert>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('ui.store.field_challan_no')}</span>
          <input
            value={challanNo}
            onChange={(e) => setChallanNo(e.target.value)}
            placeholder="CH-2026-0431"
            style={{ ...field, font: "400 14px/1.4 var(--fx-font-mono)" }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('ui.store.field_received_on')}</span>
          <DateInput
            value={receivedAt}
            onChange={setReceivedAt}
            style={field}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('ui.store.field_item')}</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} style={field}>
            {items.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('ui.store.field_into')}</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={field}>
            {locations.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
                {option.kind === 'bonded' ? t('ui.store.location_bonded_suffix') : ''}
              </option>
            ))}
          </select>
        </label>

        {bonded ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>{t('ui.store.ud_label')}</span>
            <select value={udId} onChange={(e) => setUdId(e.target.value)} style={field}>
              <option value="">{t('ui.store.ud_choose')}</option>
              {uds.map((ud) => (
                <option key={ud.id} value={ud.id}>
                  {ud.number}
                </option>
              ))}
            </select>
            <span style={{ font: "400 12px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              {t('ui.store.ud_hint')}
            </span>
          </label>
        ) : null}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>
            {t('ui.store.field_qty_on_challan', { unit: item?.uom ?? '—' })}
          </span>
          <input
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="21000.00"
            style={{ ...field, font: "400 14px/1.4 var(--fx-font-mono)" }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('ui.store.field_unit_price')}</span>
          <input
            inputMode="decimal"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="4.20"
            style={{ ...field, font: "400 14px/1.4 var(--fx-font-mono)" }}
          />
          <span style={{ font: "400 12px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.store.unit_price_hint')}
          </span>
        </label>
      </div>

      {bonded ? (
        <InlineAlert tone="warning">
          {t('ui.store.bonded_warning', { code: location?.code ?? '' })}
        </InlineAlert>
      ) : null}

      <SectionHeading eyebrow={t('ui.store.rolls_counted_eyebrow', { count: rolls.length })}>
        {t('ui.store.rolls_heading')}
      </SectionHeading>

      {mismatch ? (
        <InlineAlert tone="warning">
          {t('ui.store.rolls_mismatch', {
            counted: rollTotal.value,
            expected: lineQty.value,
            difference: difference.value,
            unit,
          })}
        </InlineAlert>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rolls.map((roll, index) => (
          <div
            key={roll.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '32px 1.2fr 1fr .9fr .9fr .8fr 44px',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {index + 1}
            </span>
            <input
              value={roll.rollNo}
              onChange={(e) => patchRoll(roll.key, { rollNo: e.target.value })}
              aria-label={t('ui.store.roll_number_label', { index: index + 1 })}
              placeholder={t('ui.store.roll_no_placeholder')}
              style={{ ...field, font: "400 13px/1.4 var(--fx-font-mono)" }}
            />
            <input
              inputMode="decimal"
              value={roll.qty}
              onChange={(e) => patchRoll(roll.key, { qty: e.target.value })}
              aria-label={t('ui.store.roll_qty_label', { index: index + 1 })}
              placeholder={item?.uom ?? 'qty'}
              style={{ ...field, font: "400 13px/1.4 var(--fx-font-mono)" }}
            />
            <input
              value={roll.lot}
              onChange={(e) => patchRoll(roll.key, { lot: e.target.value })}
              aria-label={t('ui.store.roll_lot_label', { index: index + 1 })}
              placeholder={t('ui.store.roll_lot_placeholder')}
              style={{ ...field, font: "400 13px/1.4 var(--fx-font-mono)" }}
            />
            <input
              value={roll.dyeLot}
              onChange={(e) => patchRoll(roll.key, { dyeLot: e.target.value })}
              aria-label={t('ui.store.roll_dye_lot_label', { index: index + 1 })}
              placeholder={t('ui.store.roll_dye_lot_placeholder')}
              style={{ ...field, font: "400 13px/1.4 var(--fx-font-mono)" }}
            />
            <input
              value={roll.shadeGroup}
              onChange={(e) => patchRoll(roll.key, { shadeGroup: e.target.value })}
              aria-label={t('ui.store.roll_shade_label', { index: index + 1 })}
              placeholder={t('ui.store.roll_shade_placeholder')}
              style={{ ...field, font: "400 13px/1.4 var(--fx-font-mono)" }}
            />
            <button
              onClick={() => setRolls((current) => current.filter((r) => r.key !== roll.key))}
              aria-label={t('ui.store.roll_remove_label', { index: index + 1 })}
              style={{
                minHeight: 44,
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-sm)',
                background: 'transparent',
                color: 'var(--fx-text-tertiary)',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button variant="ghost" onClick={addRoll}>
          {t('ui.store.add_roll')}
        </Button>
        <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          {rolls.length > 0
            ? t('ui.store.rolls_progress', {
                counted: rollTotal.value,
                expected: lineQty.value,
                unit,
              })
            : t('ui.store.rolls_none_yet')}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button variant="primary" size="lg" disabled={!complete} onClick={() => void receive()}>
            {rolls.length > 0
              ? t.plural('ui.store.receive_button', rolls.length)
              : t('ui.store.receive_button')}
          </Button>
        </span>
      </div>
    </div>
  )
}

/** Anything the storekeeper has not finished typing counts as nothing, not as NaN. */
function decimalOrZero(raw: string): string {
  const trimmed = raw.trim()
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? trimmed : '0'
}
