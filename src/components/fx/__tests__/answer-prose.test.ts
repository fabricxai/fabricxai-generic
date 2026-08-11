import { describe, expect, it } from 'vitest'

import { parseAnswerProse, parseInlines } from '../answer-prose'

describe('parseAnswerProse', () => {
  it('splits paragraphs on blank lines instead of collapsing them', () => {
    const blocks = parseAnswerProse('First point.\n\nSecond point.')
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'First point.' }] },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Second point.' }] },
    ])
  })

  it('parses headings, lists, and emphasis the model commonly emits', () => {
    const blocks = parseAnswerProse(
      [
        '## Order 4410',
        '',
        'Here is what I read:',
        '',
        '- **Balance:** 12,400 pcs',
        '- Status: `confirmed`',
        '',
        '1. Check the LC latest shipment',
        '2. Confirm with commercial',
      ].join('\n'),
    )

    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 2,
      inlines: [{ kind: 'text', text: 'Order 4410' }],
    })
    expect(blocks[1]?.kind).toBe('paragraph')
    expect(blocks[2]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [
        [
          { kind: 'strong', text: 'Balance:' },
          { kind: 'text', text: ' 12,400 pcs' },
        ],
        [
          { kind: 'text', text: 'Status: ' },
          { kind: 'code', text: 'confirmed' },
        ],
      ],
    })
    expect(blocks[3]).toMatchObject({
      kind: 'list',
      ordered: true,
      items: [
        [{ kind: 'text', text: 'Check the LC latest shipment' }],
        [{ kind: 'text', text: 'Confirm with commercial' }],
      ],
    })
  })

  it('keeps fenced code as one block and does not interpret markers inside it', () => {
    const blocks = parseAnswerProse('Before\n\n```\n**not bold**\n```\n\nAfter')
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Before' }] },
      { kind: 'code', text: '**not bold**' },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'After' }] },
    ])
  })

  it('leaves unmatched markers alone', () => {
    expect(parseInlines('Price is *not closed')).toEqual([
      { kind: 'text', text: 'Price is *not closed' },
    ])
  })
})
