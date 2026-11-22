// Jobs "Map" view — fit (x) by pay (y), colored by location, shaped by role family.
import { PageFrame } from "@/components/page-frame";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { rankValue } from "@/lib/hunt-types";
import { familiesFrom, mapPoints } from "@/lib/hunt-map.mjs";
import { JobMap, type MapPoint } from "@/components/hunt/job-map";
import { JobsViewToggle } from "@/components/hunt/jobs-view-toggle";

export const dynamic = "force-dynamic";

export default function JobsMapPage() {
  const { jobs, display } = readHuntEnrichment();
  // True rank: the same order the Jobs list sorts by (head-to-head first, then composite).
  const order = Object.entries(jobs)
    .map(([url, e]) => [url, rankValue(e, "true")] as const)
    .filter(([, v]) => v != null)
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const rank = new Map(order.map(([url], i) => [url, i + 1]));
  // Role categories from the profile (map_families / target roles); null = the built-in software ones.
  const families = familiesFrom(display?.roleFamilies ?? null);
  const { points, noPay } = mapPoints(jobs, { trueRank: (u: string) => rank.get(u) ?? null, families });
  return (
    <PageFrame>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl tracking-tight text-landing">Jobs</h1>
        <JobsViewToggle active="map" />
      </div>
      <JobMap points={points as MapPoint[]} noPay={noPay} baseFloor={display?.baseFloor ?? null} families={families ? families.map((f: { name: string }) => f.name) : null} />
    </PageFrame>
  );
}
