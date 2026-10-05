/**
 * Kick 官方 API（docs.kick.com）：OAuth 2.1 + PKCE、事件訂閱（webhook）、webhook 簽章驗證。
 * - 只用內建 fetch / crypto，不裝套件。
 * - token 存在記憶體與 runtime/kick-token.json（雲端重新部署會消失，重按「連接 Kick」即可；
 *   Kick 那邊的訂閱不會消失，webhook 驗證用的是 Kick 公鑰，不需要 token）。
 */
import { createHash, randomBytes, verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const KICK_ID = 'https://id.kick.com';
export const KICK_API = 'https://api.kick.com';
export const KICK_SCOPES = ['user:read', 'channel:read', 'events:subscribe'];

export interface KickToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
}

export interface KickClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
}

export interface KickChatEvent {
  messageId: string;
  author: string;
  text: string;
  senderUserId: number | null;
  broadcasterUserId: number | null;
  broadcasterSlug: string | null;
}

/** 純函式：驗 Kick webhook 簽章（RSA-SHA256 PKCS#1 v1.5，簽的是 `${id}.${ts}.${body}`）。 */
export function verifyKickSignature(publicKeyPem: string, messageId: string, timestamp: string, rawBody: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify('sha256', Buffer.from(`${messageId}.${timestamp}.${rawBody}`), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** 把 chat.message.sent 的 payload 轉成我們的留言。 */
export function parseKickChat(payload: unknown): KickChatEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const sender = (p.sender ?? {}) as Record<string, unknown>;
  const broadcaster = (p.broadcaster ?? {}) as Record<string, unknown>;
  const text = typeof p.content === 'string' ? p.content : '';
  const messageId = typeof p.message_id === 'string' ? p.message_id : '';
  if (!messageId || !text.trim()) return null;
  return {
    messageId,
    author: typeof sender.username === 'string' ? sender.username : '觀眾',
    text,
    senderUserId: typeof sender.user_id === 'number' ? sender.user_id : null,
    broadcasterUserId: typeof broadcaster.user_id === 'number' ? broadcaster.user_id : null,
    broadcasterSlug: typeof broadcaster.channel_slug === 'string' ? broadcaster.channel_slug : null,
  };
}

export class KickClient {
  private token: KickToken | null = null;
  private pending = new Map<string, { verifier: string; at: number }>();
  private publicKey: { pem: string; at: number } | null = null;
  private seenMessageIds: string[] = [];
  private seenSet = new Set<string>();
  constructor(private o: KickClientOptions) {
    if (existsSync(o.tokenPath)) {
      try {
        this.token = JSON.parse(readFileSync(o.tokenPath, 'utf8')) as KickToken;
      } catch { this.token = null; }
    }
  }

  connected(): boolean {
    return this.token !== null;
  }

  /** 產生授權網址（PKCE S256）。state 用來對回 verifier。 */
  authUrl(): string {
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    // 10 分鐘內沒回來就丟掉
    for (const [k, v] of this.pending) if (Date.now() - v.at > 600_000) this.pending.delete(k);
    this.pending.set(state, { verifier, at: Date.now() });
    const q = new URLSearchParams({
      response_type: 'code', client_id: this.o.clientId, redirect_uri: this.o.redirectUri, state,
      scope: KICK_SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256',
    });
    return `${KICK_ID}/oauth/authorize?${q}`;
  }

  async exchange(code: string, state: string): Promise<void> {
    const p = this.pending.get(state);
    if (!p) throw new Error('state 不對或已過期，請重新按「連接 Kick」');
    this.pending.delete(state);
    await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.o.redirectUri, code_verifier: p.verifier });
  }

  private async tokenRequest(fields: Record<string, string>): Promise<void> {
    const body = new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, ...fields });
    const res = await fetch(`${KICK_ID}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Kick token ${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // 文件寫的是平的；萬一包在 data 裡也接得住
    const d = (typeof parsed.access_token === 'string' ? parsed : (parsed.data as Record<string, unknown>) ?? parsed) as unknown as { access_token: string; refresh_token: string; expires_in: number | string; scope: string; token_type?: string };
    console.log('kick token response keys:', Object.keys(parsed).join(','), 'token_type:', d.token_type ?? '?', 'scope:', d.scope ?? '?', 'expires_in:', d.expires_in ?? '?');
    if (typeof d.access_token !== 'string' || !d.access_token) throw new Error(`Kick token 回應沒有 access_token（欄位：${Object.keys(parsed).join(',')}）`);
    this.token = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + Number(d.expires_in) * 1000, scope: d.scope };
    mkdirSync(dirname(this.o.tokenPath), { recursive: true });
    writeFileSync(this.o.tokenPath, JSON.stringify(this.token));
  }

  private async accessToken(): Promise<string> {
    if (!this.token) throw new Error('尚未連接 Kick');
    if (Date.now() > this.token.expires_at - 60_000) {
      await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.token.refresh_token });
    }
    return this.token!.access_token;
  }

  /** 不回傳 token 本身，只回傳足以除錯的資訊。 */
  tokenInfo(): { scope: string; expiresAt: number; accessTokenLength: number; refreshTokenLength: number } | null {
    if (!this.token) return null;
    return { scope: this.token.scope, expiresAt: this.token.expires_at, accessTokenLength: this.token.access_token?.length ?? 0, refreshTokenLength: this.token.refresh_token?.length ?? 0 };
  }

  /** Kick 的 token 自我檢查端點：active、scope、client_id、exp。 */
  async introspect(): Promise<unknown> {
    const tok = await this.accessToken();
    const res = await fetch(`${KICK_API}/public/v1/token/introspect`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 500) };
  }

  forget(): void {
    this.token = null;
    if (existsSync(this.o.tokenPath)) unlinkSync(this.o.tokenPath);
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = await this.accessToken();
    const init: RequestInit = { method, headers: { authorization: `Bearer ${tok}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(15_000) };
    if (body) init.body = JSON.stringify(body);
    const res = await fetch(`${KICK_API}${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`Kick API ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async me(): Promise<{ user_id: number; name: string } | null> {
    const r = await this.api<{ data?: { user_id: number; name: string }[] }>('GET', '/public/v1/users');
    return r.data?.[0] ?? null;
  }

  async channel(): Promise<{ slug: string; broadcaster_user_id: number; stream_title?: string; stream?: { is_live?: boolean; viewer_count?: number } } | null> {
    const r = await this.api<{ data?: { slug: string; broadcaster_user_id: number; stream_title?: string; stream?: { is_live?: boolean; viewer_count?: number } }[] }>('GET', '/public/v1/channels');
    return r.data?.[0] ?? null;
  }

  async subscriptions(): Promise<{ id: string; event: string; version: number; method: string }[]> {
    const r = await this.api<{ data?: { id: string; event: string; version: number; method: string }[] }>('GET', '/public/v1/events/subscriptions');
    return r.data ?? [];
  }

  async subscribeChat(): Promise<{ name: string; version: number; subscription_id?: string; error?: string }[]> {
    const r = await this.api<{ data?: { name: string; version: number; subscription_id?: string; error?: string }[] }>('POST', '/public/v1/events/subscriptions', {
      events: [{ name: 'chat.message.sent', version: 1 }], method: 'webhook',
    });
    return r.data ?? [];
  }

  async unsubscribeAll(): Promise<number> {
    const subs = await this.subscriptions();
    if (subs.length === 0) return 0;
    const q = subs.map((s) => `id=${encodeURIComponent(s.id)}`).join('&');
    await this.api('DELETE', `/public/v1/events/subscriptions?${q}`);
    return subs.length;
  }

  /** Kick 公鑰：官方要求不要寫死，會輪替；快取 1 小時，驗證失敗時重抓一次。 */
  private async fetchPublicKey(force = false): Promise<string> {
    if (!force && this.publicKey && Date.now() - this.publicKey.at < 3_600_000) return this.publicKey.pem;
    const res = await fetch(`${KICK_API}/public/v1/public-key`, { signal: AbortSignal.timeout(10_000) });
    const d = (await res.json()) as { data?: { public_key?: string } };
    const pem = d.data?.public_key;
    if (!pem) throw new Error('拿不到 Kick 公鑰');
    this.publicKey = { pem, at: Date.now() };
    return pem;
  }

  /** 驗 webhook；回傳 ok 與是否重複（Kick 可能重送）。 */
  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ ok: boolean; duplicate: boolean; reason?: string }> {
    const id = headers['kick-event-message-id'] ?? '';
    const ts = headers['kick-event-message-timestamp'] ?? '';
    const sig = headers['kick-event-signature'] ?? '';
    if (!id || !ts || !sig) return { ok: false, duplicate: false, reason: 'missing headers' };
    let pem = await this.fetchPublicKey();
    let ok = verifyKickSignature(pem, id, ts, rawBody, sig);
    if (!ok) {
      pem = await this.fetchPublicKey(true);
      ok = verifyKickSignature(pem, id, ts, rawBody, sig);
    }
    if (!ok) return { ok: false, duplicate: false, reason: 'bad signature' };
    if (this.seenSet.has(id)) return { ok: true, duplicate: true };
    this.seenSet.add(id);
    this.seenMessageIds.push(id);
    if (this.seenMessageIds.length > 2000) this.seenSet.delete(this.seenMessageIds.shift()!);
    return { ok: true, duplicate: false };
  }
}
