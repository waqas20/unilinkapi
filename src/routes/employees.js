import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Generate Employee ID: EMP2025001
const generateEmployeeId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(employee_id, 8) AS UNSIGNED)) as max_id 
     FROM employees 
     WHERE employee_id LIKE 'EMP${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `EMP${currentYear}${String(nextId).padStart(3, '0')}`;
};

// GET all employees
router.get('/employees', async (req, res) => {
  try {
    const { department, status, searchQuery } = req.query;

    let query = 'SELECT * FROM employees WHERE 1=1';
    const params = [];

    if (department) {
      query += ' AND department = ?';
      params.push(department);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (searchQuery) {
      query += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR employee_id LIKE ? OR designation LIKE ?)';
      const s = `%${searchQuery}%`;
      params.push(s, s, s, s, s);
    }

    query += ' ORDER BY created_at DESC';

    const [employees] = await pool.query(query, params);

    // Stats
    const [all] = await pool.query('SELECT status, department FROM employees');
    const totalEmployees = all.length;
    const activeEmployees = all.filter(e => e.status === 'Active').length;
    const departments = [...new Set(all.map(e => e.department).filter(Boolean))].length;

    res.json({
      success: true,
      employees,
      stats: { totalEmployees, activeEmployees, departments }
    });

  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
});

// GET single employee
router.get('/employees/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, employee: rows[0] });
  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch employee' });
  }
});

// POST create employee
router.post('/employees', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      name, email, phone, emergencyPhone, cnicNumber,
      address, salary, department, designation, joiningDate, status
    } = req.body;

    if (!name || !phone) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }

    const employeeId = await generateEmployeeId(connection);

    await connection.query(
      `INSERT INTO employees 
       (employee_id, name, email, phone, emergency_phone, cnic_number, address, salary, department, designation, joining_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeId,
        name.trim(),
        email?.trim() || null,
        phone.trim(),
        emergencyPhone?.trim() || null,
        cnicNumber?.trim() || null,
        address?.trim() || null,
        salary || null,
        department?.trim() || null,
        designation?.trim() || null,
        joiningDate || null,
        status || 'Active'
      ]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Employee created successfully', employeeId });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating employee:', error);
    res.status(500).json({ success: false, message: 'Failed to create employee' });
  } finally {
    connection.release();
  }
});

// PUT update employee
router.put('/employees/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const {
      name, email, phone, emergencyPhone, cnicNumber,
      address, salary, department, designation, joiningDate, status
    } = req.body;

    if (!name || !phone) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }

    const [existing] = await connection.query('SELECT id FROM employees WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    await connection.query(
      `UPDATE employees SET
        name = ?, email = ?, phone = ?, emergency_phone = ?, cnic_number = ?,
        address = ?, salary = ?, department = ?, designation = ?, joining_date = ?, status = ?
       WHERE id = ?`,
      [
        name.trim(),
        email?.trim() || null,
        phone.trim(),
        emergencyPhone?.trim() || null,
        cnicNumber?.trim() || null,
        address?.trim() || null,
        salary || null,
        department?.trim() || null,
        designation?.trim() || null,
        joiningDate || null,
        status || 'Active',
        id
      ]
    );

    await connection.commit();
    res.json({ success: true, message: 'Employee updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating employee:', error);
    res.status(500).json({ success: false, message: 'Failed to update employee' });
  } finally {
    connection.release();
  }
});

// DELETE employee
router.delete('/employees/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM employees WHERE id = ?', [req.params.id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    await connection.query('DELETE FROM employees WHERE id = ?', [req.params.id]);
    await connection.commit();
    res.json({ success: true, message: 'Employee deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting employee:', error);
    res.status(500).json({ success: false, message: 'Failed to delete employee' });
  } finally {
    connection.release();
  }
});

export default router;