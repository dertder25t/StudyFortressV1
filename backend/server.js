// A simple, UNIFIED backend for the Study App.

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { exec } = require('child_process');
const { HfInference } = require('@huggingface/inference');
const { OpenAI } = require('openai');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'your-super-secret-key-that-you-should-change'; // IMPORTANT: Change this!
const SALT_ROUNDS = 10;
const APP_DIR = '/opt/StudyFortressV1';

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    `);
  } catch (error) {
    console.error("FATAL: Failed to initialize database:", error);
    process.exit(1);
  }
}

// --- MIDDLEWARE ---
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
const flashcardPrompt = (text) => `Based on the following notes, generate a list of question and answer flashcards. Provide at least 5 flashcards if possible. The questions should be clear and the answers concise. Notes: --- ${text} --- Return ONLY the output as a JSON array of objects, where each object has a "question" and "answer" key. Do not include any other text or markdown formatting.`;
async function generateWithGoogle(text, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: "user", parts: [{ text: flashcardPrompt(text) }] }], generationConfig: { responseMimeType: "application/json", responseSchema: { type: "ARRAY", items: { type: "OBJECT", properties: { question: { type: "STRING" }, answer: { type: "STRING" } } } } } };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI API request failed with status ${response.status}`);
    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Google AI");
    return JSON.parse(result.candidates[0].content.parts[0].text);
}
async function generateWithOpenAI(text, apiKey) {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({ model: 'gpt-3.5-turbo', response_format: { type: "json_object" }, messages: [{ role: 'user', content: flashcardPrompt(text) }] });
    if (!response.choices?.[0]?.message?.content) throw new Error("Invalid response from OpenAI");
    return JSON.parse(response.choices[0].message.content);
}
async function generateWithHuggingFace(text, apiKey) {
    const hf = new HfInference(apiKey);
    const response = await hf.textGeneration({ model: 'mistralai/Mistral-7B-v0.1', inputs: flashcardPrompt(text), parameters: { max_new_tokens: 500 } });
    const jsonString = response.generated_text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!jsonString) throw new Error("Could not find valid JSON in Hugging Face response.");
    return JSON.parse(jsonString[0]);
}

// --- API ENDPOINTS ---

app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await db.run('INSERT INTO users (email, password_hash, isAdmin) VALUES (?, ?, 0)', [email, hash]);
        const userId = result.lastID;
        const username = email.split('@')[0];
        await db.run('INSERT INTO profile (userId, username) VALUES (?, ?)', [userId, username]);
        await db.run('INSERT INTO rewards (userId) VALUES (?)', [userId]);
        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(err.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => { /* ... implementation ... */ });

app.get('/api/all-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const profileData = await db.get('SELECT p.*, u.isAdmin FROM profile p JOIN users u ON u.id = p.userId WHERE p.userId = ?', userId);
    const rewards = await db.get('SELECT * FROM rewards WHERE userId = ?', userId);
    const folders = await db.all('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notes = await db.all('SELECT * FROM notes WHERE userId = ? ORDER BY createdAt DESC', userId);
    const cards = await db.all('SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC', userId);
    const notesByFolder = notes.reduce((acc, note) => { (acc[note.folderId] = acc[note.folderId] || []).push(note); return acc; }, {});
    const cardsByFolder = cards.reduce((acc, card) => { (acc[card.folderId] = acc[card.folderId] || []).push(card); return acc; }, {});
    res.json({ profile: profileData, rewards, folders, notesByFolder, cardsByFolder });
  } catch (err) { console.error("Error fetching all data:", err); res.status(500).json({ error: "Failed to fetch app data from server." }); }
});

app.post('/api/profile', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.post('/api/generate-ai-cards', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.post('/api/rewards', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.post('/api/folders', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.delete('/api/folders/:id', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.post('/api/notes', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.delete('/api/notes/:id', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.post('/api/manual-cards', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.put('/api/cards/:id', authenticateToken, async (req, res) => { /* ... implementation ... */ });
app.delete('/api/cards/:id', authenticateToken, async (req, res) => { /* ... implementation ... */ });

// --- VERSION ENDPOINT ---
app.get('/api/version', (req, res) => {
    try {
        const packageJson = require('./package.json');
        res.json({ version: packageJson.version });
    } catch (error) {
        console.error("Could not read package.json:", error);
        res.status(500).json({ error: "Could not determine app version." });
    }
});

// --- ADMIN ENDPOINT ---
app.post('/api/admin/update-app', authenticateToken, checkAdmin, (req, res) => {
    console.log(`[ADMIN UPDATE] - Admin user ${req.user.id} initiated an update.`);
    const command = `cd ${APP_DIR} && git pull && npm install --prefix backend`;

    exec(command, (error, stdout, stderr) => {
        const fullOutput = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
        console.log(`[ADMIN UPDATE] - Full Output:\n${fullOutput}`);

        if (error) {
            console.error(`[ADMIN UPDATE] - Execution Error: ${error.message}`);
            return res.status(500).json({
                message: "Update script failed during pull or install. Check server logs.",
                error: error.message,
                output: fullOutput
            });
        }

        // Send a success response BEFORE restarting the server.
        res.status(200).json({
            message: "Update successful! Server is restarting now...",
            output: fullOutput
        });
        
        // Restart the server with PM2 after a short delay.
        setTimeout(() => {
            console.log('[ADMIN UPDATE] - Issuing restart command to PM2...');
            exec('pm2 restart study-app', (restartError, restartStdout, restartStderr) => {
                if (restartError) { console.error(`[ADMIN UPDATE] - PM2 Restart Error: ${restartError.message}`); }
                if (restartStderr) { console.warn(`[ADMIN UPDATE] - PM2 Restart Stderr: ${restartStderr}`); }
                console.log(`[ADMIN UPDATE] - PM2 Restart Stdout: ${restartStdout}`);
            });
        }, 1000);
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'study-app.html')));

// --- SERVER STARTUP ---
app.listen(PORT, async () => { await initializeDatabase(); console.log(`Server running at http://localhost:${PORT}`); });
