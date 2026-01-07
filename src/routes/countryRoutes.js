import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// Get all countries
router.get('/countries', async (req, res) => {
  try {
    const [countries] = await pool.query(
      `SELECT * FROM countries ORDER BY country_name ASC`
    );
    
    res.json({
      success: true,
      countries: countries,
      total: countries.length
    });
    
  } catch (error) {
    console.error('Error fetching countries:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch countries',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single country by ID
router.get('/countries/:countryId', async (req, res) => {
  try {
    const { countryId } = req.params;
    
    const [countries] = await pool.query(
      'SELECT * FROM countries WHERE id = ?',
      [countryId]
    );
    
    if (countries.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Country not found' 
      });
    }
    
    res.json({
      success: true,
      country: countries[0]
    });
    
  } catch (error) {
    console.error('Error fetching country:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch country',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new country
router.post('/countries', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { countryName, status } = req.body;
    
    // Validate required fields
    if (!countryName) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name is required' 
      });
    }

    // Trim and validate country name
    const trimmedCountryName = countryName.trim();

    if (trimmedCountryName.length < 2) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name must be at least 2 characters long' 
      });
    }

    if (trimmedCountryName.length > 100) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name must not exceed 100 characters' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const countryStatus = status || 'Active';
    
    if (!validStatuses.includes(countryStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }
    
    // Check if country already exists (case-insensitive)
    const [existingCountry] = await connection.query(
      'SELECT id, country_name FROM countries WHERE LOWER(country_name) = LOWER(?)',
      [trimmedCountryName]
    );
    
    if (existingCountry.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `Country "${existingCountry[0].country_name}" already exists in the system`
      });
    }
    
    // Insert country
    const [result] = await connection.query(
      'INSERT INTO countries (country_name, status) VALUES (?, ?)',
      [trimmedCountryName, countryStatus]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Country added successfully',
      countryId: result.insertId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating country:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while adding the country',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update country
router.put('/countries/:countryId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { countryId } = req.params;
    const { countryName, status } = req.body;
    
    // Validate required fields
    if (!countryName) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name is required' 
      });
    }

    // Trim and validate country name
    const trimmedCountryName = countryName.trim();

    if (trimmedCountryName.length < 2) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name must be at least 2 characters long' 
      });
    }

    if (trimmedCountryName.length > 100) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Country name must not exceed 100 characters' 
      });
    }

    // Validate status
    const validStatuses = ['Active', 'Inactive'];
    const countryStatus = status || 'Active';
    
    if (!validStatuses.includes(countryStatus)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either Active or Inactive' 
      });
    }

    // Check if country exists
    const [existingCountry] = await connection.query(
      'SELECT id FROM countries WHERE id = ?',
      [countryId]
    );
    
    if (existingCountry.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Country not found' 
      });
    }

    // Check if country name is being changed to one that already exists
    const [nameCheck] = await connection.query(
      'SELECT id, country_name FROM countries WHERE LOWER(country_name) = LOWER(?) AND id != ?',
      [trimmedCountryName, countryId]
    );
    
    if (nameCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: `Country "${nameCheck[0].country_name}" already exists in the system`
      });
    }
    
    // Update country
    await connection.query(
      'UPDATE countries SET country_name = ?, status = ? WHERE id = ?',
      [trimmedCountryName, countryStatus, countryId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Country updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating country:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the country',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete country
router.delete('/countries/:countryId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { countryId } = req.params;
    
    // Check if country exists
    const [country] = await connection.query(
      'SELECT id, country_name FROM countries WHERE id = ?',
      [countryId]
    );
    
    if (country.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Country not found' 
      });
    }
    
    // You can add additional checks here to prevent deletion if country is referenced elsewhere
    // For example:
    // const [references] = await connection.query(
    //   'SELECT COUNT(*) as count FROM students WHERE country_id = ?',
    //   [countryId]
    // );
    // if (references[0].count > 0) {
    //   return res.status(400).json({ 
    //     success: false, 
    //     message: 'Cannot delete country as it is being used by students' 
    //   });
    // }
    
    // Delete country
    await connection.query(
      'DELETE FROM countries WHERE id = ?',
      [countryId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Country deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting country:', error);
    
    // Check if it's a foreign key constraint error
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete country as it is being referenced by other records'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the country',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Get country statistics
router.get('/countries/stats/overview', async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_countries,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active_countries,
        SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) as inactive_countries
       FROM countries`
    );
    
    res.json({
      success: true,
      stats: stats[0]
    });
    
  } catch (error) {
    console.error('Error fetching country statistics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;