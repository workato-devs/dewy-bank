/**
 * Dewy Bank — Lifecycle / Expiry Lambda (Phase 0 STUB).
 *
 * EventBridge-scheduled (decision 6.5 / plan §7). On each scheduled run it will:
 *   - find workshops whose TTL/expiry has passed and auto-tear-down the ones that
 *     had a TTL set at provision time;
 *   - emit SES warning mail for long-lived resources outliving their expected
 *     window (SES stays in SANDBOX mode — approved/verified senders only, no
 *     production-access request — decision 6.5).
 *
 * SES recipients are the verified identities of `facilitators` group members
 * (sandbox permits mail only to verified identities).
 */

type ScheduledEvent = {
  'detail-type'?: string;
  time?: string;
  [k: string]: unknown;
};

export const handler = async (event: ScheduledEvent): Promise<unknown> => {
  // TODO(Phase 4): scan workshop expiry records; auto-teardown expired TTL'd workshops;
  //   send SES sandbox warnings to verified facilitator identities for long-lived resources.
  console.log('lifecycle stub invoked', JSON.stringify(event));
  return { status: 'stub', message: 'lifecycle/expiry Lambda — implemented in Phase 4' };
};
