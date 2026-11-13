/*
 * weekly-sec: in-browser game shell and log explorer.
 * One file, no dependencies, no network. Works from file:// (double-click).
 *
 * A challenge's play.html loads, in order:
 *   artifacts/logs.js  -> window.WEEKLY_SEC_LOGS = [ ...events ]
 *   challenge.js       -> window.WEEKLY_SEC_CHALLENGE = { ...built by tools/build.js }
 *   this file
 * Without a challenge it runs as a plain log explorer (drop a JSON file on explorer.html).
 * The query language is specified in explorer/DSL.md.
 */
(function (global) {
  'use strict';

  // ====================================================================
  // Engine (pure; also exported for Node so it can be tested)
  // ====================================================================

  class QueryError extends Error {
    constructor(msg, pos) { super(msg); this.pos = pos; }
  }

  const STOP = /[\s()\[\],|"=!<>]/;

  function lex(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; } // comment
      if (c === '"') {
        let j = i + 1, s = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; }
          else s += src[j++];
        }
        if (j >= src.length) throw new QueryError('Unclosed quote', i);
        toks.push({ t: 'str', v: s, pos: i });
        i = j + 1;
        continue;
      }
      if ('()[],|'.includes(c)) { toks.push({ t: c, v: c, pos: i }); i++; continue; }
      if (c === '!' && src[i + 1] === '=') { toks.push({ t: 'op', v: '!=', pos: i }); i += 2; continue; }
      if (c === '>' || c === '<') {
        if (src[i + 1] === '=') { toks.push({ t: 'op', v: c + '=', pos: i }); i += 2; }
        else { toks.push({ t: 'op', v: c, pos: i }); i++; }
        continue;
      }
      if (c === '=') { toks.push({ t: 'op', v: '=', pos: i }); i += src[i + 1] === '=' ? 2 : 1; continue; }
      let j = i;
      while (j < src.length && !STOP.test(src[j])) j++;
      if (j === i) throw new QueryError(`Unexpected character '${c}'`, i);
      toks.push({ t: 'word', v: src.slice(i, j), pos: i });
      i = j;
    }
    return toks;
  }

  function parse(src) {
    const toks = lex(src);
    let p = 0;
    const end = src.length;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const kw = (tok, k) => tok && tok.t === 'word' && tok.v.toLowerCase() === k;
    const where = (tok) => (tok ? tok.pos : end);
    const show = (tok) => (tok ? (tok.t === 'str' ? `"${tok.v}"` : tok.v) : 'end of query');

    function expect(t, what) {
      const tok = next();
      if (!tok || tok.t !== t) throw new QueryError(`Expected ${what}, found ${show(tok)}`, where(tok));
      return tok;
    }

    function parseValue() {
      const tok = next();
      if (tok && (tok.t === 'str' || tok.t === 'word')) return tok.v;
      throw new QueryError(`Expected a value, found ${show(tok)}`, where(tok));
    }

    function parseList() {
      expect('[', "'['");
      const vals = [parseValue()];
      while (peek() && peek().t === ',') { next(); vals.push(parseValue()); }
      expect(']', "']'");
      return vals;
    }

    function parseOr() {
      let left = parseAnd();
      while (kw(peek(), 'or')) { next(); left = { type: 'or', a: left, b: parseAnd() }; }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (kw(peek(), 'and')) { next(); left = { type: 'and', a: left, b: parseNot() }; }
      return left;
    }
    function parseNot() {
      if (kw(peek(), 'not')) { next(); return { type: 'not', e: parseNot() }; }
      return parsePrimary();
    }
    function parsePrimary() {
      const tok = next();
      if (!tok) throw new QueryError('Query ended early: expected a condition', end);
      if (tok.t === '(') {
        const e = parseOr();
        expect(')', "')'");
        return e;
      }
      if (tok.t === 'str') return { type: 'text', v: tok.v };
      if (tok.t !== 'word') throw new QueryError(`Unexpected ${show(tok)}`, tok.pos);

      const field = tok.v;
      let negate = false;
      if (kw(peek(), 'not')) { next(); negate = true; }
      const op = peek();
      let node;
      if (op && op.t === 'op' && !negate) { next(); node = { type: 'cmp', field, op: op.v, v: parseValue() }; }
      else if (kw(op, 'contains')) { next(); node = { type: 'contains', field, v: parseValue() }; }
      else if (kw(op, 'in')) { next(); node = { type: 'in', field, vs: parseList() }; }
      else if (kw(op, 'exists')) { next(); node = { type: 'exists', field }; }
      else {
        if (negate) throw new QueryError(`After '${field} not' use contains, in, or exists`, where(op));
        throw new QueryError(
          `Expected an operator after '${field}'. To search every field for this text, quote it: "${field}"`,
          where(op));
      }
      return negate ? { type: 'not', e: node } : node;
    }

    function parseFieldList() {
      const fs = [expect('word', 'a field name').v];
      while (peek() && peek().t === ',') { next(); fs.push(expect('word', 'a field name').v); }
      return fs;
    }

    function parseStage() {
      const tok = next();
      if (kw(tok, 'sort')) {
        const keys = [];
        do {
          if (keys.length) next();
          const f = expect('word', 'a field to sort by').v;
          let dir = 'asc';
          if (kw(peek(), 'asc') || kw(peek(), 'desc')) dir = next().v.toLowerCase();
          keys.push({ field: f, dir });
        } while (peek() && peek().t === ',');
        return { type: 'sort', keys };
      }
      if (kw(tok, 'count')) {
        if (kw(peek(), 'by')) { next(); return { type: 'count', by: parseFieldList() }; }
        return { type: 'count', by: [] };
      }
      if (kw(tok, 'limit')) {
        const n = expect('word', 'a number');
        if (!/^\d+$/.test(n.v)) throw new QueryError('limit needs a whole number', n.pos);
        return { type: 'limit', n: parseInt(n.v, 10) };
      }
      if (kw(tok, 'fields')) return { type: 'fields', fields: parseFieldList() };
      if (kw(tok, 'where')) return { type: 'where', e: parseOr() };
      throw new QueryError(`Unknown stage ${show(tok)}. Stages are: where, sort, count, limit, fields`, where(tok));
    }

    let filter = null;
    if (peek() && peek().t !== '|') filter = parseOr();
    const stages = [];
    while (p < toks.length) {
      const t = next();
      if (t.t !== '|') {
        throw new QueryError(`Unexpected ${show(t)}. Join conditions with 'and' / 'or', or start a stage with '|'`, t.pos);
      }
      stages.push(parseStage());
    }
    return { filter, stages };
  }

  // ---------- evaluation ----------

  function get(obj, path) {
    // Aggregated rows use the literal dotted path as their key (e.g. after `count by a.b`).
    if (obj != null && typeof obj === 'object' && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, path)) {
      return obj[path];
    }
    const parts = path.split('.');
    let cur = [obj];
    for (const part of parts) {
      const nextVals = [];
      for (const c of cur) {
        if (c == null) continue;
        if (Array.isArray(c)) {
          for (const el of c) if (el != null && typeof el === 'object' && part in el) nextVals.push(el[part]);
        } else if (typeof c === 'object' && part in c) {
          nextVals.push(c[part]);
        }
      }
      if (!nextVals.length) return undefined;
      cur = nextVals;
    }
    return cur.length === 1 ? cur[0] : cur;
  }

  function flat(v) {
    if (v === undefined) return [];
    return Array.isArray(v) ? v.flat(Infinity) : [v];
  }

  const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
  function toTime(s) {
    if (typeof s !== 'string' || !ISO.test(s)) return null;
    let x = s.replace(' ', 'T');
    if (x.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(x)) x += 'Z';
    const n = Date.parse(x);
    return Number.isNaN(n) ? null : n;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    return null;
  }
  function str(v) {
    if (v === null) return 'null';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // Compare a field value with a query literal. Returns -1/0/1, or null when not comparable.
  function compare(a, raw) {
    if (a === undefined) return null;
    if (a !== null && typeof a === 'object') {
      return str(a).toLowerCase() === raw.toLowerCase() ? 0 : null;
    }
    const ta = toTime(typeof a === 'string' ? a : ''), tb = toTime(raw);
    if (ta !== null && tb !== null) return Math.sign(ta - tb);
    const na = toNum(a), nb = toNum(raw);
    if (na !== null && nb !== null) return Math.sign(na - nb);
    const sa = str(a).toLowerCase(), sb = raw.toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  const OPS = {
    '=': (c) => c === 0,
    '!=': (c) => c !== 0,
    '>': (c) => c === 1,
    '<': (c) => c === -1,
    '>=': (c) => c === 1 || c === 0,
    '<=': (c) => c === -1 || c === 0,
  };

  const textCache = new WeakMap();
  function rowText(row) {
    let t = textCache.get(row);
    if (t === undefined) { t = JSON.stringify(row).toLowerCase(); textCache.set(row, t); }
    return t;
  }

  function test(node, row) {
    switch (node.type) {
      case 'and': return test(node.a, row) && test(node.b, row);
      case 'or': return test(node.a, row) || test(node.b, row);
      case 'not': return !test(node.e, row);
      case 'text': return rowText(row).includes(node.v.toLowerCase());
      case 'exists': return flat(get(row, node.field)).some((v) => v !== null && v !== '');
      case 'contains': {
        const needle = node.v.toLowerCase();
        return flat(get(row, node.field)).some((v) => str(v).toLowerCase().includes(needle));
      }
      case 'in': {
        const vals = flat(get(row, node.field));
        return vals.some((v) => node.vs.some((raw) => compare(v, raw) === 0));
      }
      case 'cmp': {
        const vals = flat(get(row, node.field));
        if (node.op === '!=') return !vals.some((v) => compare(v, node.v) === 0);
        return vals.some((v) => {
          const c = compare(v, node.v);
          return c !== null && OPS[node.op](c);
        });
      }
    }
    throw new Error('bad node ' + node.type);
  }

  function sortValue(v) {
    if (Array.isArray(v)) v = v[0];
    if (v === undefined || v === null) return { k: 3, v: 0 };
    if (typeof v === 'number') return { k: 0, v };
    if (typeof v === 'object') return { k: 2, v: JSON.stringify(v).toLowerCase() };
    const t = toTime(v);
    if (t !== null) return { k: 0, v: t };
    const n = toNum(v);
    if (n !== null) return { k: 0, v: n };
    return { k: 1, v: String(v).toLowerCase() };
  }
  function cmpSort(a, b) {
    if (a.k !== b.k) return a.k - b.k;
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  }

  function run(query, rows) {
    const q = typeof query === 'string' ? parse(query) : query;
    let out = q.filter ? rows.filter((r) => test(q.filter, r)) : rows.slice();
    let columns = null;
    let aggregated = false;
    for (const st of q.stages) {
      if (st.type === 'sort') {
        const keyed = out.map((r, i) => ({ r, i, ks: st.keys.map((k) => sortValue(get(r, k.field))) }));
        keyed.sort((x, y) => {
          for (let j = 0; j < st.keys.length; j++) {
            const a = x.ks[j], b = y.ks[j];
            // missing values always last, whatever the direction
            if (a.k === 3 || b.k === 3) { if (a.k !== b.k) return a.k === 3 ? 1 : -1; continue; }
            const c = cmpSort(a, b);
            if (c) return st.keys[j].dir === 'desc' ? -c : c;
          }
          return x.i - y.i;
        });
        out = keyed.map((x) => x.r);
      } else if (st.type === 'count') {
        const groups = new Map();
        for (const r of out) {
          const key = st.by.map((f) => {
            const v = get(r, f);
            return v === undefined ? null : v;
          });
          const id = JSON.stringify(key);
          const g = groups.get(id);
          if (g) g.count++;
          else groups.set(id, { key, count: 1 });
        }
        out = [...groups.values()].map((g) => {
          const o = {};
          st.by.forEach((f, i) => { o[f] = g.key[i]; });
          o.count = g.count;
          return o;
        });
        out.sort((a, b) => b.count - a.count);
        columns = [...st.by, 'count'];
        aggregated = true;
      } else if (st.type === 'where') {
        out = out.filter((r) => test(st.e, r));
      } else if (st.type === 'limit') {
        out = out.slice(0, st.n);
      } else if (st.type === 'fields') {
        columns = st.fields;
      }
    }
    return { rows: out, columns, aggregated };
  }

  // ---------- SHA-256 (pure JS; crypto.subtle is unreliable on file://) ----------
  const SHA_K = [], SHA_H0 = [];
  (function init() {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) {
      if (primes.every((p) => n % p)) primes.push(n);
    }
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
    primes.forEach((p, i) => { SHA_K.push(frac(Math.cbrt(p))); if (i < 8) SHA_H0.push(frac(Math.sqrt(p))); });
  })();
  function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const len = bytes.length;
    const buf = new Uint8Array((((len + 9) + 63) >> 6) << 6);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 4, (len * 8) >>> 0);
    dv.setUint32(buf.length - 8, Math.floor((len * 8) / 4294967296));
    const H = SHA_H0.slice();
    const W = new Uint32Array(64);
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < buf.length; off += 64) {
      for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4);
      for (let t = 16; t < 64; t++) {
        const x = W[t - 15], y = W[t - 2];
        W[t] = (W[t - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + W[t - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[t] + W[t]) >>> 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  // Must match the normalisation used when the answer key was generated.
  function normalizeAnswer(s) {
    return String(s)
      .trim()
      .toLowerCase()
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .replace(/^(https?:\/\/|s3:\/\/)/, '')
      .replace(/^#/, '')
      .replace(/\s+/g, ' ')
      .replace(/[./]+$/, '');
  }
  function answerHash(salt, qid, answer) {
    return sha256(`${salt}:${qid}:${normalizeAnswer(answer)}`);
  }


  // Hints, answers, rubric and walkthrough ship "sealed": XOR with a salt-derived key, then base64.
  // This is obfuscation, not encryption. It stops accidental reading of the page source, nothing more.
  function sealKey(salt) {
    const hex = sha256(`${salt}:weekly-sec-v1`);
    const k = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k[i] = parseInt(hex.substr(i * 2, 2), 16);
    return k;
  }
  function seal(text, salt) {
    const k = sealKey(salt);
    const b = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i] ^ k[i % 32]);
    return btoa(bin);
  }
  function unseal(b64, salt) {
    const k = sealKey(salt);
    const bin = atob(b64);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i) ^ k[i % 32];
    return new TextDecoder().decode(b);
  }

  // ---- Ranked plans ("rank" questions) --------------------------------
  // key = { order: [ids in the canonical plan], items: { id: { exclude, why } }, rules: [{ before: [ids], after: [ids], why }] }
  // A plan is judged on three things, so every possible arrangement gets a specific reason:
  //   1. an "exclude" tile put in the plan          → that tile's why
  //   2. a needed tile put in "don't do"            → that tile's why
  //   3. any rule broken (some `before` tile placed after some `after` tile) → the rule's why
  // Any order that breaks no rule is accepted, so several correct orders can exist.
  const asList = (x) => (Array.isArray(x) ? x : [x]);
  function judgeRank(key, plan, dont) {
    const problems = [];
    for (const id of plan) if (key.items[id] && key.items[id].exclude) problems.push({ kind: 'exclude', id, why: key.items[id].why });
    for (const id of dont) if (key.items[id] && !key.items[id].exclude) problems.push({ kind: 'needed', id, why: key.items[id].why });
    const pos = new Map(plan.map((id, i) => [id, i]));
    for (const r of key.rules || []) {
      const broken = asList(r.before).some((b) => asList(r.after).some((a) => pos.has(a) && pos.has(b) && pos.get(b) > pos.get(a)));
      if (broken) problems.push({ kind: 'order', why: r.why });
    }
    return { ok: problems.length === 0, problems };
  }
  // How many orderings of the needed tiles the rules accept (for authors; build.js prints it).
  function countOrders(ids, rules) {
    const idx = new Map(ids.map((id, i) => [id, i]));
    const pred = ids.map(() => 0);
    for (const r of rules || []) for (const b of asList(r.before)) for (const a of asList(r.after)) pred[idx.get(a)] |= 1 << idx.get(b);
    const n = ids.length, ways = new Array(1 << n).fill(0);
    ways[0] = 1;
    for (let m = 0; m < 1 << n; m++) {
      if (!ways[m]) continue;
      for (let i = 0; i < n; i++) if (!(m & (1 << i)) && (pred[i] & m) === pred[i]) ways[m | (1 << i)] += ways[m];
    }
    return ways[(1 << n) - 1];
  }

  const engine = { lex, parse, run, get, sha256, normalizeAnswer, answerHash, seal, unseal, judgeRank, countOrders, QueryError };
  if (typeof module !== 'undefined' && module.exports) { module.exports = engine; return; }
  global.WeeklySecEngine = engine;

  // ====================================================================
  // UI
  // ====================================================================

  const CSS = `
:root{--bg:#f4f5f7;--panel:#fff;--panel-2:#f9fafb;--ink:#14171a;--muted:#5b6570;--faint:#8a939c;--line:#e1e4e8;
--accent:#1d63d8;--accent-ink:#fff;--accent-soft:#e7effc;--ok:#0a7a45;--ok-soft:#e5f5ec;--err:#b42318;--err-soft:#fdecea;
--warn:#9a5b00;--warn-soft:#fff4e0;--code:#f0f2f5;--row-hover:#eef3fb;--shadow:0 8px 30px rgba(15,23,42,.12);
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#151b23;--panel-2:#11161d;--ink:#e6edf3;--muted:#9aa5b1;--faint:#6e7781;
--line:#2a313c;--accent:#4c8dff;--accent-ink:#06101f;--accent-soft:#16233a;--ok:#3fb950;--ok-soft:#10261a;--err:#ff7b72;--err-soft:#2d1416;
--warn:#e3b341;--warn-soft:#2b2110;--code:#1c232d;--row-hover:#1a2433;--shadow:0 8px 30px rgba(0,0,0,.5)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
button{font:inherit;color:inherit;cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.5}
code{font-family:var(--mono);font-size:.92em;background:var(--code);padding:1px 5px;border-radius:4px}
.app{display:grid;grid-template-rows:auto 1fr;height:100vh}
.top{display:flex;align-items:center;gap:14px;padding:0 16px;min-height:56px;background:var(--panel);border-bottom:1px solid var(--line);min-width:0}
.brand{display:flex;align-items:center;gap:10px;white-space:nowrap;min-width:0}
.wk{font:600 11px var(--mono);letter-spacing:.04em;background:var(--accent-soft);color:var(--accent);padding:3px 7px;border-radius:5px}
.brand b{font-size:15px;overflow:hidden;text-overflow:ellipsis}
.tabs{display:flex;gap:2px;margin-left:8px;overflow-x:auto;scrollbar-width:none}
.tab{background:none;border:0;padding:8px 12px;border-radius:7px;color:var(--muted);font-weight:550;white-space:nowrap;position:relative}
.tab:hover:not(:disabled){background:var(--panel-2);color:var(--ink)}
.tab.on{color:var(--ink);background:var(--accent-soft)}
.tab .dot{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:var(--accent);color:var(--accent-ink);font-size:11px;line-height:18px;text-align:center}
.tab-obj{display:none}
.sp{flex:1}
.stat{display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;white-space:nowrap}
.stat small{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.stat span{font:600 15px var(--mono)}
.stat.over span{color:var(--err)}
.btn{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:7px 13px;font-weight:550}
.btn:hover:not(:disabled){border-color:var(--faint)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover:not(:disabled){filter:brightness(1.08)}
.btn.danger{color:var(--err)}
.btn.sm{padding:4px 10px;font-size:13px}
.link{background:none;border:0;padding:0;color:var(--accent);text-decoration:underline;text-underline-offset:2px;font-size:13px}
.body{display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,24vw,400px);min-height:0}
.view{min-height:0;overflow:auto;min-width:0}
.obj{border-left:1px solid var(--line);background:var(--panel);overflow:auto;min-height:0}
@media (max-width:1100px){.body{grid-template-columns:minmax(0,1fr)}.obj{display:none}.tab-obj{display:inline-block}
 .app.objopen .obj{display:block;position:fixed;inset:var(--toph,56px) 0 0 0;z-index:30;border-left:0}}
@media (max-width:700px){.top{flex-wrap:wrap;gap:6px 10px;padding:8px 10px 4px}.brand{flex:1}.sp{display:none}.tabs{order:5;width:100%;margin-left:0;flex-wrap:wrap;overflow:visible}.tab{padding:7px 9px;font-size:13.5px}.tab-obj{order:-1}.stat small{display:none}.top .btn{padding:5px 10px}}
/* prose */
.prose{max-width:840px;margin:0 auto;padding:28px 28px 80px}
.prose h1{font-size:26px;margin:0 0 6px}
.prose h2{font-size:18px;margin:32px 0 10px;padding-top:8px}
.prose h3{font-size:15px;margin:22px 0 8px}
.prose p,.prose li{color:var(--ink)}
.prose pre{background:var(--code);padding:12px 14px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 var(--mono)}
.prose td,.prose th{overflow-wrap:anywhere}
.prose pre code{background:none;padding:0}
.prose blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 6px 6px 0}
.prose .tw{overflow-x:auto;margin:12px 0}
.prose table{border-collapse:collapse;width:100%;font-size:13.5px}
.prose th,.prose td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.prose th{font-size:12px;color:var(--muted);font-weight:600}
.prose a{color:var(--accent)}
.prose hr{border:0;border-top:1px solid var(--line);margin:28px 0}
.sub{color:var(--muted);font-size:15px;margin:0 0 14px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px}
.pill{font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.start{margin:6px 0 24px;border-color:var(--accent);box-shadow:var(--shadow)}
.start h3{margin:0 0 4px;font-size:16px}
.choices{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
.choice{text-align:left;border:1.5px solid var(--line);background:var(--panel-2);border-radius:10px;padding:12px 14px}
.choice b{display:block;margin-bottom:2px}
.choice span{color:var(--muted);font-size:13px}
.choice.on{border-color:var(--accent);background:var(--accent-soft)}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
select,input[type=text],textarea{font:inherit;color:var(--ink);background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
select:focus,input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
@media (max-width:600px){.choices{grid-template-columns:1fr}.prose{padding:20px 16px 60px}}
/* objectives */
.objhead{position:sticky;top:0;background:var(--panel);z-index:2;padding:16px 18px 12px;border-bottom:1px solid var(--line)}
.objhead h2{margin:0;font-size:15px;display:flex;align-items:center;justify-content:space-between}
.bar{height:6px;border-radius:3px;background:var(--code);margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--ok);transition:width .3s}
.objhead p{margin:6px 0 0;font-size:12.5px;color:var(--muted)}
.qs{padding:10px 12px 40px}
.q{border:1px solid var(--line);border-radius:11px;padding:13px 14px;margin:8px 0;background:var(--panel)}
.q.solved{border-color:color-mix(in srgb,var(--ok) 45%,var(--line));background:var(--ok-soft)}
.q.revealed{background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.qh{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.qn{font:700 12px var(--mono);background:var(--code);border-radius:5px;padding:2px 6px}
.qt{font-size:12px;color:var(--muted);flex:1}
.qp{font:600 12px var(--mono);color:var(--muted)}
.q.solved .qp{color:var(--ok)}
.q p.prompt{margin:0 0 10px;font-size:13.5px}
.ans{display:flex;gap:6px}
.ans input{flex:1;min-width:0;font:13px var(--mono)}
.q textarea{width:100%;min-height:110px;font:13px/1.45 var(--mono);resize:vertical}
.fb{font-size:12.5px;margin-top:6px;min-height:0}
.fb.ok{color:var(--ok);font-weight:600}.fb.no{color:var(--err)}
.shake{animation:shake .35s}
@keyframes shake{20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(5px)}}
.hints{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.hint{font-size:13px;background:var(--panel-2);border:1px dashed var(--line);border-radius:8px;padding:8px 10px}
.hint b{font-size:11.5px;color:var(--muted);display:block;margin-bottom:2px}
.hrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.hbtn{font-size:12px;border:1px solid var(--line);background:var(--panel-2);border-radius:999px;padding:3px 10px}
.hbtn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.qfoot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px}
.answer{font:13px var(--mono);margin-top:8px;padding:7px 10px;border-radius:7px;background:var(--panel-2);border:1px solid var(--line);word-break:break-all}
.locked{font-size:12.5px;color:var(--muted)}
/* logs */
.logs{display:grid;grid-template-columns:clamp(160px,13vw,240px) minmax(0,1fr);height:100%}
.fields{border-right:1px solid var(--line);overflow:auto;padding:12px 10px;background:var(--panel)}
.fields h4,.ev-list h4{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin:2px 6px 8px}
.fields input{width:100%;margin-bottom:8px;font-size:13px;padding:5px 9px}
.fld{display:flex;justify-content:space-between;gap:8px;padding:2px 6px;border-radius:5px;cursor:pointer;font:12px var(--mono)}
.fld span:first-child{min-width:0;word-break:break-all}
.fld span:last-child{color:var(--faint);flex-shrink:0}
.fld:hover{background:var(--row-hover)}
.lmain{overflow:auto;padding:16px 18px 40px;min-width:0}
.qbox{display:flex;gap:8px;align-items:flex-start}
.qbox textarea{flex:1;font:14px var(--mono);min-height:44px;resize:vertical;padding:10px 12px;background:var(--panel)}
.qbox .btn{padding:10px 18px}
.hint-line{color:var(--faint);font-size:12px;margin:6px 2px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.err{color:var(--err);font:13px var(--mono);white-space:pre;overflow:auto;margin:6px 2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.chip{font:12px var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:4px 10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip:hover{border-color:var(--accent)}
.status{color:var(--muted);font-size:13px;margin:10px 2px}
.app.objhide .body{grid-template-columns:minmax(0,1fr)}.app.objhide .obj{display:none}.app.objhide .tab-obj{display:inline-block}
.objhead .hide{font:500 12px system-ui,sans-serif;margin-left:10px;color:var(--muted)}
@media (max-width:1100px){.objhead .hide{display:none}}
.tablewrap{overflow-x:hidden;overflow-y:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.tablewrap table{border-collapse:collapse;width:100%;table-layout:fixed;font:12.5px var(--mono)}
.tablewrap th{position:sticky;top:0;background:var(--panel);text-align:left;font:600 12px system-ui,sans-serif;color:var(--muted);padding:8px 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tablewrap td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tablewrap tr.r:hover td{background:var(--row-hover)}
.tablewrap td.tg{padding:5px 4px;text-align:center;color:var(--faint);cursor:pointer;user-select:none}
.tablewrap td.v{cursor:copy}
.tablewrap td.v:hover{text-decoration:underline dotted}
.tablewrap tr.x td{white-space:pre-wrap;background:var(--code);overflow-wrap:anywhere;word-break:normal}
.more{margin:12px 0}
@media (max-width:760px){.logs{grid-template-columns:1fr;grid-template-rows:auto 1fr}.fields{max-height:170px;border-right:0;border-bottom:1px solid var(--line)}}
/* evidence */
.ev{display:grid;grid-template-columns:260px minmax(0,1fr);height:100%}
.ev-list{border-right:1px solid var(--line);padding:12px 10px;background:var(--panel);overflow:auto}
.ev-item{display:block;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:8px 10px;margin-bottom:2px}
.ev-item b{display:block;font:600 13px var(--mono);word-break:break-all}
.ev-item span{font-size:12px;color:var(--muted)}
.ev-item:hover{background:var(--row-hover)}
.ev-item.on{background:var(--accent-soft)}
.ev-view{overflow:auto;padding:16px 18px 40px;min-width:0}
.ev-view h3{margin:0 0 2px;font:600 15px var(--mono)}
.ev-view p{margin:0 0 12px;color:var(--muted);font-size:13px}
.ev-view pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.55 var(--mono);margin:0}
@media (max-width:760px){.ev{grid-template-columns:1fr;grid-template-rows:auto 1fr}.ev-list{border-right:0;border-bottom:1px solid var(--line)}}
/* notebook */
.nb{max-width:900px;margin:0 auto;padding:22px 24px 60px}
.nb textarea{width:100%;min-height:280px;font:13.5px/1.55 var(--mono);resize:vertical}
.nb h3{font-size:14px;margin:22px 0 8px}
.act{font:12.5px/1.5 var(--mono);border-top:1px solid var(--line);padding:6px 0;display:flex;gap:12px}
.act time{color:var(--faint);flex-shrink:0;width:56px}
.act.no span{color:var(--err)}.act.ok span{color:var(--ok)}.act.h span{color:var(--warn)}
/* debrief */
.score-big{font:700 44px var(--mono);margin:0}
.score-big small{font-size:18px;color:var(--muted)}
.sumtab td:last-child,.sumtab th:last-child{text-align:right}
.story{border-top:1px solid var(--line);margin-top:26px;padding-top:6px}
.refs{margin-top:26px;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;background:var(--panel);padding:4px 20px 8px}
.refs h2{margin-top:16px}
.refs ul{list-style:none;padding:0;margin:0 0 6px}
.refs li{padding:10px 0;border-top:1px solid var(--line)}
.refs li a{font-weight:600}
.refs .src{display:block;font-size:12px;color:var(--muted);margin-top:2px}
.refs li p{margin:4px 0 0;font-size:14px}
.qrun{display:flex;gap:8px;align-items:flex-start;margin-top:8px}
.qrun code{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:6px 9px;border-radius:7px;font:12px/1.5 var(--mono)}
.qrun .btn{flex-shrink:0}
.stage{border:1px solid var(--line);border-radius:11px;background:var(--panel);padding:4px 16px;margin:10px 0}
.stage[open]{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));padding-bottom:14px}
.stage summary{cursor:pointer;display:flex;gap:10px;align-items:center;padding:9px 0;font-weight:600;list-style:none}
.stage summary::-webkit-details-marker{display:none}
.stage summary .qn{font:700 12px var(--mono);background:var(--accent-soft);color:var(--accent);border-radius:5px;padding:2px 6px}
.stage summary .st{margin-left:auto;font:500 12px var(--mono);color:var(--muted)}
.stage.done summary .st{color:var(--ok)}
.stage .prompt{margin:0 0 6px;color:var(--muted)}
.step{border-left:3px solid var(--accent);padding:4px 0 4px 12px;margin:12px 0}
.step > b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin-bottom:2px}
/* choice questions */
.opts{display:flex;flex-direction:column;gap:6px}
.opt{display:flex;gap:9px;align-items:flex-start;text-align:left;border:1.5px solid var(--line);background:var(--panel-2);border-radius:9px;padding:8px 10px;font-size:13px;color:var(--ink)}
.opt:hover:not(:disabled){border-color:var(--accent)}
.opt i{font-style:normal;font:600 12px var(--mono);color:var(--muted);flex-shrink:0;margin-top:1px}
.opt.no{border-color:color-mix(in srgb,var(--err) 45%,var(--line));background:var(--err-soft);text-decoration:line-through;color:var(--muted)}
.opt.ok{border-color:var(--ok);background:var(--ok-soft)}
.opt:disabled{cursor:default}
.why{font-size:12.5px;margin-top:6px;padding:8px 10px;border-radius:8px;background:var(--panel-2);border-left:3px solid var(--line)}
.why.no{border-left-color:var(--err);background:var(--err-soft)}
.why.ok{border-left-color:var(--ok);background:var(--ok-soft)}
/* planning board (rank questions) */
.board{padding:22px 24px 60px;max-width:1200px}
.board h1{margin:0 0 4px;font-size:22px}
.board .sub{color:var(--muted);margin:0 0 16px}
.lanes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) minmax(0,1fr);gap:14px;align-items:start}
.locked .lanes{grid-template-columns:minmax(0,1.25fr) minmax(0,1fr)}
@media (max-width:900px){.lanes,.locked .lanes{grid-template-columns:1fr}.board{padding:16px 16px 60px}}
.lane{border:1.5px dashed var(--line);border-radius:12px;background:var(--panel-2);padding:10px;display:flex;flex-direction:column;min-height:140px}
.lane.plan{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));background:color-mix(in srgb,var(--accent-soft) 45%,var(--panel-2))}
.lane.dont{border-color:color-mix(in srgb,var(--err) 35%,var(--line))}
.lane h3{margin:0 0 2px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between}
.lane h3 span{color:var(--faint);font-weight:500}
.lane > p{margin:0 0 8px;font-size:12px;color:var(--muted)}
.ll{display:flex;flex-direction:column;gap:7px;flex:1;min-height:60px}
.ll:empty::after{content:attr(data-empty);color:var(--faint);font-size:12.5px;text-align:center;padding:18px 6px;border-radius:8px}
.tile{display:flex;gap:8px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 8px 8px 6px;font-size:13px;line-height:1.4;box-shadow:0 1px 2px rgba(15,23,42,.06);user-select:none;-webkit-user-select:none}
.board:not(.locked) .tile{cursor:grab}
.tile .grip{color:var(--faint);cursor:grab;touch-action:none;padding:0 3px;font-size:15px;line-height:1.2;flex-shrink:0}
.tile .n{font:700 12px var(--mono);color:var(--accent);flex-shrink:0;min-width:18px;margin-top:1px}
.tile .tx{flex:1;min-width:0}
.tile .tx small{display:block;color:var(--muted);font-size:12px;margin-top:5px;line-height:1.45}
.tile .ctl{display:flex;gap:3px;flex-shrink:0}
.tile .ctl button{border:1px solid var(--line);background:var(--panel-2);color:var(--muted);border-radius:6px;font-size:11.5px;padding:2px 6px;line-height:1.4}
.tile .ctl button:hover{color:var(--ink);border-color:var(--accent)}
.tile.ghost{position:fixed;z-index:60;pointer-events:none;box-shadow:var(--shadow);transform:rotate(1.5deg);opacity:.95}
.tile.holder{opacity:.35;border-style:dashed}
.tile.bad{border-color:var(--err);background:var(--err-soft)}
.tile.good{border-color:color-mix(in srgb,var(--ok) 50%,var(--line))}
.locked .tile .grip{display:none}
.bfoot{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}
.bres{margin-top:12px;max-width:780px}
/* dialogs, toast */
dialog{border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);max-width:560px;width:calc(100% - 32px);padding:22px 24px;box-shadow:var(--shadow)}
dialog.wide{max-width:780px}
dialog::backdrop{background:rgba(5,10,20,.55)}
dialog h3{margin:0 0 8px;font-size:17px}
dialog p{margin:0 0 12px;color:var(--muted)}
dialog textarea{width:100%;min-height:80px}
dialog pre{background:var(--code);padding:10px 12px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px var(--mono)}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:9px;font-size:13.5px;z-index:99;box-shadow:var(--shadow);opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
.empty{color:var(--muted);text-align:center;padding:60px 20px}
.drop{border:2px dashed var(--line);border-radius:12px;padding:48px 24px;text-align:center;color:var(--muted);margin-top:24px}
.drop.on{border-color:var(--accent);color:var(--ink)}
`;

  const PAGE = 200;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* storage unavailable: run without persistence */ }
    return null;
  }

  let toastTimer;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
  }

  function dialog({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false, note = null, wide = false }) {
    return new Promise((resolve) => {
      const ta = note ? el('textarea', { placeholder: note }) : null;
      const d = el('dialog', { class: wide ? 'wide' : '' },
        el('h3', null, title),
        typeof body === 'string' ? el('p', null, body) : body,
        ta,
        el('div', { class: 'dlg-actions' },
          cancel ? el('button', { class: 'btn', onclick: () => { d.close(); resolve(null); } }, cancel) : null,
          el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { d.close(); resolve({ note: ta ? ta.value.trim() : '' }); } }, confirm)));
      d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
      d.addEventListener('cancel', () => resolve(null));
      document.body.append(d);
      d.showModal();
      if (ta) ta.focus();
    });
  }

  // ---------- tiny Markdown renderer (headings, paragraphs, lists, tables, code, quotes) ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function slug(s) { return s.toLowerCase().replace(/<[^>]+>|[`*]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
        if (/^https?:/.test(u)) return `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
        if (u.startsWith('#')) return `<a href="${u}" data-anchor="${u.slice(1)}">${t}</a>`;
        return t;
      });
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${esc(codes[i])}</code>`);
  }
  function md(src) {
    const L = src.replace(/\r/g, '').split('\n');
    const out = [];
    const isList = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
    const isBlock = (l) => /^(```|#{1,4}\s|>|\||---+\s*$)/.test(l) || isList(l);
    let i = 0;
    while (i < L.length) {
      const l = L[i];
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if (/^\s*$/.test(l)) { i++; }
      else if (/^(#{1,4})\s+/.test(l)) {
        const m = l.match(/^(#{1,4})\s+(.*)$/);
        out.push(`<h${m[1].length} id="${slug(m[2])}">${inline(m[2])}</h${m[1].length}>`); i++;
      } else if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; }
      else if (/^>/.test(l)) {
        const buf = [];
        while (i < L.length && /^>/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
      } else if (/^\|/.test(l)) {
        const rows = [];
        while (i < L.length && /^\|/.test(L[i])) rows.push(L[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        out.push(`<div class="tw"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (isList(l)) {
        const ordered = /^\s*\d+\./.test(l);
        const items = [];
        while (i < L.length && (isList(L[i]) || (items.length && /^\s{2,}\S/.test(L[i])))) {
          if (isList(L[i])) items.push(L[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
          else items[items.length - 1] += ' ' + L[i].trim();
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
      } else {
        const buf = [];
        while (i < L.length && !/^\s*$/.test(L[i]) && !isBlock(L[i])) buf.push(L[i++]);
        out.push(`<p>${inline(buf.join(' '))}</p>`);
      }
    }
    return out.join('\n');
  }
  function mdEl(src) {
    const d = el('div', { html: md(src) });
    d.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-anchor]');
      if (!a) return;
      e.preventDefault();
      const t = d.querySelector(`[id="${a.dataset.anchor.replace(/["\\]/g, '')}"]`);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return d;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ====================================================================
  // Log view (used by the game and by the standalone explorer)
  // ====================================================================

  function discoverFields(rows) {
    const counts = new Map();
    const walk = (o, prefix, depth) => {
      if (o == null || typeof o !== 'object' || depth > 4) return;
      const items = Array.isArray(o) ? o.slice(0, 3) : [o];
      for (const it of items) {
        if (it == null || typeof it !== 'object' || Array.isArray(it)) continue;
        for (const [k, v] of Object.entries(it)) {
          const path = prefix ? `${prefix}.${k}` : k;
          const leaf = v == null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object'));
          if (leaf) counts.set(path, (counts.get(path) || 0) + 1);
          else walk(v, path, depth + 1);
        }
      }
    };
    for (const r of rows) walk(r, '', 0);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function quoteVal(v) {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /^[^\s()\[\],|"=!<>#]+$/.test(s) && !/^(and|or|not|in|contains|exists)$/i.test(s)
      ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  function cellValue(row, path) {
    const paths = Array.isArray(path) ? path : [path];
    for (const p of paths) {
      const v = get(row, p);
      if (v !== undefined && v !== null && v !== '') return { p, v };
    }
    return { p: paths[0], v: undefined };
  }
  function fmt(v) {
    if (v === undefined) return '';
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  const HELP = `<h3>Query language</h3>
<pre>source = cloudtrail                 exact match (case-insensitive)
eventName != GetObject              not equal
userAgent contains "aws-cli"        substring
ts >= 2026-11-10T22:00              time, number, or text comparison: &lt; &gt; &lt;= &gt;=
eventName in [CreateUser, DeleteUser]
errorCode exists                    field is present and not empty
"203.0.113"                         quoted text alone: search every field
a and b    a or b    not a    ( … ) and binds tighter than or
userIdentity.arn                    dotted paths reach into nested objects
field not contains x · field not in [..] · field not exists

| where count > 1                   filter again (also after count)
| sort ts desc, eventName asc
| count by field1, field2           group and count (sorted by count)
| fields ts, sourceIPAddress        choose columns
| limit 50</pre>
<p>Enter runs · Shift+Enter new line · ↑ history · click a cell to filter on it · click a field on the left to count its values · ▸ shows the full event.</p>`;

  // ARNs are long and their prefix is the same everywhere: show what follows the account ID
  const shortText = (t) => (typeof t === 'string' && t.startsWith('arn:aws') ? t.replace(/^arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d*:/, '').replace(/^assumed-role\//, '') : t);
  // display form of a cell: short ARNs, and timestamps as "11-10 23:51:59" (the full value is in the tooltip)
  const cellText = (t, path) => {
    const m = /^\d{4}-(\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$/.exec(t);
    return m ? m[1].replace('T', ' ') : shortText(t);
  };

  function LogView(logs, cfg) {
    cfg = cfg || {};
    const histKey = `weekly-sec:history:${cfg.id || 'adhoc'}`;
    const status = el('div', { class: 'status' });
    const errBox = el('div', { class: 'err' });
    const tableWrap = el('div', { class: 'tablewrap' });
    const moreBtn = el('button', { class: 'btn sm more' }, 'Show more');
    const ta = el('textarea', { spellcheck: 'false', rows: '2', placeholder: 'e.g.  source = cloudtrail and eventName contains Create | sort ts' });
    const defaultCols = cfg.columns || Object.keys(logs[0] || {}).slice(0, 6).map((k) => ({ label: k, path: k }));
    let shown = 0;

    function render(result) {
      shown = 0;
      tableWrap.innerHTML = '';
      const sample = result.rows.slice(0, 150);
      let cols = result.columns ? result.columns.map((c) => ({ label: c, path: c })) : defaultCols;
      // drop default columns that are empty in these results, so the rest get the room
      if (!result.columns && sample.length) cols = cols.filter((c) => sample.some((r) => cellValue(r, c.path).v !== undefined));
      const head = el('tr', null, result.aggregated ? null : el('th'), cols.map((c) => el('th', { title: c.label }, c.label)));
      const tbody = el('tbody');
      // The table always fits its space (no sideways scrolling). Short columns (time, source,
      // event, IP…) get exactly the width they need; long ones (ARNs, details) share the rest.
      const roomy = (tableWrap.clientWidth || innerWidth - 600) >= 640;
      const widths = cols.map((c) => {
        const lens = sample.map((r) => cellText(fmt(cellValue(r, c.path).v), c.path).length).sort((a, b) => a - b);
        const p90 = lens.length ? lens[Math.floor(lens.length * 0.9)] : 0;
        const need = Math.max(c.label.length, p90, 3);
        return roomy && need <= 24 ? `calc(${Math.min(need, 17) + 1}ch + 16px)` : null;
      });
      const colgroup = el('colgroup', null, result.aggregated ? null : el('col', { style: 'width:26px' }),
        widths.map((w) => el('col', w ? { style: `width:${w}` } : null)));
      tableWrap.append(el('table', null, colgroup, el('thead', null, head), tbody));
      function addPage() {
        for (const row of result.rows.slice(shown, shown + PAGE)) {
          const tr = el('tr', { class: 'r' });
          if (!result.aggregated) {
            let open = null;
            const tg = el('td', { class: 'tg', title: 'Show the full event' }, '▸');
            tg.addEventListener('click', () => {
              if (open) { open.remove(); open = null; tg.textContent = '▸'; return; }
              open = el('tr', { class: 'x' }, el('td', { colspan: String(cols.length + 1) }, JSON.stringify(row, null, 2)));
              tr.after(open);
              tg.textContent = '▾';
            });
            tr.append(tg);
          }
          for (const c of cols) {
            const { p, v } = cellValue(row, c.path);
            const text = fmt(v);
            const td = el('td', { class: 'v', title: `${p}: ${text}\nClick to filter on this value` }, cellText(text, p));
            td.addEventListener('click', () => { if (v !== undefined) addFilter(`${p} = ${quoteVal(Array.isArray(v) ? v[0] : v)}`); });
            tr.append(td);
          }
          tbody.append(tr);
        }
        shown = Math.min(shown + PAGE, result.rows.length);
        moreBtn.style.display = shown < result.rows.length ? '' : 'none';
        moreBtn.textContent = `Show ${Math.min(PAGE, result.rows.length - shown)} more`;
      }
      moreBtn.onclick = addPage;
      addPage();
    }

    function headTail() {
      const q = ta.value.trim();
      const p = q.indexOf('|');
      return [(p >= 0 ? q.slice(0, p) : q).trim(), p >= 0 ? q.slice(p) : ''];
    }
    function addFilter(clause) {
      const [h, t] = headTail();
      ta.value = (h ? `${h} and ${clause}` : clause) + (t ? ' ' + t : '');
      exec();
    }

    let histIdx = -1;
    function exec() {
      const q = ta.value;
      errBox.textContent = '';
      const t0 = performance.now();
      try {
        const res = run(q, logs);
        const n = res.rows.length, ms = Math.round(performance.now() - t0);
        status.textContent = `${n.toLocaleString()} ${res.aggregated ? (n === 1 ? 'group' : 'groups') : (n === 1 ? 'event' : 'events')} · ${ms} ms`;
        render(res);
        if (q.trim()) {
          const h = (store(histKey) || []).filter((x) => x !== q.trim());
          h.unshift(q.trim());
          store(histKey, h.slice(0, 40));
          histIdx = -1;
        }
      } catch (e) {
        if (!(e instanceof QueryError)) throw e;
        status.textContent = 'Query error: the table still shows the previous results';
        const line = q.replace(/\n/g, ' ');
        errBox.textContent = `${e.message}\n  ${line}\n  ${' '.repeat(Math.min(e.pos, line.length))}^`;
      }
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); exec(); return; }
      const h = store(histKey) || [];
      if (e.key === 'ArrowUp' && ta.selectionStart === 0 && h.length) {
        e.preventDefault(); histIdx = Math.min(histIdx + 1, h.length - 1); ta.value = h[histIdx];
      } else if (e.key === 'ArrowDown' && histIdx >= 0 && ta.selectionStart === ta.value.length) {
        e.preventDefault(); histIdx--; ta.value = histIdx >= 0 ? h[histIdx] : '';
      }
    });

    const fields = discoverFields(logs);
    const ff = el('input', { type: 'text', placeholder: `Filter ${fields.length} fields…` });
    const fl = el('div');
    const drawFields = () => {
      const f = ff.value.toLowerCase();
      fl.innerHTML = '';
      for (const [path, n] of fields) {
        if (f && !path.toLowerCase().includes(f)) continue;
        fl.append(el('div', { class: 'fld', title: `Count events by ${path}`, onclick: () => {
          const [h] = headTail();
          ta.value = `${h ? h + ' ' : ''}| count by ${path}`;
          exec();
        } }, el('span', null, path), el('span', null, n.toLocaleString())));
      }
    };
    ff.addEventListener('input', drawFields);
    drawFields();

    const showHelp = () => dialog({ title: 'Query help', body: el('div', { html: HELP }), confirm: 'Got it', cancel: null, wide: true });

    const root = el('div', { class: 'logs' },
      el('div', { class: 'fields' }, el('h4', null, 'Fields'), ff, fl),
      el('div', { class: 'lmain' },
        el('div', { class: 'qbox' }, ta, el('button', { class: 'btn primary', onclick: exec }, 'Run')),
        el('div', { class: 'hint-line' },
          el('span', null, 'Enter to run · Shift+Enter new line · ↑ history · click a cell to filter'),
          el('button', { class: 'link', onclick: showHelp }, 'Query help')),
        errBox,
        el('div', { class: 'chips' }, (cfg.examples || []).map((ex) =>
          el('button', { class: 'chip', title: ex, onclick: () => { ta.value = ex; exec(); } }, ex))),
        status, tableWrap, moreBtn));

    ta.value = '| sort ts';
    exec();
    ta.value = '';
    return { root, focus: () => ta.focus(), runQuery: (q) => { ta.value = q; exec(); } };
  }

  // ====================================================================
  // Game
  // ====================================================================

  function Game(ch, logs) {
    const KEY = `weekly-sec:${ch.id}:state`;
    const fresh = () => ({ v: 2, mode: 'challenge', timebox: 90, startedAt: null, finishedAt: null, hintsUnlockedAt: null,
      guide: 'hints', solved: {}, revealed: {}, hints: {}, wrong: {}, picks: {}, boards: {}, fb: {}, steps: {}, notes: '', log: [] });
    let S = Object.assign(fresh(), store(KEY) || {});
    for (const k of ['wrong', 'picks', 'boards', 'fb', 'steps']) S[k] = S[k] || {};
    S.guide = S.guide || 'hints';
    // carry over answers solved with the earlier version of the explorer
    const legacy = store(`weekly-sec:solved:${ch.id}`);
    if (legacy && !Object.keys(S.solved).length) S.solved = legacy;
    const save = () => store(KEY, S);

    const qs = ch.questions;
    for (const q of qs) if (S.hints[q.id] > (q.hints || []).length) S.hints[q.id] = (q.hints || []).length;
    const total = qs.reduce((s, q) => s + q.points, 0);
    const unsealT = (x) => unseal(x, ch.salt);
    const keys = {};
    const keyOf = (q) => keys[q.id] || (keys[q.id] = JSON.parse(unsealT(q.key)));
    const now = () => Date.now();
    const elapsed = () => S.startedAt ? ((S.finishedAt || now()) - S.startedAt) / 1000 : 0;
    const started = () => !!S.startedAt;
    const finished = () => !!S.finishedAt;
    const hintsOn = () => S.mode === 'guided' || !!S.hintsUnlockedAt;
    const walk = () => S.mode === 'guided' && S.guide === 'walkthrough';
    const modeLabel = () => S.mode === 'guided' ? (walk() ? 'guided · walkthrough' : 'guided · hints') : `challenge${S.hintsUnlockedAt ? ' (hints unlocked)' : ''}`;
    const resolved = (q) => S.solved[q.id] !== undefined || !!S.revealed[q.id];
    const live = (q) => started() && !finished() && !resolved(q);
    const Q = (q) => q.id.toUpperCase();
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

    function logEvent(type, text, q) {
      S.log.push({ t: Math.round(elapsed()), type, q: q || null, text });
      save();
    }
    function hintCost(q) { return (q.hints || []).slice(0, S.hints[q.id] || 0).reduce((s, h) => s + h.cost, 0); }
    function missCost(q) { return (S.wrong[q.id] || 0) * (q.wrongCost || 0); }
    const penalty = (q) => hintCost(q) + missCost(q);
    function qScore(q) {
      if (S.revealed[q.id]) return 0;
      if (S.solved[q.id] !== undefined) return Math.max(0, q.points - penalty(q));
      return null;
    }
    const score = () => qs.reduce((s, q) => s + (qScore(q) || 0), 0);
    const doneCount = () => qs.filter(resolved).length;

    // ---------- shell ----------
    const tabs = {};
    const views = {};
    const timerEl = el('div', { class: 'stat' }, el('small', null, 'Time'), el('span', null, '--:--'));
    const scoreEl = el('div', { class: 'stat' }, el('small', null, 'Score'), el('span', null, `0/${total}`));
    const finishBtn = el('button', { class: 'btn', onclick: endEarly, title: 'Stop the clock and go to the score screen' }, 'End investigation');
    const restartBtn = el('button', { class: 'btn', onclick: startOver, title: 'Clear this attempt and start again' }, 'Restart');
    const nav = el('nav', { class: 'tabs' });
    const view = el('main', { class: 'view' });
    const obj = el('aside', { class: 'obj' });
    const app = el('div', { class: 'app' },
      el('header', { class: 'top' },
        el('div', { class: 'brand' }, el('span', { class: 'wk' }, ch.week || 'weekly-sec'), el('b', null, ch.title)),
        nav, el('span', { class: 'sp' }), timerEl, scoreEl, restartBtn, finishBtn),
      el('div', { class: 'body' }, view, obj));

    const boardQs = qs.filter((q) => q.kind === 'rank');
    const TABS = [['briefing', 'Briefing'], ['guide', 'Guide'], ['logs', 'Logs'], ['evidence', 'Evidence'],
      ...boardQs.map((q) => [`board-${q.id}`, q.board || q.short || 'Plan']),
      ['notebook', 'Notebook'], ['debrief', 'Score'], ['objectives', 'Objectives']];
    const gated = TABS.map(([id]) => id).filter((id) => !['briefing', 'debrief', 'objectives'].includes(id));
    for (const [id, label] of TABS) {
      tabs[id] = el('button', { class: 'tab' + (id === 'objectives' ? ' tab-obj' : ''), onclick: () => show(id) }, label);
      nav.append(tabs[id]);
    }

    function refreshChrome() {
      for (const id of gated) {
        tabs[id].disabled = !started();
        tabs[id].title = started() ? '' : 'Begin the investigation first';
      }
      tabs.debrief.style.display = finished() ? '' : 'none';
      tabs.guide.style.display = walk() ? '' : 'none';
      tabs.objectives.innerHTML = '';
      tabs.objectives.append('Objectives', el('span', { class: 'dot' }, `${doneCount()}/${qs.length}`));
      finishBtn.style.display = started() && !finished() ? '' : 'none';
      restartBtn.style.display = started() ? '' : 'none';
      scoreEl.lastChild.textContent = `${score()}/${total}`;
      tick();
    }

    function tick() {
      const span = timerEl.lastChild;
      timerEl.classList.remove('over');
      if (!started()) { span.textContent = S.timebox ? fmtClock(S.timebox * 60) : '--:--'; timerEl.firstChild.textContent = 'Timebox'; return; }
      const e = elapsed();
      if (S.timebox) {
        const left = S.timebox * 60 - e;
        if (left >= 0) { span.textContent = fmtClock(left); timerEl.firstChild.textContent = finished() ? 'Left at end' : 'Time left'; }
        else { span.textContent = '+' + fmtClock(-left); timerEl.firstChild.textContent = 'Over time'; timerEl.classList.add('over'); }
      } else { span.textContent = fmtClock(e); timerEl.firstChild.textContent = 'Elapsed'; }
    }
    setInterval(tick, 1000);

    function setObjHidden(h) {
      app.classList.toggle('objhide', h);
      store('weekly-sec:objhide', h || null);
      if (views.logs && current === 'logs') views.logs.runQuery(views.logs.root.querySelector('textarea').value); // re-fit the table
    }
    let current = null;
    function show(id) {
      if (id === 'objectives' && matchMedia('(min-width: 1101px)').matches) { setObjHidden(!app.classList.contains('objhide')); return; }
      if (id === 'objectives') { app.classList.toggle('objopen'); tabs.objectives.classList.toggle('on', app.classList.contains('objopen')); return; }
      app.classList.remove('objopen');
      tabs.objectives.classList.remove('on');
      if (!tabs[id] || tabs[id].disabled) return;
      current = id;
      for (const k in tabs) tabs[k].classList.toggle('on', k === id);
      if (!views[id] || !['logs', 'evidence'].includes(id)) views[id] = id.startsWith('board-') ? boardView(qs.find((q) => `board-${q.id}` === id)) : build[id]();
      view.innerHTML = '';
      view.append(views[id].root || views[id]);
      view.scrollTop = 0;
      if (views[id].focus) views[id].focus();
      store(`${KEY}:tab`, id);
    }
    // re-render the current view if it shows state that just changed
    const rerender = () => { if (current && (current.startsWith('board-') || current === 'notebook' || current === 'guide')) { const y = view.scrollTop; show(current); view.scrollTop = y; } };

    // ---------- views ----------
    const build = {
      briefing() {
        const wrap = el('div', { class: 'prose' });
        wrap.append(
          el('h1', null, ch.title),
          el('p', { class: 'sub' }, ch.subtitle || ''),
          el('div', { class: 'meta' },
            [ch.angle, ch.task, ch.difficulty, ch.minutes && `${ch.minutes} min`].filter(Boolean).map((x) => el('span', { class: 'pill' }, x)),
            (ch.skills || []).map((x) => el('span', { class: 'pill' }, x))));
        if (!started()) wrap.append(startCard());
        wrap.append(mdEl(ch.briefing));
        if (!started()) wrap.append(el('div', { style: 'margin-top:28px' }, el('button', { class: 'btn primary', onclick: () => { wrap.querySelector('.start').scrollIntoView({ behavior: 'smooth' }); } }, 'Ready? Back to the top to begin ↑')));
        return wrap;
      },
      logs() { return LogView(logs, { id: ch.id, columns: ch.columns, examples: ch.examples }); },
      evidence() {
        const list = el('div', { class: 'ev-list' }, el('h4', null, 'Evidence'));
        const viewer = el('div', { class: 'ev-view' });
        const items = (ch.evidence || []).map((f, i) => {
          const b = el('button', { class: 'ev-item', onclick: () => open(i) }, el('b', null, f.label || f.path), el('span', null, f.note || ''));
          list.append(b);
          return b;
        });
        function open(i) {
          const f = ch.evidence[i];
          items.forEach((b, j) => b.classList.toggle('on', i === j));
          viewer.innerHTML = '';
          viewer.append(el('h3', null, f.label || f.path), el('p', null, `${f.path}${f.note ? ' · ' + f.note : ''}`), el('pre', null, f.content));
        }
        if (items.length) open(0);
        else viewer.append(el('div', { class: 'empty' }, 'No evidence files for this challenge.'));
        return el('div', { class: 'ev' }, list, viewer);
      },
      notebook() {
        const ta = el('textarea', { placeholder: 'Working notes, hypotheses, indicators, timeline… Saved automatically.\n\nTip: when you get stuck, write down where and why before you open a hint.' });
        ta.value = S.notes;
        ta.addEventListener('input', () => { S.notes = ta.value; save(); });
        const acts = el('div');
        if (!S.log.length) acts.append(el('div', { class: 'locked' }, 'Hints, wrong answers and other events will appear here.'));
        for (const a of S.log) {
          const cls = { wrong: 'no', solved: 'ok', hint: 'h', reveal: 'h', unlock: 'h', guide: 'h' }[a.type] || '';
          acts.append(el('div', { class: 'act ' + cls }, el('time', null, fmtClock(a.t)), el('span', null, a.text)));
        }
        return el('div', { class: 'nb' },
          el('div', { class: 'row', style: 'justify-content:space-between' },
            el('h3', { style: 'margin:0' }, 'Notebook'),
            el('div', { class: 'row' },
              el('button', { class: 'btn sm', onclick: () => download(`${ch.id}-notebook.md`, summary()) }, 'Download .md'))),
          el('p', { class: 'locked' }, 'Stays in this browser. Downloaded with your debrief summary.'),
          ta, el('h3', null, 'Activity'), acts);
      },
      debrief() { return debriefView(); },
      guide() { return guideView(); },
    };

    // ---------- guidance: queries that run straight into Logs ----------
    function runInLogs(q) {
      show('logs');
      views.logs.runQuery(q);
      logEvent('query', `Ran a suggested query: ${q.split('\n')[0].slice(0, 90)}`);
    }
    function queryBox(q) {
      return el('div', { class: 'qrun' }, el('code', null, q), el('button', { class: 'btn sm', onclick: () => runInLogs(q) }, 'Run in Logs'));
    }

    // Walkthrough: one section per objective, opened at the one you're on; steps open one at a time.
    let guideFocus = null;
    function openGuide(q) { guideFocus = q ? q.id : null; show('guide'); }
    function guideView() {
      const cur = qs.find((q) => q.id === guideFocus) || qs.find((q) => !resolved(q)) || qs[0];
      guideFocus = null;
      const wrap = el('div', { class: 'prose guide' },
        el('h1', null, 'Walkthrough'),
        el('p', { class: 'sub' }, 'It follows your progress and opens at the objective you’re on. Open one step at a time, and only when you need it. Every query runs straight into Logs.'));
      let curSec = null;
      for (const q of qs) {
        const steps = q.guide || [];
        const n = finished() ? steps.length : Math.min(S.steps[q.id] || 0, steps.length);
        const status = S.solved[q.id] !== undefined ? '✓ done' : S.revealed[q.id] ? 'revealed' : n ? `step ${n} of ${steps.length}` : `${steps.length} steps`;
        const sec = el('details', { class: 'stage' + (resolved(q) ? ' done' : ''), open: q === cur },
          el('summary', null, el('span', { class: 'qn' }, Q(q)), el('span', { class: 'qt' }, q.short || ''), el('span', { class: 'st' }, status)));
        sec.append(el('p', { class: 'prompt' }, q.prompt));
        for (let i = 0; i < n; i++) {
          const st = steps[i];
          sec.append(el('div', { class: 'step' }, el('b', null, `Step ${i + 1}`), el('div', { html: inline(unsealT(st.text)) }), st.query ? queryBox(unsealT(st.query)) : null));
        }
        const row = el('div', { class: 'row', style: 'margin-top:10px' });
        if (live(q) && n < steps.length) row.append(el('button', { class: 'btn primary sm', onclick: () => {
          S.steps[q.id] = n + 1; save();
          logEvent('guide', `${Q(q)} walkthrough step ${n + 1} of ${steps.length}`, q.id);
          guideFocus = q.id; rerender(); renderObjectives();
        } }, n ? 'Next step →' : 'Show the first step →'));
        else if (live(q) && steps.length) row.append(el('span', { class: 'locked' }, 'That’s every step. Answer it in Objectives.'));
        if (q.kind === 'rank') row.append(el('button', { class: 'btn sm', onclick: () => show(`board-${q.id}`) }, 'Open the board'));
        sec.append(row);
        wrap.append(sec);
        if (q === cur) curSec = sec;
      }
      if (curSec) setTimeout(() => curSec.scrollIntoView({ block: 'start' }), 0);
      return wrap;
    }

    function startCard() {
      let mode = S.mode, tb = S.timebox, guide = S.guide;
      const cm = el('button', { class: 'choice', onclick: () => pick('challenge') }, el('b', null, 'Challenge mode'), el('span', null, 'Hints locked. Solve it cold. (You can still unlock hints later; it gets recorded.)'));
      const gm = el('button', { class: 'choice', onclick: () => pick('guided') }, el('b', null, 'Guided mode'), el('span', null, 'Help whenever you want it. Best if this topic is new to you.'));
      const gh = el('button', { class: 'choice', onclick: () => pickG('hints') }, el('b', null, 'Deeper hints'),
        el('span', null, 'Work it out yourself. Each question has hints that get more specific, ending with the exact query to run. Each hint costs points.'));
      const gw = el('button', { class: 'choice', onclick: () => pickG('walkthrough') }, el('b', null, 'Walkthrough'),
        el('span', null, 'Step-by-step guidance that follows your progress: what to look for next on the objective you’re on, and the query to run. No points are taken for steps, and your score is marked as a walkthrough.'));
      const sub = el('div', null, el('p', { class: 'locked', style: 'margin:4px 0 0' }, 'How much help do you want?'), el('div', { class: 'choices' }, gh, gw));
      function pick(m) { mode = m; cm.classList.toggle('on', m === 'challenge'); gm.classList.toggle('on', m === 'guided'); sub.style.display = m === 'guided' ? '' : 'none'; }
      function pickG(g) { guide = g; gh.classList.toggle('on', g === 'hints'); gw.classList.toggle('on', g === 'walkthrough'); }
      pick(mode); pickG(guide);
      const sel = el('select', { onchange: () => { tb = Number(sel.value); } },
        [[45, '45 minutes'], [60, '60 minutes'], [90, '90 minutes'], [120, '2 hours'], [0, 'No timebox']].map(([v, l]) => el('option', { value: String(v) }, l)));
      sel.value = String(tb);
      return el('div', { class: 'card start' },
        el('h3', null, 'Before you start'),
        el('div', { class: 'locked' }, 'Read the briefing below as long as you like: the clock starts only when you begin. The logs and evidence unlock then.'),
        el('div', { class: 'choices' }, cm, gm), sub,
        el('div', { class: 'row' },
          el('label', null, 'Timebox ', sel),
          el('span', { class: 'sp' }),
          el('button', { class: 'btn primary', onclick: () => {
            S.mode = mode; S.guide = guide; S.timebox = tb; S.startedAt = now(); save();
            logEvent('start', `Started in ${modeLabel()} mode${tb ? `, ${tb}-minute timebox` : ', no timebox'}`);
            refreshChrome(); renderObjectives();
            if (walk()) openGuide(); else show('logs');
            toast(walk() ? 'Clock started. The Guide tab walks you through it.' : 'Clock started. Good hunting.');
          } }, 'Begin investigation →')));
    }
    async function switchToWalkthrough() {
      const r = await dialog({ title: 'Switch to the walkthrough?', body: 'You’ll get step-by-step guidance with queries for each objective. Your score is marked as a walkthrough from here on.', confirm: 'Switch' });
      if (!r) return;
      S.mode = 'guided'; S.guide = 'walkthrough'; if (!S.hintsUnlockedAt) S.hintsUnlockedAt = now(); save();
      logEvent('unlock', 'Switched to the walkthrough');
      renderObjectives(); openGuide();
    }

    // ---------- objectives ----------
    function renderObjectives() {
      obj.innerHTML = '';
      const pct = Math.round((doneCount() / qs.length) * 100);
      const head = el('div', { class: 'objhead' },
        el('h2', null, el('span', null, 'Objectives',
          el('button', { class: 'link hide', title: 'Hide this panel for more room. Bring it back with the Objectives tab.', onclick: () => setObjHidden(true) }, 'hide ›')),
          el('span', { class: 'qp' }, `${score()} / ${total} pts`)),
        el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
        el('p', null, finished() ? 'Investigation over. Answers are shown below.'
          : !started() ? 'Read the briefing, then begin to start answering.'
          : `${doneCount()} of ${qs.length} done · ${walk() ? 'walkthrough mode' : 'hints and misses cost the points shown'}`),
        started() && !finished() && !walk() && hintsOn() && qs.some((q) => (q.guide || []).length)
          ? el('button', { class: 'link', style: 'font-size:12.5px', onclick: switchToWalkthrough }, 'Want step-by-step guidance instead? Switch to the walkthrough') : null);
      const list = el('div', { class: 'qs' });
      for (const q of qs) list.append(qCard(q));
      obj.append(head, list);
      refreshChrome();
    }

    function solve(q, value, msg) {
      S.solved[q.id] = value; save();
      logEvent('solved', `${Q(q)} solved: ${value}`, q.id);
      toast(`${Q(q)} ${msg || 'correct'} · +${Math.max(0, q.points - penalty(q))} pts`);
      afterChange();
    }
    function miss(q, text, why) {
      S.wrong[q.id] = (S.wrong[q.id] || 0) + 1; save();
      logEvent('wrong', `${Q(q)} ${text}${q.wrongCost ? ` (−${q.wrongCost})` : ''}${why ? ` · told: ${why}` : ''}`, q.id);
    }
    function afterChange() {
      if (!finished() && qs.every(resolved)) {
        S.finishedAt = now(); save();
        logEvent('finish', `All objectives done · ${score()}/${total}`);
        renderObjectives(); show('debrief');
        toast('All objectives done. Here’s how you did.');
        return;
      }
      renderObjectives(); rerender();
    }

    function qCard(q) {
      const solved = S.solved[q.id] !== undefined, revealed = !!S.revealed[q.id];
      const card = el('div', { class: 'q' + (solved ? ' solved' : '') + (revealed ? ' revealed' : '') });
      const sc = qScore(q);
      const pts = sc !== null ? `${sc}/${q.points}` : `${q.points} pts${penalty(q) ? ` (−${penalty(q)})` : ''}`;
      card.append(el('div', { class: 'qh' }, el('span', { class: 'qn' }, Q(q)), el('span', { class: 'qt' }, q.short || ''), el('span', { class: 'qp' }, pts)));
      card.append(el('p', { class: 'prompt' }, q.prompt));
      if (q.kind === 'rank') rankCard(q, card);
      else if (q.kind === 'choice') choiceCard(q, card);
      else answerCard(q, card);

      // hints
      const used = S.hints[q.id] || 0;
      const hints = q.hints || [];
      if (walk() && (q.guide || []).length && live(q)) {
        const n = S.steps[q.id] || 0;
        card.append(el('div', { class: 'hrow', style: 'margin-top:10px' },
          el('button', { class: 'hbtn', onclick: () => openGuide(q) }, n ? `Walkthrough · step ${n} of ${q.guide.length} →` : 'Walk me through this →')));
      } else if (hints.length) {
        const box = el('div', { class: 'hints' });
        for (let i = 0; i < used; i++) box.append(el('div', { class: 'hint' }, el('b', null, `Hint ${i + 1} · −${hints[i].cost}`), el('span', { html: inline(unsealT(hints[i].text)) }),
          hints[i].query ? queryBox(unsealT(hints[i].query)) : null));
        if (live(q) && used < hints.length) {
          if (hintsOn()) {
            box.append(el('div', { class: 'hrow' },
              el('button', { class: 'hbtn', onclick: () => takeHint(q, used) }, `Hint ${used + 1} · −${hints[used].cost} pts`),
              el('span', { class: 'locked' }, `${hints.length - used} left`)));
          } else {
            box.append(el('div', { class: 'hrow' }, el('span', { class: 'locked' }, 'Hints are locked in challenge mode.'),
              el('button', { class: 'link', onclick: unlockHints }, 'Unlock hints')));
          }
        }
        card.append(box);
      }
      if (live(q)) {
        card.append(el('div', { class: 'qfoot' },
          el('span', { class: 'locked' }, q.wrongCost ? `Each wrong check −${q.wrongCost}` : ''),
          el('button', { class: 'link', style: 'color:var(--muted)', onclick: () => reveal(q) }, 'Give up and reveal answer')));
      }
      return card;
    }

    function answerCard(q, card) {
      const fb = el('div', { class: 'fb' });
      if (S.solved[q.id] !== undefined) { fb.className = 'fb ok'; fb.textContent = `✓ ${S.solved[q.id]}`; card.append(fb); return; }
      if (S.revealed[q.id]) { card.append(el('div', { class: 'answer' }, 'Revealed: ', unsealT(q.answer))); return; }
      if (finished()) { card.append(el('div', { class: 'answer' }, 'Answer: ', unsealT(q.answer))); return; }
      const inp = el('input', { type: 'text', placeholder: q.placeholder || 'your answer', disabled: !started(), spellcheck: 'false' });
      const check = () => {
        const v = inp.value.trim();
        if (!v) return;
        if (q.hashes.includes(answerHash(ch.salt, q.id, v))) return solve(q, v);
        logEvent('wrong', `${Q(q)} wrong answer: ${v}`, q.id);
        fb.className = 'fb no'; fb.textContent = '✗ Not quite. Logged in your notebook.';
        card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
      card.append(el('div', { class: 'ans' }, inp, el('button', { class: 'btn primary sm', disabled: !started(), onclick: check }, 'Check')), fb);
    }

    // ---------- choice: pick one; every wrong option explains itself ----------
    function choiceCard(q, card) {
      const picks = S.picks[q.id] || (S.picks[q.id] = []);
      const done = resolved(q) || finished();
      const key = done || picks.length ? keyOf(q) : null;
      const box = el('div', { class: 'opts' });
      q.options.forEach((o, i) => {
        const wrongPick = picks.includes(o.id);
        const isRight = done && key.correct === o.id;
        const b = el('button', { class: 'opt' + (wrongPick ? ' no' : '') + (isRight ? ' ok' : ''), disabled: !live(q) || wrongPick,
          onclick: () => {
            const k = keyOf(q);
            if (o.id === k.correct) return solve(q, o.text.length > 60 ? o.text.slice(0, 57) + '…' : o.text);
            picks.push(o.id); save();
            miss(q, `wrong choice: ${o.text}`, k.why[o.id]);
            renderObjectives();
            const c = obj.querySelector(`[data-q="${q.id}"]`);
            if (c) { c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); }
          } }, el('i', null, String.fromCharCode(65 + i)), el('span', null, o.text));
        box.append(b);
      });
      card.dataset.q = q.id;
      card.append(box);
      if (done) {
        card.append(el('div', { class: 'why ok', html: inline(`${S.revealed[q.id] ? '**Revealed.** ' : S.solved[q.id] === undefined ? '**Answer.** ' : '**Correct.** '}${key.why[key.correct]}`) }));
      } else if (picks.length) {
        card.append(el('div', { class: 'why no', html: inline(`**✗ Not that one.** ${key.why[picks[picks.length - 1]]}`) }));
      }
    }

    // ---------- rank: the card summarises, the board (its own tab) is where you play ----------
    function boardState(q) {
      const ids = q.items.map((t) => t.id);
      let st = S.boards[q.id];
      const have = st ? [...st.pool, ...st.plan, ...st.dont].sort().join() : '';
      if (have !== ids.slice().sort().join()) st = S.boards[q.id] = { pool: ids.slice(), plan: [], dont: [] };
      return st;
    }
    function rankCard(q, card) {
      const st = boardState(q);
      const go = el('button', { class: 'btn sm' + (live(q) ? ' primary' : ''), disabled: !started(), onclick: () => show(`board-${q.id}`) },
        live(q) ? 'Open the planning board →' : 'View the board →');
      if (S.solved[q.id] !== undefined) card.append(el('div', { class: 'fb ok' }, `✓ Plan accepted${S.wrong[q.id] ? ` after ${plural(S.wrong[q.id], 'failed check')}` : ' first time'}`));
      else if (S.revealed[q.id]) card.append(el('div', { class: 'fb' }, 'Revealed. The board shows a correct plan.'));
      else if (finished()) card.append(el('div', { class: 'fb' }, 'Not finished. The board shows a correct plan.'));
      else if (started()) {
        card.append(el('div', { class: 'locked' }, `${q.items.length - st.pool.length} of ${q.items.length} actions placed${S.wrong[q.id] ? ` · ${plural(S.wrong[q.id], 'failed check')}` : ''}`));
        if (S.fb[q.id]) card.append(el('div', { class: 'why no', html: inline(`**✗ Last check:** ${S.fb[q.id].why}`) }));
      }
      card.append(el('div', { style: 'margin-top:8px' }, go));
    }

    function boardView(q) {
      const st = boardState(q);
      const done = resolved(q) || finished();
      const key = done ? keyOf(q) : null;
      const byId = Object.fromEntries(q.items.map((t) => [t.id, t]));
      // once it's over, show the player's accepted plan, or a correct one
      const shown = !done ? st : S.solved[q.id] !== undefined ? st
        : { pool: [], plan: key.order.slice(), dont: q.items.map((t) => t.id).filter((id) => key.items[id].exclude) };
      const root = el('div', { class: 'board' + (done ? ' locked' : '') });
      const LANES = [
        ['pool', 'Actions', 'Every action goes somewhere: in the plan or under Don’t do.', 'All placed. Check your plan.'],
        ['plan', 'Your plan', 'Top = first. Drag to reorder.', 'Drag actions here, in the order you’d do them.'],
        ['dont', 'Don’t do', 'Actions that are wrong, wasteful or harmful here.', 'Drag actions here that you wouldn’t do.'],
      ];
      const lists = {};
      const lanesEl = el('div', { class: 'lanes' }, LANES.filter(([id]) => !(done && id === 'pool')).map(([id, title, help, empty]) => {
        lists[id] = el('div', { class: 'll', 'data-lane': id, 'data-empty': empty });
        return el('div', { class: `lane ${id}` }, el('h3', null, title, el('span', null, String(shown[id].length))), el('p', null, help), lists[id]);
      }));

      function move(id, lane, idx) {
        for (const l of ['pool', 'plan', 'dont']) { const i = st[l].indexOf(id); if (i >= 0) st[l].splice(i, 1); }
        st[lane].splice(idx === undefined ? st[lane].length : Math.max(0, Math.min(idx, st[lane].length)), 0, id);
        save(); paint();
      }
      function tile(id, lane, i) {
        const t = byId[id];
        const ctl = el('span', { class: 'ctl' });
        const b = (label, title, fn) => el('button', { title, onclick: fn }, label);
        if (!done) {
          if (lane === 'pool') ctl.append(b('Plan', 'Add to the end of your plan', () => move(id, 'plan')), b('Don’t', 'Move to Don’t do', () => move(id, 'dont')));
          if (lane === 'plan') ctl.append(b('↑', 'Move up', () => move(id, 'plan', i - 1)), b('↓', 'Move down', () => move(id, 'plan', i + 1)), b('✕', 'Back to Actions', () => move(id, 'pool')));
          if (lane === 'dont') ctl.append(b('✕', 'Back to Actions', () => move(id, 'pool')));
        }
        const tx = el('span', { class: 'tx' }, t.text);
        if (done) tx.append(el('small', { html: inline(key.items[id].why) }));
        return el('div', { class: 'tile' + (done ? ' good' : ''), 'data-id': id },
          done ? null : el('span', { class: 'grip', title: 'Drag' }, '⋮⋮'),
          lane === 'plan' ? el('span', { class: 'n' }, `${i + 1}.`) : null, tx, ctl);
      }
      function paint() {
        for (const [id] of LANES) {
          if (!lists[id]) continue;
          lists[id].innerHTML = '';
          shown[id].forEach((tid, i) => lists[id].append(tile(tid, id, i)));
          lists[id].parentNode.querySelector('h3 span').textContent = String(shown[id].length);
        }
        if (checkBtn) checkBtn.disabled = st.pool.length > 0;
        if (status) status.textContent = st.pool.length ? `${plural(st.pool.length, 'action')} still to place` : 'Ready to check';
      }

      // drag and drop (mouse: drag the tile; touch: drag the ⋮⋮ grip so the page still scrolls)
      let drag = null;
      root.addEventListener('pointerdown', (e) => {
        const t = e.target.closest('.tile');
        if (done || !t || e.target.closest('button') || e.button > 0) return;
        if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return;
        e.preventDefault();
        drag = { t, x0: e.clientX, y0: e.clientY, on: false };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
      function onMove(e) {
        if (!drag) return;
        if (!drag.on) {
          if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
          const r = drag.t.getBoundingClientRect();
          drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top;
          drag.ghost = drag.t.cloneNode(true);
          drag.ghost.classList.add('ghost');
          drag.ghost.style.width = r.width + 'px';
          document.body.append(drag.ghost);
          drag.t.classList.add('holder');
          drag.on = true;
        }
        drag.ghost.style.left = e.clientX - drag.dx + 'px';
        drag.ghost.style.top = e.clientY - drag.dy + 'px';
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const list = under && (under.closest('.ll') || (under.closest('.lane') && under.closest('.lane').querySelector('.ll')));
        if (list && root.contains(list)) {
          const sibs = [...list.children].filter((c) => c !== drag.t);
          const before = sibs.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
          if (before) list.insertBefore(drag.t, before); else list.append(drag.t);
        }
        const vr = view.getBoundingClientRect();
        if (e.clientY < vr.top + 50) view.scrollTop -= 14;
        else if (e.clientY > vr.bottom - 50) view.scrollTop += 14;
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (drag && drag.on) {
          drag.ghost.remove();
          for (const id of ['pool', 'plan', 'dont']) st[id] = [...lists[id].children].map((c) => c.dataset.id);
          save(); paint();
        }
        drag = null;
      }

      let checkBtn = null, status = null;
      const res = el('div', { class: 'bres' });
      root.append(el('h1', null, q.short || 'Plan'), el('p', { class: 'sub' }, q.prompt));
      if (!done) {
        checkBtn = el('button', { class: 'btn primary', onclick: check }, 'Check plan');
        status = el('span', { class: 'locked' });
        root.append(lanesEl, el('div', { class: 'bfoot' }, checkBtn, status, el('span', { class: 'sp' }),
          el('span', { class: 'locked' }, `${q.points} pts${q.wrongCost ? ` · each failed check −${q.wrongCost}` : ''}${penalty(q) ? ` · −${penalty(q)} so far` : ''}`)), res);
        if (S.fb[q.id]) res.append(el('div', { class: 'why no', html: inline(`**✗ Last check: ${plural(S.fb[q.id].n, 'thing')} to fix.** Here’s one: ${S.fb[q.id].why}`) }));
      } else {
        const head = S.solved[q.id] !== undefined ? '**✓ Plan accepted.** Here’s why each step sits where it does.'
          : '**A correct plan** (other orders can also be right). Here’s why each step sits where it does.';
        root.append(el('div', { class: 'why ok', style: 'margin-bottom:14px;max-width:780px', html: inline(head) }), lanesEl);
      }
      paint();

      function check() {
        if (st.pool.length) return toast('Place every action first.');
        const k = keyOf(q);
        const r = judgeRank(k, st.plan, st.dont);
        if (r.ok) { delete S.fb[q.id]; return solve(q, `${st.plan.length}-step plan`, 'plan accepted'); }
        const first = r.problems[0];
        S.fb[q.id] = { n: r.problems.length, why: first.why };
        miss(q, `plan rejected, ${plural(r.problems.length, 'problem')}`, first.why);
        renderObjectives(); rerender();
        const b = view.querySelector('.bres');
        if (b) { b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }
      }
      return root;
    }

    async function takeHint(q, i) {
      const h = q.hints[i];
      const r = await dialog({
        title: `${Q(q)} · Hint ${i + 1} costs ${h.cost} points`,
        body: 'Before you open it: where exactly are you stuck, and what have you tried? Writing it down is half the learning. It goes into your notebook.',
        note: 'I’m stuck because…', confirm: `Open hint (−${h.cost})`,
      });
      if (!r) return;
      S.hints[q.id] = i + 1; save();
      logEvent('hint', `${Q(q)} hint ${i + 1} opened (−${h.cost})${r.note ? ` · stuck: ${r.note}` : ''}`, q.id);
      if (r.note) { S.notes += `${S.notes && !S.notes.endsWith('\n') ? '\n' : ''}[${fmtClock(elapsed())}] Stuck on ${Q(q)}: ${r.note}\n`; save(); }
      renderObjectives();
    }
    async function unlockHints() {
      const r = await dialog({ title: 'Unlock hints?', body: 'You’ll switch from challenge mode to guided mode for the rest of this attempt. Your debrief records when you switched.', confirm: 'Unlock hints' });
      if (!r) return;
      S.hintsUnlockedAt = now(); save();
      logEvent('unlock', 'Unlocked hints (switched to guided mode)');
      renderObjectives();
    }
    async function reveal(q) {
      const r = await dialog({ title: `Reveal the answer to ${Q(q)}?`, body: `You’ll score 0 of ${q.points} on this question. It's logged as given up.`, confirm: 'Reveal answer', danger: true, note: 'What were you missing? (optional)' });
      if (!r) return;
      S.revealed[q.id] = true; save();
      logEvent('reveal', `${Q(q)} answer revealed${r.note ? ` · ${r.note}` : ''}`, q.id);
      afterChange();
      if (q.kind === 'rank' && !finished()) show(`board-${q.id}`);
    }

    async function endEarly() {
      const open = qs.filter((q) => !resolved(q));
      const r = await dialog({
        title: 'End the investigation now?',
        body: open.length ? `${open.map(Q).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open and will score 0. The clock stops, every answer is shown, and you’ll see your score and the full story of what happened.`
          : 'The clock stops and you’ll see your score and the full story of what happened.',
        confirm: 'End and see my score',
      });
      if (!r) return;
      S.finishedAt = now(); save();
      logEvent('finish', `Ended early · ${score()}/${total}${open.length ? ` · open: ${open.map(Q).join(', ')}` : ''}`);
      renderObjectives(); show('debrief');
    }

    async function startOver() {
      const r = await dialog({ title: 'Start over?', body: 'This clears your answers, hints, board, notebook and score for this challenge in this browser, and takes you back to the start screen.', confirm: 'Clear and restart', danger: true });
      if (!r) return;
      store(KEY, null); store(`weekly-sec:solved:${ch.id}`, null); store(`${KEY}:tab`, null);
      S = fresh(); save(); location.reload();
    }

    // ---------- score screen ----------
    function resultOf(q) {
      if (S.solved[q.id] !== undefined) return q.kind === 'rank' ? '✓ plan accepted' : q.kind === 'choice' ? '✓ correct' : '✓ solved';
      return S.revealed[q.id] ? 'gave up' : 'not answered';
    }
    function summary() {
      const lines = [`# weekly-sec debrief: ${ch.week ? ch.week + ' · ' : ''}${ch.title}`, ''];
      lines.push(`- Mode: ${modeLabel()}${S.hintsUnlockedAt ? ` (switched at ${fmtClock((S.hintsUnlockedAt - S.startedAt) / 1000)})` : ''}`);
      lines.push(`- Timebox: ${S.timebox ? S.timebox + ' min' : 'none'} · time used: ${fmtClock(elapsed())}`);
      lines.push(`- Score: ${score()}/${total}${finished() ? '' : ' (in progress)'}`, '');
      lines.push('| Q | Result | Hints | Misses | Score |', '|---|---|---|---|---|');
      for (const q of qs) {
        const res = S.solved[q.id] !== undefined && q.kind === 'answer' ? `solved: ${S.solved[q.id]}` : resultOf(q);
        const sc = qScore(q);
        lines.push(`| ${Q(q)} | ${res.replace(/\|/g, '\\|')} | ${S.hints[q.id] || 0} (−${hintCost(q)}) | ${S.wrong[q.id] || 0}${missCost(q) ? ` (−${missCost(q)})` : ''} | ${sc === null ? '–' : sc}/${q.points} |`);
      }
      for (const q of boardQs) {
        const st = boardState(q), byId = Object.fromEntries(q.items.map((t) => [t.id, t.text]));
        lines.push('', `## ${Q(q)} final board`, '', ...st.plan.map((id, i) => `${i + 1}. ${byId[id]}`));
        if (st.dont.length) lines.push('', 'Don’t do:', ...st.dont.map((id) => `- ${byId[id]}`));
        if (st.pool.length) lines.push('', 'Unplaced:', ...st.pool.map((id) => `- ${byId[id]}`));
      }
      lines.push('', '## Activity', '');
      for (const a of S.log) lines.push(`- ${fmtClock(a.t)} ${a.text}`);
      lines.push('', '## Notebook', '', S.notes || '(empty)');
      return lines.join('\n');
    }
    function download(name, text) {
      const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name });
      document.body.append(a); a.click(); a.remove();
    }
    function copy(text) {
      const done = () => toast('Copied to clipboard');
      const fallback = () => {
        const t = el('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed: use Download instead'); }
        t.remove();
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    }

    function debriefView() {
      const wrap = el('div', { class: 'prose' });
      const s = score();
      const band = walk() ? 'Walkthrough run. Next time, try Deeper hints or Challenge mode to test yourself.' : s >= 85 ? 'You could run this incident.' : s >= 60 ? 'Solid work. Read what happened below to see what you missed.' : 'Read the full story below closely, then try another one.';
      const rows = qs.map((q) => {
        const sc = qScore(q);
        return el('tr', null, el('td', null, Q(q)), el('td', null, q.short || ''), el('td', null, resultOf(q)),
          el('td', null, String(S.hints[q.id] || 0)), el('td', null, String(S.wrong[q.id] || 0)), el('td', null, sc === null ? '0' : `${sc}/${q.points}`));
      });
      wrap.append(
        el('h1', null, 'Score'),
        el('p', { class: 'sub' }, `${ch.week ? ch.week + ' · ' : ''}${ch.title} · ${modeLabel()} mode · ${fmtClock(elapsed())} used${S.timebox ? ` of ${S.timebox}:00` : ''}`),
        el('p', { class: 'score-big' }, String(s), el('small', null, ` / ${total}`)),
        el('p', null, band),
        el('div', { class: 'tw' }, el('table', { class: 'sumtab' },
          el('thead', null, el('tr', null, ['', 'Objective', 'Result', 'Hints', 'Misses', 'Score'].map((h) => el('th', null, h)))),
          el('tbody', null, rows))),
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('button', { class: 'btn primary', onclick: () => copy(summary()) }, 'Copy summary for a debrief'),
          el('button', { class: 'btn', onclick: () => download(`${ch.id}-debrief.md`, summary()) }, 'Download .md')),
        el('p', { class: 'locked', style: 'margin-top:8px' }, 'The summary has your score, hints, misses, final plan and notebook. Share it with a mentor or study group to talk it through.'));
      if (ch.inspiredBy) {
        let refs = [];
        try { refs = JSON.parse(unsealT(ch.inspiredBy)); } catch (e) { /* older build */ }
        if (refs.length) wrap.append(el('div', { class: 'refs' },
          el('h2', null, 'Inspired by real incidents'),
          el('p', null, 'The company and the data are made up. The attack isn’t: every step of it has happened for real. These write-ups show how.'),
          el('ul', null, refs.map((r) => el('li', null,
            el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.title),
            el('span', { class: 'src' }, [r.source, r.date].filter(Boolean).join(' · ')),
            el('p', null, r.note))))));
      }
      if (ch.solution) wrap.append(el('div', { class: 'story' }, mdEl(unsealT(ch.solution))));
      wrap.append(el('hr'), el('button', { class: 'btn danger', onclick: startOver }, 'Start over'));
      return wrap;
    }

    document.body.innerHTML = '';
    document.body.append(app);
    const syncTop = () => app.style.setProperty('--toph', app.firstChild.offsetHeight + 'px');
    syncTop();
    window.addEventListener('resize', syncTop);
    document.title = `${ch.week ? ch.week + ' · ' : ''}${ch.title} · weekly-sec`;
    if (store('weekly-sec:objhide')) app.classList.add('objhide');
    renderObjectives();
    const last = store(`${KEY}:tab`);
    show(!started() ? 'briefing' : finished() ? 'debrief' : last && last !== 'objectives' && tabs[last] && !tabs[last].disabled ? last : 'logs');
  }

  // ====================================================================
  // Standalone explorer (no challenge): load any JSON log file
  // ====================================================================

  function LogsOnly(logs, title) {
    const lv = LogView(logs, {});
    document.body.innerHTML = '';
    document.body.append(el('div', { class: 'app' },
      el('header', { class: 'top' }, el('div', { class: 'brand' }, el('span', { class: 'wk' }, 'explorer'), el('b', null, title || 'Log explorer')),
        el('span', { class: 'sp' }), el('span', { class: 'locked' }, `${logs.length.toLocaleString()} events`)),
      el('div', { class: 'body', style: 'grid-template-columns:minmax(0,1fr)' }, el('main', { class: 'view' }, lv.root))));
    lv.focus();
  }

  function Loader() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    const msg = el('p', { class: 'err' });
    const drop = el('div', { class: 'drop' },
      el('p', null, el('b', null, 'No log set loaded.')),
      el('p', null, 'To play a challenge, open its play.html. To explore any JSON log file, drop it here: an array of events, or {"logs": [...]}.'),
      input);
    const load = (file) => file.text().then((t) => {
      try {
        const data = JSON.parse(t);
        const logs = Array.isArray(data) ? data : data.logs;
        if (!Array.isArray(logs)) throw new Error('expected an array of events');
        LogsOnly(logs, file.name);
      } catch (e) { msg.textContent = `Could not load ${file.name}: ${e.message}`; }
    });
    input.addEventListener('change', () => input.files[0] && load(input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('on'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('on'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
    document.body.innerHTML = '';
    document.body.append(el('div', { class: 'prose' }, el('h1', null, 'weekly-sec log explorer'), drop, msg));
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const ch = global.WEEKLY_SEC_CHALLENGE;
    const logs = global.WEEKLY_SEC_LOGS;
    if (ch) Game(ch, Array.isArray(logs) ? logs : []);
    else if (Array.isArray(logs)) LogsOnly(logs, global.WEEKLY_SEC_META && global.WEEKLY_SEC_META.title);
    else Loader();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
