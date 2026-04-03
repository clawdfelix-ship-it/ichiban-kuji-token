const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// Database setup
const db = new sqlite3.Database('./raffle.db', (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

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
`, (err) => {
  if (err) {
    console.error('Error creating tables', err);
  }
});

// Check if we have any admin users, create default if none
db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, row) => {
  if (err) {
    console.error(err);
    return;
  }
  if (row.count === 0) {
    bcrypt.hash('admin123', 10, (err, hash) => {
      if (err) {
        console.error(err);
        return;
      }
      db.run('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)', ['admin', hash, 1], (err) => {
        if (!err) {
          console.log('Default admin user created: admin / admin123');
        }
      });
    });
  }
});

// Promisify database methods for cleaner code
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastInsertRowid: this.lastID });
    });
  });
}

// ===== Public Routes =====

// Home page - list all active raffles
app.get('/', async (req, res) => {
  try {
    const raffles = await dbAll(`
      SELECT id, title, description, total_boxes, remaining_boxes, price_per_box, status
      FROM raffles
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);
    res.render('index', { raffles });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Raffle detail page - show remaining prizes
app.get('/raffle/:id', async (req, res) => {
  try {
    const raffle = await dbGet('SELECT * FROM raffles WHERE id = ?', [req.params.id]);
    if (!raffle) {
      return res.status(404).send('抽獎活動不存在');
    }
    
    // Get all prizes grouped by tier
    const prizes = await dbAll(`
      SELECT * FROM prizes 
      WHERE raffle_id = ? 
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    
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
    const winners = await dbAll(`
      SELECT w.*, p.name as prize_name, p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = ?
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);
    
    const remainingCount = raffle.remaining_boxes;
    
    res.render('raffle', { 
      raffle, 
      pools, 
      winners, 
      remainingCount 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// API: Get remaining prize counts
app.get('/api/raffle/:id/prizes', async (req, res) => {
  try {
    const prizes = await dbAll(`
      SELECT id, tier, name, remaining_count, total_count, is_final, pool_number
      FROM prizes
      WHERE raffle_id = ?
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    
    res.json({ prizes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get recent winners
app.get('/api/raffle/:id/winners', async (req, res) => {
  try {
    const winners = await dbAll(`
      SELECT w.*, p.name as prize_name, p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = ?
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);
    
    res.json({ winners });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Draw prize endpoint
app.post('/api/raffle/:id/draw', async (req, res) => {
  try {
    const { name, contact } = req.body;
    const raffleId = req.params.id;
    
    // Check raffle is active and has remaining boxes
    const raffle = await dbGet('SELECT * FROM raffles WHERE id = ?', [raffleId]);
    if (!raffle || raffle.status !== 'active') {
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }
    if (raffle.remaining_boxes <= 0) {
      return res.status(400).json({ error: '所有盒子已經抽完' });
    }
    
    // Get all prizes that still have remaining count
    const availablePrizes = await dbAll(`
      SELECT * FROM prizes
      WHERE raffle_id = ? AND remaining_count > 0
      ORDER BY is_final ASC -- 非最終賞先抽，最後抽最終賞
    `, [raffleId]);
    
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
    
    // Use serialize to run sequentially
    await new Promise((resolve, reject) => {
      db.serialize(async () => {
        try {
          // Decrease remaining count for the prize
          await dbRun(`
            UPDATE prizes 
            SET remaining_count = remaining_count - 1 
            WHERE id = ?
          `, [drawnPrize.id]);
          
          // Decrease remaining boxes for the raffle
          await dbRun(`
            UPDATE raffles 
            SET remaining_boxes = remaining_boxes - 1 
            WHERE id = ?
          `, [raffleId]);
          
          // If no boxes left, mark raffle as completed
          if (raffle.remaining_boxes - 1 <= 0) {
            await dbRun(`
              UPDATE raffles 
              SET status = 'completed' 
              WHERE id = ?
            `, [raffleId]);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    
    // Create entry
    const entryResult = await dbRun(`
      INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact)
      VALUES (?, ?, ?, ?)
    `, [raffleId, drawnPrize.id, name, contact]);
    
    // Record winner
    await dbRun(`
      INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name)
      VALUES (?, ?, ?, ?)
    `, [entryResult.lastInsertRowid, raffleId, drawnPrize.id, name]);
    
    // Get updated prize info
    const updatedPrize = await dbGet('SELECT * FROM prizes WHERE id = ?', [drawnPrize.id]);
    
    res.json({
      success: true,
      entryId: entryResult.lastInsertRowid,
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Admin Routes =====

// Admin dashboard
app.get('/admin', async (req, res) => {
  try {
    const raffles = await dbAll(`
      SELECT * FROM raffles 
      ORDER BY created_at DESC
    `);
    res.render('admin/dashboard', { raffles });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Create raffle page
app.get('/admin/create', (req, res) => {
  res.render('admin/create');
});

// Create raffle API
app.post('/api/admin/raffles/create', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      total_boxes, 
      price_per_box, 
      num_pools,
      start_date,
      end_date 
    } = req.body;
    
    const result = await dbRun(`
      INSERT INTO raffles (
        title, description, type, total_boxes, price_per_box, 
        remaining_boxes, num_pools, start_date, end_date, status
      ) VALUES (?, ?, 'ichiban', ?, ?, ?, ?, ?, ?, 'active')
    `, [
      title, 
      description, 
      parseInt(total_boxes), 
      parseFloat(price_per_box), 
      parseInt(total_boxes), 
      parseInt(num_pools || 1),
      start_date || null,
      end_date || null
    ]);
    
    res.json({ 
      success: true, 
      raffleId: result.lastInsertRowid 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add prize to raffle
app.post('/api/admin/raffles/:id/prizes/add', async (req, res) => {
  try {
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
    
    const result = await dbRun(`
      INSERT INTO prizes (
        raffle_id, tier, name, description, image_url, 
        total_count, remaining_count, is_final, pool_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      parseInt(raffleId),
      tier,
      name,
      description || null,
      image_url || null,
      parseInt(total_count),
      parseInt(total_count),
      is_final ? 1 : 0,
      is_final ? (parseInt(pool_number) || 1) : null
    ]);
    
    res.json({ 
      success: true, 
      prizeId: result.lastInsertRowid 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get raffle with prizes for admin editing
app.get('/api/admin/raffles/:id', async (req, res) => {
  try {
    const raffle = await dbGet('SELECT * FROM raffles WHERE id = ?', [req.params.id]);
    const prizes = await dbAll('SELECT * FROM prizes WHERE raffle_id = ? ORDER BY pool_number, is_final DESC, tier', [req.params.id]);
    
    res.json({ raffle, prizes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete prize
app.delete('/api/admin/raffles/:raffleId/prizes/:prizeId', async (req, res) => {
  try {
    await dbRun('DELETE FROM prizes WHERE id = ? AND raffle_id = ?', [
      req.params.prizeId, 
      req.params.raffleId
    ]);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Close/reopen raffle
app.post('/api/admin/raffles/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await dbRun('UPDATE raffles SET status = ? WHERE id = ?', [status, req.params.id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Ichiban Kuji Raffle Server running on port ${port}`);
  console.log(`- Public: http://localhost:${port}`);
  console.log(`- Admin: http://localhost:${port}/admin`);
  console.log(`- Default admin: admin / admin123`);
});
