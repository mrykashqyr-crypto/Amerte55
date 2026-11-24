# 🤖 أميرتي Cloud Panel v2

لوحة تحكم سحابية كاملة لبوت الواتساب — ارفع ملف بوت وشغّله من المتصفح.

## 📁 هيكل المشروع

```
amirati/
├── server/
│   ├── index.js        ← الخادم الرئيسي (HTTP + API + File Manager)
│   ├── package.json    ← المكتبات
│   └── bots/
│       └── bot.js      ← بوت واتساب جاهز (Baileys + AI)
├── client/
│   └── index.html      ← الواجهة الكاملة (نفس تصميم أميرتي)
├── .gitignore
└── README.md
```

## ⚡ تشغيل محلي

```bash
cd server
npm install
node index.js
# افتح: http://localhost:3000
```

## 🌐 استضافة مجانية على Render.com

1. ارفع المجلد `server/` على GitHub
2. روح على [render.com](https://render.com) ← New Web Service
3. اربطه بـ GitHub
4. الإعدادات:
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Environment Variables:**
     - `BOT_PHONE` = رقمك مع رمز الدولة
     - `ADMIN_PASS` = كلمة مرور اللوحة
5. اضغط Deploy ← يعطيك رابط مجاني

## 🔧 ميزات اللوحة

| الميزة | التفاصيل |
|--------|----------|
| رفع ملفات | ارفع .js أو .py أو .sh مباشرة |
| تشغيل فوري | اختر الملف وضغط ▶️ تشغيل |
| كود الربط | يظهر تلقائياً لربط واتساب |
| طرفية حية | أوامر shell مباشرة |
| سجل مباشر | لوج يتحدث كل 3 ثواني |
| Sandbox | محاكاة أوامر الجروب |

## 📄 ملفات البوت المدعومة

| الامتداد | المشغّل |
|----------|---------|
| `.js`    | node    |
| `.py`    | python3 |
| `.ts`    | ts-node |
| `.sh`    | bash    |

## 🔑 استخدام بوت واتساب (bot.js)

1. أدخل رقم الواتساب في اللوحة
2. اضغط "حفظ وطلب كود"
3. انتظر ظهور كود الربط (8 خانات)
4. افتح واتساب ← الأجهزة المرتبطة ← ربط برقم الهاتف
5. أدخل الكود

## 💡 استهلاك الذاكرة

- **Backend:** Node.js built-ins فقط + Express بدون مكتبات إضافية
- **Frontend:** Vanilla JS بدون أي framework
- **RAM:** ~20-30 MB عند الخمول
