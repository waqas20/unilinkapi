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

const addColumnIfMissing = async (connection, table, column, definition) => {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) {
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`✓ Added ${table}.${column}`);
    return true;
  }
  return false;
};

export async function ensureSchemaMigrations() {
  const connection = await pool.getConnection();
  try {
    await addColumnIfMissing(connection, 'users', 'invoice_id', 'INT NULL');
    await addColumnIfMissing(connection, 'users', 'source_lead_id', 'INT NULL');

    await connection.query('ALTER TABLE users MODIFY COLUMN dob DATE NULL').catch(() => {});

    const [hasSourceLeadId] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'source_lead_id'`
    );

    if (hasSourceLeadId.length > 0) {
      await connection.query(`
        UPDATE users u
        INNER JOIN (
          SELECT user_id, MIN(transferred_from_lead_id) AS lead_id
          FROM student_counselors
          WHERE transferred_from_lead_id IS NOT NULL
          GROUP BY user_id
        ) sc ON sc.user_id = u.id
        SET u.source_lead_id = sc.lead_id
        WHERE u.source_lead_id IS NULL AND u.role = 'client'
      `).catch(() => {});

      await connection.query(`
        UPDATE users u
        INNER JOIN leads l ON LOWER(l.email) = LOWER(u.email) AND l.is_registered = TRUE
        SET u.source_lead_id = l.id
        WHERE u.source_lead_id IS NULL AND u.role = 'client'
      `).catch(() => {});
    }

    console.log('✓ Schema migrations complete');
  } catch (err) {
    console.error('✗ Schema migration failed:', err.message);
    throw err;
  } finally {
    connection.release();
  }
}

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