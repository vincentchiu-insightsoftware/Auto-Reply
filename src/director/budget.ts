/**
 * 預算：先預留、完成後結算。逾時或未知用量以預留額結算，不假定零費用。
 * 費率表為 null 時不允許任何付費呼叫。滑動一小時窗與整場總額分開計。
 */
export interface PriceTable {
  input_per_mtok: number;
  output_per_mtok: number;
  tts_per_mchar: number;
}

export interface Reservation {
  id: number;
  usd: number;
  at: number;
  settled: boolean;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

export class Budget {
  private ledger: { at: number; usd: number }[] = [];
  private open = new Map<number, Reservation>();
  private nextId = 1;
  private sessionTotal = 0;
  constructor(
    private prices: PriceTable | null,
    private hourlyLimit: number | null,
    private sessionLimit: number | null,
    private now: () => number,
  ) {}

  imageTokens(w: number, h: number): number {
    return Math.ceil(w / 28) * Math.ceil(h / 28);
  }
  estimateModelUsd(inputTokens: number, imageTokens: number, maxOutputTokens: number): number {
    if (!this.prices) throw new BudgetError('price table unknown; paid call not allowed');
    return ((inputTokens + imageTokens) * this.prices.input_per_mtok + maxOutputTokens * this.prices.output_per_mtok) / 1_000_000;
  }
  ttsUsd(chars: number): number {
    if (!this.prices) throw new BudgetError('price table unknown; paid call not allowed');
    return (chars * this.prices.tts_per_mchar) / 1_000_000;
  }
  private hourSpent(): number {
    const cutoff = this.now() - 3_600_000;
    this.ledger = this.ledger.filter((x) => x.at > cutoff);
    let s = 0;
    for (const x of this.ledger) s += x.usd;
    for (const r of this.open.values()) s += r.usd;
    return s;
  }
  private sessionCommitted(): number {
    let s = this.sessionTotal;
    for (const r of this.open.values()) s += r.usd;
    return s;
  }
  /** 預留失敗回傳 null，呼叫方記 budget_stop。 */
  reserve(usd: number): Reservation | null {
    if (this.hourlyLimit === null || this.sessionLimit === null) throw new BudgetError('limits unauthorized (null)');
    if (this.hourSpent() + usd > this.hourlyLimit) return null;
    if (this.sessionCommitted() + usd > this.sessionLimit) return null;
    const r: Reservation = { id: this.nextId++, usd, at: this.now(), settled: false };
    this.open.set(r.id, r);
    return r;
  }
  /** actualUsd 為 null 表示未知（逾時、中止），以預留額結算。 */
  settle(r: Reservation, actualUsd: number | null): number {
    if (r.settled) return 0;
    r.settled = true;
    this.open.delete(r.id);
    const charged = actualUsd === null ? r.usd : Math.min(Math.max(actualUsd, 0), Math.max(r.usd, actualUsd));
    this.ledger.push({ at: this.now(), usd: charged });
    this.sessionTotal += charged;
    return charged;
  }
  snapshot(): { hourUsd: number; sessionUsd: number; openReservations: number; hourlyLimit: number | null; sessionLimit: number | null } {
    return { hourUsd: this.hourSpent(), sessionUsd: this.sessionCommitted(), openReservations: this.open.size, hourlyLimit: this.hourlyLimit, sessionLimit: this.sessionLimit };
  }
}
