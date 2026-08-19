import express from 'express';
import pool from '../config/db.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ============================================================
// SQL — Run once to add offer_letter columns:
//
// ALTER TABLE applications
//   ADD COLUMN offer_letter_path VARCHAR(500) NULL,
//   ADD COLUMN offer_letter_uploaded_at DATETIME NULL;
//
// Also update the ENUM if your DB enforces it:
// ALTER TABLE applications
//   MODIFY COLUMN application_status
//   ENUM('Pending','Approved','Accepted','Withdrawn','Rejected','Closed')
//   NOT NULL DEFAULT 'Pending';
// ============================================================

// Configure multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/application-forms');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'form-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only images, PDFs, and documents are allowed'));
  }
});

const ensureColumn = async (table, column, definition) => {
  try {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${column}\` ${definition}`);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') return;
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    } catch (err2) {
      if (err2.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`${table}.${column} column ensure:`, err2.message);
      }
    }
  }
};

const ensureApplicationSchema = async () => {
  await ensureColumn('applications', 'intake', 'VARCHAR(100) NULL');
  await ensureColumn('applications', 'apps_submitted_through_other', 'VARCHAR(255) NULL');
  await ensureColumn('applications', 'apps_tagged_through_other', 'VARCHAR(255) NULL');
  await ensureColumn('applications', 'offer_letter_type', 'VARCHAR(100) NULL');
  await ensureColumn('applications', 'offer_letter_other', 'VARCHAR(255) NULL');
  await ensureColumn('applications', 'initial_deposit_status', 'VARCHAR(50) NULL');
  await ensureColumn('applications', 'initial_deposit_amount', 'VARCHAR(100) NULL');
  await ensureColumn('applications', 'enrollment_fee_status', 'VARCHAR(50) NULL');
  await ensureColumn('applications', 'enrollment_fee_amount', 'VARCHAR(100) NULL');
  await ensureColumn('applications', 'tuition_fee_status', 'VARCHAR(50) NULL');
  await ensureColumn('applications', 'tuition_fee_amount', 'VARCHAR(100) NULL');

  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN intake_id INT NULL`);
  } catch (err) {
    console.warn('applications.intake_id nullable:', err.message);
  }
  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN application_status VARCHAR(50) NOT NULL DEFAULT 'Pending'`);
  } catch (err) {
    console.warn('applications.application_status varchar:', err.message);
  }
  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN tagging_status VARCHAR(50) NULL`);
  } catch (err) {
    console.warn('applications.tagging_status varchar:', err.message);
  }
  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN university_fees VARCHAR(100) NULL`);
  } catch (err) {
    console.warn('applications.university_fees varchar:', err.message);
  }
  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN apps_submitted_through VARCHAR(100) NULL`);
  } catch (err) {
    console.warn('applications.apps_submitted_through varchar:', err.message);
  }
  try {
    await pool.query(`ALTER TABLE applications MODIFY COLUMN apps_tagged_through VARCHAR(100) NULL`);
  } catch (err) {
    console.warn('applications.apps_tagged_through varchar:', err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS application_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      application_id INT NOT NULL,
      document_type VARCHAR(100) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      original_name VARCHAR(255) NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_application_documents_app (application_id)
    )
  `);
};

const INTAKE_SELECT = `COALESCE(NULLIF(a.intake, ''), i.intake_name) as intake_name`;

const normalizeTaggingStatus = (value) => {
  if (value === 'Received' || value === 'Tagged') return 'Tagged';
  return 'Not Tagged';
};

const paidAmount = (status, amount) =>
  status === 'Paid' ? (amount?.toString().trim() || null) : null;

