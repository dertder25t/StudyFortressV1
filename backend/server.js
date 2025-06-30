
const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const { exec } = require('child_process');
const { HfInference } = require('@huggingface/inference');
const { OpenAI } = require('openai');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'your-super-secret-key-that-you-should-change';
const SALT_ROUNDS = 10;
const APP_DIR = '/opt/StudyFortressV1';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomUUID();
        cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage: storage });

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR)); // Serve uploaded files statically

let db;

// --- DATABASE SETUP ---
async function initializeDatabase() {
  try {
    db = await open({ filename: './database.db', driver: sqlite3.Database });
    console.log('Connected to the SQLite database.');
    await db.exec('PRAGMA foreign_keys = ON;');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, isAdmin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS profile (userId INTEGER PRIMARY KEY, username TEXT, bio TEXT, avatarUrl TEXT, googleApiKey TEXT, openaiApiKey TEXT, huggingfaceApiKey TEXT, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rewards (userId INTEGER PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, lastStudied TEXT, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, color TEXT, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, title TEXT NOT NULL, content TEXT, cardCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, noteId TEXT, question TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL, ease REAL NOT NULL, interval INTEGER NOT NULL, dueDate TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS audio_clips (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, noteId TEXT NOT NULL, originalName TEXT NOT NULL, serverPath TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE);
    `);
  } catch (error) {
    console.error("FATAL: Failed to initialize database:", error);
    process.exit(1);
  }
}

// --- MIDDLEWARE & HELPERS ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) { console.error("JWT Verification Error:", err); return res.sendStatus(403); }
        req.user = user;
        next();
    });
}
async function checkAdmin(req, res, next) {
    try {
        const user = await db.get('SELECT isAdmin FROM users WHERE id = ?', req.user.id);
        if (user && user.isAdmin === 1) {
            next();
        } else {
            res.status(403).json({ error: "Forbidden: Admin access required."});
        }
    } catch (err) {
        res.status(500).json({ error: "Error verifying admin status."});
    }
}

// --- AI HELPERS ---
const subpointsPrompt = (text) => `Analyze the following text and generate a concise list of the main subpoints or topics discussed. Return ONLY a JSON array of strings, where each string is a subpoint. Example: ["Subpoint one", "Second key idea", "Final conclusion"].\n\nText: """${text}"""`;
const keywordsPrompt = (text) => `Analyze the following text and extract the most important keywords and key phrases (2-4 words long). Return ONLY a JSON array of strings. Example: ["machine learning", "neural networks", "data processing"].\n\nText: """${text}"""`;
const flashcardPrompt = (text) => `Based on the following notes, generate a list of question and answer flashcards. Provide at least 5 flashcards if possible. The questions should be clear and the answers concise. Notes: --- ${text} --- Return ONLY the output as a JSON array of objects, where each object has a "question" and "answer" key. Do not include any other text or markdown formatting.`;

async function generateWithGoogle(text, apiKey, promptFunc) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: "user", parts: [{ text: promptFunc(text) }] }], generationConfig: { responseMimeType: "application/json" } };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI API request failed with status ${response.status}`);
    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Google AI");
    return JSON.parse(result.candidates[0].content.parts[0].text);
}
async function generateWithOpenAI(text, apiKey, promptFunc) {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', response_format: { type: "json_object" }, messages: [{ role: 'user', content: promptFunc(text) }] });
    if (!response.choices?.[0]?.message?.content) throw new Error("Invalid response from OpenAI");
    return JSON.parse(response.choices[0].message.content);
}

// --- API ENDPOINTS ---

app.get('/api/all-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [profileData, rewards, folders, notes, cards, audioClips] = await Promise.all([
        db.get('SELECT p.*, u.isAdmin FROM profile p JOIN users u ON u.id = p.userId WHERE p.userId = ?', userId),
        db.get('SELECT * FROM rewards WHERE userId = ?', userId),
        db.all('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM notes WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM audio_clips WHERE userId = ? ORDER BY createdAt DESC', userId)
    ]);

    const notesByFolder = notes.reduce((acc, note) => { (acc[note.folderId] = acc[note.folderId] || []).push(note); return acc; }, {});
    const cardsByFolder = cards.reduce((acc, card) => { (acc[card.folderId] = acc[card.folderId] || []).push(card); return acc; }, {});
    const audioByNote = audioClips.reduce((acc, clip) => { (acc[clip.noteId] = acc[clip.noteId] || []).push(clip); return acc; }, {});

    res.json({ profile: profileData, rewards, folders, notesByFolder, cardsByFolder, audioByNote });
  } catch (err) { console.error("Error fetching all data:", err); res.status(500).json({ error: "Failed to fetch app data from server." }); }
});

