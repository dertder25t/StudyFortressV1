const express = require('express');
const https = require('https');
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
const { OpenAI } = require('openai');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');

const uuid = () => {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-you-should-change';
const SALT_ROUNDS = 10;

if (JWT_SECRET === 'your-super-secret-key-that-you-should-change') {
    console.warn('****************************************************************');
    console.warn('** WARNING: Using default JWT_SECRET. This is NOT secure!     **');
    console.warn('** Please set a strong secret in your environment variables.  **');
    console.warn('****************************************************************');
}

const APP_DIR = process.env.APP_DIR || path.resolve(__dirname);
const UPLOAD_DIR = path.join(APP_DIR, 'uploads');
const DB_PATH = path.join(APP_DIR, 'database.db');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// --- MULTER SETUP ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = uuid();
        cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const documentUploader = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF files are allowed.'), false);
        }
    }
}).single('document');

const audioUploader = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'audio/webm' || file.mimetype === 'video/webm') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only WEBM audio files are allowed.'), false);
        }
    }
}).single('audio');


// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per window
	standardHeaders: true,
	legacyHeaders: false, 
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});
app.use('/api', apiLimiter);


// --- DATABASE SETUP & HELPERS ---
let db;
async function initializeDatabase() {
  try {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    console.log('Connected to the SQLite database.');
    await db.exec('PRAGMA foreign_keys = ON;');
    await db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, isAdmin INTEGER NOT NULL DEFAULT 0);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS profile (userId INTEGER PRIMARY KEY, username TEXT, bio TEXT, avatarUrl TEXT, googleApiKey TEXT, openaiApiKey TEXT, groqApiKey TEXT, audioQuality TEXT, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS rewards (userId INTEGER PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, lastStudied TEXT, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, color TEXT, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, documentId TEXT, title TEXT NOT NULL, content TEXT, cardCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE, FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE SET NULL);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, noteId TEXT, question TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL, ease REAL NOT NULL, interval INTEGER NOT NULL, dueDate TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE, FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, folderId TEXT NOT NULL, originalName TEXT NOT NULL, serverPath TEXT NOT NULL, fileType TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS audio_clips (id TEXT PRIMARY KEY, userId INTEGER NOT NULL, noteId TEXT NOT NULL, serverPath TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
    
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('maxUploadSize', '10')");
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('enableAudioCompression', 'true')");
  } catch (error) {
    console.error("FATAL: Failed to initialize database:", error);
    process.exit(1);
  }
}
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) { 
            console.error("JWT Verification Error:", err.message); 
            return res.status(403).json({ error: "Forbidden: Invalid or expired token." });
        }
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

// --- AI HELPER FUNCTIONS ---
const cleanJsonString = (str) => {
    const firstBracket = str.indexOf('{');
    const firstSquare = str.indexOf('[');
    let start = -1;
    if (firstBracket === -1) { start = firstSquare; } 
    else if (firstSquare === -1) { start = firstBracket; } 
    else { start = Math.min(firstBracket, firstSquare); }
    if (start === -1) return str;
    const lastBracket = str.lastIndexOf('}');
    const lastSquare = str.lastIndexOf(']');
    const end = Math.max(lastBracket, lastSquare);
    if (end === -1) return str;
    return str.substring(start, end + 1);
};
const flashcardPrompt = (text) => `Based on the following notes, generate a list of question and answer flashcards. Provide at least 5 flashcards if possible. The questions should be clear and the answers concise. Notes: --- ${text} --- Return ONLY the output as a JSON array of objects, where each object has a "question" and "answer" key. Do not include any other text or markdown formatting.`;
const subpointsPrompt = (text) => `Analyze the following text and extract the main ideas as a concise, bulleted list. Text: --- ${text} --- Return ONLY the output as a JSON object with a single key "subpoints" which is an array of strings.`;
const highlightPrompt = (text) => `Analyze the following text and identify the most important keywords or key phrases. Text: --- ${text} --- Return ONLY the output as a JSON object with a single key "highlights" which is an array of strings.`;

