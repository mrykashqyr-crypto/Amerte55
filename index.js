/**
 * لوحة أميرتي السحابية — index.js
 * خادم HTTP + مدير البوتات + واجهة رفع الملفات
 * وظائف Node.js المدمجة فقط (http, fs, path, child_process)
 */

'use strict';

const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'amirati2026';
const BOTS_DIR = path.join(__dirname, 'bots');

function resolveClientDir() {
  const candidates = [
    path.join(__dirname, 'client'),
    path.join(__dirname, '..', 'client'),
    path.join(__dirname, 'public'),
    __dirname,
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

const CLIENT_DIR = resolveClientDir();

if (!fs.existsSync(BOTS_DIR)) {
  fs.mkdirSync(BOTS_DIR, { recursive: true });
}

// ── الحالة ─────────────────────────────────────────────────────────────────
let botProcess = null;
let botStatus = 'stopped'; // stopped | starting | online | reconnecting
let pairingCode = '';
let activeBot = null;
let currentPhone = (process.env.BOT_PHONE || '').replace(/\D/g, '');
let currentOwner = (process.env.OWNER_PHONE || process.env.BOT_PHONE || '').replace(/\D/g, '');
const logs = [];

// ── تسجيل الأحداث ──────────────────────────────────────────────────────────
function addLog(line, src = 'out') {
  const clean = String(line || '').trim();
  if (!clean) return;
  const ts = Date.now();
  logs.push({ ts, src, text: clean });
  if (logs.length > 400) {
    logs.shift();
  }
  process.stdout.write(clean + '\n');

  const pairMatch = clean.match(/PAIRING CODE[:\s]+([A-Z0-9\-]{6,12})/i);
  if (pairMatch) pairingCode = pairMatch[1];
  if (clean.includes('[OK]') && clean.includes('ONLINE')) {
    botStatus = 'online';
    pairingCode = '';
  }
  if (clean.includes('[CLOSE]')) {
    botStatus = 'reconnecting';
  }
}

function listBotFiles() {
  return fs.readdirSync(BOTS_DIR)
    .filter(f => !fs.statSync(path.join(BOTS_DIR, f)).isDirectory())
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(BOTS_DIR, f)).size,
      ext: path.extname(f),
    }));
}

// ── بوت رانر ───────────────────────────────────────────────────────────────
function getRunner(filename) {
  const ext = path.extname(filename).toLowerCase();
  return { '.js': ['node'], '.py': ['python3', '-u'], '.ts': ['ts-node'], '.sh': ['bash'] }[ext] || null;
}

function stopBot() {
  if (!botProcess) {
    botStatus = 'stopped';
    activeBot = null;
    return;
  }
  try {
    botProcess.kill('SIGTERM');
  } catch {}
  botProcess = null;
  botStatus = 'stopped';
  activeBot = null;
  addLog('[PANEL] تم إيقاف البوت.', 'sys');
}

function startBot(filename) {
  if (!filename) {
    const files = listBotFiles();
    filename = files[0]?.name || null;
  }
  if (!filename) {
    addLog('[ERR] لا يوجد ملف بوت لتشغيله.', 'err');
    return { ok: false, error: 'لا يوجد ملف بوت لتشغيله' };
  }

  if (botProcess) stopBot();
  const filePath = path.join(BOTS_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    addLog(`[ERR] الملف غير موجود: ${filename}`, 'err');
    return { ok: false, error: `الملف غير موجود: ${filename}` };
  }

  const runner = getRunner(filePath);
  if (!runner) {
    addLog(`[ERR] نوع الملف غير مدعوم: ${filename}`, 'err');
    return { ok: false, error: `نوع الملف غير مدعوم: ${filename}` };
  }

  botStatus = 'starting';
  activeBot = path.basename(filePath);
  addLog(`[PANEL] تشغيل البوت: ${activeBot}`, 'sys');

  botProcess = spawn(runner[0], [...runner.slice(1), filePath], {
    cwd: BOTS_DIR,
    env: {
      ...process.env,
      BOT_PHONE: currentPhone,
      OWNER_PHONE: currentOwner || currentPhone,
    },
  });

  botProcess.stdout.on('data', d => d.toString().split('\n').forEach(l => addLog(l, 'out')));
  botProcess.stderr.on('data', d => d.toString().split('\n').forEach(l => {
    if (l.trim()) addLog(l, 'err');
  }));
  botProcess.on('close', code => {
    addLog(`[PANEL] البوت توقف (exit ${code})`, 'sys');
    botProcess = null;
    botStatus = 'stopped';
    activeBot = null;
  });

  return { ok: true, message: `تم بدء تشغيل ${activeBot}` };
}

