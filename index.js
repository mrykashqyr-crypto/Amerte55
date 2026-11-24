/**
 * أميرتي Cloud Panel — index.js
 * HTTP Server + Bot Manager + File Upload API
 * Node.js built-ins only (http, fs, path, child_process)
 * No external dependencies except multer-less file parsing
 */

'use strict';

const http     = require('http');
const { spawn, exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');

const PORT       = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'amirati2026';
const BOTS_DIR   = path.join(__dirname, 'bots');
const CLIENT_DIR = path.join(__dirname, '..', 'client');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────
let botProcess   = null;
let botStatus    = 'stopped';   // stopped | starting | online | reconnecting
let pairingCode  = '';
let activeBot    = null;        // filename of currently running bot
let currentPhone = (process.env.BOT_PHONE || '').replace(/\D/g, '');
const logs = [];

// ── Logging ───────────────────────────────────────────────────
function addLog(line, src = 'out') {
  const clean = String(line || '').trim();
  if (!clean) return;
  const ts = Date.now();
  logs.push({ ts, src, text: clean });
  if (logs.length > 400) logs.shift();
  process.stdout.write(clean + '\n');

  const pairMatch = clean.match(/PAIRING CODE[:\s]+([A-Z0-9\-]{6,12})/i);
  if (pairMatch) pairingCode = pairMatch[1];
  if (clean.includes('[OK]') && clean.includes('ONLINE')) { botStatus = 'online'; pairingCode = ''; }
  if (clean.includes('[CLOSE]'))   botStatus = 'reconnecting';
}

// ── Bot runner ────────────────────────────────────────────────
function getRunner(filename) {
  const ext = path.extname(filename).toLowerCase();
  return { '.js': ['node'], '.py': ['python3', '-u'], '.ts': ['ts-node'], '.sh': ['bash'] }[ext] || null;
}

function startBot(filename) {
  if (botProcess) stopBot();
  const filePath = path.join(BOTS_DIR, filename);
  if (!fs.existsSync(filePath)) return addLog(`[ERR] الملف غير موجود: ${filename}`, 'err');

  const runner = getRunner(filename);
  if (!runner) return addLog(`[ERR] نوع الملف غير مدعوم: ${filename}`, 'err');

  botStatus = 'starting';
  activeBot = filename;
  addLog(`[PANEL] تشغيل البوت: ${filename}`);

  botProcess = spawn(runner[0], [...runner.slice(1), filePath], {
    cwd: BOTS_DIR,
    env: { ...process.env, BOT_PHONE: currentPhone }
  });

  botProcess.stdout.on('data', d => d.toString().split('\n').forEach(l => addLog(l, 'out')));
  botProcess.stderr.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) addLog(l, 'err'); }));
  botProcess.on('close', code => {
    addLog(`[PANEL] البوت توقف (exit ${code})`, 'sys');
    botProcess = null;
    botStatus = 'stopped';
    activeBot = null;
  });
}

function stopBot() {
  if (!botProcess) return;
  botProcess.kill('SIGTERM');
  botProcess = null;
  botStatus = 'stopped';
  addLog('[PANEL] تم إيقاف البوت.', 'sys');
}

function restartBot() {
  const name = activeBot || (fs.readdirSync(BOTS_DIR)[0] || null);
  stopBot();
  if (name) setTimeout(() => startBot(name), 1200);
}

function resetSession() {
  stopBot();
  const authDir = path.join(BOTS_DIR, 'auth_info');
  fs.rmSync(authDir, { recursive: true, force: true });
  pairingCode = '';
  addLog('[PANEL] تم حذف جلسة auth_info بنجاح.', 'sys');
}

// ── Multipart file parser (no deps) ──────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return cb(new Error('No boundary'));
  const boundary = '--' + boundaryMatch[1];

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
      if (buf.slice(pos, pos + 2).toString() === '--') break;
      pos += 2; // skip \r\n

      const headerEnd = buf.indexOf('\r\n\r\n', pos);
      if (headerEnd === -1) break;
      const headers = buf.slice(pos, headerEnd).toString();
      pos = headerEnd + 4;

      const nameMatch     = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (!filenameMatch) { pos++; continue; }

      const nextBoundary = buf.indexOf('\r\n' + boundary, pos);
      if (nextBoundary === -1) break;
      const fileData = buf.slice(pos, nextBoundary);
      files.push({ fieldname: nameMatch?.[1] || 'file', filename: path.basename(filenameMatch[1]), data: fileData });
      pos = nextBoundary + 2;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

// ── Serve static files ────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.json': 'application/json',
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── JSON helpers ──────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(e); } });
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.url.split('?')[0];
  const method = req.method;

  // ── Health check
  if (method === 'GET' && url === '/health') {
    res.writeHead(200); return res.end('OK');
  }

  // ── API: state
  if (method === 'GET' && url === '/api/state') {
    const since = parseInt(new URLSearchParams(req.url.split('?')[1] || '').get('since') || '0', 10);
    const bots  = fs.readdirSync(BOTS_DIR)
      .filter(f => !fs.statSync(path.join(BOTS_DIR, f)).isDirectory())
      .map(f => ({ name: f, size: fs.statSync(path.join(BOTS_DIR, f)).size, ext: path.extname(f) }));
    return json(res, 200, {
      status: botStatus,
      pairingCode,
      phone: currentPhone,
      activeBot,
      bots,
      logs: logs.filter(l => l.ts > since),
    });
  }

  // ── API: upload bot file
  if (method === 'POST' && url === '/api/upload') {
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

  // ── API: delete bot file
  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.replace('/api/bots/', ''));
    const fp = path.join(BOTS_DIR, name);
    if (!fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'الملف غير موجود' });
    if (activeBot === name) stopBot();
    fs.unlinkSync(fp);
    addLog(`[PANEL] تم حذف الملف: ${name}`, 'sys');
    return json(res, 200, { ok: true });
  }

  // ── API: actions (start/stop/restart/reset/exec/set_phone)
  if (method === 'POST' && url === '/api/action') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (body.pass !== ADMIN_PASS) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });

      switch (body.action) {
        case 'start':
          startBot(body.bot || fs.readdirSync(BOTS_DIR).filter(f => !fs.statSync(path.join(BOTS_DIR,f)).isDirectory())[0]);
          break;
        case 'stop':     stopBot(); break;
        case 'restart':  restartBot(); break;
        case 'reset':    resetSession(); break;
        case 'set_phone':
          currentPhone = String(body.phone || '').replace(/\D/g, '');
          addLog(`[PANEL] رقم الواتساب: ${currentPhone}`, 'sys');
          break;
        case 'exec':
          if (body.cmd) {
            addLog(`$ ${body.cmd}`, 'sys');
            exec(body.cmd, { cwd: BOTS_DIR, timeout: 15000 }, (e, out, err2) => {
              if (out) out.split('\n').forEach(l => addLog(l, 'out'));
              if (err2) err2.split('\n').forEach(l => { if (l.trim()) addLog(l, 'err'); });
              if (e && !err2) addLog(`[ERR] ${e.message}`, 'err');
            });
          }
          break;
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  // ── Static files
  if (method === 'GET') {
    let filePath = url === '/' ? '/index.html' : url;
    serveStatic(res, path.join(CLIENT_DIR, filePath));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  addLog(`[SERVER] أميرتي Cloud Panel يعمل على المنفذ ${PORT}`, 'sys');
});
