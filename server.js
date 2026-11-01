// 照片 app 的本地服务器：在电脑上运行 app，并让 iPhone 通过同一个 Wi-Fi 接收收藏的照片。
// 用法：双击「启动照片.cmd」，或运行 node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = __dirname;
const FIXED_PORT = Number(process.env.PORT) || 0;
const START_PORT = FIXED_PORT || 8848;
const OPEN_BROWSER = !process.argv.includes('--no-open');

let shared = [];   // photos the PC app has sent for the phone: {id, name, type, date, data}
let nextId = 1;

/* ---------- helpers ---------- */
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const allowedOrigin = o => o === 'null' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal || i.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|Bluetooth/i.test(name);
      out.push({ address: i.address, score: (virtual ? 0 : 2) + (i.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map(x => x.address);
}

function readBody(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function uniqueName(name) {
  const clean = (name || 'photo.jpg').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'photo.jpg';
  const taken = new Set(shared.map(s => s.name));
  if (!taken.has(clean)) return clean;
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})${ext}`)) return `${base} (${n})${ext}`;
}
function addShared(name, type, date, data) {
  const item = { id: String(nextId++), name: uniqueName(name), type: type || 'image/jpeg', date: Number(date) || Date.now(), data };
  shared.push(item);
  return item;
}

/* ---------- ZIP (no compression; photos are already compressed) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), size = f.data.length, { time, date } = dosTime(f.date);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);  // 0x0800 = UTF-8 names
    local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(size, 20); cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ---------- languages ---------- */
// zh = Simplified Chinese, zht = Traditional Chinese, en = everything else
function pickLang(tag) {
  const l = String(tag || '').trim();
  if (/^zh/i.test(l)) return /hant|-(tw|hk|mo)\b/i.test(l) ? 'zht' : 'zh';
  return 'en';
}
const langFromRequest = req => pickLang((req.headers['accept-language'] || '').split(',')[0]);
const SYSTEM_LANG = pickLang(Intl.DateTimeFormat().resolvedOptions().locale);
const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const PHONE = {
  zh: {
    html: 'zh-CN', title: '收藏的照片', from: '来自电脑', fromN: n => `来自电脑 · ${n} 张`,
    tipTitle: '保存到 iPhone 的「照片」', tip: '长按任意一张照片，选择 <b>「存储到“照片”」</b>。',
    all: n => `全部下载（${n} 张）`,
    many: n => `照片多的话：下载后到「文件」App →「下载项」点开压缩包，进入文件夹，点右上角「选择」→ 全选 → 分享 →「存储 ${n} 张图像」。`,
    emptyTitle: '还没有照片', empty: '在电脑上打开照片 app 的「收藏」，点右上角「分享到 iPhone」，然后刷新这个页面。',
    zip: '收藏的照片.zip',
  },
  zht: {
    html: 'zh-TW', title: '收藏的照片', from: '來自電腦', fromN: n => `來自電腦 · ${n} 張`,
    tipTitle: '儲存到 iPhone 的「照片」', tip: '長按任一張照片，選擇 <b>「儲存到“照片”」</b>。',
    all: n => `全部下載（${n} 張）`,
    many: n => `照片很多的話：下載後到「檔案」App →「下載項目」點開壓縮檔，進入資料夾，點右上角「選取」→ 全選 → 分享 →「儲存 ${n} 張影像」。`,
    emptyTitle: '還沒有照片', empty: '在電腦上開啟照片 app 的「收藏」，點右上角「分享到 iPhone」，然後重新整理這個頁面。',
    zip: '收藏的照片.zip',
  },
  en: {
    html: 'en', title: 'Favorite Photos', from: 'From your computer', fromN: n => `From your computer · ${pl(n, 'photo', 'photos')}`,
    tipTitle: 'Save to your iPhone’s Photos', tip: 'Touch and hold any photo, then choose <b>Save to Photos</b>.',
    all: n => `Download All (${n})`,
    many: () => 'Lots of photos? After downloading, open the Files app → Downloads, tap the zip file to unzip it, open the folder, then tap Select → Select All → Share → Save Images.',
    emptyTitle: 'No photos yet', empty: 'On your computer, open Favorites in the Photos app, tap “Share to iPhone”, then refresh this page.',
    zip: 'Favorite Photos.zip',
  },
};
const CONSOLE = {
  zh: { started: '照片 app 已启动，可以分享到 iPhone 了', phone: 'iPhone 接收页', keep: '分享期间请保持这个窗口打开，关闭即可停止。', fail: '无法启动：' },
  zht: { started: '照片 app 已啟動，可以分享到 iPhone 了', phone: 'iPhone 接收頁', keep: '分享期間請保持這個視窗開啟，關閉即可停止。', fail: '無法啟動：' },
  en: { started: 'Photos app is running. Ready to share to iPhone.', phone: 'iPhone page', keep: 'Keep this window open while sharing. Close it to stop.', fail: 'Could not start: ' },
}[SYSTEM_LANG];

/* ---------- phone page ---------- */
function phonePage(lang) {
  const T = PHONE[lang];
  const items = shared.map(s => `
    <figure><img src="/p/${s.id}" alt="${esc(s.name)}" loading="lazy"><figcaption>${esc(s.name)}</figcaption></figure>`).join('');
  const body = shared.length ? `
    <div class="tip">
      <b>${T.tipTitle}</b>
      ${T.tip}
    </div>
    <a class="btn" href="/share.zip" download="${esc(T.zip)}">${T.all(shared.length)}</a>
    <p class="small">${T.many(shared.length)}</p>
    <div class="list">${items}</div>` : `
    <div class="tip"><b>${T.emptyTitle}</b>${T.empty}</div>`;
  return `<!doctype html>
<html lang="${T.html}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${T.title}</title>
<style>
:root{--bg:#f2f2f7;--card:#fff;--fg:#000;--sub:#8e8e93;--accent:#007aff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#fff;--accent:#0a84ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
header{padding:24px 16px 4px}
h1{margin:0;font-size:34px;font-weight:700}
.sub{color:var(--sub);font-size:15px;margin-top:2px}
.tip{margin:16px;padding:14px 16px;background:var(--card);border-radius:14px;font-size:16px;line-height:1.5}
.tip b:first-child{display:block;margin-bottom:2px}
.btn{display:block;margin:0 16px;padding:15px;border-radius:14px;background:var(--accent);color:#fff;text-align:center;font-size:17px;font-weight:600;text-decoration:none}
.btn:active{opacity:.7}
.small{margin:10px 20px 4px;color:var(--sub);font-size:13px;line-height:1.5}
.list{display:flex;flex-direction:column;gap:14px;padding:12px 16px 40px}
figure{margin:0;background:var(--card);border-radius:14px;overflow:hidden}
figure img{display:block;width:100%;height:auto;min-height:80px;background:rgba(127,127,127,.15)}
figcaption{padding:8px 12px;font-size:13px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head>
<body>
<header><h1>${T.title}</h1><div class="sub">${shared.length ? T.fromN(shared.length) : T.from}</div></header>
${body}
</body></html>`;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return fs.readFile(path.join(ROOT, 'index.html'), (err, data) =>
        err ? send(res, 500, 'index.html not found') : send(res, 200, data, 'text/html; charset=utf-8'));
    }
    if (req.method === 'GET' && p === '/phone') return send(res, 200, phonePage(langFromRequest(req)), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p.startsWith('/p/')) {
      const item = shared.find(s => s.id === p.slice(3));
      if (!item) return send(res, 404, 'Not found');
      return send(res, 200, item.data, item.type, { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(item.name)}` });
    }
    if (req.method === 'GET' && p === '/share.zip') {
      return send(res, 200, makeZip(shared), 'application/zip',
        { 'Content-Disposition': `attachment; filename="photos.zip"; filename*=UTF-8''${encodeURIComponent(PHONE[langFromRequest(req)].zip)}` });
    }

    // Everything below is only for the app running on this computer.
    // The app is usually opened by double-clicking index.html (origin "null"), so allow that origin.
    if (p.startsWith('/api/')) {
      if (!isLocal(req)) return send(res, 403, 'Forbidden');
      const origin = req.headers.origin;
      if (origin && allowedOrigin(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Photo-App',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      // The custom header forces a CORS check, so random websites can't post here.
      if (req.method === 'POST' && req.headers['x-photo-app'] !== '1') return send(res, 403, 'Forbidden');
      if (req.method === 'GET' && p === '/api/info') return json(res, { ips: lanIPs(), port: server.address().port, count: shared.length });
      if (req.method === 'POST' && p === '/api/share/clear') { shared = []; return json(res, { ok: true }); }
      if (req.method === 'POST' && p === '/api/share/add') {
        const data = await readBody(req);
        const item = addShared(url.searchParams.get('name'), req.headers['content-type'], url.searchParams.get('date'), data);
        return json(res, { id: item.id });
      }
      if (req.method === 'POST' && p === '/api/share/add-url') {   // sample photos from the internet
        const { url: src, name, date } = JSON.parse((await readBody(req, 1e5)).toString('utf8'));
        if (!/^https:\/\//.test(src)) return send(res, 400, 'bad url');
        const r = await fetch(src);
        if (!r.ok) return send(res, 502, 'fetch failed');
        const item = addShared(name, r.headers.get('content-type'), date, Buffer.from(await r.arrayBuffer()));
        return json(res, { id: item.id });
      }
    }
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, String(e.message || e));
  }
});

function start(port) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && !FIXED_PORT && port < START_PORT + 20) start(port + 1);
    else { console.error(CONSOLE.fail, e.message); process.exit(1); }
  });
  server.listen(port, '0.0.0.0', () => {
    // Open index.html directly (not http://localhost) so the browser shows the same
    // favorites and folders as when you double-click index.html.
    const page = path.join(ROOT, 'index.html');
    console.log(`\n  ${CONSOLE.started}`);
    for (const ip of lanIPs()) console.log(`  ${CONSOLE.phone}: http://${ip}:${port}/phone`);
    console.log(`\n  ${CONSOLE.keep}\n`);
    if (OPEN_BROWSER) {
      const cmd = process.platform === 'win32' ? `start "" "${page}"` : process.platform === 'darwin' ? `open "${page}"` : `xdg-open "${page}"`;
      exec(cmd);
    }
  });
}
start(START_PORT);
