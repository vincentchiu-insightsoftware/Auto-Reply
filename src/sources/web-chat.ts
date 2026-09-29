/** WebChatSource：測試台網頁送進來的留言，當成直播留言。 */
import type { Clock } from '../clock.js';
import type { ChatMessage, ChatSource, SourceHealth } from '../types.js';

export class WebChatSource implements ChatSource {
  readonly id = 'web-chat';
  private queue: ChatMessage[] = [];
  private seq = 0;
  constructor(private clock: Clock) {}
  push(author: string, text: string): ChatMessage {
    const m: ChatMessage = { messageId: `w${++this.seq}`, idStability: 'stable', source: 'web', text, author, receivedAt: this.clock.now() };
    this.queue.push(m);
    return m;
  }
  async start(): Promise<void> {}
  async poll(): Promise<ChatMessage[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  health(): SourceHealth {
    return { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 };
  }
  async stop(): Promise<void> {}
}
