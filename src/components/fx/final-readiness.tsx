import { StatusLabel } from '@/components/fx/signature'

/**
 * Will this order fail its final inspection? (adoption plan 5.2)
 *
 * `preFinalReadiness` has computed the answer since 6.x and reached exactly one surface: a
 * MARBIM tool. So the merchandiser whose order it is, and the quality desk that will run the
 * inspection, could only get it by asking the copilot a question neither of them knew to ask
 * — while the four inspection screens each showed their own fragment and none of them said
 * "this lot is heading for a fail".
 *
 * Blockers are NAMED rather than counted, which is the service's own decision and worth
 * keeping here: "no measurement check on record" and "last inline DHU above threshold" need
 * different people to do different things, and a single not-ready flag sends nobody anywhere.
 *
 * Renders nothing when the order has no final inspection inside the window — a permanent
 * "nothing to report" panel on every order page is furniture.
 */
export function FinalReadinessStrip({
  readiness,
}: {
  readiness: {
    plannedFinalDate: string
    daysToFinal: number
    ready: boolean
    blockers: string[]
  } | null
}) {
  if (!readiness) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 16px',
        borderRadius: 'var(--fx-radius-md)',
        border: '1px solid var(--fx-border-subtle)',
        background: 'var(--fx-bg-surface)',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            font: "500 11px/1 var(--fx-font-mono)",
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--fx-text-tertiary)',
          }}
        >
          Final inspection
        </span>
        <StatusLabel status={readiness.ready ? 'on-track' : 'at-risk'}>
          {readiness.ready ? 'ready' : 'not ready'}
        </StatusLabel>
        <span
          data-mono
          style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
        >
          {readiness.plannedFinalDate}
          {' · '}
          {readiness.daysToFinal < 0
            ? `${Math.abs(readiness.daysToFinal)}d overdue`
            : `${readiness.daysToFinal}d away`}
        </span>
      </span>

      {readiness.blockers.length > 0 ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {readiness.blockers.map((blocker) => (
            <span
              key={blocker}
              style={{
                font: "400 13px/1.5 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              {blocker}
            </span>
          ))}
        </span>
      ) : (
        <span
          style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
        >
          Nothing outstanding — the checks this order needs are on record.
        </span>
      )}
    </div>
  )
}