async function generateWithGoogle(text, apiKey, model, promptFunction) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = { contents: [{ role: "user", parts: [{ text: promptFunction(text) }] }] };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI API request failed with status ${response.status}`);
    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid response from Google AI");
    return JSON.parse(cleanJsonString(result.candidates[0].content.parts[0].text));
}
async function generateWithOpenAI(text, apiKey, model, promptFunction) {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({ model: model, response_format: { type: "json_object" }, messages: [{ role: 'user', content: promptFunction(text) }] });
    if (!response.choices?.[0]?.message?.content) throw new Error("Invalid response from OpenAI");
    return JSON.parse(cleanJsonString(response.choices[0].message.content));
}
async function generateWithGroq(text, apiKey, model, promptFunction) {
    const groq = new OpenAI({
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: apiKey
    });
    const response = await groq.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: promptFunction(text) }],
        response_format: { type: "json_object" },
    });
    if (!response.choices?.[0]?.message?.content) throw new Error("Invalid response from Groq");
    return JSON.parse(cleanJsonString(response.choices[0].message.content));
}
async function transcribeWithOpenAI(filePath, apiKey) {
    const openai = new OpenAI({ apiKey });
    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
    });
    return transcription;
}
async function transcribeWithGoogle(filePath, apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const audioData = fs.readFileSync(filePath).toString('base64');
    const payload = {
        contents: [{
            parts: [
                { text: "Transcribe this audio recording." },
                { inline_data: { mime_type: 'audio/webm', data: audioData } }
            ]
        }]
    };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Google AI transcription failed with status ${response.status}`);
    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error("Invalid transcription response from Google AI");
    return { text: result.candidates[0].content.parts[0].text };
}

// --- API ROUTING ---
const apiRouter = express.Router();

// AUTH
apiRouter.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await db.run('INSERT INTO users (email, password_hash, isAdmin) VALUES (?, ?, 0)', [email, hash]);
        const userId = result.lastID;
        const username = email.split('@')[0];
        await db.run('INSERT INTO profile (userId, username, audioQuality) VALUES (?, ?, ?)', [userId, username, '64000']);
        await db.run('INSERT INTO rewards (userId) VALUES (?)', [userId]);
        res.status(201).json({ message: 'User created successfully.' });
    } catch (err) {
        console.error("Registration Error:", err);
        if (err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: "An account with this email already exists." });
        }
        res.status(500).json({ error: "An unexpected error occurred during registration." });
    }
});
apiRouter.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user || !await bcrypt.compare(password, user.password_hash)) { return res.status(401).json({ error: 'Invalid credentials.' }); }
        res.json({ accessToken: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' }) });
    } catch (err) { console.error("Login Error:", err); res.status(500).json({ error: err.message }); }
});

