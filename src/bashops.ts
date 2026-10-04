/**
 * What a Bash command did to files. Claude often reads and edits through the shell
 * (`sed -n '40,80p' f`, `grep -n x f`, `cat f`, `sed -i`, `> f`), and those never reach the
 * Read/Edit file events, so recall scoring, adoption and the handoff missed them.
 * A best-effort parse: simple segments only, paths that exist as files, never an error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BashFileOp {
  path: string;
  op: 'read' | 'edit';
  ranged?: boolean;
}

export interface BashOps {
  files: BashFileOp[];
  /** Kinds of lookup the command did (counted in adoption like Read/Grep). */
  uses: Array<'read' | 'grep'>;
}

const MAX_FILES = 10;

/** Split a shell line into words, keeping quoted text whole; operators come back as their own words. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  const push = () => {
    if (has) out.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      push();
      if (c === '\n') out.push(';');
    } else if (c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
      push();
      let op = c;
      while (i + 1 < cmd.length && (cmd[i + 1] === c || (c === '>' && cmd[i + 1] === '&') || (c === '&' && cmd[i + 1] === '>'))) op += cmd[++i];
      out.push(op);
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  return out;
}

/** Drop heredoc bodies (a python edit script is data, not commands); the `<<EOF` line stays. */
function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n\s*\2\s*(?=\n|$)|$)/g, (_m, _q, _tag, tail) => tail);
}

const SEPARATORS = new Set([';', '|', '||', '&&', '&']);
const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'wc']);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ugrep', 'ag']);

export function bashFileOps(command: string, cwd: string): BashOps {
  const files: BashFileOp[] = [];
  const uses = new Set<'read' | 'grep'>();
  let dir = cwd;
  if (!command || command.length > 20000) return { files, uses: [] };
  const resolveFile = (p: string): string | null => {
    if (!p || p.startsWith('-') || p === '/dev/null' || /[*?$`]/.test(p)) return null;
    const abs = path.resolve(dir, p.replace(/^~(?=\/)/, process.env.HOME || '~'));
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  };
  const add = (p: string | null, op: 'read' | 'edit', ranged?: boolean) => {
    if (!p || files.length >= MAX_FILES) return;
    const prev = files.find((f) => f.path === p && f.op === op);
    if (prev) {
      if (!ranged) delete prev.ranged;
      return;
    }
    files.push({ path: p, op, ...(ranged ? { ranged: true } : {}) });
  };

  const all = words(stripHeredocs(command));
  let seg: string[] = [];
  const flush = () => {
    const w = seg;
    seg = [];
    // Redirect targets are edits; strip them (and their operator) before reading the arguments.
    const args: string[] = [];
    for (let i = 0; i < w.length; i++) {
      if (/^(>|>>|&>|>&|&>>)$/.test(w[i])) {
        add(resolveFile(w[i + 1] || ''), 'edit');
        i++;
      } else if (w[i] === '<') {
        i++;
      } else args.push(w[i]);
    }
    while (args.length && /^\w+=/.test(args[0])) args.shift(); // FOO=1 cmd
    if (args[0] === 'sudo' || args[0] === 'command' || args[0] === 'time') args.shift();
    const name = path.basename(args[0] || '');
    const rest = args.slice(1);
    if (name === 'cd') {
      const to = rest[0];
      if (to && !to.startsWith('-')) dir = path.resolve(dir, to.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
      return;
    }
    if (READERS.has(name)) {
      const ranged = name === 'head' || name === 'tail' || name === 'wc';
      let skipNext = false;
      const found = rest.filter((a) => {
        if (skipNext) return (skipNext = false);
        if (/^-[nc]$/.test(a)) return !(skipNext = true);
        return true;
      });
      for (const a of found) add(resolveFile(a), 'read', ranged);
      if (found.some((a) => resolveFile(a))) uses.add('read');
      return;
    }
    if (name === 'sed' || name === 'gsed') {
      const inPlace = rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='));
      let script: string | null = null;
      const targets: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '-e' || a === '-f') {
          script = script ?? rest[++i] ?? '';
          continue;
        }
        if (a === '-i' && rest[i + 1] === '') {
          i++; // BSD: sed -i '' 's/a/b/' f
          continue;
        }
        if (a.startsWith('-')) continue;
        if (script === null) script = a;
        else targets.push(a);
      }
      const ranged = !inPlace && /^\s*\d+(,\s*\$?\d*)?\s*p\s*$|^\s*\/.*\/\s*,/.test(script || '');
      for (const t of targets) add(resolveFile(t), inPlace ? 'edit' : 'read', ranged);
      if (!inPlace && targets.some((t) => resolveFile(t))) uses.add('read');
      return;
    }
    if (name === 'perl' && rest.some((a) => /^-[a-zA-Z]*i/.test(a))) {
      let sawScript = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-e' || /^-[a-zA-Z]*e$/.test(rest[i])) {
          i++;
          sawScript = true;
        } else if (!rest[i].startsWith('-')) {
          if (!sawScript) sawScript = true;
          else add(resolveFile(rest[i]), 'edit');
        }
      }
      return;
    }
    if (name === 'tee') {
      for (const a of rest) add(resolveFile(a), 'edit');
      return;
    }
    if (GREPS.has(name)) {
      uses.add('grep');
      // grep [flags] PATTERN [files]; -e/-f carry the pattern instead.
      let pattern = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '-e' || a === '-f' || a === '--regexp') {
          i++;
          pattern = true;
          continue;
        }
        if (/^-(A|B|C|m|g|t|-include|-exclude|-glob|-type)$/.test(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-')) continue;
        if (!pattern) {
          pattern = true;
          continue;
        }
        add(resolveFile(a), 'read', true); // a targeted look into that file
      }
    }
  };
  for (const w of all) {
    if (SEPARATORS.has(w)) flush();
    else seg.push(w);
  }
  flush();
  return { files, uses: [...uses] };
}
