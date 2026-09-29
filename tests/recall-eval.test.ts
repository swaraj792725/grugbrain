import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, paths, userHome } from '../src/config.js';
import { addNote, MemoryDB, projectKey } from '../src/memory/store.js';
import { autoRecall } from '../src/recall.js';
import { HOLDOUT_NEGATIVES, HOLDOUT_NOTES, HOLDOUT_POSITIVES, NEGATIVES, NOTES, POSITIVES } from './recall-corpus.js';

const ORIGINAL = { HOME: process.env.HOME, GRUG_HOME: process.env.GRUG_HOME };
let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grug-eval-'));
  process.env.HOME = tmp;
  process.env.GRUG_HOME = path.join(tmp, '.grug');
  delete process.env.CLAUDE_CONFIG_DIR;
  if (userHome() !== tmp || !paths.home().startsWith(tmp)) throw new Error('test HOME isolation failed');
});
afterAll(() => {
  process.env.HOME = ORIGINAL.HOME;
  if (ORIGINAL.GRUG_HOME === undefined) delete process.env.GRUG_HOME;
  else process.env.GRUG_HOME = ORIGINAL.GRUG_HOME;
});

let runs = 0;
function evaluate(NOTES: string[], POSITIVES: Array<[string, number]>, NEGATIVES: string[]) {
  const cwd = path.join(tmp, 'evalproj' + runs++);
  fs.mkdirSync(cwd);
  const db: MemoryDB = { version: 1, nodes: {}, edges: {} }; // fresh memory per evaluation
  NOTES.forEach((n, i) => addNote(db, projectKey(cwd), n, Date.now() - i * 1000, { kind: 'decision' }));
  fs.mkdirSync(paths.home(), { recursive: true });
  fs.writeFileSync(paths.memory(), JSON.stringify(db));
  const cfg = loadConfig();
  const ids = Object.values(db.nodes).filter((n) => n.type === 'note').map((n) => [n.label, n.id] as const);
  const idOf = (i: number) => ids.find(([l]) => l === NOTES[i])![1];
  let hits = 0;
  let noise = 0;
  const missed: string[] = [];
  for (const [q, want] of POSITIVES) {
    const r = autoRecall({ cfg, sessionId: 'e-' + q.slice(0, 12), cwd, prompt: q });
    if (r?.ids.includes(idOf(want))) hits++;
    else missed.push(q);
    noise += (r?.ids.length || 0) - (r?.ids.includes(idOf(want)) ? 1 : 0);
  }
  const falsePos: string[] = [];
  for (const q of NEGATIVES) if (autoRecall({ cfg, sessionId: 'n-' + q.slice(0, 12), cwd, prompt: q })) falsePos.push(q);
  return { recall: hits / POSITIVES.length, noisePerQuery: noise / POSITIVES.length, fpRate: falsePos.length / NEGATIVES.length, missed, falsePos };
}

const SUFFIXES = [
  ' Also, while you are at it, tidy the formatting and tell me if the documentation needs an update afterwards.',
  ' Use only what you already know from earlier context, and keep the answer short with a couple of bullet points.'
];
const compound = (ps: Array<[string, number]>): Array<[string, number]> => ps.map(([q, i], k) => [q + '.' + SUFFIXES[k % SUFFIXES.length], i]);

describe('recall matching eval', () => {
  it('finds the note when the question is one part of a longer, multi-part prompt', () => {
    const a = evaluate(NOTES, compound(POSITIVES), NEGATIVES);
    const b = evaluate(HOLDOUT_NOTES, compound(HOLDOUT_POSITIVES), HOLDOUT_NEGATIVES);
    console.log('COMPOUND', JSON.stringify({ tuned: a.recall, holdout: b.recall, noise: [a.noisePerQuery, b.noisePerQuery] }), '\nMISSED', a.missed.length, b.missed.length);
    expect(a.recall).toBeGreaterThanOrEqual(0.8);
    expect(b.recall).toBeGreaterThanOrEqual(0.5);
    expect(a.noisePerQuery).toBeLessThanOrEqual(0.15);
    expect(b.noisePerQuery).toBeLessThanOrEqual(0.15);
    // Clauses must not make unrelated prompts louder: unrelated request + the same trailing instruction.
    const quietA = evaluate(NOTES, [], NEGATIVES.map((q, k) => q + '.' + SUFFIXES[k % 2]));
    const quietB = evaluate(HOLDOUT_NOTES, [], HOLDOUT_NEGATIVES.map((q, k) => q + '.' + SUFFIXES[k % 2]));
    expect(quietA.fpRate).toBeLessThanOrEqual(1 / 16);
    expect(quietB.fpRate).toBe(0);
  });

  it('reports recall and false positives', () => {
    const r = evaluate(NOTES, POSITIVES, NEGATIVES);
    console.log('EVAL', JSON.stringify({ recall: r.recall, noisePerQuery: r.noisePerQuery, fpRate: r.fpRate }), '\nMISSED', r.missed, '\nFALSE POSITIVES', r.falsePos);
    // Guards, not aspirations: matching may improve, but never below these on the tuned set.
    expect(r.recall).toBeGreaterThanOrEqual(0.85);
    expect(r.fpRate).toBeLessThanOrEqual(1 / 16);
    expect(r.noisePerQuery).toBeLessThanOrEqual(0.1);
  });

  it('reports the hold-out set', () => {
    const r = evaluate(HOLDOUT_NOTES, HOLDOUT_POSITIVES, HOLDOUT_NEGATIVES);
    console.log('HOLDOUT', JSON.stringify({ recall: r.recall, noisePerQuery: r.noisePerQuery, fpRate: r.fpRate }), '\nMISSED', r.missed, '\nFALSE POSITIVES', r.falsePos);
    // Hold-out (never tuned against): before synonyms 50% recall; silence on unrelated prompts must stay perfect.
    expect(r.recall).toBeGreaterThanOrEqual(0.6);
    expect(r.fpRate).toBe(0);
    expect(r.noisePerQuery).toBeLessThanOrEqual(0.1);
  });
});
