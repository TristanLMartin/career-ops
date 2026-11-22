# Study plan (optional)

The dashboard's **Study** page shows a day-by-day interview prep plan with tickable items,
flashcards and a few reference docs. It reads only your own files under `data/study/` (personal,
gitignored); nothing here is required.

| File | What it is |
|---|---|
| `data/study/days.md` | The plan: `## Phase` headings, `### Day N: theme`, one `- ` bullet per tickable item |
| `data/study/cards.jsonl` | Flashcards, one JSON object per line: `{"c": "Behavioral", "q": "...", "one": "...", "b": ["...", "..."]}` |
| `data/study/stories.md` | Your story bank (STAR answers), shown on the Stories tab |
| `data/study/design-prompts.md` | Practice prompts (`## Prompt name` sections), linked from days that quote their name |
| `data/study/company-prep.md` | Per-company notes (`## Company` sections), linked from tracker rows in Interview |
| `data/study/lessons.md`, `checkpoints.md`, `resources.md` | Free-form notes |

Start from the example: `mkdir -p data/study && cp docs/study/example/* data/study/`, then edit.
Ticks are saved in `data/study-state.json`. Ask your AI CLI to write a plan for your field from
your CV and target roles ("write data/study/days.md for a 3-week recruiter interview prep").
