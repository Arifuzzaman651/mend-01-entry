// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const byteOrd = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A file as lines: its own line break, its lines, and whether it ends with a line break. */
interface FileModel {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBr: false };
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One line of a hunk or chunk body: context, old-only, or new-only. `backslash` marks a `\` line after it. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash?: boolean;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in `file` at `tier`, at or after `from`. */
function occurrences(O: string[], file: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, file[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(O: string[], file: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, file, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the lines that replace a match: context lines come from the file's own matched lines, and at tier 2
 * every other line is re-indented (P, the leading whitespace of O's first line, replaced by F, that of the
 * file's first matched line) when it is not empty, not only whitespace, and starts with P.
 */
function buildReplacement(items: BodyItem[], fileLines: string[], at: number, tier: number): string[] {
  const O = items.filter((it) => it.kind !== 'new').map((it) => it.text);
  const F = fileLines[at] === undefined ? '' : leadWs(fileLines[at]!);
  const P = O.length === 0 ? '' : leadWs(O[0]!);
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oIdx]!);
      oIdx += 1;
    } else if (it.kind === 'old') {
      oIdx += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk or chunk's last context or `+` line. */
function backslashAfterLast(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.backslash === true;
  }
  return false;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  oldRaw: string | null; // path as written, after any a/ or b/ prefix is removed; null when /dev/null
  newRaw: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const cut = rest.indexOf('\t');
  return (cut < 0 ? rest : rest.slice(0, cut)).trim();
}

/** A leading `a/` or `b/` is removed from a path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function hunkOldLen(h: Hunk): number {
  return h.items.filter((it) => it.kind !== 'new').length;
}
function hunkNewLen(h: Hunk): number {
  return h.items.filter((it) => it.kind !== 'old').length;
}

/** Apply one hunk to a file model; `d` is the running length offset of this section's earlier hunks. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): void {
  const O = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
  if (O.length === 0) {
    const beforeLen = model.lines.length;
    const ins = Math.min(h.a + d, beforeLen);
    const added = h.items.filter((it) => it.kind !== 'old').map((it) => it.text);
    model.lines.splice(ins, 0, ...added);
    if (ins === beforeLen) model.finalBr = !backslashAfterLast(h.items);
    return;
  }
  const found = findTier(O, model.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const at = best;
  const touchedEnd = at + O.length === model.lines.length;
  const rep = buildReplacement(h.items, model.lines, at, found.tier);
  model.lines.splice(at, O.length, ...rep);
  if (touchedEnd) model.finalBr = !backslashAfterLast(h.items);
}

/** Parse one unified section starting at `i`; returns the index of the next unprocessed line. */
function parseUniSection(lines: string[], i: number, gitOld: string | null, gitNew: string | null, edits: Edit[], strict: boolean): number {
  const n = lines.length;
  const sec: UniSection = { oldRaw: null, newRaw: null, isCreate: false, isDelete: false, hunks: [] };
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  // Header: lines before the first hunk.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if (lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
        if (pairOld !== null) break; // a second pair starts a new section
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
    else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
    else if (line.startsWith('new file mode')) sec.isCreate = true;
    else if (line.startsWith('deleted file mode')) sec.isDelete = true;
    i += 1;
  }
  // Hunks.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < n) {
        const l = lines[j]!;
        if (l === '') {
          items.push({ kind: 'ctx', text: '' });
          j += 1;
        } else if (l.startsWith(' ')) {
          items.push({ kind: 'ctx', text: l.slice(1) });
          j += 1;
        } else if (l.startsWith('-')) {
          if (l.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
          items.push({ kind: 'old', text: l.slice(1) });
          j += 1;
        } else if (l.startsWith('+')) {
          items.push({ kind: 'new', text: l.slice(1) });
          j += 1;
        } else if (l.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.backslash = true;
          j += 1;
        } else break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      sec.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    i += 1; // prose between hunks is ignored
  }
  const oldPath = pairOld !== null ? stripAB(pairOld) : renameOld !== null ? renameOld : gitOld !== null ? stripAB(gitOld) : null;
  const newPath = pairNew !== null ? stripAB(pairNew) : renameNew !== null ? renameNew : gitNew !== null ? stripAB(gitNew) : null;
  sec.oldRaw = oldPath === '/dev/null' ? null : oldPath;
  sec.newRaw = newPath === '/dev/null' ? null : newPath;
  edits.push(uniEdit(sec, strict));
  return i;
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.oldRaw;
  const newP = sec.newRaw;
  const kind = newP === null || sec.isDelete ? 'delete' : oldP === null || sec.isCreate ? 'create' : oldP !== newP ? 'move' : 'change';
  return (tree) => {
    if (kind === 'create') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') content.push(it.text);
      let finalBr = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const items = sec.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k -= 1) {
          if (items[k]!.kind === 'new') {
            finalBr = items[k]!.backslash !== true;
            break outer;
          }
        }
      }
      tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = oldP;
      if (p === null) throw new Fail('missing', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'move') {
      const q = newP!;
      if (!safe(q)) throw new Fail('unsafe', q);
      if (tree.get(p) === null) throw new Fail('missing', p);
      if (tree.get(q) !== null) throw new Fail('exists', q);
    } else if (tree.get(p) === null) {
      throw new Fail('missing', p);
    }
    const before = tree.get(p)!;
    const model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(model, h, d, strict, p);
      d += hunkNewLen(h) - hunkOldLen(h);
    }
    const out = joinFile(model);
    if (kind === 'move') {
      const q = newP!;
      tree.now.set(p, null);
      tree.now.set(q, out);
      tree.moves.push({ old: p, new: q });
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseUniSection(lines, i + 1, m[1]!, m[2]!, edits, strict);
    } else if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
      i = parseUniSection(lines, i, null, null, edits, strict);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(oldLines, model.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ kind: 'old', text: t })),
      ...newLines.map((t): BodyItem => ({ kind: 'new', text: t })),
    ];
    const rep = buildReplacement(items, model.lines, found.occ[0]!, found.tier);
    model.lines.splice(found.occ[0]!, oldLines.length, ...rep);
    tree.now.set(path, joinFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break; // a new block starts: this one has no markers
      if (eq < 0 && t === '=======') eq = j;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0 || eq > rep) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null: no anchor
  items: BodyItem[];
  eof: boolean;
}

function bodyItem(text: string): BodyItem {
  if (text === '') return { kind: 'ctx', text: '' };
  if (text.startsWith(' ')) return { kind: 'ctx', text: text.slice(1) };
  if (text.startsWith('-')) return { kind: 'old', text: text.slice(1) };
  return { kind: 'new', text: text.slice(1) }; // starts with '+'
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // First line at or after the cursor equal to the anchor, at the first tier with one.
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineEq(ch.anchor, model.lines[k]!, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      if (O.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const added = ch.items.filter((it) => it.kind !== 'old').map((it) => it.text);
        model.lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const found = findTier(O, model.lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at = -1;
      for (const pos of found.occ) {
        if (ch.eof && pos + O.length !== model.lines.length) continue;
        at = pos;
        break;
      }
      if (at < 0) throw new Fail('no-match', path);
      const rep = buildReplacement(ch.items, model.lines, at, found.tier);
      model.lines.splice(at, O.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

interface SectionLine {
  text: string;
  lineNo: number; // 1-based patch line number
}

/**
 * Collect one V4A section's lines, from `start` up to (not including) the next section start or
 * `endExclusive`; trailing blank lines are not part of the section. Returns the collected lines and
 * the index where the next section starts.
 */
function collectV4aSection(lines: string[], start: number, endExclusive: number): { content: SectionLine[]; end: number } {
  let end = endExclusive;
  for (let k = start; k < endExclusive; k += 1) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      end = k;
      break;
    }
  }
  const content: SectionLine[] = [];
  for (let k = start; k < end; k += 1) content.push({ text: lines[k]!, lineNo: k + 1 });
  while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
  return { content, end };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { content, end } = collectV4aSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const cl of content) {
        if (cl.text === '') fileLines.push('');
        else if (cl.text.startsWith('+')) fileLines.push(cl.text.slice(1));
        else throw new Exit2(`error: parse ${cl.lineNo}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = end;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { content, end } = collectV4aSection(lines, i + 1, last);
      for (const cl of content) {
        if (cl.text !== '') throw new Exit2(`error: parse ${cl.lineNo}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = end;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      const { content, end } = collectV4aSection(lines, i + 1, last);
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < content.length; idx += 1) {
        const cl = content[idx]!;
        const t = cl.text;
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${cl.lineNo}`);
          cur.eof = true;
          close();
        } else if (t.startsWith('@@')) {
          close();
          cur = { anchor: t.slice(2).trim(), items: [], eof: false };
          if (cur.anchor === '') cur.anchor = null;
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${cl.lineNo}`);
            cur = { anchor: null, items: [], eof: false };
          }
          cur.items.push(bodyItem(t));
        } else {
          throw new Exit2(`error: parse ${cl.lineNo}`);
        }
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = end;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.original(mv.new) === null && finalOf(mv.old) === null && finalOf(mv.new) !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrd(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrd)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
