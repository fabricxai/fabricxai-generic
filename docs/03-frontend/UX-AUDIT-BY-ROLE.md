# What each person actually experiences, and what to do about it

A walk through the product from inside each department's permissions — what a person
sees when they sign in, what they can and cannot touch, where the screens help and where
they quietly waste somebody's morning. Then a design for the thing you asked for: drop a
file into the sidebar without saying what it is, and have MARBIM work it out, fill the
form, and put it in front of the right person to approve.

Written in plain language on purpose. The audience is whoever decides what gets built
next, not only whoever writes it.

Everything below was read from the code — the navigation registry that decides who sees
what, the server actions each screen calls, the state machines, and the intake
definitions. Where I say something is missing, I mean I looked for it and it is not
there.

---

## Part 1 · The shape everybody shares

### Signing in

Three screens, no surprises: sign up, confirm your email, sign in. Email confirmation is
required, so an account that never receives the mail exists and cannot be used — worth
knowing because it looks identical to a wrong password from the user's side.

There is no admin tool for creating a factory. The first owner signs up through the same
form everyone else uses, and that one path creates the company and the owner's role
together. This is a good decision: one code path for creating a factory is one code path
that gets exercised.

### What you see once you are in

Your roles decide your entire sidebar. A module you have no access to is **hidden**, not
greyed out — which is right, because a link you can see and cannot use still tells you
the module exists. A module you can open but not change shows a read-only banner before
you type anything, rather than letting you fill in a form and then refusing it.

That much is genuinely well done and unusually disciplined.

**But where you land after signing in is not.** Owner, admin and merchandiser go to
"Your work" — a composed queue of drafts waiting on them, exceptions, and desk queues.
Everybody else is sent to the first screen in their own sidebar, and because the sidebar
is ordered with the approve inbox near the top, **a storekeeper signing in lands on an
approval inbox that is usually empty.** Not their receiving screen. Not anything they
were about to do. The code comment says the intent was that "a storekeeper is not greeted
by an office feed", and that is exactly what happens anyway.

> **Fix:** give every role a landing screen chosen for that role, not inherited from
> sidebar order. A storekeeper should land on receiving, a cutting supervisor on the lay
> screen, a line supervisor on hourly entry. This is a small change with a
> disproportionate effect — it is the first thing every person sees, every day.

### "Your work" only exists for the office

The composed queue — what needs you, why, and how long it has waited — is built for
merchandiser, owner and admin. Everyone else has no such screen at all. A storekeeper
who wants to know whether anything is waiting on them has to remember which of their
four screens to check, and check each one.

> **Fix:** the machinery is already there and is not module-specific. It reads drafts
> routed to your roles, exceptions, and alerts. Giving a storekeeper a version showing
> requisitions waiting to be issued, GRNs awaiting inspection and UD balances running low
> is mostly a matter of choosing which existing queries to compose.

### The approval inbox

Everything the system is unsure about lands in one place. Ten roles can approve; a draft
is routed only to the roles that may decide it, so the inbox is not a firehose. Drafts
age, and there is a nightly escalation for ones nobody has touched.

Two real problems live here.

**You can approve your own draft.** The code that checks approvals looks at your *role*
and counts distinct approvers; it never compares the approver to the person who raised
it. Where a rule demands two approvals it does correctly insist on two different people.
But the ordinary single-approval case lets one person write and sign the same change.
This is written down as a known open question rather than a bug, because the main intake
path is "whoever uploaded the PO reviews the extraction and signs it" — and a blanket ban
would break it. It still needs deciding, and money-shaped targets are the obvious place
to start requiring somebody else.

**Nobody can configure who approves what.** The function that sets approval rules has no
caller anywhere in the application. Rules can only be created by seeding the database or
by editing it by hand. A factory that wants "adjustments over 50,000 taka need the owner"
cannot express that without a developer.

> **Fix:** an approval-rules screen under settings is the single highest-value missing
> screen in the product. Everything else in the approval system is built and working; it
> is governed by a table no one can reach.

### Refusals

There is a `/refused` screen for floor roles showing what the system said no to and why.
This is a genuinely good pattern that most products lack, and it should be extended — it
is currently visible to seven roles, and every role that can be refused should have it.

---

## Part 2 · Department by department

### Merchandising — the busiest desk

**Sees:** buyers, RFQs, orders, sampling, costing, planning, shipment, memory, approve,
"Your work". **Can change:** all of those.

A merchandiser adds a lead, walks it through contacted → sampling talk → negotiation →
won, checks for duplicates, converts it to a buyer and sets terms. Then an RFQ: quote,
re-quote as the buyer pushes back, clarify, win or lose. A won RFQ becomes an order with
a colour-and-size breakdown and a generated time-and-action calendar.

