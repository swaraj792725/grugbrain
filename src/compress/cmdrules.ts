/**
 * Per-command output rules: installs, builds and package managers print a wall of progress
 * (Downloading, Compiling, Collecting, Get:...) around a few lines that matter. Each rule names the
 * noise for one family of commands; everything else, and every line that looks like a problem,
 * is kept verbatim. Deterministic, and only applied when the command matches a rule.
 */

export interface RuleResult {
  text: string;
  changed: boolean;
  rule: string | null;
  dropped: number;
}

interface Rule {
  name: string;
  /** Tested against each command in a pipeline/chain. */
  cmd: RegExp;
  /** Lines that are progress/noise for this tool. */
  noise: RegExp[];
  /** Noise worth a count + first few examples (deprecation notices) instead of silence. */
  sample?: RegExp;
}

const RULES: Rule[] = [
  {
    name: 'npm',
    cmd: /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update|up|upgrade|remove|rm|uninstall|dedupe)\b/,
    noise: [/^npm (http|info|timing|sill|verb)\b/, /^\s*(Progress|Packages:|Resolving|Fetching|Linking|Already up[- ]to[- ]date)\b/i, /^(info|warning)? ?\s*(fsevents|Resolving packages|Fetching packages|Linking dependencies|Building fresh packages)\b/i, /^[\s+-]*[\w@/.-]+ [\d.]+\s*$/, /^\s*[+-]{1,3} [\w@/.-]+@[\d.]+\s*$/],
    sample: /^npm (warn|WARN) (deprecated|EBADENGINE)|^\s*warning .*deprecated|^npm warn (deprecated|old lockfile)/i
  },
  {
    name: 'pip',
    cmd: /\b(pip3?|pipx|uv\s+pip|uv\s+sync|uv\s+add|poetry\s+(install|add|update)|conda\s+install)\b/,
    noise: [/^\s*(Collecting|Downloading|Using cached|Obtaining|Preparing metadata|Installing build dependencies|Getting requirements|Building wheel|Created wheel|Stored in directory|Installing collected)\b/, /^\s*Requirement already satisfied\b/, /^\s*[━─=#\-]{3,}\s*[\d.]+\s*[kMG]?i?B/i, /^\s*\S*\s*[\d.]+\/[\d.]+ [kMG]?i?B/, /^\s*(Resolved|Prepared|Installed|Audited) \d+ packages? in\b.*$/i, /^\s*\+ [\w.-]+==[\w.]+\s*$/],
    sample: /^\s*(WARNING|DEPRECATION)\b/
  },
  {
    name: 'cargo',
    cmd: /\bcargo\s+(build|b|check|c|install|fetch|update|add|clippy|doc|run|r)\b/,
    noise: [/^\s*(Compiling|Downloading|Downloaded|Fresh|Blocking|Updating|Locking|Adding|Unpacking|Installing|Documenting)\b/, /^\s*Running `/]
  },
  {
    name: 'go',
    cmd: /\bgo\s+(build|get|mod|install|generate|vet)\b/,
    noise: [/^go: (downloading|finding|extracting|upgraded|added)\b/]
  },
  {
    name: 'apt',
    cmd: /\b(apt|apt-get|dpkg|aptitude)\b.*\b(install|update|upgrade|dist-upgrade|remove|purge|autoremove)\b/,
    noise: [/^(Get|Hit|Ign|Fetched|Selecting|Preparing to unpack|Unpacking|Setting up|Processing triggers|Reading|Building dependency|Reading state|Reading package)\b/, /^\(Reading database/, /^Need to get/, /^After this operation/, /^debconf:/, /^update-alternatives:/]
  },
  {
    name: 'brew',
    cmd: /\bbrew\s+(install|upgrade|update|reinstall|uninstall|cleanup)\b/,
    noise: [/^==> (Downloading|Fetching|Pouring|Installing)\b/, /^#+\s*[\d.]+%/]
  },
  {
    name: 'docker',
    cmd: /\bdocker(\s+compose)?\s+(build|buildx|pull|push|compose\s+build|up)\b|\bdocker-compose\b/,
    noise: [/^#\d+ (\[.*\] )?(resolve|load|transferring|sha256:|CACHED|DONE|extracting|exporting|writing|naming|\d+\.\d+ )/, /^\s*[0-9a-f]{12}: (Waiting|Pulling fs layer|Verifying Checksum|Download complete|Pull complete|Already exists|Layer already exists|Preparing|Pushed)\b/, /^#\d+ sha256:/]
  },
  {
    name: 'git',
    cmd: /\bgit\s+(clone|fetch|pull|push|submodule|lfs)\b/,
    noise: [/^remote: (Enumerating|Counting|Compressing|Total|Resolving)\b/, /^(Receiving|Resolving|Unpacking|Compressing|Writing|Counting|Enumerating) (objects|deltas)/, /^Cloning into\b/]
  },
  {
    name: 'make',
    cmd: /\b(make|cmake|ninja|gradle|gradlew|mvn|mvnw)\b/,
    noise: [/^\[\s*\d+%\]\s+(Building|Linking|Scanning|Generating|Built target)\b/, /^\[INFO\] (Download(ing|ed)|Copying|Nothing to compile|Using|---|Building jar|Installing)\b/, /^(Download(ing|ed)|> Task :[\w:-]+( UP-TO-DATE| NO-SOURCE| FROM-CACHE)?)\s*.*$/, /^-- (Looking|Performing|Found|Detecting|Check|Configuring|Generating|Build files)\b/]
  }
];

/** Anything that looks like a problem is never treated as noise. */
const SIGNAL = /\b(error|errors|fail|failed|failure|fatal|panic|exception|traceback|denied|cannot|can't|not found|unable|conflict|vulnerabilit(y|ies)|ERR!)\b|^\s*(warning|warn)\b/i;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Commands of a pipeline/chain, without leading cd. */
function commandParts(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\n/)
    .map((x) => x.trim().replace(/^(cd\s+\S+\s*)/, ''))
    .filter(Boolean);
}

export function ruleFor(cmd: string): string | null {
  for (const part of commandParts(cmd)) for (const r of RULES) if (r.cmd.test(part)) return r.name;
  return null;
}

export function applyCommandRules(cmd: string, raw: string, minChars = 1500): RuleResult {
  const none: RuleResult = { text: raw, changed: false, rule: null, dropped: 0 };
  if (!raw || raw.length < minChars) return none;
  const names = new Set<string>();
  for (const part of commandParts(cmd)) for (const r of RULES) if (r.cmd.test(part)) names.add(r.name);
  if (!names.size) return none;
  const rules = RULES.filter((r) => names.has(r.name));

  const lines = raw.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').split('\n');
  const out: string[] = [];
  let dropped = 0;
  let run = 0;
  const samples: string[] = [];
  let sampled = 0;
  const flush = () => {
    if (run > 0) out.push(`  … ${run} progress line${run > 1 ? 's' : ''} omitted`);
    run = 0;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const sampleRule = rules.find((r) => r.sample && r.sample.test(line));
    if (sampleRule) {
      sampled++;
      if (samples.length < 3) samples.push(line);
      dropped++;
      continue;
    }
    const isNoise = rules.some((r) => r.noise.some((n) => n.test(line)));
    if (isNoise && !SIGNAL.test(line)) {
      run++;
      dropped++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  if (sampled) {
    out.push('', `[grug: ${sampled} deprecation/warning notice${sampled > 1 ? 's' : ''}; first ${samples.length}:]`, ...samples);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const text = out.join('\n');
  // Only worth it when it clearly shrinks; otherwise leave the output exactly as it was.
  if (dropped < 5 || text.length > raw.length * 0.75) return none;
  return { text: `[grug: ${[...names].join('/')} output: ${dropped} progress/notice lines dropped, errors and warnings kept]\n${text}`, changed: true, rule: [...names].join('/'), dropped };
}