const mapApplicationFields = (body) => {
  const {
    applicationDate, studentId, countryId, universityId,
    intake, intakeOther, program,
    appsSubmittedThrough, appsSubmittedThroughOther,
    appsTaggedThrough, appsTaggedThroughOther,
    universityFees, condition, applicationStatus, taggingStatus, remarks,
    offerLetterType, offerLetterOther,
    initialDepositStatus, initialDepositAmount,
    enrollmentFeeStatus, enrollmentFeeAmount,
    tuitionFeeStatus, tuitionFeeAmount,
  } = body;

  const intakeValue = intake === 'Other'
    ? (intakeOther?.trim() ? `Other: ${intakeOther.trim()}` : 'Other')
    : (intake?.trim() || null);

  const accepted = applicationStatus === 'Accepted';

  return {
    applicationDate,
    studentId,
    countryId,
    universityId,
    intakeValue,
    program: program?.trim(),
    appsSubmittedThrough: appsSubmittedThrough?.trim() || null,
    appsSubmittedThroughOther: appsSubmittedThrough === 'Other' ? (appsSubmittedThroughOther?.trim() || null) : null,
    appsTaggedThrough: appsTaggedThrough?.trim() || null,
    appsTaggedThroughOther: appsTaggedThrough === 'Other' ? (appsTaggedThroughOther?.trim() || null) : null,
    universityFees: universityFees?.toString().trim() || null,
    condition: condition?.trim() || null,
    applicationStatus: applicationStatus || 'Pending',
    taggingStatus: normalizeTaggingStatus(taggingStatus),
    remarks: remarks?.trim() || null,
    offerLetterType: accepted ? (offerLetterType?.trim() || null) : null,
    offerLetterOther: accepted && offerLetterType === 'Other' ? (offerLetterOther?.trim() || null) : null,
    initialDepositStatus: initialDepositStatus || null,
    initialDepositAmount: paidAmount(initialDepositStatus, initialDepositAmount),
    enrollmentFeeStatus: enrollmentFeeStatus || null,
    enrollmentFeeAmount: paidAmount(enrollmentFeeStatus, enrollmentFeeAmount),
    tuitionFeeStatus: tuitionFeeStatus || null,
    tuitionFeeAmount: paidAmount(tuitionFeeStatus, tuitionFeeAmount),
  };
};

// Generate application ID
const generateApplicationId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(application_id, 8) AS UNSIGNED)) as max_id 
     FROM applications 
     WHERE application_id LIKE 'APP${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `APP${currentYear}${String(nextId).padStart(3, '0')}`;
};


