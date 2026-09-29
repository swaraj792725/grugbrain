/**
 * Test/build output summarizer.
 * Keeps every failure (with its assertion + stack context) and the runner's summary lines;
 * drops the wall of passing tests, progress dots and banners. Only activates when it recognizes
 * a runner, so arbitrary command output is never mangled. Deterministic.
 *
 * Supported: jest, vitest, mocha, pytest, go test, cargo test, node:test/TAP, rspec, phpunit,
 * tsc, eslint (compiler/linter output is de-duplicated and capped instead).
 */

export interface TestSummary {
  text: string;
  changed: boolean;
  framework: string | null;
  failures: number;
  keptLines: number;
  totalLines: number;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const RUNNERS: Array<{ name: string; detect: RegExp }> = [
  { name: 'vitest', detect: /^\s*(Test Files|Tests)\s+.*\b(passed|failed)\b/m },
  { name: 'jest', detect: /^\s*(Tests|Test Suites):\s+.*\b(passed|failed|total)\b/m },
  { name: 'pytest', detect: /^=+ .*\b(passed|failed|error|errors)\b.* in [\d.]+s/m },
  { name: 'go', detect: /^(ok|FAIL|---\s(PASS|FAIL))\s/m },
  { name: 'cargo', detect: /^test result: (ok|FAILED)\./m },
  { name: 'mocha', detect: /^\s+\d+ (passing|failing)\b/m },
  { name: 'tap', detect: /^# (pass|fail)\s+\d+/m },
  { name: 'rspec', detect: /^\d+ examples?, \d+ failures?/m },
  { name: 'phpunit', detect: /^(OK \(\d+ tests?|Tests: \d+, Assertions: \d+)/m }
];

const PASS_LINE =
  /^\s*(✓|✔|√|PASS\b|ok\s+\d+\b|ok\s+[\w./-]+\s|---\s*PASS|=== RUN|test .+ \.\.\. ok$|[\w/.:-]+::[\w\[\]-]+ PASSED|\.+$|\[\s*\d+%\]|PASSED\b)/;
const FAIL_START =
  /(✗|✕|×|❌|✖|\bFAIL(ED)?\b|--- FAIL|not ok\b|\bERROR\b|Error:|AssertionError|assert(ion)? failed|panicked at|Traceback \(most recent call last\)|^\s*●\s|^E\s{2,}|^\s*\d+\) |failures?:$|thread '.*' panicked|expected .* (to|but)|Expected:|Received:)/i;
const SUMMARY =
  /(Test Files|Test Suites:|Tests:|Snapshots:|Time:|Duration|\d+ (passed|failed|passing|failing|pending|skipped|errors?)\b|test result:|examples?, \d+ failures?|short test summary|^(ok|FAIL)\s+[\w./-]+|# (pass|fail|tests))/i;

const TSC_ERR = /^(.+?)\(\d+,\d+\): error TS\d+:|^(.+?):\d+:\d+ - error TS\d+:/;
const ESLINT_FILE = /^(\/|[A-Za-z]:\\|\.\/)?[\w./\\-]+\.(t|j)sx?$/;

function summarizeCompiler(lines: string[]): TestSummary | null {
  const tscErrors = lines.filter((l) => TSC_ERR.test(l));
  if (tscErrors.length > 40) {
    const perFile = new Map<string, number>();
    for (const l of tscErrors) {
      const m = l.match(TSC_ERR)!;
      const f = m[1] || m[2];
      perFile.set(f, (perFile.get(f) || 0) + 1);
    }
    const keep = lines.slice(0, lines.findIndex((l) => TSC_ERR.test(l)) + 1);
    let shown = 0;
    const out: string[] = [];
    for (let i = 0; i < lines.length && shown < 30; i++) {
      if (TSC_ERR.test(lines[i])) {
        out.push(lines[i]);
        // continuation lines of the same diagnostic
        for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && j < i + 4; j++) out.push(lines[j]);
        shown++;
      }
    }
    void keep;
    const files = [...perFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} (${n})`);
    out.push('', `[grug: showing first ${shown} of ${tscErrors.length} TypeScript errors. By file: ${files.slice(0, 15).join(', ')}${files.length > 15 ? ` +${files.length - 15} files` : ''}]`);
    const tail = lines.slice(-3).filter((l) => /Found \d+ errors?/.test(l));
    out.push(...tail);
    return { text: out.join('\n'), changed: true, framework: 'tsc', failures: tscErrors.length, keptLines: out.length, totalLines: lines.length };
  }
  return null;
}

export function summarizeTestOutput(raw: string, minChars = 3000): TestSummary {
  const none = (framework: string | null = null): TestSummary => ({
    text: raw, changed: false, framework, failures: 0, keptLines: 0, totalLines: 0
  });
  if (!raw || raw.length < minChars) return none();
  const text = raw.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  const lines = text.split('\n');

  const compiler = summarizeCompiler(lines);
  if (compiler) return compiler;

  const runner = RUNNERS.find((r) => r.detect.test(text));
  if (!runner) return none();

  const keep = new Set<number>();
  // Command banner.
  for (let i = 0; i < Math.min(3, lines.length); i++) if (lines[i].trim()) keep.add(i);
  // Summary lines near the end + anywhere a "summary" header appears.
  const tailStart = Math.max(0, lines.length - 40);
  for (let i = 0; i < lines.length; i++) {
    if (SUMMARY.test(lines[i]) && (i >= tailStart || /short test summary|^(ok|FAIL)\s/.test(lines[i]))) keep.add(i);
  }
  // Failure blocks with context.
  let failures = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!FAIL_START.test(lines[i]) || PASS_LINE.test(lines[i])) continue;
    failures++;
    // Some runners (go test, TAP) print the failure message BEFORE the FAIL line: walk back over
    // indented detail lines up to the test's header.
    for (let b = i - 1, n = 0; b >= 0 && n < 30; b--, n++) {
      if (/^=== RUN/.test(lines[b])) {
        keep.add(b);
        break;
      }
      if (!/^\s+\S/.test(lines[b]) || PASS_LINE.test(lines[b])) break;
      keep.add(b);
    }
    let budget = 40;
    for (let j = i; j < lines.length && budget > 0; j++, budget--) {
      if (j > i && PASS_LINE.test(lines[j])) break;
      // node_modules / internal frames add little: keep the first two, drop the rest.
      if (/^\s+at .*(node_modules|node:internal)/.test(lines[j]) && j > i + 2 && keep.has(j - 1) && /node_modules|node:internal/.test(lines[j - 1])) continue;
      // Block ends at a separator rule or two blank lines; diffs and code frames in between are kept.
      if (j > i && /^\s*([⎯─━=_-])\1{9,}/.test(lines[j])) break;
      if (j > i + 1 && lines[j].trim() === '' && (lines[j + 1] ?? '').trim() === '') break;
      keep.add(j);
    }
  }

  const idx = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) {
      const gap = lines.slice(prev + 1, i);
      const passed = gap.filter((l) => PASS_LINE.test(l)).length;
      out.push(`  … ${i - prev - 1} line(s) omitted${passed ? ` (${passed} passing)` : ''}`);
    }
    out.push(lines[i]);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`  … ${lines.length - 1 - prev} line(s) omitted`);

  let result = out.join('\n');
  if (result.length > 14000) result = result.slice(0, 10000) + '\n  … [grug: failure details truncated; re-run a single failing test for the rest]\n' + result.slice(-3000);
  if (result.length > text.length * 0.7) return none(runner.name);
  const header = `[grug: summarized ${runner.name} output: ${failures ? 'every failure kept in full' : 'no failures found'}, ${lines.length - idx.length} passing/noise lines dropped]`;
  return {
    text: `${header}\n${result}`,
    changed: true,
    framework: runner.name,
    failures,
    keptLines: idx.length,
    totalLines: lines.length
  };
}
