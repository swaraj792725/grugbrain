/**
 * Risky-command guard: before a shell command that throws away work or data in one go
 * (rm -rf on a home/root/project dir, force push, git reset --hard, git clean -fd, DROP TABLE, curl | sh, ...),
 * the user is asked first. Claude Code and Antigravity show their own approval prompt ('ask');
 * apps without one get a deny that names the risk, and the identical repeat is let through (ask-once).
 * Quoted text and heredoc bodies are data (commit messages, grep patterns, scripts), so they are left out.
 */

/** Drop heredoc bodies and quoted text with spaces ("$HOME" and "/" stay: they are targets). */
function commandPart(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n\s*\2\s*(?=\n|$)|$)/g, (_m, _q, _tag, tail) => tail)
    .replace(/'[^']*'/g, (m) => (/\s/.test(m) ? "''" : m))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => (/\s/.test(m) ? '""' : m));
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

/** rm targets that wipe a whole tree: /, ~, $HOME, ., .., *, .git, or a top-level dir like /usr or /Users/me. */
function wideTarget(t: string): boolean {
  const x = unquote(t).replace(/\/+$/, '') || '/';
  if (/^(\/|\/\*|~|~\/\*|\$\{?HOME\}?|\$\{?HOME\}?\/\*|\.|\.\/\*|\.\.|\.\.\/\*|\*|\.\*|\.git)$/.test(x)) return true;
  return /^\/[^/*]+(\/[^/*]+)?$/.test(x) && !/^\/(tmp|private\/tmp|var\/tmp)(\/|$)/.test(x);
}

function rmRisk(words: string[]): string | null {
  let r = false;
  let f = false;
  const targets: string[] = [];
  let opts = true;
  for (const w of words.slice(1)) {
    if (opts && w === '--') opts = false;
    else if (opts && /^--recursive$/.test(w)) r = true;
    else if (opts && /^--force$/.test(w)) f = true;
    else if (opts && /^-[a-zA-Z]+$/.test(w)) {
      if (/[rR]/.test(w)) r = true;
      if (/f/.test(w)) f = true;
    } else targets.push(w);
  }
  const wide = targets.filter(wideTarget);
  return r && f && wide.length ? `rm -rf on ${wide.join(' ')} deletes a whole tree with no undo` : null;
}

function gitRisk(words: string[]): string | null {
  const i = words.findIndex((w, n) => n > 0 && !w.startsWith('-') && !/^-C$/.test(words[n - 1]) && !/^-c$/.test(words[n - 1]));
  const sub = words[i];
  const rest = words.slice(i + 1);
  const has = (re: RegExp) => rest.some((w) => re.test(w));
  switch (sub) {
    case 'push':
      if (has(/^--force-with-lease|^--force-if-includes/)) return null;
      if (has(/^(--force|-[a-zA-Z]*f[a-zA-Z]*)$/) || has(/^\+[^\s]/)) return 'force push rewrites the remote branch (others lose commits); --force-with-lease is the safer form';
      if (has(/^--delete$|^-d$|^:[^\s]/)) return 'this deletes a remote branch';
      return null;
    case 'reset':
      return has(/^--hard$/) ? 'git reset --hard throws away every uncommitted change' : null;
    case 'clean':
      return has(/^-[a-zA-Z]*f/) || has(/^--force$/) ? 'git clean -f deletes untracked files (they were never committed, so git cannot bring them back)' : null;
    case 'checkout':
    case 'restore':
      if (sub === 'restore' && has(/^--staged$/) && !has(/^--worktree$|^-W$/)) return null;
      return has(/^(\.|\.\/|:\/|\*)$/) ? `git ${sub} . throws away every uncommitted change in the tree` : null;
    case 'branch':
      return has(/^-D$|^--delete$/) && has(/^--force$|^-D$/) ? 'git branch -D deletes a branch even when it is not merged' : null;
    case 'stash':
      return rest[0] === 'clear' ? 'git stash clear drops every stash' : rest[0] === 'drop' ? 'git stash drop deletes a stash' : null;
    case 'filter-branch':
    case 'filter-repo':
      return 'this rewrites the whole history';
  }
  return null;
}

const SQL_CLIENT = /\b(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?|clickhouse(?:-client)?|cockroach|duckdb)\b/;
const SQL_DROP = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?\w)|\bdelete\s+from\s+\w+\s*(;|$|["'])|dropDatabase\(\)/i;

/** Why this command needs the user's yes, or null when it does not. */
export function dangerReason(command: string): string | null {
  const raw = String(command || '');
  if (!raw.trim() || raw.length > 20_000) return null;
  // SQL lives inside quotes (psql -c "DROP TABLE x"), so it is checked on the raw text, client named.
  if (SQL_CLIENT.test(raw) && SQL_DROP.test(raw.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(?:\n\s*\2\s*(?=\n|$)|$)/g, ''))) return 'this drops or wipes database data';
  if (/\b(prisma\s+migrate\s+reset|rails\s+db:(drop|reset)|rake\s+db:(drop|reset)|dropdb)\b/.test(raw)) return 'this drops and recreates the database';
  const cmd = commandPart(raw);
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)) return 'this runs a script straight from the internet';
  if (/\bmkfs(\.\w+)?\b|\bdd\b[^;&|]*\bof=\/dev\/(?!null\b)|>\s*\/dev\/(sd|disk|nvme)/.test(cmd)) return 'this writes over a disk';
  if (/\bchmod\s+(-R\s+|--recursive\s+)\S*777\s+(\/|~|\$HOME)\S*\s*$/m.test(cmd)) return 'this opens up permissions on a whole tree';
  for (const seg of cmd.split(/\n|;|&&|\|\||\|/)) {
    let words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^\w+=/.test(words[0]) || /^(sudo|command|exec|nohup|time|xargs|env)$/.test(words[0]) || /^-/.test(words[0]))) words = words.slice(1);
    const bin = (words[0] || '').replace(/^.*\//, '');
    const why = bin === 'rm' ? rmRisk(words) : bin === 'git' ? gitRisk(words) : null;
    if (why) return why;
  }
  return null;
}

/** The text the model (and the user, in the approval prompt) sees. */
export function dangerText(command: string, why: string, askOnce: boolean): string {
  const c = command.length > 160 ? command.slice(0, 157) + '...' : command;
  return askOnce
    ? `grugbrain: risky command held back (${why}): ${c}\nAsk the user to confirm first, and check for work that would be lost (git status). If they say yes, run the exact same command again and it will be allowed.`
    : `grugbrain: risky command (${why}). Run it only if the user asked for this.`;
}
