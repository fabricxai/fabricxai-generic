/**
 * Product-facing model names. Pure — safe for client and server.
 *
 * People see "marbim fast" / "marbim large". Vendor ids (`claude-sonnet-5`, …) stay on
 * jobs, drafts, and provider wiring. This never picks a model; it only renames a caption.
 */

export type MarbimTier = 'fast' | 'large'

export const MARBIM_TIERS: readonly { id: MarbimTier; label: string }[] = [
  { id: 'fast', label: 'marbim fast' },
  { id: 'large', label: 'marbim large' },
] as const

export function labelForTier(tier: MarbimTier): string {
  return tier === 'large' ? 'marbim large' : 'marbim fast'
}

/** Map a vendor (or mock) model id to what the UI should print. */
export function surfaceLabelFor(id: string | null | undefined): string | null {
  if (!id) return null
  if (id.startsWith('mock/')) return id
  // Opus-class reasoners are the "large" tier; everything else on the answer path is "fast".
  if (/opus/i.test(id)) return 'marbim large'
  return 'marbim fast'
}

/** Inverse of the product label — which tier the panel should start on. */
export function tierFromSurfaceLabel(label: string | null | undefined): MarbimTier {
  return label === 'marbim large' ? 'large' : 'fast'
}
