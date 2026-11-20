#!/usr/bin/env node
// Build a playable browser challenge from its source folder.
//
//   node tools/build.js <source-dir> "<output-dir>"
//   e.g. node tools/build.js .authoring/chall-1-midnight-export "challenges/chall 1 - Midnight Export"
//
// source-dir (keep it out of the published tree, e.g. .authoring/<id>/):
//   challenge.json   metadata, questions (answer / choice / rank) with plaintext answers, hints,
//                    walkthrough steps and the real incidents that inspired it (see TEMPLATE/challenge.json)
//   briefing.md      the scenario, shown in-game
//   solution.md      what happened, shown in-game on the score screen
//   artifacts/       logs.json + evidence files
//
// output-dir (what players get):
//   readme.txt       how to get started, in plain text
//   play.html        double-click to play
//   files/           everything the game needs: challenge.js (answers hashed, the rest sealed),
//                    explorer.js (a copy of the engine, so the folder works on its own) and
//                    artifacts/ (logs.json for players who prefer their own tools, logs.js, evidence)
// No plaintext solution is written: the full story is shown in-game once the player is done.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { answerHash, seal, judgeRank, countOrders, run: runQuery } = require('../explorer/explorer.js');

const args = process.argv.slice(2);
const [srcDir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!srcDir || !outDir) {
  console.error('usage: node tools/build.js <source-dir> "<output-dir>"');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const src = (p) => path.join(srcDir, p);
const read = (p) => fs.readFileSync(src(p), 'utf8');
const c = JSON.parse(read('challenge.json'));

const problems = [];
for (const k of ['id', 'title', 'salt', 'briefing', 'questions']) if (!c[k]) problems.push(`challenge.json: missing "${k}"`);
if (c.salt && !/^[0-9a-f]{16,}$/.test(c.salt)) problems.push('salt must be 16+ hex chars (generate: node -e "console.log(require(\'crypto\').randomBytes(8).toString(\'hex\'))")');
const total = (c.questions || []).reduce((s, q) => s + (q.points || 0), 0);
if (total !== 100) problems.push(`question points add up to ${total}, not 100`);
if (c.lab && !fs.existsSync(src('lab'))) problems.push('challenge.json has a "lab" but there is no lab/ folder in the source');
if (c.lab && fs.existsSync(src('lab')) && !fs.readdirSync(src('lab')).some((f) => /compose.*\.ya?ml$/.test(f))) problems.push('lab/ has no docker-compose file');
if (!(c.inspiredBy || []).length) problems.push('add "inspiredBy": the real incidents this challenge is based on (title, source, date, url, note), shown on the score screen');
for (const q of c.questions || []) if (!(q.guide || []).length) problems.push(`${q.id}: add "guide" steps for walkthrough mode`);
for (const r of c.inspiredBy || []) if (!r.title || !/^https:\/\//.test(r.url || '') || !r.note) problems.push(`inspiredBy "${r.title || '?'}": needs a title, an https url and a note`);
const KINDS = ['answer', 'choice', 'rank'];
const notes = [];
for (const q of c.questions || []) {
  if (!KINDS.includes(q.kind)) problems.push(`${q.id}: kind must be one of ${KINDS.join(', ')} (free-text "written" questions are retired: use rank or choice)`);
  if (q.kind === 'answer' && !(q.answers || []).length) problems.push(`${q.id}: needs at least one entry in "answers"`);
  if (q.kind === 'choice') {
    const opts = q.options || [];
    if (opts.length < 3) problems.push(`${q.id}: choice questions need 3+ options`);
    if (opts.filter((o) => o.correct).length !== 1) problems.push(`${q.id}: exactly one option must be "correct": true`);
    for (const o of opts) if (!o.text || !o.why) problems.push(`${q.id}: every option needs "text" and "why" (why it's right, or why it's wrong)`);
  }
  if (q.kind === 'rank') {
    const items = q.items || [];
    const ids = items.map((t) => t.id);
    if (items.length < 4) problems.push(`${q.id}: rank questions need 4+ items`);
    if (new Set(ids).size !== ids.length) problems.push(`${q.id}: item ids must be unique`);
    for (const t of items) if (!t.id || !t.text || !t.why) problems.push(`${q.id}: every item needs "id", "text" and "why"`);
    const needed = items.filter((t) => !t.exclude).map((t) => t.id);
    if (needed.length < 2) problems.push(`${q.id}: at least two items must belong in the plan`);
    const list = (x) => (Array.isArray(x) ? x : [x]);
    for (const r of q.rules || []) {
      if (!r.why) problems.push(`${q.id}: every rule needs a "why"`);
      for (const id of [...list(r.before), ...list(r.after)]) if (!needed.includes(id)) problems.push(`${q.id}: rule refers to "${id}", which isn't a plan item`);
    }
    if (!problems.length) {
      const key = { order: needed, items: Object.fromEntries(items.map((t) => [t.id, { exclude: !!t.exclude, why: t.why }])), rules: q.rules || [] };
      if (!judgeRank(key, needed, items.filter((t) => t.exclude).map((t) => t.id)).ok) problems.push(`${q.id}: the items' listed order must itself satisfy every rule`);
      else {
        let all = 1; for (let i = 2; i <= needed.length; i++) all *= i;
        notes.push(`${q.id}: ${needed.length} plan steps + ${items.length - needed.length} don't-do · rules accept ${countOrders(needed, q.rules)} of ${all} orders`);
      }
    }
  }
  if ((q.kind === 'choice' || q.kind === 'rank') && !(q.wrongCost >= 0)) problems.push(`${q.id}: set "wrongCost", the points lost per failed check`);
  const costs = (q.hints || []).map((h) => h.cost);
  if (costs.some((x, i) => i && x <= costs[i - 1])) problems.push(`${q.id}: hint costs must rise per tier`);
}
// every query a hint or walkthrough step suggests must run and find something
const logsForCheck = c.logs && fs.existsSync(src(c.logs)) ? JSON.parse(read(c.logs)) : null;
for (const q of c.questions || []) {
  const qsToCheck = [...(q.hints || []).filter((h) => h.query).map((h) => ['hint', h.query]), ...(q.guide || []).filter((g) => g.query).map((g) => ['guide step', g.query])];
  for (const g of q.guide || []) if (!g.text) problems.push(`${q.id}: every guide step needs "text"`);
  for (const [where, query] of qsToCheck) {
    if (!logsForCheck) { problems.push(`${q.id}: ${where} has a query but the challenge has no logs`); continue; }
    try { if (!runQuery(query, logsForCheck).rows.length) problems.push(`${q.id}: ${where} query returns nothing: ${query}`); }
    catch (e) { problems.push(`${q.id}: ${where} query doesn't parse (${e.message}): ${query}`); }
  }
}
if (problems.length) { console.error(problems.map((p) => '✗ ' + p).join('\n')); process.exit(1); }

const S = (t) => seal(t, c.salt);
// deterministic shuffle, seeded by the salt, so rebuilds are stable
function shuffle(arr, label) {
  const a = arr.slice();
  let h = crypto.createHash('sha256').update(`${c.salt}:${label}`).digest();
  for (let i = a.length - 1; i > 0; i--) {
    if (i % 8 === 0) h = crypto.createHash('sha256').update(h).digest();
    const j = h.readUInt32BE((i % 8) * 4) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const out = {
  id: c.id, week: c.week, title: c.title, subtitle: c.subtitle, angle: c.angle, task: c.task,
  difficulty: c.difficulty, minutes: c.minutes, skills: c.skills, salt: c.salt,
  briefing: read(c.briefing),
  columns: c.columns, examples: c.examples,
  evidence: (c.evidence || []).map((e) => ({ path: e.path, label: e.label, note: e.note, content: read(e.path) })),
  questions: c.questions.map((q) => {
    const o = { id: q.id, kind: q.kind, points: q.points, short: q.short, prompt: q.prompt, placeholder: q.placeholder,
      board: q.board, wrongCost: q.wrongCost,
      hints: (q.hints || []).map((h) => ({ cost: h.cost, text: S(h.text), query: h.query ? S(h.query) : undefined })),
      guide: (q.guide || []).map((g) => ({ text: S(g.text), query: g.query ? S(g.query) : undefined })),
      story: q.story ? S(q.story) : undefined };
    if (q.kind === 'answer') {
      o.hashes = q.answers.map((a) => answerHash(c.salt, q.id, a));
      o.answer = S(q.answers[0]);
      if (q.visibleAnswer) o.visibleAnswer = true; // answer is part of the shown material (e.g. a tool name in evidence)
    }
    if (q.kind === 'choice') {
      // options are shuffled and renamed so neither position nor id gives the answer away
      const opts = shuffle(q.options, `${q.id}:opts`).map((x, i) => ({ ...x, tid: `o${i + 1}` }));
      o.options = opts.map((x) => ({ id: x.tid, text: x.text }));
      o.key = S(JSON.stringify({ correct: opts.find((x) => x.correct).tid, why: Object.fromEntries(opts.map((x) => [x.tid, x.why])) }));
    }
    if (q.kind === 'rank') {
      const items = shuffle(q.items, `${q.id}:items`).map((x, i) => ({ ...x, tid: `t${i + 1}` }));
      const tid = Object.fromEntries(items.map((x) => [x.id, x.tid]));
      const list = (x) => (Array.isArray(x) ? x : [x]);
      o.items = items.map((x) => ({ id: x.tid, text: x.text }));
      o.key = S(JSON.stringify({
        order: q.items.filter((x) => !x.exclude).map((x) => tid[x.id]),
        items: Object.fromEntries(items.map((x) => [x.tid, { exclude: !!x.exclude, why: x.why }])),
        rules: (q.rules || []).map((r) => ({ before: list(r.before).map((id) => tid[id]), after: list(r.after).map((id) => tid[id]), why: r.why })),
      }));
    }
    return o;
  }),
  solution: c.solution ? S(read(c.solution)) : undefined,
  // sealed too: the links would give the scenario away before the end
  inspiredBy: S(JSON.stringify(c.inspiredBy)),
};

// Write output
const F = path.join(outDir, 'files');
fs.mkdirSync(path.join(F, 'artifacts'), { recursive: true });
for (const old of ['README.md', 'SOLUTION.md', 'challenge.js', 'artifacts']) fs.rmSync(path.join(outDir, old), { recursive: true, force: true }); // older layout
const copy = (p) => { fs.mkdirSync(path.dirname(path.join(F, p)), { recursive: true }); fs.copyFileSync(src(p), path.join(F, p)); };
for (const e of c.evidence || []) copy(e.path);
if (c.logs) {
  const logs = JSON.parse(read(c.logs));
  const lines = logs.map((e) => JSON.stringify(e)).join(',\n');
  fs.writeFileSync(path.join(F, 'artifacts/logs.json'), `[\n${lines}\n]\n`);
  fs.writeFileSync(path.join(F, 'artifacts/logs.js'), `// Same events as logs.json, wrapped so play.html can load them from file://\nwindow.WEEKLY_SEC_LOGS = [\n${lines}\n];\n`);
}
const json = JSON.stringify(out, null, 1);
fs.writeFileSync(path.join(F, 'challenge.js'),
  `// Built by tools/build.js. Answers are salted SHA-256 hashes; hints, keys, walkthrough and story are\n// sealed (obfuscated, not encrypted) so they can't be read by accident. Don't edit by hand.\nwindow.WEEKLY_SEC_CHALLENGE = ${json};\n`);
fs.copyFileSync(path.join(root, 'explorer', 'explorer.js'), path.join(F, 'explorer.js'));
const hasLab = fs.existsSync(src('lab'));
if (hasLab) { fs.rmSync(path.join(outDir, 'lab'), { recursive: true, force: true }); fs.cpSync(src('lab'), path.join(outDir, 'lab'), { recursive: true }); }

const name = `${c.week ? c.week + ' · ' : ''}${c.title}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
fs.writeFileSync(path.join(outDir, 'play.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · weekly-sec</title>
</head>
<body>
<noscript>This challenge runs in your browser and needs JavaScript turned on.${c.logs ? " The raw logs are in files/artifacts/logs.json." : ""}</noscript>
${c.logs ? '<script src="files/artifacts/logs.js"></script>\n' : ''}<script src="files/challenge.js"></script>
<script src="files/explorer.js"></script>
</body>
</html>
`);

// readme.txt: plain text, wrapped, readable in any editor
// wrap to 72 columns; `first` prefixes the first line, `ind` indents the rest (hanging indent)
const wrap = (t, ind = '', first = ind) => {
  const out = []; let line = '';
  const pre = () => (out.length ? ind : first);
  for (const w of String(t).split(/\s+/).filter(Boolean)) {
    if (line && (pre() + line + ' ' + w).length > 72) { out.push(pre() + line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(pre() + line);
  return out.join('\n');
};
const item = (n, t) => wrap(t, '   ', `${n}. `);
const tip = (t) => wrap(t, '  ', '- ');
const ascii = (t) => String(t).replace(/[–—]/g, '-').replace(/→/g, '->').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const title = ascii(`${c.week ? c.week + ' - ' : ''}${c.title}`).toUpperCase();
const field = (k, v) => v ? wrap(ascii(v), ' '.repeat(13), (k + ':').padEnd(13)) : null;
const hasLogs = !!c.logs;
const lab = c.lab || {};
const labDir = `${path.basename(outDir)}/${lab.dir || 'lab'}`;
const startCmd = lab.start || 'docker compose up -d --build';
const stopCmd = lab.stop || 'docker compose down -v';

const steps = [{ text: 'Get this folder onto your computer: clone the repository, or download it as a ZIP from GitHub and unzip it.' }];
if (hasLab) {
  steps.push({ text: 'Install Docker Engine and the Docker Compose v2 plugin if you do not have them (https://docs.docker.com/get-started/get-docker/). You need the "docker compose" subcommand (two words, v2) -- not the old "docker-compose" binary. Verify with:', lines: ['      docker compose version', '   It must print a v2.x version. If it errors, see lab/REQUIREMENTS.txt.'] });
  steps.push({ text: `Start the lab. Open a terminal, cd into "${labDir}", and run:`, lines: ['      ' + startCmd, ...(lab.url ? ['   The target then listens on ' + ascii(lab.url) + '.'] : [])] });
}
steps.push({ text: 'Open this folder and double-click play.html. It opens in your web browser (Chrome, Firefox, Edge or Safari). This is the game, and where you read the briefing and submit every answer. There is no server and no sign-up, and nothing leaves your machine.' });
steps.push({ text: 'Read the briefing, then choose a mode and a timebox and click "Begin investigation". The clock starts then.' });
steps.push({ text: hasLab
  ? 'Exploit the lab from your terminal, but submit every answer back in play.html, in the Objectives panel on the right. The terminal is only for running the attack; nothing you type there is graded. A wrong pick or a rejected plan in the game tells you why it is wrong.'
  : 'Investigate in the Logs and Evidence tabs and answer the objectives on the right. A wrong pick or a rejected plan tells you why it is wrong.' });
steps.push({ text: 'When every objective is done, you get your score, the full story of what happened, and links to the real incidents that inspired this challenge. Click "End investigation" to stop early.' });
if (hasLab) steps.push({ text: 'Shut the lab down when you are finished:', lines: ['      ' + stopCmd] });

const tips = [
  hasLogs ? tip('In Logs, click "Query help" for the query language. It takes two minutes to learn. Click any cell to filter on it, and click a field name to count its values.') : null,
  hasLab ? tip('The lab speaks JSON-RPC over HTTP. You can drive it with nothing more than curl; the briefing and the in-game hints show how.') : null,
  tip('Use the Notebook tab for your notes. It also records your hints and wrong answers.'),
  tip('Your progress is saved in your browser. "Restart" in the top bar wipes it and starts again.'),
  hasLogs ? tip('Prefer your own tools (jq, pandas, a SIEM)? The raw events are in files/artifacts/logs.json. You still answer in the game.') : null,
  hasLab ? tip('The lab binds to 127.0.0.1 only and is sandboxed (all capabilities dropped, no-new-privileges, read-only filesystem, resource caps). It is safe to run locally. Never expose its port to a network.') : null,
].filter(Boolean);

const readme = [
  title, '='.repeat(title.length), '',
  wrap(ascii(c.subtitle || '')), '',
  ...[field('Type', c.task ? `${c.angle} (${c.task.toLowerCase()})` : c.angle), field('Difficulty', c.difficulty), field('Time', c.minutes && `${c.minutes} minutes`),
    field('Skills', (c.skills || []).join(', ')),
    hasLab ? field('Requires', 'Docker Engine and the Docker Compose v2 plugin (the "docker compose" subcommand). See lab/REQUIREMENTS.txt.') : null,
    field('Format', hasLab ? 'A Docker lab you exploit from a terminal, plus a browser game for the objectives, hints and scoring. Runs offline.' : 'Browser game. Runs offline, with nothing to install.')].filter(Boolean), '',
  'GETTING STARTED', '---------------',
  ...steps.flatMap((st, i) => [item(i + 1, st.text), ...(st.lines || []), '']).slice(0, -1), '',
  'MODES', '-----',
  tip('Challenge mode: hints are locked. Solve it cold.'),
  tip('Guided mode, deeper hints: hints that get more specific' + (hasLogs ? ', ending with the exact query to run' : '') + '. Each hint costs points.'),
  tip('Guided mode, walkthrough: step-by-step guidance that follows your progress. Steps are free; your score is marked as a walkthrough.'), '',
  'TIPS', '----', ...tips, '',
  'WHAT IS IN THIS FOLDER', '----------------------',
  'readme.txt   This file.',
  'play.html    The game. Start here.',
  hasLab ? 'lab/         The Docker lab target, plus REQUIREMENTS.txt (Docker +' : null,
  hasLab ? '             Compose v2). See GETTING STARTED above.' : null,
  `files/       ${hasLogs ? 'Logs, evidence' : 'Evidence'} and the game itself. Keep it`,
  '             next to play.html and do not rename it.', '',
  'ABOUT THE DATA', '--------------',
  wrap('Everything here is fictional: the company, people, accounts, keys, IP addresses and domains. Credentials are obviously fake (they end in EXAMPLE), and nothing in this folder is malicious. The lab target is intentionally insecure for training, and only for that.'), '',
].filter((x) => x !== null).join('\n');
fs.writeFileSync(path.join(outDir, 'readme.txt'), readme);

// lab/REQUIREMENTS.txt: spell out the Docker + Compose v2 prerequisite for any lab challenge
if (hasLab) {
  const reqTitle = title + ' - LAB REQUIREMENTS';
  const req = [
    reqTitle, '='.repeat(reqTitle.length), '',
    'You need two things, both from Docker:', '',
    '  1. Docker Engine - the `docker` command.',
    '  2. The Docker Compose v2 plugin - the `docker compose` SUBCOMMAND',
    '     (two words, with a space). This is NOT the old, separate',
    '     `docker-compose` (hyphen) binary.', '',
    'CHECK WHAT YOU HAVE', '-------------------',
    '  docker --version',
    '  docker compose version      <- must print "Docker Compose version v2.x"', '',
    "If `docker compose version` fails with \"unknown shorthand flag: 'd'\",",
    '"\'compose\' is not a docker command", or similar, the v2 plugin is',
    'missing. Install it:', '',
    '  Debian / Ubuntu:  sudo apt-get update && sudo apt-get install -y docker-compose-plugin',
    '  Fedora / RHEL:    sudo dnf install -y docker-compose-plugin',
    '  macOS / Windows:  use Docker Desktop (the plugin is built in; just update it).', '',
    'Then re-run `docker compose version` to confirm it prints a v2.x version.', '',
    'RUN THE LAB', '-----------',
    'From this lab/ folder:', '',
    '  ' + startCmd + '      # start',
    '  ' + stopCmd + '      # stop and clean up when done',
    ...(lab.url ? ['', 'The target then listens on ' + ascii(lab.url) + '.'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, lab.dir || 'lab', 'REQUIREMENTS.txt'), req);
}

const digest = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
for (const n of notes) console.log('  ' + n);
console.log(`✓ built ${c.id} → ${outDir} · ${out.questions.length} questions · ${total} pts · ${(c.inspiredBy || []).length} incident links · ${digest}`);
