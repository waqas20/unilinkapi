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
  limits: { fileSize: 10 * 1024 * 1024 },
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

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

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
        u.mobile, u.country, u.dob, u.status, u.course, u.created_at,
        COUNT(DISTINCT sc.counselor_id) as counselor_count,
        COUNT(DISTINCT cm.id) as meeting_count
      FROM users u
      LEFT JOIN student_counselors sc ON u.id = sc.user_id
      LEFT JOIN counselor_meetings cm ON u.id = cm.user_id
      WHERE u.role = 'client'
      GROUP BY u.id
      ORDER BY u.created_at DESC`
    );
    res.json({ success: true, students, total: students.length });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch students' });
  }
});

// Get single student by ID with all details
router.get('/students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    const [students] = await pool.query(
      `SELECT * FROM users WHERE id = ? AND role = 'client'`,
      [studentId]
    );
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [education] = await pool.query(
      'SELECT * FROM student_education WHERE student_id = ? ORDER BY start_date DESC',
      [studentId]
    );

    const [workExperience] = await pool.query(
      'SELECT * FROM student_work_experience WHERE student_id = ? ORDER BY id DESC',
      [studentId]
    );

    const [documents] = await pool.query(
      'SELECT * FROM student_documents WHERE student_id = ? ORDER BY display_order ASC, uploaded_at DESC',
      [studentId]
    );

    const [counselors] = await pool.query(
      `SELECT c.*, sc.assigned_at
       FROM counselors c
       INNER JOIN student_counselors sc ON c.id = sc.counselor_id
       WHERE sc.user_id = ?
       ORDER BY sc.assigned_at DESC`,
      [studentId]
    );

    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       WHERE cm.user_id = ?
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [studentId]
    );

    // Get emergency contact
    const [emergencyContacts] = await pool.query(
      'SELECT * FROM student_emergency_contact WHERE student_id = ? LIMIT 1',
      [studentId]
    );

    // Get family details
    const [familyDetails] = await pool.query(
      'SELECT * FROM student_family_details WHERE student_id = ? ORDER BY FIELD(type, "Father","Mother","Sponsor")',
      [studentId]
    );

    // Get activities
    const [activities] = await pool.query(
      'SELECT * FROM student_activities WHERE student_id = ? ORDER BY id ASC',
      [studentId]
    );

    // Get awards
    const [awards] = await pool.query(
      'SELECT * FROM student_awards WHERE student_id = ? ORDER BY id ASC',
      [studentId]
    );

    res.json({
      success: true,
      student: students[0],
      education,
      workExperience,
      documents,
      assignedCounselors: counselors,
      meetings,
      emergencyContact: emergencyContacts[0] || null,
      familyDetails,
      activities,
      awards
    });

  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch student' });
  }
});

// Create new student
router.post('/students', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      firstName, middleName, surname, email, alternativeEmail,
      mobile, landline, address, postalCode, country, dob,
      nationality, maritalStatus, gender,
      cityOfBirth, countryOfBirth,
      passportNo, passportIssueDate, passportPlaceOfIssue,
      guardianName, guardianRelation, guardianMobile, guardianEmail,
      sourceInquiry, course,
      emergencyContact, familyDetails,
      education, workExperience, activities, awards
    } = req.body;

    if (!firstName || !surname || !email || !mobile || !address || !country || !dob) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(mobile)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number' });
    }

    const [existingUser] = await connection.query(
      'SELECT id FROM users WHERE email = ?', [trimmedEmail]
    );
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    const studentId = await generateStudentId(connection);
    const generatedPassword = generatePassword(12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    const [result] = await connection.query(
      `INSERT INTO users 
      (student_id, name, middle_name, surname, email, alternative_email, mobile, landline,
       address, postal_code, country, dob, nationality, marital_status, gender,
       city_of_birth, country_of_birth, passport_no, passport_issue_date, passport_place_of_issue,
       guardian_name, guardian_relation, guardian_mobile, guardian_email,
       source_inquiry, course, password, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', 'Active')`,
      [
        studentId, firstName.trim(), middleName?.trim() || null, surname.trim(),
        trimmedEmail, alternativeEmail?.trim() || null,
        mobile.trim(), landline?.trim() || null,
        address.trim(), postalCode?.trim() || null,
        country, dob,
        nationality?.trim() || null, maritalStatus || null, gender || null,
        cityOfBirth?.trim() || null, countryOfBirth?.trim() || null,
        passportNo?.trim() || null,
        passportIssueDate || null,
        passportPlaceOfIssue?.trim() || null,
        guardianName?.trim() || null, guardianRelation?.trim() || null,
        guardianMobile?.trim() || null, guardianEmail?.trim() || null,
        sourceInquiry || null, course?.trim() || null,
        hashedPassword
      ]
    );

    const newStudentId = result.insertId;

    // Insert emergency contact
    if (emergencyContact && (emergencyContact.full_name || emergencyContact.contact_no)) {
      await connection.query(
        `INSERT INTO student_emergency_contact (student_id, full_name, relation, contact_no, email, address, postal_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newStudentId, emergencyContact.full_name || null, emergencyContact.relation || null,
         emergencyContact.contact_no || null, emergencyContact.email || null,
         emergencyContact.address || null, emergencyContact.postal_code || null]
      );
    }

    // Insert family details
    if (familyDetails && Array.isArray(familyDetails)) {
      for (const member of familyDetails) {
        if (member.type && (member.full_name || member.contact_no)) {
          await connection.query(
            `INSERT INTO student_family_details (student_id, type, full_name, relation, contact_no, email, profession, address, sponsor_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newStudentId, member.type, member.full_name || null, member.relation || null,
             member.contact_no || null, member.email || null, member.profession || null,
             member.address || null, member.sponsor_note || null]
          );
        }
      }
    }

    // Insert education
    if (education && Array.isArray(education) && education.length > 0) {
      const educationValues = education
        .filter(edu => edu.education_level && edu.institute_name)
        .map(edu => [
          newStudentId, edu.education_level, edu.institute_name,
          edu.start_date || null, edu.end_date || null,
          edu.result || null, edu.subjects || null, edu.cgpa || null, edu.remarks || null
        ]);
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education (student_id, education_level, institute_name, start_date, end_date, result, subjects, cgpa, remarks)
           VALUES ?`,
          [educationValues]
        );
      }
    }

    // Insert activities
    if (activities && Array.isArray(activities) && activities.length > 0) {
      const activityValues = activities
        .filter(a => a.activity_name)
        .map(a => [newStudentId, a.activity_name, a.description || null,
          a.grade_levels || null, a.hours_per_week || null, a.weeks_per_year || null]);
      if (activityValues.length > 0) {
        await connection.query(
          `INSERT INTO student_activities (student_id, activity_name, description, grade_levels, hours_per_week, weeks_per_year)
           VALUES ?`,
          [activityValues]
        );
      }
    }

    // Insert awards
    if (awards && Array.isArray(awards) && awards.length > 0) {
      const awardValues = awards
        .filter(a => a.award_name)
        .map(a => [newStudentId, a.award_name, a.recognition_level || null,
          a.award_type || null, a.received_date || null, a.description || null]);
      if (awardValues.length > 0) {
        await connection.query(
          `INSERT INTO student_awards (student_id, award_name, recognition_level, award_type, received_date, description)
           VALUES ?`,
          [awardValues]
        );
      }
    }

    // Insert work experience
    if (workExperience && Array.isArray(workExperience) && workExperience.length > 0) {
      const workValues = workExperience
        .filter(w => w.company_name && w.designation)
        .map(w => [newStudentId, w.company_name, w.designation,
          w.date_from || null, w.date_to || null, w.duration || null,
          w.employment_type || null, w.relation || null]);
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience (student_id, company_name, designation, date_from, date_to, duration, employment_type, relation)
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
      credentials: { email: trimmedEmail, password: generatedPassword }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while creating the student' });
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
      firstName, middleName, surname, email, alternativeEmail,
      mobile, landline, address, postalCode, country, dob,
      nationality, maritalStatus, gender,
      cityOfBirth, countryOfBirth,
      passportNo, passportIssueDate, passportPlaceOfIssue,
      guardianName, guardianRelation, guardianMobile, guardianEmail,
      sourceInquiry, status, course,
      emergencyContact, familyDetails,
      education, workExperience, activities, awards
    } = req.body;

    if (!firstName || !surname || !email || !mobile || !address || !country || !dob) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const formattedDob = dob.split('T')[0];

    const [existingStudent] = await connection.query(
      'SELECT id FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [emailCheck] = await connection.query(
      'SELECT id FROM users WHERE email = ? AND id != ?', [trimmedEmail, studentId]
    );
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'Email already associated with another user' });
    }

    // Update users table
    await connection.query(
      `UPDATE users SET
        name = ?, middle_name = ?, surname = ?, email = ?, alternative_email = ?,
        mobile = ?, landline = ?, address = ?, postal_code = ?, country = ?, dob = ?,
        nationality = ?, marital_status = ?, gender = ?,
        city_of_birth = ?, country_of_birth = ?,
        passport_no = ?, passport_issue_date = ?, passport_place_of_issue = ?,
        guardian_name = ?, guardian_relation = ?, guardian_mobile = ?, guardian_email = ?,
        source_inquiry = ?, status = ?, course = ?
      WHERE id = ?`,
      [
        firstName.trim(), middleName?.trim() || null, surname.trim(),
        trimmedEmail, alternativeEmail?.trim() || null,
        mobile.trim(), landline?.trim() || null,
        address.trim(), postalCode?.trim() || null,
        country, formattedDob,
        nationality?.trim() || null, maritalStatus || null, gender || null,
        cityOfBirth?.trim() || null, countryOfBirth?.trim() || null,
        passportNo?.trim() || null,
        passportIssueDate ? passportIssueDate.split('T')[0] : null,
        passportPlaceOfIssue?.trim() || null,
        guardianName?.trim() || null, guardianRelation?.trim() || null,
        guardianMobile?.trim() || null, guardianEmail?.trim() || null,
        sourceInquiry || null, status || 'Active', course?.trim() || null,
        studentId
      ]
    );

    // Update emergency contact (upsert)
    if (emergencyContact) {
      const [existingEC] = await connection.query(
        'SELECT id FROM student_emergency_contact WHERE student_id = ?', [studentId]
      );
      if (existingEC.length > 0) {
        await connection.query(
          `UPDATE student_emergency_contact SET full_name=?, relation=?, contact_no=?, email=?, address=?, postal_code=?
           WHERE student_id=?`,
          [emergencyContact.full_name || null, emergencyContact.relation || null,
           emergencyContact.contact_no || null, emergencyContact.email || null,
           emergencyContact.address || null, emergencyContact.postal_code || null,
           studentId]
        );
      } else {
        await connection.query(
          `INSERT INTO student_emergency_contact (student_id, full_name, relation, contact_no, email, address, postal_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [studentId, emergencyContact.full_name || null, emergencyContact.relation || null,
           emergencyContact.contact_no || null, emergencyContact.email || null,
           emergencyContact.address || null, emergencyContact.postal_code || null]
        );
      }
    }

    // Update family details (delete + reinsert)
    if (familyDetails && Array.isArray(familyDetails)) {
      await connection.query('DELETE FROM student_family_details WHERE student_id = ?', [studentId]);
      for (const member of familyDetails) {
        if (member.type) {
          await connection.query(
            `INSERT INTO student_family_details (student_id, type, full_name, relation, contact_no, email, profession, address, sponsor_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [studentId, member.type, member.full_name || null, member.relation || null,
             member.contact_no || null, member.email || null, member.profession || null,
             member.address || null, member.sponsor_note || null]
          );
        }
      }
    }

    // Update education
    if (education && Array.isArray(education)) {
      await connection.query('DELETE FROM student_education WHERE student_id = ?', [studentId]);
      const educationValues = education
        .filter(edu => edu.education_level && edu.institute_name)
        .map(edu => [
          studentId, edu.education_level, edu.institute_name,
          edu.start_date ? edu.start_date.split('T')[0] : null,
          edu.end_date ? edu.end_date.split('T')[0] : null,
          edu.result || null, edu.subjects || null, edu.cgpa || null, edu.remarks || null
        ]);
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education (student_id, education_level, institute_name, start_date, end_date, result, subjects, cgpa, remarks)
           VALUES ?`,
          [educationValues]
        );
      }
    }

    // Update activities
    if (activities && Array.isArray(activities)) {
      await connection.query('DELETE FROM student_activities WHERE student_id = ?', [studentId]);
      const activityValues = activities
        .filter(a => a.activity_name)
        .map(a => [studentId, a.activity_name, a.description || null,
          a.grade_levels || null, a.hours_per_week || null, a.weeks_per_year || null]);
      if (activityValues.length > 0) {
        await connection.query(
          `INSERT INTO student_activities (student_id, activity_name, description, grade_levels, hours_per_week, weeks_per_year)
           VALUES ?`,
          [activityValues]
        );
      }
    }

    // Update awards
    if (awards && Array.isArray(awards)) {
      await connection.query('DELETE FROM student_awards WHERE student_id = ?', [studentId]);
      const awardValues = awards
        .filter(a => a.award_name)
        .map(a => [studentId, a.award_name, a.recognition_level || null,
          a.award_type || null, a.received_date || null, a.description || null]);
      if (awardValues.length > 0) {
        await connection.query(
          `INSERT INTO student_awards (student_id, award_name, recognition_level, award_type, received_date, description)
           VALUES ?`,
          [awardValues]
        );
      }
    }

    // Update work experience
    if (workExperience && Array.isArray(workExperience)) {
      await connection.query('DELETE FROM student_work_experience WHERE student_id = ?', [studentId]);
      const workValues = workExperience
        .filter(w => w.company_name && w.designation)
        .map(w => [studentId, w.company_name, w.designation,
          w.date_from ? w.date_from.split('T')[0] : null,
          w.date_to ? w.date_to.split('T')[0] : null,
          w.duration || null, w.employment_type || null, w.relation || null]);
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience (student_id, company_name, designation, date_from, date_to, duration, employment_type, relation)
           VALUES ?`,
          [workValues]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Student updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the student' });
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

    const [existingStudent] = await connection.query(
      'SELECT id, name FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await connection.query('DELETE FROM users WHERE id = ?', [studentId]);
    await connection.commit();
    res.json({ success: true, message: 'Student deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the student' });
  } finally {
    connection.release();
  }
});

// ============ MANUAL FORM UPLOAD ============

router.post('/students/:studentId/manual-form', upload.single('manualForm'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;

    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const [student] = await connection.query(
      'SELECT id, manual_form_path FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    if (student[0].manual_form_path) {
      const oldFilePath = path.join(__dirname, '..', student[0].manual_form_path);
      if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
    }

    const filePath = `/uploads/student-documents/${req.file.filename}`;
    await connection.query(
      'UPDATE users SET manual_form_path = ?, manual_form_uploaded_at = NOW() WHERE id = ?',
      [filePath, studentId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Manual form uploaded successfully', filePath });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the manual form' });
  } finally {
    connection.release();
  }
});

router.get('/students/:studentId/manual-form', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [result] = await pool.query(
      'SELECT manual_form_path, manual_form_uploaded_at FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (result.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
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
    res.status(500).json({ success: false, message: 'Failed to fetch manual form' });
  }
});

router.delete('/students/:studentId/manual-form', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;

    const [student] = await connection.query(
      'SELECT manual_form_path FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    if (!student[0].manual_form_path) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No manual form found' });
    }

    const filePath = path.join(__dirname, '..', student[0].manual_form_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.query(
      'UPDATE users SET manual_form_path = NULL, manual_form_uploaded_at = NULL WHERE id = ?',
      [studentId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Manual form deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the manual form' });
  } finally {
    connection.release();
  }
});

// ============ DOCUMENT MANAGEMENT ============

const PREDEFINED_DOCUMENTS = [
  { name: 'Passport', order: 1 },
  { name: 'CNIC (Back & Front)', order: 2 },
  { name: 'Updated CV / Resume', order: 3 },
  { name: 'English Proficiency Test', order: 4 },
  { name: 'Extracurricular Certificates', order: 5 },
  { name: 'Essay or SOP', order: 6 },
  { name: 'Birth Certificate', order: 7 },
];

router.post('/students/:studentId/documents', upload.single('document'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { documentName, documentType, displayOrder } = req.body;

    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (!documentName || !documentType) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Document name and type are required' });
    }

    const filePath = `/uploads/student-documents/${req.file.filename}`;
    await connection.query(
      `INSERT INTO student_documents (student_id, document_name, document_type, file_path, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [studentId, documentName, documentType, filePath, displayOrder || 99]
    );

    await connection.commit();
    res.json({ success: true, message: 'Document uploaded successfully', filePath });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the document' });
  } finally {
    connection.release();
  }
});

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
    res.json({ success: true, message: 'Document verification status updated' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the document' });
  } finally {
    connection.release();
  }
});

