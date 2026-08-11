# Runbook · changing the UI while you test it

For the loop where you click through a screen, dislike something, change it, and see the
change a second later — then ship it to the factory when it is right.

Bringing the stack up is [`local.md`](./local.md). This file is what to do once it is up.

---

## 1 · The loop

| | |
|---|---|
| App | http://localhost:3000 |
| Every email the app sends | http://localhost:8025 (Mailpit) |
| Logins | `<role>@barakah.test` / `<role>@testtextile.test` |
| Password | the shared one from `seed-day0 --password=…` |

Edit a `.tsx` file → save → the browser updates on its own. No restart, no rebuild. Two
exceptions, both of which need `pnpm dev` restarted:

- `src/app/theme.css` sometimes needs a hard refresh (Ctrl+Shift+R) rather than a restart
- anything in `src/lib/env.ts`, `next.config.ts`, or a new environment variable

**The worker is not optional.** Approvals route, events fire and outcomes compile in
`pnpm worker:dev`. Without it a screen looks fine and nothing happens behind it.

### Which tenant to click through

Two seeded factories are on your machine, and which one you pick decides what you are
looking at:

| Tenant | Logins | Use it for |
|---|---|---|
| **Barakah Fashions Ltd** | `…@barakah.test` | screens **with data** — orders, GRNs, inspections, a frozen waterfall |
| **Test Textile Ltd** | `…@testtextile.test` | **empty states** — the first thing a new factory ever sees |

Empty states are the half that never gets looked at, and the half a new customer meets first.
Both matter.

Reset either at any time — both commands are idempotent:

```bash
pnpm tsx scripts/seed-day0.ts --reset-passwords --password=<shared>
pnpm tsx scripts/seed-day0.ts --name="Test Textile Ltd" --slug=test-textile \
  --domain=testtextile.test --reset-passwords --password=<shared>
```

---

## 2 · Where the UI actually lives

```
src/app/theme.css              107 design tokens — colour, spacing, radius, type
src/components/fx/             the shared vocabulary; change here = change everywhere
  primitives.tsx               Button, Badge, Card
  forms.tsx                    TextInput, Select, DateInput, Checkbox …
  feedback.tsx                 Modal, InlineAlert, EmptyState, LockedState
  data.tsx  figures.tsx        tables, numbers, charts
  signature.tsx                StatusLabel and the selvage
src/components/shell/          sidebar, top bar, page header, toasts
src/app/(app)/<module>/        one folder per screen — page.tsx + its client components
```

**Change `components/fx` to fix something in twenty places. Change `app/(app)/<module>` to
fix it in one.** Most "this box is too small" complaints belong in the first.

---

## 3 · Four rules that will reject your change

Not style advice — these fail `pnpm lint` or `pnpm test`, and CI will not publish.

1. **Colours and spacing come from tokens.** `var(--fx-bg-surface)`, never `#fff`. A test
   reads every `var(--fx-…)` in the codebase and fails on one that does not exist in
   `theme.css` — a misspelt custom property is silently dropped by CSS and produces
   invisible text, which is how the wall board once shipped unreadable.
2. **No hardcoded user-facing strings.** Use `t('ui.orders.something')` and add the key to
   **both** `en` and `bn` in `src/lib/i18n-ui.ts`. A missing Bangla key fails the build —
   that is what makes "the floor reads Bangla" a property rather than an intention.
3. **Money is a string, never a number.** `parseFloat`/`Number()` on an amount is
   lint-banned. Render what the server sent.
4. **Screens don't decide anything.** No permission checks, no gate logic, no arithmetic
   that matters in a component. The server decides and the screen shows the answer. A
   check in the browser is a suggestion.

---

## 4 · Before you push

```bash
pnpm lint          # includes the custom rules above
pnpm test          # ~1,100 unit tests, ~6s
pnpm test:browser  # component tests in jsdom
pnpm build         # catches what dev mode forgives
```

Add `pnpm test:e2e` if you touched one of the five floor screens — it runs axe-core for
accessibility, and a contrast failure on a factory tablet is a real defect.

If you changed a shared component, run `pnpm test:browser` even when it "obviously" works.
The date field's whole reason for existing is a bug that looked fine on screen.

---

## 5 · Shipping it to the factory

```bash
git add -A && git commit -m "fix(ui): …"
git push                       # CI tests and publishes the image; deploys nothing
git tag v1.0.2 && git push origin v1.0.2   # this is what reaches Barakah
```

Deploying is a **tag**, never a merge — so pushing work in progress is safe. Rollback is
**Actions → deploy → Run workflow** with an older commit SHA.

⚠ **Compose-file changes do not deploy.** `/opt/fabricxai/docker-compose.prod.yml` on the
VPS is a hand-maintained copy and the workflow only rewrites its `IMAGE=` line. Changing
`docker-compose.prod.yml` in the repo changes nothing on the server until somebody applies
it by hand.

---

## 6 · Cursor and Claude Code together

They edit the same files on the same disk. Neither knows what the other is doing, so **git
is the boundary between them**, and the only real rule is: *don't have both working on the
same file at the same time.* Finish a thought in one, then switch.

What each is good for here:

| | |
|---|---|
| **Cursor** | tight visual iteration — you can see the screen, you know what you want, the change is in one or two files. Padding, wording, layout, a colour, moving a button. |
| **Claude Code** | anything that spans files or needs to be *proved*: a new screen wired to an action, a change across twenty components, adding the i18n keys and the tests, running the suites, and shipping it through CI and the tag. |

A practical division that works: **click through the app, note what is wrong, fix the
one-file things in Cursor as you go.** When you hit something that needs a server action, a
new i18n key pair, a state machine, or "change this everywhere" — hand it over.

Two things worth knowing:

- **Tell Claude Code what Cursor changed.** It reads files fresh, but it will not notice an
  uncommitted edit unless it looks. `git diff` is the fastest way to hand over.
- **Commit before switching.** Not to push — just so the other tool's work has a floor to
  stand on, and so a bad edit is one `git checkout` away from gone.

`CLAUDE.md` at the repo root is the architecture contract both should obey. If a suggestion
from either tool contradicts it — an action touching `db` directly, a component deciding a
permission — the contract wins. It is what the tests enforce.
