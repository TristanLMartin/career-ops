# Job Hunt messages feed: setup (about 10 minutes)

A small Google Apps Script in your own Google account reads your job-hunt mail read-only and serves it as JSON to anyone holding a long random key. Your career-ops machine pulls that feed every hour. No Google password or token is stored on that machine, only the feed URL and key.

What it can see: threads under the Job Hunt labels plus (v2) recruiter and job mail found by a Gmail search, for sender, subject, dates and Gmail's short preview only. It never reads full bodies or attachments.

What it can do: nothing besides read. Its only Google permission is gmail.readonly.

## 1. Create the script
1. Open https://script.google.com, click New project, name it "Job Hunt feed".
2. Project Settings: tick "Show appsscript.json manifest file in editor".
3. Replace appsscript.json and Code.gs with the files in this folder. Save.

## 2. Make the key and test it
1. Run makeKey. Authorize: it should ask only for "View your email messages and settings".
2. Copy the FEED_KEY value from the Execution log.
3. Script properties: add MY_EMAIL (your Gmail address).
4. Run testFeed: the log should show ok=true and version=2.

## 3. Deploy it
Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone (the key keeps others out). Copy the Web app URL ending in /exec.

## 4. Hand it to your career-ops machine
Add to ~/career-ops/.env (gitignored):
JOBHUNT_FEED_URL=https://script.google.com/macros/s/…/exec
JOBHUNT_FEED_KEY=<the FEED_KEY value>

## Updating the code
Paste the new Code.gs, run testFeed, then Deploy > Manage deployments > pencil > Version: New version > Deploy. The URL stays the same.

## To shut it off
Archive the deployment or delete the project. Changing FEED_KEY locks out the old key immediately.
