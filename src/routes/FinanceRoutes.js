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
// MIGRATION — run GET /finance/migrate to apply safely
// ============================================================
router.get('/finance/migrate', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // payment_method column
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS payment_method ENUM('bank','cash') NOT NULL DEFAULT 'bank'
    `).catch(() => {});

    // show_converted_currency flag
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS show_converted_currency TINYINT(1) NOT NULL DEFAULT 1
    `).catch(() => {});

    // manual student columns on invoices
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS is_manual_student TINYINT(1) NOT NULL DEFAULT 0
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_name VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_email VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_mobile VARCHAR(50) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_country VARCHAR(100) NULL
    `).catch(() => {});

    // per-invoice selected default services
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_selected_default_services (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id  INT NOT NULL,
        service_id  INT,
        service_name VARCHAR(255) NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // multi-student university commission table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_commission_students (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id          INT NOT NULL,
        student_id          INT NULL,
        student_name        VARCHAR(255) NOT NULL,
        student_ref_id      VARCHAR(100) NULL,
        student_email       VARCHAR(255) NULL,
        student_mobile      VARCHAR(50) NULL,
        is_manual           TINYINT(1) NOT NULL DEFAULT 0,
        commission_amount   DECIMAL(15,2) NOT NULL DEFAULT 0,
        university_name     VARCHAR(255) NULL,
        commission_reference VARCHAR(255) NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // manual student columns on invoice_agent_students
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS is_manual TINYINT(1) NOT NULL DEFAULT 0
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_email VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_mobile VARCHAR(50) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_country VARCHAR(100) NULL
    `).catch(() => {});

    res.json({ success: true, message: 'Migration applied successfully' });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// BANK ACCOUNTS
// ============================================================

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

router.get('/finance/bank-accounts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const [accounts] = await pool.query('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
    if (accounts.length === 0) return res.status(404).json({ success: false, message: 'Bank account not found' });
    res.json({ success: true, account: accounts[0] });
  } catch (error) {
    console.error('Error fetching bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank account' });
  }
});

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
      [accountName.trim(), bankName.trim(), accountNumber.trim(), iban?.trim() || null, branchName?.trim() || null, branchCode?.trim() || null, currency || 'PKR', status || 'Active']
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
      [accountName.trim(), bankName.trim(), accountNumber.trim(), iban?.trim() || null, branchName?.trim() || null, branchCode?.trim() || null, currency || 'PKR', status || 'Active', accountId]
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
// DEFAULT SERVICES
// ============================================================

router.get('/finance/default-services', async (req, res) => {
  try {
    const [services] = await pool.query(
      'SELECT * FROM invoice_default_services WHERE is_active = 1 ORDER BY display_order ASC, id ASC'
    );
    res.json({ success: true, services });
  } catch (error) {
    console.error('Error fetching default services:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch default services' });
  }
});

router.post('/finance/default-services', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceName, displayOrder } = req.body;
    if (!serviceName || !serviceName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }
    const [result] = await connection.query(
      'INSERT INTO invoice_default_services (service_name, display_order) VALUES (?, ?)',
      [serviceName.trim(), displayOrder || 99]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Default service added', serviceId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding default service:', error);
    res.status(500).json({ success: false, message: 'Failed to add default service' });
  } finally {
    connection.release();
  }
});

router.put('/finance/default-services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceId } = req.params;
    const { serviceName, displayOrder } = req.body;
    if (!serviceName || !serviceName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }
    const [existing] = await connection.query('SELECT id FROM invoice_default_services WHERE id = ?', [serviceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }
    await connection.query(
      'UPDATE invoice_default_services SET service_name=?, display_order=? WHERE id=?',
      [serviceName.trim(), displayOrder || 99, serviceId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Default service updated' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating default service:', error);
    res.status(500).json({ success: false, message: 'Failed to update default service' });
  } finally {
    connection.release();
  }
});

