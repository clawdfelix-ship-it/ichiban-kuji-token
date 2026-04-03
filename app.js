const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// Database setup
const db = new Database('./raffle.db');

// Create tables if not exists
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password_hash TEXT,
  is_admin INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS raffles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  type TEXT DEFAULT 'ichiban', -- 'ichiban' = 一番賞模式
  total_boxes INTEGER, -- 總盒數
  price_per_box REAL, -- 每盒價格
  remaining_boxes INTEGER, -- 剩餘盒數
  num_pools INTEGER DEFAULT 1, -- 獎池數量
  start_date DATETIME,
  end_date DATETIME,
  status TEXT DEFAULT 'active', -- active, closed, completed
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id INTEGER,
  tier TEXT, -- 獎級 (A, B, C, D, LAST)
  name TEXT, -- 獎品名稱
  description TEXT,
  image_url TEXT,
  total_count INTEGER, -- 總數
  remaining_count INTEGER, -- 剩餘數
  is_final BOOLEAN DEFAULT 0, -- 是否最終賞
  pool_number INTEGER NULL, -- 獎池編號(最終賞分池)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(raffle_id) REFERENCES raffles(id)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raffle_id INTEGER,
  prize_id INTEGER,
  buyer_name TEXT,
  buyer_contact TEXT,
  drawn_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(raffle_id) REFERENCES raffles(id),
  FOREIGN KEY(prize_id) REFERENCES prizes(id)
);

CREATE TABLE IF NOT EXISTS winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER,
  raffle_id INTEGER,
  prize_id INTEGER,
  buyer_name TEXT,
  drawn_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entry_id) REFERENCES entries(id),
  FOREIGN KEY(raffle_id) REFERENCES raffles(id),
  FOREIGN KEY(prize_id) REFERENCES prizes(id)
);
`);

// Check if we have any admin users, create default if none
(async function() {
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get().count;
  if (adminCount === 0) {
    const defaultPassword = await bcrypt.hash('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run('admin', defaultPassword, 1);
    console.log('Default admin user created: admin / admin123');
  }
})();

// Auth middleware
function requireAuth(req, res, next) {
  // Simple session-free auth for now
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireAdmin(req, res, next) {
  // TODO: Add proper session auth
  next();
}

// ===== Public Routes =====

// Home page - list all active raffles
app.get('/', (req, res) => {
  const raffles = db.prepare(`
    SELECT id, title, description, total_boxes, remaining_boxes, price_per_box, status
    FROM raffles
    WHERE status = 'active'
    ORDER BY created_at DESC
  `).all();
  
  res.render('index', { raffles });
});

// Raffle detail page - show remaining prizes
app.get('/raffle/:id', (req, res) => {
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(req.params.id);
  if (!raffle) {
    return res.status(404).send('抽獎活動不存在');
  }
  
  // Get all prizes grouped by tier
  const prizes = db.prepare(`
    SELECT * FROM prizes 
    WHERE raffle_id = ? 
    ORDER BY pool_number, is_final DESC, tier
  `).all(req.params.id);
  
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
  const winners = db.prepare(`
    SELECT w.*, p.name as prize_name, p.tier as prize_tier
    FROM winners w
    JOIN prizes p ON w.prize_id = p.id
    WHERE w.raffle_id = ?
    ORDER BY w.drawn_at DESC
    LIMIT 20
  `).all(req.params.id);
  
  const remainingCount = raffle.remaining_boxes;
  
  res.render('raffle', { 
    raffle, 
    pools, 
    winners, 
    remainingCount 
  });
});

// API: Get remaining prize counts
app.get('/api/raffle/:id/prizes', (req, res) => {
  const prizes = db.prepare(`
    SELECT id, tier, name, remaining_count, total_count, is_final, pool_number
    FROM prizes
    WHERE raffle_id = ?
    ORDER BY pool_number, is_final DESC, tier
  `).all(req.params.id);
  
  res.json({ prizes });
});

// API: Get recent winners
app.get('/api/raffle/:id/winners', (req, res) => {
  const winners = db.prepare(`
    SELECT w.*, p.name as prize_name, p.tier as prize_tier
    FROM winners w
    JOIN prizes p ON w.prize_id = p.id
    WHERE w.raffle_id = ?
    ORDER BY w.drawn_at DESC
    LIMIT 20
  `).all(req.params.id);
  
  res.json({ winners });
});

// Draw prize endpoint
app.post('/api/raffle/:id/draw', (req, res) => {
  const { name, contact } = req.body;
  const raffleId = req.params.id;
  
  // Check raffle is active and has remaining boxes
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return res.status(400).json({ error: '抽獎活動已關閉' });
  }
  if (raffle.remaining_boxes <= 0) {
    return res.status(400).json({ error: '所有盒子已經抽完' });
  }
  
  // Get all prizes that still have remaining count
  const availablePrizes = db.prepare(`
    SELECT * FROM prizes
    WHERE raffle_id = ? AND remaining_count > 0
    ORDER BY is_final ASC -- 非最終賞先抽，最後抽最終賞
  `).all(raffleId);
  
  if (availablePrizes.length === 0) {
    return res.status(400).json({ error: '沒有剩餘獎品了' });
  }
  
  // Weighted random selection based on remaining count
  // Each remaining prize has equal chance
  const weighted = [];
  for (const prize of availablePrizes) {
    for (let i = 0; i < prize.remaining_count; i++) {
      weighted.push(prize);
    }
  }
  
  const randomIndex = Math.floor(Math.random() * weighted.length);
  const drawnPrize = weighted[randomIndex];
  
  // Start transaction
  const transaction = db.transaction(() => {
    // Decrease remaining count for the prize
    db.prepare(`
      UPDATE prizes 
      SET remaining_count = remaining_count - 1 
      WHERE id = ?
    `).run(drawnPrize.id);
    
    // Decrease remaining boxes for the raffle
    db.prepare(`
      UPDATE raffles 
      SET remaining_boxes = remaining_boxes - 1 
      WHERE id = ?
    `).run(raffleId);
    
    // If no boxes left, mark raffle as completed
    if (raffle.remaining_boxes - 1 <= 0) {
      db.prepare(`
        UPDATE raffles 
        SET status = 'completed' 
        WHERE id = ?
      `).run(raffleId);
    }
    
    // Create entry
    const result = db.prepare(`
      INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact)
      VALUES (?, ?, ?, ?)
    `).run(raffleId, drawnPrize.id, name, contact);
    
    // Record winner
    db.prepare(`
      INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name)
      VALUES (?, ?, ?, ?)
    `).run(result.lastInsertRowid, raffleId, drawnPrize.id, name);
    
    return result.lastInsertRowid;
  });
  
  const entryId = transaction();
  
  // Get updated prize info
  const updatedPrize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(drawnPrize.id);
  
  res.json({
    success: true,
    entryId,
    prize: {
      id: updatedPrize.id,
      name: updatedPrize.name,
      tier: updatedPrize.tier,
      description: updatedPrize.description,
      image_url: updatedPrize.image_url,
      is_final: updatedPrize.is_final
    },
    remaining_boxes: raffle.remaining_boxes - 1
  });
});

// ===== Admin Routes =====

// Admin dashboard
app.get('/admin', (req, res) => {
  const raffles = db.prepare(`
    SELECT * FROM raffles 
    ORDER BY created_at DESC
  `).all();
  
  res.render('admin/dashboard', { raffles });
});

// Create raffle page
app.get('/admin/create', (req, res) => {
  res.render('admin/create');
});

// Create raffle API
app.post('/api/admin/raffles/create', (req, res) => {
  const { 
    title, 
    description, 
    total_boxes, 
    price_per_box, 
    num_pools,
    start_date,
    end_date 
  } = req.body;
  
  const result = db.prepare(`
    INSERT INTO raffles (
      title, description, type, total_boxes, price_per_box, 
      remaining_boxes, num_pools, start_date, end_date, status
    ) VALUES (?, ?, 'ichiban', ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    title, 
    description, 
    parseInt(total_boxes), 
    parseFloat(price_per_box), 
    parseInt(total_boxes), 
    parseInt(num_pools || 1),
    start_date || null,
    end_date || null
  );
  
  res.json({ 
    success: true, 
    raffleId: result.lastInsertRowid 
  });
});

