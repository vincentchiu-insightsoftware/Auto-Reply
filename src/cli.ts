#!/usr/bin/env node
/**
 * arb CLI：fixtures | replay | report | doctor | status
 * replay 加 --realtime 時可用 stdin 控制：pause / resume / estop / stop / status
 */
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { generateScenario, scenarioDigest, scenarioExists } from './fixtures/generate.js';
import { runReplay } from './replay.js';
import { buildReport, readEvents, renderReport } from './report.js';
import { attachStdinControl } from './control/stdin.js';
import { runTtsTest, defaultVoices } from './tts-test.js';
import { validateAzureCredentials } from './providers/azure-tts.js';


/** doctor 用：只檢查憑證有無與格式，不實際呼叫。格式錯（例如貼成中文佔位字）算 FAIL，因為 tts-test 一定跑不起來。 */
function ttsCredentialCheck(): { name: string; status: 'OK' | 'MISSING' | 'FAIL'; detail: string } {
  const key = process.env.AZURE_SPEECH_KEY ?? '';
  const region = process.env.AZURE_SPEECH_REGION ?? '';
  if (!key || !region) return { name: 'tts_credentials', status: 'MISSING', detail: '未設定 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION' };
  const bad = validateAzureCredentials(key, region);
  if (bad) return { name: 'tts_credentials', status: 'FAIL', detail: bad };
  return { name: 'tts_credentials', status: 'OK', detail: `region=${region}（只檢查有無設定與格式，未實際呼叫）` };
}

