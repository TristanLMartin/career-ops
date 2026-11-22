// hunt: the Jobs view's company filter (/pipeline?company=X), linked from each company on
// /portals. A job matches when its company name is the same company (case, punctuation, legal
// suffixes and "Industries"/"Technologies"/"AI"-style tails ignored, so "Andurilindustries" and
// "Anduril Industries" are one) or its posting URL is on the same ATS board as the portal entry
// (job-boards.greenhouse.io/anthropic, jobs.ashbyhq.com/livekit, jobs.lever.co/palantir, ...).

const TAILS = ["inc", "llc", "ltd", "corp", "corporation", "co", "company", "hq", "industries", "technologies", "technology", "tech", "labs", "ai", "io", "app", "software", "group", "holdings"];

const words = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean);

/** "Anduril Industries, Inc." / "Andurilindustries" -> "anduril". */
export function companyKey(name) {
  let w = words(name);
  while (w.length > 1 && TAILS.includes(w[w.length - 1])) w = w.slice(0, -1);
  let k = w.join("");
  for (let again = true; again;) {
    again = false;
    for (const t of TAILS) if (t.length >= 2 && k.length - t.length >= Math.max(3, 7 - t.length) && k.endsWith(t)) { k = k.slice(0, -t.length); again = true; break; }
  }
  return k;
}

/** "greenhouse:anthropic" for a Greenhouse/Ashby/Lever/Workable/Rippling/SmartRecruiters board or posting URL, else null. */
export function atsBoard(url) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  const gh = u.searchParams.get("for");
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (host.startsWith("api.") || host.startsWith("boards-api.")) { const m = u.pathname.match(/boards\/([^/]+)/i); return m ? `greenhouse:${m[1].toLowerCase()}` : null; }
    if (gh) return `greenhouse:${gh.toLowerCase()}`;
    return seg && seg !== "embed" ? `greenhouse:${seg}` : null;
  }
  if (host === "jobs.ashbyhq.com" || host === "api.ashbyhq.com") {
    const m = u.pathname.match(/job-board\/([^/]+)/i);
    return m ? `ashby:${m[1].toLowerCase()}` : seg ? `ashby:${seg}` : null;
  }
  if (host === "jobs.lever.co" || host === "api.lever.co") {
    const m = u.pathname.match(/postings\/([^/]+)/i);
    return m ? `lever:${m[1].toLowerCase()}` : seg ? `lever:${seg}` : null;
  }
  if (host === "apply.workable.com" && seg) return `workable:${seg}`;
  if (host === "ats.rippling.com" && seg) return `rippling:${seg}`;
  if (host === "jobs.smartrecruiters.com" && seg) return `smartrecruiters:${seg}`;
  return null;
}

/**
 * The filter for ?company=X: the name plus the ATS boards of every portal entry with that
 * name (so a job listed under a different spelling on the same board still matches).
 * @param {string} name
 * @param {string[]} [boards] atsBoard() keys of the portal entry
 */
export function companyFilter(name, boards = []) {
  return { name: String(name ?? "").trim(), key: companyKey(name), boards: new Set(boards.filter(Boolean)) };
}

/** Does a job ({company, url}) belong to the filtered company? */
export function matchesCompany(job, f) {
  if (!f || !f.key) return true;
  if (companyKey(job?.company) === f.key) return true;
  const b = atsBoard(job?.url);
  return b != null && f.boards.has(b);
}

/** /pipeline link for a company, with its boards so aliases on the same board match too. */
export function companyHref(name, boards = []) {
  const p = new URLSearchParams({ company: String(name ?? "").trim() });
  for (const b of [...new Set(boards.filter(Boolean))]) p.append("board", b);
  return `/pipeline?${p.toString()}`;
}
