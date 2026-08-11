/**
 * What the extract model is told about dates.
 *
 * The schema has always demanded `YYYY-MM-DD` and the instruction never mentioned it, so
 * every document that writes dates the way documents actually write them came back rejected
 * AFTER the model call was paid for: a SWIFT MT700 states `261118`, a challan `18/11/2026`,
 * an audit report "06 Oct 2026". The live test hit it on an LC (`issueDate expected
 * YYYY-MM-DD; issueDate not a real calendar date`).
 *
 * Asserting on prompt text is usually brittle and worth avoiding. It is worth it here
 * because the failure mode is silent to every other check: the code compiles, the schema is
 * right, the model is right, and the two only disagree at runtime against a real document.
 */
import { describe, expect, it } from 'vitest'

import { extractionInstruction } from '@/modules/marbim/service'

describe('the extraction instruction', () => {
  const instruction = extractionInstruction('commercial', 'uds')

  it('still says what is being extracted', () => {
    expect(instruction).toContain('uds')
    expect(instruction).toContain('commercial')
  })

  it('names the date format the schema will enforce', () => {
    expect(instruction).toContain('YYYY-MM-DD')
  })

  it('gives the forms real documents use, including the SWIFT six-digit one', () => {
    // 261118 is the form that broke it. Without an example the model has no reason to read
    // six digits as a date at all.
    expect(instruction).toContain('261118')
    expect(instruction).toContain('2026-11-18')
    expect(instruction).toContain('18/11/2026')
  })

  it('tells it to leave an ambiguous date empty rather than pick one', () => {
    // 05/12 is two dates, and the code receiving the answer cannot tell which. A missing
    // date is visible to whoever approves the draft; a wrong one is not.
    expect(instruction).toContain('05/12/2026')
    expect(instruction).toMatch(/leave that field empty/)
  })
})