// DATA & PROFILE
apiRouter.get('/all-data', authenticateToken, async (req, res) => {
 try {
    const userId = req.user.id;
    const [profileData, rewards, folders, notes, cards, documents, settingsData, audioClips] = await Promise.all([
        db.get('SELECT p.*, u.isAdmin FROM profile p JOIN users u ON u.id = p.userId WHERE p.userId = ?', userId),
        db.get('SELECT * FROM rewards WHERE userId = ?', userId),
        db.all('SELECT * FROM folders WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM notes WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM documents WHERE userId = ? ORDER BY createdAt DESC', userId),
        db.all('SELECT * FROM settings'),
        db.all('SELECT * FROM audio_clips WHERE userId = ?', userId)
    ]);
    const settings = settingsData.reduce((acc, {key, value}) => ({ ...acc, [key]: value }), {});
    const notesByFolder = notes.reduce((acc, note) => { (acc[note.folderId] = acc[note.folderId] || []).push(note); return acc; }, {});
    const cardsByFolder = cards.reduce((acc, card) => { (acc[card.folderId] = acc[card.folderId] || []).push(card); return acc; }, {});
    const documentsByFolder = documents.reduce((acc, doc) => { (acc[doc.folderId] = acc[doc.folderId] || []).push(doc); return acc; }, {});
    const audioClipsByNote = audioClips.reduce((acc, clip) => { (acc[clip.noteId] = acc[clip.noteId] || []).push(clip); return acc; }, {});
    res.json({ profile: profileData, rewards, folders, notesByFolder, cardsByFolder, documentsByFolder, settings, audioClipsByNote });
 } catch (err) { console.error("Error fetching all data:", err); res.status(500).json({ error: "Failed to fetch app data from server." }); }
});
apiRouter.post('/profile', authenticateToken, async (req, res) => {
  try {
    const { username, bio, avatarUrl, googleApiKey, openaiApiKey, groqApiKey, audioQuality } = req.body;
    await db.run('UPDATE profile SET username=?, bio=?, avatarUrl=?, googleApiKey=?, openaiApiKey=?, groqApiKey=?, audioQuality=? WHERE userId=?', [username, bio, avatarUrl, googleApiKey, openaiApiKey, groqApiKey, audioQuality, req.user.id]);
    const updatedProfile = await db.get('SELECT * FROM profile WHERE userId = ?', req.user.id);
    res.json(updatedProfile);
  } catch (err) { console.error("Error updating profile:", err); res.status(500).json({ error: "Failed to update profile." }); }
});
apiRouter.post('/rewards', authenticateToken, async (req, res) => {
    try {
        const { points, streak, lastStudied } = req.body;
        await db.run('UPDATE rewards SET points=?, streak=?, lastStudied=? WHERE userId=?', [points, streak, lastStudied, req.user.id]);
        const updatedRewards = await db.get('SELECT * FROM rewards WHERE userId = ?', req.user.id);
        res.json(updatedRewards);
    } catch (err) { console.error("Error updating rewards:", err); res.status(500).json({ error: "Failed to update rewards." }); }
});

