/**
 * X.1 registration (plan 3.1).
 *
 * The bug this closes has no error message. An unregistered module produces no primer, so
 * MARBIM answered every question about the queue its own drafts land in from the standing
 * rules alone — fluently, and without the craft. Nothing logs that, nothing throws, and the
 * answers look exactly like the ones that had the primer behind them.
 *
 * So the assertions here are about wiring reaching the two places that consume it —
 * `collectPrimers` and `toolsInScope` — rather than about the registration call returning an
 * object. Registering into a Map that nobody reads is the failure being fixed.
 */
// The registry pulls in every module's register.ts, and those import the db client, which
// validates the environment at import. No database is touched by these assertions.
import 'dotenv/config'

import { describe, expect, it } from 'vitest'

import '@/modules/registry'
import { getModule } from '@/modules/core/registry'
import { collectPrimers, toolsInScope } from '@/modules/marbim/service'
import type { DraftTool, ToolPack } from '@/modules/marbim/tools'

import { approvalsToolPack, redactChain } from '../tools'
import type { AuditChain } from '../service'

describe('the approvals module is registered', () => {
  it('resolves through the registry the rest of the system reads', () => {
    // `matchRule` in this module's own service.ts does exactly this lookup to find the
    // fallback approver roles, and it returned undefined for 'approvals' until now.
    const definition = getModule('approvals')

    expect(definition).toBeDefined()
    expect(definition?.approvalDefaults.requiredRoles).toEqual(['owner'])
  })

  it('reaches MARBIM as a primer', () => {
    // The actual fix. `collectPrimers` THROWS on an unknown module rather than skipping it,
    // so this would have failed loudly the moment anything asked for the approvals primer —
    // and nothing ever did, which is why it went unnoticed.
    const primers = collectPrimers(['approvals'])

    expect(primers).toHaveLength(1)
    expect(primers[0]?.version).toBe('X.1.0')
    expect(primers[0]?.text.length).toBeGreaterThan(1000)
  })

  it('validates as a tool pack at chat time, not just at boot', () => {
    // `assertToolPacks` covers boot; this is the other door, the one a live question goes
    // through. Both resolve the pack against what the module registered.
    expect(() => toolsInScope([approvalsToolPack])).not.toThrow()
    expect(toolsInScope([approvalsToolPack])).toHaveLength(approvalsToolPack.tools.length)
  })
})

describe('nothing here can write', () => {
  it('registers no pending target', () => {
    // The boundary itself is not a desk. A drafted change to who may approve what is a
    // drafted change to the control, which is the one thing the queue exists to prevent.
    expect(getModule('approvals')?.pendingTargets).toEqual([])
    expect(getModule('approvals')?.zodMap).toEqual({})
  })

  it('offers no draft tool', () => {
    const drafts = approvalsToolPack.tools.filter((tool) => tool.kind === 'draft')

    expect(
      drafts.map((tool) => (tool as DraftTool).name),
      'approving is the human act this layer exists to preserve',
    ).toEqual([])
  })

  it('would be refused by validateToolPack if one were ever added', () => {
    // The compile-time story is that a draft tool needs a `targetTable`; the runtime story
    // is this. With `pendingTargets: []` there is no table a draft tool could name that
    // would pass, so the refusal does not depend on anybody remembering the rule.
    const smuggled: ToolPack = {
      moduleId: 'approvals',
      tools: [
        {
          kind: 'draft',
          name: 'approvals.sign_it_myself',
          description: 'A draft tool aimed at the approval rules — exactly what must not exist.',
          input: approvalsToolPack.tools[0]!.input,
          targetTable: 'approval_rules',
          execute: async () => {
            throw new Error('unreachable')
          },
        } satisfies DraftTool,
      ],
    }

    expect(() => toolsInScope([smuggled])).toThrow(/approval_rules/)
  })
})

