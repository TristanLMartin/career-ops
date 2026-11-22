# Profile template

Copy with `node scripts/hunt-new-profile.mjs <id>` (creates `profiles/<id>/`, gitignored).
Everything for one person lives in their profile directory; `CAREER_OPS_PROFILE_DIR=profiles/<id>`
points every script and the web app at it. The default profile is the repo root.

Fill in, in this order:

1. `cv.md`: the resume (or paste / drop it on the web Home page, which writes this file).
2. `config/person.yml`: name, field, target roles, pay floor, locations, `is_tech`. Then `active: true`.
3. `portals.yml`: title keywords, locations, and the job boards to scan.
4. `config/ranking.yml` → `profile_rules`: home metro, title words, specialties.
5. `skills-profile.md`: strengths and things to avoid.
6. Optional: `.env` with `JOBHUNT_FEED_URL` / `JOBHUNT_FEED_KEY` for their own Gmail feed.

`data/` (tracker, inbox, scores, study state) is created and filled by the app.
