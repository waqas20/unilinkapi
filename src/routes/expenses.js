import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

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
    const { category, paymentMode, searchQuery, startDate, endDate } = req.query;

    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    if (paymentMode) {
      query += ' AND payment_mode = ?';
      params.push(paymentMode);
    }

    if (searchQuery) {
      query += ' AND (name LIKE ? OR expense_id LIKE ? OR description LIKE ?)';
      const s = `%${searchQuery}%`;
      params.push(s, s, s);
    }

    if (startDate) {
      query += ' AND expense_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND expense_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY expense_date DESC, created_at DESC';

    const [expenses] = await pool.query(query, params);

    // Stats
    const [all] = await pool.query('SELECT amount, category FROM expenses');
    const totalExpenses = all.length;
    const totalAmount = all.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
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

    const { category, name, description, amount, paymentMode, expenseDate, referenceNo } = req.body;

    if (!category || !name || !amount || !paymentMode || !expenseDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Category, name, amount, payment mode and date are required' });
    }

    const expenseId = await generateExpenseId(connection);

    await connection.query(
      `INSERT INTO expenses (expense_id, category, name, description, amount, payment_mode, expense_date, reference_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        expenseId,
        category,
        name.trim(),
        description?.trim() || null,
        parseFloat(amount),
        paymentMode,
        expenseDate,
        referenceNo?.trim() || null
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

    const { id } = req.params;
    const { category, name, description, amount, paymentMode, expenseDate, referenceNo } = req.body;

    if (!category || !name || !amount || !paymentMode || !expenseDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Category, name, amount, payment mode and date are required' });
    }

    const [existing] = await connection.query('SELECT id FROM expenses WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    await connection.query(
      `UPDATE expenses SET
        category = ?, name = ?, description = ?, amount = ?, payment_mode = ?, expense_date = ?, reference_no = ?
       WHERE id = ?`,
      [
        category,
        name.trim(),
        description?.trim() || null,
        parseFloat(amount),
        paymentMode,
        expenseDate,
        referenceNo?.trim() || null,
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