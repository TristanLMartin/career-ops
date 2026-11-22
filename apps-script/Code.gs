/**
 * Job Hunt messages feed (read-only).
 *
 * Serves the threads under a short allow-list of Gmail labels as JSON, to anyone
 * holding a long random key. Your career-ops machine pulls it hourly
 * (scripts/hunt-messages-sync.mjs, JOBHUNT_FEED_URL / JOBHUNT_FEED_KEY in .env).
 *
 * Safety properties:
 *  - Uses ONLY the Gmail advanced service with the gmail.readonly scope (see
 *    appsscript.json). It cannot send, delete, label, or modify mail.
 *  - Returns ONLY threads that carry one of the labels in LABELS. Anything else in
 *    the mailbox is never queried.
 *  - Returns metadata + Gmail's short snippet, never full bodies or attachments.
 *  - A wrong or missing key gets the same tiny "forbidden" reply.
 *
 * Script properties (Project Settings > Script properties):
 *   FEED_KEY  : required, long random string (run makeKey() once to create it)
 *   MY_EMAIL  : your address, used to mark "you sent the last message"
 *   LABELS    : optional, comma-separated label names (defaults below)
 *   DAYS      : optional, how far back to look (default 90)
 *   SEARCH    : optional, Gmail search that finds recruiter / job mail anywhere in
 *               the inbox, with or without a label (default DEFAULT_SEARCH below).
 *               Set it to "off" to go back to labels only.
 *   SEARCH_DAYS : optional, how far back the search looks (default 45)
 *
 * v2 (2026-11-21): also finds unlabelled recruiter mail with a Gmail search, so
 * nothing needs a label any more. Still read-only, still metadata + snippet only.
 */

var DEFAULT_LABELS = [
  'Job Hunt/LinkedIn messages',
  'Job Hunt/Applications',
  'Job Hunt/Recruiters'
];
var MAX_THREADS_PER_LABEL = 200;
var MAX_SEARCH_THREADS = 150;