function restartBot(filename) {
  const name = filename || activeBot || (listBotFiles()[0]?.name || null);
  stopBot();
  if (name) {
    setTimeout(() => startBot(name), 1200);
    return { ok: true, message: `جاري إعادة تشغيل ${name}` };
  }
  return { ok: false, error: 'لا يوجد ملف بوت لإعادة تشغيله' };
}

function resetSession() {
  stopBot();
  const authDir = path.join(BOTS_DIR, 'auth_info');
  fs.rmSync(authDir, { recursive: true, force: true });
  pairingCode = '';
  addLog('[PANEL] تم حذف جلسة auth_info الفعالة.', 'sys');
  return { ok: true, message: 'تم حذف الجلسة بنجاح' };
}

// ── محلل ملفات متعدد الأجزاء ──────────────────────────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return cb(new Error('لا يوجد حد للملفات'));
  const boundary = Buffer.from('--' + boundaryMatch[1]);
  const dashDash = Buffer.from('--');
  const crlf = Buffer.from('\r\n');
  const headerSep = Buffer.from('\r\n\r\n');

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const files = [];

    let pos = 0;
    while (pos < buf.length) {
      const bStart = buf.indexOf(boundary, pos);
      if (bStart === -1) break;
      pos = bStart + boundary.length;
      if (buf.slice(pos, pos + 2).equals(dashDash)) break;
      if (buf.slice(pos, pos + 2).equals(crlf)) pos += 2;

      const headerEnd = buf.indexOf(headerSep, pos);
      if (headerEnd === -1) break;
      const headers = buf.slice(pos, headerEnd).toString('utf8');
      pos = headerEnd + 4;

      const nameMatch = headers.match(/name="([^"]+)"/i);
      const filenameMatch = headers.match(/filename="([^"]*)"/i);

      let partEnd = buf.indexOf(Buffer.concat([crlf, boundary]), pos);
      let nextPos = partEnd === -1 ? -1 : partEnd + 2;
      if (partEnd === -1) {
        partEnd = buf.indexOf(boundary, pos);
        nextPos = partEnd;
      }
      if (partEnd === -1) break;

      if (filenameMatch && filenameMatch[1]) {
        files.push({
          fieldname: nameMatch?.[1] || 'file',
          filename: path.basename(filenameMatch[1]),
          data: buf.slice(pos, partEnd),
        });
      }
      pos = nextPos;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

// ── خدمة الملفات الثابتة ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    try {
      cb(null, JSON.parse(b || '{}'));
    } catch (e) {
      cb(e);
    }
  });
}

function isAuthorized(req, body) {
  const headerPass = String(req.headers['x-admin-pass'] || '').trim();
  const bodyPass = String(body?.pass || '').trim();
  return headerPass === ADMIN_PASS || bodyPass === ADMIN_PASS;
}

function runShellCommand(cmd, cb) {
  const clean = String(cmd || '').trim();
  if (!clean) return cb(null, '');
  addLog(`$ ${clean}`, 'sys');
  exec(clean, { cwd: BOTS_DIR, timeout: 60000 }, (e, out, err2) => {
    const lines = [];
    if (out) {
      out.split('\n').forEach(l => {
        if (l.trim()) {
          addLog(l, 'out');
          lines.push(l);
        }
      });
    }
    if (err2) {
      err2.split('\n').forEach(l => {
        if (l.trim()) {
          addLog(l, 'err');
          lines.push(l);
        }
      });
    }
    if (e && !err2) {
      const m = `[ERR] ${e.message}`;
      addLog(m, 'err');
      lines.push(m);
    }
    cb(null, lines.join('\n'));
  });
}

