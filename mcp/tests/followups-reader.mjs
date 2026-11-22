// Test-only: builds the GET /api/profile/followups body for the fake dashboard from fixture data,
// the way web/src/lib/hunt-data.ts readOpportunities() does (messages, marks, contacts, thread
// rows, the core cadence calculator, buildOpportunities). The real server never reads these
// files itself; it asks the dashboard.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ProfileData } from "../src/data.mjs";

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

export class FollowupsReader extends ProfileData {
  /** readHuntMessages */
  async messages() {
    const M = await this.M();
    const dir = this.file("data");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^hunt-messages\.[a-z0-9-]+\.jsonl$/.test(f)); } catch { /* none */ }
    let text = "";
    for (const f of [path.join(dir, "hunt-messages.jsonl"), ...files.map((f) => path.join(dir, f))]) {
      const body = readText(f);
      text += body.endsWith("\n") || !body ? body : body + "\n";
    }
    const byThread = new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!m || typeof m.threadId !== "string" || !m.threadId) continue;
      const prev = byThread.get(m.threadId);
      if (!prev || String(m.date) >= String(prev.date)) byThread.set(m.threadId, m);
    }
    const list = [...byThread.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return M.messagesView.dedupeLinkedInPeople(list);
  }

  async marks() {
    const M = await this.M();
    return M.kinds.normalizeMarks(readJson(this.file("data/message-marks.json"), {}));
  }

  contacts() { return readJson(this.file("data/hunt-contacts.json"), {}).contacts ?? {}; }

  /** readThreadRows */
  async threadRowList() {
    const M = await this.M();
    return this.once("threads", async () => {
      const messages = await this.messages();
      const { marks, kindOverrides } = await this.marks();
      const cache = readJson(this.file("data/message-kinds.json"), {}).threads ?? {};
      const rows = M.kinds.threadRows(M.kinds.autoClear(messages), { marks, kindOverrides, cache, needsReply: M.messagesView.needsReply });
      const contacts = this.contacts();
      const trackerCos = new Set((await this.applications()).map((a) => M.followups.normCo(a.company)).filter((c) => c.length >= 3));
      for (const r of rows) {
        if (kindOverrides[r.id] || r.kind === "recruiter" || r.kind === "job_lead") continue;
        const from = String(r.from ?? "").toLowerCase();
        const known = contacts[from];
        const atTracked = trackerCos.has(M.followups.domainWord(from)) && /\b(schedul\w*|screen\w*|interview\w*|loop|recruit\w*|availability|next steps?)\b/i.test(`${r.snippet} ${r.subject ?? ""}`);
        if (known || atTracked) { r.kind = "recruiter"; r.kindBy = "rules"; r.why = known ? `${known.role} at ${known.company}` : "sender at a company in the tracker"; }
      }
      return rows;
    });
  }

  /** readFollowupEntries: the core cadence calculator (followup-cadence.mjs --json), or []. */
  followupEntries() {
    return this.once("entries", () => new Promise((resolve) => {
      const script = path.join(this.p.codeRoot, "followup-cadence.mjs");
      if (!fs.existsSync(script)) return resolve([]);
      const env = { ...process.env };
      delete env.CAREER_OPS_ROOT; delete env.CAREER_OPS_DATA_DIR; delete env.CAREER_OPS_PROFILE_DIR; delete env.CAREER_OPS_TRACKER;
      if (this.p.profileDir) env.CAREER_OPS_PROFILE_DIR = this.p.profileDir;
      else if (path.resolve(this.root) !== path.resolve(this.p.codeRoot)) env.CAREER_OPS_ROOT = this.root;
      execFile(process.execPath, [script, "--json"], { cwd: this.p.codeRoot, env, timeout: 12_000, encoding: "utf8", maxBuffer: 8 << 20 }, (err, out) => {
        if (err && !out) return resolve([]);
        try {
          const j = JSON.parse(out.slice(out.indexOf("{")));
          resolve(Array.isArray(j.entries) ? j.entries : []);
        } catch { resolve([]); }
      });
    }));
  }

  /** readOpportunities: the Follow-ups page, one row per opportunity, marks applied. */
  async opportunities() {
    const M = await this.M();
    const { marks } = await this.marks();
    const opps = M.followups.buildOpportunities({ entries: await this.followupEntries(), tracker: await this.trackerRows(), threads: await this.threadRowList(), contacts: this.contacts() });
    return opps.map((o) => {
      const m = marks[`opp:${o.key}`];
      const latest = o.threads[0]?.date ?? "";
      const back = m?.mark === "done" && latest && m.lastDate && latest > m.lastDate && !o.threads[0]?.lastFromMe;
      return { ...o, mark: m && !back ? m : null };
    });
  }

}

/** The JSON GET /api/profile/followups serves. */
export async function followupsBody(profile) {
  const r = new FollowupsReader(profile);
  const M = await r.M();
  const now = Date.now();
  const followups = (await r.opportunities()).map((o) => {
    let label = null;
    try { label = M.followups.whenLabel(o, now) || null; } catch { /* optional */ }
    return { ...o, whenLabel: label };
  });
  return { generatedAt: new Date(now).toISOString(), followups };
}
