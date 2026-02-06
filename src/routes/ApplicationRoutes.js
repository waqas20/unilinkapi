import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

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
       INNER JOIN universities un ON a.university_id = un.id
       INNER JOIN intakes i ON a.intake_id = i.id
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
       INNER JOIN universities un ON a.university_id = un.id
       INNER JOIN intakes i ON a.intake_id = i.id
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
       INNER JOIN universities un ON a.university_id = un.id
       INNER JOIN intakes i ON a.intake_id = i.id
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
    
    // Check if application exists
    const [existingApplication] = await connection.query(
      'SELECT id, application_id FROM applications WHERE id = ?',
      [applicationId]
    );
    
    if (existingApplication.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found' 
      });
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