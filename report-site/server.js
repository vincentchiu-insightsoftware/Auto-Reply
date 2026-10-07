// 極簡靜態網頁伺服器：單一報告頁，供 Railway 部署。舊的 /client、/internal 路徑一律導回首頁。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const html = () => readFileSync(join(dir, 'index.html'));

createServer((req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (path === '/client' || path === '/internal') {
    res.writeHead(302, { location: '/' });
    return res.end();
  }
  if (path === '/listen' || path.startsWith('/listen/')) {
    let rel = path === '/listen' ? 'index.html' : path.slice('/listen/'.length);
    try { rel = decodeURIComponent(rel); } catch { rel = ''; }
    if (!/^[\w.\u4e00-\u9fff-]+$/.test(rel)) { res.writeHead(404); return res.end(); }
    const f = join(dir, 'listen', rel);
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': rel.endsWith('.mp3') ? 'audio/mpeg' : 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(readFileSync(f));
  }
  if (path !== '/') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html());
}).listen(port, () => console.log(`report site on :${port}`));
