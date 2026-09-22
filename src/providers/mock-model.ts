/**
 * MockModelProvider：可腳本化。固定模板回覆，只證明管線與驗證，不證明模型理解畫面或抗注入。
 * 依 FaultSchedule 模擬逾時、429、格式錯誤、超長、宣稱真人、晚到、額度用盡。
 */
import type { Clock } from '../clock.js';
import { ModelTimeoutError, RateLimitError, SpendLimitError, type DecisionInput, type ModelProvider, type ModelResult, type ProviderUsage, type RawDecision } from '../types.js';
import type { FaultSchedule } from './faults.js';
import { Prng } from '../util/prng.js';
import { countChars } from '../util/text.js';

const MODEL_FAULTS = ['model_timeout', 'model_rate_limit', 'model_malformed', 'model_overlong', 'model_human_claim', 'model_late', 'model_spend_limit'] as const;

const REACTIONS = ['這波有戲。', '先穩住，別急。', '看這節奏應該還有機會。', '對面壓得有點兇。', '這局節奏我喜歡。', '先看下一步再說。'];

export class MockModelProvider implements ModelProvider {
  readonly id = 'mock-model';
  private u: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  private rng: Prng;
  constructor(
    private clock: Clock,
    private faults: FaultSchedule | null,
    private opts: { baseLatencyMs: number; jitterMs: number; timeoutMs: number; seed: number },
  ) {
    this.rng = new Prng(opts.seed);
  }
  usage(): ProviderUsage {
    return { ...this.u };
  }

  private estimateInput(input: DecisionInput): { inputTokens: number; imageTokens: number } {
    let text = 400; // 系統指令
    text += JSON.stringify(input.persona).length / 2;
    for (const r of input.referenceExcerpts) text += r.length / 1.5;
    for (const c of input.untrustedChat) text += c.text.length / 1.2 + 12;
    for (const s of input.recentSpoken) text += s.length / 1.5;
    let img = 0;
    for (const f of input.frames) img += Math.ceil(f.width / 28) * Math.ceil(f.height / 28);
    return { inputTokens: Math.round(text), imageTokens: img };
  }

  async decide(input: DecisionInput, signal: AbortSignal): Promise<ModelResult> {
    this.u.calls++;
    const est = this.estimateInput(input);
    this.u.inputTokens += est.inputTokens;
    this.u.imageTokens += est.imageTokens;
    const fault = this.faults?.active(this.clock.now(), MODEL_FAULTS) ?? null;

    if (fault === 'model_spend_limit') throw new SpendLimitError();
    if (fault === 'model_rate_limit') {
      await this.clock.sleep(300, signal);
      throw new RateLimitError(10_000);
    }
    if (fault === 'model_timeout') {
      // 永遠不回；由 director 的 timeout 中止
      await this.clock.sleep(this.opts.timeoutMs * 10, signal);
      throw new ModelTimeoutError();
    }
    if (fault === 'model_late') {
      // 晚到：故意不理會 abort，超過 timeout 後才回，用來測晚到結果是否被丟棄
      await this.clock.sleep(this.opts.timeoutMs + 3000);
    } else {
      await this.clock.sleep(this.opts.baseLatencyMs + this.rng.int(0, this.opts.jitterMs), signal);
    }
    if (fault === 'model_malformed') return { decision: { speak: 'yes', text: 'oops' }, usage: { ...est, outputTokens: 20 } };

    const chat = input.untrustedChat.slice(-2);
    let decision: RawDecision;
    if (fault === 'model_overlong') {
      decision = { speak: true, utterance: '這波真的很精彩，'.repeat(12), reply_to_ids: chat.map((c) => c.messageId), observation_id: input.observationId, reason_code: 'chat_reply' };
    } else if (fault === 'model_human_claim') {
      decision = { speak: true, utterance: '我當然是真人啦，別亂講。', reply_to_ids: chat.map((c) => c.messageId), observation_id: input.observationId, reason_code: 'chat_reply' };
    } else if (chat.length > 0) {
      const last = chat[chat.length - 1]!;
      const quoted = Array.from(last.text.trim()).slice(0, 14).join('');
      const reaction = REACTIONS[this.rng.int(0, REACTIONS.length - 1)]!;
      const facts = input.frames[0]?.mockFacts;
      const tail = facts && facts.kind !== 'black' ? `現在第${facts.round}局，${facts.scoreA}比${facts.scoreB}。` : '';
      let utt = `有人問${quoted}，${reaction}${tail}`;
      if (countChars(utt) > input.constraints.maxCharacters) utt = `有人問${quoted}，${reaction}`;
      decision = { speak: true, utterance: utt, reply_to_ids: chat.map((c) => c.messageId), observation_id: input.observationId, reason_code: 'chat_reply' };
    } else {
      const facts = input.frames[0]?.mockFacts;
      if (facts && facts.kind !== 'black') {
        const r = this.rng.next();
        if (r < 0.15) {
          decision = { speak: false, utterance: '', reply_to_ids: [], observation_id: input.observationId, reason_code: 'no_new_information' };
        } else if (r < 0.25) {
          decision = { speak: true, utterance: '漂亮！', reply_to_ids: [], observation_id: input.observationId, reason_code: 'game_event' };
        } else {
          const st = facts.status === 'clutch' ? '關鍵時刻了' : facts.status === 'push' ? '這波在推進' : '節奏還算平穩';
          decision = { speak: true, utterance: `第${facts.round}局${facts.scoreA}比${facts.scoreB}，${st}。${REACTIONS[this.rng.int(0, REACTIONS.length - 1)]}`, reply_to_ids: [], observation_id: input.observationId, reason_code: 'game_event' };
        }
      } else {
        decision = { speak: false, utterance: '', reply_to_ids: [], observation_id: input.observationId, reason_code: 'uncertain' };
      }
    }
    const outputTokens = Math.round(decision.utterance.length * 1.5) + 30;
    this.u.outputTokens += outputTokens;
    return { decision, usage: { ...est, outputTokens } };
  }
}
