/**
 * Module registration for 4.1 ⚖
 *
 * `allocations` is a pending target, but only through the scenario-apply handler: the
 * generic single-row write cannot express applying a plan, which replaces a set of rows
 * and flips the scenario's status in one transaction, and which must re-run the overload
 * check against the board as it is at approve time.
 *
 * `smv_records` is a target because reading a standard minute value off an IE study sheet
 * is exactly the transcription MARBIM should draft. `line_calendars` deliberately is not:
 * a shift roster is a decision about people, and a drafted one is a holiday the system
 * quietly planned work on.
 */
import { registerModule } from '../core/registry'

import { commitScenarioApply, commitSmvRecord } from './service'
import { planningToolPack } from './tools'
import { PLANNING_ZOD_MAP } from './zod'

export const planningModule = registerModule({
  id: 'planning',

  refResolvers: {
    /* `L1` — what the floor calls a sewing line, and what the board prints. */
    line: async (ctx, ref) => {
      const { lineIdByCode } = await import('./queries')
      return lineIdByCode(ctx, ref)
    },
  },
  pendingTargets: ['allocations', 'smv_records'],
  zodMap: PLANNING_ZOD_MAP,

  /** Read-only: an allocation is the factory promising its capacity, and a scenario is
   * applied after somebody compares it — both already have a human route through the inbox. */
  toolPack: planningToolPack,

  // Planner drafts, manager approves. Committing capacity is committing a ship date.
  approvalDefaults: { requiredRoles: ['owner', 'admin', 'planner'] },

  commitHandlers: {
    smv_records: commitSmvRecord,

    allocations: async (ctx, tx, input) => {
      const result = await commitScenarioApply(ctx, tx, { payload: input.payload })
      return { rowId: result.rowId, after: result.after }
    },
  },

  domainPrimer: {
    version: '4.1.0',
    text: `You are helping a planner schedule sewing lines in a Bangladeshi export factory.

HOW CAPACITY IS MEASURED
- Capacity is EARNABLE minutes, not clock minutes: (shift − planned downtime) × manpower ×
  expected efficiency. A 40-operator line on a 480-minute shift has 19,200 clock minutes
  and, at 60%, about 11,500 earnable ones. Planning against the clock figure is the single
  most common way a factory over-commits.
- Work is measured in earned minutes: SMV × quantity. A style at 12.5 SMV needs 12,500
  minutes for 1,000 pieces regardless of how many people are on the line.
- A new style does not start at its steady-state rate. Operators learn the operation, and
  day one is often half of day ten. Use the learning curve when one exists.

THE ONE THING YOU MUST NOT DO
Never trim a quantity, extend a window, or shave a rate to make a plan fit. If the numbers
say a line-day is 1,700 minutes over, say 1,700 minutes over. A planner may decide to
accept an overload — that is their call and it gets recorded — but a plan that fits only
because software quietly adjusted it is a ship date the factory will miss without warning.

OTHER RULES
- Never invent an SMV. If a style has no record, say so and stop. "About twelve minutes"
  is how a factory commits to a date it cannot make.
- Always state the efficiency a capacity answer assumed. A number without its assumptions
  gets quoted back six weeks later as a promise.
- Moving sewing moves everything downstream of it in the order's timeline. When you
  propose a move, say which milestones shift.
- Three or more styles on one line in one day is a changeover warning worth raising: every
  style change costs setup time the SMV does not include.

DRAFTING
You may draft a scenario — a what-if arrangement — and an SMV record read off an IE study.
A scenario becomes real only when a manager approves it, and the overload check runs again
at that moment against the board as it is then. Never describe a drafted plan as scheduled.`,
  },
})
