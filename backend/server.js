// A simple, UNIFIED backend for the Study App.
// This single file acts as BOTH the API server and the web server.
// Version 1.2: Multi-provider AI support (Google, OpenAI, Hugging Face)

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { HfInference } = require('@huggingface/inference');
const { OpenAI } = require('openai');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'your-super-secret-key-that-you-should-change'; // CHANGE THIS!
const SALT_ROUNDS = 10;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

// --- DATABASE SETUP ---
async function initializeDatabase() {
  db = await open({ filename: './database.db', driver: sqlite3.Database });
  console.log('Connected to the SQLite database.');
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile (
        userId INTEGER PRIMARY KEY,
        username TEXT,
        bio TEXT,
        avatarUrl TEXT,
        googleApiKey TEXT,
        openaiApiKey TEXT,
        huggingfaceApiKey TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rewards (userId INTEGER PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, lastStudied TEXT, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, color TEXT, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, title TEXT NOT NULL, content TEXT, cardCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, noteId TEXT, question TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL, ease REAL NOT NULL, interval INTEGER NOT NULL, dueDate TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE);
  `);
}

// --- AUTHENTICATION & API HELPERS ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

const flashcardPrompt = (text) => `Based on the following notes, generate a list of question and answer flashcards. Provide at least 5 flashcards if possible. The questions should be clear and the answers concise. Notes: --- ${text} --- Return ONLY the output as a JSON array of objects, where each object has a "question" and "answer" key. Do not include any other text or markdown formatting.`;

async function generateWithGoogle(text, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
        contents: [{ role: "user", parts: [{ text: flashcardPrompt(text) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, answer: { type: "STRING" } } } } }
    };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI API request failed with status ${response.status}`);
    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Google AI");
    return JSON.parse(result.candidates[0].content.parts[0].text);
}

async function generateWithOpenAI(text, apiKey) {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        response_format: { type: "json_object" },
        messages: [{ role: 'user', content: flashcardPrompt(text) }]
    });
    if (!response.choices?.[0]?.message?.content) throw new Error("Invalid response from OpenAI");
    return JSON.parse(response.choices[0].message.content);
}

async function generateWithHuggingFace(text, apiKey) {
    const hf = new HfInference(apiKey);
    const response = await hf.textGeneration({
        model: 'mistralai/Mistral-7B-v0.1',
        inputs: flashcardPrompt(text),
        parameters: { max_new_tokens: 500 }
    });
    const jsonString = response.generated_text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!jsonString) throw new Error("Could not find valid JSON in Hugging Face response.");
    return JSON.parse(jsonString[0]);
}

// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
        const userId = result.lastID;
        const username = email.split('@')[0];
        await db.run('INSERT INTO profile (userId, username) VALUES (?, ?)', [userId, username]);
        await db.run('INSERT INTO rewards (userId) VALUES (?)', [userId]);
        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) { res.status(err.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }
        res.json({ accessToken: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/all-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await db.get('SELECT * FROM profile WHERE userId = ?', userId);
    const rewards = await db.get('SELECT * FROM rewards WHERE userId = ?', userId);
    const folders = await db.all('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notes = await db.all('SELECT * FROM notes WHERE userId = ? ORDER BY createdAt DESC', userId);
    const cards = await db.all('SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notesByFolder = notes.reduce((acc, note) => { (acc[note.folderId] = acc[note.folderId] || []).push(note); return acc; }, {});
    const cardsByFolder = cards.reduce((acc, card) => { (acc[card.folderId] = acc[card.folderId] || []).push(card); return acc; }, {});
    res.json({ profile, rewards, folders, notesByFolder, cardsByFolder });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  const { username, bio, avatarUrl, googleApiKey, openaiApiKey, huggingfaceApiKey } = req.body;
  try {
    await db.run('UPDATE profile SET username=?, bio=?, avatarUrl=?, googleApiKey=?, openaiApiKey=?, huggingfaceApiKey=? WHERE userId=?', [username, bio, avatarUrl, googleApiKey, openaiApiKey, huggingfaceApiKey, req.user.id]);
    const updatedProfile = await db.get('SELECT * FROM profile WHERE userId = ?', req.user.id);
    res.json(updatedProfile);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/generate-ai-cards', authenticateToken, async (req, res) => {
    const { provider, text } = req.body;
    if (!provider || !text) return res.status(400).json({ error: 'Provider and text are required.' });
    try {
        const profile = await db.get('SELECT * FROM profile WHERE userId = ?', req.user.id);
        const apiKey = profile[`${provider}ApiKey`];
        if (!apiKey) return res.status(400).json({ error: `API key for ${provider} not found.` });
        let cards;
        switch(provider) {
            case 'google': cards = await generateWithGoogle(text, apiKey); break;
            case 'openai': cards = await generateWithOpenAI(text, apiKey); break;
            case 'huggingface': cards = await generateWithHuggingFace(text, apiKey); break;
            default: return res.status(400).json({ error: 'Invalid provider.' });
        }
        res.json(cards);
    } catch (err) {
        console.error(`Error with ${provider}:`, err);
        res.status(500).json({ error: `An error occurred with the ${provider} API: ${err.message}` });
    }
});

app.post('/api/rewards', authenticateToken, async (req, res) => {
    const { points, streak, lastStudied } = req.body;
    await db.run('UPDATE rewards SET points=?, streak=?, lastStudied=? WHERE userId=?', [points, streak, lastStudied, req.user.id]);
    res.json(await db.get('SELECT * FROM rewards WHERE userId = ?', req.user.id));
});
app.post('/api/folders', authenticateToken, async (req, res) => {
    const { id, name, description, color } = req.body;
    if (id) {
        await db.run('UPDATE folders SET name=?, description=?, color=? WHERE id=? AND userId=?', [name, description, color, id, req.user.id]);
        res.json({ id, name, description, color });
    } else {
        const newId = `folder_${crypto.randomUUID()}`;
        await db.run('INSERT INTO folders (id, userId, name, description, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [newId, req.user.id, name, description, color, new Date().toISOString()]);
        res.status(201).json({ id: newId, name, description, color });
    }
});
app.delete('/api/folders/:id', authenticateToken, (req, res) => { db.run('DELETE FROM folders WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); });
app.post('/api/notes', authenticateToken, async (req, res) => {
    const { folderId, noteId, title, content, cards } = req.body;
    const userId = req.user.id;
    let finalNoteId = noteId || `note_${crypto.randomUUID()}`;
    if(noteId) { await db.run('UPDATE notes SET title=?, content=?, cardCount=? WHERE id=? AND userId=?', [title, content, cards.length, noteId, userId]); }
    else { await db.run('INSERT INTO notes (id, userId, folderId, title, content, cardCount, createdAt) VALUES (?,?,?,?,?,?,?)', [finalNoteId, userId, folderId, title, content, cards.length, new Date().toISOString()]); }
    await db.run('DELETE FROM cards WHERE noteId=? AND userId=?', [finalNoteId, userId]);
    const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const card of cards) { await stmt.run(`card_${crypto.randomUUID()}`, userId, folderId, finalNoteId, card.question, card.answer, card.source, card.srs.ease, card.srs.interval, card.srs.dueDate, card.createdAt); }
    await stmt.finalize();
    res.status(201).json({ message: 'Note and cards saved' });
});
app.delete('/api/notes/:id', authenticateToken, (req, res) => { db.run('DELETE FROM notes WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); });
app.post('/api/manual-cards', authenticateToken, async (req, res) => {
    const { folderId, cards } = req.body;
    const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const card of cards) { await stmt.run(`card_${crypto.randomUUID()}`, req.user.id, folderId, null, card.question, card.answer, 'manual', card.srs.ease, card.srs.interval, card.srs.dueDate, card.createdAt); }
    await stmt.finalize();
    res.status(201).json({ message: 'Cards saved' });
});
app.put('/api/cards/:id', authenticateToken, (req, res) => { db.run('UPDATE cards SET ease=?, interval=?, dueDate=? WHERE id=? AND userId=?', [req.body.srs.ease, req.body.srs.interval, req.body.srs.dueDate, req.params.id, req.user.id]); res.json({ message: 'Card updated' }); });
app.delete('/api/cards/:id', authenticateToken, (req, res) => { db.run('DELETE FROM cards WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'study-app.html')));

// --- SERVER STARTUP ---
app.listen(PORT, async () => { await initializeDatabase(); console.log(`Server running at http://localhost:${PORT}`); });

