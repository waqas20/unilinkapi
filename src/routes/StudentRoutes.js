import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for document uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/student-documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'doc-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, and documents are allowed'));
    }
  }
});

// Validation helper functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

// Generate student ID
const generateStudentId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(student_id, 8) AS UNSIGNED)) as max_id 
     FROM users 
     WHERE student_id LIKE 'STU${currentYear}%' AND role = 'client'`
  );
  
  const nextId = (result[0].max_id || 0) + 1;
  return `STU${currentYear}${String(nextId).padStart(3, '0')}`;
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

// ============ STUDENT CRUD ENDPOINTS ============

// Get all students
router.get('/students', async (req, res) => {
  try {
    const [students] = await pool.query(
      `SELECT u.id, u.student_id, u.name, u.middle_name, u.surname, u.email, 
              u.mobile, u.country, u.dob, u.status, u.created_at,
              COUNT(DISTINCT sc.counselor_id) as counselor_count,
              COUNT(DISTINCT cm.id) as meeting_count
       FROM users u
       LEFT JOIN student_counselors sc ON u.id = sc.user_id
       LEFT JOIN counselor_meetings cm ON u.id = cm.user_id
       WHERE u.role = 'client'
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    
    res.json({
      success: true,
      students: students,
      total: students.length
    });
    
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch students',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single student by ID with all details
router.get('/students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Get student basic info
    const [students] = await pool.query(
      `SELECT * FROM users WHERE id = ? AND role = 'client'`,
      [studentId]
    );
    
    if (students.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Get education details
    const [education] = await pool.query(
      'SELECT * FROM student_education WHERE student_id = ? ORDER BY start_date DESC',
      [studentId]
    );
    
    // Get work experience
    const [workExperience] = await pool.query(
      'SELECT * FROM student_work_experience WHERE student_id = ? ORDER BY id DESC',
      [studentId]
    );
    
    // Get documents
    const [documents] = await pool.query(
      'SELECT * FROM student_documents WHERE student_id = ? ORDER BY uploaded_at DESC',
      [studentId]
    );
    
    // Get assigned counselors
    const [counselors] = await pool.query(
      `SELECT c.*, sc.assigned_at
       FROM counselors c
       INNER JOIN student_counselors sc ON c.id = sc.counselor_id
       WHERE sc.user_id = ?
       ORDER BY sc.assigned_at DESC`,
      [studentId]
    );
    
    // Get meetings
    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       WHERE cm.user_id = ?
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [studentId]
    );
    
    res.json({
      success: true,
      student: students[0],
      education: education,
      workExperience: workExperience,
      documents: documents,
      assignedCounselors: counselors,
      meetings: meetings
    });
    
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch student',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new student
router.post('/students', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      firstName, middleName, surname, email, mobile, address, country, dob,
      guardianName, guardianRelation, guardianMobile, guardianEmail, sourceInquiry,
      education, workExperience
    } = req.body;
    
    // Validate required fields
    if (!firstName || !surname || !email || !mobile || !address || !country || !dob || 
        !guardianName || !guardianRelation || !guardianMobile) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const fullName = `${firstName.trim()} ${middleName ? middleName.trim() + ' ' : ''}${surname.trim()}`;

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(mobile)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
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

    // Generate student ID
    const studentId = await generateStudentId(connection);
    
    // Generate password
    const generatedPassword = generatePassword(12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);
    
    // Insert student
    const [result] = await connection.query(
      `INSERT INTO users 
       (student_id, name, middle_name, surname, email, mobile, address, country, dob, 
        guardian_name, guardian_relation, guardian_mobile, guardian_email, source_inquiry, 
        password, role, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', 'Active')`,
      [studentId, fullName, middleName?.trim() || null, surname.trim(), trimmedEmail, 
       mobile.trim(), address.trim(), country, dob, guardianName.trim(), guardianRelation.trim(), 
       guardianMobile.trim(), guardianEmail?.trim() || null, sourceInquiry || null, hashedPassword]
    );
    
    const newStudentId = result.insertId;
    
    // Insert education details if provided
    if (education && Array.isArray(education) && education.length > 0) {
      const educationValues = education
        .filter(edu => edu.education_level && edu.institute_name && edu.start_date)
        .map(edu => [
          newStudentId,
          edu.education_level,
          edu.institute_name,
          edu.start_date,
          edu.end_date || null,
          edu.result || null,
          edu.remarks || null
        ]);
      
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education 
           (student_id, education_level, institute_name, start_date, end_date, result, remarks)
           VALUES ?`,
          [educationValues]
        );
      }
    }
    
    // Insert work experience if provided
    if (workExperience && Array.isArray(workExperience) && workExperience.length > 0) {
      const workValues = workExperience
        .filter(work => work.company_name && work.designation)
        .map(work => [
          newStudentId,
          work.company_name,
          work.designation,
          work.duration || null,
          work.relation || null
        ]);
      
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience 
           (student_id, company_name, designation, duration, relation)
           VALUES ?`,
          [workValues]
        );
      }
    }
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Student created successfully',
      studentId: newStudentId,
      generatedStudentId: studentId,
      credentials: {
        email: trimmedEmail,
        password: generatedPassword
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while creating the student',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update student
router.put('/students/:studentId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    const {
      firstName, middleName, surname, email, mobile, address, country, dob,
      guardianName, guardianRelation, guardianMobile, guardianEmail, sourceInquiry,
      status, education, workExperience
    } = req.body;
    
    // Validate required fields
    if (!firstName || !surname || !email || !mobile || !address || !country || !dob) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const fullName = `${firstName.trim()} ${middleName ? middleName.trim() + ' ' : ''}${surname.trim()}`;

    // Format date to YYYY-MM-DD
    const formattedDob = dob.split('T')[0];

    // Check if student exists
    const [existingStudent] = await connection.query(
      'SELECT id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Check if email is being changed to one that already exists
    const [emailCheck] = await connection.query(
      'SELECT id FROM users WHERE email = ? AND id != ?',
      [trimmedEmail, studentId]
    );
    
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This email address is already associated with another user' 
      });
    }
    
    // Update student basic info
    await connection.query(
      `UPDATE users 
       SET name = ?, middle_name = ?, surname = ?, email = ?, mobile = ?, address = ?, 
           country = ?, dob = ?, guardian_name = ?, guardian_relation = ?, 
           guardian_mobile = ?, guardian_email = ?, source_inquiry = ?, status = ?
       WHERE id = ?`,
      [fullName, middleName?.trim() || null, surname.trim(), trimmedEmail, mobile.trim(), 
       address.trim(), country, formattedDob, guardianName?.trim(), guardianRelation?.trim(), 
       guardianMobile?.trim(), guardianEmail?.trim() || null, sourceInquiry || null, 
       status || 'Active', studentId]
    );
    
    // Update education details
    if (education && Array.isArray(education)) {
      // Delete existing education records
      await connection.query('DELETE FROM student_education WHERE student_id = ?', [studentId]);
      
      // Insert new education records
      const educationValues = education
        .filter(edu => edu.education_level && edu.institute_name && edu.start_date)
        .map(edu => [
          studentId,
          edu.education_level,
          edu.institute_name,
          edu.start_date.split('T')[0], // Format start date
          edu.end_date ? edu.end_date.split('T')[0] : null, // Format end date
          edu.result || null,
          edu.remarks || null
        ]);
      
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education 
           (student_id, education_level, institute_name, start_date, end_date, result, remarks)
           VALUES ?`,
          [educationValues]
        );
      }
    }
    
    // Update work experience
    if (workExperience && Array.isArray(workExperience)) {
      // Delete existing work experience records
      await connection.query('DELETE FROM student_work_experience WHERE student_id = ?', [studentId]);
      
      // Insert new work experience records
      const workValues = workExperience
        .filter(work => work.company_name && work.designation)
        .map(work => [
          studentId,
          work.company_name,
          work.designation,
          work.duration || null,
          work.relation || null
        ]);
      
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience 
           (student_id, company_name, designation, duration, relation)
           VALUES ?`,
          [workValues]
        );
      }
    }
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Student updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the student',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete student
router.delete('/students/:studentId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    
    // Check if student exists
    const [existingStudent] = await connection.query(
      'SELECT id, name FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Delete student (cascade will handle related records)
    await connection.query('DELETE FROM users WHERE id = ?', [studentId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Student deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting student:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the student',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// ============ MANUAL FORM UPLOAD ============

// Upload manual form for student
router.post('/students/:studentId/manual-form', upload.single('manualForm'), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    
    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }
    
    // Check if student exists
    const [student] = await connection.query(
      'SELECT id, manual_form_path FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (student.length === 0) {
      await connection.rollback();
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Delete old file if exists
    if (student[0].manual_form_path) {
      const oldFilePath = path.join(__dirname, '..', student[0].manual_form_path);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    
    const filePath = `/uploads/student-documents/${req.file.filename}`;
    
    // Update student record with manual form path
    await connection.query(
      'UPDATE users SET manual_form_path = ?, manual_form_uploaded_at = NOW() WHERE id = ?',
      [filePath, studentId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Manual form uploaded successfully',
      filePath: filePath
    });
    
  } catch (error) {
    await connection.rollback();
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading manual form:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while uploading the manual form',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Get manual form for student
router.get('/students/:studentId/manual-form', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const [result] = await pool.query(
      'SELECT manual_form_path, manual_form_uploaded_at FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (result.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    res.json({
      success: true,
      manualForm: result[0].manual_form_path ? {
        filePath: result[0].manual_form_path,
        uploadedAt: result[0].manual_form_uploaded_at
      } : null
    });
    
  } catch (error) {
    console.error('Error fetching manual form:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch manual form',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete manual form for student
router.delete('/students/:studentId/manual-form', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    
    // Get file path
    const [student] = await connection.query(
      'SELECT manual_form_path FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    if (!student[0].manual_form_path) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'No manual form found' 
      });
    }
    
    // Delete file from filesystem
    const filePath = path.join(__dirname, '..', student[0].manual_form_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Update database
    await connection.query(
      'UPDATE users SET manual_form_path = NULL, manual_form_uploaded_at = NULL WHERE id = ?',
      [studentId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Manual form deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting manual form:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the manual form',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// ============ DOCUMENT MANAGEMENT ============

// Upload student document
router.post('/students/:studentId/documents', upload.single('document'), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    const { documentName, documentType } = req.body;
    
    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }
    
    if (!documentName || !documentType) {
      await connection.rollback();
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ 
        success: false, 
        message: 'Document name and type are required' 
      });
    }
    
    const filePath = `/uploads/student-documents/${req.file.filename}`;
    
    await connection.query(
      `INSERT INTO student_documents (student_id, document_name, document_type, file_path)
       VALUES (?, ?, ?, ?)`,
      [studentId, documentName, documentType, filePath]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      filePath: filePath
    });
    
  } catch (error) {
    await connection.rollback();
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading document:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while uploading the document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update document verification status
router.put('/students/:studentId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId, documentId } = req.params;
    const { verified } = req.body;
    
    await connection.query(
      'UPDATE student_documents SET verified = ? WHERE id = ? AND student_id = ?',
      [verified ? 1 : 0, documentId, studentId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Document verification status updated'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating document:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete document
router.delete('/students/:studentId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId, documentId } = req.params;
    
    // Get file path
    const [document] = await connection.query(
      'SELECT file_path FROM student_documents WHERE id = ? AND student_id = ?',
      [documentId, studentId]
    );
    
    if (document.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Document not found' 
      });
    }
    
    // Delete from database
    await connection.query(
      'DELETE FROM student_documents WHERE id = ? AND student_id = ?',
      [documentId, studentId]
    );
    
    // Delete file from filesystem
    const filePath = path.join(__dirname, '..', document[0].file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Document deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting document:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// ============ COUNSELOR ASSIGNMENT FOR STUDENTS ============

// Assign counselor to student
router.post('/students/:studentId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    const { counselorId } = req.body;
    
    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Counselor ID is required' 
      });
    }
    
    // Check if already assigned
    const [existing] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This counselor is already assigned to this student' 
      });
    }
    
    // Assign counselor
    await connection.query(
      'INSERT INTO student_counselors (user_id, counselor_id) VALUES (?, ?)',
      [studentId, counselorId]
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

// Remove counselor from student
router.delete('/students/:studentId/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId, counselorId } = req.params;
    
    const [result] = await connection.query(
      'DELETE FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
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

// ============ STUDENT MEETINGS ============

// Schedule meeting for student
router.post('/students/:studentId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { studentId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;
    
    // Validate required fields
    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }
    
    // Check if counselor is assigned to this student
    const [assignment] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'This counselor is not assigned to this student' 
      });
    }
    
    // Get student info
    const [student] = await connection.query(
      'SELECT name, student_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Check for time conflicts
    const [hours, minutes] = meetingTime.split(':');
    const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
    const endMinutes = startMinutes + parseInt(durationMinutes);
    
    // Validate business hours (9 AM to 5 PM)
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
       (counselor_id, user_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, studentId, student[0].name, student[0].student_id, meetingDate, meetingTime, durationMinutes, notes || null]
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

export default router;