The best-designed interaction in the product is here: before you mark a milestone as
actually happened, you can preview the ripple — every downstream date the change would
move. That is exactly the right shape for a decision whose consequences are not obvious.

**Where it hurts.** This is the widest permission set in the system and the sidebar
treats every entry as equal weight. A merchandiser's day is orders and samples; buyers
and RFQs are periodic; costing is occasional. Nothing reflects that.

Sample stages have to be moved by hand, one at a time, and the buyer's verdict is
recorded separately from the dispatch. In practice a merchandiser learns a sample was
approved by email and then does two or three screen actions to make the system agree.

> **Improve:** let the ripple preview be reachable from the order list, not only from
> inside a milestone. Collapse "dispatched → feedback → verdict" into one step where the
> verdict is recorded with its evidence. And let the buyer's email itself be the input —
> which is what Part 3 is about.

### Costing

**Sees and changes:** merchandiser, commercial, finance.

Preview a sheet, save it as a draft, approve it against a margin floor, and it becomes
the version quotes reference. A new version supersedes rather than edits, so a quote you
sent stays reconstructible. The bill of materials sits under it and feeds requisitions.

**Where it hurts.** The margin floor is policy, and policy is invisible on the screen.
Someone building a sheet does not see how close to the floor they are until they try to
approve. There is no comparison against what this style cost last season, though the data
to do it exists.

> **Improve:** show the floor as a live line on the sheet while it is being built, and
> put last season's actual against each row.

### Sampling

**Sees:** merchandiser, quality, production. **Can change:** merchandiser only.

Request → in work → dispatched → feedback → approved or rejected. Any stage can be closed
outright, which is right: a buyer who walks away should not force somebody to fake a
dispatch.

The important thing this screen carries is the pre-production approval that unblocks
cutting. Alerts about samples about to block cutting appear on "Your work".

**Where it hurts.** Quality and production can see samples and change nothing, but they
are the people who most often *know* something changed. A QC manager who has the buyer's
approval in hand has to find a merchandiser to type it in.

> **Improve:** let quality record a verdict with evidence as a draft that a merchandiser
> approves. This is precisely what the draft-and-approve machinery exists for, and it is
> not being used for the case that needs it most.

### Commercial — letters of credit, back-to-back, UD

**Sees and changes:** commercial, finance. UD is also open to store and compliance.

Create an LC, link it to orders, record amendments. A latest-shipment or expiry conflict
becomes a red alert on every screen that touches the order — good, and the kind of thing
that gets missed on paper. Back-to-back credit is checked against a percentage of the
master LC.

The UD is the sharpest part of the product. Before any bonded material moves, the draw is
checked; overdrawing is a hard block with a recorded override, because it is legal
exposure rather than an inconvenience. A UD can be exhausted (nothing left) and then
expire (time ran out), and the record says which.

**Where it hurts.** This is the most consequential department and the least forgiving
screen. The UD balance is a number you go and look at rather than something that follows
you. The store issues against a UD but only sees the refusal at the moment of issuing.

> **Improve:** put remaining UD balance and days-to-expiry in the shell for anyone whose
> work touches bonded stock, the way the LC conflict alert already travels. Warn at a
> threshold rather than only blocking at zero — a storekeeper who knows on Tuesday that a
> UD runs out Thursday can do something about it.

### Bank documents and finance

**Sees and changes:** commercial, finance.

Preparing → submitted → accepted or discrepant → realized. Discrepancies can bounce back
for resubmission and escalate after a set number of days. Realization is terminal; a
correction is a new document rather than a status moved backwards.

Finance raises invoices and payment requests against receivables and payables that both
allow a partial step and both end terminal.

**Where it hurts.** The discrepancy path is where money actually gets stuck, and it is
modelled as a status rather than as work. There is no view of "everything currently
discrepant, how long, and whose turn it is".

> **Improve:** a discrepancy queue with age and owner. The state machine already supports
> it; nothing surfaces it.

### Procurement

**Sees and changes:** procurement, commercial, store.

Supplier, requisition from the bill of materials, quotes, comparison, purchase order,
then confirmed → in production → shipped → received. Over-receipt tolerance is enforced.
There is a supplier scorecard for on-time, quality and price, and it feeds back into the
comparison — so last season's late supplier is visible while this season's quote is being
read. That is a nice piece of design.

**Where it hurts.** Quotes are typed in. A supplier emails a PDF and somebody re-keys it,
which is both the slowest step and the one where a wrong unit price enters the system.
This was attempted as a document intake and removed, for a good reason covered in Part 3.