app.post('/api/notes/:noteId/audio', authenticateToken, upload.single('audio'), async (req, res) => {
    try {
        const { noteId } = req.params;
        const { file } = req;
        if (!file) return res.status(400).json({ error: 'No audio file uploaded.' });

        const clipId = `audio_${crypto.randomUUID()}`;
        await db.run(
            'INSERT INTO audio_clips (id, userId, noteId, originalName, serverPath, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
            [clipId, req.user.id, noteId, file.originalname, file.filename, new Date().toISOString()]
        );
        res.status(201).json(await db.get('SELECT * FROM audio_clips WHERE id = ?', clipId));
    } catch (err) { console.error("Audio Upload Error:", err); res.status(500).json({ error: "Failed to upload audio." }); }
});

app.post('/api/ai/:feature', authenticateToken, async (req, res) => {
    const { feature } = req.params;
    const { provider, text } = req.body;
    if (!provider || !text) return res.status(400).json({ error: 'Provider and text are required.' });

    let promptFunc;
    if (feature === 'subpoints') promptFunc = subpointsPrompt;
    else if (feature === 'keywords') promptFunc = keywordsPrompt;
    else if (feature === 'flashcards') promptFunc = flashcardPrompt;
    else return res.status(400).json({ error: 'Invalid AI feature.' });

    try {
        const profile = await db.get('SELECT * FROM profile WHERE userId = ?', req.user.id);
        const apiKey = profile[`${provider}ApiKey`];
        if (!apiKey) return res.status(400).json({ error: `API key for ${provider} not found.` });

        let result;
        if (provider === 'google') result = await generateWithGoogle(text, apiKey, promptFunc);
        else if (provider === 'openai') result = await generateWithOpenAI(text, apiKey, promptFunc);
        else return res.status(400).json({ error: 'Invalid provider.' });
        
        res.json(result);
    } catch (err) {
        console.error(`Error with ${provider} for ${feature}:`, err);
        res.status(500).json({ error: `An error occurred with the ${provider} API: ${err.message}` });
    }
});

