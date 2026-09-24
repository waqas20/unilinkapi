import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fgkjdfg890780we9fjsdkjsdyw39%^sdffsdfsddf';

const authenticateClient = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
    if (decoded.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Student access only' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired. Please login again.' });
    }
    return res.status(403).json({ success: false, message: 'Invalid token' });
  }
};

const studentUserId = (req) => req.user.userId || req.user.id;

// GET /portal/me
router.get('/portal/me', authenticateClient, async (req, res) => {
  try {
    const userId = studentUserId(req);
    const [rows] = await pool.query(
      `SELECT id, name, email, student_id, mobile, status, profile_picture
       FROM users WHERE id = ? AND role = 'client' LIMIT 1`,
      [userId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Student profile not found' });
    }
    res.json({ success: true, student: rows[0] });
  } catch (error) {
    console.error('portal/me:', error);
    res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
});

// GET /portal/counselors — assigned counselors + their meetings with this student
router.get('/portal/counselors', authenticateClient, async (req, res) => {
  try {
    const userId = studentUserId(req);
    const [counselors] = await pool.query(
      `SELECT c.id, c.counselor_id, c.name, c.email, c.phone, c.expertise, c.status, sc.assigned_at
       FROM counselors c
       INNER JOIN student_counselors sc ON c.id = sc.counselor_id
       WHERE sc.user_id = ?
       ORDER BY sc.assigned_at DESC`,
      [userId]
    );

    const [meetings] = await pool.query(
      `SELECT cm.*, c.name AS counselor_name
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       WHERE cm.user_id = ?
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [userId]
    );

    const meetingsByCounselor = {};
    for (const m of meetings) {
      if (!meetingsByCounselor[m.counselor_id]) meetingsByCounselor[m.counselor_id] = [];
      meetingsByCounselor[m.counselor_id].push(m);
    }

    const result = counselors.map((c) => ({
      ...c,
      meetings: meetingsByCounselor[c.id] || [],
    }));

    res.json({ success: true, counselors: result });
  } catch (error) {
    console.error('portal/counselors:', error);
    res.status(500).json({ success: false, message: 'Failed to load counselors' });
  }
});

// GET /portal/applications
router.get('/portal/applications', authenticateClient, async (req, res) => {
  try {
    const userId = studentUserId(req);
    const [applications] = await pool.query(
      `SELECT a.id, a.application_id, a.application_date, a.program, a.application_status,
              a.tagging_status, a.intake, a.created_at,
              c.country_name, un.university_name
       FROM applications a
       LEFT JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       WHERE a.student_id = ?
       ORDER BY a.created_at DESC`,
      [userId]
    );
    res.json({ success: true, applications });
  } catch (error) {
    console.error('portal/applications:', error);
    res.status(500).json({ success: false, message: 'Failed to load applications' });
  }
});

// GET /portal/visas — by linked student id OR matching applicant email
router.get('/portal/visas', authenticateClient, async (req, res) => {
  try {
    const userId = studentUserId(req);
    const [users] = await pool.query(
      `SELECT id, email FROM users WHERE id = ? AND role = 'client' LIMIT 1`,
      [userId]
    );
    if (!users.length) {
      return res.status(404).json({ success: false, message: 'Student profile not found' });
    }
    const email = users[0].email;

    const [visas] = await pool.query(
      `SELECT v.id, v.visa_id, v.visa_type, v.visa_status, v.institute,
              v.submission_date, v.visa_appointment_date, v.created_at,
              COALESCE(v.applicant_name, u.name) AS applicant_name,
              COALESCE(v.applicant_email, u.email) AS applicant_email,
              c.country_name
       FROM visas v
       LEFT JOIN users u ON v.student_id = u.id
       LEFT JOIN countries c ON v.country_id = c.id
       WHERE v.student_id = ?
          OR LOWER(TRIM(COALESCE(v.applicant_email, ''))) = LOWER(TRIM(?))
       ORDER BY v.created_at DESC`,
      [userId, email]
    );
    res.json({ success: true, visas });
  } catch (error) {
    console.error('portal/visas:', error);
    res.status(500).json({ success: false, message: 'Failed to load visas' });
  }
});

export default router;
