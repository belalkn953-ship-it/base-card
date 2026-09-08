require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'base-card.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  icon TEXT NOT NULL DEFAULT '🎮',
  description TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  game_id INTEGER NOT NULL,
  package_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  payment_number TEXT NOT NULL,
  receipt_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(game_id) REFERENCES games(id),
  FOREIGN KEY(package_id) REFERENCES packages(id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);
try { db.prepare('ALTER TABLE orders ADD COLUMN user_id INTEGER').run(); } catch (_) {}

const settingDefaults = {
  site_name: 'Base Card',
  tagline: 'شحن ألعاب سريع وآمن وموثوق',
  support_whatsapp: '',
  sham_cash: '',
  sham_cash_qr: '',
  hero_title: 'خلّ لعبك أقوى مع Base Card',
  hero_text: 'اشحن رصيدك وباقاتك المفضلة بسهولة. أسعار واضحة، تنفيذ سريع، ومتابعة حقيقية لكل طلب.',
  offer_title: 'عرض الأسبوع',
  offer_text: 'تابع عروضنا الدورية واحصل على قيمة أفضل مع كل عملية شحن.'
};
const upsertSetting = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
for (const [key, value] of Object.entries(settingDefaults)) {
  if (!db.prepare('SELECT key FROM settings WHERE key=?').get(key)) upsertSetting.run(key, value);
}
if (!db.prepare('SELECT id FROM admins LIMIT 1').get()) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'change-this-immediately';
  db.prepare('INSERT INTO admins(username,password_hash) VALUES (?,?)').run(username, bcrypt.hashSync(password, 12));
  console.log(`Admin created: ${username}. Change ADMIN_PASSWORD before production.`);
}
if (!db.prepare('SELECT id FROM games LIMIT 1').get()) {
  const addGame = db.prepare('INSERT INTO games(name,slug,icon,description,sort_order) VALUES (?,?,?,?,?)');
  const ff = addGame.run('فري فاير', 'free-fire', '🔥', 'جواهر وباقات Free Fire للاعبين الذين لا يتوقفون.', 1).lastInsertRowid;
  const pubg = addGame.run('ببجي موبايل', 'pubg-mobile', '🎯', 'شدات PUBG Mobile لتجهيزك للمواجهة القادمة.', 2).lastInsertRowid;
  const addPackage = db.prepare('INSERT INTO packages(game_id,name,price,note,sort_order) VALUES (?,?,?,?,?)');
  addPackage.run(ff, '100 جوهرة', '1', 'باقة أساسية', 1);
  addPackage.run(ff, '530 جوهرة', '5', 'الأكثر طلبًا', 2);
  addPackage.run(pubg, '60 شدة', '1', 'باقة أساسية', 1);
  addPackage.run(pubg, '325 شدة', '5', 'عرض مميز', 2);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const publicSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
const gameRows = (visibleOnly = false) => db.prepare(`SELECT * FROM games ${visibleOnly ? 'WHERE visible=1' : ''} ORDER BY sort_order,id`).all();
const packageRows = (visibleOnly = false) => db.prepare(`SELECT p.*,g.name game_name,g.slug game_slug FROM packages p JOIN games g ON g.id=p.game_id ${visibleOnly ? 'WHERE p.visible=1 AND g.visible=1' : ''} ORDER BY p.game_id,p.sort_order,p.id`).all();
const publicOrder = row => ({
  order_number: row.order_number, game: row.game_name, package: row.package_name,
  player_id: row.player_id, customer_name: row.customer_name, status: row.status,
  admin_note: row.admin_note, created_at: row.created_at, updated_at: row.updated_at
});

function createOrderNumber() {
  let number;
  do number = `BC-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${crypto.randomInt(100000, 999999)}`;
  while (db.prepare('SELECT id FROM orders WHERE order_number=?').get(number));
  return number;
}
function sessionHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function auth(req, res, next) {
  const raw = req.cookies.base_card_session;
  if (!raw) return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا' });
  const session = db.prepare(`SELECT s.*,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?`).get(sessionHash(raw), new Date().toISOString());
  if (!session) return res.status(401).json({ error: 'انتهت الجلسة، سجل الدخول مجددًا' });
  req.admin = session;
  next();
}
function currentCustomer(req) {
  const raw = req.cookies.base_card_user;
  if (!raw) return null;
  return db.prepare(`SELECT u.* FROM customer_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sessionHash(raw), new Date().toISOString()) || null;
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: process.env.GOOGLE_CALLBACK_URL || `${process.env.SITE_URL || `http://localhost:${PORT}`}/auth/google/callback` }, (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id, email = profile.emails?.[0]?.value || '', name = profile.displayName || email || 'مستخدم Google', avatar = profile.photos?.[0]?.value || '';
      const existing = db.prepare('SELECT id FROM users WHERE google_id=?').get(googleId);
      if (existing) db.prepare('UPDATE users SET email=?,name=?,avatar=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(email,name,avatar,existing.id);
      else db.prepare('INSERT INTO users(google_id,email,name,avatar) VALUES (?,?,?,?)').run(googleId,email,name,avatar);
      done(null, db.prepare('SELECT * FROM users WHERE google_id=?').get(googleId));
    } catch (e) { done(e); }
  }));
}
app.use(passport.initialize());
app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.redirect('/?google=not-configured');
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next);
});
app.get('/auth/google/callback', passport.authenticate('google', { session: false, failureRedirect: '/?google=failed' }), (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const days = Number(process.env.SESSION_DAYS || 7);
  db.prepare('INSERT INTO customer_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sessionHash(token), req.user.id, new Date(Date.now() + days * 86400000).toISOString());
  res.cookie('base_card_user', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: days * 86400000 });
  res.redirect('/?google=success');
});
app.get('/api/auth/me', (req, res) => { const user = currentCustomer(req); res.json(user ? { id:user.id, name:user.name, email:user.email, avatar:user.avatar } : null); });
app.post('/api/auth/logout', (req, res) => { if (req.cookies.base_card_user) db.prepare('DELETE FROM customer_sessions WHERE token_hash=?').run(sessionHash(req.cookies.base_card_user)); res.clearCookie('base_card_user'); res.json({ ok:true }); });

app.get('/admin', (_, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/api/public/config', (_, res) => res.json({ settings: publicSettings(), games: gameRows(true), packages: packageRows(true) }));

app.post('/api/orders', orderLimiter, upload.single('receipt'), (req, res) => {
  try {
    const gameId = Number(req.body.game_id), packageId = Number(req.body.package_id);
    const playerId = clean(req.body.player_id, 100), customerName = clean(req.body.customer_name, 120), paymentNumber = clean(req.body.payment_number, 120);
    const game = db.prepare('SELECT * FROM games WHERE id=? AND visible=1').get(gameId);
    const pack = db.prepare('SELECT * FROM packages WHERE id=? AND game_id=? AND visible=1').get(packageId, gameId);
    if (!game || !pack || !playerId || !customerName || !paymentNumber) return res.status(400).json({ error: 'يرجى تعبئة جميع البيانات المطلوبة بشكل صحيح' });
    const orderNumber = createOrderNumber();
    const customer = currentCustomer(req);
    db.prepare(`INSERT INTO orders(order_number,game_id,package_id,player_id,customer_name,payment_number,receipt_path,user_id) VALUES (?,?,?,?,?,?,?,?)`).run(orderNumber, gameId, packageId, playerId, customerName, paymentNumber, req.file ? `/uploads/${req.file.filename}` : null, customer ? customer.id : null);
    res.status(201).json({ order_number: orderNumber, message: 'تم استلام طلبك بنجاح' });
  } catch (e) { res.status(500).json({ error: 'تعذر حفظ الطلب حاليًا' }); }
});
app.get('/api/orders/:number', (req, res) => {
  const row = db.prepare(`SELECT o.*,g.name game_name,p.name package_name FROM orders o JOIN games g ON g.id=o.game_id JOIN packages p ON p.id=o.package_id WHERE o.order_number=?`).get(clean(req.params.number, 60));
  if (!row) return res.status(404).json({ error: 'لم يتم العثور على هذا الطلب' });
  res.json(publicOrder(row));
});
app.post('/api/support', orderLimiter, (req, res) => {
  const name = clean(req.body.name, 120), contact = clean(req.body.contact, 160), message = clean(req.body.message, 1000);
  if (!name || !contact || !message) return res.status(400).json({ error: 'يرجى تعبئة بيانات التواصل والرسالة' });
  db.prepare('INSERT INTO messages(name,contact,message) VALUES (?,?,?)').run(name, contact, message);
  res.status(201).json({ message: 'تم إرسال رسالتك، وسيتواصل معك فريق الدعم' });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const username = clean(req.body.username, 80), password = String(req.body.password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  const token = crypto.randomBytes(32).toString('hex');
  const days = Number(process.env.SESSION_DAYS || 7);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES (?,?,?)').run(sessionHash(token), admin.id, expires);
  res.cookie('base_card_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: days * 86400000 });
  res.json({ username: admin.username });
});
app.post('/api/admin/logout', (req, res) => {
  if (req.cookies.base_card_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(req.cookies.base_card_session));
  res.clearCookie('base_card_session');
  res.json({ ok: true });
});
app.get('/api/admin/me', auth, (req, res) => res.json({ username: req.admin.username }));
app.get('/api/admin/dashboard', auth, (_, res) => {
  const counts = {
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    today: db.prepare("SELECT COUNT(*) n FROM orders WHERE date(created_at)=date('now')").get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('pending','processing')").get().n,
    games: db.prepare('SELECT COUNT(*) n FROM games WHERE visible=1').get().n
  };
  const orders = db.prepare(`SELECT o.*,g.name game_name,p.name package_name FROM orders o JOIN games g ON g.id=o.game_id JOIN packages p ON p.id=o.package_id ORDER BY o.id DESC LIMIT 10`).all();
  res.json({ counts, orders });
});
app.get('/api/admin/games', auth, (_, res) => res.json(gameRows(false)));
app.post('/api/admin/games', auth, (req, res) => {
  const name = clean(req.body.name, 100), slug = clean(req.body.slug, 100).toLowerCase().replace(/[^a-z0-9-]/g, '-'), icon = clean(req.body.icon, 8) || '🎮', description = clean(req.body.description, 300);
  if (!name || !slug) return res.status(400).json({ error: 'الاسم والرابط المختصر مطلوبان' });
  try { const result = db.prepare('INSERT INTO games(name,slug,icon,description,visible,sort_order) VALUES (?,?,?,?,?,?)').run(name, slug, icon, description, Number(req.body.visible !== false), Number(req.body.sort_order || 0)); res.status(201).json({ id: result.lastInsertRowid }); } catch { res.status(400).json({ error: 'الرابط المختصر مستخدم مسبقًا' }); }
});
app.put('/api/admin/games/:id', auth, (req, res) => {
  const id = Number(req.params.id); const old = db.prepare('SELECT * FROM games WHERE id=?').get(id); if (!old) return res.status(404).json({ error: 'اللعبة غير موجودة' });
  const name = clean(req.body.name, 100), icon = clean(req.body.icon, 8) || '🎮', description = clean(req.body.description, 300);
  db.prepare('UPDATE games SET name=?,icon=?,description=?,visible=?,sort_order=? WHERE id=?').run(name || old.name, icon, description, req.body.visible ? 1 : 0, Number(req.body.sort_order || 0), id); res.json({ ok: true });
});
app.delete('/api/admin/games/:id', auth, (req, res) => { try { db.prepare('DELETE FROM games WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); } catch { res.status(400).json({ error: 'لا يمكن حذف لعبة مرتبطة بطلبات' }); } });
app.get('/api/admin/packages', auth, (_, res) => res.json(packageRows(false)));
app.post('/api/admin/packages', auth, (req, res) => { const gameId = Number(req.body.game_id), name = clean(req.body.name, 100), price = clean(req.body.price, 50), note = clean(req.body.note, 150); if (!gameId || !name || !price) return res.status(400).json({ error: 'اللعبة والاسم والسعر مطلوبة' }); const r = db.prepare('INSERT INTO packages(game_id,name,price,note,visible,sort_order) VALUES (?,?,?,?,?,?)').run(gameId,name,price,note,Number(req.body.visible !== false),Number(req.body.sort_order||0)); res.status(201).json({ id:r.lastInsertRowid }); });
app.put('/api/admin/packages/:id', auth, (req, res) => { const id=Number(req.params.id); if(!db.prepare('SELECT id FROM packages WHERE id=?').get(id)) return res.status(404).json({error:'الباقة غير موجودة'}); db.prepare('UPDATE packages SET game_id=?,name=?,price=?,note=?,visible=?,sort_order=? WHERE id=?').run(Number(req.body.game_id),clean(req.body.name,100),clean(req.body.price,50),clean(req.body.note,150),req.body.visible?1:0,Number(req.body.sort_order||0),id); res.json({ok:true}); });
app.delete('/api/admin/packages/:id', auth, (req, res) => { try { db.prepare('DELETE FROM packages WHERE id=?').run(Number(req.params.id)); res.json({ok:true}); } catch { res.status(400).json({error:'لا يمكن حذف باقة مرتبطة بطلبات'}); } });
app.get('/api/admin/orders', auth, (req, res) => { const q=clean(req.query.q,100), status=clean(req.query.status,30); let sql=`SELECT o.*,g.name game_name,p.name package_name FROM orders o JOIN games g ON g.id=o.game_id JOIN packages p ON p.id=o.package_id WHERE 1=1`; const args=[]; if(q){sql+=' AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.player_id LIKE ?)'; args.push(`%${q}%`,`%${q}%`,`%${q}%`)} if(status){sql+=' AND o.status=?';args.push(status)} sql+=' ORDER BY o.id DESC'; res.json(db.prepare(sql).all(...args)); });
app.patch('/api/admin/orders/:id', auth, (req, res) => { const allowed=['pending','processing','completed','rejected']; const status=clean(req.body.status,30); if(!allowed.includes(status)) return res.status(400).json({error:'حالة غير صالحة'}); db.prepare('UPDATE orders SET status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,clean(req.body.admin_note,500),Number(req.params.id)); res.json({ok:true}); });
app.get('/api/admin/settings', auth, (_, res) => res.json(publicSettings()));
app.put('/api/admin/settings', auth, (req, res) => { for(const key of Object.keys(settingDefaults)) if(req.body[key] !== undefined) upsertSetting.run(key, clean(req.body[key], 1000)); res.json(publicSettings()); });
app.post('/api/admin/settings/payment', auth, upload.single('qr_code'), (req, res) => { if(req.body.sham_cash !== undefined) upsertSetting.run('sham_cash', clean(req.body.sham_cash, 200)); if(req.file) upsertSetting.run('sham_cash_qr', `/uploads/${req.file.filename}`); res.json(publicSettings()); });
app.get('/api/admin/messages', auth, (_, res) => res.json(db.prepare('SELECT * FROM messages ORDER BY id DESC').all()));

app.use((err, _, res, __) => { console.error(err); res.status(500).json({ error: 'حدث خطأ غير متوقع' }); });
app.listen(PORT, () => console.log(`Base Card running on port ${PORT}`));
