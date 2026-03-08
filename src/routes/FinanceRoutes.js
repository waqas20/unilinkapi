import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// ============================================================
// HELPER: Generate Invoice ID
// ============================================================
const generateInvoiceId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(invoice_id, 8) AS UNSIGNED)) as max_id
     FROM invoices
     WHERE invoice_id LIKE 'INV${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `INV${currentYear}${String(nextId).padStart(3, '0')}`;
};

// ============================================================
// BANK ACCOUNTS
// ============================================================

// GET all bank accounts
router.get('/finance/bank-accounts', async (req, res) => {
  try {
    const [accounts] = await pool.query(
      `SELECT ba.*,
        (SELECT COALESCE(SUM(i.final_amount),0) 
         FROM invoices i 
         WHERE i.bank_account_id = ba.id 
           AND i.payment_status = 'Paid'
           AND MONTH(i.invoice_date) = MONTH(CURDATE())
           AND YEAR(i.invoice_date) = YEAR(CURDATE())) as monthly_credit,
        (SELECT COALESCE(SUM(i.final_amount),0)
         FROM invoices i
         WHERE i.bank_account_id = ba.id
           AND i.payment_status IN ('Pending','Partially Paid')
           AND MONTH(i.invoice_date) = MONTH(CURDATE())
           AND YEAR(i.invoice_date) = YEAR(CURDATE())) as monthly_pending,
        (SELECT COUNT(*) FROM invoices i WHERE i.bank_account_id = ba.id) as total_invoices
       FROM bank_accounts ba
       ORDER BY ba.created_at DESC`
    );
    res.json({ success: true, accounts, total: accounts.length });
  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank accounts' });
  }
});

// GET single bank account
router.get('/finance/bank-accounts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const [accounts] = await pool.query(
      'SELECT * FROM bank_accounts WHERE id = ?', [accountId]
    );
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    res.json({ success: true, account: accounts[0] });
  } catch (error) {
    console.error('Error fetching bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank account' });
  }
});

