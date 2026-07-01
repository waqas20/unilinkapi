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
  limits: { fileSize: 5 * 1024 * 1024 },
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

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

const generatePassword = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

const serializeQualifications = (qualifications) => {
  if (!Array.isArray(qualifications) || qualifications.length === 0) return null;
  const filtered = qualifications.filter(q => q.qualification?.trim() || q.subject?.trim() || q.grade?.trim());
  return filtered.length > 0 ? JSON.stringify(filtered) : null;
};

const serializeAdmissionTests = (admissionTests) => {
  if (!admissionTests || typeof admissionTests !== 'object') return null;
  return JSON.stringify(admissionTests);
};

const serializeCountries = (countriesOfInterest) => {
  if (!Array.isArray(countriesOfInterest) || countriesOfInterest.length === 0) return null;
  return JSON.stringify(countriesOfInterest);
};

// ─── DB Migration Note ────────────────────────────────────────────────────────
// Run the following ALTER statements once against your MySQL database if you
// haven't already added these columns:
//
//   ALTER TABLE leads
//     ADD COLUMN IF NOT EXISTS program      VARCHAR(100)  NULL,
//     ADD COLUMN IF NOT EXISTS grades       TEXT          NULL,
//     ADD COLUMN IF NOT EXISTS purpose_of_visit TEXT      NULL,
//     ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'Unpaid',
//     ADD COLUMN IF NOT EXISTS qualifications TEXT        NULL,
//     ADD COLUMN IF NOT EXISTS counsellor_notes TEXT      NULL,
//     ADD COLUMN IF NOT EXISTS referred_by  VARCHAR(255)  NULL,
//     ADD COLUMN IF NOT EXISTS countries_other VARCHAR(255) NULL,
//     ADD COLUMN IF NOT EXISTS admission_tests TEXT       NULL;
//
// For the users table, ensure the following columns exist:
//   middle_name, surname, alternative_email, landline, postal_code,
//   nationality, marital_status, gender, city_of_birth, country_of_birth,
//   passport_no, passport_issue_date, passport_place_of_issue,
//   source_inquiry, payment_status VARCHAR(20) DEFAULT 'Unpaid',
//   invoice_id INT NULL  ← NEW: links the student to an invoice at registration
//
// Run GET /leads/migrate-invoice to add the invoice_id column safely.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Migrate: add invoice_id to users table ───────────────────────────────────
router.get('/leads/migrate-invoice', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS invoice_id INT NULL
    `).catch(() => {});

    // Also add a foreign key if not already there (best-effort)
    await connection.query(`
      ALTER TABLE users
      ADD CONSTRAINT fk_users_invoice
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
    `).catch(() => {}); // Ignore if FK already exists or invoices table differs

    res.json({ success: true, message: 'Migration applied: users.invoice_id column ready.' });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ─── Invoice search for student registration ──────────────────────────────────
// GET /leads/invoices/search?q=searchTerm
// Returns invoices that are NOT yet linked to any student (invoice_id on users),
// filtered by invoice_id string, student_name, or final_amount.
// Only Student-type invoices are returned (commission invoices aren't linked to students).
router.get('/leads/invoices/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) {
      return res.json({ success: true, invoices: [] });
    }

    const searchTerm = `%${q.trim()}%`;

    const [invoices] = await pool.query(
      `SELECT 
         i.id,
         i.invoice_id,
         i.invoice_type,
         i.invoice_date,
         i.final_amount,
         i.payment_status,
         i.student_name,
         i.student_ref_id,
         i.is_manual_student,
         i.manual_student_name,
         ba.bank_name,
         ba.account_name
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       WHERE i.invoice_type = 'Student'
         AND i.id NOT IN (
           SELECT invoice_id FROM users WHERE invoice_id IS NOT NULL
         )
         AND (
           i.invoice_id LIKE ?
           OR i.student_name LIKE ?
           OR i.manual_student_name LIKE ?
           OR i.student_ref_id LIKE ?
           OR CAST(i.final_amount AS CHAR) LIKE ?
         )
       ORDER BY i.created_at DESC
       LIMIT 20`,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );

    res.json({ success: true, invoices });
  } catch (error) {
    console.error('Error searching invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to search invoices' });
  }
});

// Create new lead (First Time Query)
router.post('/leads', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      fullName, email, phone, address,
      interest, program,
      countriesOfInterest, countriesOther,
      qualifications, referredBy, counsellorNotes, admissionTests
    } = req.body;
    
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Full name must be at least 3 characters long' });
    }

    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a complete address (minimum 10 characters)' });
    }
    
    const [existingLead] = await connection.query(
      'SELECT id, full_name, email FROM leads WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingLead.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A lead with this email address already exists. Please use the Follow Up option to update your information.',
        existingLead: { name: existingLead[0].full_name, email: existingLead[0].email }
      });
    }

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = serializeQualifications(qualifications);
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    
    const [result] = await connection.query(
      `INSERT INTO leads
         (full_name, email, phone, address, interest, program,
          countries_of_interest, countries_other, qualifications,
          referred_by, counsellor_notes, admission_tests, is_follow_up, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, 'New')`,
      [
        trimmedName, trimmedEmail, trimmedPhone, address.trim(),
        interest.trim(), program?.trim() || null,
        countriesJson, countriesOther?.trim() || null, qualificationsJson,
        referredBy?.trim() || null, counsellorNotes?.trim() || null,
        admissionTestsJson
      ]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Your Form has been submitted successfully!',
      leadId: result.insertId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while submitting your registration. Please try again later.' });
  } finally {
    connection.release();
  }
});

// Lookup lead for follow-up
router.post('/leads/lookup', async (req, res) => {
  try {
    const { lookupName, lookupEmail, lookupPhone, purposeOfVisit } = req.body;
    
    if (!lookupName) {
      return res.status(400).json({ success: false, message: 'Full name is required to lookup your information' });
    }

    const hasEmail = lookupEmail && lookupEmail.trim().length > 0;
    const hasPhone = lookupPhone && lookupPhone.trim().length > 0;

    if (!hasEmail && !hasPhone) {
      return res.status(400).json({ success: false, message: 'Please provide either an email address or phone number' });
    }

    const trimmedName = lookupName.trim();

    if (hasEmail && !validateEmail(lookupEmail.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (hasPhone && !validatePhone(lookupPhone.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (!purposeOfVisit || !purposeOfVisit.trim()) {
      return res.status(400).json({ success: false, message: 'Purpose of visit is required' });
    }

    let whereClause = 'LOWER(TRIM(full_name)) = LOWER(?)';
    const queryParams = [trimmedName];

    if (hasEmail && hasPhone) {
      whereClause += ' AND (LOWER(TRIM(email)) = LOWER(?) OR REPLACE(REPLACE(REPLACE(phone, " ", ""), "-", ""), "+", "") LIKE ?)';
      const normalizedPhone = '%' + lookupPhone.trim().replace(/\D/g, '');
      queryParams.push(lookupEmail.trim().toLowerCase(), normalizedPhone);
    } else if (hasEmail) {
      whereClause += ' AND LOWER(TRIM(email)) = LOWER(?)';
      queryParams.push(lookupEmail.trim().toLowerCase());
    } else {
      whereClause += ' AND REPLACE(REPLACE(REPLACE(phone, " ", ""), "-", ""), "+", "") LIKE ?';
      const normalizedPhone = '%' + lookupPhone.trim().replace(/\D/g, '');
      queryParams.push(normalizedPhone);
    }
    
    const [leads] = await pool.query(
      `SELECT id, full_name, email, phone, address, interest, program, comments,
              countries_of_interest, countries_other, grades, qualification, qualifications,
              referred_by, counsellor_notes, admission_tests,
              (SELECT COUNT(*) FROM follow_ups WHERE lead_id = leads.id) as follow_up_count,
              created_at, updated_at
       FROM leads 
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT 1`,
      queryParams
    );
    
    if (leads.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No record found with the provided details. Please check your information or submit a new registration.' 
      });
    }

    await pool.query(
      'UPDATE leads SET purpose_of_visit = ? WHERE id = ?',
      [purposeOfVisit.trim(), leads[0].id]
    );
    
    res.json({
      success: true,
      message: 'Your information has been retrieved successfully',
      lead: leads[0]
    });
    
  } catch (error) {
    console.error('Error looking up lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while looking up your information. Please try again later.' });
  }
});

// Create follow-up and track changes
router.post('/leads/:leadId/follow-up', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const {
      fullName, email, phone, address,
      interest, program,
      countriesOfInterest, countriesOther,
      qualifications, referredBy, counsellorNotes, admissionTests,
      purposeOfVisit
    } = req.body;
    
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Full name must be at least 3 characters long' });
    }

    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a complete address (minimum 10 characters)' });
    }
    
    const [currentLead] = await connection.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    
    if (currentLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead record not found' });
    }
    
    const oldData = currentLead[0];

    if (trimmedEmail !== oldData.email.toLowerCase()) {
      const [emailCheck] = await connection.query(
        'SELECT id FROM leads WHERE email = ? AND id != ?',
        [trimmedEmail, leadId]
      );
      if (emailCheck.length > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'This email address is already associated with another record. Please use a different email.' });
      }
    }
    
    const [followUpCount] = await connection.query(
      'SELECT COUNT(*) as count FROM follow_ups WHERE lead_id = ?',
      [leadId]
    );
    
    const nextFollowUpNumber = followUpCount[0].count + 1;
    
    const [followUpResult] = await connection.query(
      'INSERT INTO follow_ups (lead_id, follow_up_number, notes) VALUES (?, ?, ?)',
      [leadId, nextFollowUpNumber, `Follow-up #${nextFollowUpNumber} - Updated information`]
    );
    
    const followUpId = followUpResult.insertId;

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = serializeQualifications(qualifications);
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    
    const changes = [];
    const fieldsToTrack = {
      fullName: 'full_name',
      email: 'email',
      phone: 'phone',
      address: 'address',
      interest: 'interest',
      program: 'program',
      counsellorNotes: 'counsellor_notes',
      countriesOfInterest: 'countries_of_interest',
      countriesOther: 'countries_other',
      qualifications: 'qualifications',
      referredBy: 'referred_by',
      admissionTests: 'admission_tests'
    };

    const newValues = {
      fullName: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      address: address.trim(),
      interest: interest.trim(),
      program: program?.trim() || null,
      counsellorNotes: counsellorNotes?.trim() || null,
      countriesOfInterest: countriesJson,
      countriesOther: countriesOther?.trim() || null,
      qualifications: qualificationsJson,
      referredBy: referredBy?.trim() || null,
      admissionTests: admissionTestsJson
    };
    
    for (const [requestField, dbField] of Object.entries(fieldsToTrack)) {
      const newValue = newValues[requestField];
      const oldValue = oldData[dbField];
      const oldVal = oldValue === null ? '' : String(oldValue).trim();
      const newVal = newValue === null ? '' : String(newValue).trim();
      if (newVal !== oldVal) {
        changes.push([leadId, followUpId, dbField, oldValue, newValue]);
      }
    }
    
    if (changes.length > 0) {
      await connection.query(
        `INSERT INTO lead_changes (lead_id, follow_up_id, field_name, old_value, new_value) VALUES ?`,
        [changes]
      );
    }
    
    await connection.query(
      `UPDATE leads 
       SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?,
           countries_of_interest = ?, countries_other = ?, qualifications = ?,
           referred_by = ?, counsellor_notes = ?, admission_tests = ?,
           purpose_of_visit = ?, is_follow_up = TRUE
       WHERE id = ?`,
      [
        trimmedName, trimmedEmail, trimmedPhone, address.trim(),
        interest.trim(), program?.trim() || null,
        countriesJson, countriesOther?.trim() || null, qualificationsJson,
        referredBy?.trim() || null, counsellorNotes?.trim() || null,
        admissionTestsJson,
        purposeOfVisit?.trim() || oldData.purpose_of_visit || null,
        leadId
      ]
    );
    
    await connection.commit();
    
    res.json({ success: true, message: 'Follow-up recorded successfully!', followUpNumber: nextFollowUpNumber });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating follow-up:', error);
    res.status(500).json({ success: false, message: 'An error occurred while submitting your follow-up. Please try again later.' });
  } finally {
    connection.release();
  }
});