### Store

**Sees:** store, procurement, production. **Can change:** store only.

Receive against a purchase order, record rolls with shade lots, take the fabric
inspection result, raise requisitions, issue stock. Bonded issues check the UD and refuse
an overdraw with an explanation. Stock corrections are drafts somebody else approves —
which is the whole reason the count is trustworthy.

This is the most complete floor module, and it is the only one whose screens read Bangla.

**Where it hurts.** Everything works and nothing anticipates. A requisition arrives with
no indication of whether the stock exists; the storekeeper finds out by trying to issue.
Roll-level entry is thorough and slow, and on a delivery bay with twenty rolls the
thoroughness is the problem.

> **Improve:** show availability on the requisition before the issue is attempted. Allow
> roll entry by exception — enter the common case once, correct the rolls that differ.

### Planning

**Sees:** planner, production, merchandiser. **Can change:** planner, merchandiser.

Record standard minute values, allocate orders to line-days, move allocations. Scenarios
can be forked, compared and proposed — and applying a scenario goes through approval,
because a whole-plan swap is the largest single write in the system.

**Where it hurts.** The comparison is the valuable part and it is buried behind forking.
Most replanning is a small change under time pressure, and the safe path is the long one.

> **Improve:** make "what would this move break" available on a single drag, not only on
> a forked scenario.

### Cutting

**Sees:** cutting, production, planner. **Can change:** cutting, production.

Checks pre-production approval before anything else — no approved sample, no cutting.
Then marker, lay, cut report, bundles, and bundle scanning through to sewing. Wastage is
computed against tolerance. A cut report correction is a proposal, not an edit, so the
original number stays in the audit trail.

**Where it hurts.** **Cutting cannot approve anything** — the role is not among the ten
that can use the approve inbox. So a cutting supervisor can raise a correction and has no
way to see what happened to it. They can see `/refused`, which covers refusals, but not
the ordinary "waiting" state.

> **Improve:** either give cutting the inbox in a read-only form, or show the fate of
> drafts you raised on the screen you raised them from. Somebody who proposes a
> correction should not have to ask whether it went through.

### Sewing lines

**Sees:** production, planner, quality. **Can change:** production.

Plan the line day, record hourly output, open and close downtime with a reason at the
moment it happens, record the endline count, close the day. Efficiency is earned minutes
over available minutes.

**Where it hurts.** Hourly entry is the highest-frequency interaction in the entire
product — every line, every hour, all day — and it is a form. The screen is in English on
a floor where the people using it may not read it.

> **Improve:** this screen deserves more design attention than any other in the system on
> volume alone. Large targets, the previous hour visible for comparison, running
> efficiency, and Bangla.

### Quality

**Sees and changes:** quality, production.

Four inspections on four screens: fabric by the four-point system, inline defects
producing DHU, measurements against tolerance, and final inspection where the AQL plan is
previewed before anybody starts counting — so sample size and accept number are fixed in
advance. That ordering is correct and worth protecting.

**Where it hurts.** The four screens do not know about each other. A style with a bad
fabric inspection, climbing inline DHU and a tight measurement tolerance is a style about
to fail final, and nothing says so.

> **Improve:** a per-order quality picture that puts the four signals together, and warns
> before the final inspection rather than reporting after it.

### Maintenance

**Sees:** maintenance, production. **Can change:** both.

Report a machine, claim the ticket, resolve it with parts coming off spares stock in the
same transaction, or cancel with a required reason. Downtime cost is computed from line
value per minute. Preventive maintenance has schedules and a checklist that cannot be
empty — because a PM record with nothing ticked is a signature on nothing.

**Where it hurts.** The line supervisor who reports the machine is the person waiting on
it and is not told anything after reporting. Maintenance is also not among the roles that
can approve, so anything it drafts is invisible to it afterwards.

### Shipment

**Sees and changes:** shipment, commercial, merchandiser.

Open the shipment, load cartons, generate and then lock the packing list, record the EXP
number — mandatory before the bank — build and tick the document checklist, send to the
bank, confirm departure. Quantity outside LC tolerance and shipping past the LC latest
date are both explicit, overridable against a name, and recorded.

This is the best-gated flow in the product.

**Where it hurts.** The gates are discovered in sequence, at the end, under time
pressure. Every one of them is knowable days earlier.

> **Improve:** a readiness view per shipment from the moment it opens — EXP present,
> quantity against tolerance, LC dates, documents outstanding — so the gates are a
> countdown rather than an ambush at the door.

### HR and payroll

**Sees and changes:** HR only, plus owner.

