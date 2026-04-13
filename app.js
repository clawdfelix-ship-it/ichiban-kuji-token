const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { put } = require('@vercel/blob');
const Stripe = require('stripe');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection - supports Vercel Postgres
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
if (!connectionString) {
  console.error('ERROR: POSTGRES_URL environment variable is not set!');
  console.error('Please go to Vercel dashboard → Project → Settings → Environment Variables');
  console.error('Add POSTGRES_URL from your Vercel Postgres connection string');
}

const usePgSsl = (() => {
  if (!connectionString) return false;
  const raw = String(connectionString).toLowerCase();
  if (process.env.PGSSLMODE === 'disable' || process.env.PG_SSL_DISABLE === '1') return false;
  if (raw.includes('localhost') || raw.includes('127.0.0.1')) return false;
  return true;
})();

const pool = new Pool({
  connectionString,
  ssl: usePgSsl ? { rejectUnauthorized: false } : false
});

// For Vercel serverless: we use memoryStorage, because Vercel filesystem is read-only at runtime
// After user uploads in admin, we save it to public/uploads and it needs to be committed to git
// to be available to Vercel CDN. This is okay because:
// 1. Admin uploads are very infrequent
// 2. Images are small (<5MB)
// 3. After upload, you just need to git commit/push and Vercel deploys it
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳圖片文件'));
    }
  }
});

// Ensure upload directory exists locally (we already created it with .gitkeep)
const uploadDir = path.join(__dirname, 'public', 'uploads');

// Test connection
if (connectionString) {
  pool.connect((err, client, release) => {
    if (err) {
      console.error('Error connecting to PostgreSQL:', err);
    } else {
      console.log('Connected to PostgreSQL database');
      release();
    }
  });
}

// Promisify query
function dbQuery(sql, params = [], client = pool) {
  return client.query(sql, params);
}

// Multer middleware for mixed content-type support
// upload.any() allows file uploads, we just ignore files for now (text fields are parsed)
const anyMulter = upload.any();
const multerUnlessJson = (req, res, next) => {
  const contentType = req.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    anyMulter(req, res, next);
  } else {
    next();
  }
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/stripe')) {
        req.rawBody = buf;
      }
    }
  })
);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const isVercel = !!process.env.VERCEL;
if (isVercel) {
  app.set('trust proxy', 1);
}

if (isVercel && !process.env.SESSION_SECRET) {
  console.error('WARNING: SESSION_SECRET is not set on Vercel. Using random secret (sessions will reset on restart).');
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const twdPerHkd = (() => {
  const raw =
    process.env.TWD_PER_HKD ||
    process.env.HKD_TO_TWD ||
    process.env.FX_TWD_PER_HKD ||
    '4.0';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 4.0;
})();

function formatMoney(value, maxFractionDigits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('zh-HK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.redirect('/admin/login');
  }
  next();
}

function requireAuthApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '請先登入' });
  }
  next();
}

function requireAdminApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '請先以管理員登入' });
  }
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: '需要管理員權限' });
  }
  next();
}

function normalizeSessionUser(userRow) {
  if (!userRow) return null;
  return {
    id: userRow.id,
    username: userRow.username,
    contact: userRow.contact ?? null,
    is_admin: !!userRow.is_admin,
    created_at: userRow.created_at
  };
}

// Create tables if not exists
async function initDatabase() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        contact TEXT NULL,
        is_admin INTEGER DEFAULT 0,
        token_balance INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS raffles (
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        type TEXT DEFAULT 'ichiban',
        total_boxes INTEGER,
        price_per_box REAL,
        cover_image TEXT NULL,
        remaining_boxes INTEGER,
        num_pools INTEGER DEFAULT 1,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        status TEXT DEFAULT 'active',
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prizes (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        tier TEXT,
        name TEXT,
        description TEXT,
        image_url TEXT,
        total_count INTEGER,
        remaining_count INTEGER,
        is_final BOOLEAN DEFAULT FALSE,
        pool_number INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id)
      );

      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        prize_id INTEGER,
        buyer_name TEXT,
        buyer_contact TEXT,
        user_id INTEGER NULL,
        verification_code_id INTEGER NULL,
        drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );

      CREATE TABLE IF NOT EXISTS winners (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER,
        raffle_id INTEGER,
        prize_id INTEGER,
        buyer_name TEXT,
        user_id INTEGER NULL,
        drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(entry_id) REFERENCES entries(id),
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );

      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        code TEXT UNIQUE,
        prize_id INTEGER,
        used BOOLEAN DEFAULT FALSE,
        used_at TIMESTAMP NULL,
        user_id INTEGER NULL,
        assigned_user_id INTEGER NULL,
        assigned_at TIMESTAMP NULL,
        assigned_by INTEGER NULL,
        purchase_id INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );

      CREATE TABLE IF NOT EXISTS token_topups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_ref TEXT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tokens INTEGER NOT NULL,
        amount_hkd INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'HKD',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP NULL,
        UNIQUE(provider, provider_ref),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS token_ledger (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        delta_tokens INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_type TEXT NULL,
        ref_id INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    await dbQuery('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_balance INTEGER DEFAULT 0');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_by INTEGER NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS purchase_id INTEGER NULL');
    await dbQuery('ALTER TABLE raffles ADD COLUMN IF NOT EXISTS cover_image TEXT NULL');
    await dbQuery('ALTER TABLE entries ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP NULL');

    const adminResult = await dbQuery('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
    const hasAdmin = adminResult.rows[0]?.count !== '0';

    const seedAdminUsername =
      process.env.SEED_ADMIN_USERNAME ||
      process.env.ADMIN_LOGIN ||
      process.env.ADMIN_USERNAME;
    const seedAdminPassword =
      process.env.SEED_ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD;
    const allowReset =
      process.env.SEED_ADMIN_RESET === '1' ||
      process.env.RESET_ADMIN_PASSWORD === '1';

    if (seedAdminUsername && seedAdminPassword) {
      const existingUserResult = await dbQuery('SELECT id, is_admin FROM users WHERE username = $1 LIMIT 1', [
        seedAdminUsername
      ]);
      const exists = existingUserResult.rows.length > 0;

      if (!exists) {
        const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
        await dbQuery(
          'INSERT INTO users (username, password_hash, contact, is_admin) VALUES ($1, $2, $3, $4)',
          [seedAdminUsername, passwordHash, null, 1]
        );
        console.log('Admin user seeded from environment variables.');
      } else if (allowReset || !hasAdmin) {
        const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
        await dbQuery('UPDATE users SET password_hash = $1, is_admin = 1 WHERE username = $2', [
          passwordHash,
          seedAdminUsername
        ]);
        console.log('Admin user password updated from environment variables.');
      }
    }

    console.log('Database initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

const dbInit = (async () => {
  if (!connectionString) return;
  await initDatabase();
})();

app.use(async (req, res, next) => {
  if (!connectionString) return next();
  try {
    await dbInit;
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'Database init failed' });
    }
    return res.status(500).send('Database init failed');
  }
});

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripeClient = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const TOKENS_PER_BOX = 299;

