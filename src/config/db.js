import mysql from 'mysql2/promise';

// Debug: Check if environment variables are loaded
console.log('Database configuration:', {
  host: process.env.DB_HOST || 'NOT SET',
  user: process.env.DB_USER || 'NOT SET',
  database: process.env.DB_NAME || 'NOT SET',
  password: process.env.DB_PASSWORD === '' ? 'EMPTY STRING' : (process.env.DB_PASSWORD || 'NOT SET')
});

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'u760925268_unilinks',
  password: process.env.DB_PASSWORD || 'U760925268_unilinks',
  database: process.env.DB_NAME || 'u760925268_unilinks',
  port: parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Test connection on startup
pool.getConnection()
  .then(connection => {
    console.log('✓ Database connected successfully');
    connection.release();
  })
  .catch(err => {
    console.error('✗ Database connection failed:', err.message);
  });

export default pool;