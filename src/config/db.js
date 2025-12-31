import mysql from 'mysql2/promise';

// Debug: Check if environment variables are loaded
console.log('Database configuration:', {
  host: process.env.DB_HOST || 'NOT SET',
  user: process.env.DB_USER || 'NOT SET',
  database: process.env.DB_NAME || 'NOT SET',
  password: process.env.DB_PASSWORD === '' ? 'EMPTY STRING' : (process.env.DB_PASSWORD || 'NOT SET')
});

const pool = mysql.createPool({
  uri: 'mysql://root:grWNxchRtVkzZFAMcgQzWnDzoyTafPjI@trolley.proxy.rlwy.net:12672/railway', // Railway will parse it automatically
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
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