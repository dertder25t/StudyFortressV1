// A simple, UNIFIED backend for the Study App.
// This single file acts as BOTH the API server and the web server.
// NO NGINX NEEDED.


const express = require('express');
const path = require('path'); // Core Node.js module for working with file paths
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'xk2/d}dfIM?H}6FD`+tQ%>XLkYoQ&=Zs4x8g1wmwrE£[ldx-F#'; 
const SALT_ROUNDS = 10;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- NEW PART: SERVE THE FRONTEND ---
// This tells Express to serve any static files (like .html, .css, .js)
// from the 'public' directory.
app.use(express.static(path.join(__dirname, 'public')));


let db;

// --- DATABASE SETUP ---
async function initializeDatabase() {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  });
  console.log('Connected to the SQLite database.');

  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile (
        userId INTEGER PRIMARY KEY,
        username TEXT,
        bio TEXT,
        avatarUrl TEXT,
        apiKey TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rewards (
        userId INTEGER PRIMARY KEY,
        points INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        lastStudied TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        folderId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        cardCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        folderId TEXT NOT NULL,
        noteId TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        source TEXT NOT NULL,
        ease REAL NOT NULL,
        interval INTEGER NOT NULL,
        dueDate TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE
    );
  `);
}

// --- AUTHENTICATION MIDDLEWARE ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <TOKEN>
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// --- API ENDPOINTS ---

// AUTH
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, password_hash]);
        const userId = result.lastID;
        const username = email.split('@')[0];
        await db.run('INSERT INTO profile (userId, username, avatarUrl) VALUES (?, ?, ?)', [userId, username, `https://placehold.co/100x100/1e293b/94a3b8?text=${username.charAt(0).toUpperCase()}`]);
        await db.run('INSERT INTO rewards (userId, points, streak) VALUES (?, 0, 0)', [userId]);
        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
            res.status(409).json({ error: 'This email is already registered.' });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
        const accessToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ accessToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET all data
app.get('/api/all-data', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const profile = await db.get('SELECT * FROM profile WHERE userId = ?', userId);
    const rewards = await db.get('SELECT * FROM rewards WHERE userId = ?', userId);
    const folders = await db.all('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notes = await db.all('SELECT * FROM notes WHERE userId = ? ORDER BY createdAt DESC', userId);
    const cards = await db.all('SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notesByFolder = notes.reduce((acc, note) => { (acc[note.folderId] = acc[note.folderId] || []).push(note); return acc; }, {});
    const cardsByFolder = cards.reduce((acc, card) => { (acc[card.folderId] = acc[card.folderId] || []).push(card); return acc; }, {});
    res.json({ profile, rewards, folders, notesByFolder, cardsByFolder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Other API routes (profile, rewards, folders, notes, cards) are the same...
// They are all protected by the `authenticateToken` middleware.

app.post('/api/profile', authenticateToken, async (req, res) => {
  const { username, bio, avatarUrl, apiKey } = req.body;
  const userId = req.user.id;
  try {
    await db.run('UPDATE profile SET username = ?, bio = ?, avatarUrl = ?, apiKey = ? WHERE userId = ?', [username, bio, avatarUrl, apiKey, userId]);
    const updatedProfile = await db.get('SELECT * FROM profile WHERE userId = ?', userId);
    res.json(updatedProfile);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/rewards', authenticateToken, async (req, res) => {
    const { points, streak, lastStudied } = req.body;
    const userId = req.user.id;
    try {
        await db.run('UPDATE rewards SET points = ?, streak = ?, lastStudied = ? WHERE userId = ?', [points, streak, lastStudied, userId]);
        const updatedRewards = await db.get('SELECT * FROM rewards WHERE userId = ?', userId);
        res.json(updatedRewards);
    } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/folders', authenticateToken, async (req, res) => {
    const { id, name, description, color } = req.body;
    const userId = req.user.id;
    try {
        if (id) {
            await db.run('UPDATE folders SET name = ?, description = ?, color = ? WHERE id = ? AND userId = ?', [name, description, color, id, userId]);
            res.json({ id, name, description, color });
        } else {
            const newId = `folder_${crypto.randomUUID()}`;
            await db.run('INSERT INTO folders (id, userId, name, description, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [newId, userId, name, description, color, new Date().toISOString()]);
            res.status(201).json({ id: newId, name, description, color });
        }
    } catch(err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/folders/:id', authenticateToken, async (req, res) => {
    try {
        await db.run('DELETE FROM folders WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
        res.status(204).send();
    } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/notes', authenticateToken, async (req, res) => {
    const { folderId, noteId, title, content, cards } = req.body;
    const userId = req.user.id;
    try {
        let finalNoteId = noteId;
        if(noteId) {
            await db.run('UPDATE notes SET title = ?, content = ?, cardCount = ? WHERE id = ? AND userId = ?', [title, content, cards.length, noteId, userId]);
        } else {
            finalNoteId = `note_${crypto.randomUUID()}`;
            await db.run('INSERT INTO notes (id, userId, folderId, title, content, cardCount, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [finalNoteId, userId, folderId, title, content, cards.length, new Date().toISOString()]);
        }
        await db.run('DELETE FROM cards WHERE noteId = ? AND userId = ?', [finalNoteId, userId]);
        const stmt = await db.prepare('INSERT INTO cards (id, userId, folderId, noteId, question, answer, source, ease, interval, dueDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const card of cards) {
            await stmt.run(`card_${crypto.randomUUID()}`, userId, folderId, finalNoteId, card.question, card.answer, card.source, card.srs.ease, card.srs.interval, card.srs.dueDate, card.createdAt);
        }
        await stmt.finalize();
        res.status(201).json({ message: 'Note and cards saved' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/notes/:id', authenticateToken, async (req, res) => {
    try {
        await db.run('DELETE FROM notes WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/manual-cards', authenticateToken, async (req, res) => {
    const { folderId, cards } = req.body;
    const userId = req.user.id;
    try {
        const stmt = await db.prepare('INSERT INTO cards (id, userId, folderId, noteId, question, answer, source, ease, interval, dueDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const card of cards) {
            await stmt.run(`card_${crypto.randomUUID()}`, userId, folderId, null, card.question, card.answer, 'manual', card.srs.ease, card.srs.interval, card.srs.dueDate, card.createdAt);
        }
        await stmt.finalize();
        res.status(201).json({ message: 'Cards saved' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/cards/:id', authenticateToken, async (req, res) => {
    const { srs } = req.body;
    try {
        await db.run('UPDATE cards SET ease = ?, interval = ?, dueDate = ? WHERE id = ? AND userId = ?', [srs.ease, srs.interval, srs.dueDate, req.params.id, req.user.id]);
        res.json({ message: 'Card updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/cards/:id', authenticateToken, async (req, res) => {
    try {
        await db.run('DELETE FROM cards WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- SERVER STARTUP ---
app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`Server is running!`);
  console.log(`Access your app at http://localhost:${PORT}`);
});
