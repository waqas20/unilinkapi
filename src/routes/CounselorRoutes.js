import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Validation helper functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

// Generate counselor ID
const generateCounselorId = async (connection) => {
  const [result] = await connection.query(
    'SELECT MAX(CAST(SUBSTRING(counselor_id, 5) AS UNSIGNED)) as max_id FROM counselors'
  );
  
  const nextId = (result[0].max_id || 0) + 1;
  return `COUN${String(nextId).padStart(3, '0')}`;
};

// Get all counselors with meeting counts
router.get('/counselors', async (req, res) => {
  try {
    const [counselors] = await pool.query(
      `SELECT c.*, 
              COUNT(DISTINCT cm.id) as total_meetings,
              COUNT(DISTINCT CASE WHEN cm.status = 'Scheduled' THEN cm.id END) as scheduled_meetings,
              COUNT(DISTINCT CASE WHEN cm.status = 'Completed' THEN cm.id END) as completed_meetings
       FROM counselors c
       LEFT JOIN counselor_meetings cm ON c.id = cm.counselor_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );
    
    res.json({
      success: true,
      counselors: counselors,
      total: counselors.length
    });
    
  } catch (error) {
    console.error('Error fetching counselors:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch counselors',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single counselor by ID with meetings
router.get('/counselors/:counselorId', async (req, res) => {
  try {
    const { counselorId } = req.params;
    
    const [counselors] = await pool.query(
      `SELECT c.*, 
              COUNT(DISTINCT cm.id) as total_meetings
       FROM counselors c
       LEFT JOIN counselor_meetings cm ON c.id = cm.counselor_id
       WHERE c.id = ?
       GROUP BY c.id`,
      [counselorId]
    );
    
    if (counselors.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Get meetings for this counselor
    const [meetings] = await pool.query(
      'SELECT * FROM counselor_meetings WHERE counselor_id = ? ORDER BY meeting_date DESC, meeting_time DESC',
      [counselorId]
    );
    
    res.json({
      success: true,
      counselor: counselors[0],
      meetings: meetings
    });
    
  } catch (error) {
    console.error('Error fetching counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new counselor
router.post('/counselors', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { name, email, phone, experience, expertise, status } = req.body;
    
    // Validate required fields
    if (!name || !email || !phone || !experience || !expertise) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
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
        message: 'Name must be at least 3 characters long' 
      });
    }

    // Check if email already exists
    const [existingCounselor] = await connection.query(
      'SELECT id, name, email FROM counselors WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingCounselor.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A counselor with this email address already exists',
        existingCounselor: {
          name: existingCounselor[0].name,
          email: existingCounselor[0].email
        }
      });
    }

    // Generate counselor ID
    const counselorId = await generateCounselorId(connection);
    
    // Insert counselor
    const [result] = await connection.query(
      `INSERT INTO counselors (counselor_id, name, email, phone, experience, expertise, status, number_of_students)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [counselorId, trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active']
    );
    
    const newCounselorId = result.insertId;
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Counselor added successfully!',
      counselorId: newCounselorId,
      generatedId: counselorId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while adding the counselor. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update counselor
router.put('/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    const { name, email, phone, experience, expertise, status } = req.body;
    
    // Validate required fields
    if (!name || !email || !phone || !experience || !expertise) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
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

    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }

    // Check if email is being changed to one that already exists
    const [emailCheck] = await connection.query(
      'SELECT id FROM counselors WHERE email = ? AND id != ?',
      [trimmedEmail, counselorId]
    );
    
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This email address is already associated with another counselor' 
      });
    }
    
    // Update counselor
    await connection.query(
      `UPDATE counselors 
       SET name = ?, email = ?, phone = ?, experience = ?, expertise = ?, status = ?
       WHERE id = ?`,
      [trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active', counselorId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete counselor
router.delete('/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    
    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id, name FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Delete counselor (meetings will be deleted automatically due to CASCADE)
    await connection.query('DELETE FROM counselors WHERE id = ?', [counselorId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Add meeting to counselor
router.post('/counselors/:counselorId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    const { studentName, studentId, meetingDate, meetingTime, notes } = req.body;
    
    // Validate required fields
    if (!studentName || !studentId || !meetingDate || !meetingTime) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Insert meeting
    await connection.query(
      `INSERT INTO counselor_meetings (counselor_id, student_name, student_id, meeting_date, meeting_time, status, notes)
       VALUES (?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, studentName.trim(), studentId.trim(), meetingDate, meetingTime, notes?.trim() || null]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Meeting scheduled successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error adding meeting:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while scheduling the meeting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete meeting
router.delete('/counselors/:counselorId/meetings/:meetingId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId, meetingId } = req.params;
    
    // Check if meeting exists
    const [existingMeeting] = await connection.query(
      'SELECT id FROM counselor_meetings WHERE id = ? AND counselor_id = ?',
      [meetingId, counselorId]
    );
    
    if (existingMeeting.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Meeting not found' 
      });
    }
    
    // Delete meeting
    await connection.query('DELETE FROM counselor_meetings WHERE id = ?', [meetingId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Meeting deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting meeting:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the meeting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

export default router;