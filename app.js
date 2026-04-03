const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.Port || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Database setup
const db = new sqlite3.Database('./raffle.db', (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Create tables if not exists
db.serialize(() => {
  db.run(`
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
    type TEXT DEFAULT 'single', -- 'single' = 傳統抽獎( one prize, many entrants ), 'ichiban' = 一番賞( multiple prizes, one entry = one prize )
    total_boxes INTEGER, -- 總盒數 (一番賞)
    remaining_boxes INTEGER, -- 剩餘盒數
    start_date DATETIME,
    end_date DATETIME,
    status TEXT DEFAULT 'active',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    drawn_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    tier TEXT, -- A B C D 獎級
    name TEXT, -- 獎品名稱
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
    name TEXT,
    contact TEXT,
    won_prize_id INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(raffle_id) REFERENCES raffles(id),
    FOREIGN KEY(won_prize_id) REFERENCES prizes(id)
  );

  CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    entry_id INTEGER,
    prize_id INTEGER,
    drawn_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(raffle_id) REFERENCES raffles(id),
    FOREIGN KEY(entry_id) REFERENCES entries(id),
    FOREIGN KEY(prize_id) REFERENCES prizes(id)
  );
);
});

// Create default admin if not exists
db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', [], (err, row) => {
  if (err) {
    console.error('Error checking admin count', err);
    return;
  }
  const adminCount = row.count;
  if (adminCount === 0) {
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    const passwordHash = bcrypt.hashSync(defaultPassword, 10);
    db.run('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)', ['admin', passwordHash, 1], (err) => {
      if (!err) {
        console.log('Created default admin user: admin / ' + defaultPassword);
        console.log('⚠️  Change this password in production!');
      }
    });
  }
});

// Auth middleware
function requireAdmin(req, res, next) {
  // Simple session-free auth for admin - uses password from body/query
  const adminPassword = req.body.admin_password || req.query.admin_password;
  if (!adminPassword) {
    return res.status(401).json({ error: 'Admin password required' });
  }
  db.get('SELECT * FROM users WHERE username = ?', ['admin'], (err, admin) => {
    if (err || !admin) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    if (!bcrypt.compareSync(adminPassword, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    req.admin = admin;
    next();
  });
}

// API Routes

// Get all active raffles
app.get('/api/raffles', (req, res) => {
  db.all(`
    SELECT id, title, description, type, total_boxes, remaining_boxes, start_date, end_date 
    FROM raffles 
    WHERE status = 'active'
    ORDER BY created_at DESC
  `, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Add prize stats for ichiban
    const result = Promise.all(rows.map(r => {
      return new Promise((resolve) => {
        if (r.type !== 'ichiban') {
          return resolve(r);
        }
        db.all(`
          SELECT tier, COUNT(*) as total, SUM(remaining_count) as remaining 
          FROM prizes 
          WHERE raffle_id = ? 
          GROUP BY tier
          ORDER BY tier
        `, [r.id], (err, prizeStats) => {
          if (err) {
            resolve(r);
          } else {
            resolve({
              ...r,
              prize_stats: prizeStats
            });
          }
        });
      });
    });

    Promise.all(result).then(rows => {
      res.json({ raffles: rows });
    });
  });
});

// Get single raffle
app.get('/api/raffles/:id', (req, res) => {
  db.get('SELECT * FROM raffles WHERE id = ?', [req.params.id], (err, raffle) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!raffle) {
      return res.status(404).json({ error: 'Raffle not found' });
    }

    db.get('SELECT COUNT(*) as count FROM entries WHERE raffle_id = ?', [req.params.id], (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      let prizes = null;
      if (raffle.type === 'ichiban') {
        db.all('SELECT * FROM prizes WHERE raffle_id = ? ORDER BY tier, is_final DESC', [req.params.id], (err, prizeList) => {
          res.json({
            raffle,
            entry_count: row.count,
            prizes: prizeList
          });
        });
      } else {
        res.json({
          raffle,
          entry_count: row.count
        });
      }
    });
  });
});

// Enter raffle / draw for ichiban
app.post('/api/raffles/:id/enter', (req, res) => {
  const { name, contact } = req.body;
  const raffleId = req.params.id;

  if (!name || !contact) {
    return res.status(400).json({ error: 'Name and contact are required' });
  }

  db.get('SELECT * FROM raffles WHERE id = ?', [raffleId], (err, raffle) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!raffle) {
      return res.status(404).json({ error: 'Raffle not found' });
    }

    if (raffle.status !== 'active') {
      return res.status(400).json({ error: 'This raffle is closed' });
    }

    // Traditional single prize raffle
    if (raffle.type !== 'ichiban') {
      db.run('INSERT INTO entries (raffle_id, name, contact) VALUES (?, ?, ?)', [raffleId, name, contact], function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, entry_id: this.lastID });
      });
      return;
    }

    // Ichiban Kuji raffle - draw prize immediately
    if (raffle.remaining_boxes <= 0) {
      return res.status(400).json({ error: 'All boxes are sold out' });
    }

    // Get all available prizes (remaining_count > 0)
    db.all('SELECT * FROM prizes WHERE raffle_id = ? AND remaining_count > 0 ORDER BY RANDOM()', [raffleId], (err, availablePrizes) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (availablePrizes.length === 0) {
        return res.status(400).json({ error: 'No prizes left' });
      }

      // Weighted random pick - more remaining = higher chance
      const totalWeight = availablePrizes.reduce((sum, p) => sum + p.remaining_count, 0);
      let random = Math.floor(Math.random() * totalWeight);
      let picked = null;

      for (const prize of availablePrizes) {
        random -= prize.remaining_count;
        if (random <= 0) {
          picked = prize;
          break;
        }
      }

      if (!picked) {
        picked = availablePrizes[availablePrizes.length - 1];
      }

      // Insert entry with prize
      db.run('INSERT INTO entries (raffle_id, name, contact, won_prize_id) VALUES (?, ?, ?, ?)', [raffleId, name, contact, picked.id], function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        // Decrement remaining count
        db.run('UPDATE prizes SET remaining_count = remaining_count - 1 WHERE id = ?', [picked.id], (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          // Decrement remaining boxes
          db.run('UPDATE raffles SET remaining_boxes = remaining_boxes - 1 WHERE id = ?', [raffleId], (err) => {
            if (err) {
              return res.status(500).json({ error: err.message });
            }

            // Check if all boxes gone - close raffle
            const newRemaining = raffle.remaining_boxes - 1;
            if (newRemaining <= 0) {
              db.run('UPDATE raffles SET status = "completed" WHERE id = ?', [raffleId]);
            }

            res.json({
              success: true,
              entry_id: this.lastID,
              prize: {
                id: picked.id,
                tier: picked.tier,
                name: picked.name,
                is_final: picked.is_final === 1,
                pool_number: picked.pool_number
              },
              remaining_boxes: newRemaining
            });
          });
        });
      });
    });
  });
});

// Get raffle results
app.get('/api/raffles/:id/results', (req, res) => {
  const raffleId = req.params.id;
  db.get('SELECT * FROM raffles WHERE id = ?', [raffleId], (err, raffle) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!raffle) {
      return res.status(404).json({ error: 'Raffle not found' });
    }

    if (raffle.status === 'active') {
      return res.status(400).json({ error: 'Results not available yet' });
    }

    // Get all entries with prizes
    db.all(`
      SELECT e.id, e.name, e.contact, p.tier, p.name as prize_name, p.is_final, e.created_at
      FROM entries e
      LEFT JOIN prizes p ON e.won_prize_id = p.id
      WHERE e.raffle_id = ?
      ORDER BY e.created_at
    `, [raffleId], (err, entries) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      db.get('SELECT COUNT(*) as total FROM entries WHERE raffle_id = ?', [raffleId], (err, row) => {
        res.json({
          raffle,
          entries,
          total_entries: row.count
        });
      });
    });
  });
});

// Admin: get all raffles
app.get('/api/admin/raffles', requireAdmin, (req, res) => {
  db.all(`
    SELECT id, title, description, type, total_boxes, remaining_boxes, status, start_date, end_date, created_at
    FROM raffles 
    ORDER BY created_at DESC
  `, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const result = rows.map(r => {
      return new Promise((resolve) => {
        db.get('SELECT COUNT(*) as count FROM entries WHERE raffle_id = ?', [r.id], (err, row) => {
          if (err) {
            resolve({ ...r, entry_count: 0 });
          } else {
            resolve({ ...r, entry_count: row.count });
          }
        });
      });
    });

    Promise.all(result).then(rows => {
      res.json({ raffles: rows });
    });
  });
});

// Admin: create raffle
app.post('/api/admin/raffles/create', requireAdmin, (req, res) => {
  const { title, description, type = 'single', total_boxes, prizes } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  // Traditional single prize raffle
  if (type !== 'ichiban') {
    const { prize, start_date, end_date } = req.body;
    if (!prize || !end_date) {
      return res.status(400).json({ error: 'Prize and end date are required' });
    }

    db.run(`
      INSERT INTO raffles (title, description, type, total_boxes, remaining_boxes, start_date, end_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [title, description, type, total_boxes, total_boxes, start_date, end_date, req.admin.id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID });
    });
    return;
  }

  // Ichiban Kuji creation
  if (!total_boxes || !prizes || !Array.isArray(prizes) || prizes.length === 0) {
    return res.status(400).json({ error: 'Total boxes and prizes array are required' });
  }

  // Insert raffle first
  db.run(`
    INSERT INTO raffles (title, description, type, total_boxes, remaining_boxes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [title, description, type, total_boxes, total_boxes, req.admin.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const raffleId = this.lastID;

    // Insert all prizes
    let inserted = 0;
    for (const prize of prizes) {
      db.run(`
        INSERT INTO prizes (raffle_id, tier, name, total_count, remaining_count, is_final, pool_number)
          VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        raffleId,
        prize.tier || 'A',
        prize.name,
        prize.count,
        prize.count,
        prize.is_final ? 1 : 0,
        prize.pool_number || null
      ], (err) => {
        if (!err) inserted++;
      });
    }

    res.json({
      success: true,
      id: raffleId,
      total_boxes,
      total_prizes: inserted
    });
  });
});