// Session must come after database init because it depends on pgSession with the connected pool
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isVercel
    },
    ...(connectionString
      ? {
          store: new pgSession({
            pool,
            createTableIfMissing: true
          })
        }
      : {})
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = !!req.session.user?.is_admin;
  res.locals.twdPerHkd = twdPerHkd;
  res.locals.formatMoney = formatMoney;
  next();
});

app.get('/api/admin/stripe/debug', requireAdminApi, async (req, res) => {
  const out = {
    stripe: {
      has_secret_key: !!stripeSecretKey,
      secret_key_prefix: stripeSecretKey ? stripeSecretKey.slice(0, 7) : null,
      has_webhook_secret: !!stripeWebhookSecret,
      api_ok: null,
      api_error: null
    },
    db: {
      has_postgres_url: !!connectionString,
      ok: null,
      token_balance_column: null,
      token_topups_table: null,
      error: null
    },
    env: {
      vercel: !!process.env.VERCEL,
      has_session_secret: !!process.env.SESSION_SECRET
    }
  };

  if (stripeClient && stripeSecretKey.startsWith('sk_')) {
    try {
      const acct = await stripeClient.accounts.retrieve();
      out.stripe.api_ok = true;
      out.stripe.account_id = acct?.id || null;
    } catch (err) {
      out.stripe.api_ok = false;
      out.stripe.api_error = err?.message || 'Stripe error';
    }
  }

  if (connectionString) {
    try {
      await dbQuery('SELECT 1');
      out.db.ok = true;

      const col = await dbQuery(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_balance' LIMIT 1`
      );
      out.db.token_balance_column = col.rows.length > 0;

      const tbl = await dbQuery(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_topups' LIMIT 1`
      );
      out.db.token_topups_table = tbl.rows.length > 0;
    } catch (err) {
      out.db.ok = false;
      out.db.error = err?.message || 'DB error';
    }
  }

  res.json(out);
});

app.get('/api/wallet/balance', requireAuthApi, async (req, res) => {
  try {
    if (!connectionString) {
      return res.status(500).json({ error: 'POSTGRES_URL 未設定' });
    }
    const result = await dbQuery('SELECT token_balance FROM users WHERE id = $1', [req.session.user.id]);
    res.json({ token_balance: result.rows[0]?.token_balance || 0 });
  } catch (err) {
    console.error('Wallet balance failed:', err);
    res.status(500).json({ error: err?.message || 'Server error' });
  }
});

app.post('/api/wallet/stripe/checkout', requireAuthApi, async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(500).json({ error: 'Stripe 未設定' });
    }
    if (!stripeSecretKey.startsWith('sk_')) {
      return res.status(500).json({ error: 'Stripe key 設定錯誤（請使用 Secret Key）' });
    }

    const tokens = parseInt(req.body.tokens, 10);
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens % TOKENS_PER_BOX !== 0) {
      return res.status(400).json({ error: `充值 tokens 必須係 ${TOKENS_PER_BOX} 嘅倍數` });
    }
    if (tokens > TOKENS_PER_BOX * 200) {
      return res.status(400).json({ error: '單次充值太大' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const topupResult = await dbQuery(
      `
        INSERT INTO token_topups (user_id, provider, provider_ref, status, tokens, amount_hkd, currency)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
      `,
      [req.session.user.id, 'stripe', null, 'pending', tokens, tokens, 'HKD']
    );
    const topupId = topupResult.rows[0].id;

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'hkd',
            unit_amount: tokens * 100,
            product_data: {
              name: `充值 Tokens ${tokens}`
            }
          }
        }
      ],
      metadata: {
        topup_id: String(topupId),
        user_id: String(req.session.user.id),
        tokens: String(tokens)
      },
      success_url: `${baseUrl}/my?topup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/my?topup=cancel`
    });

    await dbQuery('UPDATE token_topups SET provider_ref = $1 WHERE id = $2', [session.id, topupId]);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout failed:', err);
    if (!connectionString) {
      return res.status(500).json({ error: 'POSTGRES_URL 未設定' });
    }
    res.status(500).json({ error: err?.message || 'Stripe error' });
  }
});

