import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

const ensureVisaEnquirySchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visa_enquiries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      enquiry_id VARCHAR(20) NOT NULL,
      first_name VARCHAR(100) NULL,
      middle_name VARCHAR(100) NULL,
      last_name VARCHAR(100) NULL,
      date_of_birth DATE NULL,
      nationality VARCHAR(100) NULL,
      city_country_of_birth VARCHAR(255) NULL,
      passport_no VARCHAR(50) NULL,
      passport_date_of_issue DATE NULL,
      passport_place_of_issue VARCHAR(255) NULL,
      gender VARCHAR(20) NULL,
      marital_status VARCHAR(30) NULL,
      residential_address TEXT NULL,
      postal_code VARCHAR(20) NULL,
      mobile_no VARCHAR(30) NULL,
      landline_no VARCHAR(30) NULL,
      email VARCHAR(255) NULL,
      alternative_email VARCHAR(255) NULL,
      occupation VARCHAR(255) NULL,
      emergency_full_name VARCHAR(255) NULL,
      emergency_relation VARCHAR(100) NULL,
      emergency_contact_no VARCHAR(30) NULL,
      emergency_email VARCHAR(255) NULL,
      emergency_address TEXT NULL,
      emergency_postal_code VARCHAR(20) NULL,
      sponsor_full_name VARCHAR(255) NULL,
      sponsor_relation VARCHAR(100) NULL,
      sponsor_contact_no VARCHAR(30) NULL,
      sponsor_email VARCHAR(255) NULL,
      sponsor_profession VARCHAR(255) NULL,
      sponsor_address TEXT NULL,
      sponsor_postal_code VARCHAR(20) NULL,
      intended_country VARCHAR(100) NULL,
      purpose_of_visit VARCHAR(255) NULL,
      travel_month_year VARCHAR(50) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_visa_enquiry_id (enquiry_id),
      INDEX idx_visa_enquiry_created (created_at)
    )
  `);
};

const generateEnquiryId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(enquiry_id, 9) AS UNSIGNED)) as max_id
     FROM visa_enquiries
     WHERE enquiry_id LIKE ?`,
    [`VE${currentYear}%`]
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `VE${currentYear}${String(nextId).padStart(4, '0')}`;
};

const mapBodyToValues = (body) => ({
  firstName: body.firstName?.trim() || null,
  middleName: body.middleName?.trim() || null,
  lastName: body.lastName?.trim() || null,
  dateOfBirth: body.dateOfBirth || null,
  nationality: body.nationality?.trim() || null,
  cityCountryOfBirth: body.cityCountryOfBirth?.trim() || null,
  passportNo: body.passportNo?.trim() || null,
  passportDateOfIssue: body.passportDateOfIssue || null,
  passportPlaceOfIssue: body.passportPlaceOfIssue?.trim() || null,
  gender: body.gender?.trim() || null,
  maritalStatus: body.maritalStatus?.trim() || null,
  residentialAddress: body.residentialAddress?.trim() || null,
  postalCode: body.postalCode?.trim() || null,
  mobileNo: body.mobileNo?.trim() || null,
  landlineNo: body.landlineNo?.trim() || null,
  email: body.email?.trim() || null,
  alternativeEmail: body.alternativeEmail?.trim() || null,
  occupation: body.occupation?.trim() || null,
  emergencyFullName: body.emergencyFullName?.trim() || null,
  emergencyRelation: body.emergencyRelation?.trim() || null,
  emergencyContactNo: body.emergencyContactNo?.trim() || null,
  emergencyEmail: body.emergencyEmail?.trim() || null,
  emergencyAddress: body.emergencyAddress?.trim() || null,
  emergencyPostalCode: body.emergencyPostalCode?.trim() || null,
  sponsorFullName: body.sponsorFullName?.trim() || null,
  sponsorRelation: body.sponsorRelation?.trim() || null,
  sponsorContactNo: body.sponsorContactNo?.trim() || null,
  sponsorEmail: body.sponsorEmail?.trim() || null,
  sponsorProfession: body.sponsorProfession?.trim() || null,
  sponsorAddress: body.sponsorAddress?.trim() || null,
  sponsorPostalCode: body.sponsorPostalCode?.trim() || null,
  intendedCountry: body.intendedCountry?.trim() || null,
  purposeOfVisit: body.purposeOfVisit?.trim() || null,
  travelMonthYear: body.travelMonthYear?.trim() || null,
});

