import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

const ensureExpenseAccountColumns = async (db) => {
  await db.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS payment_source ENUM('bank','cash') NOT NULL DEFAULT 'cash'
  `).catch(async () => {
    try {
      await db.query(`ALTER TABLE expenses ADD COLUMN payment_source ENUM('bank','cash') NOT NULL DEFAULT 'cash'`);
    } catch { /* exists */ }
  });
  await db.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS bank_account_id INT NULL
  `).catch(async () => {
    try {
      await db.query(`ALTER TABLE expenses ADD COLUMN bank_account_id INT NULL`);
    } catch { /* exists */ }
  });
};

const resolvePaymentSource = ({ paymentSource, paymentMode, bankAccountId }) => {
  const source = paymentSource === 'bank' ? 'bank' : 'cash';
  const accountId = source === 'bank' ? (parseInt(bankAccountId, 10) || null) : null;
  return { source, accountId, paymentMode };
};

// Generate Expense ID: EXP2025001
const generateExpenseId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(expense_id, 8) AS UNSIGNED)) as max_id 
     FROM expenses 
     WHERE expense_id LIKE 'EXP${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `EXP${currentYear}${String(nextId).padStart(3, '0')}`;
};

// GET all expenses
router.get('/expenses', async (req, res) => {
  try {
    await ensureExpenseAccountColumns(pool);
    const { category, paymentMode, searchQuery, startDate, endDate } = req.query;

    let query = `SELECT e.*, ba.account_name, ba.bank_name
                 FROM expenses e
                 LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id
                 WHERE 1=1`;
    const params = [];

    if (category) {
      query += ' AND e.category = ?';
      params.push(category);
    }

    if (paymentMode) {
      query += ' AND e.payment_mode = ?';
      params.push(paymentMode);
    }

    if (searchQuery) {
      query += ' AND (e.name LIKE ? OR e.expense_id LIKE ? OR e.description LIKE ?)';
      const s = `%${searchQuery}%`;
      params.push(s, s, s);
    }

    if (startDate) {
      query += ' AND e.expense_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND e.expense_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY e.expense_date DESC, e.created_at DESC';

    const [expenses] = await pool.query(query, params);

    const [all] = await pool.query('SELECT amount, category FROM expenses');
    const totalExpenses = all.length;
    const totalAmount = all.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

    const currentMonth = new Date().toISOString().slice(0, 7);
    const [monthlyRows] = await pool.query(
      `SELECT SUM(amount) as monthly FROM expenses WHERE DATE_FORMAT(expense_date, '%Y-%m') = ?`,
      [currentMonth]
    );
    const monthlyAmount = parseFloat(monthlyRows[0].monthly || 0);

    res.json({
      success: true,
      expenses,
      stats: { totalExpenses, totalAmount, monthlyAmount }
    });

  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch expenses' });
  }
});

// GET single expense
router.get('/expenses/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Expense not found' });
    res.json({ success: true, expense: rows[0] });
  } catch (error) {
    console.error('Error fetching expense:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch expense' });
  }
});

// POST create expense
router.post('/expenses', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureExpenseAccountColumns(connection);

    const { category, name, description, amount, paymentMode, expenseDate, referenceNo, paymentSource, bankAccountId } = req.body;

    if (!category || !name || !amount || !paymentMode || !expenseDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Category, name, amount, payment mode and date are required' });
    }

    const { source, accountId } = resolvePaymentSource({ paymentSource, paymentMode, bankAccountId });
    if (source === 'bank' && !accountId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please select a bank account for this expense' });
    }

    const expenseId = await generateExpenseId(connection);

    await connection.query(
      `INSERT INTO expenses (expense_id, category, name, description, amount, payment_mode, expense_date, reference_no, payment_source, bank_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        expenseId,
        category,
        name.trim(),
        description?.trim() || null,
        parseFloat(amount),
        paymentMode,
        expenseDate,
        referenceNo?.trim() || null,
        source,
        accountId
      ]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Expense created successfully', expenseId });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating expense:', error);
    res.status(500).json({ success: false, message: 'Failed to create expense' });
  } finally {
    connection.release();
  }
});

// PUT update expense
router.put('/expenses/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureExpenseAccountColumns(connection);

    const { id } = req.params;
    const { category, name, description, amount, paymentMode, expenseDate, referenceNo, paymentSource, bankAccountId } = req.body;

    if (!category || !name || !amount || !paymentMode || !expenseDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Category, name, amount, payment mode and date are required' });
    }

    const [existing] = await connection.query('SELECT id FROM expenses WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    const { source, accountId } = resolvePaymentSource({ paymentSource, paymentMode, bankAccountId });
    if (source === 'bank' && !accountId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please select a bank account for this expense' });
    }

    await connection.query(
      `UPDATE expenses SET
        category = ?, name = ?, description = ?, amount = ?, payment_mode = ?, expense_date = ?,
        reference_no = ?, payment_source = ?, bank_account_id = ?
       WHERE id = ?`,
      [
        category,
        name.trim(),
        description?.trim() || null,
        parseFloat(amount),
        paymentMode,
        expenseDate,
        referenceNo?.trim() || null,
        source,
        accountId,
        id
      ]
    );

    await connection.commit();
    res.json({ success: true, message: 'Expense updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating expense:', error);
    res.status(500).json({ success: false, message: 'Failed to update expense' });
  } finally {
    connection.release();
  }
});

// DELETE expense
router.delete('/expenses/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM expenses WHERE id = ?', [req.params.id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    await connection.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    await connection.commit();
    res.json({ success: true, message: 'Expense deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting expense:', error);
    res.status(500).json({ success: false, message: 'Failed to delete expense' });
  } finally {
    connection.release();
  }
});

export default router;
