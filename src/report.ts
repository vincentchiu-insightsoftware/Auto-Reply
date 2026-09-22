/**
 * 回播報告：從 JSONL 事件算指標。覆蓋率以唯一合格留言為分母，遊戲評論另計。
 */
import { readFileSync } from 'node:fs';
import type { LogEvent } from './log/events.js';

export interface LatencyStat {
  n: number;
  median: number | null;
  p95: number | null;
  max: number | null;
}

export interface Report {
  scenario_time_ms: number | null;
  wall_time_ms: number | null;
  chat: {
    received_total: number;
    unique_eligible: number;
    covered_by_playback: number;
    coverage_rate: number | null;
    skipped_identity: number;
    unsafe_input_local: number;
    invalid_input: number;
    resend_duplicates_dropped: number;
    cross_source_same_id: number;
  };
  utterances_played: number;
  by_trigger: Record<string, number>;
  by_reason_code: Record<string, number>;
  game_comments_played: number;
  short_utterances_played: number;
  silences: number;
  model_calls: number;
  dropped_by_reason: Record<string, number>;
  latency_ms: { t1_event_to_model_sent: LatencyStat; t2_model_roundtrip: LatencyStat; t3_validate_and_tts: LatencyStat; t4_play_start: LatencyStat; total_event_to_play: LatencyStat };
  duplicate_playbacks: number;
  overlap_count: number;
  illegal_transitions: number;
  context_changes: number;
  estops: { count: number; max_silence_ms: number | null; late_playbacks_after_estop: number };
  budget: { hourUsd: number; sessionUsd: number; hourlyLimit: number | null; sessionLimit: number | null; settlements: number; over_limit_settlements: number } | null;
  paid_disabled_events: number;
  errors: number;
  transcript: { t: number; trigger: string; utterance: string; reply_keys: string[] }[];
}

function stat(xs: number[]): LatencyStat {
  if (xs.length === 0) return { n: 0, median: null, p95: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
}

export function readEvents(path: string): LogEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEvent);
}