Import attendance, record and activate the wage gazette, run payroll, approve the run.
Overtime is twice the basic hourly rate. Reads are audited. Before go-live there is a
parallel run against the factory's own sheet where every difference must be zero or
explained.

**Where it hurts.** Payroll is one long action with a single approval at the end. The
approver is asked to sign a whole month having seen a summary.

> **Improve:** surface exceptions before the approval — everyone whose pay moved more than
> a threshold against last month, everyone with impossible attendance, everyone new. Sign
> the exceptions, not the total.

### Compliance

**Sees and changes:** compliance only.

Log an audit, raise corrective actions, progress them, attach evidence, close — and only
a declared closer role may close. Certificates warn ahead of expiry on a schedule.

**Where it hurts.** Compliance is the most isolated department in the product: one role,
one screen, no overlap. Corrective actions almost always require somebody else to
actually do something, and there is no way to assign that person anything.

> **Improve:** let a corrective action carry an owner in another department and appear in
> that person's work queue.

### Owner and admin

**Sees:** everything.

Dashboard with exceptions, a wall board, the refused list, and settings — company
profile, granting and revoking roles, module policy, and the audit trail. Policy is the
real lever: confidence floors, margin floors, tolerances, aging windows. Change a number
here and what the whole factory is allowed to do changes.

**Where it hurts.** Policy is presented as settings rather than as consequence. Nothing
says which gate a number controls or what changing it will permit. And as noted above,
the one policy that governs approval routing cannot be edited at all.

---

## Part 3 · The problems that repeat

Five things showed up in almost every department.

**One. Refusals arrive late.** Almost every gate is checked at the moment of the write —
UD balance at issue, PP approval at cutting, EXP at bank submission, tolerance at packing.
Each is correct and each is discoverable earlier. The single biggest improvement
available across the product is moving gate state *forward* in time: show it as a
condition of the work, not as a verdict on the attempt.

**Two. Read-only roles are dead ends.** Several roles can see a module and change nothing
— quality on sampling, production on store, planner on cutting. These are usually the
people who first learn that something changed. The draft-and-approve machinery is built
precisely for "someone who knows proposes, someone who owns approves", and it is barely
used for this.

**Three. You cannot see what happened to what you raised.** Three roles that can create
drafts — cutting, shipment, maintenance — cannot open the approve inbox at all.

**Four. The floor mostly reads English.** Bangla covers receiving and the route
boundaries. The other eleven floor screens do not, including hourly output entry, which is
touched more than any other screen in the system.

**Five. MARBIM does not work.** No model provider is registered, so every AI answer
hard-fails and uploaded documents accumulate unprocessed while the job health check
reports green. Anyone evaluating the product today should be told the copilot is off
rather than left to discover it.

---

## Part 4 · Drop a file in, get a draft out

This is the thing you asked for: put any document into the sidebar without saying what it
is, have MARBIM work out what it is, fill in the form, and put it in front of whoever
should approve it.

### What happens today

There is an intake screen. You choose from six kinds of document — a buyer's purchase
order, a UD, a tech pack, a wage gazette, a compliance audit report, a measurement chart
— then upload, and for some kinds answer one question the paper cannot answer, such as
which buyer sent it. Extraction runs, produces a draft with confidence recorded per
field, and the draft lands in the approve inbox.

The classifier you are asking for was **deliberately left out**, and the reason is written
down in the code: a tech pack filed as a buyer purchase order puts a wrong draft in
somebody's approve inbox, where it looks exactly like a right one. The argument is that
what makes extraction safe is the draft-and-approve loop, not the classifier, and that a
guess is worse than a question.

That argument is sound and I do not think it blocks what you want. It blocks one specific
design — a classifier whose guess is invisible. What follows is a design where the guess
is always visible, always cheap to correct, and never the thing that decides whether a
person looks at the document.

### The design

**A drop target that is always there.** "Add a file" lives in the sidebar, on every
screen, for every role. You can also drag a file onto any window. You are never asked
what it is.

**Immediately, before anything is understood:** the file is stored and attached to your
name, and you see it in a short list — "reading this now" — with a spinner. Nothing is
ever silently swallowed. This matters because it is the failure mode of every
drop-anything feature: the user lets go of the file and does not know whether anything
happened.

**Then MARBIM reads it and says what it thinks it is,** with a confidence that comes from
an actual measurement rather than a constant, because the codebase forbids invented
confidence and is right to.

From there, three paths.

**When it is confident** — say it is clearly a buyer's purchase order — extraction runs
and the draft goes to the approve inbox of the department that owns it. A purchase order
goes to merchandising. A wage gazette goes to HR. A UD goes to commercial. That routing
already exists: approval rules route drafts by role, so classification only has to choose
the module and the existing machinery does the rest.