router.delete('/finance/default-services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceId } = req.params;
    const [existing] = await connection.query('SELECT id FROM invoice_default_services WHERE id = ?', [serviceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }
    await connection.query('DELETE FROM invoice_default_services WHERE id = ?', [serviceId]);
    await connection.commit();
    res.json({ success: true, message: 'Default service deleted' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting default service:', error);
    res.status(500).json({ success: false, message: 'Failed to delete default service' });
  } finally {
    connection.release();
  }
});

// ============================================================
// AGENTS
// ============================================================

router.get('/finance/agents', async (req, res) => {
  try {
    const [agents] = await pool.query(
      `SELECT a.*,
        (SELECT COUNT(*) FROM invoices i WHERE i.agent_id = a.id) as total_invoices
       FROM agents a
       ORDER BY a.agent_name ASC`
    );
    res.json({ success: true, agents });
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch agents' });
  }
});

router.post('/finance/agents', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentName, companyName, email, phone, address, status, notes } = req.body;
    if (!agentName || !agentName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Agent name is required' });
    }
    const [result] = await connection.query(
      `INSERT INTO agents (agent_name, company_name, email, phone, address, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agentName.trim(), companyName?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, status || 'Active', notes?.trim() || null]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Agent created', agentId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating agent:', error);
    res.status(500).json({ success: false, message: 'Failed to create agent' });
  } finally {
    connection.release();
  }
});

router.put('/finance/agents/:agentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentId } = req.params;
    const { agentName, companyName, email, phone, address, status, notes } = req.body;
    if (!agentName || !agentName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Agent name is required' });
    }
    const [existing] = await connection.query('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    await connection.query(
      `UPDATE agents SET agent_name=?, company_name=?, email=?, phone=?, address=?, status=?, notes=? WHERE id=?`,
      [agentName.trim(), companyName?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, status || 'Active', notes?.trim() || null, agentId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Agent updated' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating agent:', error);
    res.status(500).json({ success: false, message: 'Failed to update agent' });
  } finally {
    connection.release();
  }
});

router.delete('/finance/agents/:agentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentId } = req.params;
    const [existing] = await connection.query('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    await connection.query('DELETE FROM agents WHERE id = ?', [agentId]);
    await connection.commit();
    res.json({ success: true, message: 'Agent deleted' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, message: 'Cannot delete agent as they have invoices linked' });
    }
    console.error('Error deleting agent:', error);
    res.status(500).json({ success: false, message: 'Failed to delete agent' });
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
    const targetYear  = year  || new Date().getFullYear();

    const [stats] = await pool.query(
      `SELECT
        COUNT(*) as total_invoices,
        COALESCE(SUM(CASE WHEN payment_status = 'Paid' AND invoice_type != 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') AND invoice_type != 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') AND invoice_type != 'Agent Commission' THEN final_amount - COALESCE(paid_amount,0) ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN invoice_type = 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_agent_payout,
        COUNT(CASE WHEN payment_status = 'Pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN payment_status = 'Paid'    THEN 1 END) as paid_count
       FROM invoices
       WHERE MONTH(invoice_date) = ? AND YEAR(invoice_date) = ?`,
      [targetMonth, targetYear]
    );

    const [bankStats] = await pool.query(
      `SELECT ba.id, ba.account_name, ba.bank_name, ba.currency,
        COALESCE(SUM(CASE WHEN i.payment_status = 'Paid' AND i.invoice_type != 'Agent Commission' THEN i.final_amount ELSE 0 END), 0) as credit,
        COALESCE(SUM(CASE WHEN i.payment_status IN ('Pending','Partially Paid') AND i.invoice_type != 'Agent Commission' THEN i.final_amount - COALESCE(i.paid_amount,0) ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN i.invoice_type = 'Agent Commission' THEN i.final_amount ELSE 0 END), 0) as agent_payout,
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
// INVOICES — GET LIST
// ============================================================

router.get('/finance/invoices', async (req, res) => {
  try {
    const { type, status, month, year, bankAccountId } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type)          { whereClause += ' AND i.invoice_type = ?';       params.push(type); }
    if (status)        { whereClause += ' AND i.payment_status = ?';      params.push(status); }
    if (month)         { whereClause += ' AND MONTH(i.invoice_date) = ?'; params.push(month); }
    if (year)          { whereClause += ' AND YEAR(i.invoice_date) = ?';  params.push(year); }
    if (bankAccountId) { whereClause += ' AND i.bank_account_id = ?';     params.push(bankAccountId); }

    const [invoices] = await pool.query(
      `SELECT i.*,
              ba.account_name, ba.bank_name, ba.currency,
              a.agent_name
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       LEFT JOIN agents a ON i.agent_id = a.id
       ${whereClause}
       ORDER BY i.created_at DESC`,
      params
    );

    for (const inv of invoices) {
      const [extras] = await pool.query('SELECT * FROM invoice_extra_services WHERE invoice_id = ?', [inv.id]);
      inv.extra_services = extras;
      if (inv.invoice_type === 'Agent Commission') {
        const [agentStudents] = await pool.query('SELECT * FROM invoice_agent_students WHERE invoice_id = ?', [inv.id]);
        inv.agent_students = agentStudents;
      }
      if (inv.invoice_type === 'University Commission') {
        const [commStudents] = await pool.query('SELECT * FROM invoice_commission_students WHERE invoice_id = ?', [inv.id]).catch(() => [[]]);
        inv.commission_students = commStudents;
      }
    }

    res.json({ success: true, invoices, total: invoices.length });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
});

// ============================================================
// INVOICES — GET SINGLE
// ============================================================

router.get('/finance/invoices/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const [invoices] = await pool.query(
      `SELECT i.*, ba.account_name, ba.bank_name, ba.account_number, ba.iban, ba.branch_name, ba.currency,
              a.agent_name, a.company_name as agent_company
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       LEFT JOIN agents a ON i.agent_id = a.id
       WHERE i.id = ?`,
      [invoiceId]
    );

    if (invoices.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [extraServices]       = await pool.query('SELECT * FROM invoice_extra_services   WHERE invoice_id = ?', [invoiceId]);
    const [countryServices]     = await pool.query('SELECT * FROM invoice_country_services WHERE invoice_id = ?', [invoiceId]);
    const [agentStudents]       = await pool.query('SELECT * FROM invoice_agent_students   WHERE invoice_id = ?', [invoiceId]);
    const [commissionStudents]  = await pool.query('SELECT * FROM invoice_commission_students WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]).catch(() => [[]]);

    // Per-invoice selected default services
    let defaultServices = [];
    if (invoices[0].invoice_type === 'Student') {
      let [perInvoice] = await pool.query(
        'SELECT * FROM invoice_selected_default_services WHERE invoice_id = ? ORDER BY id ASC',
        [invoiceId]
      ).catch(() => [[]]);

      if (perInvoice.length > 0) {
        defaultServices = perInvoice;
      } else {
        const [ds] = await pool.query(
          'SELECT * FROM invoice_default_services WHERE is_active = 1 ORDER BY display_order ASC'
        );
        defaultServices = ds;
      }
    }

    res.json({
      success: true,
      invoice: invoices[0],
      extraServices,
      countryServices,
      agentStudents,
      commissionStudents,
      defaultServices
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoice' });
  }
});

// ============================================================
// INVOICES — CREATE
// ============================================================

router.post('/finance/invoices', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      invoiceType, invoiceDate, dueDate,
      paymentMethod, bankAccountId,
      // Student invoice — DB or manual
      studentId,
      isManualStudent,
      manualStudentName, manualStudentEmail, manualStudentMobile, manualStudentCountry,
      visaId,
      // University Commission — now multi-student
      commissionStudents,          // array: [{ isManual, studentId, studentName, studentRefId, studentEmail, studentMobile, universityName, commissionReference, commissionAmount }]
      universityName,              // kept for backward compat / single-student fallback
      commissionReference,
      // Agent Commission
      agentId, agentCommissionPercent, agentStudents,
      baseAmount, discount, extraServices, selectedCountryServices,
      selectedDefaultServices,
      finalAmount, gstPercent, gstAmount,
      notes,
      selectedCurrency, exchangeRate, convertedAmount,
      showConvertedCurrency,       // boolean — whether to show foreign currency on PDF
    } = req.body;

    if (!invoiceType || !invoiceDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Invoice type and date are required' });
    }

    const resolvedPaymentMethod = paymentMethod === 'cash' ? 'cash' : 'bank';

    if (resolvedPaymentMethod === 'bank') {
      if (!bankAccountId) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Bank account is required for bank transfers' });
      }
      const [bank] = await connection.query('SELECT id FROM bank_accounts WHERE id = ? AND status = ?', [bankAccountId, 'Active']);
      if (bank.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Bank account not found or inactive' });
      }
    }

    // ── Resolve student info ──
    let studentName = null, studentRefId = null, studentEmail = null, studentMobile = null, studentCountry = null;
    const resolvedIsManual = isManualStudent ? 1 : 0;

    if (isManualStudent) {
      // Manual entry — store provided details
      studentName    = manualStudentName?.trim() || null;
      studentEmail   = manualStudentEmail?.trim() || null;
      studentMobile  = manualStudentMobile?.trim() || null;
      studentCountry = manualStudentCountry?.trim() || null;
    } else if (studentId && invoiceType !== 'Agent Commission') {
      const [students] = await connection.query(
        'SELECT name, middle_name, surname, student_id, email, mobile, country FROM users WHERE id = ?',
        [studentId]
      );
      if (students.length > 0) {
        const s = students[0];
        studentName    = [s.name, s.middle_name, s.surname].filter(Boolean).join(' ');
        studentRefId   = s.student_id;
        studentEmail   = s.email;
        studentMobile  = s.mobile;
        studentCountry = s.country;
      }
    }

    // ── Visa ──
    let visaRefId = null, visaType = null, visaCountry = null;
    if (visaId) {
      const [visas] = await connection.query('SELECT visa_id, visa_type FROM visas WHERE id = ?', [visaId]);
      if (visas.length > 0) { visaRefId = visas[0].visa_id; visaType = visas[0].visa_type; }
      if (studentCountry) visaCountry = studentCountry;
    }

    // ── Amount calculation ──
    const extrasTotal      = Array.isArray(extraServices)
      ? extraServices.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0) : 0;
    const commissionPercent = parseFloat(agentCommissionPercent) || 0;
    const totalBase         = parseFloat(baseAmount) || 0;

    // For University Commission, total = sum of commissionStudents amounts
    let resolvedFinalAmount = parseFloat(finalAmount) || 0;
    let uniName             = universityName || null;
    let uniRef              = commissionReference || null;

    if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
      resolvedFinalAmount = commissionStudents.reduce((sum, s) => sum + (parseFloat(s.commissionAmount) || 0), 0);
      // For the main invoice record, use first student's uni info or keep provided
      if (!uniName && commissionStudents[0]?.universityName) uniName = commissionStudents[0].universityName;
      if (!uniRef  && commissionStudents[0]?.commissionReference) uniRef = commissionStudents[0].commissionReference;
    }

    const agentCommissionAmount = invoiceType === 'Agent Commission'
      ? (totalBase * commissionPercent / 100) : null;

    const resolvedGstPercent      = parseFloat(gstPercent) || 0;
    const resolvedGstAmount       = parseFloat(gstAmount)  || 0;
    const resolvedCurrency        = selectedCurrency || 'PKR';
    const resolvedExchangeRate    = resolvedCurrency === 'PKR' ? 1 : (parseFloat(exchangeRate) || 1);
    const resolvedConvertedAmount = resolvedCurrency === 'PKR' ? null : (parseFloat(convertedAmount) || null);
    const resolvedShowConverted   = showConvertedCurrency === false ? 0 : 1; // default show

    const invoiceId = await generateInvoiceId(connection);

    const [result] = await connection.query(
      `INSERT INTO invoices
       (invoice_id, invoice_type, invoice_date, due_date,
        payment_method, bank_account_id,
        student_id, student_name, student_ref_id, student_email, student_mobile, student_country,
        is_manual_student, manual_student_name, manual_student_email, manual_student_mobile, manual_student_country,
        visa_id, visa_ref_id, visa_type, visa_country,
        university_name, commission_reference,
        agent_id, agent_commission_percent, agent_commission_amount,
        base_amount, discount, extra_services_total, final_amount,
        gst_percent, gst_amount,
        selected_currency, exchange_rate, converted_amount,
        show_converted_currency,
        payment_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      [
        invoiceId, invoiceType, invoiceDate, dueDate || null,
        resolvedPaymentMethod, resolvedPaymentMethod === 'bank' ? (bankAccountId || null) : null,
        isManualStudent ? null : (studentId || null),
        isManualStudent ? (manualStudentName?.trim() || null) : studentName,
        isManualStudent ? null : studentRefId,
        isManualStudent ? (manualStudentEmail?.trim() || null) : studentEmail,
        isManualStudent ? (manualStudentMobile?.trim() || null) : studentMobile,
        isManualStudent ? (manualStudentCountry?.trim() || null) : studentCountry,
        resolvedIsManual,
        isManualStudent ? (manualStudentName?.trim() || null) : null,
        isManualStudent ? (manualStudentEmail?.trim() || null) : null,
        isManualStudent ? (manualStudentMobile?.trim() || null) : null,
        isManualStudent ? (manualStudentCountry?.trim() || null) : null,
        visaId || null, visaRefId, visaType, visaCountry,
        uniName, uniRef,
        agentId || null, commissionPercent || null,
        invoiceType === 'Agent Commission' ? agentCommissionAmount : null,
        totalBase, parseFloat(discount) || 0, extrasTotal,
        invoiceType === 'University Commission' ? resolvedFinalAmount : (parseFloat(finalAmount) || 0),
        resolvedGstPercent, resolvedGstAmount,
        resolvedCurrency, resolvedExchangeRate, resolvedConvertedAmount,
        resolvedShowConverted,
        notes || null
      ]
    );

    const newInvoiceId = result.insertId;

    // ── Extra services ──
    if (Array.isArray(extraServices) && extraServices.length > 0) {
      for (const svc of extraServices) {
        if (svc.name) {
          await connection.query(
            'INSERT INTO invoice_extra_services (invoice_id, service_name, price) VALUES (?, ?, ?)',
            [newInvoiceId, svc.name, parseFloat(svc.price) || 0]
          );
        }
      }
    }

    // ── Country services ──
    if (Array.isArray(selectedCountryServices) && selectedCountryServices.length > 0) {
      for (const cs of selectedCountryServices) {
        await connection.query(
          'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name) VALUES (?, ?, ?)',
          [newInvoiceId, cs.id, cs.service_name]
        );
      }
    }

    // ── Selected default services (Student only) ──
    if (invoiceType === 'Student' && Array.isArray(selectedDefaultServices) && selectedDefaultServices.length > 0) {
      for (const ds of selectedDefaultServices) {
        await connection.query(
          'INSERT INTO invoice_selected_default_services (invoice_id, service_id, service_name) VALUES (?, ?, ?)',
          [newInvoiceId, ds.id || null, ds.service_name]
        ).catch(() => {
          console.warn('invoice_selected_default_services table missing — run GET /finance/migrate');
        });
      }
    }

    // ── Agent students ──
    if (invoiceType === 'Agent Commission' && Array.isArray(agentStudents) && agentStudents.length > 0) {
      for (const s of agentStudents) {
        await connection.query(
          `INSERT INTO invoice_agent_students
           (invoice_id, student_id, student_name, student_ref_id, is_manual, student_email, student_mobile, student_country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newInvoiceId,
            s.isManual ? null : (s.id || null),
            s.student_name,
            s.student_ref_id || null,
            s.isManual ? 1 : 0,
            s.student_email || null,
            s.student_mobile || null,
            s.student_country || null
          ]
        ).catch(async () => {
          // Fallback if extra columns don't exist yet
          await connection.query(
            'INSERT INTO invoice_agent_students (invoice_id, student_id, student_name, student_ref_id) VALUES (?, ?, ?, ?)',
            [newInvoiceId, s.isManual ? null : (s.id || null), s.student_name, s.student_ref_id || null]
          );
        });
      }
    }

    // ── University Commission students (multi-student) ──
    if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
      for (const s of commissionStudents) {
        await connection.query(
          `INSERT INTO invoice_commission_students
           (invoice_id, student_id, student_name, student_ref_id, student_email, student_mobile,
            is_manual, commission_amount, university_name, commission_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newInvoiceId,
            s.isManual ? null : (s.studentId || null),
            s.studentName || '',
            s.isManual ? null : (s.studentRefId || null),
            s.studentEmail || null,
            s.studentMobile || null,
            s.isManual ? 1 : 0,
            parseFloat(s.commissionAmount) || 0,
            s.universityName || null,
            s.commissionReference || null
          ]
        ).catch(err => {
          console.warn('invoice_commission_students insert error — run GET /finance/migrate:', err.message);
        });
      }
    }

    await connection.commit();
    res.status(201).json({
      success: true, message: 'Invoice created successfully',
      invoiceId: newInvoiceId, generatedInvoiceId: invoiceId
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to create invoice' });
  } finally {
    connection.release();
  }
});

// ============================================================
// INVOICES — UPDATE
// ============================================================

router.put('/finance/invoices/:invoiceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;
    const {
      paymentStatus, paidAmount, paymentDate,
      bankAccountId, baseAmount, discount, gstPercent, gstAmount, finalAmount,
      invoiceDate, dueDate, universityName, commissionReference,
      agentId, agentCommissionPercent, agentCommissionAmount,
      notes,
      showConvertedCurrency,
    } = req.body;

    const [existing] = await connection.query('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const safeFloat = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const resolvedShowConverted = showConvertedCurrency === false || showConvertedCurrency === 0 ? 0 : 1;

    await connection.query(
      `UPDATE invoices SET
        payment_status=?, paid_amount=?, payment_date=?,
        bank_account_id=COALESCE(?,bank_account_id),
        base_amount=COALESCE(?,base_amount),
        discount=COALESCE(?,discount),
        gst_percent=COALESCE(?,gst_percent),
        gst_amount=COALESCE(?,gst_amount),
        final_amount=COALESCE(?,final_amount),
        invoice_date=COALESCE(?,invoice_date),
        due_date=?,
        university_name=COALESCE(?,university_name),
        commission_reference=COALESCE(?,commission_reference),
        agent_id=COALESCE(?,agent_id),
        agent_commission_percent=COALESCE(?,agent_commission_percent),
        agent_commission_amount=COALESCE(?,agent_commission_amount),
        show_converted_currency=?,
        notes=?
       WHERE id=?`,
      [
        paymentStatus || 'Pending',
        safeFloat(paidAmount) ?? 0,
        paymentDate || null,
        safeFloat(bankAccountId),
        safeFloat(baseAmount),
        safeFloat(discount),
        safeFloat(gstPercent),
        safeFloat(gstAmount),
        safeFloat(finalAmount),
        invoiceDate || null,
        dueDate || null,
        universityName || null,
        commissionReference || null,
        agentId || null,
        safeFloat(agentCommissionPercent),
        safeFloat(agentCommissionAmount),
        resolvedShowConverted,
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

// ============================================================
// INVOICES — DELETE
// ============================================================

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
// COUNTRY SERVICES
// ============================================================

router.get('/countries/:countryId/services', async (req, res) => {
  try {
    const { countryId } = req.params;
    const [services] = await pool.query(
      'SELECT * FROM country_services WHERE country_id = ? ORDER BY display_order ASC, id ASC', [countryId]
    );
    res.json({ success: true, services, total: services.length });
  } catch (error) {
    console.error('Error fetching country services:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch services' });
  }
});

router.post('/countries/:countryId/services', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId } = req.params;
    const { serviceName, description, displayOrder } = req.body;
    if (!serviceName) { await connection.rollback(); return res.status(400).json({ success: false, message: 'Service name is required' }); }
    const [country] = await connection.query('SELECT id FROM countries WHERE id = ?', [countryId]);
    if (country.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Country not found' }); }
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

router.put('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;
    const { serviceName, description, displayOrder } = req.body;
    if (!serviceName) { await connection.rollback(); return res.status(400).json({ success: false, message: 'Service name is required' }); }
    const [existing] = await connection.query('SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]);
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Service not found' }); }
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

router.delete('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;
    const [existing] = await connection.query('SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]);
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Service not found' }); }
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

// ── Student visas ──
router.get('/finance/student-visas/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [visas] = await pool.query(
      `SELECT v.id, v.visa_id, v.visa_type, v.visa_status, v.institute
       FROM visas v WHERE v.student_id = ? ORDER BY v.created_at DESC`,
      [studentId]
    );
    res.json({ success: true, visas });
  } catch (error) {
    console.error('Error fetching student visas:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch visas' });
  }
});

export default router;