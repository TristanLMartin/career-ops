// Jobs "Map" view — fit (x) by pay (y), colored by location, shaped by role family.
import { PageFrame } from "@/components/page-frame";
import { readBaseFloor, readHuntEnrichment } from "@/lib/hunt-data";
import { familiesFrom, mapPoints } from "@/lib/hunt-map.mjs";
import { rankMap } from "@/lib/hunt-rank-order.mjs";
import { JobMap, type MapPoint } from "@/components/hunt/job-map";
import { JobsViewToggle } from "@/components/hunt/jobs-view-toggle";

export const dynamic = "force-dynamic";

export default function JobsMapPage() {
  const { jobs, display } = readHuntEnrichment();
  // Best overall: the same #N as Home, Jobs and job pages (lib/hunt-rank-order.mjs).
  const rank = rankMap(jobs);
  // Role categories from the profile (map_families / target roles); null = the built-in software ones.
  const families = familiesFrom(display?.roleFamilies ?? null);
  const { points, noPay } = mapPoints(jobs, { trueRank: (u: string) => rank.get(u) ?? null, families });
  return (
    <PageFrame>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl tracking-tight text-landing">Jobs</h1>
        <JobsViewToggle active="map" />
      </div>
      <JobMap points={points as MapPoint[]} noPay={noPay} floor={readBaseFloor()} families={families ? families.map((f: { name: string }) => f.name) : null} />
    </PageFrame>
  );
}
