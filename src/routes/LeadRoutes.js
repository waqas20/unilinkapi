import express from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool from '../config/db.js';

const router = express.Router();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/meeting-notes');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'meeting-note-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, JPG, PNG, GIF) and PDFs are allowed'));
    }
  }
});

// Validation helper functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  // Accepts formats like: +92 300 1234567, 03001234567, etc.
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

// Generate random password
const generatePassword = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// Create new lead (First Time Query)
router.post('/leads', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { fullName, email, phone, address, interest, comments } = req.body;
    
    // Validate required fields
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
      });
    }

    // Validate name length
    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Full name must be at least 3 characters long' 
      });
    }

    // Validate address length
    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a complete address (minimum 10 characters)' 
      });
    }
    
    // Check if email already exists
    const [existingLead] = await connection.query(
      'SELECT id, full_name, email FROM leads WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingLead.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A lead with this email address already exists. Please use the Follow Up option to update your information.',
        existingLead: {
          name: existingLead[0].full_name,
          email: existingLead[0].email
        }
      });
    }
    
    // Insert lead
    const [result] = await connection.query(
      `INSERT INTO leads (full_name, email, phone, address, interest, comments, is_follow_up, status)
       VALUES (?, ?, ?, ?, ?, ?, FALSE, 'New')`,
      [trimmedName, trimmedEmail, trimmedPhone, address.trim(), interest, comments?.trim() || null]
    );
    
    const leadId = result.insertId;
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Your Form has been submitted successfully!',
      leadId: leadId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating lead:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while submitting your registration. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Lookup lead for follow-up
