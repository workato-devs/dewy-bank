/**
 * Dewy Bank — Provisioning Lambda (Phase 0 STUB).
 *
 * Facilitator-invoked workshop setup/teardown (decision 6.2 / plan §7). Members
 * of the Cognito `facilitators` group invoke this to:
 *   - set up a workshop: create/populate the per-workshop-prefixed data
 *     (seed accounts incl. a VICTIM account — decision 6.3/6.7), set an
 *     optional TTL/expiry (decision 6.5);
 *   - re-seed/reset a victim account to its starting balance between attempts
 *     (idempotent — decision 6.3);
 *   - tear down a workshop's data.
 *
 * Invocation is gated by IAM: only `facilitators` group members may invoke
 * (least privilege). The expiry/TTL recorded here is what the lifecycle Lambda
 * reads to auto-teardown TTL'd workshops.
 */

type ProvisioningEvent = {
  action?: 'setup' | 'teardown' | 'reseed';
  workshopId?: string;
  ttlHours?: number;
  [k: string]: unknown;
};

export const handler = async (event: ProvisioningEvent): Promise<unknown> => {
  // TODO(Phase 1/2): implement setup (seed accounts incl. victim), teardown, and
  //   idempotent reseed/reset. Record expiry per workshop for the lifecycle Lambda.
  console.log('provisioning stub invoked', JSON.stringify(event));
  return { status: 'stub', message: 'provisioning Lambda — implemented in Phase 1/2' };
};
