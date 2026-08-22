/**
 * i18n. Errors and notifications carry KEYS, never display strings — the floor reads
 * Bangla and the office reads English against the same rows.
 *
 * This file is the resolver and the catalogue for everything the SCHEDULED JOBS emit. Those
 * messages are the first ones that leave the system: they go out as email, to somebody who
 * is not looking at a screen and cannot ask what a key meant.
 *
 * ## What it does when something is missing
 *
 * Three fallbacks, each chosen because the alternative is a message that looks fine and
 * says nothing:
 *
 *  - a key missing in Bangla falls back to English. A supervisor reading English is
 *    inconvenienced; one reading an empty alert is not informed at all.
 *  - a key missing everywhere renders as the KEY. An empty subject line reads as a broken
 *    mail server; `maintenance.notifications.pm_due.title` reads as a missing translation,
 *    which is what it is, and it is greppable.
 *  - a placeholder with no value stays as `{daysLeft}`. Rendering "expires in undefined
 *    days" turns a caller's bug into something the reader has to interpret.
 *
 * Adding a notification means adding its key here in BOTH locales. The vectors enforce
 * that, and `missingKeys` is what the delivery job uses to report a gap rather than quietly
 * mailing a key.
 */
export const LOCALES = ['en', 'bn'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

/**
 * The cookie a language picker writes and `lib/ui-locale.ts` reads.
 *
 * It lives HERE, in the module with no dependencies, rather than beside the server-side
 * resolver that owns the reading of it — because `global-error.tsx` needs the name too, and
 * that is a client component: importing it from the resolver pulled `next/headers` into the
 * browser bundle and failed the build.
 */
export const LOCALE_COOKIE = 'fx_locale'

export type Catalogue = Record<Locale, Record<string, string>>

/**
 * The Bangla here is written for the people who actually read it — a floor supervisor, a
 * storekeeper, a mechanic. It is deliberately plainer than the English, which is written
 * for the office, and it keeps the terms a Bangladeshi garment factory uses in English
 * anyway (LC, UD, PM, ex-factory).
 */
export const MESSAGES: Catalogue = {
  en: {
    // ── core ──
    'notifications.system.welcome.title': 'Welcome to FabricXAI',
    'notifications.system.test.title': 'Test notification',
    'notifications.approve.waiting.title': '{count} change(s) waiting for your approval',
    'notifications.lc.expiry_near.title': 'LC {lcNumber} expires on {date}',
    'core.notifications.jobs_silent.title':
      'Scheduled jobs have stopped: {staleCount} silent, {stuckCount} stuck',

    // ── 1.3 Order Desk & TNA ──
    // Milestone names are stable identifiers on the row (`pp_approval`), never
    // display strings — the TNA engine, the notification job and the board all
    // key off the same value, and only the screen turns it into words.
    'orders.milestones.order_confirmed': 'PO received',
    'orders.milestones.yarn_booking': 'Yarn booked',
    'orders.milestones.yarn_in_house': 'Yarn in-house',
    'orders.milestones.knitting': 'Knitting complete · greige',
    'orders.milestones.fabric_booking': 'Fabric booked',
    'orders.milestones.lab_dip_approval': 'Lab dip approved',
    'orders.milestones.fabric_in_house': 'Fabric in-house',
    'orders.milestones.trims_in_house': 'Trims in-house',
    'orders.milestones.hardware_in_house': 'Hardware in-house',
    'orders.milestones.pp_sample_submit': 'PP sample submitted',
    'orders.milestones.pp_approval': 'PP sample approved',
    'orders.milestones.cutting': 'Cutting start',
    'orders.milestones.sewing_start': 'Sewing start',
    'orders.milestones.sewing_end': 'Sewing complete',
    'orders.milestones.linking': 'Linking complete',
    'orders.milestones.finishing': 'Finishing and packing',
    'orders.milestones.final_inspection': 'Final inspection · buyer QA',
    'orders.milestones.ex_factory': 'Ex-factory',
    // EU-template milestones (live-test kit): converted from the kit's tna.json.
    'orders.milestones.knitting_complete': 'Knitting complete',
    'orders.milestones.dyeing_complete': 'Dyeing complete',
    'orders.milestones.wash_approval': 'Wash approved',
    'orders.milestones.shell_fabric_inspection': 'Shell fabric inspected',

    'orders.notifications.milestone_at_risk.title': '{milestone} is at risk',
    'orders.notifications.milestone_at_risk.body':
      '{milestone} was planned for {plannedDate} and is not done yet.',
    'orders.notifications.milestone_late.title': '{milestone} is LATE',
    'orders.notifications.milestone_late.body':
      '{milestone} was due on {plannedDate} and has still not been actualised.',

    // ── 2.1 LC register ──
    'commercial.notifications.lc_countdown_latest_shipment.title':
      'LC {lcNumber}: {daysLeft} day(s) to latest shipment ({date})',
    'commercial.notifications.lc_countdown_expiry.title':
      'LC {lcNumber}: {daysLeft} day(s) to expiry ({date})',
    'commercial.lc.conflict.expiry': 'The credit expires before this order can ship',
    'commercial.lc.conflict.latest_shipment':
      'The credit\'s latest shipment date is before the planned ex-factory date',
    'commercial.lc.conflict.presentation_window':
      'The credit leaves too few days to present documents after shipment',
    'commercial.lc.conflict.unknown_ex_factory':
      'The credit is linked to an order with no ex-factory date',

    // ── 2.2 Bonded warehouse ──
    'commercial.notifications.ud_expiring.title':
      'UD {udNumber} expires on {validUntil} ({daysLeft} day(s) left)',
    'commercial.notifications.ud_low_balance.title':
      'UD {udNumber}: {itemRef} is nearly exhausted',
    'commercial.notifications.ud_reconciliation_due.title':
      'UD reconciliation is due for {period}',

    // ── Gates (rule 8) — shown when a server-side gate refuses a write ──
    'gates.fabric_inspection.not_inspected':
      'Some of these rolls have not passed 4-point inspection yet. Inspection comes before cutting, not after.',
    'gates.fabric_inspection.failed':
      'Some of these rolls failed 4-point inspection. Cloth that far out of grade becomes a buyer claim after it is cut.',
    'gates.fabric_inspection.roll_not_found':
      'One of these rolls could not be checked for inspection, so the state of the rest is unknown.',
    'gates.fabric_inspection.no_provider':
      'Fabric inspection cannot be checked right now, so the issue is blocked',

    // ── 6.1 Line tracking ──
    'production.notifications.partition_default.title':
      'Production writes are landing in the default partition',
    'production.notifications.run_rate_at_risk.title':
      '{poNumber} will finish sewing {forecastDate}, {slipDays} day(s) after {milestoneDate} — at {ratePerDay}/day',

    // ── Cross-department news (the `notify` queue) ──
    'quality.notifications.fabric_rejected.title':
      'A roll failed 4-point inspection at {pointsPer100SqYd} points/100 yd² (limit {threshold}) — it cannot be issued',
    'quality.notifications.final_failed.title':
      'A lot of {lotQty} failed final inspection on a sample of {sampleSize} — it does not ship',
    'quality.notifications.measurement_failed.title':
      'Size {sampledSize} measured outside the buyer\u2019s tolerance',
    'shipment.notifications.exp_missing.title':
      'Documents were refused at the bank — this shipment has no EXP number',
    'shipment.notifications.tolerance_breach.title':
      'Shipped {direction} by {varianceQty} against a {tolerancePct}% LC tolerance',
    'costing.notifications.below_floor.title':
      '{styleCode} approved at {achievedMarginPct}% margin, below the {floorPct}% floor',
    'cutting.notifications.wastage_variance.title':
      'Cutting wastage at {wastagePct}% against a {threshold}% threshold',
    'commercial.notifications.ud_overdrawn.title':
      'UD {udNumber} is overdrawn on {itemRef} by {shortfall} — duty exposure',

    // ── 11.1 Commercial finance ──
    'finance.notifications.cash_shortfall.title':
      'Cash goes negative in the week of {week} — {inflow} in against {outflow} out ({currency})',

    // ── 7.1 Quality ──
    'quality.notifications.repeat_defect.title':
      '{code} at {operation} — {days} days running, through {through}',

    // ── 9.1 Machines & tickets ──
    'maintenance.notifications.pm_due.title':
      'Preventive maintenance due for {machineType} (due {dueOn}, {daysOverdue} day(s) overdue)',
    'maintenance.notifications.parts_low.title':
      '{name}: {onHand} on hand, minimum is {minLevel}',
    'maintenance.notifications.breakdown_outliers.title':
      'Machines breaking down far more than the rest ({month})',
    'maintenance.notifications.downtime_no_rate.title':
      'No downtime cost for {month}: no line-minute rate is configured',

    // ── 10.2 Compliance ──
    'compliance.notifications.certificate_expiring.title':
      '{kind} certificate expires on {expiresOn} ({daysRemaining} day(s) left)',
    'compliance.notifications.certificate_expired.title':
      '{kind} certificate EXPIRED on {expiresOn}',
    'compliance.notifications.cap_escalated.title':
      '{severity} corrective action is {status}, due {deadline}',


    // ── Refusals, every module ──────────────────────────────────────────────
    //
    // Every `messageKey` a service can throw has a sentence here. Without one the screen
    // renders the key itself — `conflict: shipment.errors.doc_needs_file` — which is not a
    // crash and is not wrong, but it is a dotted identifier where an explanation should be,
    // and it teaches people that the system talks to itself in front of them.
    //
    // These say what happened and what to do about it. They do NOT interpolate the values
    // in `AppError.details`: only `Error.message` survives a server-action boundary, so a
    // template with a live `{placeholder}` in it would reach the reader unfilled. Naming
    // the value needs actions to return a typed failure rather than throw — a larger change
    // than this catalogue. `commit-handlers.test.ts`' sibling, `i18n.test.ts`, fails if a
    // service gains a key with no copy here.
    'errors.confidence_not_measured':
      'This draft was composed in conversation, so nothing measured how sure it is. A confidence score on it would be invented, and it was refused rather than shown as though it meant something.',
    'errors.confidence_required':
      'An extraction has to carry a confidence for every field it filled — a draft without one cannot be reviewed for how hard to look at it.',
    'errors.invalid_tenant_scope':
      'That request is not scoped to a company, so it was refused rather than run against everything.',
    'orders.errors.breakdown_outside_tolerance':
      'This breakdown is outside the quantity tolerance the buyer accepts. Shipping short against an agreed band is a claim, not a rounding difference.',
    'orders.errors.buyer_not_found': 'That buyer no longer exists.',
    'orders.errors.duplicate_breakdown_cell':
      'The same colour and size appears twice in this breakdown. The floor would cut to whichever row it read first.',
    'orders.errors.milestone_already_actualized':
      'That milestone already has an actual date. Recording a second one would move a date the rest of the schedule was rippled from.',
    'orders.errors.milestone_not_found': 'That milestone is not on this order’s TNA.',
    'orders.errors.no_styles':
      'An order needs at least one style — one with none is an order nobody can cost, cut or ship.',
    'orders.errors.order_not_found': 'That order no longer exists.',
    'orders.errors.po_draft_insert_only':
      'An order drafted from a PO is created, not edited. Amending a confirmed order is a revision with its own trail.',
    'orders.errors.style_not_found': 'That style is not on this order.',
    'orders.errors.template_invalid': 'That TNA template cannot be read as it stands.',
    'orders.errors.template_not_found': 'That TNA template no longer exists.',
    'orders.errors.tna_template_unschedulable':
      'This template cannot be scheduled — its dependencies do not resolve into an order of work.',

    'approvals.errors.auto_approve_needs_floor':
      'An auto-approve rule needs a confidence floor — without one it would commit anything the extractor produced.',
    'approvals.errors.draft_not_found': 'That draft no longer exists.',
    'approvals.errors.no_required_roles':
      'This rule names no approving role, so nobody could ever action it.',
    'approvals.errors.rules_are_owner_only': 'Only an owner changes who approves what.',
    'buyers.errors.buyer_not_found': 'That buyer no longer exists.',
    'buyers.errors.invalid': 'That does not fit what a buyer record accepts.',
    'buyers.errors.lead_is_lost':
      'This lead was marked lost. Reopening it is a new lead, not an edit to this one.',
    'buyers.errors.lead_not_found': 'That lead no longer exists.',
    'buyers.errors.lost_needs_reason':
      'A lost lead needs a stated reason — it is the only thing the next quote can learn from.',
    'buyers.errors.terms_backdated':
      'These terms start before the newest version already on file. Backdating would change which terms governed orders taken in between.',
    'buyers.errors.terms_draft_insert_only':
      'Terms are versioned, never edited: the AQL gate and the shipping tolerance read them by date.',
    'commercial.errors.bank_docs_invalid': 'That does not fit what a bank submission accepts.',
    'commercial.errors.btb_currency_mismatch':
      'A back-to-back credit must be in the same currency as its master — the headroom cannot be compared otherwise.',
    'commercial.errors.charge_needs_parent':
      'A bank charge has to belong to an LC or a submission.',
    'commercial.errors.discrepancy_needs_notes':
      'A discrepancy needs its notes — they are what the bank is being answered with.',
    'commercial.errors.invalid_period': 'That period is not a valid one.',
    'commercial.errors.lc_not_amendable': 'This LC is not in a state that accepts an amendment.',
    'commercial.errors.shipment_not_found':
      'That shipment no longer exists, so a presentation cannot be opened against it.',
    'commercial.errors.lc_not_found': 'That letter of credit no longer exists.',
    'commercial.errors.order_not_found':
      'That order no longer exists, so the credit cannot cover it.',
    'commercial.errors.lc_order_buyer_mismatch':
      'This credit was issued by a different buyer than that order — a credit cannot pay for goods it was never opened against.',
    'maintenance.notifications.ticket_claimed.title':
      'A mechanic has taken your ticket and is on the way.',
    'maintenance.notifications.ticket_resolved.title':
      'Your machine ticket is resolved — the line can run.',
    'approvals.notifications.draft_aging.title':
      'A draft has waited past {hours} hours in your approve queue.',
    'shipment.notifications.packable.title':
      '{poNumber} has {pieces} pieces off finishing — cartons can be planned.',
    'maintenance.notifications.ticket_opened.title':
      'A line is down — an unclaimed machine ticket is waiting.',
    'sampling.notifications.pp_approved.title':
      'PP approved on {styleCode} — cutting can start.',
    'sampling.notifications.pp_rejected.title':
      'PP rejected on {styleCode} — cutting stays closed.',
    'quality.notifications.lot_inspectable.title':
      '{poNumber} has {pieces} pieces off finishing — a sample can be drawn.',
    'store.notifications.grn_failed.title':
      'Inspection failed on challan {challanNo} — those rolls are locked.',
    'store.notifications.grn_passed.title': 'Challan {challanNo} passed inspection.',
    'store.notifications.requisition_raised.title':
      'Material requested — {lines} line(s) waiting on the store.',
    'production.notifications.dayclose_skipped.title':
      'Some lines got no efficiency figure for {forDate}.',
    'production.notifications.dayclose_skipped.body':
      '{lines} produced that day but had no plan behind them — no SMV and no manpower means there is nothing to measure against, so they are missing from the day\u2019s figures. Plan the line before the shift and the number appears on its own.',
    'production.notifications.runrate_slip.title': 'Line {line} is falling behind the day plan.',
    'production.notifications.runrate_slip.body':
      '{made} made against {expected} planned so far — {behind} pieces behind, more than an hour of work.',
    'commercial.errors.lc_number_exists':
      'A letter of credit with that number is already recorded.',
    /* The schema has forbidden this since 0008, but only as a CHECK — so the refusal
       reached the person as an unreadable React #441 (live test, Phase 3). No placeholders:
       `AppError.details` do not survive a server action, and both dates are on screen in
       the form the reader is looking at anyway. */
    'commercial.errors.lc_expiry_before_shipment':
      'This credit would expire before its own latest shipment date — the documents would be due at the bank before the goods are allowed to leave. Check the expiry and the latest shipment date; one of them is a day and month the wrong way round.',
    'commercial.errors.no_btb_limit':
      'No back-to-back limit is set on the master LC, so there is no headroom to draw against.',
    'commercial.errors.no_invoiced_amount':
      'Nothing has been invoiced against this, so there is nothing to realize.',
    'commercial.errors.reconciliation_exists':
      'This UD has already been reconciled for that period.',
    'commercial.errors.shortfall_needs_reason':
      'A realization short of the invoice needs a stated reason.',
    'commercial.errors.submission_not_found': 'That bank submission no longer exists.',
    'commercial.errors.submitted_needs_date': 'A submitted set needs the date it went to the bank.',
    'commercial.errors.ud_draft_insert_only':
      'A UD is recorded once. Amending one is a fresh declaration, not an edit.',
    'commercial.errors.ud_items_invalid':
      'This UD’s authorised items cannot be read against the current schema, so no balance can be computed from it.',
    'commercial.errors.ud_not_found': 'That utilization declaration no longer exists.',
    'commercial.errors.ud_not_short': 'This UD is not short, so there is nothing to reconcile.',
    'commercial.errors.ud_number_exists':
      'A UD with that number is already recorded. Two rows for one declaration double-count the bonded balance.',
    'compliance.errors.audit_not_found': 'That audit no longer exists.',
    'compliance.errors.cap_closed': 'That corrective action is already closed.',
    'compliance.errors.cap_not_found': 'That corrective action no longer exists.',
    'compliance.errors.empty_evidence':
      'Evidence needs a file or a description — an empty entry closes a finding on nothing.',
    'compliance.errors.finding_not_found': 'That finding no longer exists.',
    'compliance.errors.invalid': 'That does not fit what this compliance record accepts.',
    'compliance.errors.not_a_closer': 'Your role does not close corrective actions.',
    'compliance.errors.self_certification':
      'The person who raised or actioned this cannot also verify it closed.',
    'costing.errors.below_floor_needs_owner':
      'This sheet is below the margin floor. Only an owner approves quoting under it.',
    'costing.errors.bom_not_found': 'That bill of materials no longer exists.',
    'costing.errors.no_approved_sheet': 'No approved cost sheet exists for this style.',
    'costing.errors.no_bom_for_style':
      'This style has an approved cost sheet with no bill of materials behind it, so nothing can size a requisition from it.',
    'costing.errors.sheet_not_found': 'That cost sheet no longer exists.',
    'costing.errors.sheet_stale':
      'This sheet has changed since it was opened. Reload it before approving — you would be signing a different set of numbers.',
    /* No placeholders: AppError.details do not survive a server action, and the offending
       lines are on screen in front of the reviewer anyway. */
    'costing.errors.bom_line_no_consumption':
      'Some lines have no consumption, and a material line has to consume something. A tech pack often leaves sew thread blank because it is derived from stitch length rather than printed — edit those lines and enter the quantity before approving.',
    'costing.errors.sheet_uncomputable':
      'This sheet cannot be computed as it stands. Something it needs is missing rather than wrong.',
    'costing.errors.template_not_found': 'That consumption template no longer exists.',
    'cutting.errors.bundle_not_found': 'That bundle no longer exists.',
    'cutting.errors.bundles_already_generated': 'Bundles have already been generated for this lay.',
    'cutting.errors.lay_not_found': 'That lay no longer exists.',
    'cutting.errors.marker_code_exists': 'A marker with that code is already registered.',
    'cutting.errors.marker_draft_insert_only':
      'A changed marker is a new marker: lays already spread against this one were cut to its ratio.',
    'cutting.errors.marker_not_found': 'That marker no longer exists.',
    'cutting.errors.no_breakdown':
      'This style has no colour and size breakdown, so a cut cannot be checked against what the buyer ordered.',
    'cutting.errors.no_cut_lays': 'Nothing has been cut against this order yet.',
    'cutting.errors.report_not_found': 'That cut report no longer exists.',
    'cutting.errors.style_not_found': 'That style is not on this order.',
    'cutting.errors.uncomputable': 'There is not enough recorded yet to compute that.',
    'errors.commit_failed': 'The change could not be committed. Nothing was written.',
    'errors.confidence_out_of_range': 'A confidence must be between 0 and 1.',
    /* No placeholders: AppError.details do not survive a server action, and the reference
       the person typed is in the question they just asked. */
    'approvals.errors.rule_not_found': 'That routing rule no longer exists, or was already retired.',
    'errors.self_approval':
      'You raised this draft, and this table needs a second pair of hands — a record a bank or an auditor will ask about cannot be signed into existence by its own author. Ask another approver to decide it.',
    'errors.reference_empty': 'That lookup needs something to look up — a code or an id.',
    'errors.reference_kind_unknown':
      'Nothing in this system knows how to look that kind of thing up. This is a wiring fault rather than anything you typed.',
    'errors.drawer_kind_unknown':
      'Nothing here knows how to show a quick view of that kind of thing. This is a wiring fault rather than anything you clicked.',
    'errors.reference_not_found':
      'No record here matches that reference. Check the code against the screen it came from — it is looked up exactly, never guessed at, because the nearest match is how a shipment ends up against the wrong buyer.',
    'errors.document_not_found': 'That document no longer exists.',
    'errors.document_not_uploaded':
      'The file never finished uploading, so there is nothing to attach.',
    'errors.document_quarantined': 'That file was quarantined and cannot be used.',
    'errors.document_size_invalid':
      'The file size does not match what was reserved for it — upload it again.',
    'errors.document_too_large': 'That file is larger than the limit.',
    'errors.document_type_not_allowed':
      'That kind of file is not accepted. PDFs, images, spreadsheets and Word documents are.',
    'errors.empty_update': 'Nothing was changed, so nothing was saved.',
    'errors.forbidden': 'Your role does not allow this.',
    'errors.illegal_transition': 'That status cannot follow the current one.',
    'errors.module_inactive':
      'This module is switched off for this factory. An owner can enable it in Settings.',
    'errors.module_not_disableable':
      'This module is part of the platform’s core and cannot be switched off.',
    'errors.module_required_by':
      'Other active modules depend on this one. Switch those off first.',
    'errors.module_requires':
      'This module depends on modules that are switched off. Enable those first.',
    'errors.owner_only': 'Only an owner can change which modules this factory runs.',
    'errors.invalid_identifier':
      'This draft carries a field the target table has no column for, so it cannot be written. Its module needs to own the commit.',
    'errors.not_an_approver': 'You are not one of the approvers this change requires.',
    'errors.payload_invalid':
      'Some of what was entered does not fit what this record accepts. Nothing was saved.',
    'errors.pending_change_not_found': 'That draft no longer exists.',
    'errors.not_the_raiser':
      'That reading belongs to whoever uploaded the document. Only they can check it against the paper and send it on.',
    'errors.pending_change_not_drafted':
      'That reading has already been sent for approval, or thrown away.',
    'errors.pending_change_not_pending': 'That draft has already been decided.',
    'errors.rate_limited':
      'Too many attempts in a short time. Wait a moment and try again — nothing was saved.',
    'errors.sync_batch_too_large': 'That offline batch is too large to sync in one go.',
    'errors.sync_failed': 'The offline batch did not sync. Nothing in it was applied.',
    'errors.sync_operation_unknown':
      'The server does not recognise this kind of entry. The device app is probably newer than the server — tell whoever runs the system.',
    'errors.sync_role_forbidden':
      'This entry needs a role this account does not hold. It stays queued on the device — ask a supervisor to grant the role, then sync again.',
    'errors.target_id_mismatch': 'This draft points at a different row than the one being changed.',
    'errors.target_not_registered': 'That module does not allow drafts against this table.',
    'errors.target_row_not_found': 'The row this draft was meant to change no longer exists.',
    'errors.unauthenticated': 'You are signed out. Sign in again — nothing was saved.',
    'errors.unknown_module': 'That module is not registered.',
    'errors.unknown_schema': 'That draft names a shape this module does not define.',
    'finance.errors.no_accrual': 'Nothing has accrued against this yet.',
    'finance.errors.no_margin_basis':
      'No approved cost sheet stands behind this order, so there is no margin to measure against.',
    'finance.errors.order_not_found': 'That order no longer exists.',
    'finance.errors.payable_already_settled':
      'This payable has already been settled. Paying it twice is a second payment, not a correction.',
    'finance.errors.payable_not_found': 'That payable no longer exists.',
    'finance.errors.pieces_required': 'A per-piece figure needs the piece count it is per.',
    'finance.errors.receivable_already_settled': 'This receivable has already been settled.',
    'finance.errors.receivable_not_found': 'That receivable no longer exists.',
    'finance.errors.uncomputable': 'There is not enough recorded yet to compute that.',
    'gates.btb_headroom.no_btb':
      'No back-to-back credit is linked, and an import PO cannot be issued without one — the factory would be committed to a supplier with nothing funding it.',
    // ── Gates the floor and the desk actually hit ──
    //
    // Twenty-one gate reasons were thrown with no copy behind them, so a UD overdraw
    // reached the storekeeper as the literal string `gate_blocked:
    // gates.ud_balance.insufficient` (audit BE-H3). These are the refusals people meet.
    'store.errors.nothing_to_return': 'No rolls were chosen to return.',
    'store.errors.return_needs_reason':
      'A return needs a reason. It moves material back into the store and gives back what the declaration had drawn, and the reason is what the record is for.',
    'gates.ud_balance.insufficient':
      'This issue would draw more than the UD allows. An owner can approve a deliberate overdraw through the approve inbox.',
    /*
     * The five refusals `decideUdDraw` actually returns, which had NO copy at all — the
     * sentence above was filed under a key nothing throws, so every bonded refusal fell
     * through to a caller's generic fallback. The services compose the real sentence with
     * the balance in it; these stand behind them.
     */
    'commercial.ud.insufficient_balance':
      'This issue would draw more than the UD allows. An owner can approve a deliberate overdraw through the approve inbox.',
    'commercial.ud.not_active':
      'That Utilization Declaration is not active, so nothing may be drawn against it.',
    'commercial.ud.expired':
      'That Utilization Declaration has expired. Bonded material cannot leave the warehouse against it — customs needs a fresh one.',
    'commercial.ud.item_not_authorized':
      'That material is not on this Utilization Declaration. A declaration covers named materials only.',
    'commercial.ud.unit_mismatch':
      'This asks in a different unit from the one the declaration authorises, and converting between them is a customs question.',
    /* The pulse strip (specs/order-centric-core.md §2) — what the order is blocked on,
       said over the workspace. Gate reasonKeys join these verbatim. */
    'pulse.milestones_late': '{count} milestone(s) late — worst: {worst}.',
    'pulse.milestones_at_risk': '{count} milestone(s) at risk of slipping.',
    'pulse.exp_missing':
      'Shipment {partialNo} has no EXP number — the bank will not take its documents.',
    'pulse.lc_deadline_breached':
      'Shipment {partialNo} is {days} day(s) past the LC’s latest-shipment date.',
    'pulse.lc_deadline_near':
      'Shipment {partialNo} is {days} day(s) from the LC’s latest-shipment date.',
    'gates.pp_approval.not_approved':
      'The buyer has not approved the PP sample for this style, so cutting cannot start.',
    'gates.pp_approval.no_sample':
      'No PP sample has been raised for this style. Cutting starts after the buyer approves one.',
    'gates.pp_approval.rejected':
      'The buyer rejected the PP sample. A new round has to be approved before this style is cut.',
    'gates.pp_approval.awaiting_feedback':
      'The PP sample is with the buyer and has no verdict yet.',
    'gates.pp_approval.wrong_sample_type':
      'That sample is not a PP sample. Only a pre-production approval opens cutting.',
    'gates.pp_approval.style_not_found': 'That style is not on this order.',
    'gates.pp_approval.style_mismatch':
      'The approved sample belongs to a different style than the one being cut.',
    'gates.pp_approval.no_provider':
      'PP approval cannot be checked right now, so cutting is held rather than opened.',
    'gates.pp_approval.demo_bypass':
      'The PP gate is bypassed for a demo. This never happens outside development.',
    'gates.issued_fabric.no_rolls':
      'No fabric has been issued for this order, so there is nothing to lay.',
    'gates.issued_fabric.not_issued_to_order':
      'Those rolls were issued against a different order.',
    'gates.issued_fabric.blocked': 'The issued-fabric check did not pass, so the lay is held.',
    'gates.final_inspection.none':
      'No final inspection has been recorded for this order. The shipment is held until one is.',
    'gates.final_inspection.failed':
      'The final inspection failed. Commercial or an owner can waive it on the record if the buyer accepts the lot.',
    'gates.final_inspection.blocked': 'Final inspection has not cleared this shipment.',
    // No {placeholders} in gate copy: only `reason` survives a server action's boundary
    // (lib/action-failure.ts), so a brace here reaches the screen as a literal brace. The
    // services compose the sentence with the figures in it; this is the fallback.
    'gates.btb_headroom.exceeded':
      'This purchase order would take the back-to-back credits past their ceiling under the master credit.',
    'gates.btb_headroom.btb_not_found': 'That back-to-back credit no longer exists.',
    'gates.btb_headroom.master_not_found':
      'The master credit behind this back-to-back is missing, so its headroom cannot be checked.',
    'gates.btb_headroom.master_not_active':
      'The master credit is not active, so nothing is funding this back-to-back.',
    'gates.btb_headroom.currency_mismatch':
      'The back-to-back and its master credit are in different currencies, and no rate has been stated to net them.',
    // The credit must FUND the order, not merely be attached to it. Headroom answers a
    // different question — whether the credits fit under their master — and passed happily
    // while a PO four times the size of its credit was written against it.
    'gates.btb_headroom.po_exceeds_btb':
      'This purchase order is larger than the back-to-back credit funding it, counting the orders already committed to that credit.',
    'gates.btb_headroom.po_currency_mismatch':
      'This purchase order and the back-to-back credit funding it are in different currencies, and no rate has been stated to net them.',
    'gates.exp_number.missing':
      'No EXP number on this shipment. Bangladesh Bank requires one before documents can be presented, so the handoff is blocked rather than delayed.',
    'gates.lc_date.after_latest_shipment':
      'This shipment leaves after the credit\'s latest shipment date, so the bank will refuse the presentation. Commercial can accept the breach on the record before the departure is confirmed.',
    'gates.lc_date.expired':
      'The credit expired before this shipment date, so there is nothing left to present against. Commercial can accept the breach on the record before the departure is confirmed.',
    'maintenance.errors.invalid': 'That does not fit what this maintenance record accepts.',
    'maintenance.errors.part_not_found': 'That spare part is not in the store.',
    'maintenance.errors.ticket_not_found': 'That ticket no longer exists.',
    'marbim.errors.context_required':
      'This kind of document needs something the paper does not carry — choose it before sending.',
    'marbim.errors.context_unknown':
      'That choice is not one of yours. Pick from the list rather than an id.',
    'marbim.errors.invalid': 'That does not fit what MARBIM accepts here.',
    'marbim.errors.nothing_to_read':
      'There is nothing to read — paste the text, or attach a PDF or photo the model can read on its own.',
    /* Covers both refusals: the type is not one that can be read at all, and the type is
       readable but these particular bytes produced nothing (a damaged archive). The remedy
       is the same sentence either way, so it is one key rather than two near-identical ones. */
    'marbim.errors.file_unreadable':
      'MARBIM could not read this file. It reads PDF, JPEG, PNG, WebP, Word, Excel and CSV — if this is one of those, the file may be damaged. For anything else, paste the text on the intake page instead.',
    'marbim.errors.kind_not_your_desk':
      'That kind of document belongs to another department, so it cannot be filed from here. Whoever owns that desk can read it in, or an owner can.',
    'marbim.errors.job_not_found': 'That extraction no longer exists.',
    'marbim.errors.job_rejected':
      'That extraction was rejected and will not be retried — what it read did not fit the target.',
    'marbim.errors.unavailable':
      'MARBIM is not available on this factory, so there is nothing to read your document. Nothing has been queued — what you typed is still here.',
    'marbim.errors.rate_limited':
      'Too many documents have been sent for reading in the last hour. Try again shortly.',
    'marbim.errors.token_ceiling':
      'This factory has used up its model budget for the day. MARBIM will answer again once the last 24 hours clear, or an owner can raise the daily limit in Settings.',
    'marbim.notifications.extraction_succeeded.title':
      'The document you sent to MARBIM has been read — check it against the paper before it goes for approval.',
    'marbim.notifications.extraction_succeeded.body':
      'Nobody else can see it yet. You have the document; the approver does not. The weakest field is the one to read twice.',
    'marbim.notifications.extraction_rejected.title':
      'MARBIM could not read the document you sent, and will not try again.',
    'marbim.notifications.extraction_rejected.body':
      'Nothing was drafted. Enter it by hand, or send a clearer copy.',
    'marbim.errors.target_not_registered':
      'That module does not allow drafts against this table, so nothing read from a document could ever land there.',
    'marbim.errors.unknown_intake_kind': 'That is not a kind of document MARBIM knows how to file.',
    'marbim.errors.unknown_module': 'That module is not registered.',
    'memory.errors.embedding_width':
      'That embedding is the wrong width to compare against the ones on file.',
    'memory.errors.empty_source_bom':
      'The order being copied from has a bill of materials with no lines.',
    'memory.errors.invalid': 'That does not fit what this record accepts.',
    'memory.errors.no_fingerprint':
      'This style has no fingerprint yet, so it cannot be matched against past ones.',
    'memory.errors.no_outcome':
      'This order has no recorded outcome, so there is nothing for a future quote to learn from it.',
    'memory.errors.no_source_bom': 'The order being copied from has no bill of materials.',
    'memory.errors.note_window_closed':
      'The window for a close-out note on this order has passed. What was written stands.',
    'memory.errors.order_not_found': 'That order no longer exists.',
    'memory.errors.outcome_not_found': 'No outcome has been recorded for that order.',
    'memory.errors.rfq_not_found': 'That RFQ no longer exists.',
    'memory.errors.source_style_not_found': 'That style is not on record.',
    'planning.errors.allocation_done':
      'That allocation is finished. Moving it now would restate capacity the floor has already used.',
    'planning.errors.allocation_not_found': 'That allocation no longer exists.',
    'marbim.errors.kind_is_inline_only':
      'That document is read straight into its own screen, not sent to the approve inbox. Open the screen it belongs to and drop it there.',
    'compliance.errors.findings_no_audit':
      'These findings are not attached to an audit. Log the audit first, then send the report again.',
    'commercial.errors.lc_draft_no_buyer':
      'This credit has no buyer against it. Send the document again and choose whose credit it is.',
    'planning.errors.calendar_no_working_days':
      'No working day falls inside those dates. Pick at least one day of the week the lines run.',
    'planning.errors.calendar_range_backwards': 'The calendar ends before it starts.',
    'planning.errors.downtime_exceeds_shift':
      'Planned downtime has to be less than the shift, or the line earns nothing.',
    'planning.errors.line_inactive': 'That line is not active.',
    'planning.errors.line_needs_floor':
      'A line belongs to a floor, and a floor to a factory unit. Name an existing floor or describe a new one.',
    'planning.errors.line_not_found': 'That line no longer exists.',
    'planning.errors.no_manpower':
      'That line has no manpower recorded for the day, so its capacity cannot be computed.',
    'planning.errors.no_shift_for_day': 'That line has no shift on the calendar for that day.',
    'planning.errors.no_smv':
      'This style has no SMV on record. Planning it would mean inventing one, and an invented SMV is how a factory commits to a date it cannot make.',
    'planning.errors.scenario_empty': 'That scenario changes nothing.',
    'planning.errors.scenario_no_longer_fits':
      'The board has moved since this scenario was forked, and it no longer fits. Fork a fresh one rather than applying this over the top.',
    'planning.errors.scenario_not_found': 'That scenario no longer exists.',
    'planning.errors.smv_draft_insert_only':
      'A restudy is a new SMV record, not an edit — the older figures are the variance history.',
    'planning.errors.uncomputable': 'There is not enough recorded yet to compute that.',
    'procurement.errors.no_btb_limit':
      'No back-to-back limit is set, so there is no headroom for this import order.',
    'procurement.errors.no_quotes':
      'No quotes have been recorded against this requisition, so there is nothing to compare.',
    'procurement.errors.po_line_not_found': 'That purchase order line no longer exists.',
    'procurement.errors.po_not_found': 'That purchase order no longer exists.',
    'procurement.errors.pr_draft_insert_only':
      'A requisition is raised, not edited through the approve inbox.',
    'procurement.errors.pr_line_not_found': 'That requisition line no longer exists.',
    'procurement.errors.pr_no_exists': 'A requisition with that number already exists.',
    'procurement.errors.pr_not_found': 'That purchase requisition no longer exists.',
    'procurement.errors.quote_draft_insert_only':
      'A revised quote is a new quote — rewriting one would change the comparison a PO was awarded on.',
    'procurement.errors.supplier_code_exists': 'A supplier with that code is already registered.',
    'procurement.errors.supplier_draft_insert_only':
      'A supplier record is added, not edited through the approve inbox.',
    'procurement.errors.supplier_inactive': 'That supplier is not active.',
    'procurement.errors.supplier_not_found': 'That supplier no longer exists.',
    'procurement.errors.uncomputable':
      'These quotes cannot be compared as they stand — usually a currency with no stated rate.',
    'production.errors.count_exceeds_checked':
      'More pieces were counted than were checked at the endline.',
    'production.errors.downtime_already_closed': 'That stoppage has already been closed.',
    'production.errors.downtime_already_open':
      'This line already has an open stoppage. Close it before opening another.',
    'production.errors.downtime_ends_before_start': 'A stoppage cannot end before it began.',
    'production.errors.downtime_not_found': 'That stoppage no longer exists.',
    'production.errors.line_out_of_scope':
      'That line is not one of yours. You can enter only the lines you supervise — ask the office to widen them.',
    'quality.errors.final_inspection_not_found': 'That final inspection no longer exists.',
    'quality.errors.line_not_found': 'That line no longer exists.',
    'quality.errors.no_aql_rows':
      'No AQL table covers a lot of that size, so no sample size can be drawn.',
    'quality.errors.no_inline_checks':
      'Nothing has been checked inline yet, so there is no DHU to report.',
    'quality.errors.spec_not_found': 'No measurement chart is on file for that style.',
    'quality.errors.third_party_already_resulted':
      'That inspection already has a result. A second one is a re-inspection, not an edit.',
    'quality.errors.third_party_not_found': 'That third-party inspection no longer exists.',
    'quality.errors.uncomputable': 'There is not enough recorded yet to compute that.',
    'quality.errors.unknown_defect_codes':
      'Some of those defect codes are not on the factory’s list.',
    'rfq.errors.below_floor_needs_manager':
      'This quote is below the margin floor. A manager has to approve quoting under it.',
    'rfq.errors.below_floor_needs_reason':
      'Quoting below the floor needs a stated reason — it is what a later reader has to judge it by.',
    'rfq.errors.buyer_not_found': 'That buyer no longer exists.',
    'rfq.errors.clarification_already_answered': 'That clarification has already been answered.',
    'rfq.errors.clarification_not_found': 'That clarification no longer exists.',
    'rfq.errors.invalid': 'That does not fit what an RFQ accepts.',
    'rfq.errors.no_live_quote': 'No quotation is live on this RFQ.',
    'rfq.errors.not_found': 'That RFQ no longer exists.',
    'rfq.errors.quote_not_draft':
      'That quotation has already been sent. Changing it now is a revision, not an edit.',
    'rfq.errors.quote_not_found': 'That quotation no longer exists.',
    'rfq.errors.sheet_does_not_reconcile':
      'This quote does not reconcile with the cost sheet behind it.',
    'rfq.errors.sheet_has_no_margin_basis':
      'The cost sheet behind this quote has no margin basis, so there is nothing to check the price against.',
    'rfq.errors.unknown_loss_reason': 'That is not one of the recorded reasons for losing an RFQ.',
    'sampling.errors.feedback_draft_insert_only':
      'A verdict records what the buyer said. Editing one rewrites history the PP gate already acted on.',
    'sampling.errors.invalid': 'That does not fit what a sample record accepts.',
    'sampling.errors.mixed_cost_currencies':
      'These sample costs are in different currencies and cannot be totalled without a stated rate.',
    'sampling.errors.order_not_found': 'That order no longer exists.',
    'sampling.errors.request_closed': 'That sample request is closed.',
    'sampling.errors.request_draft_insert_only':
      'A sample request is raised, not edited through the approve inbox.',
    'sampling.errors.request_not_found': 'That sample request no longer exists.',
    'sampling.errors.stage_not_forward':
      'Sample stages move forward only. A sample back in pattern is a remake, which is a new request.',
    'settings.errors.disable_needs_note': 'Turning that off needs a note saying why.',
    'settings.errors.invalid_policy': 'That policy value is not one this setting accepts.',
    'settings.errors.last_owner': 'A company must keep at least one owner.',
    'settings.errors.not_a_member': 'That person is not a member of this company.',
    'settings.errors.no_such_line':
      'This factory has no line with that code. Check it against the line board.',
    'settings.errors.policy_is_admin_only': 'Only an admin or owner changes that policy.',
    'settings.errors.role_not_held': 'They do not hold that role.',
    'shipment.errors.carton_already_loaded': 'That carton is already loaded on a shipment.',
    'shipment.errors.carton_draft_insert_only':
      'A carton is opened and repacked on the floor, not edited in a queue — the packing list and the shipped quantity are both derived from these rows.',
    'shipment.errors.carton_not_found': 'That carton no longer exists.',
    'shipment.errors.carton_wrong_order': 'That carton was packed against a different order.',
    'shipment.errors.doc_needs_file':
      'A document cannot be marked ready without the file itself — “bill of lading ready” with no bill of lading is how a presentation reaches the bank counter incomplete.',
    'shipment.errors.doc_not_on_checklist': 'That document is not on this shipment’s checklist.',
    'shipment.errors.docs_not_ready':
      'Some documents on the checklist are still pending. The bank is presented the whole set or none of it.',
    'shipment.errors.exp_already_set':
      'This shipment already has an EXP number. The bank issues one per shipment, so a different one is either a typo needing a trail or another shipment’s number.',
    'shipment.errors.invalid': 'That does not fit what this shipment record accepts.',
    'shipment.errors.lc_not_found': 'That letter of credit no longer exists.',
    'shipment.errors.no_cartons': 'Nothing has been packed against this order yet.',
    'shipment.errors.no_cartons_loaded': 'No cartons are loaded on this shipment.',
    'shipment.errors.no_checklist':
      'This shipment has no document checklist yet. Build it from the LC first.',
    'shipment.errors.no_doc_kinds':
      'The LC lists no required documents and none were supplied, so an empty checklist would leave the EXP number as the only thing between this shipment and the bank.',
    'shipment.errors.no_lc_on_shipment':
      'No letter of credit is linked to this shipment, so there is no tolerance band to check against.',
    'shipment.errors.no_order_styles':
      'That order has no styles, so nothing can be packed against it.',
    'shipment.errors.nothing_to_waive': 'There is no failed final inspection to waive.',
    'shipment.errors.order_not_found': 'That order no longer exists.',
    'shipment.errors.packing_list_has_mismatches':
      'This list does not match the buyer’s grid. It can be approved, but only knowingly.',
    'shipment.errors.packing_list_not_found': 'That packing list no longer exists.',
    'shipment.errors.packing_list_stale':
      'Cartons have changed since this list was generated. Regenerate it before locking — you would be locking a list that no longer matches the boxes.',
    'shipment.errors.shipment_already_departed':
      'These goods are already ex-factory. The manifest is what left, and adding to it now would change a document already presented.',
    'shipment.errors.shipment_not_found': 'That shipment no longer exists.',
    'shipment.errors.tolerance_not_breached':
      'The shipped quantity is inside the LC’s tolerance, so there is nothing to override.',
    'shipment.errors.waiver_needs_commercial':
      'Only commercial or an owner may waive this — a failed final inspection, or a credit that cannot accept the shipment date.',
    'shipment.errors.waiver_needs_reason':
      'A waiver needs a stated reason — it is the entire justification a later auditor has.',
    'store.errors.adjustment_below_zero': 'That adjustment would take stock below zero.',
    'store.errors.bom_item_unknown': 'That item is not on the style’s bill of materials.',
    'store.errors.bonded_requires_ud':
      'Bonded material must be issued against a utilization declaration. Issuing without one is a customs exposure, not a paperwork slip.',
    'store.errors.exceeds_requisition': 'That is more than the requisition asked for.',
    'store.errors.item_uom_locked':
      'That item already holds stock in its original unit. Changing the unit now would silently reinterpret every quantity already recorded against it.',
    'store.errors.location_kind_locked':
      'A location’s kind is fixed once it exists. Rolls already here were received under its current customs status, and changing it would reclassify them after the fact.',
    'store.errors.grn_not_found': 'That goods receipt no longer exists.',
    'store.errors.item_not_found': 'That item is not in the store.',
    'store.errors.item_not_requisitioned':
      'That item is not on the requisition being issued against.',
    'store.errors.requisition_has_no_lines': 'That requisition has no lines.',
    'store.errors.roll_item_mismatch': 'That roll is a different item to the one being issued.',
    'store.errors.roll_not_found': 'That roll no longer exists.',
    'store.errors.roll_not_in_stock': 'That roll is not in stock.',
    'store.errors.unit_mismatch': 'The unit does not match the one this item is held in.',
    'workforce.errors.gazette_draft_insert_only':
      'A gazette is superseded, never edited — rewriting rates would change what people were told they were paid.',
    'workforce.errors.gazette_has_no_grades':
      'That gazette has no grade table, so a payroll computed against it would pay nothing.',
    'workforce.errors.gazette_not_found': 'That wage gazette no longer exists.',
    'workforce.errors.unknown_employees':
      'The export names employees who are not on the register — nothing was imported, because half a floor landing silently is a payroll short for the other half.',
    'workforce.errors.gazette_superseded': 'That gazette has been superseded.',
    'workforce.errors.no_active_gazette':
      'No wage gazette is active for that period, so there are no rates to compute against.',
    'workforce.errors.payroll_compute_failed':
      'Payroll could not be computed. Nothing was written.',
    'workforce.errors.run_not_found': 'That payroll run no longer exists.',
    'workforce.errors.run_not_recomputable':
      'That run has been approved. A correction is an adjustment in the next period, not a rewrite of a paid figure.',

    // ── 3.2 Procurement ──
    'procurement.notifications.over_receipt.title':
      'Over-receipt: {receivedQty} received against {orderedQty} ordered ({overReceiptQty} over, allowance {tolerancePct}%)',

    // ── 9.1 Maintenance · what a refused action says ──
    // These are the errors a screen can actually put in front of somebody. Without an entry
    // the raw key renders, which is what these two screens were doing.
    'maintenance.errors.serial_exists':
      'A machine with that serial is already registered. Two rows for one machine split its service history, so check the registry before adding it again.',
    'maintenance.errors.machine_not_found': 'That machine is no longer in the registry.',
    'maintenance.errors.line_not_found': 'That line no longer exists.',
    'maintenance.errors.schedule_not_found': 'That maintenance schedule no longer exists.',
    'maintenance.errors.schedule_type_mismatch':
      'That checklist belongs to a different type of machine. Signing it off here would record a service that did not happen.',
  },

  bn: {
    // ── core ──
    'notifications.system.welcome.title': 'FabricXAI-তে স্বাগতম',
    'notifications.system.test.title': 'পরীক্ষামূলক নোটিফিকেশন',
    'notifications.approve.waiting.title': '{count}টি পরিবর্তন আপনার অনুমোদনের অপেক্ষায়',
    'notifications.lc.expiry_near.title': 'LC {lcNumber} শেষ হবে {date} তারিখে',
    'core.notifications.jobs_silent.title':
      'নির্ধারিত জব বন্ধ হয়ে গেছে: {staleCount}টি নীরব, {stuckCount}টি আটকে আছে',

    // ── 1.3 ──
    // The floor says these terms in English anyway (PP, QA, ex-factory), so the
    // Bangla keeps them rather than inventing translations nobody uses out loud.
    'orders.milestones.order_confirmed': 'পিও গৃহীত',
    'orders.milestones.yarn_booking': 'সুতা বুকিং',
    'orders.milestones.yarn_in_house': 'সুতা ইন-হাউস',
    'orders.milestones.knitting': 'নিটিং সম্পন্ন · গ্রেইজ',
    'orders.milestones.fabric_booking': 'ফ্যাব্রিক বুকিং',
    'orders.milestones.lab_dip_approval': 'ল্যাব ডিপ অনুমোদিত',
    'orders.milestones.fabric_in_house': 'ফ্যাব্রিক ইন-হাউস',
    'orders.milestones.trims_in_house': 'ট্রিমস ইন-হাউস',
    'orders.milestones.hardware_in_house': 'হার্ডওয়্যার ইন-হাউস',
    'orders.milestones.pp_sample_submit': 'পিপি স্যাম্পল জমা',
    'orders.milestones.pp_approval': 'পিপি স্যাম্পল অনুমোদিত',
    'orders.milestones.cutting': 'কাটিং শুরু',
    'orders.milestones.sewing_start': 'সিউইং শুরু',
    'orders.milestones.sewing_end': 'সিউইং সম্পন্ন',
    'orders.milestones.linking': 'লিংকিং সম্পন্ন',
    'orders.milestones.finishing': 'ফিনিশিং ও প্যাকিং',
    'orders.milestones.final_inspection': 'ফাইনাল ইন্সপেকশন · বায়ার কিউএ',
    'orders.milestones.ex_factory': 'এক্স-ফ্যাক্টরি',
    'orders.milestones.knitting_complete': 'নিটিং সম্পন্ন',
    'orders.milestones.dyeing_complete': 'ডাইং সম্পন্ন',
    'orders.milestones.wash_approval': 'ওয়াশ অনুমোদিত',
    'orders.milestones.shell_fabric_inspection': 'শেল ফ্যাব্রিক পরিদর্শিত',

    'orders.notifications.milestone_at_risk.title': '{milestone} ঝুঁকিতে আছে',
    'orders.notifications.milestone_at_risk.body':
      '{milestone}-এর পরিকল্পিত তারিখ ছিল {plannedDate}, এখনও শেষ হয়নি।',
    'orders.notifications.milestone_late.title': '{milestone} দেরি হয়ে গেছে',
    'orders.notifications.milestone_late.body':
      '{milestone}-এর তারিখ ছিল {plannedDate}, এখনও সম্পন্ন হিসেবে রেকর্ড হয়নি।',

    // ── 2.1 ──
    'commercial.notifications.lc_countdown_latest_shipment.title':
      'LC {lcNumber}: শেষ শিপমেন্টের ({date}) বাকি {daysLeft} দিন',
    'commercial.notifications.lc_countdown_expiry.title':
      'LC {lcNumber}: মেয়াদ শেষের ({date}) বাকি {daysLeft} দিন',
    'marbim.errors.kind_is_inline_only':
      'এই ডকুমেন্টটি সরাসরি তার নিজের স্ক্রিনে পড়া হয়, approve inbox-এ যায় না। সংশ্লিষ্ট স্ক্রিন খুলে সেখানে দিন।',
    'compliance.errors.findings_no_audit':
      'এই ফাইন্ডিংগুলো কোনো অডিটের সঙ্গে যুক্ত নয়। আগে অডিটটি লগ করুন, তারপর রিপোর্টটি আবার পাঠান।',
    'commercial.errors.lc_draft_no_buyer':
      'এই ক্রেডিটের বিপরীতে কোনো ক্রেতা নেই। ডকুমেন্টটি আবার পাঠান এবং কার ক্রেডিট তা বেছে নিন।',
    'commercial.errors.order_not_found': 'সেই অর্ডারটি আর নেই, তাই ক্রেডিট এটি কভার করতে পারবে না।',
    'approvals.errors.rule_not_found': 'এই রাউটিং নিয়মটি আর নেই, বা আগেই বাতিল হয়েছে।',
    'errors.self_approval':
      'এই ড্রাফট আপনিই তুলেছেন, আর এই টেবিলে দ্বিতীয় একজনের সই লাগে — ব্যাংক বা অডিটর যে রেকর্ড দেখতে চাইবে, তা লেখক নিজে সই করে চালু করতে পারেন না। অন্য একজন অনুমোদনকারীকে সিদ্ধান্ত নিতে বলুন।',
        'errors.reference_empty': 'কী খুঁজতে হবে সেটাই দেওয়া হয়নি — একটি কোড বা আইডি লাগবে।',
    'errors.reference_kind_unknown':
      'এই ধরনের জিনিস কীভাবে খুঁজতে হয় সিস্টেম জানে না। এটি আপনার লেখা কিছুর ভুল নয়, ভেতরের সংযোগের সমস্যা।',
    'errors.drawer_kind_unknown':
      'এই ধরনের জিনিসের দ্রুত-দেখা কীভাবে দেখাতে হয় সিস্টেম জানে না। এটি আপনার ক্লিকের ভুল নয়, ভেতরের সংযোগের সমস্যা।',
    'errors.reference_not_found':
      'এই রেফারেন্সের সঙ্গে মিলে এমন কিছু পাওয়া যায়নি। যে স্ক্রিন থেকে কোডটি নিয়েছেন সেটির সঙ্গে মিলিয়ে দেখুন — হুবহু মেলানো হয়, কাছাকাছি কিছু ধরে নেওয়া হয় না।',
    'costing.errors.bom_line_no_consumption':
      'কিছু লাইনে consumption নেই, অথচ material লাইনে কিছু না কিছু লাগবেই। টেক প্যাকে সেলাই সুতার পরিমাণ সাধারণত লেখা থাকে না — অনুমোদনের আগে ওই লাইনগুলোতে পরিমাণ বসান।',
    'maintenance.notifications.ticket_claimed.title':
      'একজন মেকানিক আপনার টিকিট নিয়েছেন, আসছেন।',
    'maintenance.notifications.ticket_resolved.title':
      'আপনার মেশিনের টিকিট সমাধান হয়েছে — লাইন চালানো যাবে।',
    'approvals.notifications.draft_aging.title':
      'আপনার approve সারিতে একটি খসড়া {hours} ঘণ্টার বেশি অপেক্ষায়।',
    'shipment.notifications.packable.title':
      '{poNumber}-এর {pieces} পিস ফিনিশিং থেকে এসেছে — কার্টনের পরিকল্পনা করা যায়।',
    'maintenance.notifications.ticket_opened.title':
      'একটি লাইন বন্ধ — মেশিনের একটি টিকিট কেউ নেয়নি।',
    'sampling.notifications.pp_approved.title':
      '{styleCode}-এর PP অনুমোদিত — কাটিং শুরু করা যাবে।',
    'sampling.notifications.pp_rejected.title':
      '{styleCode}-এর PP প্রত্যাখ্যাত — কাটিং বন্ধই থাকছে।',
    'quality.notifications.lot_inspectable.title':
      '{poNumber}-এর {pieces} পিস ফিনিশিং থেকে এসেছে — স্যাম্পল নেওয়া যায়।',
    'store.notifications.grn_failed.title':
      'চালান {challanNo}-এর ইন্সপেকশন ফেল করেছে — ওই রোলগুলো আটকে আছে।',
    'store.notifications.grn_passed.title': 'চালান {challanNo} ইন্সপেকশনে পাস করেছে।',
    'store.notifications.requisition_raised.title':
      'মালামাল চাওয়া হয়েছে — {lines}টি লাইন স্টোরের অপেক্ষায়।',
    'production.notifications.dayclose_skipped.title':
      '{forDate} তারিখে কিছু লাইনের কোনো এফিসিয়েন্সি হিসাব হয়নি।',
    'production.notifications.dayclose_skipped.body':
      '{lines} ওই দিন প্রোডাকশন করেছে কিন্তু কোনো প্ল্যান ছিল না — SMV আর ম্যানপাওয়ার ছাড়া মাপার কিছু থাকে না, তাই দিনের হিসাবে এগুলো নেই। শিফট শুরুর আগে লাইনের প্ল্যান দিলে সংখ্যাটা নিজে থেকেই আসবে।',
    'production.notifications.runrate_slip.title': 'লাইন {line} দিনের পরিকল্পনা থেকে পিছিয়ে পড়ছে।',
    'production.notifications.runrate_slip.body':
      'এ পর্যন্ত পরিকল্পিত {expected}-এর বিপরীতে {made} হয়েছে — {behind} পিস পিছিয়ে, এক ঘণ্টার বেশি কাজ।',
    'commercial.errors.lc_expiry_before_shipment':
      'এই ক্রেডিটের মেয়াদ তার শেষ শিপমেন্ট তারিখের আগেই শেষ হয়ে যাচ্ছে — অর্থাৎ পণ্য বেরোনোর আগেই ব্যাংকে কাগজ জমা দিতে হবে। মেয়াদ ও শেষ শিপমেন্ট — দুটি তারিখ দেখুন; একটিতে দিন আর মাস উল্টে গেছে।',
    'commercial.errors.lc_order_buyer_mismatch':
      'এই ক্রেডিট অন্য বায়ারের খোলা — যে পণ্যের জন্য ক্রেডিট খোলা হয়নি তার দাম এটি দিতে পারে না।',
    'commercial.lc.conflict.expiry': 'LC-র মেয়াদ শিপমেন্টের আগেই শেষ হয়ে যাবে',
    'commercial.lc.conflict.latest_shipment':
      'LC-র শেষ শিপমেন্ট তারিখ পরিকল্পিত ex-factory তারিখের আগে',
    'commercial.lc.conflict.presentation_window':
      'LC-তে শিপমেন্টের পর ডকুমেন্ট জমা দেওয়ার সময় খুব কম',
    'commercial.lc.conflict.unknown_ex_factory':
      'LC এমন একটি অর্ডারের সাথে যুক্ত যার ex-factory তারিখ নেই',

    // ── 2.2 ──
    'commercial.notifications.ud_expiring.title':
      'UD {udNumber}-এর মেয়াদ {validUntil} তারিখে শেষ ({daysLeft} দিন বাকি)',
    'commercial.notifications.ud_low_balance.title': 'UD {udNumber}: {itemRef} প্রায় শেষ',
    'commercial.notifications.ud_reconciliation_due.title':
      '{period} মাসের UD মিলকরণ বাকি আছে',

    // ── Gates ──
    // ── gates · a blocked gate is what stops somebody's work; all thirty are Bangla ──
    'gates.pp_approval.wrong_sample_type':
      'এটি PP স্যাম্পল নয়। শুধু প্রি-প্রোডাকশন অ্যাপ্রুভালেই কাটিং খোলে।',
    'gates.pp_approval.style_not_found': 'এই স্টাইল এই অর্ডারে নেই।',
    'gates.pp_approval.style_mismatch':
      'অ্যাপ্রুভ হওয়া স্যাম্পলটি যে স্টাইলের, কাটা হচ্ছে অন্য স্টাইল।',
    'gates.pp_approval.demo_bypass':
      'ডেমোর জন্য PP গেট বাইপাস করা হয়েছে। ডেভেলপমেন্টের বাইরে এটি কখনো হয় না।',
    'gates.issued_fabric.blocked':
      'ইস্যু করা কাপড়ের চেক পাস করেনি, তাই লে আটকে রাখা হয়েছে।',
    'gates.final_inspection.none':
      'এই অর্ডারের কোনো ফাইনাল ইন্সপেকশন নেই। একটি না হওয়া পর্যন্ত শিপমেন্ট আটকে থাকবে।',
    'gates.final_inspection.failed':
      'ফাইনাল ইন্সপেকশন ফেল করেছে। বায়ার লটটি নিলে কমার্শিয়াল বা ওনার রেকর্ডে মওকুফ করতে পারেন।',
    'gates.final_inspection.blocked': 'ফাইনাল ইন্সপেকশন এই শিপমেন্ট ছাড় করেনি।',
    'gates.exp_number.missing':
      'এই শিপমেন্টে EXP নম্বর নেই। বাংলাদেশ ব্যাংক ডকুমেন্ট জমার আগে এটি চায়, তাই দেরি না করে হ্যান্ডঅফ আটকে দেওয়া হয়েছে।',
    'gates.lc_date.after_latest_shipment':
      'এই শিপমেন্ট LC-র শেষ শিপমেন্ট তারিখের পরে যাচ্ছে, তাই ব্যাংক প্রেজেন্টেশন নেবে না। ডিপার্চার কনফার্ম করার আগে কমার্শিয়াল রেকর্ডে এই ব্যত্যয় মেনে নিতে পারেন।',
    'gates.lc_date.expired':
      'এই শিপমেন্টের তারিখের আগেই LC-র মেয়াদ শেষ হয়েছে, জমা দেওয়ার মতো কিছু আর নেই। ডিপার্চার কনফার্ম করার আগে কমার্শিয়াল রেকর্ডে এই ব্যত্যয় মেনে নিতে পারেন।',
    'gates.btb_headroom.no_btb':
      'কোনো ব্যাক-টু-ব্যাক ক্রেডিট যুক্ত নেই, আর সেটি ছাড়া ইমপোর্ট PO ইস্যু করা যায় না — তাহলে ফ্যাক্টরি সাপ্লায়ারের কাছে দায়বদ্ধ হবে অথচ টাকার উৎস থাকবে না।',
    'gates.btb_headroom.exceeded':
      'এই পারচেজ অর্ডার মাস্টার ক্রেডিটের নিচে থাকা ব্যাক-টু-ব্যাক ক্রেডিটগুলোকে সিলিং ছাড়িয়ে নিয়ে যাবে।',
    'gates.btb_headroom.btb_not_found': 'এই ব্যাক-টু-ব্যাক ক্রেডিট আর নেই।',
    'gates.btb_headroom.master_not_found':
      'এই ব্যাক-টু-ব্যাকের পেছনের মাস্টার ক্রেডিট নেই, তাই এর হেডরুম মেলানো যাচ্ছে না।',
    'gates.btb_headroom.master_not_active':
      'মাস্টার ক্রেডিট সক্রিয় নয়, তাই এই ব্যাক-টু-ব্যাকের পেছনে কোনো টাকার উৎস নেই।',
    'gates.btb_headroom.po_exceeds_btb':
      'ওই ক্রেডিটে আগে থেকে দেওয়া অর্ডারগুলো ধরলে, এই পারচেজ অর্ডার তার ফান্ডিং ব্যাক-টু-ব্যাক ক্রেডিটের চেয়ে বড়।',
    'gates.btb_headroom.po_currency_mismatch':
      'এই পারচেজ অর্ডার আর তার ফান্ডিং ব্যাক-টু-ব্যাক ক্রেডিট আলাদা কারেন্সিতে, আর মেলানোর কোনো রেট বলা হয়নি।',
    'gates.btb_headroom.currency_mismatch':
      'ব্যাক-টু-ব্যাক আর তার মাস্টার ক্রেডিট আলাদা মুদ্রায়, আর মেলানোর মতো কোনো রেট বলা হয়নি।',
    'gates.fabric_inspection.not_inspected':
      'এই রোলগুলোর কয়েকটির ৪-পয়েন্ট ইন্সপেকশন এখনও হয়নি। ইন্সপেকশন কাটিংয়ের আগে, পরে নয়।',
    'gates.fabric_inspection.failed':
      'এই রোলগুলোর কয়েকটি ৪-পয়েন্ট ইন্সপেকশনে ফেল করেছে। এত খারাপ গ্রেডের কাপড় কাটার পরে বায়ার ক্লেইম হয়ে ফিরে আসে।',
    'gates.fabric_inspection.roll_not_found':
      'একটি রোল যাচাই করা যায়নি, তাই বাকিগুলোর অবস্থাও নিশ্চিত নয়।',
    'gates.fabric_inspection.no_provider':
      'ফেব্রিক ইন্সপেকশন এখন যাচাই করা যাচ্ছে না, তাই ইস্যু আটকানো হয়েছে',
    // The floor meets these two: the storekeeper at the UD gate, the cutting master at the
    // PP gate. The desk-facing ones (BTB, final inspection) stay English on the same
    // boundary as the rest of the office namespaces.
    'gates.ud_balance.insufficient':
      'এই ইস্যু UD-এর সীমার বেশি হয়ে যাবে। ইচ্ছাকৃত ওভারড্র হলে owner অ্যাপ্রুভ ইনবক্সে অনুমোদন দিতে পারেন।',
    'commercial.ud.insufficient_balance':
      'এই ইস্যু UD-এর সীমার বেশি হয়ে যাবে। ইচ্ছাকৃত ওভারড্র হলে owner অ্যাপ্রুভ ইনবক্সে অনুমোদন দিতে পারেন।',
    'commercial.ud.not_active':
      'এই UD সক্রিয় নয়, তাই এর বিপরীতে কিছু ইস্যু করা যাবে না।',
    'commercial.ud.expired':
      'এই UD-র মেয়াদ শেষ হয়ে গেছে। মেয়াদোত্তীর্ণ ঘোষণার বিপরীতে বন্ডেড মাল বের করা যায় না — কাস্টমস থেকে নতুন UD লাগবে।',
    'commercial.ud.item_not_authorized':
      'এই মালটি এই UD-তে নেই। UD শুধু নাম-উল্লেখ করা মালামাল কভার করে।',
    'commercial.ud.unit_mismatch':
      'UD যে এককে অনুমোদন দিয়েছে, চাওয়া হয়েছে অন্য এককে — এক থেকে অন্যটিতে রূপান্তর কাস্টমসের প্রশ্ন।',
    'pulse.milestones_late': '{count}টি মাইলফলক দেরিতে — সবচেয়ে খারাপ: {worst}।',
    'pulse.milestones_at_risk': '{count}টি মাইলফলক পিছিয়ে পড়ার ঝুঁকিতে।',
    'pulse.exp_missing':
      'শিপমেন্ট {partialNo}-এর EXP নম্বর নেই — ব্যাংক এর কাগজ নেবে না।',
    'pulse.lc_deadline_breached':
      'শিপমেন্ট {partialNo} এলসির শেষ-শিপমেন্ট তারিখ {days} দিন পেরিয়ে গেছে।',
    'pulse.lc_deadline_near':
      'শিপমেন্ট {partialNo} এলসির শেষ-শিপমেন্ট তারিখ থেকে {days} দিন দূরে।',
    'gates.pp_approval.not_approved':
      'এই স্টাইলের PP স্যাম্পল বায়ার এখনও অ্যাপ্রুভ করেননি, তাই কাটিং শুরু করা যাবে না।',
    'gates.pp_approval.no_sample':
      'এই স্টাইলের কোনো PP স্যাম্পল তোলা হয়নি। বায়ার অ্যাপ্রুভ করার পরেই কাটিং শুরু হয়।',
    'gates.pp_approval.rejected':
      'বায়ার PP স্যাম্পল রিজেক্ট করেছেন। নতুন রাউন্ড অ্যাপ্রুভ না হলে এই স্টাইল কাটা যাবে না।',
    'gates.pp_approval.awaiting_feedback': 'PP স্যাম্পল বায়ারের কাছে আছে, এখনও কোনো ভারডিক্ট আসেনি।',
    'gates.pp_approval.no_provider':
      'PP অ্যাপ্রুভাল এখন যাচাই করা যাচ্ছে না, তাই কাটিং খোলার বদলে আটকানো হয়েছে।',
    'gates.issued_fabric.no_rolls': 'এই অর্ডারের জন্য কোনো ফেব্রিক ইস্যু হয়নি, তাই লে করার কিছু নেই।',
    'gates.issued_fabric.not_issued_to_order': 'ওই রোলগুলো অন্য একটি অর্ডারের বিপরীতে ইস্যু হয়েছে।',

    // ── 6.1 ──
    'production.notifications.partition_default.title':
      'প্রোডাকশন এন্ট্রি ডিফল্ট পার্টিশনে জমা হচ্ছে',
    'production.notifications.run_rate_at_risk.title':
      '{poNumber} এর সেলাই শেষ হবে {forecastDate}, {milestoneDate} এর {slipDays} দিন পরে — দৈনিক {ratePerDay} হারে',

    // ── বিভাগ-পারাপার খবর ──
    'quality.notifications.fabric_rejected.title':
      'একটি রোল ৪-পয়েন্ট ইন্সপেকশনে ফেল ({pointsPer100SqYd}, সীমা {threshold}) — ইস্যু করা যাবে না',
    'quality.notifications.final_failed.title':
      '{lotQty} পিসের লট ফাইনাল ইন্সপেকশনে ফেল ({sampleSize} নমুনা) — শিপ হবে না',
    'quality.notifications.measurement_failed.title':
      '{sampledSize} সাইজ বায়ারের টলারেন্সের বাইরে',
    'shipment.notifications.exp_missing.title':
      'EXP নম্বর নেই — ব্যাংকে ডকুমেন্ট জমা আটকে গেছে',
    'shipment.notifications.tolerance_breach.title':
      'LC টলারেন্স {tolerancePct}% এর বিপরীতে {varianceQty} {direction}',
    'costing.notifications.below_floor.title':
      '{styleCode} অনুমোদিত {achievedMarginPct}% মার্জিনে, ফ্লোর {floorPct}% এর নিচে',
    'cutting.notifications.wastage_variance.title':
      'কাটিং অপচয় {wastagePct}%, সীমা {threshold}%',
    'commercial.notifications.ud_overdrawn.title':
      'UD {udNumber} এ {itemRef} {shortfall} পরিমাণ ওভারড্র — শুল্ক ঝুঁকি',

    // ── 11.1 ──
    'finance.notifications.cash_shortfall.title':
      '{week} সপ্তাহে নগদ ঘাটতি — {inflow} আসছে, {outflow} যাচ্ছে ({currency})',

    // ── 7.1 ──
    'quality.notifications.repeat_defect.title':
      '{operation} এ {code} — টানা {days} দিন, {through} পর্যন্ত',

    // ── 9.1 ──
    'maintenance.notifications.pm_due.title':
      '{machineType} মেশিনের PM বাকি (তারিখ {dueOn}, {daysOverdue} দিন পার)',
    'maintenance.notifications.parts_low.title':
      '{name}: স্টকে {onHand}টি, সর্বনিম্ন থাকা দরকার {minLevel}টি',
    'maintenance.notifications.breakdown_outliers.title':
      'যে মেশিনগুলো অন্যদের তুলনায় অনেক বেশি নষ্ট হচ্ছে ({month})',
    'maintenance.notifications.downtime_no_rate.title':
      '{month} মাসের ডাউনটাইম খরচ হিসাব করা যায়নি: লাইন-মিনিটের রেট সেট করা নেই',

    // ── 10.2 ──
    'compliance.notifications.certificate_expiring.title':
      '{kind} সার্টিফিকেটের মেয়াদ {expiresOn} তারিখে শেষ ({daysRemaining} দিন বাকি)',
    'compliance.notifications.certificate_expired.title':
      '{kind} সার্টিফিকেটের মেয়াদ {expiresOn} তারিখে শেষ হয়ে গেছে',
    'compliance.notifications.cap_escalated.title':
      '{severity} সংশোধনী ব্যবস্থা এখনও {status}, শেষ তারিখ {deadline}',

    // ── 3.2 Procurement ──
    'procurement.notifications.over_receipt.title':
      'অতিরিক্ত গ্রহণ: {orderedQty}-এর বিপরীতে {receivedQty} এসেছে ({overReceiptQty} বেশি, ছাড় {tolerancePct}%)',

    // ── Refusals the FLOOR reads ────────────────────────────────────────────
    //
    // Only the departments whose readers are on the floor: store, cutting, production,
    // quality, sampling, maintenance, plus the shared `errors.*` that any screen can hit.
    // Commercial, finance, costing and the rest stay English on purpose — the office reads
    // them, and `t()` falls back, so nothing goes blank.
    //
    // Same rule as the English: say what happened and what to do next. No `{placeholder}`
    // here — `AppError.details` does not survive a server action, so a template would reach
    // a storekeeper with the braces still in it.
    'errors.confidence_not_measured':
      'এই ড্রাফটটি কথোপকথন থেকে তৈরি, তাই এটি কতটা নির্ভরযোগ্য তা কেউ মাপেনি। এখানে confidence স্কোর দিলে সেটি বানানো হতো, তাই অর্থপূর্ণ কিছুর মতো দেখানোর বদলে এটি বাতিল করা হয়েছে।',
    'errors.confidence_required':
      'Extraction যে ঘরগুলো পূরণ করেছে, তার প্রতিটির জন্য confidence থাকতে হবে — না থাকলে কোন ঘরটা ভালো করে দেখতে হবে তা বোঝার উপায় নেই।',
    'errors.invalid_tenant_scope':
      'অনুরোধটিতে কোন কোম্পানির কাজ তা বলা নেই, তাই সবার ডেটার উপর চালানোর বদলে এটি বাতিল করা হয়েছে।',

    'cutting.errors.bundle_not_found': 'এই bundle-টি আর নেই।',
    'cutting.errors.bundles_already_generated': 'এই lay-এর bundle আগেই তৈরি হয়ে গেছে।',
    'cutting.errors.lay_not_found': 'এই lay-টি আর নেই।',
    'cutting.errors.marker_code_exists': 'এই কোডের marker আগেই নিবন্ধিত আছে।',
    'cutting.errors.marker_draft_insert_only':
      'marker বদলাতে হলে নতুন marker করতে হবে: এটি ধরে যে lay গুলো বিছানো হয়েছে, সেগুলো এই ratio-তেই কাটা।',
    'cutting.errors.marker_not_found': 'এই marker-টি আর নেই।',
    'cutting.errors.no_breakdown':
      'এই স্টাইলের রং ও সাইজের ব্রেকডাউন নেই, তাই বায়ার যা অর্ডার করেছে তার সাথে কাটিং মিলিয়ে দেখা যাচ্ছে না।',
    'cutting.errors.no_cut_lays': 'এই অর্ডারে এখনও কিছু কাটা হয়নি।',
    'cutting.errors.report_not_found': 'এই কাটিং রিপোর্টটি আর নেই।',
    'cutting.errors.style_not_found': 'এই স্টাইলটি এই অর্ডারে নেই।',
    'cutting.errors.uncomputable': 'হিসাব করার মতো যথেষ্ট এন্ট্রি এখনও হয়নি।',
    'errors.commit_failed': 'পরিবর্তনটি সংরক্ষণ করা যায়নি। কিছুই লেখা হয়নি।',
    'errors.confidence_out_of_range': 'confidence-এর মান ০ থেকে ১-এর মধ্যে হতে হবে।',
    'errors.document_not_found': 'এই ডকুমেন্টটি আর নেই।',
    'errors.document_not_uploaded': 'ফাইলটির আপলোড শেষ হয়নি, তাই যুক্ত করার কিছু নেই।',
    // Deliberately as vague as the English. "Held in a security check" would name a
    // mechanism that does not exist: nothing in the codebase ever sets `quarantined`
    // (there is no AV scan yet — audit INFRA-M12), so the Bangla must not assert a scan
    // the English does not claim and the system does not perform.
    'errors.document_quarantined': 'ফাইলটি আটকে রাখা হয়েছে, এটি ব্যবহার করা যাবে না।',
    'errors.document_size_invalid':
      'ফাইলের সাইজ যা বলা হয়েছিল তার সাথে মিলছে না — আবার আপলোড করুন।',
    'errors.document_too_large': 'ফাইলটি অনুমোদিত সীমার চেয়ে বড়।',
    'errors.document_type_not_allowed':
      'এই ধরনের ফাইল নেওয়া হয় না। PDF, ছবি, স্প্রেডশিট আর Word ডকুমেন্ট চলবে।',
    'errors.empty_update': 'কিছু বদলানো হয়নি, তাই কিছু সংরক্ষণও হয়নি।',
    'errors.forbidden': 'আপনার role-এ এই কাজের অনুমতি নেই।',
    'errors.illegal_transition': 'এখনকার স্টেটাস থেকে সরাসরি ওই স্টেটাসে যাওয়া যায় না।',
    'errors.module_inactive':
      'এই মডিউলটি এই কারখানার জন্য বন্ধ আছে। মালিক সেটিংস থেকে চালু করতে পারেন।',
    'errors.module_not_disableable': 'এই মডিউলটি প্ল্যাটফর্মের মূল অংশ — বন্ধ করা যায় না।',
    'errors.module_required_by': 'অন্য চালু মডিউল এটির উপর নির্ভর করে। আগে সেগুলো বন্ধ করুন।',
    'errors.module_requires':
      'এই মডিউলটি এমন মডিউলের উপর নির্ভর করে যেগুলো বন্ধ আছে। আগে সেগুলো চালু করুন।',
    'errors.owner_only': 'কারখানায় কোন মডিউল চলবে তা কেবল মালিকই বদলাতে পারেন।',
    'errors.invalid_identifier':
      'এই ড্রাফটে এমন একটি ঘর আছে যার কলাম টার্গেট টেবিলে নেই, তাই লেখা যাচ্ছে না। এটি যে মডিউলের, কমিট সেই মডিউলকেই করতে হবে।',
    'errors.not_an_approver': 'এই পরিবর্তনে যাদের অনুমোদন লাগে, আপনি তাদের একজন নন।',
    'errors.payload_invalid':
      'যা লেখা হয়েছে তার কিছু অংশ এই রেকর্ডে চলে না। কিছুই সংরক্ষণ হয়নি।',
    'errors.pending_change_not_found': 'এই ড্রাফটটি আর নেই।',
    'errors.not_the_raiser':
      'এই রিডিংটি যিনি ডকুমেন্ট আপলোড করেছেন তাঁর। কাগজের সাথে মিলিয়ে দেখে পাঠানোর কাজটি কেবল তিনিই করতে পারেন।',
    'errors.pending_change_not_drafted':
      'এই রিডিংটি ইতিমধ্যে অনুমোদনে পাঠানো হয়েছে, নয়তো বাতিল করা হয়েছে।',
    'errors.pending_change_not_pending': 'এই ড্রাফটের সিদ্ধান্ত আগেই হয়ে গেছে।',
    'errors.rate_limited':
      'অল্প সময়ে অনেকবার চেষ্টা হয়েছে। একটু পরে আবার করুন — কিছু সংরক্ষণ হয়নি।',
    'errors.sync_batch_too_large': 'অফলাইন ব্যাচটি এত বড় যে একবারে sync করা যাবে না।',
    'errors.sync_failed': 'অফলাইন ব্যাচটি sync হয়নি। এর কোনো এন্ট্রিই জমা হয়নি।',
    'errors.sync_operation_unknown':
      'এই ধরনের এন্ট্রি সার্ভার চেনে না। ডিভাইসের অ্যাপ সম্ভবত সার্ভারের চেয়ে নতুন — যিনি সিস্টেম দেখেন তাকে জানান।',
    'errors.sync_role_forbidden':
      'এই এন্ট্রির জন্য যে role লাগে তা এই অ্যাকাউন্টে নেই। এন্ট্রিটি ডিভাইসেই জমা থাকবে — সুপারভাইজারকে বলে role নিয়ে আবার sync করুন।',
    'errors.target_id_mismatch': 'এই ড্রাফট যে সারির কথা বলছে, বদলানো হচ্ছে অন্য সারি।',
    'errors.target_not_registered': 'এই টেবিলে ড্রাফট রাখার অনুমতি ওই মডিউল দেয় না।',
    'errors.target_row_not_found': 'এই ড্রাফট যে সারিটি বদলাতে চেয়েছিল সেটি আর নেই।',
    'errors.unauthenticated': 'আপনি সাইন আউট হয়ে গেছেন। আবার সাইন ইন করুন — কিছু সংরক্ষণ হয়নি।',
    'errors.unknown_module': 'এই মডিউলটি নিবন্ধিত নয়।',
    'errors.unknown_schema': 'ড্রাফটটি এমন একটি গঠনের নাম বলছে যা এই মডিউলে নেই।',
    'maintenance.errors.invalid': 'এই রক্ষণাবেক্ষণ রেকর্ডে এটি চলে না।',
    'maintenance.errors.part_not_found': 'এই স্পেয়ার পার্টটি স্টোরে নেই।',
    'maintenance.errors.ticket_not_found': 'এই টিকিটটি আর নেই।',
    // The first planning refusal to reach the floor in Bangla. The rest of that module's
    // errors are still on AWAITING_BANGLA — a planner reads English today, an operator
    // being told a line cannot be created should not have to.
    'planning.errors.calendar_no_working_days':
      'ওই তারিখগুলোর মধ্যে কোনো কর্মদিবস পড়ে না। সপ্তাহের অন্তত একটি দিন বেছে নিন যেদিন লাইন চলে।',
    'planning.errors.calendar_range_backwards': 'ক্যালেন্ডার শুরুর আগেই শেষ হয়ে যাচ্ছে।',
    'planning.errors.downtime_exceeds_shift':
      'পরিকল্পিত ডাউনটাইম শিফটের চেয়ে কম হতে হবে, নাহলে লাইন কিছুই তৈরি করতে পারে না।',
    'planning.errors.line_needs_floor':
      'লাইন একটি ফ্লোরের অধীনে থাকে, আর ফ্লোর থাকে একটি ইউনিটের অধীনে। আগের কোনো ফ্লোর বেছে নিন, নয়তো নতুন ফ্লোরের তথ্য দিন।',
    'production.errors.count_exceeds_checked':
      'endline-এ যত পিস চেক হয়েছে, গণনা তার চেয়ে বেশি দেখানো হয়েছে।',
    'production.errors.downtime_already_closed': 'এই ডাউনটাইমটি আগেই বন্ধ করা হয়েছে।',
    'production.errors.downtime_already_open':
      'এই লাইনে একটি ডাউনটাইম এখনও খোলা আছে। নতুন একটি শুরু করার আগে সেটি বন্ধ করুন।',
    'production.errors.downtime_ends_before_start': 'ডাউনটাইম শুরুর আগে শেষ হতে পারে না।',
    'production.errors.downtime_not_found': 'এই ডাউনটাইম এন্ট্রিটি আর নেই।',
    'production.errors.line_out_of_scope':
      'এই লাইনটি আপনার নয়। আপনি যে লাইনগুলো দেখেন শুধু সেগুলোতেই এন্ট্রি দিতে পারবেন — লাইন বাড়াতে অফিসে বলুন।',
    'settings.errors.no_such_line':
      'এই ফ্যাক্টরিতে এই কোডের কোনো লাইন নেই। লাইন বোর্ডের সাথে কোডটি মিলিয়ে দেখুন।',
    'quality.errors.final_inspection_not_found': 'এই ফাইনাল ইন্সপেকশনটি আর নেই।',
    'quality.errors.line_not_found': 'এই লাইনটি আর নেই।',
    'quality.errors.no_aql_rows':
      'এই সাইজের lot-এর জন্য কোনো AQL টেবিল নেই, তাই কত পিস নমুনা নিতে হবে বের করা যাচ্ছে না।',
    'quality.errors.no_inline_checks': 'inline-এ এখনও কোনো চেক হয়নি, তাই DHU বের করার কিছু নেই।',
    'quality.errors.spec_not_found': 'এই স্টাইলের কোনো মেজারমেন্ট চার্ট জমা নেই।',
    'quality.errors.third_party_already_resulted':
      'এই ইন্সপেকশনের ফল আগেই দেওয়া হয়েছে। দ্বিতীয়বার মানে নতুন করে ইন্সপেকশন, আগেরটা বদলানো নয়।',
    'quality.errors.third_party_not_found': 'এই থার্ড-পার্টি ইন্সপেকশনটি আর নেই।',
    'quality.errors.uncomputable': 'হিসাব করার মতো যথেষ্ট এন্ট্রি এখনও হয়নি।',
    'quality.errors.unknown_defect_codes': 'এর মধ্যে কিছু ডিফেক্ট কোড ফ্যাক্টরির তালিকায় নেই।',
    'sampling.errors.feedback_draft_insert_only':
      'বায়ার যা বলেছে সেটাই এখানে লেখা থাকে। বদলালে PP gate যে কথার উপর ভরসা করে কাটিং ছেড়েছে সেটাই পাল্টে যায়।',
    'sampling.errors.invalid': 'স্যাম্পল রেকর্ডে এটি চলে না।',
    'sampling.errors.mixed_cost_currencies':
      'এই স্যাম্পলের খরচগুলো আলাদা আলাদা মুদ্রায় আছে, রেট না দিলে যোগ করা যাবে না।',
    'sampling.errors.order_not_found': 'এই অর্ডারটি আর নেই।',
    'sampling.errors.request_closed': 'এই স্যাম্পল রিকোয়েস্টটি বন্ধ করা হয়েছে।',
    'sampling.errors.request_draft_insert_only':
      'স্যাম্পল রিকোয়েস্ট নতুন করে তোলা হয়, approve inbox থেকে বদলানো হয় না।',
    'sampling.errors.request_not_found': 'এই স্যাম্পল রিকোয়েস্টটি আর নেই।',
    'sampling.errors.stage_not_forward':
      'স্যাম্পলের ধাপ শুধু সামনে এগোয়। প্যাটার্নে ফিরে যাওয়া মানে আবার নতুন করে বানানো, সেটা নতুন রিকোয়েস্ট।',
    'marbim.errors.unavailable':
      'এই ফ্যাক্টরিতে MARBIM নেই, তাই আপনার ডকুমেন্ট পড়ার কেউ নেই। কিছু জমা হয়নি — আপনি যা লিখেছেন তা এখানেই আছে।',
    'marbim.errors.nothing_to_read':
      'পড়ার মতো কিছু নেই — টেক্সট পেস্ট করুন, অথবা এমন PDF বা ছবি যুক্ত করুন যা model নিজে পড়তে পারে।',
    'marbim.errors.kind_not_your_desk':
      'এই ধরনের কাগজ অন্য বিভাগের, তাই এখান থেকে ফাইল করা যাবে না। যাঁর ডেস্ক, তিনি বা ওনার এটি পড়াতে পারবেন।',
    'marbim.errors.file_unreadable':
      'MARBIM এই ফাইলটি পড়তে পারেনি। এটি PDF, JPEG, PNG, WebP, Word, Excel ও CSV পড়তে পারে — এগুলোর একটি হলে ফাইলটি হয়তো নষ্ট। অন্য কিছু হলে intake পাতায় লেখাটি পেস্ট করুন।',
    'marbim.errors.token_ceiling':
      'এই ফ্যাক্টরির আজকের model বাজেট শেষ হয়ে গেছে। গত ২৪ ঘণ্টার হিসাব শেষ হলে MARBIM আবার উত্তর দেবে, অথবা owner চাইলে Settings-এ দৈনিক সীমা বাড়াতে পারেন।',
    'marbim.notifications.extraction_succeeded.title':
      'আপনি MARBIM-কে যে ডকুমেন্ট পাঠিয়েছিলেন তা পড়া হয়েছে — অনুমোদনে পাঠানোর আগে কাগজের সাথে মিলিয়ে দেখুন।',
    'marbim.notifications.extraction_succeeded.body':
      'এখনো অন্য কেউ এটি দেখতে পাচ্ছে না। ডকুমেন্টটি আপনার হাতে আছে, অনুমোদনকারীর হাতে নেই। যেটির confidence সবচেয়ে কম, সেটি দুইবার পড়ুন।',
    'marbim.notifications.extraction_rejected.title':
      'আপনি যে ডকুমেন্ট পাঠিয়েছিলেন MARBIM সেটি পড়তে পারেনি, এবং আর চেষ্টা করবে না।',
    'marbim.notifications.extraction_rejected.body':
      'কোনো draft তৈরি হয়নি। হাতে এন্ট্রি করুন, অথবা আরও পরিষ্কার একটি কপি পাঠান।',

    // ── shipment · 8.1 · the packing floor reads these ──
    'shipment.errors.carton_already_loaded': 'এই কার্টন আগেই একটি শিপমেন্টে লোড হয়েছে।',
    'shipment.errors.carton_draft_insert_only':
      'কার্টন ফ্লোরে খোলা ও রি-প্যাক হয় — কিউতে এডিট হয় না। প্যাকিং লিস্ট আর শিপড কোয়ান্টিটি দুটোই এই রো থেকে আসে।',
    'shipment.errors.carton_not_found': 'এই কার্টন আর নেই।',
    'shipment.errors.carton_wrong_order': 'এই কার্টন অন্য অর্ডারের বিপরীতে প্যাক করা হয়েছিল।',
    'shipment.errors.doc_needs_file':
      'ফাইল ছাড়া কোনো ডকুমেন্ট রেডি করা যায় না — বিল অব লেডিং ছাড়া “বিল অব লেডিং রেডি” মানে ব্যাংক কাউন্টারে অসম্পূর্ণ প্রেজেন্টেশন।',
    'shipment.errors.doc_not_on_checklist': 'এই ডকুমেন্ট এই শিপমেন্টের চেকলিস্টে নেই।',
    'shipment.errors.docs_not_ready':
      'চেকলিস্টের কিছু ডকুমেন্ট এখনো বাকি। ব্যাংকে পুরো সেট যায়, নয়তো কিছুই না।',
    'shipment.errors.exp_already_set':
      'এই শিপমেন্টের EXP নম্বর আগেই আছে। ব্যাংক প্রতি শিপমেন্টে একটি দেয়, তাই ভিন্ন নম্বর হয় টাইপো — যার ট্রেইল দরকার — নয়তো অন্য শিপমেন্টের নম্বর।',
    'shipment.errors.invalid': 'এই শিপমেন্ট রেকর্ড যা নেয়, এটি তার সঙ্গে মেলে না।',
    'shipment.errors.lc_not_found': 'এই LC আর নেই।',
    'shipment.errors.no_cartons': 'এই অর্ডারের বিপরীতে এখনো কিছু প্যাক হয়নি।',
    'shipment.errors.no_cartons_loaded': 'এই শিপমেন্টে কোনো কার্টন লোড করা নেই।',
    'shipment.errors.no_checklist':
      'এই শিপমেন্টের ডকুমেন্ট চেকলিস্ট এখনো নেই। আগে LC থেকে সেটি বানান।',
    'shipment.errors.no_doc_kinds':
      'LC-তে কোনো ডকুমেন্ট চাওয়া হয়নি এবং কিছু দেওয়াও হয়নি। খালি চেকলিস্ট মানে এই শিপমেন্ট আর ব্যাংকের মাঝে শুধু EXP নম্বরটাই থাকবে।',
    'shipment.errors.no_lc_on_shipment':
      'এই শিপমেন্টের সঙ্গে কোনো LC যুক্ত নেই, তাই মেলানোর মতো টলারেন্স ব্যান্ডও নেই।',
    'shipment.errors.no_order_styles':
      'এই অর্ডারে কোনো স্টাইল নেই, তাই এর বিপরীতে কিছু প্যাক করা যাবে না।',
    'shipment.errors.nothing_to_waive': 'মওকুফ করার মতো কোনো ফেল করা ফাইনাল ইন্সপেকশন নেই।',
    'shipment.errors.order_not_found': 'এই অর্ডার আর নেই।',
    'shipment.errors.packing_list_has_mismatches':
      'এই লিস্ট বায়ারের গ্রিডের সঙ্গে মেলে না। জেনেশুনে অ্যাপ্রুভ করা যায়, না জেনে নয়।',
    'shipment.errors.packing_list_not_found': 'এই প্যাকিং লিস্ট আর নেই।',
    'shipment.errors.packing_list_stale':
      'এই লিস্ট তৈরির পর কার্টন বদলেছে। লক করার আগে আবার তৈরি করুন — নইলে বাক্সের সঙ্গে না মেলা একটি লিস্ট লক করবেন।',
    'shipment.errors.shipment_already_departed':
      'এই মাল ইতিমধ্যে ex-factory হয়ে গেছে। যা গেছে সেটাই ম্যানিফেস্ট, এখন যোগ করলে জমা দেওয়া ডকুমেন্ট বদলে যাবে।',
    'shipment.errors.shipment_not_found': 'এই শিপমেন্ট আর নেই।',
    'shipment.errors.tolerance_not_breached':
      'শিপড কোয়ান্টিটি LC-র টলারেন্সের ভেতরেই আছে, তাই ওভাররাইড করার কিছু নেই।',
    'shipment.errors.waiver_needs_commercial':
      'শুধু কমার্শিয়াল বা ওনার এটি মওকুফ করতে পারেন — ফেল করা ফাইনাল ইন্সপেকশন, বা শিপমেন্টের তারিখ নিতে না পারা LC।',
    'shipment.errors.waiver_needs_reason':
      'মওকুফের জন্য কারণ লেখা দরকার — পরে অডিটরের কাছে এটাই একমাত্র যুক্তি।',
    'store.errors.adjustment_below_zero': 'এই সমন্বয়ে স্টক শূন্যের নিচে চলে যাবে।',
    'store.errors.bom_item_unknown': 'এই আইটেমটি স্টাইলের BOM-এ নেই।',
    'store.errors.bonded_requires_ud':
      'বন্ডেড মাল UD ছাড়া ইস্যু করা যাবে না। UD ছাড়া ইস্যু করলে সেটা কাগজের ছোট ভুল নয়, কাস্টমসের ঝুঁকি।',
    'store.errors.exceeds_requisition': 'রিকুইজিশনে যা চাওয়া হয়েছে তার চেয়ে এটি বেশি।',
    'store.errors.nothing_to_return': 'ফেরত দেওয়ার জন্য কোনো রোল বাছা হয়নি।',
    'store.errors.return_needs_reason':
      'ফেরতের কারণ লিখতে হবে। এতে মাল স্টোরে ফিরে আসে আর UD থেকে যা টানা হয়েছিল তা ফেরত যায় — কারণটাই রেকর্ডের মূল কথা।',
    'store.errors.item_uom_locked':
      'এই আইটেমের স্টক আগের এককেই রাখা আছে। এখন একক বদলালে আগে লেখা প্রতিটি পরিমাণের মানে চুপচাপ বদলে যাবে।',
    'store.errors.location_kind_locked':
      'লোকেশন তৈরি হয়ে গেলে তার ধরন আর বদলানো যায় না। এখানে থাকা রোলগুলো বর্তমান কাস্টমস স্ট্যাটাসেই এসেছে; ধরন বদলালে সেগুলো পরে গিয়ে অন্য শ্রেণিতে পড়ে যাবে।',
    'store.errors.grn_not_found': 'এই GRN-টি আর নেই।',
    'store.errors.item_not_found': 'এই আইটেমটি স্টোরে নেই।',
    'store.errors.item_not_requisitioned':
      'যে রিকুইজিশনের বিপরীতে ইস্যু হচ্ছে, তাতে এই আইটেমটি নেই।',
    'store.errors.requisition_has_no_lines': 'এই রিকুইজিশনে কোনো লাইন নেই।',
    'store.errors.roll_item_mismatch': 'এই roll যে আইটেমের, ইস্যু হচ্ছে অন্য আইটেম।',
    'store.errors.roll_not_found': 'এই roll-টি আর নেই।',
    'store.errors.roll_not_in_stock': 'এই roll স্টকে নেই।',
    'store.errors.unit_mismatch':
      'এই আইটেমটি যে ইউনিটে রাখা আছে, দেওয়া ইউনিট তার সাথে মিলছে না।',

    // ── 10.1 Workforce · what a refused import says ──
    'workforce.errors.unknown_employees':
      'এক্সপোর্ট ফাইলে এমন কর্মী আছেন যারা রেজিস্টারে নেই — কিছুই ইমপোর্ট হয়নি। অর্ধেক ফ্লোরের হাজিরা চুপচাপ ঢুকে গেলে বাকি অর্ধেকের বেতন কম হয়ে যায়, তা ধরা পড়ে বেতনের দিনে।',

    // ── 9.1 Maintenance · what a refused action says ──
    'maintenance.errors.serial_exists':
      'এই সিরিয়ালের মেশিন আগেই নিবন্ধিত আছে। দুটি সারি হলে সার্ভিস ইতিহাস ভাগ হয়ে যায় — যোগ করার আগে রেজিস্ট্রি দেখে নিন।',
    'maintenance.errors.machine_not_found': 'এই মেশিনটি আর রেজিস্ট্রিতে নেই।',
    'maintenance.errors.line_not_found': 'এই লাইনটি আর নেই।',
    'maintenance.errors.schedule_not_found': 'এই রক্ষণাবেক্ষণ সূচিটি আর নেই।',
    'maintenance.errors.schedule_type_mismatch':
      'এই চেকলিস্ট অন্য ধরনের মেশিনের। এখানে সই করলে যে সার্ভিস হয়নি তা রেকর্ড হয়ে যাবে।',
  },
}

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Render a key.
 *
 * Substitution is a SINGLE pass over the template, so a parameter whose value happens to
 * contain `{something}` is inserted literally rather than substituted again. A machine
 * serial or a note pasted from elsewhere can contain anything, and a second pass would let
 * one parameter reach into another.
 */
export function t(
  locale: Locale,
  key: string,
  params: Readonly<Record<string, unknown>> = {},
  catalogue: Catalogue = MESSAGES,
): string {
  const template = catalogue[locale]?.[key] ?? catalogue[DEFAULT_LOCALE]?.[key]

  // Not an empty string: an empty subject reads as a broken mail server, and the key reads
  // as what it is.
  if (template === undefined) return key

  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    // `undefined` means the caller did not supply it. Leaving the placeholder visible keeps
    // that a developer's bug rather than making it the reader's problem.
    if (value === undefined || value === null) return whole
    return String(value)
  })
}

/** A user's locale, or the default. Anything unsupported is the default, never a crash. */
export function resolveLocale(locale: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(locale ?? '') ? (locale as Locale) : DEFAULT_LOCALE
}

/**
 * Which of these keys the catalogue does not define.
 *
 * Used by the delivery job to REPORT a gap rather than quietly mailing somebody a dotted
 * key. A message that goes out wrong is a problem twice: once when it is read, and again
 * because nobody knew it happened.
 */
export function missingKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].filter((key) => MESSAGES[DEFAULT_LOCALE][key] === undefined).sort()
}
