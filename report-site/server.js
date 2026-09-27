// 極簡靜態網頁伺服器：多個報告頁面，供 Railway 部署。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const pages = {
  '/': 'index.html',        // 內部：問題、解法、參考案例
  '/client': 'client.html', // 對客戶：運作方式與為什麼標榜 AI
};
const port = Number(process.env.PORT || 3000);

createServer((req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const file = pages[path];
  if (!file || !existsSync(join(dir, file))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(readFileSync(join(dir, file)));
}).listen(port, () => console.log(`report site on :${port}`));