// Recruiter and job-related mail. Promotions, social and job-alert digests are
// excluded so job-board newsletters don't flood the dashboard; the dashboard
// classifies what's left (recruiter / job lead / other).
var DEFAULT_SEARCH = [
  '(recruiter OR recruiting OR "talent acquisition" OR sourcer OR "hiring manager"',
  ' OR interview OR "phone screen" OR "your application" OR "the role" OR "this role"',
  ' OR calendly OR paraform OR greenhouse OR lever OR ashby OR workday',
  ' OR "good to chat" OR "meeting scheduled")',
  ' -category:promotions -category:social -category:forums',
  // newsletters, job-alert digests and HR/benefits mail. Add your own noise here, e.g. your
  // current or previous employer's HR domain: ' -from:hr.example.com'
  ' -from:substack.com -from:otp.workday.com -from:docusign.net',
  ' -from:indeed.com -from:glassdoor.com',
  ' -from:jobalerts-noreply@linkedin.com -from:jobs-noreply@linkedin.com',
  ' -subject:benefits -subject:"open enrollment"'
].join('');

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('FEED_KEY') || '';
  var given = (e && e.parameter && e.parameter.key) || '';
  if (expected.length < 32 || !safeEqual_(given, expected)) {
    return json_({ ok: false, error: 'forbidden' });
  }

  var myEmail = (props.getProperty('MY_EMAIL') || '').toLowerCase();
  var wanted = (props.getProperty('LABELS') || DEFAULT_LABELS.join(','))
    .split(',').map(function (s) { return s.trim(); }).filter(String);
  var days = parseInt(props.getProperty('DAYS') || '90', 10);

  var labels = Gmail.Users.Labels.list('me').labels || [];
  var byName = {};
  labels.forEach(function (l) { byName[l.name] = l; });

  var threads = {};
  var missing = [];
  wanted.forEach(function (name) {
    var label = byName[name];
    if (!label) { missing.push(name); return; }
    var pageToken = null, count = 0;
    do {
      var res = Gmail.Users.Threads.list('me', {
        labelIds: [label.id],
        q: 'newer_than:' + days + 'd',
        maxResults: 100,
        pageToken: pageToken
      });
      (res.threads || []).forEach(function (t) {
        if (!threads[t.id]) threads[t.id] = { id: t.id, labels: [] };
        threads[t.id].labels.push(name);
        count++;
      });
      pageToken = res.nextPageToken;
    } while (pageToken && count < MAX_THREADS_PER_LABEL);
  });

  var search = props.getProperty('SEARCH') || DEFAULT_SEARCH;
  var searchDays = parseInt(props.getProperty('SEARCH_DAYS') || '45', 10);
  var searchCount = 0;
  if (search.toLowerCase() !== 'off') {
    var tok = null;
    do {
      var sr = Gmail.Users.Threads.list('me', {
        q: search + ' newer_than:' + searchDays + 'd',
        maxResults: 100,
        pageToken: tok
      });
      (sr.threads || []).forEach(function (t) {
        if (!threads[t.id]) threads[t.id] = { id: t.id, labels: [] };
        if (threads[t.id].labels.indexOf('search:recruiting') === -1) threads[t.id].labels.push('search:recruiting');
        searchCount++;
      });
      tok = sr.nextPageToken;
    } while (tok && searchCount < MAX_SEARCH_THREADS);
  }

  var out = Object.keys(threads).map(function (id) {
    var t = Gmail.Users.Threads.get('me', id, {
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date']
    });
    var msgs = t.messages || [];
    var first = msgs[0], last = msgs[msgs.length - 1];
    var lastFrom = header_(last, 'From');
    return {
      threadId: id,
      labels: threads[id].labels,
      subject: header_(first, 'Subject'),
      from: header_(first, 'From'),
      lastFrom: lastFrom,
      lastFromMe: !!myEmail && lastFrom.toLowerCase().indexOf(myEmail) !== -1,
      to: header_(last, 'To'),
      messageCount: msgs.length,
      firstDate: new Date(Number(first.internalDate)).toISOString(),
      lastDate: new Date(Number(last.internalDate)).toISOString(),
      snippet: last.snippet || '',
      link: 'https://mail.google.com/mail/u/0/#all/' + id
    };
  });
  out.sort(function (a, b) { return a.lastDate < b.lastDate ? 1 : -1; });

  return json_({
    ok: true,
    generatedAt: new Date().toISOString(),
    version: 2,
    labels: wanted,
    missingLabels: missing,
    searchThreads: searchCount,
    days: days,
    threads: out
  });
}

/** Run once from the editor: creates FEED_KEY and logs it so you can copy it to your career-ops .env. */
function makeKey() {
  var bytes = [];
  for (var i = 0; i < 4; i++) bytes.push(Utilities.getUuid().replace(/-/g, ''));
  var key = bytes.join('');
  PropertiesService.getScriptProperties().setProperty('FEED_KEY', key);
  Logger.log('FEED_KEY = ' + key);
}

/** Run from the editor to check what the feed would return, without deploying. */
function testFeed() {
  var key = PropertiesService.getScriptProperties().getProperty('FEED_KEY');
  var res = JSON.parse(doGet({ parameter: { key: key } }).getContent());
  Logger.log('ok=%s version=%s threads=%s searchThreads=%s missingLabels=%s', res.ok, res.version, (res.threads || []).length, res.searchThreads, res.missingLabels);
  (res.threads || []).slice(0, 5).forEach(function (t) {
    Logger.log('%s | %s | %s', t.lastDate, t.lastFrom, t.subject);
  });
}

function header_(msg, name) {
  var hs = (msg && msg.payload && msg.payload.headers) || [];
  for (var i = 0; i < hs.length; i++) if (hs[i].name.toLowerCase() === name.toLowerCase()) return hs[i].value;
  return '';
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
