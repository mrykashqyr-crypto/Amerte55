/**
 * أميرتي WhatsApp Bot — bot.js
 * يعمل مع Baileys + AI من pollinations.ai مجاناً
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

// ── AI ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `أنت "أميرتي"، مساعدة ذكاء اصطناعي ذكية ومشرفة على واتساب.
- تفاعلي بذكاء واختصار مفيد مع اسم المتحدث.
- لا تذكري أعذاراً تقنية أو حالة الشبكة أبداً.`.trim();

async function askAI(jid, speaker, prompt) {
  if (!chatMemory.has(jid)) chatMemory.set(jid, []);
  const history = chatMemory.get(jid);
  history.push({ role: 'user', speaker, text: prompt.slice(0, 320) });
  if (history.length > 8) history.shift();

  const transcript = history.map(m =>
    `${m.role === 'user' ? m.speaker : 'أميرتي'}: ${m.text}`).join('\n');
  const fullPrompt = `${SYSTEM_PROMPT}\n\n--- المحادثة ---\n${transcript}\n\nردي بصفتك أميرتي على (${speaker}):`;

  for (let i = 1; i <= 3; i++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), i === 1 ? 18000 : 28000);
    try {
      const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reply = (await res.text()).trim();
      if (reply) {
        history.push({ role: 'assistant', speaker: 'أميرتي', text: reply.slice(0, 320) });
        return reply;
      }
    } catch { clearTimeout(timer); await new Promise(r => setTimeout(r, 1500 * i)); }
  }
  throw new Error('AI exhausted');
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
        if (type !== 'notify' && type !== 'append') return;
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

        origLog(`[MSG] ${pushName}: ${body}`);

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
        } catch {
          // صمت تام — بدون أعذار
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
