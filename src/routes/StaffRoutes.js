import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fgkjdfg890780we9fjsdkjsdyw39%^sdffsdfsddf';

const APP_MODULE_KEYS = [
  'dashboard',
  'leads',
  'students',
  'counselors',
  'applications',
  'visas',
  'finance',
  'visitor_logs',
  'employees',
  'master_data',
  'staff_users'
];

const parseAllowedModules = (value) => {
  let list = [];
  if (!value) list = [];
  else if (Array.isArray(value)) list = value.map(String).filter(k => APP_MODULE_KEYS.includes(k));
  else {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (Array.isArray(parsed)) {
        list = parsed.map(String).filter(k => APP_MODULE_KEYS.includes(k));
      } else if (parsed && typeof parsed === 'object') {
        list = Object.keys(parsed).filter(k => parsed[k] && APP_MODULE_KEYS.includes(k));
      }
    } catch {
      list = [];
    }
  }
  if (!list.includes('dashboard')) list = ['dashboard', ...list];
  return list;
};

const serializeAllowedModules = (modules) => {
  const list = parseAllowedModules(modules);
  return JSON.stringify(list);
};

const ensureStaffSchema = async () => {
  try {
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS allowed_modules TEXT NULL
    `);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      try {
        await pool.query('ALTER TABLE users ADD COLUMN allowed_modules TEXT NULL');
      } catch (err2) {
        if (err2.code !== 'ER_DUP_FIELDNAME') {
          console.warn('allowed_modules column ensure:', err2.message);
        }
      }
    }
  }

  // Ensure role column accepts 'staff'
  try {
    await pool.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL`);
  } catch (err) {
    console.warn('users.role widen:', err.message);
  }
};

const requireStaffManager = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
    const modules = Array.isArray(decoded.allowed_modules) ? decoded.allowed_modules : [];
    const allowed =
      decoded.role === 'admin' ||
      (decoded.role === 'staff' && modules.includes('staff_users'));
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Only admins can manage staff users' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const sanitizeUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  status: row.status || 'Active',
  allowed_modules: parseAllowedModules(row.allowed_modules),
  created_at: row.created_at,
  updated_at: row.updated_at || null
});

// List admin + staff users
router.get('/staff-users', requireStaffManager, async (req, res) => {
  try {
    await ensureStaffSchema();
    const [rows] = await pool.query(
      `SELECT id, name, email, role, status, allowed_modules, created_at
       FROM users
       WHERE role IN ('admin', 'staff')
       ORDER BY FIELD(role, 'admin', 'staff'), name ASC`
    );
    res.json({
      success: true,
      users: rows.map(sanitizeUser),
      total: rows.length
    });
  } catch (error) {
    console.error('Error listing staff users:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch staff users' });
  }
});

// Create staff user
router.post('/staff-users', requireStaffManager, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureStaffSchema();
    await connection.beginTransaction();

    const { name, email, password, allowedModules, status } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    }
    if (String(password).length < 6) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    const modulesJson = serializeAllowedModules(allowedModules);
    const userStatus = status === 'Inactive' ? 'Inactive' : 'Active';

    const [existing] = await connection.query('SELECT id FROM users WHERE email = ?', [trimmedEmail]);
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    let result;
    try {
      [result] = await connection.query(
        `INSERT INTO users (name, email, password, plain_password, role, status, allowed_modules)
         VALUES (?, ?, ?, ?, 'staff', ?, ?)`,
        [trimmedName, trimmedEmail, hashedPassword, String(password), userStatus, modulesJson]
      );
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await connection.query(
          `INSERT INTO users (name, email, password, role, allowed_modules)
           VALUES (?, ?, ?, 'staff', ?)`,
          [trimmedName, trimmedEmail, hashedPassword, modulesJson]
        );
      } else {
        throw err;
      }
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Staff user created successfully',
      user: {
        id: result.insertId,
        name: trimmedName,
        email: trimmedEmail,
        role: 'staff',
        status: userStatus,
        allowed_modules: parseAllowedModules(modulesJson)
      }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating staff user:', error);
    res.status(500).json({ success: false, message: 'Failed to create staff user' });
  } finally {
    connection.release();
  }
});

// Update staff user (modules / profile / password). Admins: modules not editable (always full access).
router.put('/staff-users/:userId', requireStaffManager, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureStaffSchema();
    await connection.beginTransaction();

    const { userId } = req.params;
    const { name, email, password, allowedModules, status } = req.body;

    const [rows] = await connection.query(
      'SELECT id, role, email FROM users WHERE id = ? AND role IN (\'admin\', \'staff\')',
      [userId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const target = rows[0];
    const trimmedName = name?.trim();
    const trimmedEmail = email?.trim()?.toLowerCase();

    if (trimmedEmail && trimmedEmail !== target.email) {
      const [dup] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [trimmedEmail, userId]
      );
      if (dup.length > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'Email already in use' });
      }
    }

    const updates = [];
    const params = [];

    if (trimmedName) {
      updates.push('name = ?');
      params.push(trimmedName);
    }
    if (trimmedEmail) {
      updates.push('email = ?');
      params.push(trimmedEmail);
    }
    if (status === 'Active' || status === 'Inactive') {
      updates.push('status = ?');
      params.push(status);
    }

    // Only staff get module ACLs; admins always have full access
    if (target.role === 'staff' && allowedModules !== undefined) {
      updates.push('allowed_modules = ?');
      params.push(serializeAllowedModules(allowedModules));
    }

    if (password && String(password).length >= 6) {
      const hashed = await bcrypt.hash(String(password), 10);
      updates.push('password = ?');
      params.push(hashed);
      try {
        await connection.query('UPDATE users SET plain_password = ? WHERE id = ?', [String(password), userId]);
      } catch {
        /* plain_password may not exist */
      }
    } else if (password && String(password).length > 0 && String(password).length < 6) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    if (updates.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    params.push(userId);
    await connection.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const [updated] = await connection.query(
      `SELECT id, name, email, role, status, allowed_modules, created_at FROM users WHERE id = ?`,
      [userId]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'User updated successfully',
      user: sanitizeUser(updated[0])
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating staff user:', error);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  } finally {
    connection.release();
  }
});

// Delete staff user only (never delete admins via this endpoint)
router.delete('/staff-users/:userId', requireStaffManager, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { userId } = req.params;

    if (String(req.user.userId) === String(userId)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    const [rows] = await pool.query(
      'SELECT id, role FROM users WHERE id = ?',
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (rows[0].role !== 'staff') {
      return res.status(400).json({ success: false, message: 'Only staff users can be deleted from this module' });
    }

    await pool.query('DELETE FROM users WHERE id = ? AND role = ?', [userId, 'staff']);
    res.json({ success: true, message: 'Staff user deleted successfully' });
  } catch (error) {
    console.error('Error deleting staff user:', error);
    res.status(500).json({ success: false, message: 'Failed to delete staff user' });
  }
});

export default router;