// Get lead history with all follow-ups and changes
router.get('/leads/:leadId/history', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [lead] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (lead.length === 0) return res.status(404).json({ success: false, message: 'Lead not found' });
    const [followUps] = await pool.query(
      `SELECT fu.*, l.purpose_of_visit
       FROM follow_ups fu
       LEFT JOIN leads l ON fu.lead_id = l.id
       WHERE fu.lead_id = ? ORDER BY fu.followed_up_at DESC`,
      [leadId]
    );
    const [changes] = await pool.query(
      `SELECT lc.*, fu.follow_up_number, fu.followed_up_at
       FROM lead_changes lc
       LEFT JOIN follow_ups fu ON lc.follow_up_id = fu.id
       WHERE lc.lead_id = ? ORDER BY lc.changed_at DESC`,
      [leadId]
    );
    res.json({ success: true, lead: lead[0], followUps, changes });
  } catch (error) {
    console.error('Error fetching lead history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch lead history' });
  }
});

// Get all leads that have follow-ups — excludes registered students
router.get('/leads/followups', async (req, res) => {
  try {
    const [followups] = await pool.query(
      `SELECT l.*, COUNT(DISTINCT fu.id) as follow_up_count, MAX(fu.followed_up_at) as last_follow_up
       FROM leads l
       INNER JOIN follow_ups fu ON l.id = fu.lead_id
       WHERE l.is_registered = FALSE OR l.is_registered IS NULL
       GROUP BY l.id HAVING follow_up_count > 0 ORDER BY last_follow_up DESC`
    );
    res.json({ success: true, followups, total: followups.length });
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch follow-ups' });
  }
});