// POST create bank account
router.post('/finance/bank-accounts', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountName, bankName, accountNumber, iban, branchName, branchCode, currency, status } = req.body;

    if (!accountName || !bankName || !accountNumber) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Account name, bank name, and account number are required' });
    }

    const [result] = await connection.query(
      `INSERT INTO bank_accounts (account_name, bank_name, account_number, iban, branch_name, branch_code, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountName.trim(), bankName.trim(), accountNumber.trim(),
        iban?.trim() || null, branchName?.trim() || null, branchCode?.trim() || null,
        currency || 'PKR', status || 'Active'
      ]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Bank account created successfully', accountId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to create bank account' });
  } finally {
    connection.release();
  }
});

// PUT update bank account
router.put('/finance/bank-accounts/:accountId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountId } = req.params;
    const { accountName, bankName, accountNumber, iban, branchName, branchCode, currency, status } = req.body;

    if (!accountName || !bankName || !accountNumber) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Account name, bank name, and account number are required' });
    }

    const [existing] = await connection.query('SELECT id FROM bank_accounts WHERE id = ?', [accountId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }

    await connection.query(
      `UPDATE bank_accounts SET account_name=?, bank_name=?, account_number=?, iban=?,
       branch_name=?, branch_code=?, currency=?, status=? WHERE id=?`,
      [
        accountName.trim(), bankName.trim(), accountNumber.trim(),
        iban?.trim() || null, branchName?.trim() || null, branchCode?.trim() || null,
        currency || 'PKR', status || 'Active', accountId
      ]
    );
    await connection.commit();
    res.json({ success: true, message: 'Bank account updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to update bank account' });
  } finally {
    connection.release();
  }
});

// DELETE bank account
router.delete('/finance/bank-accounts/:accountId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountId } = req.params;

    const [existing] = await connection.query('SELECT id FROM bank_accounts WHERE id = ?', [accountId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }

    await connection.query('DELETE FROM bank_accounts WHERE id = ?', [accountId]);
    await connection.commit();
    res.json({ success: true, message: 'Bank account deleted successfully' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, message: 'Cannot delete bank account as it is linked to invoices' });
    }
    console.error('Error deleting bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to delete bank account' });
  } finally {
    connection.release();
  }
});

// ============================================================
// FINANCE STATISTICS
// ============================================================
router.get('/finance/statistics', async (req, res) => {
  try {
    const { month, year } = req.query;
    const targetMonth = month || new Date().getMonth() + 1;
    const targetYear = year || new Date().getFullYear();

    const [stats] = await pool.query(
      `SELECT
        COUNT(*) as total_invoices,
        COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN final_amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') THEN final_amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') THEN final_amount - paid_amount ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN invoice_type = 'Student' AND payment_status = 'Paid' THEN final_amount ELSE 0 END), 0) as student_credit,
        COALESCE(SUM(CASE WHEN invoice_type = 'University Commission' AND payment_status = 'Paid' THEN final_amount ELSE 0 END), 0) as commission_credit,
        COUNT(CASE WHEN payment_status = 'Pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN payment_status = 'Paid' THEN 1 END) as paid_count
       FROM invoices
       WHERE MONTH(invoice_date) = ? AND YEAR(invoice_date) = ?`,
      [targetMonth, targetYear]
    );

    // Per-bank stats
    const [bankStats] = await pool.query(
      `SELECT ba.id, ba.account_name, ba.bank_name, ba.currency,
        COALESCE(SUM(CASE WHEN i.payment_status = 'Paid' THEN i.final_amount ELSE 0 END), 0) as credit,
        COALESCE(SUM(CASE WHEN i.payment_status IN ('Pending','Partially Paid') THEN i.final_amount - i.paid_amount ELSE 0 END), 0) as pending,
        COUNT(i.id) as invoice_count
       FROM bank_accounts ba
       LEFT JOIN invoices i ON ba.id = i.bank_account_id
         AND MONTH(i.invoice_date) = ?
         AND YEAR(i.invoice_date) = ?
       WHERE ba.status = 'Active'
       GROUP BY ba.id`,
      [targetMonth, targetYear]
    );

    res.json({ success: true, statistics: stats[0], bankStats });
  } catch (error) {
    console.error('Error fetching finance statistics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
  }
});

// ============================================================
// INVOICES
// ============================================================

// GET all invoices
router.get('/finance/invoices', async (req, res) => {
  try {
    const { type, status, month, year, bankAccountId } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type) {
      whereClause += ' AND i.invoice_type = ?';
      params.push(type);
    }
    if (status) {
      whereClause += ' AND i.payment_status = ?';
      params.push(status);
    }
    if (month) {
      whereClause += ' AND MONTH(i.invoice_date) = ?';
      params.push(month);
    }
    if (year) {
      whereClause += ' AND YEAR(i.invoice_date) = ?';
      params.push(year);
    }
    if (bankAccountId) {
      whereClause += ' AND i.bank_account_id = ?';
      params.push(bankAccountId);
    }

    const [invoices] = await pool.query(
      `SELECT i.*,
              ba.account_name, ba.bank_name, ba.currency
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       ${whereClause}
       ORDER BY i.created_at DESC`,
      params
    );

    // Attach extra services for each invoice
    for (const inv of invoices) {
      const [extras] = await pool.query(
        'SELECT * FROM invoice_extra_services WHERE invoice_id = ?', [inv.id]
      );
      inv.extra_services = extras;
    }

    res.json({ success: true, invoices, total: invoices.length });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
});

// GET single invoice
router.get('/finance/invoices/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const [invoices] = await pool.query(
      `SELECT i.*, ba.account_name, ba.bank_name, ba.account_number, ba.iban, ba.branch_name, ba.currency
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       WHERE i.id = ?`,
      [invoiceId]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const [extraServices] = await pool.query(
      'SELECT * FROM invoice_extra_services WHERE invoice_id = ?', [invoiceId]
    );
    const [countryServices] = await pool.query(
      'SELECT * FROM invoice_country_services WHERE invoice_id = ?', [invoiceId]
    );

    res.json({
      success: true,
      invoice: invoices[0],
      extraServices,
      countryServices
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoice' });
  }
});

// POST create invoice
router.post('/finance/invoices', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      invoiceType, invoiceDate, dueDate, bankAccountId,
      studentId, visaId,
      universityName, commissionReference,
      baseAmount, discount, extraServices, selectedCountryServices,
      finalAmount, notes
    } = req.body;

    if (!invoiceType || !invoiceDate || !bankAccountId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Invoice type, date, and bank account are required' });
    }

    // Validate bank account
    const [bank] = await connection.query('SELECT id FROM bank_accounts WHERE id = ? AND status = ?', [bankAccountId, 'Active']);
    if (bank.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Bank account not found or inactive' });
    }

    // Fetch student info
    let studentName = null, studentRefId = null, studentEmail = null, studentMobile = null, studentCountry = null;
    if (studentId) {
      const [students] = await connection.query(
        'SELECT name, middle_name, surname, student_id, email, mobile, country FROM users WHERE id = ? AND role = ?',
        [studentId, 'client']
      );
      if (students.length > 0) {
        const s = students[0];
        studentName = [s.name, s.middle_name, s.surname].filter(Boolean).join(' ');
        studentRefId = s.student_id;
        studentEmail = s.email;
        studentMobile = s.mobile;
        studentCountry = s.country;
      }
    }

    // Fetch visa info
    let visaRefId = null, visaType = null, visaCountry = null;
    if (visaId) {
      const [visas] = await connection.query(
        `SELECT v.visa_id, v.visa_type, c.country_name
         FROM visas v
         LEFT JOIN countries c ON v.student_id = (
           SELECT u.id FROM users u WHERE u.id = v.student_id
         )
         WHERE v.id = ?`,
        [visaId]
      );
      if (visas.length > 0) {
        visaRefId = visas[0].visa_id;
        visaType = visas[0].visa_type;
      }
      // Also get country from visa's student country
      if (studentCountry) visaCountry = studentCountry;
    }

    // Calculate extra services total
    const extrasTotal = Array.isArray(extraServices)
      ? extraServices.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0)
      : 0;

    const invoiceId = await generateInvoiceId(connection);

    const [result] = await connection.query(
      `INSERT INTO invoices
       (invoice_id, invoice_type, invoice_date, due_date, bank_account_id,
        student_id, student_name, student_ref_id, student_email, student_mobile, student_country,
        visa_id, visa_ref_id, visa_type, visa_country,
        university_name, commission_reference,
        base_amount, discount, extra_services_total, final_amount,
        payment_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      [
        invoiceId, invoiceType, invoiceDate, dueDate || null, bankAccountId,
        studentId || null, studentName, studentRefId, studentEmail, studentMobile, studentCountry,
        visaId || null, visaRefId, visaType, visaCountry,
        universityName || null, commissionReference || null,
        parseFloat(baseAmount) || 0,
        parseFloat(discount) || 0,
        extrasTotal,
        parseFloat(finalAmount) || 0,
        notes || null
      ]
    );

    const newInvoiceId = result.insertId;

    // Insert extra services
    if (Array.isArray(extraServices) && extraServices.length > 0) {
      for (const svc of extraServices) {
        if (svc.name && svc.price !== undefined) {
          await connection.query(
            'INSERT INTO invoice_extra_services (invoice_id, service_name, price) VALUES (?, ?, ?)',
            [newInvoiceId, svc.name, parseFloat(svc.price) || 0]
          );
        }
      }
    }

    // Insert selected country services (no price)
    if (Array.isArray(selectedCountryServices) && selectedCountryServices.length > 0) {
      for (const cs of selectedCountryServices) {
        await connection.query(
          'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name) VALUES (?, ?, ?)',
          [newInvoiceId, cs.id, cs.service_name]
        );
      }
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Invoice created successfully',
      invoiceId: newInvoiceId,
      generatedInvoiceId: invoiceId
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to create invoice' });
  } finally {
    connection.release();
  }
});

