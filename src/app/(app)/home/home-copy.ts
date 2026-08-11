/**
 * Plain-language copy for the Your work (`/home`) feed.
 *
 * Sources stay in their modules; this file only decides how a human reads a
 * kind, age or severity — same idea as Settings policy-copy.
 */

import type { ExceptionKind } from '@/modules/analytics/analytics'

export type SeverityTone = 'low' | 'medium' | 'high'

export interface WorkRow {
  id: string
  title: string
  why: string
  href: string
  age?: string
  severity?: SeverityTone
  cta: string
}

const LIST_CAP = 6

export function capRows<T>(rows: readonly T[], limit = LIST_CAP): { rows: T[]; more: number } {
  if (rows.length <= limit) return { rows: [...rows], more: 0 }
  return { rows: rows.slice(0, limit), more: rows.length - limit }
}

export function ageLabel(ageHours: number): string {
  if (ageHours < 1) return 'just now'
  if (ageHours < 24) return `${Math.floor(ageHours)}h`
  const days = Math.floor(ageHours / 24)
  return days === 1 ? '1 day' : `${days} days`
}

export function ageDaysLabel(ageDays: number): string {
  if (ageDays <= 0) return 'today'
  return ageDays === 1 ? '1 day' : `${ageDays} days`
}

/** Where an exceptions-feed kind opens. Falls back to the factory pulse. */
export function exceptionHref(kind: ExceptionKind | string): string {
  switch (kind) {
    case 'lc_conflict':
      return '/lcs'
    case 'tna_risk':
      return '/orders'
    case 'cap_critical':
      return '/compliance'
    case 'approval_waiting':
      return '/approve'
    case 'runrate_miss':
      return '/lines'
    case 'payroll_anomaly':
      return '/workforce'
    default:
      return '/dashboard'
  }
}

export function exceptionKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ')
}

export function draftWhy(input: {
  moduleId: string
  aging: boolean
  ageHours: number
  fromModel: boolean
}): string {
  const source = input.fromModel ? 'Model draft' : 'Human draft'
  if (input.aging) {
    return `${source} from ${input.moduleId} — past the aging window (${ageLabel(input.ageHours)}).`
  }
  return `${source} from ${input.moduleId} · waiting ${ageLabel(input.ageHours)}.`
}

export const HOME_COPY = {
  title: 'Your work',
  eyebrow: 'What needs you',
  decideNow: 'Decide now',
  whatIsWrong: 'What is wrong',
  alerts: 'Alerts',
  quietBuyers: 'Quiet buyers',
  quotesNeedingYou: 'Quotes needing you',
  ordersAtRisk: 'Orders at risk',
  ppBlocking: 'PP blocking cut',
  seeAll: 'See all',
  open: 'Open',
  decide: 'Decide',
  markRead: 'Mark read',
  calmTitle: 'Nothing waiting on you',
  calmBody:
    'When a draft, exception or overdue desk item lands, it shows up here. Until then the factory pulse and the order book are a good place to look.',
  calmDashboard: 'Factory pulse',
  calmOrders: 'Order desk',
  decideEmpty: 'No drafts in your queue.',
  wrongEmpty: 'Nothing open in the feed.',
  alertsEmpty: 'No unread alerts.',
  quietEmpty: 'No quiet leads.',
  quotesEmpty: 'No overdue quotes.',
  ordersEmpty: 'No orders at risk.',
  ppEmpty: 'No PP samples blocking cut.',
} as const