// Get all leads — excludes registered students
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
       WHERE l.is_registered = FALSE OR l.is_registered IS NULL
       GROUP BY l.id ORDER BY l.created_at DESC`
    );
    res.json({ success: true, leads, total: leads.length });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch leads' });
  }
});

// Get single lead by ID
router.get('/leads/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [leads] = await pool.query(
      `SELECT l.*, COUNT(DISTINCT fu.id) as follow_up_count, MAX(fu.followed_up_at) as last_follow_up
       FROM leads l LEFT JOIN follow_ups fu ON l.id = fu.lead_id
       WHERE l.id = ? GROUP BY l.id`,
      [leadId]
    );
    if (leads.length === 0) return res.status(404).json({ success: false, message: 'Lead not found' });
    res.json({ success: true, lead: leads[0] });
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch lead' });
  }
});

// Update lead information
router.put('/leads/:leadId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const {
      fullName, email, phone, address,
      interest, program, comments, counsellorNotes,
      status, countriesOfInterest, countriesOther,
      grades, qualification, qualifications,
      referredBy, admissionTests
    } = req.body;
    
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    const [existingLead] = await connection.query('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (existingLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const [emailCheck] = await connection.query('SELECT id FROM leads WHERE email = ? AND id != ?', [trimmedEmail, leadId]);
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This email address is already associated with another lead' });
    }

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = qualifications
      ? serializeQualifications(qualifications)
      : (qualification?.trim() || grades?.trim()
        ? JSON.stringify([{ qualification: qualification?.trim() || '', subject: '', grade: grades?.trim() || '' }])
        : null);
    const notesValue = counsellorNotes?.trim() || comments?.trim() || null;
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    
    await connection.query(
      `UPDATE leads 
       SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?,
           counsellor_notes = ?, status = ?, countries_of_interest = ?, countries_other = ?,
           qualifications = ?, referred_by = ?, admission_tests = ?
       WHERE id = ?`,
      [
        trimmedName, trimmedEmail, trimmedPhone, address.trim(),
        interest.trim(), program?.trim() || null,
        notesValue, status || 'New',
        countriesJson, countriesOther?.trim() || null,
        qualificationsJson, referredBy?.trim() || null,
        admissionTestsJson,
        leadId
      ]
    );
    
    await connection.commit();
    res.json({ success: true, message: 'Lead updated successfully' });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the lead' });
  } finally {
    connection.release();
  }
});

// ─── Register lead as student ─────────────────────────────────────────────────
// Accepts `applicantInfo`, `paymentStatus`, and optionally `invoiceId`.
// If invoiceId is provided, it is linked to the newly created user record.
// An invoice can only be linked to one student (enforced via DB + backend check).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/leads/:leadId/register-student', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { applicantInfo = {}, paymentStatus = 'Unpaid', invoiceId = null } = req.body;

    // ── Payment gate ──────────────────────────────────────────────────────────
    if (paymentStatus !== 'Paid') {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Payment must be completed (Paid) before registering the student.'
      });
    }

    // ── Validate required applicant fields ────────────────────────────────────
    const {
      name, middle_name, surname,
      nationality, marital_status, gender,
      dob, city_of_birth, country_of_birth,
      passport_no, passport_issue_date, passport_place_of_issue,
      address, postal_code, mobile, landline,
      email, alternative_email,
      course, source_inquiry,
      status: studentStatus,
    } = applicantInfo;

    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'First name is required.' });
    }
    if (!surname || !surname.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Last name is required.' });
    }
    if (!mobile || !mobile.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Mobile number is required.' });
    }
    if (!address || !address.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Address is required.' });
    }
    if (!dob) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Date of birth is required.' });
    }

    // ── Validate invoiceId if provided ────────────────────────────────────────
    if (invoiceId) {
      // Check invoice exists and is a Student type
      const [invCheck] = await connection.query(
        `SELECT id, invoice_type FROM invoices WHERE id = ?`,
        [invoiceId]
      );
      if (invCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Selected invoice not found.' });
      }
      if (invCheck[0].invoice_type !== 'Student') {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Only Student-type invoices can be linked to a student profile.' });
      }
      // Check it's not already linked to another student
      const [alreadyLinked] = await connection.query(
        `SELECT id FROM users WHERE invoice_id = ?`,
        [invoiceId]
      );
      if (alreadyLinked.length > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'This invoice is already linked to another student.' });
      }
    }

    // ── Fetch the lead ────────────────────────────────────────────────────────
    const [leads] = await connection.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const lead = leads[0];
    if (lead.is_registered) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This lead is already registered as a student' });
    }

    // Use applicantInfo.email if provided, else fall back to lead email
    const registrationEmail = (email && email.trim())
      ? email.trim().toLowerCase()
      : lead.email;

    const [existingUser] = await connection.query(
      'SELECT id FROM users WHERE email = ?', [registrationEmail]
    );
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A user with this email already exists in the system' });
    }

    // ── Generate student ID ───────────────────────────────────────────────────
    const currentYear = new Date().getFullYear();
    const [idResult] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING(student_id, 8) AS UNSIGNED)) as max_id 
       FROM users WHERE student_id LIKE 'STU${currentYear}%' AND role = 'client'`
    );
    const nextId = (idResult[0].max_id || 0) + 1;
    const studentId = `STU${currentYear}${String(nextId).padStart(3, '0')}`;

    // ── Create password ───────────────────────────────────────────────────────
    const generatedPassword = generatePassword(12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    // ── Format dates ──────────────────────────────────────────────────────────
    const formattedDob = dob.split('T')[0];
    const formattedPassportDate = passport_issue_date
      ? passport_issue_date.split('T')[0]
      : null;

    // ── Insert user with full applicant info ──────────────────────────────────
    // invoice_id column is added by GET /leads/migrate-invoice
    const [userResult] = await connection.query(
      `INSERT INTO users 
         (student_id, name, middle_name, surname,
          email, alternative_email,
          mobile, landline,
          address, postal_code,
          nationality, marital_status, gender,
          dob, city_of_birth, country_of_birth,
          passport_no, passport_issue_date, passport_place_of_issue,
          course, source_inquiry,
          payment_status,
          invoice_id,
          password, role, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?)`,
      [
        studentId,
        name.trim(),
        middle_name?.trim() || null,
        surname.trim(),
        registrationEmail,
        alternative_email?.trim() || null,
        mobile.trim(),
        landline?.trim() || null,
        address.trim(),
        postal_code?.trim() || null,
        nationality?.trim() || null,
        marital_status || null,
        gender || null,
        formattedDob,
        city_of_birth?.trim() || null,
        country_of_birth?.trim() || null,
        passport_no?.trim() || null,
        formattedPassportDate,
        passport_place_of_issue?.trim() || null,
        course?.trim() || null,
        source_inquiry || null,
        'Paid',             // payment_status
        invoiceId || null,  // invoice_id — links to selected invoice
        hashedPassword,
        studentStatus || 'Active',
      ]
    );
    const userId = userResult.insertId;

    // ── Transfer assigned counselors ──────────────────────────────────────────
    const [assignedCounselors] = await connection.query(
      'SELECT counselor_id FROM lead_counselor_assignments WHERE lead_id = ?', [leadId]
    );
    if (assignedCounselors.length > 0) {
      const studentCounselorValues = assignedCounselors.map(c => [userId, c.counselor_id, leadId]);
      await connection.query(
        'INSERT INTO student_counselors (user_id, counselor_id, transferred_from_lead_id) VALUES ?',
        [studentCounselorValues]
      );
    }

    // ── Transfer meetings ─────────────────────────────────────────────────────
    await connection.query(
      'UPDATE counselor_meetings SET user_id = ?, lead_id = NULL WHERE lead_id = ?',
      [userId, leadId]
    );

    // ── Mark lead as registered and store payment status ──────────────────────
    await connection.query(
      'UPDATE leads SET is_registered = TRUE, registered_at = NOW(), payment_status = ? WHERE id = ?',
      ['Paid', leadId]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Lead successfully registered as student',
      userId,
      studentId,
      counselorsTransferred: assignedCounselors.length,
      invoiceLinked: !!invoiceId,
      credentials: { email: registrationEmail, password: generatedPassword }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error registering lead as student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while registering the student' });
  } finally {
    connection.release();
  }
});

