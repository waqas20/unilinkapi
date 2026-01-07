import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Get all intakes with university and country information
router.get('/intakes', async (req, res) => {
  try {
    const [intakes] = await pool.query(
      `SELECT i.*, 
              u.university_name, 
              u.country_id,
              c.country_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       ORDER BY i.intake_name DESC, u.university_name ASC`
    );
    
    res.json({
      success: true,
      intakes: intakes,
      total: intakes.length
    });
    
  } catch (error) {
    console.error('Error fetching intakes:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch intakes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single intake by ID
router.get('/intakes/:intakeId', async (req, res) => {
  try {
    const { intakeId } = req.params;
    
    const [intakes] = await pool.query(
      `SELECT i.*, 
              u.university_name, 
              u.country_id,
              c.country_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       WHERE i.id = ?`,
      [intakeId]
    );
    
    if (intakes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Intake not found' 
      });
    }
    
    res.json({
      success: true,
      intake: intakes[0]
    });
    
  } catch (error) {
    console.error('Error fetching intake:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch intake',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get intakes by university
router.get('/intakes/by-university/:universityId', async (req, res) => {
  try {
    const { universityId } = req.params;
    
    const [intakes] = await pool.query(
      `SELECT i.*, 
              u.university_name, 
              u.country_id,
              c.country_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       WHERE i.university_id = ?
       ORDER BY i.intake_name DESC`,
      [universityId]
    );
    
    res.json({
      success: true,
      intakes: intakes,
      total: intakes.length
    });
    
  } catch (error) {
    console.error('Error fetching intakes by university:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch intakes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get intakes by country
router.get('/intakes/by-country/:countryId', async (req, res) => {
  try {
    const { countryId } = req.params;
    
    const [intakes] = await pool.query(
      `SELECT i.*, 
              u.university_name, 
              u.country_id,
              c.country_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       WHERE u.country_id = ?
       ORDER BY i.intake_name DESC, u.university_name ASC`,
      [countryId]
    );
    
    res.json({
      success: true,
      intakes: intakes,
      total: intakes.length
    });
    
  } catch (error) {
    console.error('Error fetching intakes by country:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch intakes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new intake
router.post('/intakes', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { intakeName, universityId, status } = req.body;
    
    // Validate required fields
    if (!intakeName || !universityId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name and university are required' 
      });
    }

    // Trim and validate intake name
    const trimmedIntakeName = intakeName.trim();

    if (trimmedIntakeName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name must be at least 3 characters long' 
      });
    }

    if (trimmedIntakeName.length > 100) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name must not exceed 100 characters' 
      });
    }

    // Validate university ID
    const [university] = await connection.query(
      'SELECT id, university_name FROM universities WHERE id = ?',
      [universityId]
    );

    if (university.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Selected university does not exist' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const intakeStatus = status || 'Active';
    
    if (!validStatuses.includes(intakeStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }
    
    // Check if intake with same name already exists for the same university
    const [existingIntake] = await connection.query(
      `SELECT i.id, i.intake_name, u.university_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       WHERE LOWER(i.intake_name) = LOWER(?) AND i.university_id = ?`,
      [trimmedIntakeName, universityId]
    );
    
    if (existingIntake.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `Intake "${existingIntake[0].intake_name}" already exists for ${existingIntake[0].university_name}`
      });
    }
    
    // Insert intake
    const [result] = await connection.query(
      'INSERT INTO intakes (intake_name, university_id, status) VALUES (?, ?, ?)',
      [trimmedIntakeName, universityId, intakeStatus]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Intake added successfully',
      intakeId: result.insertId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating intake:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while adding the intake',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update intake
router.put('/intakes/:intakeId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { intakeId } = req.params;
    const { intakeName, universityId, status } = req.body;
    
    // Validate required fields
    if (!intakeName || !universityId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name and university are required' 
      });
    }

    // Trim and validate intake name
    const trimmedIntakeName = intakeName.trim();

    if (trimmedIntakeName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name must be at least 3 characters long' 
      });
    }

    if (trimmedIntakeName.length > 100) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Intake name must not exceed 100 characters' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const intakeStatus = status || 'Active';
    
    if (!validStatuses.includes(intakeStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }

    // Check if intake exists
    const [existingIntake] = await connection.query(
      'SELECT id FROM intakes WHERE id = ?',
      [intakeId]
    );
    
    if (existingIntake.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Intake not found' 
      });
    }

    // Validate university ID
    const [university] = await connection.query(
      'SELECT id, university_name FROM universities WHERE id = ?',
      [universityId]
    );

    if (university.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Selected university does not exist' 
      });
    }

    // Check if intake name is being changed to one that already exists for the same university
    const [nameCheck] = await connection.query(
      `SELECT i.id, i.intake_name, u.university_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       WHERE LOWER(i.intake_name) = LOWER(?) AND i.university_id = ? AND i.id != ?`,
      [trimmedIntakeName, universityId, intakeId]
    );
    
    if (nameCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `Intake "${nameCheck[0].intake_name}" already exists for ${nameCheck[0].university_name}`
      });
    }
    
    // Update intake
    await connection.query(
      'UPDATE intakes SET intake_name = ?, university_id = ?, status = ? WHERE id = ?',
      [trimmedIntakeName, universityId, intakeStatus, intakeId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Intake updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating intake:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the intake',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete intake
router.delete('/intakes/:intakeId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { intakeId } = req.params;
    
    // Check if intake exists
    const [intake] = await connection.query(
      `SELECT i.id, i.intake_name, u.university_name, c.country_name 
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       WHERE i.id = ?`,
      [intakeId]
    );
    
    if (intake.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Intake not found' 
      });
    }
    
    // You can add additional checks here to prevent deletion if intake is referenced elsewhere
    // For example:
    // const [references] = await connection.query(
    //   'SELECT COUNT(*) as count FROM student_applications WHERE intake_id = ?',
    //   [intakeId]
    // );
    // if (references[0].count > 0) {
    //   return res.status(400).json({ 
    //     success: false, 
    //     message: 'Cannot delete intake as it is being used by student applications' 
    //   });
    // }
    
    // Delete intake
    await connection.query(
      'DELETE FROM intakes WHERE id = ?',
      [intakeId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Intake deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting intake:', error);
    
    // Check if it's a foreign key constraint error
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete intake as it is being referenced by other records'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the intake',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Get intake statistics
router.get('/intakes/stats/overview', async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_intakes,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active_intakes,
        SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) as inactive_intakes,
        COUNT(DISTINCT university_id) as universities_with_intakes
       FROM intakes`
    );
    
    res.json({
      success: true,
      stats: stats[0]
    });
    
  } catch (error) {
    console.error('Error fetching intake statistics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get intakes grouped by university
router.get('/intakes/grouped/by-university', async (req, res) => {
  try {
    const [grouped] = await pool.query(
      `SELECT u.id as university_id, 
              u.university_name, 
              c.country_name,
              COUNT(i.id) as intake_count,
              GROUP_CONCAT(i.intake_name ORDER BY i.intake_name DESC SEPARATOR '|') as intakes
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       LEFT JOIN intakes i ON u.id = i.university_id
       GROUP BY u.id, u.university_name, c.country_name
       HAVING intake_count > 0
       ORDER BY intake_count DESC, u.university_name ASC`
    );
    
    // Format the response
    const formattedData = grouped.map(item => ({
      university_id: item.university_id,
      university_name: item.university_name,
      country_name: item.country_name,
      intake_count: item.intake_count,
      intakes: item.intakes ? item.intakes.split('|') : []
    }));
    
    res.json({
      success: true,
      data: formattedData
    });
    
  } catch (error) {
    console.error('Error fetching grouped intakes:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch grouped data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get intakes grouped by intake name (to see which universities offer same intake)
router.get('/intakes/grouped/by-name', async (req, res) => {
  try {
    const [grouped] = await pool.query(
      `SELECT i.intake_name,
              COUNT(i.id) as university_count,
              GROUP_CONCAT(CONCAT(u.university_name, ' (', c.country_name, ')') ORDER BY u.university_name SEPARATOR '|') as universities
       FROM intakes i
       INNER JOIN universities u ON i.university_id = u.id
       INNER JOIN countries c ON u.country_id = c.id
       GROUP BY i.intake_name
       ORDER BY i.intake_name DESC`
    );
    
    // Format the response
    const formattedData = grouped.map(item => ({
      intake_name: item.intake_name,
      university_count: item.university_count,
      universities: item.universities ? item.universities.split('|') : []
    }));
    
    res.json({
      success: true,
      data: formattedData
    });
    
  } catch (error) {
    console.error('Error fetching grouped intakes by name:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch grouped data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;