router.delete('/students/:studentId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId, documentId } = req.params;

    const [document] = await connection.query(
      'SELECT file_path FROM student_documents WHERE id = ? AND student_id = ?',
      [documentId, studentId]
    );
    if (document.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    await connection.query(
      'DELETE FROM student_documents WHERE id = ? AND student_id = ?', [documentId, studentId]
    );

    const filePath = path.join(__dirname, '..', document[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.commit();
    res.json({ success: true, message: 'Document deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the document' });
  } finally {
    connection.release();
  }
});

// ============ COUNSELOR ASSIGNMENT ============

router.post('/students/:studentId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { counselorId } = req.body;

    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Counselor ID is required' });
    }

    const [existing] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This counselor is already assigned' });
    }

    await connection.query(
      'INSERT INTO student_counselors (user_id, counselor_id) VALUES (?, ?)', [studentId, counselorId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Counselor assigned successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error assigning counselor:', error);
    res.status(500).json({ success: false, message: 'An error occurred while assigning counselor' });
  } finally {
    connection.release();
  }
});

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
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }

    await connection.commit();
    res.json({ success: true, message: 'Counselor removed successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error removing counselor:', error);
    res.status(500).json({ success: false, message: 'An error occurred while removing counselor' });
  } finally {
    connection.release();
  }
});

