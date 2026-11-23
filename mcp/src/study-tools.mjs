// Study plan editing: read the whole plan, add / edit / move / archive tasks, add / rename days,
// add flashcards. Writes go through the dashboard's POST /api/profile/study-plan
// (web/src/lib/hunt-study-plan.mjs), which keeps done state across edits, snapshots
// the old file and logs each edit with its time and "via mcp" so it can be undone.
import { z } from "zod";
import { ToolError } from "./config.mjs";
import { dashboardPost } from "./dashboard-client.mjs";

const TASK_ID = z.string().regex(/^[a-z0-9]{2,40}$/, "task ids come from get_study_plan");
const DAY = z.union([z.number().int().min(0), z.string().regex(/^(ft|d)?\d+$/i)]).describe('A day number (3) or a fast-track day ("ft2").');
const VIA = "mcp";

async function edit(data, op, args) {
  const res = await dashboardPost(data.p, "/api/profile/study-plan", { op, via: VIA, ...args });
  if (!res.ok) throw new ToolError(res.json?.error ? `Not changed: ${res.json.error}` : `The dashboard refused the edit (HTTP ${res.status}).`);
  const { ok: _ok, ...rest } = res.json ?? {};
  void _ok;
  return rest;
}

const dayRef = (d) => (d.fast ? `ft${d.n}` : d.n);

export function studyTools({ profileArg }) {
  return {
    get_study_plan: {
      description: "The whole study plan (or days from_day..to_day): each day's number, title, theme, section and tasks (id, type, text, star, done). Archived tasks are listed with archived: true. Use the task ids with the other study tools.",
      input: { profile: profileArg, from_day: z.number().int().min(1).optional(), to_day: z.number().int().min(1).optional(), include_fast_track: z.boolean().default(true) },
      async run(data, a) {
        const s = await data.study();
        const days = s.days.filter((d) => (d.fast ? a.include_fast_track : (a.from_day == null || d.n >= a.from_day) && (a.to_day == null || d.n <= a.to_day)));
        return {
          progress: `${s.progress.done} of ${s.progress.total} days done`,
          today: s.today ? dayRef(s.today) : null,
          days: days.map((d) => ({
            day: dayRef(d), title: d.title, theme: d.theme, section: d.section, week: d.week || undefined,
            tasks: [...d.items.map((i) => ({ id: i.id, type: i.type, text: i.text, star: i.star, done: !!s.state.ticks[i.id] })),
              ...d.archived.map((i) => ({ id: i.id, type: i.type, text: i.text, star: i.star, done: !!s.state.ticks[i.id], archived: true }))],
          })),
        };
      },
    },

    add_study_task: {
      description: "Add a task to a study day. type is free text (Coding, Design, Stories, Inference...). position is 1 for first; default last. Returns the task with its id.",
      input: { profile: profileArg, day: DAY, type: z.string().max(40).optional(), text: z.string().min(1).max(500), star: z.boolean().default(false), position: z.number().int().min(1).optional() },
      async run(data, a) { return edit(data, "add_task", { day: a.day, type: a.type, text: a.text, star: a.star, position: a.position }); },
    },

    update_study_task: {
      description: "Edit a study task's text, type or star, or move it (day and/or position). It keeps its id and done state.",
      input: { profile: profileArg, task_id: TASK_ID, text: z.string().min(1).max(500).optional(), type: z.string().max(40).optional(), star: z.boolean().optional(), day: DAY.optional(), position: z.number().int().min(1).optional() },
      async run(data, a) {
        if ([a.text, a.type, a.star, a.day, a.position].every((v) => v === undefined)) throw new ToolError("Nothing to change: pass text, type, star, day or position.");
        return edit(data, "update_task", { task_id: a.task_id, text: a.text, type: a.type, star: a.star, day: a.day, position: a.position });
      },
    },

    archive_study_task: {
      description: "Hide a study task (reversible with unarchive_study_task; nothing is deleted). Its done state is kept.",
      input: { profile: profileArg, task_id: TASK_ID },
      async run(data, a) { return edit(data, "archive_task", { task_id: a.task_id }); },
    },

    unarchive_study_task: {
      description: "Restore an archived study task to its day, with its id and done state.",
      input: { profile: profileArg, task_id: TASK_ID },
      async run(data, a) { return edit(data, "unarchive_task", { task_id: a.task_id }); },
    },

    add_study_day: {
      description: "Insert a new day after after_day (0 = before Day 1). theme is the text after \"Day N:\" (title is accepted for it too). Later days renumber; every task keeps its id and done state. section (e.g. \"Phase B\") places the day at the end of that section when after_day is not given.",
      input: { profile: profileArg, after_day: z.number().int().min(0).optional(), title: z.string().max(120).optional(), theme: z.string().max(120).optional(), section: z.string().max(120).optional() },
      async run(data, a) {
        if (!a.theme && !a.title) throw new ToolError("Pass a theme (or title) for the new day.");
        if (a.after_day == null && !a.section) throw new ToolError("Pass after_day (0 = before Day 1) or a section.");
        return edit(data, "add_day", { after_day: a.after_day, theme: a.theme, title: a.title, section: a.section });
      },
    },

    update_study_day: {
      description: "Rename a study day (theme, or title for the same thing), or move it to the end of another section (e.g. \"Phase B\"). Days renumber; tasks keep their ids and done state.",
      input: { profile: profileArg, day: DAY, title: z.string().max(120).optional(), theme: z.string().max(120).optional(), section: z.string().max(120).optional() },
      async run(data, a) {
        if (a.theme == null && a.title == null && a.section == null) throw new ToolError("Nothing to change: pass theme, title or section.");
        return edit(data, "update_day", { day: a.day, theme: a.theme, title: a.title, section: a.section });
      },
    },

    add_study_cards: {
      description: "Add flashcards to the deck the Study page shows. Each card: front (the question), back (first line is the short answer; more lines become bullets), tags (the first tag is its category). A card whose front is already in the deck is skipped.",
      input: { profile: profileArg, cards: z.array(z.object({ front: z.string().min(1).max(500), back: z.string().min(1).max(2000), tags: z.array(z.string().max(40)).max(5).optional() })).min(1).max(50) },
      async run(data, a) { return edit(data, "add_cards", { cards: a.cards }); },
    },
  };
}
