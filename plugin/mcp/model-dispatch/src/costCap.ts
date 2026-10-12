import { readEvents } from "./telemetry.js";
import type { Policy } from "./types.js";

export const COST_CAP_EXCEEDED = "COST_CAP_EXCEEDED";

export class CostCapExceededError extends Error {
  readonly code = COST_CAP_EXCEEDED;
  constructor(
    readonly recordedUsd: number,
    readonly capUsd: number,
    readonly policyName: string,
    readonly telemetryPath: string,
  ) {
    super(
      `${COST_CAP_EXCEEDED}: $${recordedUsd.toFixed(4)} is already recorded in ${telemetryPath}, ` +
        `at or above hard_cost_cap_usd $${capUsd} for policy '${policyName}'. ` +
        `No further dispatch is allowed for this run. Raise the cap in the policy to continue.`,
    );
    this.name = "CostCapExceededError";
  }
}

/** Every provenance counts: the cap guards spend, so modeled and estimated figures are not exempt. */
export function recordedCostUsd(telemetryPath: string): number {
  let total = 0;
  for (const ev of readEvents(telemetryPath)) {
    if (typeof ev.cost_usd === "number" && Number.isFinite(ev.cost_usd)) total += ev.cost_usd;
  }
  return total;
}

/**
 * Throws once recorded spend has reached the cap. The call that crosses the
 * cap is allowed to finish, since its cost is unknown until it returns.
 */
export function assertUnderCostCap(policy: Policy, telemetryPath: string | undefined): void {
  const cap = policy.hard_cost_cap_usd;
  if (typeof cap !== "number" || !telemetryPath) return;
  const recorded = recordedCostUsd(telemetryPath);
  if (recorded >= cap) throw new CostCapExceededError(recorded, cap, policy.name, telemetryPath);
}
