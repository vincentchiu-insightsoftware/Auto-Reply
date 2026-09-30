/**
 * 內部測試台（第一段）：瀏覽器播影片並回報播放位置；同事在網頁留言；
 * Director 用 Claude（或 mock）決定講什麼，Azure 合成聲音，網頁播出並顯示 transcript。
 * 不推流、不接 Kick。存取需要 STAGE_TOKEN。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { RealClock } from '../clock.js';
import { loadConfig } from '../config.js';
import { EventLog, type LogEvent } from '../log/events.js';
import { loadPersona, loadReference } from '../context/persona.js';
import { Director } from '../director/director.js';
import { VideoFrameSource } from '../sources/video.js';
import { WebChatSource } from '../sources/web-chat.js';
import { WebPlayer, type PlayEvent } from '../audio/web-player.js';
import { ClaudeModelProvider } from '../providers/claude-model.js';
import { MockModelProvider } from '../providers/mock-model.js';
import { AzureTtsProvider } from '../providers/azure-tts.js';
import { MockTtsProvider } from '../providers/mock-tts.js';
import { loadHomophones } from '../text/homophones.js';
import type { ModelProvider, TtsProvider } from '../types.js';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.STAGE_TOKEN || randomBytes(6).toString('hex');
const CONFIG_PATH = process.env.STAGE_CONFIG || 'config/runtime.stage.json';
const VIDEO_PATH = resolve(process.env.VIDEO_PATH || 'runtime/video/game.mp4');
const VIDEO_URL = process.env.VIDEO_URL || '';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const SYSTEM_RULES = readFileSync(join(ROOT, 'stage', 'system-rules.md'), 'utf8');

async function ensureVideo(): Promise<void> {
  if (existsSync(VIDEO_PATH)) return;
  if (!VIDEO_URL) throw new Error(`影片不存在：${VIDEO_PATH}，且未設定 VIDEO_URL`);
  mkdirSync(resolve(VIDEO_PATH, '..'), { recursive: true });
  const m = VIDEO_URL.match(/\/d\/([^/]+)/) || VIDEO_URL.match(/[?&]id=([^&]+)/);
  const url = m ? `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t` : VIDEO_URL;
  console.log('downloading video…');
  const res = await fetch(url, { redirect: 'follow' });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !res.body) throw new Error(`影片下載失敗：HTTP ${res.status}`);
  if (ct.includes('text/html')) throw new Error('影片下載失敗：Google Drive 回傳的是網頁不是影片（檔案可能未開放「知道連結的人」檢視）');
  const tmp = VIDEO_PATH + '.part';
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
  renameSync(tmp, VIDEO_PATH);
  console.log(`video downloaded: ${statSync(VIDEO_PATH).size} bytes, type ${ct}`);
}

function probeDurationMs(): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO_PATH]).toString().trim();
  return Math.round(Number(out) * 1000);
}

// ---- SSE ----
const clients = new Set<ServerResponse>();
function broadcast(obj: unknown): void {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(line);
}

class BroadcastLog extends EventLog {
  override write(ev: LogEvent): void {
    super.write(ev);
    if (['chat_received', 'drop', 'silence', 'model_result', 'playback_start', 'playback_end', 'state', 'paused', 'resumed', 'emergency_stop', 'error', 'error_reset', 'throttle', 'source_health', 'budget_settled', 'paid_disabled', 'paid_reenabled', 'context_change'].includes(ev.type))
      broadcast({ kind: 'log', ev });
  }
}

async function main(): Promise<void> {
  await ensureVideo();
  const durationMs = probeDurationMs();
  const config = loadConfig(resolve(ROOT, CONFIG_PATH));
  const clock = new RealClock();
  mkdirSync(join(ROOT, 'runtime', 'logs'), { recursive: true });
  const log = new BroadcastLog(clock, join(ROOT, 'runtime', 'logs', `stage-${Date.now()}.jsonl`));
  const persona = loadPersona(resolve(ROOT, config.persona_path));
  const reference = loadReference(config.reference_path ? resolve(ROOT, config.reference_path) : null, config.director.max_reference_characters);
  const homophones = loadHomophones(existsSync(join(ROOT, 'config/homophones.zh-TW.json')) ? join(ROOT, 'config/homophones.zh-TW.json') : null);

  const frames = new VideoFrameSource(clock, VIDEO_PATH, durationMs, { width: 960, jpegQuality: 6, changeThreshold: 6, staleMs: 6000, ffmpeg: FFMPEG });
  const chat = new WebChatSource(clock);
  const player = new WebPlayer(clock, (ev: PlayEvent) => broadcast({ kind: 'audio', ...ev }));

  let model: ModelProvider;
  let modelMode: string;
  if (config.model.provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
    model = new ClaudeModelProvider({ modelId: config.model.model_id ?? 'claude-opus-5-5', maxOutputTokens: config.model.max_output_tokens, effort: 'low', systemRules: SYSTEM_RULES, price: config.budget.price_table ? { input: config.budget.price_table.input_per_mtok, output: config.budget.price_table.output_per_mtok } : null });
    modelMode = `claude (${config.model.model_id})`;
  } else {
    model = new MockModelProvider(clock, null, { baseLatencyMs: 1200, jitterMs: 800, timeoutMs: config.model.timeout_ms, seed: 7 });
    modelMode = 'mock（尚未設定 ANTHROPIC_API_KEY，回覆是固定模板）';
  }
  let tts: TtsProvider;
  let ttsMode: string;
  if (config.tts.provider === 'azure' && process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) {
    tts = AzureTtsProvider.fromEnv(config.tts.voice_id ?? 'zh-TW-HsiaoChenNeural', { homophones, pricePerMillionChars: config.budget.price_table?.tts_per_mchar ?? null });
    ttsMode = `azure (${config.tts.voice_id})`;
  } else {
    tts = new MockTtsProvider(clock, null);
    ttsMode = 'mock（無聲）';
  }

  const director = new Director({ clock, config, persona: { ...persona, voice_id: config.tts.voice_id ?? null }, reference, planNotes: [], frames, chat, model, tts, player, log });
  await director.start();
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    director.tick().catch((e) => log.emit('tick_error', { error: (e as Error).message })).finally(() => (ticking = false));
  }, config.director.tick_ms);

  const html = readFileSync(join(ROOT, 'stage', 'index.html'), 'utf8');
  const authed = (req: IncomingMessage): boolean => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.searchParams.get('key') === TOKEN) return true;
    const cookie = req.headers.cookie || '';
    return cookie.split(';').some((c) => c.trim() === `stage=${TOKEN}`);
  };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((ok) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        try { ok(JSON.parse(s || '{}')); } catch { ok({}); }
      });
    });

  createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    if (path === '/health') return json(res, 200, { ok: true, state: director.state });
    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('需要存取碼：在網址後面加 ?key=…');
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `stage=${TOKEN}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end(html.replace('__MODEL_MODE__', modelMode).replace('__TTS_MODE__', ttsMode).replace('__PERSONA__', persona.name));
    }
    if (path === '/video') {
      const size = statSync(VIDEO_PATH).size;
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)!;
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(start + 4_000_000, size - 1);
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'video/mp4' });
        return createReadStream(VIDEO_PATH, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-length': size, 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
      return createReadStream(VIDEO_PATH).pipe(res);
    }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', status: director.status() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path.startsWith('/audio/')) {
      const a = player.getAudio(path.slice(7));
      if (!a) return json(res, 404, { error: 'gone' });
      res.writeHead(200, { 'content-type': a.mediaType, 'content-length': a.bytes.length });
      return res.end(a.bytes);
    }
    if (path === '/status') return json(res, 200, { ...director.status(), modelMode, ttsMode, videoDurationMs: durationMs, playhead: frames.playhead });
    if (req.method === 'POST' && path === '/comment') {
      const b = await readBody(req);
      const text = String(b.text ?? '').slice(0, 500);
      const author = String(b.author ?? '同事').slice(0, 40);
      if (!text.trim()) return json(res, 400, { error: 'empty' });
      const m = chat.push(author, text);
      broadcast({ kind: 'comment', author, text, messageId: m.messageId, t: clock.now() });
      return json(res, 200, { ok: true, messageId: m.messageId });
    }
    if (req.method === 'POST' && path === '/playhead') {
      const b = await readBody(req);
      frames.playhead = { videoTimeMs: Number(b.t ?? 0) * 1000, reportedAt: clock.now(), playing: Boolean(b.playing), loop: Number(b.loop ?? 0) };
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/played') {
      const b = await readBody(req);
      player.reportEnded(String(b.id ?? ''));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/control') {
      const b = await readBody(req);
      const cmd = String(b.cmd ?? '');
      if (cmd === 'pause') director.pause('web');
      else if (cmd === 'resume') await director.resume();
      else if (cmd === 'estop') await director.emergencyStop();
      else if (cmd === 'reenable') director.reenablePaid();
      else return json(res, 400, { error: 'unknown cmd' });
      return json(res, 200, { ok: true, state: director.state });
    }
    json(res, 404, { error: 'not found' });
  }).listen(PORT, () => {
    console.log(`stage on :${PORT}  token=${TOKEN}  model=${modelMode}  tts=${ttsMode}  video=${(durationMs / 1000).toFixed(0)}s`);
    writeFileSync(join(ROOT, 'runtime', 'stage-token.txt'), TOKEN);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