// ============ COUNSELOR ASSIGNMENT ENDPOINTS ============

router.get('/leads/:leadId/counselors', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [counselors] = await pool.query(
      `SELECT c.*, lca.assigned_at, lca.notes as assignment_notes
       FROM counselors c
       INNER JOIN lead_counselor_assignments lca ON c.id = lca.counselor_id
       WHERE lca.lead_id = ? ORDER BY lca.assigned_at DESC`,
      [leadId]
    );
    res.json({ success: true, counselors });
  } catch (error) {
    console.error('Error fetching lead counselors:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch assigned counselors' });
  }
});

router.post('/leads/:leadId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { counselorId, notes } = req.body;
    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Counselor ID is required' });
    }
    const [lead] = await connection.query('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const [counselor] = await connection.query('SELECT id FROM counselors WHERE id = ?', [counselorId]);
    if (counselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Counselor not found' });
    }
    const [existing] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This counselor is already assigned to this lead' });
    }
    await connection.query(
      'INSERT INTO lead_counselor_assignments (lead_id, counselor_id, notes) VALUES (?, ?, ?)',
      [leadId, counselorId, notes || null]
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

// ============ MEETING ENDPOINTS ============

router.get('/counselors/:counselorId/available-slots', async (req, res) => {
  try {
    const { counselorId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date parameter is required' });
    const [meetings] = await pool.query(
      `SELECT meeting_time, duration_minutes FROM counselor_meetings 
       WHERE counselor_id = ? AND meeting_date = ? AND status != 'Cancelled' ORDER BY meeting_time`,
      [counselorId, date]
    );
    const bookedSlots = meetings.map(meeting => {
      const [hours, minutes] = meeting.meeting_time.split(':');
      const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
      return { start: startMinutes, end: startMinutes + meeting.duration_minutes };
    });
    res.json({ success: true, bookedSlots });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available slots' });
  }
});

router.get('/leads/:leadId/meetings', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email, l.full_name as lead_name
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       LEFT JOIN leads l ON cm.lead_id = l.id
       WHERE cm.lead_id = ? ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [leadId]
    );
    res.json({ success: true, meetings });
  } catch (error) {
    console.error('Error fetching lead meetings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch meetings' });
  }
});

