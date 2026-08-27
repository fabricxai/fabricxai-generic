# Merchandiser Workspace — the design canvas

Published as an Artifact on 22 Aug 2026:
<https://claude.ai/code/artifact/b21657d4-5145-463c-85cc-1205f38d9cac>

The source is here because it was nowhere. The canvas was designed, published, and then
**nothing in `src/` was built from it** — a fact only discovered when somebody asked to see
it again five days later. A design that lives only behind a URL is a design the build
cannot be checked against, so the artboards are checked in beside the twenty-seven older
canvases and this file records what has actually been implemented.

`canvas.json` holds the page/artboard layout and the annotations; each `*.dc.html` is one
artboard. Open the artifact to see them laid out; read the files to see what they say.

## The five pages

| Page | What it is | Status |
| --- | --- | --- |
| 1 · Merchandiser flow | The day, left to right: the week, the order, its papers, sampling, MARBIM | **being built** |
| 2 · Time and action options | Three ways to show the TNA — table (A), timeline (B), drawer (C) | A shipped; B and C undecided |
| 3 · Proposed additions | Morning digest, enquiry→quote, inputs matrix, chasing queue, buyer pack, drops/colours, shortcuts | proposals — *nothing here is decided* |
| 4 · From their own papers | Order memory, fabric leg, ship dates, sample requisition, ratio packs, capacity, agents | proposals |
| 5 · Oversight and plumbing | Owner's book, alerts, buyer scorecard, mail intake, print sheet | proposals |

Pages 3–5 are labelled in the canvas itself as things "to be argued with". They are not a
backlog and building one without a decision would be inventing product.

## What is implemented, and where

| Artboard | Screen | State |
| --- | --- | --- |
| `Main.dc.html` — Your week | `/orders` | book value, shipping month, at-risk and LC-conflict tiles; the week strip; the Ask MARBIM openings; the LC column |
| `OrderDetail.dc.html` — Order PO-88203 | `/orders/[orderId]` | facts, TNA with ripple preview, size breakdown, revision history, **LC card** |
| `TnaTimeline` / `TnaDrawer` (option B / C) | — | not built; option A (the table) is what shipped, with click-to-actualise and a ripple preview the canvas only implies |
| `OrderDossier.dc.html` — Style & documents | `/orders/[orderId]?tab=documents` | style identity, colourways and size run off the grid, the BOM from costing, the measurement chart with the last check, the order's papers. **Not built:** the department sign-off panel — see STUBS |
| `Sampling.dc.html` — Sampling room | `/sampling` | already matched before this pass — the PP section with "N styles cleared", per-round comments, "gates cutting on ⟨PO⟩ →", "the rest of the room", the library link. **Missing:** the canvas frames a due date in the past as "2 d overdue"; the screen prints the date and leaves the arithmetic to the reader |
| `MarbimDraft.dc.html` — mail → draft → verify | `/orders/[orderId]` → "Paste the buyer's mail" | the door exists: `buyer_amendment` intake, this order's style pre-picked, draft to the approve inbox. **Not built:** the canvas's "Verify & apply", which is self-approval on a ⚖ table — see STUBS |
| `MainBn.dc.html` — Your week in Bangla | `/orders` | the en/bn toggle carries the screen; the copy added for it is in both catalogues |

Anything in the right-hand column that is not a screen path is owed, and owed things live
in `docs/STUBS.md` where they can be counted.