// PUT update invoice status / payment
router.put('/finance/invoices/:invoiceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;
    const { paymentStatus, paidAmount, paymentDate, notes } = req.body;

    const [existing] = await connection.query('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    await connection.query(
      `UPDATE invoices SET payment_status=?, paid_amount=?, payment_date=?, notes=? WHERE id=?`,
      [
        paymentStatus || 'Pending',
        parseFloat(paidAmount) || 0,
        paymentDate || null,
        notes || null,
        invoiceId
      ]
    );

    await connection.commit();
    res.json({ success: true, message: 'Invoice updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to update invoice' });
  } finally {
    connection.release();
  }
});

// DELETE invoice
router.delete('/finance/invoices/:invoiceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;

    const [existing] = await connection.query('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    await connection.query('DELETE FROM invoices WHERE id = ?', [invoiceId]);
    await connection.commit();
    res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to delete invoice' });
  } finally {
    connection.release();
  }
});

// ============================================================
// COUNTRY SERVICES (under countries module)
// ============================================================

// GET all services for a country
router.get('/countries/:countryId/services', async (req, res) => {
  try {
    const { countryId } = req.params;
    const [services] = await pool.query(
      'SELECT * FROM country_services WHERE country_id = ? ORDER BY display_order ASC, id ASC',
      [countryId]
    );
    res.json({ success: true, services, total: services.length });
  } catch (error) {
    console.error('Error fetching country services:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch services' });
  }
});