// Add prize to raffle
app.post('/api/admin/raffles/:id/prizes/add', (req, res) => {
  const { 
    tier, 
    name, 
    description, 
    image_url, 
    total_count,
    is_final,
    pool_number 
  } = req.body;
  
  const raffleId = req.params.id;
  
  const result = db.prepare(`
    INSERT INTO prizes (
      raffle_id, tier, name, description, image_url, 
      total_count, remaining_count, is_final, pool_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(raffleId),
    tier,
    name,
    description || null,
    image_url || null,
    parseInt(total_count),
    parseInt(total_count),
    is_final ? 1 : 0,
    is_final ? (parseInt(pool_number) || 1) : null
  );
  
  res.json({ 
    success: true, 
    prizeId: result.lastInsertRowid 
  });
});

// Get raffle with prizes for admin editing
app.get('/api/admin/raffles/:id', (req, res) => {
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(req.params.id);
  const prizes = db.prepare('SELECT * FROM prizes WHERE raffle_id = ? ORDER BY pool_number, is_final DESC, tier').all(req.params.id);
  
  res.json({ raffle, prizes });
});

// Delete prize
app.delete('/api/admin/raffles/:raffleId/prizes/:prizeId', (req, res) => {
  db.prepare('DELETE FROM prizes WHERE id = ? AND raffle_id = ?').run(
    req.params.prizeId, 
    req.params.raffleId
  );
  
  res.json({ success: true });
});

// Close/reopen raffle
app.post('/api/admin/raffles/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE raffles SET status = ? WHERE id = ?').run(status, req.params.id);
  
  res.json({ success: true });
});

// Start server
app.listen(port, () => {
  console.log(`Ichiban Kuji Raffle Server running on port ${port}`);
  console.log(`- Public: http://localhost:${port}`);
  console.log(`- Admin: http://localhost:${port}/admin`);
  console.log(`- Default admin: admin / admin123`);
});