const valuesToParams = (v) => [
  v.firstName, v.middleName, v.lastName, v.dateOfBirth, v.nationality, v.cityCountryOfBirth,
  v.passportNo, v.passportDateOfIssue, v.passportPlaceOfIssue, v.gender, v.maritalStatus,
  v.residentialAddress, v.postalCode, v.mobileNo, v.landlineNo, v.email, v.alternativeEmail,
  v.occupation, v.emergencyFullName, v.emergencyRelation, v.emergencyContactNo, v.emergencyEmail,
  v.emergencyAddress, v.emergencyPostalCode, v.sponsorFullName, v.sponsorRelation,
  v.sponsorContactNo, v.sponsorEmail, v.sponsorProfession, v.sponsorAddress, v.sponsorPostalCode,
  v.intendedCountry, v.purposeOfVisit, v.travelMonthYear,
];

const INSERT_COLUMNS = `
  enquiry_id, first_name, middle_name, last_name, date_of_birth, nationality, city_country_of_birth,
  passport_no, passport_date_of_issue, passport_place_of_issue, gender, marital_status,
  residential_address, postal_code, mobile_no, landline_no, email, alternative_email, occupation,
  emergency_full_name, emergency_relation, emergency_contact_no, emergency_email,
  emergency_address, emergency_postal_code,
  sponsor_full_name, sponsor_relation, sponsor_contact_no, sponsor_email, sponsor_profession,
  sponsor_address, sponsor_postal_code,
  intended_country, purpose_of_visit, travel_month_year
`;

const UPDATE_SET = `
  first_name = ?, middle_name = ?, last_name = ?, date_of_birth = ?, nationality = ?, city_country_of_birth = ?,
  passport_no = ?, passport_date_of_issue = ?, passport_place_of_issue = ?, gender = ?, marital_status = ?,
  residential_address = ?, postal_code = ?, mobile_no = ?, landline_no = ?, email = ?, alternative_email = ?, occupation = ?,
  emergency_full_name = ?, emergency_relation = ?, emergency_contact_no = ?, emergency_email = ?,
  emergency_address = ?, emergency_postal_code = ?,
  sponsor_full_name = ?, sponsor_relation = ?, sponsor_contact_no = ?, sponsor_email = ?, sponsor_profession = ?,
  sponsor_address = ?, sponsor_postal_code = ?,
  intended_country = ?, purpose_of_visit = ?, travel_month_year = ?
`;

router.get('/visa-enquiries', async (req, res) => {
  try {
    await ensureVisaEnquirySchema();
    const [enquiries] = await pool.query(
      `SELECT * FROM visa_enquiries ORDER BY created_at DESC`
    );
    res.json({ success: true, enquiries, total: enquiries.length });
  } catch (error) {
    console.error('Error fetching visa enquiries:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch visa enquiries' });
  }
});

router.get('/visa-enquiries/:enquiryId', async (req, res) => {
  try {
    await ensureVisaEnquirySchema();
    const { enquiryId } = req.params;
    const [rows] = await pool.query('SELECT * FROM visa_enquiries WHERE id = ?', [enquiryId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Visa enquiry not found' });
    }
    res.json({ success: true, enquiry: rows[0] });
  } catch (error) {
    console.error('Error fetching visa enquiry:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch visa enquiry' });
  }
});

router.post('/visa-enquiries', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureVisaEnquirySchema();
    await connection.beginTransaction();

    const v = mapBodyToValues(req.body);
    if (!v.firstName || !v.lastName || !v.email || !v.mobileNo) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, and mobile number are required',
      });
    }

    const enquiryId = await generateEnquiryId(connection);
    const placeholders = Array(35).fill('?').join(', ');
    const [result] = await connection.query(
      `INSERT INTO visa_enquiries (${INSERT_COLUMNS}) VALUES (${placeholders})`,
      [enquiryId, ...valuesToParams(v)]
    );

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Visa enquiry submitted successfully',
      enquiryId: result.insertId,
      generatedEnquiryId: enquiryId,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating visa enquiry:', error);
    res.status(500).json({ success: false, message: 'Failed to submit visa enquiry' });
  } finally {
    connection.release();
  }
});

