/**
 * Payloads for 10.2, including the one `pending_changes` payload.
 *
 * `findings_batch_v1` is what MARBIM drafts from an audit report. Findings are the right
 * thing for a model to transcribe — a fifty-page RSC report listing thirty of them is exactly
 * the tedious, error-prone work a person does badly at 6pm — and every finding carries its
 * source page so a reviewer can check the severity against the paragraph it came from.
 *
 * CAPs are deliberately NOT drafted. A corrective action names an owner and a deadline; that
 * is an assignment of responsibility, and no model gets to make one.
 */
import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

export const severity = z.enum(['critical', 'major', 'minor', 'observation'])
export const regime = z.enum(['rsc', 'bsci', 'sedex', 'buyer', 'government'])

export const auditInput = z.object({
  regime,
  auditor: z.string().min(1),
  auditedOn: isoDate,
  reportDocumentId: z.uuid().optional(),
  /** Never defaulted. A regime that does not score has no score, which is not zero. */
  score: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).optional(),
})

/** What MARBIM extracts from an audit report: the findings, never the corrective actions. */
export const findingsBatchDraft = z.object({
  /**
   * OPTIONAL for the same reason `lcFromSwiftDraft.buyerId` is: no audit report carries this
   * system's id for the audit it belongs to, and a structured-output schema that demands one
   * gets an invention rather than an absence — which fails the whole reading.
   *
   * The queued path supplies it from the intake picker. The inline path is used from the
   * dialog that CREATES the audit, so it does not have one yet and the findings attach to
   * the audit that dialog is about to write.
   */
  auditId: z.uuid().optional().catch(undefined),
  findings: z
    .array(
      z.object({
        severity,
        text: z.string().min(1),
        evidence: z
          .array(
            z.object({
              documentId: z.uuid().optional(),
              page: z.number().int().positive().optional(),
              note: z.string().optional(),
            }),
          )
          .default([]),
        /** The page it was read from — the click-to-source target for a reviewer. */
        sourcePage: z.number().int().positive().optional(),
      }),
    )
    .min(1),
})

export const capInput = z.object({
  findingId: z.uuid(),
  ownerUserId: z.string().min(1),
  /** Optional: computed from the regime policy and the audit date when absent. */
  deadline: isoDate.optional(),
  milestones: z
    .array(z.object({ name: z.string().min(1), dueOn: isoDate, doneOn: isoDate.optional() }))
    .optional(),
})

export const capProgressInput = z.object({
  capId: z.uuid(),
  status: z.enum(['in_progress', 'evidence_submitted']),
  note: z.string().optional(),
})

export const capEvidenceInput = z.object({
  capId: z.uuid(),
  documentId: z.uuid().optional(),
  note: z.string().optional(),
})

export const capCloseInput = z.object({
  capId: z.uuid(),
  note: z.string().optional(),
})

export const certificateInput = z.object({
  kind: z.string().min(1),
  number: z.string().min(1),
  issuedOn: isoDate.optional(),
  /**
   * Explicitly nullable, and there is no "unknown". A certificate whose expiry nobody knows
   * must not be recorded as perpetual — that is how one silently never appears on the ladder.
   */
  expiresOn: isoDate.nullable(),
  documentId: z.uuid().optional(),
})

export const trainingInput = z.object({
  kind: z.string().min(1),
  heldOn: isoDate,
  attendeesCount: z.number().int().positive(),
  documentId: z.uuid().optional(),
})

export const COMPLIANCE_ZOD_MAP = {
  findings_batch_v1: findingsBatchDraft,
} as const

export type AuditInput = z.infer<typeof auditInput>
export type CapInput = z.infer<typeof capInput>
export type CertificateInput = z.infer<typeof certificateInput>