// FOLDERS
apiRouter.post('/folders', authenticateToken, async (req, res) => {
    try {
        const { id, name, description, color } = req.body;
        if (id) {
            await db.run('UPDATE folders SET name=?, description=?, color=? WHERE id=? AND userId=?', [name, description, color, id, req.user.id]);
            res.json({ id, name, description, color });
        } else {
            const newId = `folder_${uuid()}`;
            await db.run('INSERT INTO folders (id, userId, name, description, color, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [newId, req.user.id, name, description, color, new Date().toISOString()]);
            res.status(201).json({ id: newId, name, description, color });
        }
    } catch (err) { console.error("Error saving folder:", err); res.status(500).json({ error: "Failed to save folder." }); }
});
apiRouter.delete('/folders/:id', authenticateToken, async (req, res) => {
    try { 
        await db.run('DELETE FROM audio_clips WHERE noteId IN (SELECT id FROM notes WHERE folderId = ?)', [req.params.id]);
        await db.run('DELETE FROM folders WHERE id=? AND userId=?', [req.params.id, req.user.id]); 
        res.sendStatus(204); 
    }
    catch (err) { console.error("Error deleting folder:", err); res.status(500).json({ error: "Failed to delete folder." }); }
});
apiRouter.delete('/folders/:folderId/notes', authenticateToken, async (req, res) => {
    try {
        const { folderId } = req.params;
        const userId = req.user.id;
        const folder = await db.get('SELECT id FROM folders WHERE id = ? AND userId = ?', [folderId, userId]);
        if (!folder) return res.status(403).json({ error: "Forbidden: You do not own this folder." });
        await db.run('BEGIN TRANSACTION');
        await db.run('DELETE FROM audio_clips WHERE noteId IN (SELECT id FROM notes WHERE folderId = ?)', [folderId]);
        await db.run('DELETE FROM cards WHERE noteId IN (SELECT id FROM notes WHERE folderId = ?)', [folderId]);
        await db.run('DELETE FROM notes WHERE folderId = ? AND userId = ?', [folderId, userId]);
        await db.run('COMMIT');
        res.sendStatus(204);
    } catch (err) {
        await db.run('ROLLBACK');
        console.error("Error deleting all notes in folder:", err);
        res.status(500).json({ error: "Failed to delete all notes." });
    }
});

// NOTES & CARDS
apiRouter.post('/notes', authenticateToken, async (req, res) => {
    try {
        const { folderId, noteId, title, content, cards, documentId } = req.body;
        const userId = req.user.id;
        if (!folderId) {
            return res.status(400).json({ error: "A folderId is required to save a note." });
        }
        const finalNoteId = noteId || `note_${uuid()}`;
        await db.run('BEGIN TRANSACTION');
        if(noteId) { 
            await db.run('UPDATE notes SET title=?, content=?, cardCount=?, documentId=? WHERE id=? AND userId=?', [title, content, cards.length, documentId, noteId, userId]); 
        } else { 
            await db.run('INSERT INTO notes (id, userId, folderId, title, content, cardCount, createdAt, documentId) VALUES (?,?,?,?,?,?,?,?)', [finalNoteId, userId, folderId, title, content, cards.length, new Date().toISOString(), documentId]); 
        }
        await db.run('DELETE FROM cards WHERE noteId=? AND userId=?', [finalNoteId, userId]);
        if (cards && cards.length > 0) {
            const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
            for (const card of cards) {
                await stmt.run([`card_${uuid()}`, userId, folderId, finalNoteId, card.question, card.answer, card.source, card.ease, card.interval, card.dueDate, card.createdAt]);
            }
            await stmt.finalize();
        }
        await db.run('COMMIT');
        res.status(201).json({ message: 'Note and cards saved', noteId: finalNoteId });
    } catch (err) {
        await db.run('ROLLBACK');
        console.error("Error saving note:", err);
        res.status(500).json({ error: "Failed to save note and associated cards." });
    }
});
apiRouter.delete('/notes/:id', authenticateToken, async (req, res) => {
    try { 
        await db.run('DELETE FROM audio_clips WHERE noteId = ? AND userId = ?', [req.params.id, req.user.id]);
        await db.run('DELETE FROM notes WHERE id=? AND userId=?', [req.params.id, req.user.id]); 
        res.sendStatus(204); 
    }
    catch (err) { console.error("Error deleting note:", err); res.status(500).json({ error: "Failed to delete note." }); }
});
apiRouter.post('/manual-cards', authenticateToken, async (req, res) => {
    try {
        const { folderId, cards } = req.body;
        await db.run('BEGIN TRANSACTION');
        const stmt = await db.prepare('INSERT INTO cards (id,userId,folderId,noteId,question,answer,source,ease,interval,dueDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        for (const card of cards) {
            await stmt.run([`card_${uuid()}`, req.user.id, folderId, null, card.question, card.answer, 'manual', card.ease, card.interval, card.dueDate, card.createdAt]);
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
apiRouter.put('/cards/:id', authenticateToken, async (req, res) => {
    try {
        const { ease, interval, dueDate } = req.body.srs;
        await db.run('UPDATE cards SET ease=?, interval=?, dueDate=? WHERE id=? AND userId=?', [ease, interval, dueDate, req.params.id, req.user.id]);
        res.json({ message: 'Card updated' });
    } catch (err) { console.error("Error updating card SRS data:", err); res.status(500).json({ error: "Failed to update card." }); }
});
apiRouter.delete('/cards/:id', authenticateToken, async (req, res) => {
    try { await db.run('DELETE FROM cards WHERE id=? AND userId=?', [req.params.id, req.user.id]); res.sendStatus(204); }
    catch(err) { console.error("Error deleting card:", err); res.status(500).json({ error: "Failed to delete card." }); }
});

// DOCUMENTS
const fileSizeCheck = async (req, res, next) => {
    const setting = await db.get("SELECT value FROM settings WHERE key = 'maxUploadSize'");
    const maxSize = (parseInt(setting.value, 10) || 10) * 1024 * 1024;
    if (req.file && req.file.size > maxSize) {
        fs.unlink(req.file.path, (err) => { if (err) console.error("Error deleting oversized file:", err); });
        return res.status(413).json({ error: `File is too large. Max size is ${setting.value}MB.` });
    }
    next();
};

apiRouter.post('/folders/:folderId/upload', authenticateToken, (req, res, next) => {
    documentUploader(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, fileSizeCheck, async (req, res) => {
    try {
        const { folderId } = req.params;
        const { file } = req;
        const userId = req.user.id;
        if (!file) { return res.status(400).json({ error: 'No file uploaded.' }); }
        const docId = `doc_${uuid()}`;
        await db.run('INSERT INTO documents (id, userId, folderId, originalName, serverPath, fileType, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [docId, userId, folderId, file.originalname, file.filename, file.mimetype, new Date().toISOString()]);
        const newDocument = await db.get('SELECT * FROM documents WHERE id = ?', docId)
        res.status(201).json(newDocument);
    } catch (err) { console.error("File Upload Error:", err); res.status(500).json({ error: "Failed to upload file." }); }
});

apiRouter.get('/documents/:documentId', authenticateToken, async (req, res) => {
    try {
        const { documentId } = req.params;
        const doc = await db.get('SELECT * FROM documents WHERE id = ? AND userId = ?', [documentId, req.user.id]);
        if (!doc) return res.status(404).json({ error: "Document not found or you don't have permission." });
        const filePath = path.join(UPLOAD_DIR, doc.serverPath);
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ error: "File not found on server."});
        }
    } catch (err) {
        console.error("Error serving document:", err);
        res.status(500).json({ error: "Failed to serve document."});
    }
});
apiRouter.delete('/documents/:documentId', authenticateToken, async (req, res) => {
    try {
        const { documentId } = req.params;
        const doc = await db.get('SELECT * FROM documents WHERE id = ? AND userId = ?', [documentId, req.user.id]);
        if (!doc) { return res.status(404).json({ error: "Document not found or you don't have permission." }); }
        
        const filePath = path.join(UPLOAD_DIR, doc.serverPath);
        
        await db.run('BEGIN TRANSACTION');
        await db.run('UPDATE notes SET documentId = NULL WHERE documentId = ? AND userId = ?', [documentId, req.user.id]);
        await db.run('DELETE FROM documents WHERE id = ? AND userId = ?', [documentId, req.user.id]);
        await db.run('COMMIT');
        
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => { if (err) console.error("Error deleting file from disk:", err); });
        }
        
        res.sendStatus(204);
    } catch (err) {
        await db.run('ROLLBACK');
        console.error("Error deleting document:", err);
        res.status(500).json({ error: "Failed to delete document." });
    }
});


// AI & AUDIO
apiRouter.post('/notes/:noteId/upload-audio', authenticateToken, (req, res, next) => {
    audioUploader(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, fileSizeCheck, async (req, res) => {
    try {
        const { noteId } = req.params;
        const { file } = req;
        if (!file) return res.status(400).json({ error: 'No audio file uploaded.' });
        const clipId = `audio_${uuid()}`;
        await db.run('INSERT INTO audio_clips (id, userId, noteId, serverPath, createdAt) VALUES (?, ?, ?, ?, ?)', 
            [clipId, req.user.id, noteId, file.filename, new Date().toISOString()]);
        const newClip = await db.get('SELECT * FROM audio_clips WHERE id = ?', clipId);
        res.status(201).json(newClip);
    } catch (err) {
        console.error("Audio upload error:", err);
        res.status(500).json({ error: 'Failed to save audio clip.' });
    }
});

apiRouter.get('/audio-clips/:clipId', authenticateToken, async (req, res) => {
    try {
        const { clipId } = req.params;
        const clip = await db.get('SELECT * FROM audio_clips WHERE id = ? AND userId = ?', [clipId, req.user.id]);
        if (!clip) return res.status(404).json({ error: "Audio clip not found." });
        const filePath = path.join(UPLOAD_DIR, clip.serverPath);
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ error: "Audio file not found on server." });
        }
    } catch (err) {
        console.error("Error serving audio clip:", err);
        res.status(500).json({ error: "Failed to serve audio clip." });
    }
});
apiRouter.delete('/audio-clips/:clipId', authenticateToken, async (req, res) => {
    try {
        const { clipId } = req.params;
        const clip = await db.get('SELECT * FROM audio_clips WHERE id = ? AND userId = ?', [clipId, req.user.id]);
        if (!clip) return res.status(404).json({ error: "Audio clip not found." });
        const filePath = path.join(UPLOAD_DIR, clip.serverPath);
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => { if (err) console.error("Error deleting audio file from disk:", err); });
        }
        await db.run('DELETE FROM audio_clips WHERE id = ?', clipId);
        res.sendStatus(204);
    } catch (err) {
        console.error("Error deleting audio clip:", err);
        res.status(500).json({ error: "Failed to delete audio clip." });
    }
});
apiRouter.post('/audio-clips/:clipId/transcribe', authenticateToken, async (req, res) => {
    try {
        const { clipId } = req.params;
        const { provider, model } = req.body;
        const clip = await db.get('SELECT * FROM audio_clips WHERE id = ? AND userId = ?', [clipId, req.user.id]);
        if (!clip) return res.status(404).json({ error: "Audio clip not found." });
        
        const profile = await db.get('SELECT googleApiKey, openaiApiKey FROM profile WHERE userId = ?', req.user.id);
        const apiKey = provider === 'google' ? profile.googleApiKey : profile.openaiApiKey;
        if (!apiKey) return res.status(400).json({ error: `${provider} API key is required for transcription.` });

        const filePath = path.join(UPLOAD_DIR, clip.serverPath);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Audio file not found on server." });

        const transcription = provider === 'google'
            ? await transcribeWithGoogle(filePath, apiKey, model)
            : await transcribeWithOpenAI(filePath, apiKey); // Whisper has one model for now
        
        res.json(transcription);
    } catch (err) {
        console.error("Transcription Error:", err);
        res.status(500).json({ error: `Transcription failed: ${err.message}` });
    }
});
apiRouter.post('/generate-ai-cards', authenticateToken, async (req, res) => {
    try {
        const { text, provider, model } = req.body;
        const profile = await db.get('SELECT googleApiKey, openaiApiKey, groqApiKey FROM profile WHERE userId = ?', req.user.id);
        const apiKey = { google: profile.googleApiKey, openai: profile.openaiApiKey, groq: profile.groqApiKey }[provider];
        if (!apiKey) return res.status(400).json({ error: `${provider} API key is required.` });
        
        let result;
        if (provider === 'google') result = await generateWithGoogle(text, apiKey, model, flashcardPrompt);
        else if (provider === 'openai') result = await generateWithOpenAI(text, apiKey, model, flashcardPrompt);
        else if (provider === 'groq') result = await generateWithGroq(text, apiKey, model, flashcardPrompt);
        else return res.status(400).json({ error: 'Invalid AI provider specified.' });

        res.json(result);
    } catch (err) {
        console.error("Flashcard Generation Error:", err);
        res.status(500).json({ error: `Flashcard generation failed: ${err.message}` });
    }
});
apiRouter.post('/generate-subpoints', authenticateToken, async (req, res) => {
    try {
        const { text, provider, model } = req.body;
        const profile = await db.get('SELECT googleApiKey, openaiApiKey, groqApiKey FROM profile WHERE userId = ?', req.user.id);
        const apiKey = { google: profile.googleApiKey, openai: profile.openaiApiKey, groq: profile.groqApiKey }[provider];
        if (!apiKey) return res.status(400).json({ error: `${provider} API key is required.` });
        
        let result;
        if (provider === 'google') result = await generateWithGoogle(text, apiKey, model, subpointsPrompt);
        else if (provider === 'openai') result = await generateWithOpenAI(text, apiKey, model, subpointsPrompt);
        else if (provider === 'groq') result = await generateWithGroq(text, apiKey, model, subpointsPrompt);
        else return res.status(400).json({ error: 'Invalid AI provider specified.' });

        res.json(result);
    } catch (err) {
        console.error("Subpoint Generation Error:", err);
        res.status(500).json({ error: `Subpoint generation failed: ${err.message}` });
    }
});
apiRouter.post('/highlight-text', authenticateToken, async (req, res) => {
    try {
        const { text, provider, model } = req.body;
        const profile = await db.get('SELECT googleApiKey, openaiApiKey, groqApiKey FROM profile WHERE userId = ?', req.user.id);
        const apiKey = { google: profile.googleApiKey, openai: profile.openaiApiKey, groq: profile.groqApiKey }[provider];
        if (!apiKey) return res.status(400).json({ error: `${provider} API key is required.` });
        
        let result;
        if (provider === 'google') result = await generateWithGoogle(text, apiKey, model, highlightPrompt);
        else if (provider === 'openai') result = await generateWithOpenAI(text, apiKey, model, highlightPrompt);
        else if (provider === 'groq') result = await generateWithGroq(text, apiKey, model, highlightPrompt);
        else return res.status(400).json({ error: 'Invalid AI provider specified.' });

        res.json(result);
    } catch (err) {
        console.error("Highlighting Error:", err);
        res.status(500).json({ error: `Highlighting failed: ${err.message}` });
    }
});

