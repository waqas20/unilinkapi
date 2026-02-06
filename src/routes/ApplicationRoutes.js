import express from 'express';
import pool from '../config/db.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for manual form uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/application-forms');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'form-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, and documents are allowed'));
    }
  }
});

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

// Get all applications with related data
router.get('/applications', async (req, res) => {
  try {
    const [applications] = await pool.query(
      `SELECT a.*, 
              u.name as student_full_name,
              u.student_id as student_number,
              c.country_name,
              un.university_name,
              i.intake_name
       FROM applications a
       INNER JOIN users u ON a.student_id = u.id
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       ORDER BY a.created_at DESC`
    );
    
    res.json({
      success: true,
      applications: applications,
      total: applications.length
    });
    
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch applications',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single application by ID
router.get('/applications/:applicationId', async (req, res) => {
  try {
    const { applicationId } = req.params;
    
    const [applications] = await pool.query(
      `SELECT a.*, 
              u.name as student_full_name,
              u.student_id as student_number,
              u.email as student_email,
              u.mobile as student_mobile,
              c.country_name,
              un.university_name,
              i.intake_name
       FROM applications a
       INNER JOIN users u ON a.student_id = u.id
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       WHERE a.id = ?`,
      [applicationId]
    );
    
    if (applications.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
    }
    
    res.json({
      success: true,
      application: applications[0]
    });
    
  } catch (error) {
    console.error('Error fetching application:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get applications by student
router.get('/applications/student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const [applications] = await pool.query(
      `SELECT a.*, 
              c.country_name,
              un.university_name,
              i.intake_name
       FROM applications a
       INNER JOIN countries c ON a.country_id = c.id
       LEFT JOIN universities un ON a.university_id = un.id
       LEFT JOIN intakes i ON a.intake_id = i.id
       WHERE a.student_id = ?
       ORDER BY a.created_at DESC`,
      [studentId]
    );
    
    res.json({
      success: true,
      applications: applications,
      total: applications.length
    });
    
  } catch (error) {
    console.error('Error fetching student applications:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch applications',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new application
router.post('/applications', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      applicationDate, studentId, countryId, universityId, intakeId,
      program, appsSubmittedThrough, appsTaggedThrough, universityFees,
      acceptedRejected, withdrawn, condition, firm, insurance, finalChoice,
      depositPaid, applicationStatus, taggingStatus, remarks
    } = req.body;
    
    // Validate required fields
    if (!applicationDate || !studentId || !countryId || !universityId || !intakeId || !program) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Application date, student, country, university, intake, and program are required' 
      });
    }

    // Verify student exists
    const [student] = await connection.query(
      'SELECT id, name, student_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Verify country exists
    const [country] = await connection.query(
      'SELECT id FROM countries WHERE id = ?',
      [countryId]
    );
    
    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Country not found' 
      });
    }

    // Verify university exists and belongs to selected country
    const [university] = await connection.query(
      'SELECT id FROM universities WHERE id = ? AND country_id = ?',
      [universityId, countryId]
    );
    
    if (university.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'University not found or does not belong to selected country' 
      });
    }

    // Verify intake exists and belongs to selected university
    const [intake] = await connection.query(
      'SELECT id FROM intakes WHERE id = ? AND university_id = ?',
      [intakeId, universityId]
    );
    
    if (intake.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Intake not found or does not belong to selected university' 
      });
    }

    // Generate application ID
    const applicationId = await generateApplicationId(connection);
    
    // Insert application
    const [result] = await connection.query(
      `INSERT INTO applications 
       (application_id, application_date, student_id, student_name, country_id, 
        university_id, intake_id, program, apps_submitted_through, apps_tagged_through, 
        university_fees, accepted_rejected, withdrawn, \`condition\`, firm, insurance, 
        final_choice, deposit_paid, application_status, tagging_status, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        applicationId, applicationDate, studentId, student[0].name, countryId,
        universityId, intakeId, program.trim(), appsSubmittedThrough?.trim() || null,
        appsTaggedThrough?.trim() || null, universityFees || null, acceptedRejected || null,
        withdrawn || 'No', condition?.trim() || null, firm?.trim() || null,
        insurance?.trim() || null, finalChoice?.trim() || null, depositPaid || 'No',
        applicationStatus || 'Pending', taggingStatus || 'Not Received', remarks?.trim() || null
      ]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Application created successfully',
      applicationId: result.insertId,
      generatedApplicationId: applicationId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating application:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while creating the application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update application
router.put('/applications/:applicationId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { applicationId } = req.params;
    const {
      applicationDate, studentId, countryId, universityId, intakeId,
      program, appsSubmittedThrough, appsTaggedThrough, universityFees,
      acceptedRejected, withdrawn, condition, firm, insurance, finalChoice,
      depositPaid, applicationStatus, taggingStatus, remarks
    } = req.body;
    
    // Validate required fields
    if (!applicationDate || !studentId || !countryId || !universityId || !intakeId || !program) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Application date, student, country, university, intake, and program are required' 
      });
    }

    // Check if application exists
    const [existingApplication] = await connection.query(
      'SELECT id FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (existingApplication.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
    }

    // Verify student exists
    const [student] = await connection.query(
      'SELECT id, name FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Verify country exists
    const [country] = await connection.query(
      'SELECT id FROM countries WHERE id = ?',
      [countryId]
    );
    
    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Country not found' 
      });
    }

    // Verify university exists and belongs to selected country
    const [university] = await connection.query(
      'SELECT id FROM universities WHERE id = ? AND country_id = ?',
      [universityId, countryId]
    );
    
    if (university.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'University not found or does not belong to selected country' 
      });
    }

    // Verify intake exists and belongs to selected university
    const [intake] = await connection.query(
      'SELECT id FROM intakes WHERE id = ? AND university_id = ?',
      [intakeId, universityId]
    );
    
    if (intake.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Intake not found or does not belong to selected university' 
      });
    }

    // Format date
    const formattedDate = applicationDate.split('T')[0];
    
    // Update application
    await connection.query(
      `UPDATE applications 
       SET application_date = ?, student_id = ?, student_name = ?, country_id = ?, 
           university_id = ?, intake_id = ?, program = ?, apps_submitted_through = ?, 
           apps_tagged_through = ?, university_fees = ?, accepted_rejected = ?, 
           withdrawn = ?, \`condition\` = ?, firm = ?, insurance = ?, final_choice = ?, 
           deposit_paid = ?, application_status = ?, tagging_status = ?, remarks = ?
       WHERE id = ?`,
      [
        formattedDate, studentId, student[0].name, countryId, universityId, intakeId,
        program.trim(), appsSubmittedThrough?.trim() || null, appsTaggedThrough?.trim() || null,
        universityFees || null, acceptedRejected || null, withdrawn || 'No',
        condition?.trim() || null, firm?.trim() || null, insurance?.trim() || null,
        finalChoice?.trim() || null, depositPaid || 'No', applicationStatus || 'Pending',
        taggingStatus || 'Not Received', remarks?.trim() || null, applicationId
      ]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Application updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating application:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete application
router.delete('/applications/:applicationId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { applicationId } = req.params;
    
    // Check if application exists and get manual form path
    const [existingApplication] = await connection.query(
      'SELECT id, application_id, manual_form_path FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (existingApplication.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
    }
    
    // Delete manual form file if exists
    if (existingApplication[0].manual_form_path) {
      const filePath = path.join(__dirname, '..', existingApplication[0].manual_form_path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    // Delete application
    await connection.query('DELETE FROM applications WHERE id = ?', [applicationId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Application deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting application:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Upload manual form for application
router.post('/applications/:applicationId/manual-form', upload.single('manualForm'), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { applicationId } = req.params;
    
    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }
    
    // Check if application exists
    const [application] = await connection.query(
      'SELECT id, manual_form_path FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (application.length === 0) {
      await connection.rollback();
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
    }
    
    // Delete old file if exists
    if (application[0].manual_form_path) {
      const oldFilePath = path.join(__dirname, '..', application[0].manual_form_path);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    
    const filePath = `/uploads/application-forms/${req.file.filename}`;
    
    // Update application record with manual form path
    await connection.query(
      'UPDATE applications SET manual_form_path = ?, manual_form_uploaded_at = NOW() WHERE id = ?',
      [filePath, applicationId]
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

// Get manual form for application
router.get('/applications/:applicationId/manual-form', async (req, res) => {
  try {
    const { applicationId } = req.params;
    
    const [result] = await pool.query(
      'SELECT manual_form_path, manual_form_uploaded_at FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (result.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
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

// Delete manual form for application
router.delete('/applications/:applicationId/manual-form', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { applicationId } = req.params;
    
    // Get file path
    const [application] = await connection.query(
      'SELECT manual_form_path FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (application.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
    }
    
    if (!application[0].manual_form_path) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'No manual form found' 
      });
    }
    
    // Delete file from filesystem
    const filePath = path.join(__dirname, '..', application[0].manual_form_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Update database
    await connection.query(
      'UPDATE applications SET manual_form_path = NULL, manual_form_uploaded_at = NULL WHERE id = ?',
      [applicationId]
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

// Get application statistics
router.get('/applications/stats/overview', async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_applications,
        SUM(CASE WHEN application_status = 'Pending' THEN 1 ELSE 0 END) as pending_applications,
        SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END) as approved_applications,
        SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END) as rejected_applications,
        SUM(CASE WHEN application_status = 'Closed' THEN 1 ELSE 0 END) as closed_applications,
        SUM(CASE WHEN accepted_rejected = 'Accepted' THEN 1 ELSE 0 END) as accepted_count,
        SUM(CASE WHEN accepted_rejected = 'Rejected' THEN 1 ELSE 0 END) as rejected_count,
        SUM(CASE WHEN deposit_paid = 'Yes' THEN 1 ELSE 0 END) as deposit_paid_count,
        COUNT(DISTINCT student_id) as unique_students
       FROM applications`
    );
    
    res.json({
      success: true,
      stats: stats[0]
    });
    
  } catch (error) {
    console.error('Error fetching application statistics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;