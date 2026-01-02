import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Generate log ID
const generateLogId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(log_id, 7) AS UNSIGNED)) as max_id 
     FROM visitor_logs 
     WHERE log_id LIKE 'VL${currentYear}%'`
  );
  
  const nextId = (result[0].max_id || 0) + 1;
  return `VL${currentYear}${String(nextId).padStart(4, '0')}`;
};

// Get all visitor logs with stats
router.get('/visitor-logs', async (req, res) => {
  try {
    const { visitorType, status, searchQuery } = req.query;
    
    let query = 'SELECT * FROM visitor_logs WHERE 1=1';
    const params = [];
    
    if (visitorType) {
      query += ' AND visitor_type = ?';
      params.push(visitorType);
    }
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    if (searchQuery) {
      query += ' AND (visitor_name LIKE ? OR contact_no LIKE ? OR log_id LIKE ?)';
      const searchPattern = `%${searchQuery}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }
    
    query += ' ORDER BY visit_date DESC, time_in DESC';
    
    const [logs] = await pool.query(query, params);
    
    // Get today's date
    const today = new Date().toISOString().split('T')[0];
    
    // Calculate stats
    const [allLogs] = await pool.query('SELECT * FROM visitor_logs');
    const totalVisitors = allLogs.length;
    const todayVisitors = allLogs.filter(log => log.visit_date.toISOString().split('T')[0] === today).length;
    const currentlyInOffice = allLogs.filter(log => log.status === 'In Progress').length;
    
    res.json({
      success: true,
      logs: logs,
      stats: {
        totalVisitors,
        todayVisitors,
        currentlyInOffice
      }
    });
    
  } catch (error) {
    console.error('Error fetching visitor logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch visitor logs',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single visitor log by ID
router.get('/visitor-logs/:logId', async (req, res) => {
  try {
    const { logId } = req.params;
    
    const [logs] = await pool.query(
      'SELECT * FROM visitor_logs WHERE id = ?',
      [logId]
    );
    
    if (logs.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Visitor log not found' 
      });
    }
    
    res.json({
      success: true,
      log: logs[0]
    });
    
  } catch (error) {
    console.error('Error fetching visitor log:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch visitor log',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new visitor log
router.post('/visitor-logs', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      visitorName, visitorType, contactNo, email, address,
      idType, idNumber, purpose, visitDate, timeIn, timeOut,
      personToMeet, department, remarks, status
    } = req.body;
    
    // Validate required fields
    if (!visitorName || !visitorType || !contactNo || !purpose || !visitDate || !timeIn) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }
    
    // Generate log ID
    const logId = await generateLogId(connection);
    
    // Determine status based on timeOut
    let logStatus = status || 'In Progress';
    if (timeOut) {
      logStatus = 'Completed';
    }
    
    // Insert visitor log
    await connection.query(
      `INSERT INTO visitor_logs 
       (log_id, visitor_name, visitor_type, contact_no, email, address, 
        id_type, id_number, purpose, visit_date, time_in, time_out, 
        person_to_meet, department, remarks, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, visitorName.trim(), visitorType, contactNo.trim(), email?.trim() || null, 
       address?.trim() || null, idType || null, idNumber?.trim() || null, purpose.trim(), 
       visitDate, timeIn, timeOut || null, personToMeet?.trim() || null, 
       department?.trim() || null, remarks?.trim() || null, logStatus]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Visitor log created successfully',
      logId: logId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating visitor log:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while creating the visitor log',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update visitor log
router.put('/visitor-logs/:logId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { logId } = req.params;
    const {
      visitorName, visitorType, contactNo, email, address,
      idType, idNumber, purpose, visitDate, timeIn, timeOut,
      personToMeet, department, remarks, status
    } = req.body;
    
    // Validate required fields
    if (!visitorName || !visitorType || !contactNo || !purpose || !visitDate || !timeIn) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }
    
    // Check if log exists
    const [existingLog] = await connection.query(
      'SELECT id FROM visitor_logs WHERE id = ?',
      [logId]
    );
    
    if (existingLog.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Visitor log not found' 
      });
    }
    
    // Determine status based on timeOut
    let logStatus = status || 'In Progress';
    if (timeOut) {
      logStatus = 'Completed';
    }
    
    // Update visitor log
    await connection.query(
      `UPDATE visitor_logs 
       SET visitor_name = ?, visitor_type = ?, contact_no = ?, email = ?, address = ?, 
           id_type = ?, id_number = ?, purpose = ?, visit_date = ?, time_in = ?, time_out = ?, 
           person_to_meet = ?, department = ?, remarks = ?, status = ?
       WHERE id = ?`,
      [visitorName.trim(), visitorType, contactNo.trim(), email?.trim() || null, 
       address?.trim() || null, idType || null, idNumber?.trim() || null, purpose.trim(), 
       visitDate, timeIn, timeOut || null, personToMeet?.trim() || null, 
       department?.trim() || null, remarks?.trim() || null, logStatus, logId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Visitor log updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating visitor log:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the visitor log',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete visitor log
router.delete('/visitor-logs/:logId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { logId } = req.params;
    
    // Check if log exists
    const [existingLog] = await connection.query(
      'SELECT id, visitor_name FROM visitor_logs WHERE id = ?',
      [logId]
    );
    
    if (existingLog.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Visitor log not found' 
      });
    }
    
    // Delete visitor log
    await connection.query('DELETE FROM visitor_logs WHERE id = ?', [logId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Visitor log deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting visitor log:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the visitor log',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Mark visitor as checked out
router.post('/visitor-logs/:logId/checkout', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { logId } = req.params;
    const { timeOut } = req.body;
    
    if (!timeOut) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Time out is required' 
      });
    }
    
    // Check if log exists
    const [existingLog] = await connection.query(
      'SELECT id FROM visitor_logs WHERE id = ?',
      [logId]
    );
    
    if (existingLog.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Visitor log not found' 
      });
    }
    
    // Update time out and status
    await connection.query(
      'UPDATE visitor_logs SET time_out = ?, status = ? WHERE id = ?',
      [timeOut, 'Completed', logId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Visitor checked out successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error checking out visitor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while checking out the visitor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

export default router;