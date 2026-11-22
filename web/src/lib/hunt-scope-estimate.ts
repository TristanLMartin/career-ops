// hunt: the cost shown on the Evaluate and Deep dive buttons: the median of this profile's
// recent logged runs of that scope on the current spend tier's model (data/hunt-usage.tsv).
import { careerOpsRoot } from "@/lib/career-ops";
import { withSpendTierModel } from "@/lib/spend-tier-model.mjs";
import { medianScopeCost } from "@/lib/hunt-lite-eval.mjs";

export function scopeEstimate(scope: "lite" | "deep"): number | null {
  try {
    const root = careerOpsRoot();
    const model = withSpendTierModel("claude", { cwd: root, env: { ...process.env, ANTHROPIC_MODEL: "" } }).env?.ANTHROPIC_MODEL ?? "";
    return medianScopeCost(root, scope, { model });
  } catch {
    return null;
  }
}
