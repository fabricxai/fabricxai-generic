'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'

import { Badge } from '@/components/fx/primitives'

import { markAlertsRead } from './alerts-actions'

export interface AlertItem {
  id: string
  title: string
  body?: string
  href: string | null
  severity: 'info' | 'warning' | 'critical'
  age: string
}

/**
 * Top-bar Alerts control — unread job/escalation notifications.
 *
 * Separate from Approve on purpose: drafts wait for a signature, alerts wait for
 * a look. Same Badge language the rest of the chrome already uses.
 */
export function AlertsPopover({ alerts }: { alerts: readonly AlertItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const boxRef = useRef<HTMLDivElement>(null)
  const count = alerts.length

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function markOne(id: string) {
    startTransition(async () => {
      await markAlertsRead({ ids: [id] })
      router.refresh()
    })
  }

  function markAll() {
    if (alerts.length === 0) return
    startTransition(async () => {
      await markAlertsRead({ ids: alerts.map((a) => a.id) })
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={count > 0 ? `Alerts, ${count} unread` : 'Alerts'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 'var(--fx-tap-min)',
          padding: '6px 10px',
          borderRadius: 'var(--fx-radius-md)',
          border: '1px solid var(--fx-border-subtle)',
          background: open ? 'var(--fx-bg-selected)' : 'transparent',
          color: 'var(--fx-text-secondary)',
          font: '500 13px/1 var(--fx-font-sans)',
          cursor: 'pointer',
        }}
      >
        Alerts
        {count > 0 ? <Badge tone="accent">{count > 99 ? '99+' : count}</Badge> : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Unread alerts"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 360,
            maxWidth: 'min(360px, 92vw)',
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--fx-bg-surface)',
            border: '1px solid var(--fx-border-subtle)',
            borderRadius: 'var(--fx-radius-md)',
            boxShadow: 'var(--fx-sh2)',
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 14px',
              borderBottom: '1px solid var(--fx-border-subtle)',
            }}
          >
            <span style={{ font: '600 14px/1.2 var(--fx-font-sans)', color: 'var(--fx-text-primary)' }}>
              {count === 0 ? 'No unread alerts' : `${count} unread`}
            </span>
            {count > 0 ? (
              <button
                type="button"
                disabled={pending}
                onClick={markAll}
                style={{
                  border: 'none',
                  background: 'transparent',
                  font: '500 12px/1 var(--fx-font-sans)',
                  color: 'var(--fx-text-secondary)',
                  cursor: 'pointer',
                  padding: 4,
                }}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          {count === 0 ? (
            <div
              style={{
                padding: '20px 14px',
                font: '400 13.5px/1.5 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
              }}
            >
              Job escalations and night scans land here. Drafts to sign stay in Approve.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {alerts.map((alert) => (
                <li
                  key={alert.id}
                  style={{
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--fx-border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge
                      tone={
                        alert.severity === 'critical'
                          ? 'danger'
                          : alert.severity === 'warning'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {alert.severity}
                    </Badge>
                    <span
                      style={{
                        marginLeft: 'auto',
                        font: '400 11px/1 var(--fx-font-mono)',
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {alert.age}
                    </span>
                  </div>
                  <div style={{ font: '500 13.5px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-primary)' }}>
                    {alert.href ? (
                      <Link
                        href={alert.href}
                        onClick={() => {
                          markOne(alert.id)
                          setOpen(false)
                        }}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        {alert.title}
                      </Link>
                    ) : (
                      alert.title
                    )}
                  </div>
                  {alert.body ? (
                    <div
                      style={{
                        font: '400 12.5px/1.45 var(--fx-font-sans)',
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {alert.body}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => markOne(alert.id)}
                    style={{
                      alignSelf: 'flex-start',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      font: '500 12px/1 var(--fx-font-sans)',
                      color: 'var(--fx-text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    Mark read
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