// VERSION & ADMIN
apiRouter.get('/version', (req, res) => {
    try {
        const packageJsonPath = path.resolve(__dirname, 'package.json');
        const packageJson = require(packageJsonPath);
        res.json({ version: packageJson.version });
    } catch (error) { console.error("Could not read package.json:", error); res.status(500).json({ error: "Could not determine app version." }); }
});
apiRouter.get('/ai-models', authenticateToken, (req, res) => {
    res.json({
        google: ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest'],
        openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        groq: ['llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma-7b-it']
    });
});
apiRouter.get('/admin/settings', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const settingsData = await db.all('SELECT * FROM settings');
        const settings = settingsData.reduce((acc, {key, value}) => ({ ...acc, [key]: value }), {});
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve settings.' });
    }
});
apiRouter.post('/admin/settings', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { maxUploadSize, enableAudioCompression } = req.body;
        await db.run("UPDATE settings SET value = ? WHERE key = 'maxUploadSize'", [maxUploadSize]);
        await db.run("UPDATE settings SET value = ? WHERE key = 'enableAudioCompression'", [String(enableAudioCompression)]);
        res.json({ message: 'Settings updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update settings.' });
    }
});
apiRouter.post('/admin/update-app', authenticateToken, checkAdmin, (req, res) => {
    console.log(`[ADMIN UPDATE] - Admin user ${req.user.id} initiated an update.`);
    const command = `git pull && npm install`;
    exec(command, { cwd: APP_DIR }, (error, stdout, stderr) => {
        const fullOutput = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
        console.log(`[ADMIN UPDATE] - Full Output:\n${fullOutput}`);
        if (error) {
            console.error(`[ADMIN UPDATE] - Execution Error: ${error.message}`);
            return res.status(500).json({ message: "Update script failed.", error: error.message, output: fullOutput });
        }
        res.status(200).json({ message: "Update successful! Restarting server...", output: fullOutput });
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

// Use the apiRouter for all /api routes
app.use('/api', apiRouter);

// --- STATIC ASSETS & SPA FALLBACK ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'study-app.html'));
});

// --- SERVER STARTUP ---
async function startServer() {
    console.log('Attempting to start the server...');
    try {
        await initializeDatabase();
        console.log('Database initialized successfully.');

        const sslOptions = {
            key: fs.readFileSync(path.join(__dirname, 'key.pem')),
            cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
        };

        https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server is up and running at https://localhost:${PORT}`);
            console.log(`   Accessible on your local network at https://<your-ip-address>:${PORT}`);
        }).on('error', (err) => {
            console.error('❌ SERVER STARTUP FAILED:', err);
            if (err.code === 'ENOENT') {
                console.error('   Could not find key.pem or cert.pem. Please generate them using the OpenSSL command.');
            }
            process.exit(1);
        });

    } catch (error) {
        console.error('❌ An error occurred during server startup:', error);
        process.exit(1);
    }
}

startServer();
