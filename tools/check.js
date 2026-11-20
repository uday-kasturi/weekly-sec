#!/usr/bin/env node
// Repo checks, run by CI and runnable locally:  node tools/check.js
//  1. every lab docker-compose file publishes ports on 127.0.0.1 only, with no host networking, privileged mode,
//     host namespaces, Docker socket, or bind mounts outside the lab folder
//  2. every challenge folder is named "chall N - Name" and has a readme.txt; browser challenges also have
//     play.html and files/ (challenge.js, explorer.js in sync with explorer/explorer.js, artifacts/)
//  3. every logs.json parses, has ts + source on each event, and matches logs.js
//  4. challenge.js parses, answers are hashes only, no answer leaks in plaintext, and it links real incidents
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const errors = [];
const fail = (msg) => errors.push(msg);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(root);
const rel = (p) => path.relative(root, p);

// 1. compose files
for (const f of files.filter((f) => /docker-compose[^/]*\.ya?ml$|compose[^/]*\.ya?ml$/.test(path.basename(f)))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let inPorts = false, indent = 0;
  lines.forEach((line, i) => {
    const code = line.replace(/#.*$/, '');
    if (/^\s*network_mode:\s*["']?host/.test(code)) fail(`${rel(f)}:${i + 1} network_mode: host is not allowed`);
    if (/^\s*privileged:\s*true/.test(code)) fail(`${rel(f)}:${i + 1} privileged containers are not allowed`);
    if (/docker\.sock/.test(code)) fail(`${rel(f)}:${i + 1} mounting the Docker socket is not allowed`);
    if (/^\s*(pid|ipc|userns_mode|cgroup):\s*["']?host/.test(code)) fail(`${rel(f)}:${i + 1} sharing host namespaces is not allowed`);
    // bind mounts must stay inside the lab folder: "./x:/y" is fine, "/etc:/y", "~/x:/y" or "../x:/y" are not
    const vol = code.match(/^\s*-\s*["']?([^"':\s]+):\/[^\s"']*/);
    if (vol && /^(\/|~|\.\.|\$)/.test(vol[1])) fail(`${rel(f)}:${i + 1} mount "${vol[1]}" reaches outside the lab folder`);
    const src = code.match(/^\s*source:\s*["']?([^"'\s]+)/);
    if (src && /^(\/|~|\.\.|\$)/.test(src[1])) fail(`${rel(f)}:${i + 1} mount source "${src[1]}" reaches outside the lab folder`);
    const m = code.match(/^(\s*)ports:\s*$/);
    if (m) { inPorts = true; indent = m[1].length; return; }
    if (inPorts) {
      if (code.trim() === '') return;
      const ind = code.match(/^\s*/)[0].length;
      if (ind <= indent && !code.trim().startsWith('-')) { inPorts = false; return; }
      const item = code.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
      if (item.startsWith('target:') || item.startsWith('published:') || item.startsWith('protocol:') || item.startsWith('mode:')) {
        fail(`${rel(f)}:${i + 1} use the short "127.0.0.1:host:container" port syntax so the bind address is explicit`);
      } else if (item && !item.startsWith('127.0.0.1:')) {
        fail(`${rel(f)}:${i + 1} port "${item}" must bind to 127.0.0.1`);
      }
    }
  });
}

// 2-4. challenges
// practice/ is git-ignored (Track B), so CI never sees it, but local runs check it too.
const challenges = [];
for (const top of ['challenges', 'practice']) {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) continue;
  for (const d of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, d)).isDirectory()) challenges.push([top, d]);
}
for (const [top, c] of challenges) {
  const d = path.join(root, top, c);
  if (top === 'challenges' && !/^chall \d+ - [A-Za-z0-9][A-Za-z0-9 '&-]*$/.test(c)) fail(`${top}/${c}: folder name must be "chall N - Name"`);
  // Two formats: browser challenges (play.html + files/, built by tools/build.js) and terminal challenges
  // (readme.txt plus lab/ or files, played in a shell). Only browser ones need the build output.
  const browser = fs.existsSync(path.join(d, 'play.html'));
  const required = ['readme.txt'].concat(browser ? ['play.html', 'files/challenge.js', 'files/explorer.js'] : []);
  for (const req of required) if (!fs.existsSync(path.join(d, req))) fail(`${top}/${c}: missing ${req}${browser ? ' (build it with tools/build.js)' : ''}`);
  const ex = path.join(d, 'files', 'explorer.js');
  if (browser && fs.existsSync(ex) && fs.readFileSync(ex, 'utf8') !== fs.readFileSync(path.join(root, 'explorer', 'explorer.js'), 'utf8')) {
    fail(`${top}/${c}: files/explorer.js is out of date with explorer/explorer.js (rebuild it with tools/build.js)`);
  }

  const lj = path.join(d, 'files', 'artifacts', 'logs.json');
  const ljs = path.join(d, 'files', 'artifacts', 'logs.js');
  if (fs.existsSync(lj)) {
    let logs;
    try { logs = JSON.parse(fs.readFileSync(lj, 'utf8')); } catch (e) { fail(`${rel(lj)}: invalid JSON: ${e.message}`); }
    if (logs) {
      if (!Array.isArray(logs)) fail(`${rel(lj)}: must be an array`);
      else logs.forEach((e, i) => { if (!e.ts || !e.source) fail(`${rel(lj)}: event ${i} lacks ts or source`); });
      if (!fs.existsSync(ljs)) fail(`${top}/${c}: logs.json without logs.js (play.html needs logs.js)`);
      else {
        const src = fs.readFileSync(ljs, 'utf8');
        const body = src.slice(src.indexOf('['), src.lastIndexOf(']') + 1);
        try {
          if (JSON.stringify(JSON.parse(body)) !== JSON.stringify(logs)) fail(`${rel(ljs)}: out of sync with logs.json`);
        } catch (e) { fail(`${rel(ljs)}: cannot parse array: ${e.message}`); }
      }
    }
  }

  const cj = path.join(d, 'files', 'challenge.js');
  if (fs.existsSync(cj)) {
    const src = fs.readFileSync(cj, 'utf8');
    const m = src.match(/WEEKLY_SEC_CHALLENGE\s*=\s*(\{[\s\S]*\});\s*$/);
    let ch = null;
    if (!m) fail(`${rel(cj)}: no WEEKLY_SEC_CHALLENGE found`);
    else try { ch = JSON.parse(m[1]); } catch (e) { fail(`${rel(cj)}: not valid JSON: ${e.message}`); }
    if (ch) {
      let refs = [];
      try { refs = JSON.parse(require('../explorer/explorer.js').unseal(ch.inspiredBy || '', ch.salt)); } catch (e) { /* reported below */ }
      if (!refs.length) fail(`${rel(cj)}: no "inspiredBy" incident links (every challenge links the real incidents behind it)`);
      for (const q of ch.questions || []) {
        if (q.kind === 'answer' && (!Array.isArray(q.hashes) || !q.hashes.length || q.hashes.some((h) => !/^[0-9a-f]{64}$/.test(h)))) {
          fail(`${rel(cj)}: ${q.id} needs sha256 hashes`);
        }
        if (q.kind === 'answer' && q.answer && !q.visibleAnswer) {
          let plain = null;
          try { plain = require('../explorer/explorer.js').unseal(q.answer, ch.salt); } catch (e) { fail(`${rel(cj)}: ${q.id} sealed answer is corrupt`); }
          if (plain && plain.length > 3 && src.includes(plain)) fail(`${rel(cj)}: ${q.id}'s answer appears in plaintext`);
        }
        if (!['answer', 'choice', 'rank'].includes(q.kind)) fail(`${rel(cj)}: ${q.id} has unsupported kind "${q.kind}" (written questions are retired)`);
        if (q.kind === 'choice' || q.kind === 'rank') {
          let key = null;
          try { key = JSON.parse(require('../explorer/explorer.js').unseal(q.key, ch.salt)); } catch (e) { fail(`${rel(cj)}: ${q.id} sealed key is missing or corrupt`); }
          const ids = (q.kind === 'choice' ? q.options : q.items || []).map((x) => x.id);
          if (key && q.kind === 'choice' && !ids.includes(key.correct)) fail(`${rel(cj)}: ${q.id} key points at an option that doesn't exist`);
          if (key && q.kind === 'rank' && ids.some((id) => !key.items[id])) fail(`${rel(cj)}: ${q.id} key doesn't cover every item`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(errors.map((e) => '✗ ' + e).join('\n'));
  process.exit(1);
}
console.log(`✓ ${challenges.length} challenge(s) checked, all good`);
