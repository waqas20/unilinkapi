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
    await addColumnIfMissing(connection, 'users', 'admission_tests', 'TEXT NULL');
    await addColumnIfMissing(connection, 'users', 'allowed_modules', 'TEXT NULL');
    await addColumnIfMissing(connection, 'leads', 'referred_by_name', 'VARCHAR(255) NULL');
    try {
      await connection.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL`);
    } catch (err) {
      console.warn('users.role widen:', err.message);
    }
    await connection.query('ALTER TABLE users MODIFY COLUMN student_id VARCHAR(50) NULL').catch(() => {});
    await connection.query('ALTER TABLE users ADD UNIQUE INDEX idx_users_student_id (student_id)').catch(() => {});
    await connection.query('ALTER TABLE users MODIFY COLUMN passport_no TEXT NULL').catch(() => {});
    await connection.query('ALTER TABLE student_education MODIFY COLUMN subjects TEXT NULL').catch(() => {});
    await connection.query('ALTER TABLE student_education MODIFY COLUMN education_level VARCHAR(50) NULL').catch(() => {});
    await connection.query('ALTER TABLE student_education MODIFY COLUMN result TEXT NULL').catch(() => {});
    await connection.query('ALTER TABLE student_education MODIFY COLUMN start_date DATE NULL').catch((err) => {
      console.warn('student_education.start_date nullable:', err.message);
    });
    await connection.query('ALTER TABLE student_education MODIFY COLUMN end_date DATE NULL').catch((err) => {
      console.warn('student_education.end_date nullable:', err.message);
    });

    await connection.query('ALTER TABLE users MODIFY COLUMN dob DATE NULL').catch(() => {});

    // Allow 'Other' on student_family_details.type (was ENUM Father/Mother/Sponsor only)
    try {
      const [familyTypeCols] = await connection.query(
        `SHOW COLUMNS FROM student_family_details LIKE 'type'`
      );
      const typeDef = String(familyTypeCols[0]?.Type || '');
      if (typeDef.toLowerCase().startsWith('enum') && !/'other'/i.test(typeDef)) {
        await connection.query(
          `ALTER TABLE student_family_details MODIFY COLUMN type ENUM('Father','Mother','Sponsor','Other') NOT NULL`
        );
        console.log('✓ student_family_details.type includes Other');
      }
    } catch (err) {
      console.warn('student_family_details.type ensure Other:', err.message);
    }

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