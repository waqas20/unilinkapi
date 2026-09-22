import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const router = express.Router();

// JWT secret - in production, use environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'fgkjdfg890780we9fjsdkjsdyw39%^sdffsdfsddf';
const JWT_EXPIRES_IN = '24h';

// Validation helpers
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Register new user
router.post('/register', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { name, email, password, role } = req.body;
    
    // Validate required fields
    if (!name || !email || !password || !role) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate name length
    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Name must be at least 3 characters long' 
      });
    }

    // Validate password length
    if (password.length < 6) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Password must be at least 6 characters long' 
      });
    }

    // Validate role
    const validRoles = ['admin', 'client', 'consultant'];
    if (!validRoles.includes(role)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid role. Must be admin, client, or consultant' 
      });
    }
    
    // Check if email already exists
    const [existingUser] = await connection.query(
      'SELECT id, email FROM users WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A user with this email already exists' 
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Insert user
    const [result] = await connection.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [trimmedName, trimmedEmail, hashedPassword, role]
    );
    
    const userId = result.insertId;
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      userId: userId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error registering user:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred during registration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }
    
    // Find user by email (allowed_modules / status may not exist on older DBs)
    let users;
    try {
      const [rows] = await pool.query(
        'SELECT id, name, email, password, role, status, allowed_modules, created_at FROM users WHERE email = ?',
        [trimmedEmail]
      );
      users = rows;
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        const [rows] = await pool.query(
          'SELECT id, name, email, password, role, created_at FROM users WHERE email = ?',
          [trimmedEmail]
        );
        users = rows;
      } else {
        throw err;
      }
    }
    
    if (users.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }
    
    const user = users[0];

    if (user.status && String(user.status).toLowerCase() === 'inactive') {
      return res.status(403).json({
        success: false,
        message: 'This account is inactive. Please contact an administrator.'
      });
    }
    
    // Compare password
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }

    let allowedModules = [];
    if (user.role === 'staff') {
      try {
        allowedModules = user.allowed_modules
          ? (typeof user.allowed_modules === 'string'
            ? JSON.parse(user.allowed_modules)
            : user.allowed_modules)
          : [];
        if (!Array.isArray(allowedModules)) allowedModules = [];
      } catch {
        allowedModules = [];
      }
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role,
        allowed_modules: allowedModules
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    
    // Remove password from response
    delete user.password;
    user.allowed_modules = user.role === 'staff' ? allowedModules : null;
    
    res.json({
      success: true,
      message: 'Login successful',
      token: token,
      user: user
    });
    
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred during login',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Verify token (optional - for checking if user is still authenticated)
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'No token provided' 
      });
    }
    
    const token = authHeader.substring(7);
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get fresh user data
    const [users] = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = ?',
      [decoded.userId]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    res.json({
      success: true,
      user: users[0]
    });
    
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token' 
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired' 
      });
    }
    
    console.error('Error verifying token:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred during verification',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;