router.put('/visa-enquiries/:enquiryId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureVisaEnquirySchema();
    await connection.beginTransaction();

    const { enquiryId } = req.params;
    const [existing] = await connection.query('SELECT id FROM visa_enquiries WHERE id = ?', [enquiryId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa enquiry not found' });
    }

    const v = mapBodyToValues(req.body);
    if (!v.firstName || !v.lastName || !v.email || !v.mobileNo) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, and mobile number are required',
      });
    }

    await connection.query(
      `UPDATE visa_enquiries SET ${UPDATE_SET} WHERE id = ?`,
      [...valuesToParams(v), enquiryId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Visa enquiry updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating visa enquiry:', error);
    res.status(500).json({ success: false, message: 'Failed to update visa enquiry' });
  } finally {
    connection.release();
  }
});

router.delete('/visa-enquiries/:enquiryId', async (req, res) => {
  try {
    await ensureVisaEnquirySchema();
    const { enquiryId } = req.params;
    const [result] = await pool.query('DELETE FROM visa_enquiries WHERE id = ?', [enquiryId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Visa enquiry not found' });
    }
    res.json({ success: true, message: 'Visa enquiry deleted successfully' });
  } catch (error) {
    console.error('Error deleting visa enquiry:', error);
    res.status(500).json({ success: false, message: 'Failed to delete visa enquiry' });
  }
});

// ============================================================
// POST /visa-enquiries/:enquiryId/create-visa
// Create a visa from enquiry data (Assign To Visa)
// Only copies name, email, phone, country — everything else defaults
// ============================================================
router.post('/visa-enquiries/:enquiryId/create-visa', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureVisaEnquirySchema();
    await connection.beginTransaction();

    const { enquiryId } = req.params;
    const [rows] = await connection.query('SELECT * FROM visa_enquiries WHERE id = ?', [enquiryId]);
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa enquiry not found' });
    }

    const enquiry = rows[0];
    const applicantName = [enquiry.first_name, enquiry.middle_name, enquiry.last_name]
      .filter((p) => p && String(p).trim())
      .join(' ')
      .trim();

    if (!applicantName) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Enquiry is missing applicant name required to create a visa',
      });
    }

    const intended = String(enquiry.intended_country || '').trim();
    if (!intended) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Enquiry is missing intended country required to create a visa',
      });
    }

    let countryId = null;
    const [byName] = await connection.query(
      'SELECT id FROM countries WHERE LOWER(TRIM(country_name)) = LOWER(?) LIMIT 1',
      [intended]
    );
    if (byName.length > 0) {
      countryId = byName[0].id;
    } else if (/^\d+$/.test(intended)) {
      const [byId] = await connection.query('SELECT id FROM countries WHERE id = ? LIMIT 1', [intended]);
      if (byId.length > 0) countryId = byId[0].id;
    }

    if (!countryId) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Could not match intended country "${intended}" to a country in the system. Please update the enquiry country and try again.`,
      });
    }

    const currentYear = new Date().getFullYear();
    const [maxResult] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING(visa_id, 9) AS UNSIGNED)) as max_id
       FROM visas WHERE visa_id LIKE ?`,
      [`VISA${currentYear}%`]
    );
    const nextId = (maxResult[0].max_id || 0) + 1;
    const visaIdCode = `VISA${currentYear}${String(nextId).padStart(3, '0')}`;

    const [result] = await connection.query(
      `INSERT INTO visas
       (visa_id, student_id, applicant_name, applicant_email, applicant_phone, country_id,
        visa_type, visa_status)
       VALUES (?, NULL, ?, ?, ?, ?, 'Study Visa', 'In Progress')`,
      [
        visaIdCode,
        applicantName,
        enquiry.email || null,
        enquiry.mobile_no || null,
        countryId,
      ]
    );

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Visa created successfully from enquiry',
      visaId: result.insertId,
      generatedVisaId: visaIdCode,
      mapped: {
        applicantName,
        applicantEmail: enquiry.email || '',
        applicantPhone: enquiry.mobile_no || '',
        country: intended,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating visa from enquiry:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while creating the visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  } finally {
    connection.release();
  }
});

export default router;