// ============================================================
// GET /applications — Get all applications
// ============================================================
router.get('/applications', async (req, res) => {
  try {
    await ensureApplicationSchema();
    const [applications] = await pool.query(
      `SELECT a.*,
              u.name as student_name,
              u.student_id as student_number,
              c.country_name,
              un.university_name,
              ${INTAKE_SELECT}
       FROM applications a
       INNER JOIN users u ON a.student_id = u.id
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       ORDER BY a.created_at DESC`
    );
    res.json({ success: true, applications, total: applications.length });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// GET /applications/stats/overview
// CHANGED: Added Accepted, Withdrawn counts; removed accepted_rejected counts
// ============================================================
router.get('/applications/stats/overview', async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_applications,
        SUM(CASE WHEN application_status = 'Pending'   THEN 1 ELSE 0 END) as pending_applications,
        SUM(CASE WHEN application_status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_applications,
        SUM(CASE WHEN application_status = 'Approved'  THEN 1 ELSE 0 END) as approved_applications,
        SUM(CASE WHEN application_status = 'Accepted'  THEN 1 ELSE 0 END) as accepted_applications,
        SUM(CASE WHEN application_status = 'Withdrawn' THEN 1 ELSE 0 END) as withdrawn_applications,
        SUM(CASE WHEN application_status = 'Rejected'  THEN 1 ELSE 0 END) as rejected_applications,
        SUM(CASE WHEN application_status = 'Closed'    THEN 1 ELSE 0 END) as closed_applications,
        SUM(CASE WHEN deposit_paid = 'Yes'             THEN 1 ELSE 0 END) as deposit_paid_count,
        COUNT(DISTINCT student_id) as unique_students
       FROM applications`
    );
    res.json({ success: true, stats: stats[0] });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch statistics', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// GET /applications/:applicationId — Get single application
// ============================================================
router.get('/applications/:applicationId', async (req, res) => {
  try {
    await ensureApplicationSchema();
    const { applicationId } = req.params;
    const [applications] = await pool.query(
      `SELECT a.*,
              u.name as student_full_name,
              u.student_id as student_number,
              u.email as student_email,
              u.mobile as student_mobile,
              c.country_name,
              un.university_name,
              ${INTAKE_SELECT}
       FROM applications a
       INNER JOIN users u ON a.student_id = u.id
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       WHERE a.id = ?`,
      [applicationId]
    );
    if (applications.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });
    res.json({ success: true, application: applications[0] });
  } catch (error) {
    console.error('Error fetching application:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch application', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// GET /applications/student/:studentId
// ============================================================
router.get('/applications/student/:studentId', async (req, res) => {
  try {
    await ensureApplicationSchema();
    const { studentId } = req.params;
    const [applications] = await pool.query(
      `SELECT a.*, c.country_name, un.university_name, ${INTAKE_SELECT}
       FROM applications a
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       WHERE a.student_id = ?
       ORDER BY a.created_at DESC`,
      [studentId]
    );
    res.json({ success: true, applications, total: applications.length });
  } catch (error) {
    console.error('Error fetching student applications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch applications', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// POST /applications — Create application
// CHANGED: Removed acceptedRejected field
// ============================================================
router.post('/applications', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureApplicationSchema();
    await connection.beginTransaction();

    const fields = mapApplicationFields(req.body);
    const { applicationDate, studentId, countryId, universityId, program } = fields;

    if (!applicationDate || !studentId || !countryId || !universityId || !program) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Application date, student, country, university, and program are required' });
    }

    const [student] = await connection.query('SELECT id, name FROM users WHERE id = ? AND role = ?', [studentId, 'client']);
    if (student.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Student not found' }); }

    const [country] = await connection.query('SELECT id FROM countries WHERE id = ?', [countryId]);
    if (country.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Country not found' }); }

    const [university] = await connection.query('SELECT id FROM universities WHERE id = ? AND country_id = ?', [universityId, countryId]);
    if (university.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'University not found or does not belong to selected country' }); }

    const applicationId = await generateApplicationId(connection);

    const [result] = await connection.query(
      `INSERT INTO applications 
       (application_id, application_date, student_id, student_name, country_id,
        university_id, intake, program, apps_submitted_through, apps_submitted_through_other,
        apps_tagged_through, apps_tagged_through_other, university_fees,
        \`condition\`, application_status, tagging_status, remarks,
        offer_letter_type, offer_letter_other,
        initial_deposit_status, initial_deposit_amount,
        enrollment_fee_status, enrollment_fee_amount,
        tuition_fee_status, tuition_fee_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        applicationId, applicationDate, studentId, student[0].name, countryId,
        universityId, fields.intakeValue, program,
        fields.appsSubmittedThrough, fields.appsSubmittedThroughOther,
        fields.appsTaggedThrough, fields.appsTaggedThroughOther,
        fields.universityFees, fields.condition, fields.applicationStatus,
        fields.taggingStatus, fields.remarks,
        fields.offerLetterType, fields.offerLetterOther,
        fields.initialDepositStatus, fields.initialDepositAmount,
        fields.enrollmentFeeStatus, fields.enrollmentFeeAmount,
        fields.tuitionFeeStatus, fields.tuitionFeeAmount,
      ]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Application created successfully', applicationId: result.insertId, generatedApplicationId: applicationId });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating application:', error);
    res.status(500).json({ success: false, message: 'An error occurred while creating the application', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// PUT /applications/:applicationId — Update application
// ============================================================
router.put('/applications/:applicationId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureApplicationSchema();
    await connection.beginTransaction();

    const { applicationId } = req.params;
    const fields = mapApplicationFields(req.body);
    const { applicationDate, studentId, countryId, universityId, program } = fields;

    if (!applicationDate || !studentId || !countryId || !universityId || !program) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Application date, student, country, university, and program are required' });
    }

    const [existing] = await connection.query('SELECT id FROM applications WHERE id = ?', [applicationId]);
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Application not found' }); }

    const [student] = await connection.query('SELECT id, name FROM users WHERE id = ? AND role = ?', [studentId, 'client']);
    if (student.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Student not found' }); }

    const [country] = await connection.query('SELECT id FROM countries WHERE id = ?', [countryId]);
    if (country.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Country not found' }); }

    const [university] = await connection.query('SELECT id FROM universities WHERE id = ? AND country_id = ?', [universityId, countryId]);
    if (university.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'University not found or does not belong to selected country' }); }

    await connection.query(
      `UPDATE applications 
       SET application_date = ?, student_id = ?, student_name = ?, country_id = ?,
           university_id = ?, intake_id = NULL, intake = ?, program = ?,
           apps_submitted_through = ?, apps_submitted_through_other = ?,
           apps_tagged_through = ?, apps_tagged_through_other = ?,
           university_fees = ?, \`condition\` = ?, application_status = ?, tagging_status = ?, remarks = ?,
           offer_letter_type = ?, offer_letter_other = ?,
           initial_deposit_status = ?, initial_deposit_amount = ?,
           enrollment_fee_status = ?, enrollment_fee_amount = ?,
           tuition_fee_status = ?, tuition_fee_amount = ?
       WHERE id = ?`,
      [
        String(applicationDate).split('T')[0], studentId, student[0].name, countryId,
        universityId, fields.intakeValue, program,
        fields.appsSubmittedThrough, fields.appsSubmittedThroughOther,
        fields.appsTaggedThrough, fields.appsTaggedThroughOther,
        fields.universityFees, fields.condition, fields.applicationStatus,
        fields.taggingStatus, fields.remarks,
        fields.offerLetterType, fields.offerLetterOther,
        fields.initialDepositStatus, fields.initialDepositAmount,
        fields.enrollmentFeeStatus, fields.enrollmentFeeAmount,
        fields.tuitionFeeStatus, fields.tuitionFeeAmount,
        applicationId
      ]
    );

    await connection.commit();
    res.json({ success: true, message: 'Application updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating application:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the application', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// DELETE /applications/:applicationId
// ============================================================
router.delete('/applications/:applicationId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId } = req.params;

    const [existing] = await connection.query(
      'SELECT id, application_id, manual_form_path, offer_letter_path FROM applications WHERE id = ?',
      [applicationId]
    );
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Application not found' }); }

    const deleteFile = (filePath) => {
      if (filePath) {
        const full = path.join(__dirname, '..', filePath);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      }
    };

    deleteFile(existing[0].manual_form_path);
    deleteFile(existing[0].offer_letter_path);

    try {
      const [docs] = await connection.query('SELECT file_path FROM application_documents WHERE application_id = ?', [applicationId]);
      docs.forEach((doc) => deleteFile(doc.file_path));
      await connection.query('DELETE FROM application_documents WHERE application_id = ?', [applicationId]);
    } catch (err) {
      console.warn('application_documents cleanup:', err.message);
    }

    await connection.query('DELETE FROM applications WHERE id = ?', [applicationId]);
    await connection.commit();
    res.json({ success: true, message: 'Application deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting application:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the application', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// POST /applications/:applicationId/manual-form — Upload manual form
// ============================================================
router.post('/applications/:applicationId/manual-form', upload.single('manualForm'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId } = req.params;

    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }

    const [application] = await connection.query('SELECT id, manual_form_path FROM applications WHERE id = ?', [applicationId]);
    if (application.length === 0) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (application[0].manual_form_path) {
      const old = path.join(__dirname, '..', application[0].manual_form_path);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }

    const filePath = `/uploads/application-forms/${req.file.filename}`;
    await connection.query('UPDATE applications SET manual_form_path = ?, manual_form_uploaded_at = NOW() WHERE id = ?', [filePath, applicationId]);
    await connection.commit();
    res.json({ success: true, message: 'Manual form uploaded successfully', filePath });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the manual form', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// GET /applications/:applicationId/manual-form
// ============================================================
router.get('/applications/:applicationId/manual-form', async (req, res) => {
  try {
    const { applicationId } = req.params;
    const [result] = await pool.query('SELECT manual_form_path, manual_form_uploaded_at FROM applications WHERE id = ?', [applicationId]);
    if (result.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });
    res.json({
      success: true,
      manualForm: result[0].manual_form_path
        ? { filePath: result[0].manual_form_path, uploadedAt: result[0].manual_form_uploaded_at }
        : null
    });
  } catch (error) {
    console.error('Error fetching manual form:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch manual form', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// DELETE /applications/:applicationId/manual-form
// ============================================================
router.delete('/applications/:applicationId/manual-form', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId } = req.params;

    const [application] = await connection.query('SELECT manual_form_path FROM applications WHERE id = ?', [applicationId]);
    if (application.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Application not found' }); }
    if (!application[0].manual_form_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No manual form found' }); }

    const filePath = path.join(__dirname, '..', application[0].manual_form_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.query('UPDATE applications SET manual_form_path = NULL, manual_form_uploaded_at = NULL WHERE id = ?', [applicationId]);
    await connection.commit();
    res.json({ success: true, message: 'Manual form deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the manual form', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// NEW: POST /applications/:applicationId/offer-letter — Upload offer letter
// ============================================================
router.post('/applications/:applicationId/offer-letter', upload.single('offerLetter'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId } = req.params;

    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }

    const [application] = await connection.query('SELECT id, offer_letter_path FROM applications WHERE id = ?', [applicationId]);
    if (application.length === 0) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    if (application[0].offer_letter_path) {
      const old = path.join(__dirname, '..', application[0].offer_letter_path);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }

    const filePath = `/uploads/application-forms/${req.file.filename}`;
    await connection.query('UPDATE applications SET offer_letter_path = ?, offer_letter_uploaded_at = NOW() WHERE id = ?', [filePath, applicationId]);
    await connection.commit();
    res.json({ success: true, message: 'Offer letter uploaded successfully', filePath });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading offer letter:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the offer letter', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


// ============================================================
// NEW: GET /applications/:applicationId/offer-letter
// ============================================================
router.get('/applications/:applicationId/offer-letter', async (req, res) => {
  try {
    const { applicationId } = req.params;
    const [result] = await pool.query('SELECT offer_letter_path, offer_letter_uploaded_at FROM applications WHERE id = ?', [applicationId]);
    if (result.length === 0) return res.status(404).json({ success: false, message: 'Application not found' });
    res.json({
      success: true,
      offerLetter: result[0].offer_letter_path
        ? { filePath: result[0].offer_letter_path, uploadedAt: result[0].offer_letter_uploaded_at }
        : null
    });
  } catch (error) {
    console.error('Error fetching offer letter:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch offer letter', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ============================================================
// NEW: DELETE /applications/:applicationId/offer-letter
// ============================================================
router.delete('/applications/:applicationId/offer-letter', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId } = req.params;

    const [application] = await connection.query('SELECT offer_letter_path FROM applications WHERE id = ?', [applicationId]);
    if (application.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Application not found' }); }
    if (!application[0].offer_letter_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No offer letter found' }); }

    const filePath = path.join(__dirname, '..', application[0].offer_letter_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.query('UPDATE applications SET offer_letter_path = NULL, offer_letter_uploaded_at = NULL WHERE id = ?', [applicationId]);
    await connection.commit();
    res.json({ success: true, message: 'Offer letter deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting offer letter:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the offer letter', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    connection.release();
  }
});


router.post('/applications/:applicationId/documents', upload.single('document'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureApplicationSchema();
    await connection.beginTransaction();
    const { applicationId } = req.params;
    const documentType = (req.body.documentType || '').trim();

    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    if (!documentType) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Document type is required' });
    }

    const [application] = await connection.query('SELECT id FROM applications WHERE id = ?', [applicationId]);
    if (application.length === 0) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    const filePath = `/uploads/application-forms/${req.file.filename}`;
    const [result] = await connection.query(
      `INSERT INTO application_documents (application_id, document_type, file_path, original_name)
       VALUES (?, ?, ?, ?)`,
      [applicationId, documentType, filePath, req.file.originalname]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      document: {
        id: result.insertId,
        document_type: documentType,
        file_path: filePath,
        original_name: req.file.originalname,
        uploaded_at: new Date(),
      }
    });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading application document:', error);
    res.status(500).json({ success: false, message: 'Failed to upload document' });
  } finally {
    connection.release();
  }
});

router.get('/applications/:applicationId/documents', async (req, res) => {
  try {
    await ensureApplicationSchema();
    const { applicationId } = req.params;
    const [documents] = await pool.query(
      'SELECT * FROM application_documents WHERE application_id = ? ORDER BY uploaded_at DESC',
      [applicationId]
    );
    res.json({ success: true, documents });
  } catch (error) {
    console.error('Error fetching application documents:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
});

router.delete('/applications/:applicationId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { applicationId, documentId } = req.params;
    const [docs] = await connection.query(
      'SELECT * FROM application_documents WHERE id = ? AND application_id = ?',
      [documentId, applicationId]
    );
    if (docs.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    const full = path.join(__dirname, '..', docs[0].file_path);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    await connection.query('DELETE FROM application_documents WHERE id = ?', [documentId]);
    await connection.commit();
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting application document:', error);
    res.status(500).json({ success: false, message: 'Failed to delete document' });
  } finally {
    connection.release();
  }
});

router.get('/dashboard/stats', async (req, res) => {
  try {
    const [leadStats] = await pool.query(`SELECT COUNT(*) as total_leads FROM leads`);
    const [studentStats] = await pool.query(`SELECT COUNT(*) as total_students FROM users WHERE role = 'client'`);
    const [applicationStats] = await pool.query(`SELECT COUNT(*) as active_applications FROM applications WHERE application_status NOT IN ('Closed', 'Rejected')`);
    const [visaStats] = await pool.query(`SELECT SUM(CASE WHEN visa_status = 'Pending' THEN 1 ELSE 0 END) as pending_visas, SUM(CASE WHEN visa_status = 'Approved' THEN 1 ELSE 0 END) as approved_visas FROM visas`);
    res.json({
      success: true,
      stats: {
        totalLeads: leadStats[0].total_leads,
        totalStudents: studentStats[0].total_students,
        activeApplications: applicationStats[0].active_applications,
        pendingVisas: visaStats[0].pending_visas || 0,
        approvedVisas: visaStats[0].approved_visas || 0
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard statistics' });
  }
});

router.get('/dashboard/recent-applications', async (req, res) => {
  try {
    const [applications] = await pool.query(
      `SELECT 
         a.id, 
         a.application_id, 
         a.program, 
         a.application_status, 
         a.created_at,
         u.name as student_name,
         u.student_id as student_number,
         c.country_name,
         GROUP_CONCAT(DISTINCT co.name ORDER BY co.name SEPARATOR ', ') as counselor_names
       FROM applications a
       INNER JOIN users u ON a.student_id = u.id
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN student_counselors sc ON sc.user_id = a.student_id
       LEFT JOIN counselors co ON co.id = sc.counselor_id
       GROUP BY 
         a.id, a.application_id, a.program, a.application_status, 
         a.created_at, u.name, u.student_id, c.country_name
       ORDER BY a.created_at DESC
       LIMIT 5`
    );
    res.json({ success: true, applications });
  } catch (error) {
    console.error('Error fetching recent applications:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recent applications' });
  }
});

export default router;