// POST add service to country
router.post('/countries/:countryId/services', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId } = req.params;
    const { serviceName, description, displayOrder } = req.body;

    if (!serviceName) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }

    const [country] = await connection.query('SELECT id FROM countries WHERE id = ?', [countryId]);
    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Country not found' });
    }

    const [result] = await connection.query(
      'INSERT INTO country_services (country_id, service_name, description, display_order) VALUES (?, ?, ?, ?)',
      [countryId, serviceName.trim(), description?.trim() || null, displayOrder || 99]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Service added successfully', serviceId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding service:', error);
    res.status(500).json({ success: false, message: 'Failed to add service' });
  } finally {
    connection.release();
  }
});

// PUT update country service
router.put('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;
    const { serviceName, description, displayOrder } = req.body;

    if (!serviceName) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }

    const [existing] = await connection.query(
      'SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    await connection.query(
      'UPDATE country_services SET service_name=?, description=?, display_order=? WHERE id=?',
      [serviceName.trim(), description?.trim() || null, displayOrder || 99, serviceId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Service updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating service:', error);
    res.status(500).json({ success: false, message: 'Failed to update service' });
  } finally {
    connection.release();
  }
});

// DELETE country service
router.delete('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;

    const [existing] = await connection.query(
      'SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    await connection.query('DELETE FROM country_services WHERE id = ?', [serviceId]);
    await connection.commit();
    res.json({ success: true, message: 'Service deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting service:', error);
    res.status(500).json({ success: false, message: 'Failed to delete service' });
  } finally {
    connection.release();
  }
});

// GET student visas (for invoice creation dropdown)
router.get('/finance/student-visas/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [visas] = await pool.query(
      `SELECT v.id, v.visa_id, v.visa_type, v.visa_status, v.institute
       FROM visas v
       WHERE v.student_id = ?
       ORDER BY v.created_at DESC`,
      [studentId]
    );
    res.json({ success: true, visas });
  } catch (error) {
    console.error('Error fetching student visas:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch visas' });
  }
});

export default router;