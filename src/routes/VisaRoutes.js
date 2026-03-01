import express from 'express';
import pool from '../config/db.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Serve uploaded files
router.get('/uploads/visa-documents/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, '../uploads/visa-documents', filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ success: false, message: 'File not found' });
  }
});

// Configure multer for visa document uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/visa-documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'visa-' + uniqueSuffix + path.extname(file.originalname));
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

// Generate visa ID
const generateVisaId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(visa_id, 9) AS UNSIGNED)) as max_id 
     FROM visas 
     WHERE visa_id LIKE 'VISA${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `VISA${currentYear}${String(nextId).padStart(3, '0')}`;
};


// ============================================================
// CHANGED METHOD 1: GET /visas
// Added: institute, submission_date, submitted_by to SELECT
// ============================================================
router.get('/visas', async (req, res) => {
  try {
    const [visas] = await pool.query(
      `SELECT v.*,
              v.institute,
              v.submission_date,
              v.submitted_by,
              u.name as student_name,
              u.student_id,
              u.email as student_email,
              u.mobile as student_mobile,
              u.country as student_country
       FROM visas v
       INNER JOIN users u ON v.student_id = u.id
       WHERE u.role = 'client'
       ORDER BY v.created_at DESC`
    );

    // Get document counts for each visa
    for (let visa of visas) {
      const [feeReceipts] = await pool.query(
        'SELECT COUNT(*) as count FROM visa_fee_receipts WHERE visa_id = ?',
        [visa.id]
      );
      const [financialDocs] = await pool.query(
        'SELECT COUNT(*) as count FROM visa_financial_documents WHERE visa_id = ?',
        [visa.id]
      );
      const [photos] = await pool.query(
        'SELECT COUNT(*) as count FROM visa_passport_photos WHERE visa_id = ?',
        [visa.id]
      );
      visa.fee_receipts_count = feeReceipts[0].count;
      visa.financial_docs_count = financialDocs[0].count;
      visa.passport_photos_count = photos[0].count;
    }

    res.json({ success: true, visas, total: visas.length });

  } catch (error) {
    console.error('Error fetching visas:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch visas',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 2: GET /visas/statistics
// Updated to use new status values
// ============================================================
router.get('/visas/statistics', async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN visa_status = 'To be applied' THEN 1 ELSE 0 END) as to_be_applied,
        SUM(CASE WHEN visa_status = 'In Progress'   THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN visa_status = 'Approved'      THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN visa_status = 'Rejected'      THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN visa_appointment_date >= CURDATE() 
                  AND visa_appointment_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
             THEN 1 ELSE 0 END) as upcoming_appointments
      FROM visas
    `);

    res.json({ success: true, statistics: stats[0] });

  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 3: GET /visas/:visaId
// Added: institute, submission_date, submitted_by to SELECT
// ============================================================
router.get('/visas/:visaId', async (req, res) => {
  try {
    const { visaId } = req.params;

    const [visas] = await pool.query(
      `SELECT v.*,
              v.institute,
              v.submission_date,
              v.submitted_by,
              u.name as student_name,
              u.student_id,
              u.email as student_email,
              u.mobile as student_mobile,
              u.address as student_address,
              u.country as student_country,
              u.dob as student_dob
       FROM visas v
       INNER JOIN users u ON v.student_id = u.id
       WHERE v.id = ?`,
      [visaId]
    );

    if (visas.length === 0) {
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    const [feeReceipts] = await pool.query(
      'SELECT * FROM visa_fee_receipts WHERE visa_id = ? ORDER BY uploaded_at DESC',
      [visaId]
    );
    const [financialDocs] = await pool.query(
      'SELECT * FROM visa_financial_documents WHERE visa_id = ? ORDER BY uploaded_at DESC',
      [visaId]
    );
    const [passportPhotos] = await pool.query(
      'SELECT * FROM visa_passport_photos WHERE visa_id = ? ORDER BY uploaded_at DESC',
      [visaId]
    );

    res.json({
      success: true,
      visa: visas[0],
      feeReceipts,
      financialDocuments: financialDocs,
      passportPhotos
    });

  } catch (error) {
    console.error('Error fetching visa:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 4: POST /visas  (Create)
// Added: institute, submissionDate, submittedBy to body + INSERT
// ============================================================
router.post('/visas', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const {
      studentId,
      visaNumber,
      visaType,
      visaStatus,
      institute,        // NEW
      submissionDate,   // NEW
      submittedBy,      // NEW
      unconditionalOffer,
      visaLetter,
      accommodation,
      tbCertificate,
      affidavit,
      financialDocuments,
      visaLink,
      visaPassword,
      visaAppointmentDate,
      visaOutcome
    } = req.body;

    if (!studentId || !visaType || !visaStatus) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Student ID, visa type, and visa status are required'
      });
    }

    const [student] = await connection.query(
      'SELECT id, name, student_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );

    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const visaId = await generateVisaId(connection);

    const [result] = await connection.query(
      `INSERT INTO visas 
       (visa_id, student_id, visa_number, visa_type, visa_status,
        institute, submission_date, submitted_by,
        unconditional_offer, visa_letter, accommodation, tb_certificate,
        affidavit, financial_documents, visa_link, visa_password,
        visa_appointment_date, visa_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        visaId,
        studentId,
        visaNumber || null,
        visaType,
        visaStatus,
        institute || null,        // NEW
        submissionDate || null,   // NEW
        submittedBy || null,      // NEW
        unconditionalOffer || 'NO',
        visaLetter || 'NO',
        accommodation || null,
        tbCertificate || 'NO',
        affidavit || 'NO',
        financialDocuments || 'NO',
        visaLink || null,
        visaPassword || null,
        visaAppointmentDate || null,
        visaOutcome || null
      ]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Visa created successfully',
      visaId: result.insertId,
      generatedVisaId: visaId
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating visa:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while creating the visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============================================================
// CHANGED METHOD 5: PUT /visas/:visaId  (Update)
// Added: institute, submissionDate, submittedBy to body + UPDATE SET
// ============================================================
router.put('/visas/:visaId', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { visaId } = req.params;
    const {
      visaNumber,
      visaType,
      visaStatus,
      institute,        // NEW
      submissionDate,   // NEW
      submittedBy,      // NEW
      unconditionalOffer,
      visaLetter,
      accommodation,
      tbCertificate,
      affidavit,
      financialDocuments,
      visaLink,
      visaPassword,
      visaAppointmentDate,
      visaOutcome
    } = req.body;

    const [existing] = await connection.query(
      'SELECT id FROM visas WHERE id = ?',
      [visaId]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    await connection.query(
      `UPDATE visas 
       SET visa_number = ?, visa_type = ?, visa_status = ?,
           institute = ?, submission_date = ?, submitted_by = ?,
           unconditional_offer = ?, visa_letter = ?, accommodation = ?,
           tb_certificate = ?, affidavit = ?, financial_documents = ?,
           visa_link = ?, visa_password = ?, visa_appointment_date = ?,
           visa_outcome = ?
       WHERE id = ?`,
      [
        visaNumber || null,
        visaType,
        visaStatus,
        institute || null,        // NEW
        submissionDate || null,   // NEW
        submittedBy || null,      // NEW
        unconditionalOffer || 'NO',
        visaLetter || 'NO',
        accommodation || null,
        tbCertificate || 'NO',
        affidavit || 'NO',
        financialDocuments || 'NO',
        visaLink || null,
        visaPassword || null,
        visaAppointmentDate || null,
        visaOutcome || null,
        visaId
      ]
    );

    await connection.commit();

    res.json({ success: true, message: 'Visa updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating visa:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while updating the visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============================================================
// UNCHANGED METHODS BELOW — kept here for completeness
// DELETE /visas/:visaId, all file upload/delete routes
// are unchanged — no need to modify them.
// ============================================================

// Delete visa
router.delete('/visas/:visaId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;

    const [existing] = await connection.query('SELECT id FROM visas WHERE id = ?', [visaId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    const [feeReceipts] = await connection.query('SELECT file_path FROM visa_fee_receipts WHERE visa_id = ?', [visaId]);
    const [financialDocs] = await connection.query('SELECT file_path FROM visa_financial_documents WHERE visa_id = ?', [visaId]);
    const [photos] = await connection.query('SELECT file_path FROM visa_passport_photos WHERE visa_id = ?', [visaId]);
    const [visa] = await connection.query('SELECT birth_certificate_path, travel_history_path FROM visas WHERE id = ?', [visaId]);

    await connection.query('DELETE FROM visas WHERE id = ?', [visaId]);
    await connection.commit();

    const deleteFile = (filePath) => {
      if (filePath) {
        const fullPath = path.join(__dirname, '..', filePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
    };

    feeReceipts.forEach(r => deleteFile(r.file_path));
    financialDocs.forEach(d => deleteFile(d.file_path));
    photos.forEach(p => deleteFile(p.file_path));
    deleteFile(visa[0]?.birth_certificate_path);
    deleteFile(visa[0]?.travel_history_path);

    res.json({ success: true, message: 'Visa deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting visa:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the visa' });
  } finally {
    connection.release();
  }
});

// Upload fee receipt
router.post('/visas/:visaId/fee-receipts', upload.single('feeReceipt'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const { receiptName } = req.body;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_fee_receipts (visa_id, receipt_name, file_path) VALUES (?, ?, ?)', [visaId, receiptName || 'Fee Receipt', filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Fee receipt uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the fee receipt' });
  } finally { connection.release(); }
});

// Delete fee receipt
router.delete('/visas/:visaId/fee-receipts/:receiptId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, receiptId } = req.params;
    const [receipt] = await connection.query('SELECT file_path FROM visa_fee_receipts WHERE id = ? AND visa_id = ?', [receiptId, visaId]);
    if (receipt.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Fee receipt not found' }); }
    await connection.query('DELETE FROM visa_fee_receipts WHERE id = ? AND visa_id = ?', [receiptId, visaId]);
    const filePath = path.join(__dirname, '..', receipt[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Fee receipt deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the fee receipt' });
  } finally { connection.release(); }
});

// Upload birth certificate
router.post('/visas/:visaId/birth-certificate', upload.single('birthCertificate'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const [visa] = await connection.query('SELECT birth_certificate_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (visa[0].birth_certificate_path) { const old = path.join(__dirname, '..', visa[0].birth_certificate_path); if (fs.existsSync(old)) fs.unlinkSync(old); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('UPDATE visas SET birth_certificate_path = ? WHERE id = ?', [filePath, visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Birth certificate uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the birth certificate' });
  } finally { connection.release(); }
});

// Delete birth certificate
router.delete('/visas/:visaId/birth-certificate', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const [visa] = await connection.query('SELECT birth_certificate_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (!visa[0].birth_certificate_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No birth certificate found' }); }
    const filePath = path.join(__dirname, '..', visa[0].birth_certificate_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.query('UPDATE visas SET birth_certificate_path = NULL WHERE id = ?', [visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Birth certificate deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the birth certificate' });
  } finally { connection.release(); }
});

// Upload financial document
router.post('/visas/:visaId/financial-documents', upload.single('financialDocument'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const { documentName } = req.body;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_financial_documents (visa_id, document_name, file_path) VALUES (?, ?, ?)', [visaId, documentName || 'Financial Document', filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Financial document uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the financial document' });
  } finally { connection.release(); }
});

// Delete financial document
router.delete('/visas/:visaId/financial-documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, documentId } = req.params;
    const [document] = await connection.query('SELECT file_path FROM visa_financial_documents WHERE id = ? AND visa_id = ?', [documentId, visaId]);
    if (document.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Financial document not found' }); }
    await connection.query('DELETE FROM visa_financial_documents WHERE id = ? AND visa_id = ?', [documentId, visaId]);
    const filePath = path.join(__dirname, '..', document[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Financial document deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the financial document' });
  } finally { connection.release(); }
});

// Upload travel history
router.post('/visas/:visaId/travel-history', upload.single('travelHistory'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const [visa] = await connection.query('SELECT travel_history_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (visa[0].travel_history_path) { const old = path.join(__dirname, '..', visa[0].travel_history_path); if (fs.existsSync(old)) fs.unlinkSync(old); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('UPDATE visas SET travel_history_path = ? WHERE id = ?', [filePath, visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Travel history uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the travel history' });
  } finally { connection.release(); }
});

// Delete travel history
router.delete('/visas/:visaId/travel-history', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const [visa] = await connection.query('SELECT travel_history_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (!visa[0].travel_history_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No travel history found' }); }
    const filePath = path.join(__dirname, '..', visa[0].travel_history_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.query('UPDATE visas SET travel_history_path = NULL WHERE id = ?', [visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Travel history deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the travel history' });
  } finally { connection.release(); }
});

// Upload passport photo
router.post('/visas/:visaId/passport-photos', upload.single('passportPhoto'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_passport_photos (visa_id, file_path) VALUES (?, ?)', [visaId, filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Passport photo uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the passport photo' });
  } finally { connection.release(); }
});

// Delete passport photo
router.delete('/visas/:visaId/passport-photos/:photoId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, photoId } = req.params;
    const [photo] = await connection.query('SELECT file_path FROM visa_passport_photos WHERE id = ? AND visa_id = ?', [photoId, visaId]);
    if (photo.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Passport photo not found' }); }
    await connection.query('DELETE FROM visa_passport_photos WHERE id = ? AND visa_id = ?', [photoId, visaId]);
    const filePath = path.join(__dirname, '..', photo[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Passport photo deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the passport photo' });
  } finally { connection.release(); }
});

export default router;