app.post('/api/wallet/stripe/confirm', requireAuthApi, async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(500).json({ error: 'Stripe 未設定' });
    }
    if (!stripeSecretKey.startsWith('sk_')) {
      return res.status(500).json({ error: 'Stripe key 設定錯誤（請使用 Secret Key）' });
    }
    const sessionId = String(req.body.session_id || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: '缺少 session_id' });
    }

    const session = await stripeClient.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: '付款未完成' });
    }

    const topupId = parseInt(session?.metadata?.topup_id, 10);
    const userId = parseInt(session?.metadata?.user_id, 10);
    const tokens = parseInt(session?.metadata?.tokens, 10);
    if (!topupId || !userId || !tokens) {
      return res.status(400).json({ error: '付款資料不完整' });
    }
    if (userId !== req.session.user.id) {
      return res.status(403).json({ error: '付款帳號不匹配' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await dbQuery(
        `SELECT id, status, provider_ref FROM token_topups WHERE id = $1 FOR UPDATE`,
        [topupId],
        client
      );
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: '充值記錄不存在' });
      }
      if (!locked.rows[0].provider_ref) {
        await dbQuery('UPDATE token_topups SET provider_ref = $1 WHERE id = $2', [session.id, topupId], client);
      }
      if (locked.rows[0].status !== 'paid') {
        await dbQuery(
          `UPDATE token_topups SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [topupId],
          client
        );
        await dbQuery(`UPDATE users SET token_balance = token_balance + $1 WHERE id = $2`, [tokens, userId], client);
        await dbQuery(
          `INSERT INTO token_ledger (user_id, delta_tokens, reason, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
          [userId, tokens, 'topup', 'token_topups', topupId],
          client
        );
      }

      const bal = await dbQuery('SELECT token_balance FROM users WHERE id = $1', [userId], client);
      await client.query('COMMIT');
      client.release();
      return res.json({ success: true, token_balance: bal.rows[0]?.token_balance || 0 });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      client.release();
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('Stripe confirm failed:', err);
    return res.status(500).json({ error: err?.message || 'Stripe error' });
  }
});

app.post('/api/webhooks/stripe', async (req, res) => {
  if (!stripeClient || !stripeWebhookSecret) {
    return res.status(500).send('Stripe not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const topupId = parseInt(session?.metadata?.topup_id, 10);
    const userId = parseInt(session?.metadata?.user_id, 10);
    const tokens = parseInt(session?.metadata?.tokens, 10);

    if (topupId && userId && tokens) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await dbQuery(
          `SELECT id, status FROM token_topups WHERE id = $1 FOR UPDATE`,
          [topupId],
          client
        );
        if (locked.rows.length === 0) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(200).json({ received: true });
        }
        if (locked.rows[0].status === 'paid') {
          await client.query('COMMIT');
          client.release();
          return res.status(200).json({ received: true });
        }

        await dbQuery(
          `UPDATE token_topups SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [topupId],
          client
        );

        await dbQuery(
          `UPDATE users SET token_balance = token_balance + $1 WHERE id = $2`,
          [tokens, userId],
          client
        );

        await dbQuery(
          `INSERT INTO token_ledger (user_id, delta_tokens, reason, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
          [userId, tokens, 'topup', 'token_topups', topupId],
          client
        );

        await client.query('COMMIT');
        client.release();
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        client.release();
        console.error(err);
        return res.status(500).send('Server error');
      }
    }
  }

  res.json({ received: true });
});

// ===== Auth Routes (Public) =====

// User login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/my');
  }
  res.render('login');
});

// User register page
app.get('/register', (req, res) => {
  if (req.session.user) {
    return res.redirect('/my');
  }
  res.render('register');
});

// User my page - list my raffle entries
app.get('/my', requireAuth, (req, res) => {
  res.render('my');
});

// Register API
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, contact } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '請填寫用戶名和密碼' });
    }

    // Check if username exists
    const existing = await dbQuery('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: '用戶名已存在' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbQuery(`
      INSERT INTO users (username, password_hash, contact, is_admin)
      VALUES ($1, $2, $3, 0)
      RETURNING id, username, contact, is_admin, created_at
    `, [username, passwordHash, contact || null]);

    const user = normalizeSessionUser(result.rows[0]);
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '請填寫用戶名和密碼' });
    }

    const result = await dbQuery('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    const sessionUser = normalizeSessionUser(user);
    req.session.user = sessionUser;
    res.json({ success: true, user: sessionUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Public Routes =====

// Home page - list all active raffles
app.get('/', async (req, res) => {
  try {
    if (!connectionString) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="zh-HK">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>設定錯誤 - Ichiban Kuji Raffle</title>
          <style>body{font-family:Arial,sans-serif;max-width:800px;margin:50px auto;padding:20px}h1{color:#e74c3c}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow:auto}</style>
        </head>
        <body>
          <h1>⚠️  數據庫連接設定錯誤</h1>
          <p><strong>問題:</strong> 環境變量 <code>POSTGRES_URL</code> 未設定</p>
          <h3>解決方法:</h3>
          <ol>
            <li>去 Vercel 後台 → 這個項目 → Settings → Environment Variables</li>
            <li>添加 <code>POSTGRES_URL</code>，值係你嘅 Vercel Postgres 連接字符串</li>
            <li>重新部署項目</li>
          </ol>
          <p>如果你仲未創建 Vercel Postgres 數據庫:</p>
          <ol>
            <li>在 Vercel dashboard → Storage → Create Database → Vercel Postgres</li>
            <li>創建完成後複製 Connection String</li>
            <li>添加到 Environment Variables 命名為 <code>POSTGRES_URL</code></li>
            <li>Redeploy</li>
          </ol>
        </body>
        </html>
      `);
    }
    const result = await dbQuery(`
      SELECT id, title, description, total_boxes, remaining_boxes, price_per_box, status, cover_image
      FROM raffles
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);
    res.render('index', { raffles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="zh-HK">
      <head>
        <meta charset="UTF-8">
        <title>Server Error</title>
        <style>body{font-family:Arial,sans-serif;max-width:800px;margin:50px auto;padding:20px}h1{color:#e74c3c}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow:auto}</style>
      </head>
      <body>
        <h1>❌ Internal Server Error</h1>
        <p><strong>Error:</strong></p>
        <pre>${err.message}</pre>
        <p>Check Vercel logs for more details.</p>
      </body>
      </html>
    `);
  }
});

