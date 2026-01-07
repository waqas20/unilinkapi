import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Get all universities with country information
router.get('/universities', async (req, res) => {
  try {
    const [universities] = await pool.query(
      `SELECT u.*, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       ORDER BY u.university_name ASC`
    );
    
    res.json({
      success: true,
      universities: universities,
      total: universities.length
    });
    
  } catch (error) {
    console.error('Error fetching universities:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch universities',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single university by ID
router.get('/universities/:universityId', async (req, res) => {
  try {
    const { universityId } = req.params;
    
    const [universities] = await pool.query(
      `SELECT u.*, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       WHERE u.id = ?`,
      [universityId]
    );
    
    if (universities.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'University not found' 
      });
    }
    
    res.json({
      success: true,
      university: universities[0]
    });
    
  } catch (error) {
    console.error('Error fetching university:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch university',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get universities by country
router.get('/universities/by-country/:countryId', async (req, res) => {
  try {
    const { countryId } = req.params;
    
    const [universities] = await pool.query(
      `SELECT u.*, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       WHERE u.country_id = ?
       ORDER BY u.university_name ASC`,
      [countryId]
    );
    
    res.json({
      success: true,
      universities: universities,
      total: universities.length
    });
    
  } catch (error) {
    console.error('Error fetching universities by country:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch universities',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new university
router.post('/universities', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { universityName, countryId, status } = req.body;
    
    // Validate required fields
    if (!universityName || !countryId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name and country are required' 
      });
    }

    // Trim and validate university name
    const trimmedUniversityName = universityName.trim();

    if (trimmedUniversityName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name must be at least 3 characters long' 
      });
    }

    if (trimmedUniversityName.length > 200) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name must not exceed 200 characters' 
      });
    }

    // Validate country ID
    const [country] = await connection.query(
      'SELECT id, country_name FROM countries WHERE id = ?',
      [countryId]
    );

    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Selected country does not exist' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const universityStatus = status || 'Active';
    
    if (!validStatuses.includes(universityStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }
    
    // Check if university with same name already exists in the same country
    const [existingUniversity] = await connection.query(
      `SELECT u.id, u.university_name, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       WHERE LOWER(u.university_name) = LOWER(?) AND u.country_id = ?`,
      [trimmedUniversityName, countryId]
    );
    
    if (existingUniversity.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `University "${existingUniversity[0].university_name}" already exists in ${existingUniversity[0].country_name}`
      });
    }
    
    // Insert university
    const [result] = await connection.query(
      'INSERT INTO universities (university_name, country_id, status) VALUES (?, ?, ?)',
      [trimmedUniversityName, countryId, universityStatus]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'University added successfully',
      universityId: result.insertId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating university:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while adding the university',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update university
router.put('/universities/:universityId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { universityId } = req.params;
    const { universityName, countryId, status } = req.body;
    
    // Validate required fields
    if (!universityName || !countryId) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name and country are required' 
      });
    }

    // Trim and validate university name
    const trimmedUniversityName = universityName.trim();

    if (trimmedUniversityName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name must be at least 3 characters long' 
      });
    }

    if (trimmedUniversityName.length > 200) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'University name must not exceed 200 characters' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const universityStatus = status || 'Active';
    
    if (!validStatuses.includes(universityStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }

    // Check if university exists
    const [existingUniversity] = await connection.query(
      'SELECT id FROM universities WHERE id = ?',
      [universityId]
    );
    
    if (existingUniversity.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'University not found' 
      });
    }

    // Validate country ID
    const [country] = await connection.query(
      'SELECT id, country_name FROM countries WHERE id = ?',
      [countryId]
    );

    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Selected country does not exist' 
      });
    }

    // Check if university name is being changed to one that already exists in the same country
    const [nameCheck] = await connection.query(
      `SELECT u.id, u.university_name, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       WHERE LOWER(u.university_name) = LOWER(?) AND u.country_id = ? AND u.id != ?`,
      [trimmedUniversityName, countryId, universityId]
    );
    
    if (nameCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `University "${nameCheck[0].university_name}" already exists in ${nameCheck[0].country_name}`
      });
    }
    
    // Update university
    await connection.query(
      'UPDATE universities SET university_name = ?, country_id = ?, status = ? WHERE id = ?',
      [trimmedUniversityName, countryId, universityStatus, universityId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'University updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating university:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the university',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete university
router.delete('/universities/:universityId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { universityId } = req.params;
    
    // Check if university exists
    const [university] = await connection.query(
      `SELECT u.id, u.university_name, c.country_name 
       FROM universities u
       INNER JOIN countries c ON u.country_id = c.id
       WHERE u.id = ?`,
      [universityId]
    );
    
    if (university.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'University not found' 
      });
    }
    
    // You can add additional checks here to prevent deletion if university is referenced elsewhere
    // For example:
    // const [references] = await connection.query(
    //   'SELECT COUNT(*) as count FROM students WHERE university_id = ?',
    //   [universityId]
    // );
    // if (references[0].count > 0) {
    //   return res.status(400).json({ 
    //     success: false, 
    //     message: 'Cannot delete university as it is being used by students' 
    //   });
    // }
    
    // Delete university
    await connection.query(
      'DELETE FROM universities WHERE id = ?',
      [universityId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'University deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting university:', error);
    
    // Check if it's a foreign key constraint error
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete university as it is being referenced by other records'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the university',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Get university statistics
router.get('/universities/stats/overview', async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_universities,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active_universities,
        SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) as inactive_universities,
        COUNT(DISTINCT country_id) as countries_with_universities
       FROM universities`
    );
    
    res.json({
      success: true,
      stats: stats[0]
    });
    
  } catch (error) {
    console.error('Error fetching university statistics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get universities grouped by country
router.get('/universities/grouped/by-country', async (req, res) => {
  try {
    const [grouped] = await pool.query(
      `SELECT c.id as country_id, c.country_name, 
              COUNT(u.id) as university_count,
              GROUP_CONCAT(u.university_name ORDER BY u.university_name SEPARATOR '|') as universities
       FROM countries c
       LEFT JOIN universities u ON c.id = u.country_id
       GROUP BY c.id, c.country_name
       HAVING university_count > 0
       ORDER BY university_count DESC, c.country_name ASC`
    );
    
    // Format the response
    const formattedData = grouped.map(item => ({
      country_id: item.country_id,
      country_name: item.country_name,
      university_count: item.university_count,
      universities: item.universities ? item.universities.split('|') : []
    }));
    
    res.json({
      success: true,
      data: formattedData
    });
    
  } catch (error) {
    console.error('Error fetching grouped universities:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch grouped data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;