The draft in the inbox says, in words, **"MARBIM read this as a buyer's purchase order"**
with the confidence, the document on screen next to the extracted fields, and a control
that says **"this is actually a…"**. Correcting the guess re-runs extraction against the
right schema rather than throwing the upload away. That control is the answer to the
objection: the wrong draft does not look exactly like a right one, because every
classified draft says what it was classified as and offers to be wrong.

**When it is not confident,** the file goes to a short "needs a moment" tray and asks the
smallest possible question — usually a choice between the two kinds it is torn between,
which is a much easier question than the six-way one the intake screen asks today. The
question goes to the uploader if they are one of the relevant roles, and to the department
otherwise.

**When it cannot tell at all,** the file becomes an ordinary attachment with a note
saying MARBIM could not read it, visible to the uploader. Not an error, not a silence.

**Some documents need one thing the paper does not contain.** A buyer's purchase order
names the buyer in words; the system files buyers under an id the paper has never heard
of. Today the intake screen asks up front. In the new flow it should not — MARBIM should
extract the buyer's *name*, match it against known buyers, and put its match in the draft
for confirmation: "this is Meghna Knit Composite Ltd — the buyer we already trade with?"
The person approving is the person best placed to answer, and they are already looking at
the document.

This is worth doing carefully because it unlocks two document types that were removed
from intake for exactly this reason — supplier quotes and buyer terms. Both were dropped
because their forms demand ids and no document contains an id. Resolving names to ids at
the moment of approval is recorded in the code as the real fix, and it is the same
mechanism this design needs anyway. Supplier quotes are the single most valuable document
to automate: they are the slowest step in procurement and the one where a mistyped unit
price does the most damage.

### The rules this must not break

**A classified draft never auto-approves.** The system already allows a draft to skip a
human when every field clears a confidence floor. A draft whose *document type* was
guessed must not be eligible for that, no matter how confident the fields are — high
confidence in the wrong form is exactly the failure the original objection describes.

**Two confidences, both shown.** How sure MARBIM is about what the document *is* and how
sure it is about each *field* are different questions. A crisp scan of the wrong form
scores high on the second and low on the first.

**Routing errors must be one click to fix, not a rejection.** If a document lands with the
wrong department, that department should be able to send it to the right one. Rejecting it
throws away the upload and the extraction and tells the uploader their document was
refused, which is both wrong and discouraging.

**Nothing about who approves changes.** Classification chooses the module; the module's
approval rule chooses the people; the inbox filters to what you may actually decide. That
chain is already built and tested.

### What this needs

Most of the parts exist. The documents table already carries the module, the kind and the
row a file belongs to, with a comment saying the module is "set by the classifier" — the
column was designed for this and nothing writes it. The upload path, the extraction jobs,
per-field confidence, the pending-changes loop and the routing are all built.

What is genuinely new is: the classifier itself; the small tray for low-confidence files;
the "this is actually a…" correction; and name-to-id resolution at approval time.

And before any of it can be demonstrated, **a model provider has to be registered**, since
none is today.

---

## Part 5 · What I would build, in order

**First, the things that cost little and are felt daily.**
Land each role on a screen chosen for that role. Give the floor roles a "your work" view.
Show the fate of a draft on the screen where it was raised. Translate the hourly output
screen.

**Second, the one missing screen.** Approval rules in settings. Everything else about
approvals works and is governed by a table nobody can reach.

**Third, move the gates forward.** UD balance travelling in the shell for anyone touching
bonded stock; shipment readiness from the day the shipment opens; margin floor live on the
cost sheet; stock availability on the requisition. This is the change with the broadest
effect on how the product feels, because it converts refusals into information.

**Fourth, the drop-anything intake**, in this order: a provider registered so MARBIM works
at all; classification with a visible guess and a correction control; the low-confidence
tray; then name-to-id resolution, which brings supplier quotes with it.

**Fifth, let the people who know propose.** Quality recording a sample verdict, production
proposing a stock correction, maintenance closing its own loop. The machinery is there;
the screens do not offer it.

---

## A note on what I did not check

I read the navigation registry, the server actions, the state machines, the intake
definitions and the screen composition. I did not sit with anybody using this, and every
recommendation above is an inference from structure rather than an observation of
behaviour. The parts I am most confident about are the ones that are structural — where a
role lands, what it can reach, whether it can see the outcome of its own action. The parts
about how a screen *feels* to use want somebody watching a storekeeper for an afternoon,
and that afternoon would change some of this.
