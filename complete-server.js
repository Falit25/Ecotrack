const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

const app = express();
const JWT_SECRET = 'your-secret-key-change-this';
const ADMIN_PASSWORD = 'admin123'; // Change this

// Middleware
app.use(express.json());
app.use(express.static('.'));
app.use('/uploads', express.static(uploadsDir));

// Create uploads directory for Render
const uploadsDir = process.env.NODE_ENV === 'production' 
    ? '/opt/render/project/data/uploads'
    : 'uploads';

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Initialize database for Render persistent disk
const dbPath = process.env.NODE_ENV === 'production' 
    ? '/opt/render/project/data/ecotrack.db'
    : path.join(os.homedir(), 'ecotrack-data', 'ecotrack.db');

// Create data directory if it doesn't exist
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        points INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        suspended INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS quiz_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        score INTEGER,
        carbon_footprint REAL,
        answers TEXT,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        points INTEGER,
        description TEXT,
        earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        description TEXT,
        status TEXT DEFAULT 'pending',
        points INTEGER DEFAULT 0,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
});

// Auth middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// Routes
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', 
            [username, email, hashedPassword], function(err) {
            if (err) {
                return res.status(400).json({ error: 'Username or email already exists' });
            }
            
            const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET);
            res.json({ 
                token, 
                user: { id: this.lastID, username, email, points: 0, level: 1 }
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.suspended) {
            return res.status(403).json({ error: 'Account suspended' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ 
            token, 
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email, 
                points: user.points, 
                level: user.level 
            }
        });
    });
});

app.get('/api/profile', authenticateToken, (req, res) => {
    db.get('SELECT id, username, email, points, level FROM users WHERE id = ?', 
        [req.user.id], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    });
});

app.post('/api/quiz/submit', authenticateToken, (req, res) => {
    const { score, carbonFootprint, answers } = req.body;
    const points = 10; // Points for completing quiz
    
    db.serialize(() => {
        db.run('INSERT INTO quiz_results (user_id, score, carbon_footprint, answers) VALUES (?, ?, ?, ?)',
            [req.user.id, score, carbonFootprint, JSON.stringify(answers)]);
        
        db.run('UPDATE users SET points = points + ? WHERE id = ?', [points, req.user.id]);
        
        db.run('INSERT INTO rewards (user_id, points, description) VALUES (?, ?, ?)',
            [req.user.id, points, 'Completed carbon footprint quiz']);
    });
    
    res.json({ success: true, points });
});

app.get('/api/rewards', authenticateToken, (req, res) => {
    db.all('SELECT * FROM rewards WHERE user_id = ? ORDER BY earned_at DESC LIMIT 10',
        [req.user.id], (err, rewards) => {
        if (err) return res.status(500).json({ error: 'Failed to load rewards' });
        res.json(rewards);
    });
});

app.get('/api/leaderboard', (req, res) => {
    db.all('SELECT username, points, level FROM users WHERE suspended = 0 ORDER BY points DESC LIMIT 10',
        (err, users) => {
        if (err) return res.status(500).json({ error: 'Failed to load leaderboard' });
        res.json(users);
    });
});

app.post('/api/submit', authenticateToken, upload.single('file'), (req, res) => {
    const { description } = req.body;
    const filename = req.file ? req.file.filename : null;
    
    if (!filename) {
        return res.status(400).json({ error: 'File required' });
    }
    
    db.run('INSERT INTO submissions (user_id, filename, description) VALUES (?, ?, ?)',
        [req.user.id, filename, description], function(err) {
        if (err) return res.status(500).json({ error: 'Submission failed' });
        res.json({ success: true, id: this.lastID });
    });
});

// Admin routes
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ admin: true }, JWT_SECRET);
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid admin password' });
    }
});

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err || !decoded.admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
};

app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    db.all(`SELECT u.*, 
            COUNT(qr.id) as quiz_count
            FROM users u 
            LEFT JOIN quiz_results qr ON u.id = qr.user_id 
            GROUP BY u.id 
            ORDER BY u.created_at DESC`, (err, users) => {
        if (err) return res.status(500).json({ error: 'Failed to load users' });
        res.json(users);
    });
});

app.get('/api/admin/user/:id', authenticateAdmin, (req, res) => {
    const userId = req.params.id;
    
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        
        db.all('SELECT * FROM quiz_results WHERE user_id = ? ORDER BY completed_at DESC',
            [userId], (err, quizzes) => {
            
            db.all('SELECT * FROM rewards WHERE user_id = ? ORDER BY earned_at DESC',
                [userId], (err, rewards) => {
                
                res.json({ user, quizzes, rewards });
            });
        });
    });
});

app.delete('/api/admin/user/:id', authenticateAdmin, (req, res) => {
    const userId = req.params.id;
    
    db.serialize(() => {
        db.run('DELETE FROM rewards WHERE user_id = ?', [userId]);
        db.run('DELETE FROM quiz_results WHERE user_id = ?', [userId]);
        db.run('DELETE FROM submissions WHERE user_id = ?', [userId]);
        db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to delete user' });
            res.json({ success: true });
        });
    });
});

app.put('/api/admin/user/:id/suspend', authenticateAdmin, (req, res) => {
    const userId = req.params.id;
    const { suspended } = req.body;
    
    db.run('UPDATE users SET suspended = ? WHERE id = ?', [suspended ? 1 : 0, userId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update user' });
        res.json({ success: true });
    });
});

app.get('/api/admin/submissions', authenticateAdmin, (req, res) => {
    db.all(`SELECT s.*, u.username 
            FROM submissions s 
            LEFT JOIN users u ON s.user_id = u.id 
            ORDER BY s.submitted_at DESC`, (err, submissions) => {
        if (err) return res.status(500).json({ error: 'Failed to load submissions' });
        res.json(submissions);
    });
});

app.put('/api/admin/submission/:id/approve', authenticateAdmin, (req, res) => {
    const submissionId = req.params.id;
    const { points } = req.body;
    
    db.serialize(() => {
        db.get('SELECT * FROM submissions WHERE id = ?', [submissionId], (err, submission) => {
            if (err || !submission) {
                return res.status(404).json({ error: 'Submission not found' });
            }
            
            db.run('UPDATE submissions SET status = ?, points = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['approved', points, submissionId]);
            
            db.run('UPDATE users SET points = points + ? WHERE id = ?', [points, submission.user_id]);
            
            db.run('INSERT INTO rewards (user_id, points, description) VALUES (?, ?, ?)',
                [submission.user_id, points, 'Evidence submission approved']);
        });
    });
    
    res.json({ success: true });
});

app.put('/api/admin/submission/:id/reject', authenticateAdmin, (req, res) => {
    const submissionId = req.params.id;
    
    db.run('UPDATE submissions SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['rejected', submissionId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to reject submission' });
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`EcoTrack server running on port ${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