function arg(args: string[], name: string, dflt: string | null = null): string | null {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? dflt : v;
}
function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'fixtures': {
      const dir = resolve(arg(args, '--scenario', 'fixtures/scenario-a')!);
      const minutes = Number(arg(args, '--minutes', '30'));
      const seed = Number(arg(args, '--seed', '42'));
      const t = generateScenario(dir, { minutes, seed, writeFrames: flag(args, '--write-frames') });
      console.log(JSON.stringify({ dir, minutes: t.minutes, seed: t.seed, frames: Math.floor(t.durationMs / t.frameIntervalMs), roundChanges: t.roundChanges.length, providerFaults: t.providerFaults.length, digest: scenarioDigest(dir) }, null, 2));
      return 0;
    }
    case 'replay': {
      const scenarioDir = resolve(arg(args, '--scenario', 'fixtures/scenario-a')!);
      if (!scenarioExists(scenarioDir)) {
        console.error(`fixture 不存在：${scenarioDir}。先執行 arb fixtures --scenario ${scenarioDir}`);
        return 2;
      }
      const config = loadConfig(resolve(arg(args, '--config', 'config/runtime.example.json')!));
      const out = arg(args, '--out', 'runtime/logs/replay.jsonl');
      const realtime = flag(args, '--realtime');
      const injectEstops = Number(arg(args, '--inject-estop', '0'));
      const limitMin = arg(args, '--limit-minutes', null);
      const opts = {
        scenarioDir, config, outPath: out ? resolve(out) : null, injectEstops, resumeAfterMs: Number(arg(args, '--resume-after-ms', '3000')),
        realtime, seed: Number(arg(args, '--seed', '7')), renderFrames: !flag(args, '--no-render'),
        ...(limitMin ? { limitMs: Number(limitMin) * 60_000 } : {}),
      };
      const detachers: (() => void)[] = [];
      const res = await runReplay(opts, (director) => {
        if (realtime && detachers.length === 0) detachers.push(attachStdinControl(director, (line) => console.error(line)));
      });
      for (const d of detachers) d();
      const report = buildReport(res.log.events());
      console.log(renderReport(report));
      console.log('');
      console.log(`日誌：${res.logPath ?? '(未寫檔)'}；事件 ${res.events} 筆；場景 ${(res.scenarioMs / 60000).toFixed(1)} 分鐘，wall ${(res.wallMs / 1000).toFixed(1)} 秒`);
      const reportPath = arg(args, '--report-json', null);
      if (reportPath) {
        mkdirSync(resolve(reportPath, '..'), { recursive: true });
        writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2));
      }
      const bad = report.duplicate_playbacks > 0 || report.overlap_count > 0 || report.estops.late_playbacks_after_estop > 0 || (report.chat.coverage_rate ?? 0) > 1 || (report.budget?.over_limit_settlements ?? 0) > 0;
      return bad ? 1 : 0;
    }
    case 'report': {
      const path = args.find((a) => !a.startsWith('--'));
      if (!path) {
        console.error('用法：arb report <replay.jsonl> [--json]');
        return 2;
      }
      const r = buildReport(readEvents(resolve(path)));
      console.log(flag(args, '--json') ? JSON.stringify(r, null, 2) : renderReport(r, { transcript: Number(arg(args, '--transcript', '12')) }));
      return 0;
    }
    case 'doctor': {
      // 無設備環境：明確標 SKIPPED，不回報通過
      const checks = [
        { name: 'node_version', status: process.versions.node.split('.')[0]! >= '22' ? 'OK' : 'FAIL', detail: process.versions.node },
        { name: 'config_loads', status: 'UNKNOWN', detail: '' },
        { name: 'video_file', status: 'SKIPPED', detail: '第二步才接真影片' },
        { name: 'model_credentials', status: 'SKIPPED', detail: '第一步不讀金鑰' },
        ttsCredentialCheck(),
        { name: 'audio_device', status: 'SKIPPED', detail: '雲端環境無音效裝置' },
        { name: 'kick_webhook', status: 'SKIPPED', detail: '第三步才接 Kick' },
      ];
      try {
        loadConfig(resolve(arg(args, '--config', 'config/runtime.example.json')!));
        checks[1]!.status = 'OK';
      } catch (e) {
        checks[1]!.status = 'FAIL';
        checks[1]!.detail = (e as Error).message;
      }
      console.log(JSON.stringify({ checks, note: 'SKIPPED 不等於通過' }, null, 2));
      return checks.some((c) => c.status === 'FAIL') ? 1 : 0; // MISSING 與 SKIPPED 不算失敗，但也不算通過
    }
    case 'tts-test': {
      if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
        console.error('需要環境變數 AZURE_SPEECH_KEY 與 AZURE_SPEECH_REGION。沒有金鑰就不產生任何音檔（不做假結果）。');
        return 2;
      }
      const voicesArg = arg(args, '--voices', null);
      const limit = arg(args, '--limit', null);
      const lex = arg(args, '--lexicon', 'config/lexicon.zh-TW.json');
      const r = await runTtsTest({
        sentencesPath: resolve(arg(args, '--sentences', 'fixtures/pronunciation/sentences.json')!),
        outDir: resolve(arg(args, '--out', 'runtime/tts-test')!),
        voices: voicesArg ? voicesArg.split(',') : defaultVoices(),
        lexiconPath: lex && lex !== 'none' ? resolve(lex) : null,
        limit: limit ? Number(limit) : null,
        timeoutMs: Number(arg(args, '--timeout-ms', '15000')),
        rate: Number(arg(args, '--rate', '1')),
      });
      console.log(JSON.stringify({ ...r, indexFile: resolve(arg(args, '--out', 'runtime/tts-test')!, 'index.md') }, null, 2));
      return r.failures > 0 ? 1 : 0;
    }
    default:
      console.error('用法：arb <fixtures|replay|report|doctor|tts-test> [options]');
      console.error('  fixtures --scenario DIR --minutes N --seed S [--write-frames]');
      console.error('  replay --scenario DIR --config FILE --out FILE.jsonl [--inject-estop N] [--realtime] [--limit-minutes N] [--report-json FILE]');
      console.error('  report FILE.jsonl [--json] [--transcript N]');
      console.error('  doctor [--config FILE]');
      console.error('  tts-test [--voices a,b] [--limit N] [--lexicon FILE|none] [--out DIR]   需要 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exit(1);
  },
);
