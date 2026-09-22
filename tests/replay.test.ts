import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateScenario, scenarioDigest } from '../src/fixtures/generate.js';
import { runReplay } from '../src/replay.js';
import { buildReport } from '../src/report.js';
import { testConfig } from './stubs.js';
import { readJsonl } from '../src/sources/mock.js';
import type { FixtureChat } from '../src/fixtures/generate.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'arb-'));
}

test('fixture 可重生：同 seed 同 digest，不同 seed 不同', () => {
  const a = tmp(), b = tmp(), c = tmp();
  generateScenario(a, { minutes: 5, seed: 1, writeFrames: false });
  generateScenario(b, { minutes: 5, seed: 1, writeFrames: false });
  generateScenario(c, { minutes: 5, seed: 2, writeFrames: false });
  assert.equal(scenarioDigest(a), scenarioDigest(b));
  assert.notEqual(scenarioDigest(a), scenarioDigest(c));
  for (const d of [a, b, c]) rmSync(d, { recursive: true });
});

test('30 分鐘場景：至少 100 個唯一穩定 ID、含各類留言', () => {
  const d = tmp();
  generateScenario(d, { minutes: 30, seed: 42, writeFrames: false });
  const chats = readJsonl<FixtureChat>(join(d, 'chat.jsonl'));
  const unique = new Set(chats.map((c) => `${c.source}:${c.messageId}`));
  assert.ok(unique.size >= 100, `unique=${unique.size}`);
  const cats = new Set(chats.map((c) => c.category));
  for (const c of ['general', 'resend', 'same_text_other_author', 'same_text_later', 'identity', 'injection', 'unrelated', 'empty', 'overlong', 'cross_source'])
    assert.ok(cats.has(c as FixtureChat['category']), c);
  assert.ok(chats.every((c) => c.idStability === 'stable'));
  rmSync(d, { recursive: true });
});

test('回播 deterministic：同 seed 兩次 transcript 相同；覆蓋率 ≤ 100%；重播與重疊為 0', async () => {
  const d = tmp();
  generateScenario(d, { minutes: 6, seed: 3, writeFrames: false });
  const config = testConfig();
  const run = () => runReplay({ scenarioDir: d, config, outPath: null, injectEstops: 3, resumeAfterMs: 2000, realtime: false, seed: 11, renderFrames: false });
  const r1 = await run();
  const r2 = await run();
  const rep1 = buildReport(r1.log.events());
  const rep2 = buildReport(r2.log.events());
  assert.deepEqual(rep1.transcript, rep2.transcript);
  assert.ok(rep1.transcript.length > 0);
  assert.ok((rep1.chat.coverage_rate ?? 0) <= 1);
  assert.equal(rep1.duplicate_playbacks, 0);
  assert.equal(rep1.overlap_count, 0);
  assert.equal(rep1.estops.count, 3);
  assert.equal(rep1.estops.late_playbacks_after_estop, 0);
  assert.equal(rep1.chat.covered_by_playback <= rep1.chat.unique_eligible, true);
  assert.equal(rep1.budget?.over_limit_settlements, 0);
  rmSync(d, { recursive: true });
});

test('回播：同來源重送不重播、跨來源同 ID 各自獨立、換局有 context_change', async () => {
  const d = tmp();
  generateScenario(d, { minutes: 8, seed: 5, writeFrames: false });
  const r = await runReplay({ scenarioDir: d, config: testConfig(), outPath: null, injectEstops: 0, resumeAfterMs: 0, realtime: false, seed: 1, renderFrames: false });
  const rep = buildReport(r.log.events());
  assert.ok(rep.chat.resend_duplicates_dropped > 0);
  assert.equal(rep.duplicate_playbacks, 0);
  assert.ok(rep.context_changes >= 1);
  assert.ok(rep.chat.skipped_identity >= 1);
  assert.ok(rep.chat.unsafe_input_local >= 1);
  rmSync(d, { recursive: true });
});