router.post('/leads/lookup', async (req, res) => {
  try {
    const { lookupName, lookupEmail } = req.body;
    
    if (!lookupName || !lookupEmail) {
      return res.status(400).json({ 
        success: false, 
        message: 'Both name and email are required to lookup your information' 
      });
    }

    const trimmedEmail = lookupEmail.trim().toLowerCase();
    const trimmedName = lookupName.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }
    
    const [leads] = await pool.query(
      `SELECT id, full_name, email, phone, address, interest, comments, 
              (SELECT COUNT(*) FROM follow_ups WHERE lead_id = leads.id) as follow_up_count,
              created_at, updated_at
       FROM leads 
       WHERE LOWER(TRIM(full_name)) = LOWER(?) AND LOWER(TRIM(email)) = LOWER(?)
       ORDER BY created_at DESC
       LIMIT 1`,
      [trimmedName, trimmedEmail]
    );
    
    if (leads.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No record found with the provided name and email. Please check your information or submit a new registration.' 
      });
    }
    
    res.json({
      success: true,
      message: 'Your information has been retrieved successfully',
      lead: leads[0]
    });
    
  } catch (error) {
    console.error('Error looking up lead:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while looking up your information. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create follow-up and track changes
router.post('/leads/:leadId/follow-up', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const { fullName, email, phone, address, interest, comments } = req.body;
    
    // Validate required fields
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
      });
    }

    // Validate name length
    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Full name must be at least 3 characters long' 
      });
    }

    // Validate address length
    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a complete address (minimum 10 characters)' 
      });
    }
    
    // Get current lead data
    const [currentLead] = await connection.query(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (currentLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Lead record not found' 
      });
    }
    
    const oldData = currentLead[0];

    // Check if email is being changed to one that already exists (for a different lead)
    if (trimmedEmail !== oldData.email.toLowerCase()) {
      const [emailCheck] = await connection.query(
        'SELECT id FROM leads WHERE email = ? AND id != ?',
        [trimmedEmail, leadId]
      );
      
      if (emailCheck.length > 0) {
        await connection.rollback();
        return res.status(409).json({ 
          success: false, 
          message: 'This email address is already associated with another record. Please use a different email.' 
        });
      }
    }
    
    // Get follow-up count
    const [followUpCount] = await connection.query(
      'SELECT COUNT(*) as count FROM follow_ups WHERE lead_id = ?',
      [leadId]
    );
    
    const nextFollowUpNumber = followUpCount[0].count + 1;
    
    // Insert follow-up record
    const [followUpResult] = await connection.query(
      'INSERT INTO follow_ups (lead_id, follow_up_number, notes) VALUES (?, ?, ?)',
      [leadId, nextFollowUpNumber, `Follow-up #${nextFollowUpNumber} - Updated information`]
    );
    
    const followUpId = followUpResult.insertId;
    
    // Track changes
    const changes = [];
    const fieldsToTrack = {
      fullName: 'full_name',
      email: 'email',
      phone: 'phone',
      address: 'address',
      interest: 'interest',
      comments: 'comments'
    };

    const newValues = {
      fullName: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      address: address.trim(),
      interest: interest,
      comments: comments?.trim() || null
    };
    
    for (const [requestField, dbField] of Object.entries(fieldsToTrack)) {
      const newValue = newValues[requestField];
      const oldValue = oldData[dbField];
      
      // Compare values (handle null/empty string cases)
      const oldVal = oldValue === null ? '' : String(oldValue).trim();
      const newVal = newValue === null ? '' : String(newValue).trim();
      
      if (newVal !== oldVal) {
        changes.push([
          leadId,
          followUpId,
          dbField,
          oldValue,
          newValue
        ]);
      }
    }
    
    // Insert change records
    if (changes.length > 0) {
      await connection.query(
        `INSERT INTO lead_changes (lead_id, follow_up_id, field_name, old_value, new_value)
         VALUES ?`,
        [changes]
      );
    }
    
    // Update lead with new data
    await connection.query(
      `UPDATE leads 
       SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, comments = ?, is_follow_up = TRUE
       WHERE id = ?`,
      [trimmedName, trimmedEmail, trimmedPhone, address.trim(), interest, comments?.trim() || null, leadId]
    );
    
    await connection.commit();
    
    const changeMessage = changes.length > 0 
      ? ` ${changes.length} field(s) were updated.` 
      : ' No changes were detected from your previous submission.';
    
    res.json({
        success: true,
        message: `Follow-up recorded successfully!`,
        followUpNumber: nextFollowUpNumber
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating follow-up:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while submitting your follow-up. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Get lead history with all follow-ups and changes
router.get('/leads/:leadId/history', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    // Get lead info
    const [lead] = await pool.query(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (lead.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }
    
    // Get all follow-ups
    const [followUps] = await pool.query(
      'SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY followed_up_at DESC',
      [leadId]
    );
    
    // Get all changes
    const [changes] = await pool.query(
      `SELECT lc.*, fu.follow_up_number, fu.followed_up_at
       FROM lead_changes lc
       LEFT JOIN follow_ups fu ON lc.follow_up_id = fu.id
       WHERE lc.lead_id = ?
       ORDER BY lc.changed_at DESC`,
      [leadId]
    );
    
    res.json({
      success: true,
      lead: lead[0],
      followUps: followUps,
      changes: changes
    });
    
  } catch (error) {
    console.error('Error fetching lead history:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch lead history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all leads that have follow-ups (must come before /leads/:leadId to avoid route conflict)
router.get('/leads/followups', async (req, res) => {
  try {
    const [followups] = await pool.query(
      `SELECT l.*, 
              COUNT(DISTINCT fu.id) as follow_up_count,
              MAX(fu.followed_up_at) as last_follow_up
       FROM leads l
       INNER JOIN follow_ups fu ON l.id = fu.lead_id
       GROUP BY l.id
       HAVING follow_up_count > 0
       ORDER BY last_follow_up DESC`
    );
    
    res.json({
      success: true,
      followups: followups,
      total: followups.length
    });
    
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch follow-ups',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all leads with follow-up counts
router.get('/leads', async (req, res) => {
  try {
    const [leads] = await pool.query(
        `SELECT l.*, 
                COUNT(DISTINCT fu.id) as follow_up_count,
                MAX(fu.followed_up_at) as last_follow_up,
                COUNT(DISTINCT lca.counselor_id) as counselor_count
        FROM leads l
        LEFT JOIN follow_ups fu ON l.id = fu.lead_id
        LEFT JOIN lead_counselor_assignments lca ON l.id = lca.lead_id
        GROUP BY l.id
        ORDER BY l.created_at DESC`
    );
    
    res.json({
      success: true,
      leads: leads,
      total: leads.length
    });
    
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch leads',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single lead by ID
router.get('/leads/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    const [leads] = await pool.query(
      `SELECT l.*, 
              COUNT(DISTINCT fu.id) as follow_up_count,
              MAX(fu.followed_up_at) as last_follow_up
       FROM leads l
       LEFT JOIN follow_ups fu ON l.id = fu.lead_id
       WHERE l.id = ?
       GROUP BY l.id`,
      [leadId]
    );
    
    if (leads.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }
    
    res.json({
      success: true,
      lead: leads[0]
    });
    
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch lead',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update lead information
router.put('/leads/:leadId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const { fullName, email, phone, address, interest, comments, status } = req.body;
    
    // Validate required fields
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
      });
    }

    // Check if lead exists
    const [existingLead] = await connection.query(
      'SELECT id FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (existingLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }

    // Check if email is being changed to one that already exists
    const [emailCheck] = await connection.query(
      'SELECT id FROM leads WHERE email = ? AND id != ?',
      [trimmedEmail, leadId]
    );
    
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This email address is already associated with another lead' 
      });
    }
    
    // Update lead
    await connection.query(
      `UPDATE leads 
       SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, comments = ?, status = ?
       WHERE id = ?`,
      [trimmedName, trimmedEmail, trimmedPhone, address.trim(), interest, comments?.trim() || null, status || 'New', leadId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Lead updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating lead:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the lead',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Register lead as student
router.post('/leads/:leadId/register-student', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    
    // Get lead information
    const [leads] = await connection.query(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (leads.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }
    
    const lead = leads[0];
    
    // Check if already registered
    if (lead.is_registered) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'This lead is already registered as a student' 
      });
    }
    
    // Check if user with this email already exists
    const [existingUser] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [lead.email]
    );
    
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A user with this email already exists in the system' 
      });
    }
    
    // **ADD THIS: Generate student ID**
    const currentYear = new Date().getFullYear();
    const [result] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING(student_id, 8) AS UNSIGNED)) as max_id 
       FROM users 
       WHERE student_id LIKE 'STU${currentYear}%' AND role = 'client'`
    );
    
    const nextId = (result[0].max_id || 0) + 1;
    const studentId = `STU${currentYear}${String(nextId).padStart(3, '0')}`;
    
    // Generate random password
    const generatedPassword = generatePassword(12);
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(generatedPassword, saltRounds);
    
    // **MODIFY THIS: Create user account with student_id**
    const [userResult] = await connection.query(
      'INSERT INTO users (student_id, name, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [studentId, lead.full_name, lead.email, hashedPassword, 'client']
    );
    
    const userId = userResult.insertId;
    
    // Transfer counselor assignments from lead to student
    const [assignedCounselors] = await connection.query(
      'SELECT counselor_id FROM lead_counselor_assignments WHERE lead_id = ?',
      [leadId]
    );
    
    if (assignedCounselors.length > 0) {
      const studentCounselorValues = assignedCounselors.map(c => [
        userId, 
        c.counselor_id, 
        leadId
      ]);
      
      await connection.query(
        'INSERT INTO student_counselors (user_id, counselor_id, transferred_from_lead_id) VALUES ?',
        [studentCounselorValues]
      );
    }
    
    // Update meetings to reference the new user instead of lead
    await connection.query(
      'UPDATE counselor_meetings SET user_id = ?, lead_id = NULL WHERE lead_id = ?',
      [userId, leadId]
    );
    
    // Mark lead as registered
    await connection.query(
      'UPDATE leads SET is_registered = TRUE, registered_at = NOW() WHERE id = ?',
      [leadId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Lead successfully registered as student',
      userId: userId,
      counselorsTransferred: assignedCounselors.length,
      credentials: {
        email: lead.email,
        password: generatedPassword
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error registering lead as student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while registering the student',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============ COUNSELOR ASSIGNMENT ENDPOINTS ============

// Get assigned counselors for a lead
router.get('/leads/:leadId/counselors', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    const [counselors] = await pool.query(
      `SELECT c.*, lca.assigned_at, lca.notes as assignment_notes
       FROM counselors c
       INNER JOIN lead_counselor_assignments lca ON c.id = lca.counselor_id
       WHERE lca.lead_id = ?
       ORDER BY lca.assigned_at DESC`,
      [leadId]
    );
    
    res.json({
      success: true,
      counselors: counselors
    });
    
  } catch (error) {
    console.error('Error fetching lead counselors:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch assigned counselors',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Assign counselor to lead
router.post('/leads/:leadId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const { counselorId, notes } = req.body;
    
    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Counselor ID is required' 
      });
    }
    
    // Check if lead exists
    const [lead] = await connection.query(
      'SELECT id FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }
    
    // Check if counselor exists
    const [counselor] = await connection.query(
      'SELECT id FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (counselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Check if already assigned
    const [existing] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This counselor is already assigned to this lead' 
      });
    }
    
    // Assign counselor
    await connection.query(
      'INSERT INTO lead_counselor_assignments (lead_id, counselor_id, notes) VALUES (?, ?, ?)',
      [leadId, counselorId, notes || null]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor assigned successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error assigning counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while assigning counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Remove counselor assignment from lead
router.delete('/leads/:leadId/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId, counselorId } = req.params;
    
    const [result] = await connection.query(
      'DELETE FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Assignment not found' 
      });
    }
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor removed successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error removing counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while removing counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============ MEETING ENDPOINTS ============

// Get available time slots for a counselor on a specific date
router.get('/counselors/:counselorId/available-slots', async (req, res) => {
  try {
    const { counselorId } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ 
        success: false, 
        message: 'Date parameter is required' 
      });
    }
    
    // Get all meetings for the counselor on that date
    const [meetings] = await pool.query(
      `SELECT meeting_time, duration_minutes 
       FROM counselor_meetings 
       WHERE counselor_id = ? AND meeting_date = ? AND status != 'Cancelled'
       ORDER BY meeting_time`,
      [counselorId, date]
    );
    
    // Convert meetings to time blocks
    const bookedSlots = meetings.map(meeting => {
      const [hours, minutes] = meeting.meeting_time.split(':');
      const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
      const endMinutes = startMinutes + meeting.duration_minutes;
      
      return {
        start: startMinutes,
        end: endMinutes
      };
    });
    
    res.json({
      success: true,
      bookedSlots: bookedSlots
    });
    
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch available slots',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get meetings for a lead
router.get('/leads/:leadId/meetings', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email,
              l.full_name as lead_name
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       LEFT JOIN leads l ON cm.lead_id = l.id
       WHERE cm.lead_id = ?
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [leadId]
    );
    
    res.json({
      success: true,
      meetings: meetings
    });
    
  } catch (error) {
    console.error('Error fetching lead meetings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch meetings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Schedule meeting for lead with counselor
router.post('/leads/:leadId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;
    
    // Validate required fields
    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }
    
    // Validate duration
    if (durationMinutes < 15 || durationMinutes > 480) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Duration must be between 15 minutes and 8 hours' 
      });
    }
    
    // Check if counselor is assigned to this lead
    const [assignment] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'This counselor is not assigned to this lead' 
      });
    }
    
    // Get lead info
    const [lead] = await connection.query(
      'SELECT full_name FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Lead not found' 
      });
    }
    
    // Check for time conflicts
    const [hours, minutes] = meetingTime.split(':');
    const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
    const endMinutes = startMinutes + parseInt(durationMinutes);
    
    // Validate business hours (9 AM to 5 PM = 540 to 1020 minutes)
    if (startMinutes < 540 || endMinutes > 1020) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Meetings must be scheduled between 9:00 AM and 5:00 PM' 
      });
    }
    
    // Check for overlapping meetings
    const [conflicts] = await connection.query(
      `SELECT id, meeting_time, duration_minutes
       FROM counselor_meetings
       WHERE counselor_id = ? 
       AND meeting_date = ? 
       AND status != 'Cancelled'`,
      [counselorId, meetingDate]
    );
    
    for (const meeting of conflicts) {
      const [mHours, mMinutes] = meeting.meeting_time.split(':');
      const mStart = parseInt(mHours) * 60 + parseInt(mMinutes);
      const mEnd = mStart + meeting.duration_minutes;
      
      // Check if there's an overlap
      if ((startMinutes >= mStart && startMinutes < mEnd) ||
          (endMinutes > mStart && endMinutes <= mEnd) ||
          (startMinutes <= mStart && endMinutes >= mEnd)) {
        await connection.rollback();
        return res.status(409).json({ 
          success: false, 
          message: `This time slot conflicts with an existing meeting from ${meeting.meeting_time} (${meeting.duration_minutes} minutes)` 
        });
      }
    }
    
    // Insert meeting
    await connection.query(
      `INSERT INTO counselor_meetings 
       (counselor_id, lead_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, leadId, lead[0].full_name, `LEAD-${leadId}`, meetingDate, meetingTime, durationMinutes, notes || null]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Meeting scheduled successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error scheduling meeting:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while scheduling the meeting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update meeting notes and upload image (for counselors)
router.put('/meetings/:meetingId/notes', upload.single('notesImage'), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { meetingId } = req.params;
    const { notes, status } = req.body;
    const notesImage = req.file ? `/uploads/meeting-notes/${req.file.filename}` : null;
    
    // Check if meeting exists
    const [meeting] = await connection.query(
      'SELECT id, meeting_notes_image FROM counselor_meetings WHERE id = ?',
      [meetingId]
    );
    
    if (meeting.length === 0) {
      await connection.rollback();
      if (req.file) {
        fs.unlinkSync(req.file.path); // Delete uploaded file
      }
      return res.status(404).json({ 
        success: false, 
        message: 'Meeting not found' 
      });
    }
    
    // Delete old image if new one is uploaded
    if (notesImage && meeting[0].meeting_notes_image) {
      const oldImagePath = path.join(__dirname, '..', meeting[0].meeting_notes_image);
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }
    
    // Build update query
    let updateQuery = 'UPDATE counselor_meetings SET ';
    let updateValues = [];
    let updateFields = [];
    
    if (notes !== undefined) {
      updateFields.push('notes = ?');
      updateValues.push(notes);
    }
    
    if (notesImage) {
      updateFields.push('meeting_notes_image = ?');
      updateValues.push(notesImage);
    }
    
    if (status) {
      updateFields.push('status = ?');
      updateValues.push(status);
    }
    
    if (updateFields.length === 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No fields to update' 
      });
    }
    
    updateQuery += updateFields.join(', ') + ' WHERE id = ?';
    updateValues.push(meetingId);
    
    await connection.query(updateQuery, updateValues);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Meeting updated successfully',
      notesImageUrl: notesImage
    });
    
  } catch (error) {
    await connection.rollback();
    if (req.file) {
      fs.unlinkSync(req.file.path); // Delete uploaded file on error
    }
    console.error('Error updating meeting notes:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating meeting notes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

export default router;