// ============ MEETINGS ============

router.post('/students/:studentId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;

    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const [assignment] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This counselor is not assigned to this student' });
    }

    const [student] = await connection.query(
      'SELECT name, student_id FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [hours, minutes] = meetingTime.split(':');
    const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
    const endMinutes = startMinutes + parseInt(durationMinutes);

    if (startMinutes < 540 || endMinutes > 1020) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Meetings must be scheduled between 9:00 AM and 5:00 PM' });
    }

    const [conflicts] = await connection.query(
      `SELECT id, meeting_time, duration_minutes FROM counselor_meetings
       WHERE counselor_id = ? AND meeting_date = ? AND status != 'Cancelled'`,
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
          message: `Time slot conflicts with an existing meeting at ${meeting.meeting_time}`
        });
      }
    }

    await connection.query(
      `INSERT INTO counselor_meetings 
       (counselor_id, user_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, studentId, student[0].name, student[0].student_id,
       meetingDate, meetingTime, durationMinutes, notes || null]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Meeting scheduled successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error scheduling meeting:', error);
    res.status(500).json({ success: false, message: 'An error occurred while scheduling the meeting' });
  } finally {
    connection.release();
  }
});

// ============ CREATE APPLICATIONS FOR STUDENT ============

router.post('/students/:studentId/create-applications', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { countryIds } = req.body;

    if (!countryIds || !Array.isArray(countryIds) || countryIds.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide at least one country ID' });
    }

    const [student] = await connection.query(
      'SELECT id, name, student_id FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [existingApps] = await connection.query(
      'SELECT country_id FROM applications WHERE student_id = ? AND country_id IN (?)',
      [studentId, countryIds]
    );
    if (existingApps.length > 0) {
      const existingCountryIds = existingApps.map(app => app.country_id);
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'Applications already exist for some selected countries',
        existingCountryIds
      });
    }

    let createdCount = 0;
    const currentDate = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();

    for (const countryId of countryIds) {
      const [country] = await connection.query(
        'SELECT id, country_name FROM countries WHERE id = ? AND status = ?', [countryId, 'Active']
      );
      if (country.length === 0) continue;

      const [result] = await connection.query(
        `SELECT MAX(CAST(SUBSTRING(application_id, 8) AS UNSIGNED)) as max_id 
         FROM applications WHERE application_id LIKE ?`,
        [`APP${currentYear}%`]
      );
      const nextId = (result[0].max_id || 0) + 1;
      const applicationId = `APP${currentYear}${String(nextId).padStart(3, '0')}`;

      await connection.query(
        `INSERT INTO applications 
         (application_id, application_date, student_id, student_name, country_id, application_status, tagging_status)
         VALUES (?, ?, ?, ?, ?, 'Pending', 'Not Received')`,
        [applicationId, currentDate, studentId, student[0].name, countryId]
      );
      createdCount++;
    }

    await connection.commit();
    res.status(201).json({ success: true, message: 'Applications created successfully', createdCount });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating applications:', error);
    res.status(500).json({ success: false, message: 'An error occurred while creating applications' });
  } finally {
    connection.release();
  }
});

export default router;