describe('provenance carries names, never values', () => {
  /** A draft that has been corrected and committed — the shape a dispute is asked about. */
  const chain: AuditChain = {
    draft: {
      id: '11111111-1111-4111-8111-111111111111',
      companyId: '22222222-2222-4222-8222-222222222222',
      moduleId: 'workforce',
      targetTable: 'wage_gazettes',
      targetId: null,
      operation: 'insert',
      payload: { grade: 'G3', basic_wage: '9450.00' },
      zodSchemaKey: 'wage_gazette_v1',
      fieldConfidence: { grade: 0.99, basic_wage: 0.61 },
      confidenceMin: '0.610',
      source: 'ai_extraction',
      sourceDocumentId: null,
      extractorVersion: 'gazette-v3',
      model: 'gemini-2.5-pro',
      status: 'committed',
      createdBy: 'user-hr',
      createdAt: new Date('2026-08-01T04:00:00Z'),
      updatedAt: new Date('2026-08-01T06:00:00Z'),
      reviewedBy: 'user-owner',
      reviewedAt: new Date('2026-08-01T06:00:00Z'),
      reviewNote: null,
      corrections: { basic_wage: '9700.00' },
      // The raiser confirmed this reading unchanged and submitted it — no edits of their
      // own, which is a different fact from the reviewer's correction below it.
      draftCorrections: {},
      submittedAt: new Date('2026-08-01T05:00:00Z'),
      committedAt: new Date('2026-08-01T06:00:00Z'),
      committedRowId: '33333333-3333-4333-8333-333333333333',
      error: null,
    },
    approvals: [
      {
        approverUserId: 'user-owner',
        approverName: 'Rehana Karim',
        approvedAsRole: 'owner',
        corrections: { basic_wage: '9700.00' },
        at: new Date('2026-08-01T06:00:00Z'),
      },
    ],
    committedAudit: [
      {
        id: 1n,
        companyId: '22222222-2222-4222-8222-222222222222',
        actorUserId: 'user-owner',
        actorRole: 'owner',
        action: 'insert',
        targetTable: 'wage_gazettes',
        targetId: '33333333-3333-4333-8333-333333333333',
        before: null,
        after: { grade: 'G3', basic_wage: '9700.00' },
        changedFields: ['grade', 'basic_wage'],
        pendingChangeId: '11111111-1111-4111-8111-111111111111',
        requestId: null,
        ipAddress: null,
        userAgent: null,
        occurredAt: new Date('2026-08-01T06:00:00Z'),
      },
    ],
  }

  const redacted = redactChain(chain)

  it('keeps what a dispute actually needs', () => {
    expect(redacted.draft.moduleId).toBe('workforce')
    expect(redacted.draft.model).toBe('gemini-2.5-pro')
    expect(redacted.draft.weakestConfidence).toBe('0.610')
    expect(redacted.approvals[0]?.approver).toBe('Rehana Karim')
    expect(redacted.approvals[0]?.role).toBe('owner')
    expect(redacted.committed[0]?.changedFields).toEqual(['grade', 'basic_wage'])
  })

  it('names the corrected fields without the figures', () => {
    expect(redacted.draft.correctedFields).toEqual(['basic_wage'])
    expect(redacted.approvals[0]?.correctedFields).toEqual(['basic_wage'])
  })

  it('lets no wage rate through, anywhere in the object', () => {
    /*
     * Serialised and searched rather than checked key by key, because the leak this guards
     * against is a key somebody ADDS later — `payload`, `before`, `after` — and a per-key
     * assertion passes happily for a field it was never told about.
     *
     * 9700 is the rate somebody was actually paid; it is on the draft's corrections, the
     * approval's corrections and the audit row's `after`. Three separate ways for one wage
     * to reach a chat transcript, which is a table with different access rules from the one
     * it was stored in.
     */
    const serialised = JSON.stringify(redacted)

    expect(serialised).not.toContain('9700')
    expect(serialised).not.toContain('9450')
    expect(serialised).not.toContain('payload')
    expect(serialised).not.toContain('before')
    expect(serialised).not.toContain('after')
  })
})
