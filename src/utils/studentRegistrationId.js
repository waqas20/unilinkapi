export const STUDENT_ID_PREFIX = 'ULK';

export const normalizeStudentRegistrationId = (value) => {
  const raw = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  const suffix = raw.startsWith(STUDENT_ID_PREFIX) ? raw.slice(STUDENT_ID_PREFIX.length) : raw;
  return suffix ? `${STUDENT_ID_PREFIX}${suffix}` : '';
};

export const validateStudentRegistrationId = (value) => {
  const id = normalizeStudentRegistrationId(value);
  if (!id || id.length <= STUDENT_ID_PREFIX.length) {
    return {
      valid: false,
      message: 'Registration ID is required. Enter characters after ULK.'
    };
  }
  if (id.length > 50) {
    return {
      valid: false,
      message: 'Registration ID is too long (max 50 characters).'
    };
  }
  return { valid: true, value: id };
};

export const claimStudentRegistrationId = async (connection, rawValue) => {
  const result = validateStudentRegistrationId(rawValue);
  if (!result.valid) {
    const error = new Error(result.message);
    error.statusCode = 400;
    throw error;
  }

  const [existing] = await connection.query(
    'SELECT id FROM users WHERE LOWER(student_id) = LOWER(?) LIMIT 1',
    [result.value]
  );
  if (existing.length > 0) {
    const error = new Error('This Registration ID is already in use. Please enter a unique ID.');
    error.statusCode = 409;
    throw error;
  }

  return result.value;
};