// ── خادم HTTP ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pass');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const rawUrl = req.url || '/';
  const [urlPath, queryString] = rawUrl.split('?');
  const method = req.method;

  if (method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('OK');
  }

  if (method === 'GET' && urlPath === '/api/state') {
    const since = parseInt(new URLSearchParams(queryString || '').get('since') || '0', 10);
    const bots = listBotFiles();
    return json(res, 200, {
      status: botStatus,
      pairingCode,
      phone: currentPhone,
      activeBot,
      bots,
      logs: logs.filter(l => l.ts > since),
    });
  }

  if (method === 'GET' && urlPath === '/api/status') {
    const bots = listBotFiles();
    return json(res, 200, {
      running: Boolean(botProcess) || botStatus === 'online' || botStatus === 'starting',
      online: botStatus === 'online',
      status: botStatus,
      pairingCode,
      phone: currentPhone,
      activeBot,
      files: bots,
      logs: logs.slice(-80).map(l => l.text),
    });
  }

  if (method === 'GET' && urlPath === '/api/files') {
    return json(res, 200, { ok: true, files: listBotFiles() });
  }

  if (method === 'POST' && urlPath === '/api/upload') {
    parseMultipart(req, (err, files) => {
      if (err || !files.length) return json(res, 400, { ok: false, error: 'لا توجد ملفات صالحة' });
      const allowed = ['.py', '.js', '.ts', '.sh'];
      const saved = [];
      for (const f of files) {
        const ext = path.extname(f.filename).toLowerCase();
        if (!allowed.includes(ext)) continue;
        fs.writeFileSync(path.join(BOTS_DIR, f.filename), f.data);
        saved.push(f.filename);
        addLog(`[UPLOAD] تم رفع الملف: ${f.filename}`, 'sys');
      }
      if (!saved.length) return json(res, 400, { ok: false, error: 'نوع الملف غير مدعوم' });
      json(res, 200, { ok: true, uploaded: saved });
    });
    return;
  }

  if (method === 'DELETE' && urlPath.startsWith('/api/bots/')) {
    const name = path.basename(decodeURIComponent(urlPath.replace('/api/bots/', '')));
    const fp = path.join(BOTS_DIR, name);
    if (!fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'الملف غير موجود' });
    if (activeBot === name) stopBot();
    fs.unlinkSync(fp);
    addLog(`[PANEL] تم حذف الملف: ${name}`, 'sys');
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && urlPath === '/api/shell') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (!isAuthorized(req, body)) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });
      const cmd = body.command || body.cmd || '';
      runShellCommand(cmd, (_, output) => {
        json(res, 200, { ok: true, output });
      });
    });
    return;
  }

  if (method === 'POST' && urlPath === '/api/pairing') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (!isAuthorized(req, body)) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });
      const phone = String(body.phone || body.botPhone || '').replace(/\D/g, '');
      if (!phone) return json(res, 400, { ok: false, error: 'رقم الواتساب مطلوب' });
      currentPhone = phone;
      addLog(`[PANEL] رقم الواتساب: ${currentPhone}`, 'sys');
      const targetBot = activeBot || (listBotFiles()[0]?.name || null);
      if (targetBot) startBot(targetBot);
      json(res, 200, { ok: true, phone: currentPhone, pairingCode });
    });
    return;
  }

  if (method === 'POST' && urlPath.startsWith('/api/bot/')) {
    const action = urlPath.replace('/api/bot/', '').trim();
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (!isAuthorized(req, body)) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });

      const phone = String(body.phone || body.botPhone || '').replace(/\D/g, '');
      if (phone) currentPhone = phone;
      const botFile = body.file || body.botFile || body.bot || '';

      if (action === 'start') return json(res, 200, startBot(botFile));
      if (action === 'stop') { stopBot(); return json(res, 200, { ok: true, message: 'تم إيقاف البوت' }); }
      if (action === 'restart') return json(res, 200, restartBot(botFile));
      if (action === 'reset') return json(res, 200, resetSession());
      return json(res, 404, { ok: false, error: 'إجراء غير معروف' });
    });
    return;
  }

  if (method === 'POST' && urlPath === '/api/action') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (!isAuthorized(req, body)) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });

      switch (body.action) {
        case 'start':
          startBot(body.bot);
          break;
        case 'stop':
          stopBot();
          break;
        case 'restart':
          restartBot(body.bot);
          break;
        case 'reset':
          resetSession();
          break;
        case 'set_phone':
          currentPhone = String(body.phone || '').replace(/\D/g, '');
          addLog(`[PANEL] رقم الواتساب: ${currentPhone}`, 'sys');
          break;
        case 'exec':
          if (body.cmd) {
            runShellCommand(body.cmd, () => {});
          }
          break;
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  if (method === 'GET' && urlPath === '/' && !CLIENT_DIR) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>لوحة التحكم</title></head>
<body style="font-family:sans-serif;background:#111;color:#eee;padding:24px">
  <h2>الخادم يعمل بنجاح</h2>
  <p>لم يتم العثور على ملف <code>index.html</code> داخل مجلدات الواجهة.</p>
  <p>أضف ملف <code>index.html</code> داخل مجلد <code>client</code> أو بجانب <code>index.js</code> ثم أعد النشر.</p>
</body>
</html>`);
  }

  if (method === 'GET' && CLIENT_DIR) {
    const safeRel = path.normalize(urlPath === '/' ? 'index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
    serveStatic(res, path.join(CLIENT_DIR, safeRel));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  addLog(`[SERVER] أميرتي Cloud Panel تعمل على المنفذ ${PORT}`, 'sys');
});
  