export function buildReport(events: LogEvent[]): Report {
  const eligible = new Set<string>();
  const covered = new Set<string>();
  const dropped: Record<string, number> = {};
  const byTrigger: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const chat = { received_total: 0, skipped_identity: 0, unsafe_input_local: 0, invalid_input: 0, resend: 0 };
  const idBySource = new Map<string, Set<string>>();
  const t1: number[] = [], t2: number[] = [], t3: number[] = [], t4: number[] = [], tt: number[] = [];
  let played = 0, gameComments = 0, shortPlayed = 0, silences = 0, modelCalls = 0, dup = 0, overlap = 0, illegal = 0, ctx = 0, paidDisabled = 0, errors = 0;
  const spokenCount = new Map<string, number>();
  let estops = 0, maxSilence: number | null = null, lateAfterEstop = 0;
  let lastEstopGen: number | null = null;
  let budgetSnap: Report['budget'] = null;
  let settlements = 0, overLimit = 0;
  let scenarioMs: number | null = null, wallMs: number | null = null;
  const transcript: Report['transcript'] = [];

  for (const e of events) {
    switch (e.type) {
      case 'chat_received': {
        chat.received_total++;
        const cls = e.class as string;
        if (cls === 'eligible') eligible.add(e.key as string);
        else if (cls === 'skipped_identity') chat.skipped_identity++;
        else if (cls === 'unsafe_input_local') chat.unsafe_input_local++;
        else if (cls === 'invalid_input') chat.invalid_input++;
        const src = e.source as string, id = e.messageId as string;
        if (!idBySource.has(src)) idBySource.set(src, new Set());
        idBySource.get(src)!.add(id);
        break;
      }
      case 'drop': {
        const r = e.reason as string;
        dropped[r] = (dropped[r] ?? 0) + 1;
        if (r === 'resend_duplicate') chat.resend++;
        break;
      }
      case 'observation':
        modelCalls++;
        break;
      case 'silence':
        silences++;
        break;
      case 'playback_start': {
        played++;
        const trig = e.trigger as string;
        byTrigger[trig] = (byTrigger[trig] ?? 0) + 1;
        const rc = e.reason_code as string;
        byReason[rc] = (byReason[rc] ?? 0) + 1;
        if (trig !== 'chat') gameComments++;
        if (e.short) shortPlayed++;
        for (const k of e.reply_keys as string[]) {
          covered.add(k);
          spokenCount.set(k, (spokenCount.get(k) ?? 0) + 1);
        }
        const ev = e.t_event as number, ms = e.t_model_sent as number, mr = e.t_model_recv as number, ar = e.t_audio_ready as number, ps = e.t_play_start as number;
        t1.push(ms - ev);
        t2.push(mr - ms);
        t3.push(ar - mr);
        t4.push(ps - ar);
        tt.push(ps - ev);
        if (lastEstopGen !== null && (e.generation as number) < lastEstopGen) lateAfterEstop++;
        transcript.push({ t: e.t, trigger: trig, utterance: e.utterance as string, reply_keys: e.reply_keys as string[] });
        break;
      }
      case 'duplicate_playback':
        dup += (e.keys as string[]).length;
        break;
      case 'overlap':
        overlap++;
        break;
      case 'illegal_transition':
        illegal++;
        break;
      case 'context_change':
        ctx++;
        break;
      case 'emergency_stop': {
        estops++;
        const s = e.silenceMs as number;
        if (Number.isFinite(s)) maxSilence = maxSilence === null ? s : Math.max(maxSilence, s);
        lastEstopGen = e.generation as number;
        break;
      }
      case 'budget_settled': {
        settlements++;
        const b = e.budget as { hourUsd: number; hourlyLimit: number | null; sessionUsd: number; sessionLimit: number | null };
        if ((b.hourlyLimit !== null && b.hourUsd > b.hourlyLimit + 1e-9) || (b.sessionLimit !== null && b.sessionUsd > b.sessionLimit + 1e-9)) overLimit++;
        break;
      }
      case 'paid_disabled':
        paidDisabled++;
        break;
      case 'error':
        errors++;
        break;
      case 'stopped':
        if (e.budget) {
          const b = e.budget as { hourUsd: number; sessionUsd: number; hourlyLimit: number | null; sessionLimit: number | null };
          budgetSnap = { hourUsd: b.hourUsd, sessionUsd: b.sessionUsd, hourlyLimit: b.hourlyLimit, sessionLimit: b.sessionLimit, settlements: 0, over_limit_settlements: 0 };
        }
        break;
      case 'replay_end':
        scenarioMs = e.scenarioMs as number;
        wallMs = e.wallMs as number;
        break;
    }
  }
  if (budgetSnap) {
    budgetSnap.settlements = settlements;
    budgetSnap.over_limit_settlements = overLimit;
  }
  for (const n of spokenCount.values()) if (n > 1) dup = Math.max(dup, n - 1);
  const coveredEligible = [...covered].filter((k) => eligible.has(k)).length;
  // 跨來源同 ID：不同 source 出現相同 messageId 的數量
  let cross = 0;
  const sources = [...idBySource.entries()];
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) for (const id of sources[i]![1]) if (sources[j]![1].has(id)) cross++;
  return {
    scenario_time_ms: scenarioMs,
    wall_time_ms: wallMs,
    chat: {
      received_total: chat.received_total,
      unique_eligible: eligible.size,
      covered_by_playback: coveredEligible,
      coverage_rate: eligible.size === 0 ? null : coveredEligible / eligible.size,
      skipped_identity: chat.skipped_identity,
      unsafe_input_local: chat.unsafe_input_local,
      invalid_input: chat.invalid_input,
      resend_duplicates_dropped: chat.resend,
      cross_source_same_id: cross,
    },
    utterances_played: played,
    by_trigger: byTrigger,
    by_reason_code: byReason,
    game_comments_played: gameComments,
    short_utterances_played: shortPlayed,
    silences,
    model_calls: modelCalls,
    dropped_by_reason: dropped,
    latency_ms: { t1_event_to_model_sent: stat(t1), t2_model_roundtrip: stat(t2), t3_validate_and_tts: stat(t3), t4_play_start: stat(t4), total_event_to_play: stat(tt) },
    duplicate_playbacks: dup,
    overlap_count: overlap,
    illegal_transitions: illegal,
    context_changes: ctx,
    estops: { count: estops, max_silence_ms: maxSilence, late_playbacks_after_estop: lateAfterEstop },
    budget: budgetSnap,
    paid_disabled_events: paidDisabled,
    errors,
    transcript,
  };
}

