/**
 * أميرتي WhatsApp Bot — bot.js
 * يعمل مع Baileys + Google Gemini API عبر GEMINI_API_KEY
 * ضعه في مجلد bots/ وشغّله من لوحة التحكم
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_info');

// ── إخفاء الضجيج التقني ──────────────────────────────────────
const origLog = console.log.bind(console);
function isCryptoNoise(args) {
  const t = args.map(i => typeof i === 'string' ? i : String(i?.message || i || '')).join(' ');
  return ['MessageCounterError','Session error','Failed to decrypt','Closing session','prekey','Bad MAC']
    .some(k => t.includes(k));
}
console.log   = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };
console.warn  = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };
console.error = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };

let phoneNumber       = (process.env.BOT_PHONE || '').replace(/\D/g, '');
let activeSock        = null;
let isStarting        = false;
let pairingInProgress = false;
let reconnectTimer    = null;
let reconnectCount    = 0;

const chatMemory      = new Map();
const processedIds    = new Set();

// ── AI (Gemini) ───────────────────────────────────────────────
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL   = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
const SYSTEM_PROMPT  = `أنت "أميرتي"، مساعدة ذكاء اصطناعي مختصرة على واتساب. أجيبي بوضوح واختصار مع اسم المتحدث دون أعذار تقنية.`.trim();

function shortenText(str, maxLen = 180) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

async function askAI(jid, speaker, prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY غير مضبوط في متغيرات البيئة');
  }

  if (!chatMemory.has(jid)) chatMemory.set(jid, []);
  const history = chatMemory.get(jid);
  const cleanSpeaker = shortenText(speaker, 25) || 'مستخدم';
  history.push({ role: 'user', speaker: cleanSpeaker, text: shortenText(prompt, 180) });
  while (history.length > 4) history.shift();

  const transcript = history.map(m =>
    `${m.role === 'user' ? m.speaker : 'أميرتي'}: ${m.text}`).join('\n');
  const fullPrompt = `${transcript}\nردي بصفتك أميرتي باختصار على (${cleanSpeaker}):`;

  let lastErr = 'Gemini failed';
  for (let i = 1; i <= 2; i++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 250 },
        }),
      });
      clearTimeout(timer);

      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}

      if (!res.ok) {
        const apiMsg = data?.error?.message || raw.slice(0, 120) || res.statusText;
        lastErr = `HTTP ${res.status}: ${apiMsg}`;
        throw new Error(lastErr);
      }

      const reply = (data?.candidates?.[0]?.content?.parts || [])
        .map(p => p?.text || '')
        .join('')
        .trim();

      if (!reply) {
        lastErr = 'Empty Gemini response';
        throw new Error(lastErr);
      }

      history.push({ role: 'assistant', speaker: 'أميرتي', text: shortenText(reply, 180) });
      while (history.length > 4) history.shift();
      return reply;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e?.name === 'AbortError' ? 'Timeout (15s)' : (e?.message || String(e));
      origLog(`[AI-WARN] محاولة ${i} فشلت: ${lastErr}`);
      if (i < 2) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(lastErr);
}

// ── Reconnect ─────────────────────────────────────────────────
function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectCount++;
  const wait = delayMs ?? Math.min(7000 * reconnectCount, 35000);
  origLog(`[NET] إعادة الاتصال خلال ${Math.round(wait / 1000)}s...`);
  reconnectTimer = setTimeout(boot, wait);
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  if (isStarting) return;
  isStarting = true;
  try {
    if (activeSock) { try { activeSock.end(undefined); } catch {} activeSock = null; }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try { const r = await fetchLatestBaileysVersion(); version = r.version; } catch {}

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 120000,
      keepAliveIntervalMs: 45000,
    });

    activeSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (!sock.authState.creds.registered && (connection === 'connecting' || Boolean(qr)) && !pairingInProgress) {
        pairingInProgress = true;
        try {
          if (!phoneNumber) { origLog('[ERR] لم يتم تحديد رقم الواتساب'); return; }
          await new Promise(r => setTimeout(r, 4500));
          const code = await sock.requestPairingCode(phoneNumber);
          origLog('PAIRING CODE: ' + code);
        } catch (e) {
          origLog('[ERR] فشل طلب كود الربط: ' + e.message);
          pairingInProgress = false;
        }
      }

      if (connection === 'open') {
        isStarting = false; pairingInProgress = false; reconnectCount = 0;
        origLog('[OK] Amirati is ONLINE and ready!');
      } else if (connection === 'close') {
        isStarting = false; pairingInProgress = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        origLog(`[CLOSE] Code: ${code || 'unknown'}`);
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          return scheduleReconnect(8000);
        }
        scheduleReconnect(code === 440 ? 11000 : code === 428 ? 12000 : null);
      }
    });

    // ── Messages ──────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages?.[0];
        if (!msg?.message || processedIds.has(msg.key?.id)) return;
        processedIds.add(msg.key?.id);
        if (processedIds.size > 500) { const it = processedIds.values(); it.next(); processedIds.delete(it.next().value); }

        const jid     = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return;
        const isGroup = jid.endsWith('@g.us');

        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!body) return;

        const pushName = msg.pushName || 'مجهول';
        const isMe     = msg.key.fromMe;
        if (isMe) return;

        const mentionsMe = body.toLowerCase().includes('أميرتي') || body.toLowerCase().includes('bot');

        if (isGroup && !mentionsMe) return;

        origLog(`[MSG] ${pushName}: ${shortenText(body, 120)}`);

        // أوامر خاصة
        const cmd = body.replace(/أميرتي\s*/i, '').trim().toLowerCase();

        if (cmd === 'انسى') {
          chatMemory.delete(jid);
          await sock.sendMessage(jid, { text: '🧠 تم مسح الذاكرة، نبدأ من جديد!' }, { quoted: msg });
          return;
        }

        // رد AI
        try {
          const reply = await askAI(jid, pushName, body);
          await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          origLog(`[SENT] رد على ${pushName}`);
        } catch (err) {
          origLog(`[AI-ERR] فشل الرد على ${pushName}: ${err?.message || err}`);
        }
      } catch (e) {
        origLog('[ERR] messages.upsert: ' + e.message);
      }
    });

  } catch (e) {
    origLog('[ERR] boot: ' + e.message);
    isStarting = false;
    scheduleReconnect(10000);
  }
}

boot();
          