// Admin: draw winners (for traditional raffle)
app.post('/api/admin/raffles/:id/draw', requireAdmin, (req, res) => {
  const { number_of_winners = 1 } = req.body;
  const raffleId = req.params.id;

  db.get('SELECT * FROM raffles WHERE id = ?', [raffleId], (err, raffle) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!raffle) {
      return res.status(404).json({ error: 'Raffle not found' });
    }

    db.all('SELECT * FROM entries WHERE raffle_id = ?', [raffleId], (err, entries) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (entries.length === 0) {
        return res.status(400).json({ error: 'No entries to draw from' });
      }

      // Shuffle and pick winners (Fisher-Yates)
      const shuffled = [...entries];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const winners = shuffled.slice(0, Math.min(number_of_winners, shuffled.length));

      // Save winners
      let saved = 0;
      for (const winner of winners) {
        db.run(`
          INSERT INTO winners (raffle_id, entry_id, prize_id)
            VALUES (?, ?, ?)
        `, [raffleId, winner.id, winner.won_prize_id], (err) => {
          if (!err) saved++;
        });
      }

      // Mark raffle as completed
      db.run('UPDATE raffles SET status = "completed", drawn_at = CURRENT_TIMESTAMP WHERE id = ?', [raffleId], (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({
          success: true,
          total_winners: saved,
          winners: winners.map(w => ({
            id: w.id,
            name: w.name,
            contact: w.contact
          }))
        });
      });
    });
  });
});

// Start server
app.listen(port, () => {
  console.log(`🎫 Raffle website running on http://localhost:${port}`);
  console.log(`🔐 Admin default: admin / ${process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'}`);
});