// Other endpoints filled in
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user || !await bcrypt.compare(password, user.password_hash)) { return res.status(401).json({ error: 'Invalid credentials.' }); }
        res.json({ accessToken: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' }) });
    } catch (err) { console.error("Login Error:", err); res.status(500).json({ error: err.message }); }
});
app.post('/api/profile', authenticateToken, async (req, res) => {
  try {
    const { username, bio, avatarUrl, googleApiKey, openaiApiKey, huggingfaceApiKey } = req.body;
    await db.run('UPDATE profile SET username=?, bio=?, avatarUrl=?, googleApiKey=?, openaiApiKey=?, huggingfaceApiKey=? WHERE userId=?', [username, bio, avatarUrl, googleApiKey, openaiApiKey, huggingfaceApiKey, req.user.id]);
    res.json(await db.get('SELECT * FROM profile WHERE userId = ?', req.user.id));
  } catch (err) { console.error("Error updating profile:", err); res.status(500).json({ error: "Failed to update profile." }); }
});
app.post('/api/rewards', authenticateToken, async (req, res) => {
    try {
        const { points, streak, lastStudied } = req.body;
        await db.run('UPDATE rewards SET points=?, streak=?, lastStudied=? WHERE userId=?', [points, streak, lastStudied, req.user.id]);
        res.json(await db.get('SELECT * FROM rewards WHERE userId = ?', req.user.id));
    } catch (err) { console.error("Error updating rewards:", err); res.status(500).json({ error: "Failed to update rewards." }); }
});
app.post('/api/folders', authenticateToken, async (req, res) => {
    try {
        const { id, name, description, color } = req.body;
        if (id) {
            await db.run('UPDATE folders SET name=?, description=?, color=? WHERE id=? AND userId=?', [name, description, color, id, req.user.id]);
            res.json({ id, name, description, color });
        } else {
            const newId = `folder_${crypto.randomUUID()}`;
            await db.run('INSERT INTO folders (id, userId, name, description, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [newId, req.user.id, name, description, color, new Date().toISOString()]);
            res.status(201).json({ id: newId, name, description, color });
        }
    } catch (err) { console.error("Error saving folder:", err); res.status(500).json({ error: "Failed to save folder." }); }
});
app.delete('/api/folders/:id', authenticateToken, async (req, res) => {
    try { await db.run('DELETE FROM folders WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); }
    catch (err) { console.error("Error deleting folder:", err); res.status(500).json({ error: "Failed to delete folder." }); }
});
app.post('/api/notes', authenticateToken, async (req, res) => {
    try {
        const { folderId, noteId, title, content, cards } = req.body;
        const userId = req.user.id;
        const finalNoteId = noteId || `note_${crypto.randomUUID()}`;
        
        await db.run('BEGIN TRANSACTION');
        if(noteId) { await db.run('UPDATE notes SET title=?, content=?, cardCount=? WHERE id=? AND userId=?', [title, content, cards.length, noteId, userId]); }
        else { await db.run('INSERT INTO notes (id, userId, folderId, title, content, cardCount, createdAt) VALUES (?,?,?,?,?,?,?)', [finalNoteId, userId, folderId, title, content, cards.length, new Date().toISOString()]); }
        
        await db.run('DELETE FROM cards WHERE noteId=? AND userId=?', [finalNoteId, userId]);

        if (cards && cards.length > 0) {
            const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
            for (const card of cards) {
                await stmt.run([`card_${crypto.randomUUID()}`, userId, folderId, finalNoteId, card.question, card.answer, card.source, card.ease, card.interval, card.dueDate, card.createdAt]);
            }
            await stmt.finalize();
        }
        await db.run('COMMIT');
        res.status(201).json({ message: 'Note and cards saved' });
    } catch (err) {
        await db.run('ROLLBACK');
        console.error("Error saving note:", err);
        res.status(500).json({ error: "Failed to save note and associated cards." });
    }
});
app.delete('/api/notes/:id', authenticateToken, async (req, res) => {
    try { await db.run('DELETE FROM notes WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); }
    catch (err) { console.error("Error deleting note:", err); res.status(500).json({ error: "Failed to delete note." }); }
});
app.post('/api/manual-cards', authenticateToken, async (req, res) => {
    try {
        const { folderId, cards } = req.body;
        await db.run('BEGIN TRANSACTION');
        const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        for (const card of cards) {
            await stmt.run([`card_${crypto.randomUUID()}`, req.user.id, folderId, null, card.question, card.answer, 'manual', card.ease, card.interval, card.dueDate, card.createdAt]);
        }
        await stmt.finalize();
        await db.run('COMMIT');
        res.status(201).json({ message: 'Cards saved' });
    } catch (err) {
        await db.run('ROLLBACK');
        console.error("Error saving manual cards:", err);
        res.status(500).json({ error: "Failed to save manual cards." });
    }
});
app.put('/api/cards/:id', authenticateToken, async (req, res) => {
    try {
        const { ease, interval, dueDate } = req.body.srs;
        await db.run('UPDATE cards SET ease=?, interval=?, dueDate=? WHERE id=? AND userId=?', [ease, interval, dueDate, req.params.id, req.user.id]);
        res.json({ message: 'Card updated' });
    } catch (err) { console.error("Error updating card SRS data:", err); res.status(500).json({ error: "Failed to update card." }); }
});
app.delete('/api/cards/:id', authenticateToken, async (req, res) => {
    try { await db.run('DELETE FROM cards WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); }
    catch(err) { console.error("Error deleting card:", err); res.status(500).json({ error: "Failed to delete card." }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'study-app.html')));

// --- SERVER STARTUP ---
app.listen(PORT, async () => { await initializeDatabase(); console.log(`Server running at http://localhost:${PORT}`); });

