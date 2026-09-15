// Upper bound on how many sessions a single batch-delete invocation may carry.
// The async job Lambda has a 10 minute timeout; capping the batch size keeps a
// single job well within that budget (even with heavy, throttled sessions) and
// prevents a partial-failure + retry from re-emitting duplicate events. The
// client splits larger selections into multiple invocations of this size.
//
// This lives outside actions.ts because Next.js (Turbopack) only allows async
// function exports from a "use server" module.
export const MAX_BATCH_DELETE_SIZE = 50;
