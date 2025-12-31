import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';

const router = express.Router();

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
      message: `Follow-up #${nextFollowUpNumber} recorded successfully!${changeMessage} We will contact you shortly.`,
      followUpNumber: nextFollowUpNumber,
      changesTracked: changes.length
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

// Get all leads with follow-up counts
router.get('/leads', async (req, res) => {
  try {
    const [leads] = await pool.query(
      `SELECT l.*, 
              COUNT(DISTINCT fu.id) as follow_up_count,
              MAX(fu.followed_up_at) as last_follow_up
       FROM leads l
       LEFT JOIN follow_ups fu ON l.id = fu.lead_id
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
    
    // Generate random password
    const generatedPassword = generatePassword(12);
    
    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(generatedPassword, saltRounds);
    
    // Create user account
    const [userResult] = await connection.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [lead.full_name, lead.email, hashedPassword, 'client']
    );
    
    const userId = userResult.insertId;
    
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

export default router;