// Raffle detail page - show remaining prizes
app.get('/raffle/:id', async (req, res) => {
  try {
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [req.params.id]);
    if (raffleResult.rows.length === 0) {
      return res.status(404).send('抽獎活動不存在');
    }
    const raffle = raffleResult.rows[0];

    const entriesCountResult = await dbQuery(
      'SELECT COUNT(*)::INTEGER as count FROM entries WHERE raffle_id = $1',
      [raffle.id]
    );
    const entriesCount = entriesCountResult.rows[0]?.count || 0;
    const computedRemaining = Math.max((Number(raffle.total_boxes) || 0) - (Number(entriesCount) || 0), 0);
    if (Number.isFinite(computedRemaining) && Number(raffle.remaining_boxes) !== Number(computedRemaining)) {
      await dbQuery('UPDATE raffles SET remaining_boxes = $1 WHERE id = $2', [computedRemaining, raffle.id]);
      raffle.remaining_boxes = computedRemaining;
      if (computedRemaining <= 0 && raffle.status !== 'completed') {
        await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffle.id]);
        raffle.status = 'completed';
      }
    }

    // Get all prizes grouped by tier
    const prizesResult = await dbQuery(`
      SELECT * FROM prizes
      WHERE raffle_id = $1
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    const prizes = prizesResult.rows;

    // Group by pool for final prizes
    const pools = [];
    for (let i = 1; i <= raffle.num_pools; i++) {
      const poolPrizes = prizes.filter(p => p.pool_number === i || p.pool_number === null && i === 1);
      pools.push({
        number: i,
        prizes: poolPrizes
      });
    }

    // Get recent winners
    const winnersResult = await dbQuery(`
      SELECT w.*,
             CASE WHEN p.tier IN ('A','B','C','D','E','F','G','H') THEN p.name ELSE '親筆簽名拍立得' END as prize_name,
             p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = $1
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);

    const remainingCount = Number.isFinite(computedRemaining) ? computedRemaining : raffle.remaining_boxes;

    res.render('raffle', {
      raffle,
      pools,
      winners: winnersResult.rows,
      remainingCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// API: Get remaining prize counts
app.get('/api/raffle/:id/prizes', async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT id, tier, name, remaining_count, total_count, is_final, pool_number
      FROM prizes
      WHERE raffle_id = $1
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    res.json({ prizes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get recent winners
app.get('/api/raffle/:id/winners', async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT w.*,
             CASE WHEN p.tier IN ('A','B','C','D','E','F','G','H') THEN p.name ELSE '親筆簽名拍立得' END as prize_name,
             p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = $1
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);
    res.json({ winners: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/raffle/:id/buy-with-tokens', requireAuthApi, async (req, res) => {
  const client = await pool.connect();
  try {
    const raffleId = parseInt(req.params.id);
    const quantity = parseInt(req.body.quantity, 10);
    if (!raffleId) {
      client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 50) {
      client.release();
      return res.status(400).json({ error: '購買數量無效（最多 50）' });
    }

    await client.query('BEGIN');

    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1 FOR UPDATE', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];
    if (raffle.status !== 'active') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }

    const userResult = await dbQuery('SELECT id, token_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.user.id], client);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(401).json({ error: '請先登入' });
    }
    const user = userResult.rows[0];
    const costTokens = quantity * TOKENS_PER_BOX;
    if (Number(user.token_balance || 0) < costTokens) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: `Tokens 不足，需要 ${costTokens} tokens` });
    }

    const prizesResult = await dbQuery(
      `
        SELECT p.id, p.remaining_count, COUNT(vc.id) as pending_codes
        FROM prizes p
        LEFT JOIN verification_codes vc
          ON p.id = vc.prize_id AND vc.used = false
        WHERE p.raffle_id = $1
        GROUP BY p.id, p.remaining_count
      `,
      [raffleId],
      client
    );

    const availablePrizes = [];
    for (const row of prizesResult.rows) {
      const realRemaining = parseInt(row.remaining_count) - parseInt(row.pending_codes);
      for (let i = 0; i < realRemaining; i++) {
        availablePrizes.push(row.id);
      }
    }

    if (availablePrizes.length < quantity) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: `剩餘獎項數量不足，淨係得 ${availablePrizes.length} 個空額` });
    }

    for (let i = availablePrizes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [availablePrizes[i], availablePrizes[j]] = [availablePrizes[j], availablePrizes[i]];
    }

    await dbQuery('UPDATE users SET token_balance = token_balance - $1 WHERE id = $2', [costTokens, user.id], client);
    await dbQuery(
      `INSERT INTO token_ledger (user_id, delta_tokens, reason, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, -costTokens, 'buy_boxes', 'raffles', raffleId],
      client
    );

    const codes = [];
    for (let i = 0; i < quantity; i++) {
      const prizeId = availablePrizes[i];
      while (true) {
        const code = crypto.randomBytes(8).toString('hex').toUpperCase();
        const inserted = await dbQuery(
          `
            INSERT INTO verification_codes (raffle_id, code, prize_id, assigned_user_id, assigned_at)
              VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
              ON CONFLICT (code) DO NOTHING
              RETURNING code
          `,
          [raffleId, code, prizeId, user.id],
          client
        );
        if (inserted.rows.length > 0) {
          codes.push(inserted.rows[0].code);
          break;
        }
      }
    }

    await client.query('COMMIT');
    client.release();

    res.json({ success: true, quantity, costTokens, codes });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Draw prize endpoint - requires verification code
app.post('/api/raffle/:id/draw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, contact, code } = req.body;
    const raffleId = parseInt(req.params.id);
    const userId = req.session.user?.id || null;

    if (!raffleId) {
      await client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!code) {
      await client.release();
      return res.status(400).json({ error: '需要輸入抽獎驗證碼' });
    }
    if (!username || !contact) {
      await client.release();
      return res.status(400).json({ error: '需要填寫會員用戶名和聯絡方式' });
    }

    await client.query('BEGIN');

    const codeResult = await dbQuery(
      `
        SELECT vc.*, au.username as assigned_username
        FROM verification_codes vc
        LEFT JOIN users au ON vc.assigned_user_id = au.id
        WHERE vc.code = $1 AND vc.raffle_id = $2 AND vc.used = false
        FOR UPDATE OF vc
      `,
      [code, raffleId],
      client
    );
    if (codeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '驗證碼無效或已使用' });
    }
    const verificationCode = codeResult.rows[0];

    if (verificationCode.assigned_user_id) {
      if (!req.session.user) {
        await client.query('ROLLBACK');
        await client.release();
        return res.status(401).json({ error: '此驗證碼已分配給會員，請用會員登入後再抽獎' });
      }
      if (Number(req.session.user.id) !== Number(verificationCode.assigned_user_id)) {
        await client.query('ROLLBACK');
        await client.release();
        const assignedUsername = verificationCode.assigned_username || '指定會員';
        const currentUsername = req.session.user.username || String(req.session.user.id);
        return res.status(403).json({ error: `此驗證碼已分配給會員 ${assignedUsername}，你而家登入緊 ${currentUsername}` });
      }
    }

    const effectiveUsername = req.session.user?.username || username;

    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1 FOR UPDATE', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];

    if (raffle.status !== 'active') {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }
    if (raffle.remaining_boxes <= 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '所有盒子已經抽完' });
    }

    // Get the pre-allocated prize from verification code
    if (!verificationCode.prize_id) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '驗證碼資料錯誤，缺少預分配獎項' });
    }

    // Mark code as used FIRST - this prevents duplicate submission with double click
    // Because we already have the row lock from SELECT ... FOR UPDATE earlier, this is safe
    const codeUpdate = await dbQuery(
      `
        UPDATE verification_codes
          SET used = true, used_at = CURRENT_TIMESTAMP, user_id = $1
          WHERE id = $2 AND used = false
          RETURNING id
      `,
      [userId, verificationCode.id],
      client
    );
    if (codeUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(409).json({ error: '驗證碼已被使用，請檢查後重試' });
    }

    const prizeResult = await dbQuery(
      `
        SELECT * FROM prizes
        WHERE id = $1 AND raffle_id = $2 AND remaining_count > 0
        FOR UPDATE
      `,
      [verificationCode.prize_id, raffleId],
      client
    );
    if (prizeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '此獎項已經被抽完，驗證碼無效' });
    }
    const drawnPrize = prizeResult.rows[0];

    // Update prize count
    const prizeUpdate = await dbQuery(
      `
        UPDATE prizes
          SET remaining_count = remaining_count - 1
          WHERE id = $1 AND remaining_count > 0
          RETURNING id, name, tier, description, image_url, is_final, remaining_count
      `,
      [drawnPrize.id],
      client
    );
    const updatedPrize = prizeUpdate.rows[0];

    // Create entry
    const entryResult = await dbQuery(
      `
        INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
      `,
      [raffleId, updatedPrize.id, effectiveUsername, contact, userId, verificationCode.id],
      client
    );
    const entryId = entryResult.rows[0].id;

    await dbQuery(
      `
        INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
          VALUES ($1, $2, $3, $4, $5)
      `,
      [entryId, raffleId, updatedPrize.id, effectiveUsername, userId],
      client
    );

    const raffleUpdate = await dbQuery(
      `
        UPDATE raffles r
          SET remaining_boxes = GREATEST(r.total_boxes - x.entry_count, 0)
          FROM (
            SELECT COUNT(*)::INTEGER as entry_count
            FROM entries
            WHERE raffle_id = $1
          ) x
          WHERE r.id = $1
          RETURNING r.remaining_boxes
      `,
      [raffleId],
      client
    );
    const remainingBoxes = raffleUpdate.rows[0]?.remaining_boxes;
    if (typeof remainingBoxes !== 'number') {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(409).json({ error: '盒子餘量更新失敗，請重試' });
    }
    if (remainingBoxes <= 0) {
      await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
    }

    await client.query('COMMIT');
    await client.release();

    const majorTiers = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const displayPrizeName = majorTiers.has(updatedPrize.tier) ? updatedPrize.name : '親筆簽名拍立得';

    res.json({
      success: true,
      entryId,
      prize: { ...updatedPrize, name: displayPrizeName },
      remaining_boxes: remainingBoxes
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    console.error(err);
    await client.release();
    res.status(500).json({ error: 'Server error' });
  }
});

// Batch draw - process multiple verification codes at once
app.post('/api/raffle/:id/batch-draw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { codes, username, contact } = req.body;
    const raffleId = parseInt(req.params.id);
    const userId = req.session.user?.id || null;

    if (!raffleId) {
      await client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      await client.release();
      return res.status(400).json({ error: '需要輸入驗證碼列表' });
    }
    if (!username || !contact) {
      await client.release();
      return res.status(400).json({ error: '需要填寫會員用戶名和聯絡方式' });
    }
    if (codes.length > 50) {
      await client.release();
      return res.status(400).json({ error: '批量抽獎最多支持 50 個驗證碼' });
    }

    // Check raffle exists and is active
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.release();
      return res.status(404).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];
    if (raffle.status !== 'active') {
      await client.release();
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }

    const majorTiers = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const results = [];
    let successCount = 0;

    // Process each code sequentially
    for (const code of codes) {
      const trimmedCode = code.trim();
      if (!trimmedCode) continue;

      try {
        await client.query('BEGIN');

        // Find unused code - lock it immediately
        const codeResult = await dbQuery(
          `
            SELECT vc.*, au.username as assigned_username
            FROM verification_codes vc
            LEFT JOIN users au ON vc.assigned_user_id = au.id
            WHERE vc.code = $1 AND vc.raffle_id = $2 AND vc.used = false
            FOR UPDATE OF vc
          `,
          [trimmedCode, raffleId],
          client
        );

        if (codeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼無效或已使用'
          });
          continue;
        }

        const verificationCode = codeResult.rows[0];

        // Check assigned user
        if (verificationCode.assigned_user_id) {
          if (!req.session.user) {
            await client.query('ROLLBACK');
            results.push({
              code: trimmedCode,
              success: false,
              error: '此驗證碼已分配給會員，請登入後再抽獎'
            });
            continue;
          }
          if (Number(req.session.user.id) !== Number(verificationCode.assigned_user_id)) {
            const assignedUsername = verificationCode.assigned_username || '指定會員';
            const currentUsername = req.session.user.username || String(req.session.user.id);
            await client.query('ROLLBACK');
            results.push({
              code: trimmedCode,
              success: false,
              error: `此驗證碼已分配給 ${assignedUsername}，目前登入係 ${currentUsername}`
            });
            continue;
          }
        }

        // Mark code as used FIRST - same fix as single draw
        const codeUpdate = await dbQuery(
          `
            UPDATE verification_codes
              SET used = true, used_at = CURRENT_TIMESTAMP, user_id = $1
              WHERE id = $2 AND used = false
              RETURNING id
          `,
          [userId, verificationCode.id],
          client
        );
        if (codeUpdate.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼已被使用'
          });
          continue;
        }

        // Check that prize still exists and is available
        if (!verificationCode.prize_id) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼未預分配獎項，資料錯誤'
          });
          continue;
        }

        const prizeCheck = await dbQuery(
          `SELECT * FROM prizes WHERE id = $1 AND raffle_id = $2 AND remaining_count > 0 FOR UPDATE`,
          [verificationCode.prize_id, raffleId],
          client
        );
        if (prizeCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '對應獎項已經抽完'
          });
          continue;
        }
        const drawnPrize = prizeCheck.rows[0];

        // Check remaining boxes
        if (raffle.remaining_boxes - successCount <= 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '所有盒子已經抽完'
          });
          continue;
        }

        // Update prize count
        const prizeUpdate = await dbQuery(
          `
            UPDATE prizes
              SET remaining_count = remaining_count - 1
              WHERE id = $1 AND remaining_count > 0
              RETURNING id, name, tier, description, is_final, remaining_count
          `,
          [drawnPrize.id],
          client
        );
        if (prizeUpdate.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '獎項餘量更新失敗'
          });
          continue;
        }
        const updatedPrize = prizeUpdate.rows[0];

        const effectiveUsername = req.session.user?.username || username;

        // Insert entry
        const entryResult = await dbQuery(
          `
            INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id
          `,
          [raffleId, updatedPrize.id, effectiveUsername, contact, userId, verificationCode.id],
          client
        );
        const entryId = entryResult.rows[0].id;

        // Insert winner
        await dbQuery(
          `
            INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
              VALUES ($1, $2, $3, $4, $5)
          `,
          [entryId, raffleId, updatedPrize.id, effectiveUsername, userId],
          client
        );

        await client.query('COMMIT');
        successCount++;
        results.push({
          code: trimmedCode,
          success: true,
          prize: {
            ...updatedPrize,
            name: majorTiers.has(updatedPrize.tier) ? updatedPrize.name : '親筆簽名拍立得'
          },
          entryId
        });
      } catch (err) {
        console.error('Batch draw error for code:', trimmedCode, err);
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Rollback failed:', rollbackErr);
        }
        results.push({
          code: trimmedCode,
          success: false,
          error: '服務器錯誤，請重試'
        });
      }
    }

    // After processing all codes, update raffle remaining boxes once
    let remainingBoxes = raffle.remaining_boxes;
    if (successCount > 0) {
      const raffleUpdate = await dbQuery(
        `
          UPDATE raffles r
            SET remaining_boxes = GREATEST(r.total_boxes - x.entry_count, 0)
            FROM (
              SELECT COUNT(*)::INTEGER as entry_count
              FROM entries
              WHERE raffle_id = $1
            ) x
            WHERE r.id = $1
            RETURNING r.remaining_boxes
        `,
        [raffleId],
        client
      );

      if (raffleUpdate.rows.length > 0) {
        const finalRemaining = raffleUpdate.rows[0].remaining_boxes;
        remainingBoxes = finalRemaining;
        if (finalRemaining <= 0) {
          await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
        }
      }
    }

    await client.release();

    res.json({
      success: true,
      results,
      successCount,
      totalCodes: codes.length,
      remaining_boxes: remainingBoxes
    });
  } catch (err) {
    console.error('Batch draw fatal error:', err);
    try {
      await client.release();
    } catch (releaseErr) {
      console.error('Release failed:', releaseErr);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Admin Routes =====

// Admin login
app.get('/admin/login', (req, res) => {
  if (req.session.user?.is_admin) {
    return res.redirect('/admin');
  }
  res.render('login', { adminMode: true });
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await dbQuery('SELECT * FROM users WHERE username = $1 AND is_admin = 1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    const sessionUser = normalizeSessionUser(user);
    req.session.user = sessionUser;
    res.json({ success: true, user: sessionUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin', requireAdmin, async (req, res) => {
  const result = await dbQuery(`
    SELECT * FROM raffles
    ORDER BY created_at DESC
  `);
  res.render('admin/dashboard', { raffles: result.rows });
});

app.get('/admin/raffle/:id', requireAdmin, async (req, res) => {
  res.redirect(`/admin/raffles/${encodeURIComponent(req.params.id)}/edit`);
});

app.get('/admin/create', requireAdmin, (req, res) => {
  res.render('admin/create');
});

app.get('/admin/users', requireAdmin, (req, res) => {
  res.render('admin/users');
});

app.get('/admin/codes', requireAdmin, async (req, res) => {
  const result = await dbQuery('SELECT id FROM raffles ORDER BY created_at DESC LIMIT 1');
  if (result.rows.length === 0) {
    return res.redirect('/admin');
  }
  return res.redirect(`/admin/raffles/${result.rows[0].id}/codes`);
});

app.get('/admin/raffles/:id/edit', requireAdmin, async (req, res) => {
  const raffleId = parseInt(req.params.id);
  const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [raffleId]);
  if (raffleResult.rows.length === 0) {
    return res.status(404).send('抽獎活動不存在');
  }
  res.render('admin/edit', { raffle: raffleResult.rows[0] });
});

app.get('/admin/raffles/:id/codes', requireAdmin, async (req, res) => {
  const raffleId = parseInt(req.params.id);
  const raffleResult = await dbQuery('SELECT id, title FROM raffles WHERE id = $1', [raffleId]);
  if (raffleResult.rows.length === 0) {
    return res.status(404).send('抽獎活動不存在');
  }
  res.render('admin/codes', { raffleId, title: raffleResult.rows[0].title });
});

app.post('/api/admin/raffles/:id/reconcile-boxes', requireAdminApi, async (req, res) => {
  const client = await pool.connect();
  try {
    const raffleId = parseInt(req.params.id);
    if (!raffleId) {
      client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    await client.query('BEGIN');
    const updated = await dbQuery(
      `
        UPDATE raffles r
          SET remaining_boxes = GREATEST(r.total_boxes - x.entry_count, 0)
          FROM (
            SELECT COUNT(*)::INTEGER as entry_count
            FROM entries
            WHERE raffle_id = $1
          ) x
          WHERE r.id = $1
          RETURNING r.id, r.total_boxes, r.remaining_boxes, r.status
      `,
      [raffleId],
      client
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: '抽獎活動不存在' });
    }
    const row = updated.rows[0];
    if (row.remaining_boxes <= 0) {
      await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
    }
    await client.query('COMMIT');
    client.release();
    res.json({ success: true, raffle: row });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new raffle
app.post('/api/admin/raffles', requireAdminApi, multerUnlessJson, async (req, res) => {
  try {
    const {
      title,
      description,
      type = 'ichiban',
      total_boxes,
      price_per_box,
      num_pools = 1
    } = req.body;

    const result = await dbQuery(`
      INSERT INTO raffles (title, description, type, total_boxes, price_per_box, remaining_boxes, num_pools, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      title,
      description || null,
      type,
      parseInt(total_boxes),
      parseFloat(price_per_box),
      parseInt(total_boxes),
      parseInt(num_pools),
      req.session.user.id
    ]);

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/raffles/create', requireAdminApi, multerUnlessJson, async (req, res) => {
  try {
    const {
      title,
      description,
      type = 'ichiban',
      total_boxes,
      price_per_box,
      num_pools = 1,
      cover_image_url
    } = req.body;

    const result = await dbQuery(
      `
        INSERT INTO raffles (title, description, type, total_boxes, price_per_box, remaining_boxes, num_pools, created_by, cover_image)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `,
      [
        title,
        description || null,
        type,
        parseInt(total_boxes),
        parseFloat(price_per_box),
        parseInt(total_boxes),
        parseInt(num_pools),
        req.session.user.id,
        cover_image_url || null
      ]
    );

    res.json({ success: true, raffleId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add prize to raffle
app.post('/api/admin/raffles/:id/prizes', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const { tier, name, description, total_count, is_final, pool_number, image_url } = req.body;

    const result = await dbQuery(`
      INSERT INTO prizes (raffle_id, tier, name, description, total_count, remaining_count, is_final, pool_number, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      raffleId,
      tier,
      name,
      description || null,
      parseInt(total_count),
      parseInt(total_count),
      !!is_final,
      pool_number ? parseInt(pool_number) : null,
      image_url || null
    ]);

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/raffles/:id/items/add', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const { tier, name, description, total_count, is_final, pool_number, image_url } = req.body;

    const result = await dbQuery(
      `
        INSERT INTO prizes (raffle_id, tier, name, description, total_count, remaining_count, is_final, pool_number, image_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `,
      [
        raffleId,
        tier,
        name,
        description || null,
        parseInt(total_count),
        parseInt(total_count),
        !!is_final,
        pool_number ? parseInt(pool_number) : null,
        image_url || null
      ]
    );

    res.json({ success: true, itemId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/raffles/:raffleId/items/:itemId', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.raffleId);
    const prizeId = parseInt(req.params.itemId);
    const { tier, name, description, total_count, is_final, pool_number, image_url } = req.body;

    await dbQuery(
      `
        UPDATE prizes
          SET tier = $1, name = $2, description = $3, total_count = $4, is_final = $5, pool_number = $6, image_url = $7
          WHERE id = $8 AND raffle_id = $9
      `,
      [
        tier,
        name,
        description || null,
        parseInt(total_count),
        !!is_final,
        pool_number ? parseInt(pool_number) : null,
        image_url || null,
        prizeId,
        raffleId
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/raffles/:raffleId/items/:itemId', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.raffleId);
    const prizeId = parseInt(req.params.itemId);
    await dbQuery('DELETE FROM prizes WHERE id = $1 AND raffle_id = $2', [prizeId, raffleId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update prize
app.patch('/api/admin/raffles/:raffleId/prizes/:prizeId', requireAdminApi, async (req, res) => {
  try {
    const { raffleId, prizeId } = req.params;
    const { tier, name, description, total_count, remaining_count, is_final, pool_number, image_url } = req.body;

    await dbQuery(
      `
        UPDATE prizes
          SET tier = $1,
              name = $2,
              description = $3,
              total_count = $4,
              remaining_count = $5,
              is_final = $6,
              pool_number = $7,
              image_url = $8
          WHERE id = $9 AND raffle_id = $10
      `,
      [
        tier,
        name,
        description || null,
        parseInt(total_count),
        parseInt(remaining_count),
        !!is_final,
        pool_number ? parseInt(pool_number) : null,
        image_url || null,
        parseInt(prizeId),
        parseInt(raffleId)
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete prize
app.delete('/api/admin/raffles/:raffleId/prizes/:prizeId', requireAdminApi, async (req, res) => {
  try {
    const { raffleId, prizeId } = req.params;
    await dbQuery('DELETE FROM prizes WHERE id = $1 AND raffle_id = $2', [parseInt(prizeId), parseInt(raffleId)]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate verification codes for pre-allocation
app.post('/api/admin/raffles/:id/generate-codes', requireAdminApi, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const raffleId = parseInt(req.params.id);
    const { count } = req.body;

    const codes = [];
    for (let i = 0; i < parseInt(count); i++) {
      const code = crypto.randomBytes(8).toString('hex').toUpperCase();
      codes.push(code);
    }

    // Lock raffle to prevent concurrent code generation race conditions
    const raffleLock = await dbQuery('SELECT id FROM raffles WHERE id = $1 FOR UPDATE', [raffleId], client);
    if (raffleLock.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '活動不存在' });
    }

    // Get all prizes for this raffle, subtracting any ALREADY GENERATED BUT UNUSED codes
    const prizesResult = await dbQuery(
      `
        SELECT p.id, p.remaining_count, 
               COUNT(vc.id) as pending_codes
        FROM prizes p
        LEFT JOIN verification_codes vc ON p.id = vc.prize_id AND vc.used = false
        WHERE p.raffle_id = $1
        GROUP BY p.id, p.remaining_count
      `,
      [raffleId],
      client
    );

    const availablePrizes = [];
    for (const row of prizesResult.rows) {
      const realRemaining = parseInt(row.remaining_count) - parseInt(row.pending_codes);
      for (let i = 0; i < realRemaining; i++) {
        availablePrizes.push(row.id);
      }
    }

    if (availablePrizes.length < codes.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `剩餘獎項數量不足，淨係得 ${availablePrizes.length} 個空額，你要生成 ${codes.length} 個驗證碼`
      });
    }

    // Shuffle available prizes
    for (let i = availablePrizes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [availablePrizes[i], availablePrizes[j]] = [availablePrizes[j], availablePrizes[i]];
    }

    // Insert all codes
    for (let i = 0; i < codes.length; i++) {
      const prizeId = availablePrizes[i];
      await dbQuery(
        'INSERT INTO verification_codes (raffle_id, code, prize_id) VALUES ($1, $2, $3)',
        [raffleId, codes[i], prizeId],
        client
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      codes,
      generated: codes.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// List verification codes
app.get('/api/admin/raffles/:id/codes', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const result = await dbQuery(
      `
        SELECT
          vc.*,
          p.tier,
          p.name as prize_name,
          au.username as assigned_username,
          uu.username as used_username
        FROM verification_codes vc
        JOIN prizes p ON vc.prize_id = p.id
        LEFT JOIN users au ON vc.assigned_user_id = au.id
        LEFT JOIN users uu ON vc.user_id = uu.id
        WHERE vc.raffle_id = $1
        ORDER BY vc.created_at DESC
      `,
      [raffleId]
    );
    res.json({ codes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload cover image
app.post('/api/admin/raffles/:id/upload-cover', requireAdminApi, upload.single('image'), async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    if (!req.file) {
      return res.status(400).json({ error: '沒有上傳文件' });
    }

    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const localPath = path.join(uploadDir, filename);

    // Save locally (needs to be committed to git for Vercel)
    fs.writeFileSync(localPath, req.file.buffer);

    const imageUrl = `/uploads/${filename}`;
    await dbQuery('UPDATE raffles SET cover_image = $1 WHERE id = $2', [imageUrl, raffleId]);

    res.json({ success: true, url: imageUrl, filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

app.post('/api/admin/upload-image', requireAdminApi, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '沒有上傳文件' });
    }

    const ext = path.extname(req.file.originalname) || '.jpg';
    const key = `uploads/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

    try {
      const blob = await put(key, req.file.buffer, { access: 'public', contentType: req.file.mimetype });
      return res.json({ success: true, url: blob.url });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get entries for a raffle
app.get('/api/admin/raffles/:id/entries', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const result = await dbQuery(
      `
        SELECT e.*, p.tier, p.name as prize_name
        FROM entries e
        JOIN prizes p ON e.prize_id = p.id
        WHERE e.raffle_id = $1
        ORDER BY e.drawn_at DESC
      `,
      [raffleId]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update raffle status
app.patch('/api/admin/raffles/:id/status', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const { status } = req.body;
    await dbQuery('UPDATE raffles SET status = $1 WHERE id = $2', [status, raffleId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// User logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.post('/api/user/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get my entries for current user
app.get('/api/my/entries', requireAuthApi, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await dbQuery(
      `
        SELECT e.*, r.title as raffle_title, p.tier, p.name as prize_name, p.image_url as prize_image
        FROM entries e
        JOIN raffles r ON e.raffle_id = r.id
        JOIN prizes p ON e.prize_id = p.id
        WHERE e.user_id = $1
        ORDER BY e.drawn_at DESC
      `,
      [userId]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/my/entries/:id/redeem', requireAuthApi, async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const userId = req.session.user.id;

    const updated = await dbQuery(
      `
        UPDATE entries
          SET redeemed_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND redeemed_at IS NULL
          RETURNING id
      `,
      [entryId, userId]
    );

    if (updated.rows.length === 0) {
      return res.status(400).json({ error: '核銷失敗' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all raffles for admin
app.get('/api/admin/raffles', requireAdminApi, async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT * FROM raffles ORDER BY created_at DESC
    `);
    res.json({ raffles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update raffle
app.put('/api/admin/raffles/:id/update', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const { title, description, total_boxes, price_per_box, status, num_pools, cover_image } = req.body;

    await dbQuery(
      `
        UPDATE raffles
          SET title = $1,
              description = $2,
              total_boxes = $3,
              price_per_box = $4,
              status = $5,
              num_pools = $6,
              cover_image = $7
          WHERE id = $8
      `,
      [
        title,
        description || null,
        parseInt(total_boxes),
        parseFloat(price_per_box),
        status,
        num_pools ? parseInt(num_pools) : 1,
        cover_image || null,
        raffleId
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/raffles/:id', requireAdminApi, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    const { title, description, total_boxes, price_per_box, status, num_pools, cover_image } = req.body;

    await dbQuery(
      `
        UPDATE raffles
          SET title = $1, description = $2, total_boxes = $3, price_per_box = $4, status = $5, num_pools = $6, cover_image = $7
          WHERE id = $8
      `,
      [
        title,
        description || null,
        parseInt(total_boxes),
        parseFloat(price_per_box),
        status,
        parseInt(num_pools),
        cover_image || null,
        raffleId
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// For local development
if (!isVercel) {
  app.listen(port, () => {
    console.log(`Ichiban Kuji Raffle server running on http://localhost:${port}`);
  });
}

// For Vercel serverless
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Server error' });
  }
  res.status(500).send('Server error');
});

module.exports = app;