router.post('/leads/:leadId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;
    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    if (durationMinutes < 15 || durationMinutes > 480) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Duration must be between 15 minutes and 8 hours' });
    }
    const [assignment] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This counselor is not assigned to this lead' });
    }
    const [lead] = await connection.query('SELECT full_name FROM leads WHERE id = ?', [leadId]);
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
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
        return res.status(409).json({ success: false, message: `This time slot conflicts with an existing meeting from ${meeting.meeting_time} (${meeting.duration_minutes} minutes)` });
      }
    }
    await connection.query(
      `INSERT INTO counselor_meetings (counselor_id, lead_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, leadId, lead[0].full_name, `LEAD-${leadId}`, meetingDate, meetingTime, durationMinutes, notes || null]
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

router.put('/meetings/:meetingId/notes', upload.single('notesImage'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { meetingId } = req.params;
    const { notes, status } = req.body;
    const notesImage = req.file ? `/uploads/meeting-notes/${req.file.filename}` : null;
    const [meeting] = await connection.query('SELECT id, meeting_notes_image FROM counselor_meetings WHERE id = ?', [meetingId]);
    if (meeting.length === 0) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }
    if (notesImage && meeting[0].meeting_notes_image) {
      const oldImagePath = path.join(__dirname, '..', meeting[0].meeting_notes_image);
      if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath);
    }
    let updateFields = [];
    let updateValues = [];
    if (notes !== undefined) { updateFields.push('notes = ?'); updateValues.push(notes); }
    if (notesImage) { updateFields.push('meeting_notes_image = ?'); updateValues.push(notesImage); }
    if (status) { updateFields.push('status = ?'); updateValues.push(status); }
    if (updateFields.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }
    updateValues.push(meetingId);
    await connection.query(`UPDATE counselor_meetings SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);
    await connection.commit();
    res.json({ success: true, message: 'Meeting updated successfully', notesImageUrl: notesImage });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error updating meeting notes:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating meeting notes' });
  } finally {
    connection.release();
  }
});

export default router;