function fmtMs(x: number | null): string {
  return x === null ? '-' : `${(x / 1000).toFixed(2)}s`;
}
function fmtStat(s: LatencyStat): string {
  return `n=${s.n} 中位數 ${fmtMs(s.median)} p95 ${fmtMs(s.p95)} 最大 ${fmtMs(s.max)}`;
}

export function renderReport(r: Report, opts: { transcript: number } = { transcript: 12 }): string {
  const L: string[] = [];
  L.push('# 回播報告（mock）');
  L.push(`場景時間 ${fmtMs(r.scenario_time_ms)}，實際 wall time ${fmtMs(r.wall_time_ms)}。mock 的延遲是設定值，不代表真實模型或 TTS。`);
  L.push('');
  L.push('## 留言');
  L.push(`- 收到 ${r.chat.received_total} 則；唯一合格（可回答）${r.chat.unique_eligible} 則；被已播回覆涵蓋 ${r.chat.covered_by_playback} 則；覆蓋率 ${r.chat.coverage_rate === null ? '-' : (r.chat.coverage_rate * 100).toFixed(1) + '%'}`);
  L.push(`- 身分提問略過 ${r.chat.skipped_identity}；注入樣式本機擋下 ${r.chat.unsafe_input_local}；空白/超長 ${r.chat.invalid_input}；同來源重送丟棄 ${r.chat.resend_duplicates_dropped}；跨來源同 ID ${r.chat.cross_source_same_id} 組（各自獨立，未互相吃掉）`);
  L.push('');
  L.push('## 發言');
  L.push(`- 模型呼叫 ${r.model_calls} 次；播出 ${r.utterances_played} 句（留言回覆 ${r.by_trigger['chat'] ?? 0}、遊戲評論 ${r.game_comments_played}）；短句 ${r.short_utterances_played}；合法安靜 ${r.silences} 次`);
  L.push(`- reason_code：${Object.entries(r.by_reason_code).map(([k, v]) => `${k}=${v}`).join('，') || '-'}`);
  L.push('');
  L.push('## 丟棄分類');
  for (const [k, v] of Object.entries(r.dropped_by_reason).sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${v}`);
  L.push('');
  L.push('## 延遲（場景時間）');
  L.push(`- t1 事件→送模型：${fmtStat(r.latency_ms.t1_event_to_model_sent)}`);
  L.push(`- t2 模型往返：${fmtStat(r.latency_ms.t2_model_roundtrip)}`);
  L.push(`- t3 驗證+TTS：${fmtStat(r.latency_ms.t3_validate_and_tts)}`);
  L.push(`- t4 播放啟動：${fmtStat(r.latency_ms.t4_play_start)}`);
  L.push(`- 合計 事件→開始播放：${fmtStat(r.latency_ms.total_event_to_play)}`);
  L.push('');
  L.push('## 安全性檢查');
  L.push(`- 同一留言重播次數：${r.duplicate_playbacks}（必須 0）`);
  L.push(`- 播放重疊：${r.overlap_count}（必須 0）`);
  L.push(`- 非法狀態轉換：${r.illegal_transitions}（必須 0）`);
  L.push(`- 換局次數：${r.context_changes}`);
  L.push(`- 急停 ${r.estops.count} 次，最長靜音 ${fmtMs(r.estops.max_silence_ms)}，急停後晚到播放 ${r.estops.late_playbacks_after_estop}（必須 0）`);
  L.push(`- 付費停用事件：${r.paid_disabled_events}；ERROR 次數：${r.errors}`);
  if (r.budget) L.push(`- 預算（假費率）：本小時 $${r.budget.hourUsd.toFixed(4)} / 上限 ${r.budget.hourlyLimit ?? 'null'}；整場 $${r.budget.sessionUsd.toFixed(4)} / 上限 ${r.budget.sessionLimit ?? 'null'}；結算 ${r.budget.settlements} 筆，超限 ${r.budget.over_limit_settlements} 筆（必須 0）`);
  L.push('');
  L.push(`## 文字 transcript（前 ${opts.transcript} 句）`);
  for (const t of r.transcript.slice(0, opts.transcript)) L.push(`- [${fmtMs(t.t)}] (${t.trigger}) ${t.utterance}${t.reply_keys.length ? `  ← ${t.reply_keys.join(', ')}` : ''}`);
  return L.join('\n');
}
