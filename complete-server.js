const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Create uploads directory
const uploadsDir = 'uploads';
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.static('.'));
app.use('/uploads', express.static(uploadsDir));

// Multer setup
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Database connection
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database
const initDB = async () => {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            points INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,
            suspended INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.query(`CREATE TABLE IF NOT EXISTS quiz_results (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            score INTEGER,
            carbon_footprint REAL,
            answers TEXT,
            completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.query(`CREATE TABLE IF NOT EXISTS rewards (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            points INTEGER,
            description TEXT,
            earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.query(`CREATE TABLE IF NOT EXISTS submissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            filename TEXT,
            description TEXT,
            status TEXT DEFAULT 'pending',
            points INTEGER DEFAULT 0,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TIMESTAMP
        )`);
        
        console.log('Database initialized');
    } catch (err) {
        console.error('Database init error:', err);
    }
};

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
        
        const result = await db.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id',
            [username, email, hashedPassword]
        );
        
        const userId = result.rows[0].id;
        const token = jwt.sign({ id: userId, username }, JWT_SECRET);
        
        res.json({ 
            token, 
            user: { id: userId, username, email, points: 0, level: 1 }
        });
    } catch (error) {
        res.status(400).json({ error: 'Username or email already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        
        if (!user) {
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
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, username, email, points, level FROM users WHERE id = $1',
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

app.post('/api/quiz/submit', authenticateToken, async (req, res) => {
    const { score, carbonFootprint, answers } = req.body;
    const points = 10;
    
    try {
        await db.query('BEGIN');
        
        await db.query(
            'INSERT INTO quiz_results (user_id, score, carbon_footprint, answers) VALUES ($1, $2, $3, $4)',
            [req.user.id, score, carbonFootprint, JSON.stringify(answers)]
        );
        
        await db.query(
            'UPDATE users SET points = points + $1 WHERE id = $2',
            [points, req.user.id]
        );
        
        await db.query(
            'INSERT INTO rewards (user_id, points, description) VALUES ($1, $2, $3)',
            [req.user.id, points, 'Completed carbon footprint quiz']
        );
        
        await db.query('COMMIT');
        res.json({ success: true, points });
    } catch (error) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: 'Quiz submission failed' });
    }
});

app.get('/api/rewards', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM rewards WHERE user_id = $1 ORDER BY earned_at DESC LIMIT 10',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load rewards' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT username, points, level FROM users WHERE suspended = 0 ORDER BY points DESC LIMIT 10'
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

app.post('/api/submit', authenticateToken, upload.single('file'), async (req, res) => {
    const { description } = req.body;
    const filename = req.file ? req.file.filename : null;
    
    if (!filename) {
        return res.status(400).json({ error: 'File required' });
    }
    
    try {
        const result = await db.query(
            'INSERT INTO submissions (user_id, filename, description) VALUES ($1, $2, $3) RETURNING id',
            [req.user.id, filename, description]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ error: 'Submission failed' });
    }
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

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.*, COUNT(qr.id) as quiz_count
            FROM users u 
            LEFT JOIN quiz_results qr ON u.id = qr.user_id 
            GROUP BY u.id 
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

const PORT = process.env.PORT || 3000;

// Start server after DB init
initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`EcoTrack server running on port ${PORT}`);
        console.log(`Admin password: ${ADMIN_PASSWORD}`);
    });
});
