/**
 * The Pulse, as pure logic (specs/order-centric-core.md §2).
 *
 * The strip's whole promise is triage a person can act on: what the order waits for
 * next, and what is in the way, worst first. Every rule here is a decision somebody
 * would otherwise re-derive per screen — which milestone is "next" when some have no
 * date, when the PP gate stops mattering, which LC distance is a warning and which is
 * money already lost.
 */
import { describe, expect, it } from 'vitest'

import {
  orderPulse,
  type PulseMilestone,
  type PulseShipment,
} from '@/modules/orders/service'

const TODAY = '2026-06-01'

const milestone = (over: Partial<PulseMilestone> = {}): PulseMilestone => ({
  name: 'fabric_in_house',
  plannedDate: '2026-06-10',
  actualDate: null,
  status: 'pending',
  ownerRole: 'store',
  ...over,
})

const shipment = (over: Partial<PulseShipment> = {}): PulseShipment => ({
  partialNo: 1,
  expNumber: 'EXP-123',
  portStatus: 'booked',
  daysAgainstLatestShipment: null,
  ...over,
})

const base = {
  status: 'in_production' as const,
  today: TODAY,
  milestones: [] as PulseMilestone[],
  ppGate: null,
  shipments: [] as PulseShipment[],
}

describe('a finished order has no pulse', () => {
  it.each(['closed', 'cancelled'] as const)('%s says nothing is owed', (status) => {
    const pulse = orderPulse({
      ...base,
      status,
      milestones: [milestone({ status: 'late' })],
      shipments: [shipment({ expNumber: null })],
    })
    expect(pulse.next).toBeNull()
    expect(pulse.facts).toEqual([])
  })
})

describe('what the order waits for next', () => {
  it('is the earliest undone milestone by planned date, with days to it', () => {
    const pulse = orderPulse({
      ...base,
      milestones: [
        milestone({ name: 'sewing_start', plannedDate: '2026-06-20' }),
        milestone({ name: 'fabric_in_house', plannedDate: '2026-06-04' }),
        // Done — however early its date, it is not "next".
        milestone({ name: 'lab_dip', plannedDate: '2026-05-01', actualDate: '2026-05-02' }),
      ],
    })
    expect(pulse.next).toEqual({
      name: 'fabric_in_house',
      plannedDate: '2026-06-04',
      daysTo: 3,
      ownerRole: 'store',
    })
  })

  it('an undated milestone sorts after every dated one, never ahead of them', () => {
    const pulse = orderPulse({
      ...base,
      milestones: [
        milestone({ name: 'undated', plannedDate: null }),
        milestone({ name: 'dated', plannedDate: '2026-07-01' }),
      ],
    })
    expect(pulse.next?.name).toBe('dated')
  })
})

describe('the PP gate on the strip', () => {
  const failedGate = {
    passed: false,
    reasonKey: 'gates.pp_approval.awaiting_feedback',
    facts: { requestId: 'req-1' },
  }

  it('a failed gate surfaces under its own reasonKey while cutting has not happened', () => {
    const pulse = orderPulse({ ...base, ppGate: failedGate })
    expect(pulse.facts).toContainEqual({
      key: 'gates.pp_approval.awaiting_feedback',
      params: { requestId: 'req-1' },
      severity: 'warning',
    })
  })

  it('escalates to critical once cutting_start is late', () => {
    const pulse = orderPulse({
      ...base,
      ppGate: failedGate,
      milestones: [milestone({ name: 'cutting_start', status: 'late' })],
    })
    expect(pulse.facts.find((f) => f.key === failedGate.reasonKey)?.severity).toBe('critical')
  })

  it('says nothing once cutting has actually happened — the gate is history', () => {
    // Re-litigating a passed moment would send a merchandiser chasing an approval
    // for fabric already on the tables.
    const pulse = orderPulse({
      ...base,
      ppGate: failedGate,
      milestones: [milestone({ name: 'cutting_start', actualDate: '2026-05-28' })],
    })
    expect(pulse.facts.find((f) => f.key === failedGate.reasonKey)).toBeUndefined()
  })
})

describe('milestone slippage', () => {
  it('late is critical and names the worst; at-risk is a warning', () => {
    const pulse = orderPulse({
      ...base,
      milestones: [
        milestone({ name: 'fabric_in_house', status: 'late' }),
        milestone({ name: 'sewing_start', status: 'at_risk' }),
      ],
    })
    expect(pulse.facts).toContainEqual({
      key: 'pulse.milestones_late',
      params: { count: 1, worst: 'fabric_in_house' },
      severity: 'critical',
    })
    expect(pulse.facts).toContainEqual({
      key: 'pulse.milestones_at_risk',
      params: { count: 1 },
      severity: 'warning',
    })
  })
})

describe('the shipment facts', () => {
  it('a booked shipment without an EXP is critical; a merely planned one owes nothing yet', () => {
    const pulse = orderPulse({
      ...base,
      shipments: [
        shipment({ partialNo: 1, expNumber: null, portStatus: 'booked' }),
        shipment({ partialNo: 2, expNumber: null, portStatus: 'planned' }),
      ],
    })
    expect(pulse.facts).toContainEqual({
      key: 'pulse.exp_missing',
      params: { partialNo: 1 },
      severity: 'critical',
    })
    expect(pulse.facts.filter((f) => f.key === 'pulse.exp_missing')).toHaveLength(1)
  })

  it('the LC clause: breached is critical with positive days, near is a warning, far is silence', () => {
    const pulse = orderPulse({
      ...base,
      shipments: [
        shipment({ partialNo: 1, daysAgainstLatestShipment: -3 }),
        shipment({ partialNo: 2, daysAgainstLatestShipment: 5 }),
        shipment({ partialNo: 3, daysAgainstLatestShipment: 30 }),
      ],
    })
    expect(pulse.facts).toContainEqual({
      key: 'pulse.lc_deadline_breached',
      params: { partialNo: 1, days: 3 },
      severity: 'critical',
    })
    expect(pulse.facts).toContainEqual({
      key: 'pulse.lc_deadline_near',
      params: { partialNo: 2, days: 5 },
      severity: 'warning',
    })
    expect(pulse.facts.filter((f) => String(f.key).startsWith('pulse.lc_'))).toHaveLength(2)
  })
})

describe('ordering', () => {
  it('critical facts precede warnings whatever order the sources supplied them', () => {
    const pulse = orderPulse({
      ...base,
      milestones: [milestone({ status: 'at_risk' })],
      shipments: [shipment({ expNumber: null, portStatus: 'gated_in' })],
    })
    expect(pulse.facts.map((f) => f.severity)).toEqual(['critical', 'warning'])
  })
})
