import { describe, expect, it } from 'vitest'

import { surfaceLabelFor, tierFromSurfaceLabel } from '../surface-label'

/**
 * Guards the product-facing caption used by history receipts and the panel header.
 * Vendor ids must never leak into what a person reads.
 */
describe('surfaceLabelFor', () => {
  it('maps reason models to marbim fast / marbim large', () => {
    expect(surfaceLabelFor('claude-sonnet-5')).toBe('marbim fast')
    expect(surfaceLabelFor('claude-opus-4')).toBe('marbim large')
  })

  it('leaves the mock honest', () => {
    expect(surfaceLabelFor('mock/deterministic-v1')).toBe('mock/deterministic-v1')
  })

  it('round-trips the composer tier from the product label', () => {
    expect(tierFromSurfaceLabel('marbim large')).toBe('large')
    expect(tierFromSurfaceLabel('marbim fast')).toBe('fast')
    expect(tierFromSurfaceLabel(null)).toBe('fast')
  })
})
