'use client'

/**
 * The entity drawer, client half (specs/order-centric-core.md §3).
 *
 * ONE component renders every peek: the payload is declarative (`DrawerPeek`, built
 * server-side through the owning module's queries), so this file owns the chrome —
 * the slide-over, the scrim, Escape, the one-level stack — and no module ever ships a
 * bespoke screen in a side panel.
 *
 * ## The one-level stack, literally
 *
 * A peek opened from WITHIN a peek replaces the current one and remembers exactly one
 * step back (spec: "peek from within a peek replaces, not nests"). A peek opened from
 * the page starts fresh. Three fixed slots — current, previous, done — because an
 * unbounded breadcrumb trail is a navigation system, and a navigation system growing
 * inside a side panel is the bespoke-drawer disease this framework exists to end.
 *
 * `EntityRef` is the way in: an inline chip for any reference the reader can already
 * see (`PO-BF-2044`). Outside the provider it degrades to plain text — a page rendered
 * without the shell (print, a test) still reads correctly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { Badge, Button } from '@/components/fx/primitives'
import { useLocale, useT } from '@/components/fx/locale'
import { openEntityPeek } from '@/app/actions/entity-drawer'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import type { DrawerPeek } from '@/modules/core/drawer'

interface PeekApi {
  /** Open a peek from the PAGE — clears any back step. */
  open: (kind: string, reference: string) => void
}

const PeekContext = createContext<PeekApi | null>(null)

export function useEntityPeek(): PeekApi | null {
  return useContext(PeekContext)
}

export function EntityDrawerProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const locale = useLocale()

  const [current, setCurrent] = useState<DrawerPeek | null>(null)
  const [previous, setPrevious] = useState<DrawerPeek | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  // A slow response must not overwrite the peek of a faster, later click.
  const requestSeq = useRef(0)

  const load = useCallback(
    (kind: string, reference: string, from: DrawerPeek | null) => {
      const seq = ++requestSeq.current
      setVisible(true)
      setLoading(true)
      setError(null)
      setPrevious(from)

      void (async () => {
        try {
          const peek = unwrap(await openEntityPeek({ kind, reference }))
          if (requestSeq.current !== seq) return
          setCurrent(peek)
        } catch (cause) {
          if (requestSeq.current !== seq) return
          // The typed sentences — "switched off for this factory", "not found" —
          // arrive through the catalogue; anything else keeps the raw key for the
          // bug report it is about to become.
          setError(actionErrorMessage(cause, t('ui.common.retry'), locale))
          setCurrent(null)
        } finally {
          if (requestSeq.current === seq) setLoading(false)
        }
      })()
    },
    [locale, t],
  )

  const close = useCallback(() => {
    requestSeq.current += 1
    setVisible(false)
    setCurrent(null)
    setPrevious(null)
    setError(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    // Focus moves INTO the dialog so Escape and the reading order start there.
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, current, close])

  const api: PeekApi = {
    open: (kind, reference) => load(kind, reference, null),
  }

  return (
    <PeekContext.Provider value={api}>
      {children}

      {visible ? (
        <div
          onClick={close}
          style={{ position: 'fixed', inset: 0, zIndex: 57, backgroundColor: 'rgb(24 29 41 / .22)' }}
        />
      ) : null}

      {visible ? (
        <aside
          ref={panelRef}
          role="dialog"
          aria-modal
          aria-label={current?.title ?? t('ui.drawer.peek')}
          tabIndex={-1}
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 58,
            width: 400,
            maxWidth: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--fx-bg-surface)',
            borderLeft: '1px solid var(--fx-border-default)',
            boxShadow: 'var(--fx-sh3)',
            animation: 'fx-slide-in var(--fx-dur-overlay) var(--fx-ease-enter) both',
          }}
        >
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 18px',
              borderBottom: '1px solid var(--fx-border-subtle)',
            }}
          >
            {previous ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Back restores the remembered peek without a refetch — it is the
                  // page the reader just had, not a navigation.
                  setCurrent(previous)
                  setPrevious(null)
                  setError(null)
                }}
              >
                ← {t('ui.drawer.back')}
              </Button>
            ) : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                data-mono
                style={{
                  font: '600 15px/1.3 var(--fx-font-mono)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {loading ? t('ui.drawer.loading') : (current?.title ?? t('ui.drawer.peek'))}
              </div>
              {current?.subtitle && !loading ? (
                <div
                  style={{
                    font: '400 12.5px/1.35 var(--fx-font-sans)',
                    color: 'var(--fx-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {current.subtitle}
                </div>
              ) : null}
            </div>
            {current?.status && !loading ? (
              <Badge tone={current.status.tone}>{current.status.label}</Badge>
            ) : null}
            <Button variant="ghost" size="sm" onClick={close} aria-label={t('ui.common.close')}>
              ✕
            </Button>
          </header>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
            {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

            {current && !loading ? (
              <>
                <dl style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: 0 }}>
                  {current.facts.map((fact) => (
                    <div key={fact.labelKey} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <dt
                        style={{
                          font: '500 11px/1 var(--fx-font-mono)',
                          letterSpacing: '.06em',
                          textTransform: 'uppercase',
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {t(fact.labelKey)}
                      </dt>
                      <dd
                        data-mono={fact.mono || undefined}
                        style={{
                          margin: 0,
                          font: fact.mono
                            ? '400 14px/1.4 var(--fx-font-mono)'
                            : '400 14px/1.45 var(--fx-font-sans)',
                        }}
                      >
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {current.related && current.related.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
                    {current.related.map((rel) => (
                      <button
                        key={`${rel.kind}:${rel.reference}`}
                        type="button"
                        onClick={() => load(rel.kind, rel.reference, current)}
                        style={refChipStyle}
                      >
                        {rel.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {current?.href && !loading ? (
            <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--fx-border-subtle)' }}>
              <a
                href={current.href}
                style={{ font: '500 13.5px/1.4 var(--fx-font-sans)', color: 'var(--fx-accent)' }}
              >
                {t('ui.drawer.open_full')} →
              </a>
            </footer>
          ) : null}
        </aside>
      ) : null}
    </PeekContext.Provider>
  )
}

const refChipStyle: React.CSSProperties = {
  font: '500 12.5px/1 var(--fx-font-mono)',
  color: 'var(--fx-text-primary)',
  background: 'var(--fx-bg-sunken)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  padding: '7px 10px',
  minHeight: 'var(--fx-tap-min)',
  cursor: 'pointer',
}

/**
 * A reference the reader can peek — `<EntityRef kind="order" reference="PO-BF-2044" />`.
 *
 * Renders the reference (or `children`) as an inline chip; clicking opens the drawer.
 * Outside the provider it is a plain span, so a component using it never has to ask
 * whether the shell is mounted.
 */
export function EntityRef({
  kind,
  reference,
  children,
}: {
  kind: string
  reference: string
  children?: ReactNode
}) {
  const peek = useEntityPeek()
  const label = children ?? reference

  if (!peek) {
    return <span data-mono style={{ font: 'inherit' }}>{label}</span>
  }

  return (
    <button
      type="button"
      onClick={() => peek.open(kind, reference)}
      data-mono
      style={{
        font: 'inherit',
        color: 'inherit',
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        textDecoration: 'underline dotted',
        textUnderlineOffset: 3,
      }}
    >
      {label}
    </button>
  )
}
