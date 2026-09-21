const SUBJECT_GRADE_LEVELS = ['O Level', 'A Level'];
const PERCENTAGE_LEVELS = ['Matriculation', 'Intermediate'];
const CGPA_LEVELS = ['Graduate', 'Post Graduate'];
const A_LEVEL_TYPES = ['AS', 'A2'];

const toMonthValue = (value) => {
  if (!value) return null;
  const raw = String(value).split('T')[0];
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (raw.length >= 10) return raw.slice(0, 10);
  return null;
};

const serializeSubjects = (subjects) =>
  (subjects || [])
    .map(s => ({ subject: (s.subject || '').trim(), grade: (s.grade || '').trim() }))
    .filter(s => s.subject || s.grade);

const summarizeSubjectGrades = (subjects) =>
  serializeSubjects(subjects)
    .map(s => [s.subject, s.grade].filter(Boolean).join(' '))
    .join(', ');

const parseLeadQualifications = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const rowFromDetail = (level, detail = {}) => {
  const subjects = SUBJECT_GRADE_LEVELS.includes(level) || level === 'A Level'
    ? serializeSubjects(detail.subjects)
    : [];
  let result = '';
  if (PERCENTAGE_LEVELS.includes(level)) result = (detail.percentage || '').trim();
  else if (CGPA_LEVELS.includes(level)) result = (detail.cgpaDivision || '').trim();
  else result = summarizeSubjectGrades(detail.subjects);

  const aLevelType = A_LEVEL_TYPES.includes(detail.aLevelType) ? detail.aLevelType : null;
  const subjectsValue = aLevelType
    ? JSON.stringify({ aLevelType, subjects })
    : (subjects.length ? JSON.stringify(subjects) : null);

  return {
    education_level: level,
    institute_name: (detail.instituteName || detail.institute_name || '').trim() || null,
    start_date: toMonthValue(detail.durationFrom || detail.start_date),
    end_date: toMonthValue(detail.durationTo || detail.end_date),
    subjects: subjectsValue,
    result: result || null,
  };
};

export const qualificationsToEducationRows = (rawQualifications) => {
  const entries = parseLeadQualifications(rawQualifications);
  const rows = [];

  entries.forEach(entry => {
    const level = entry.level || entry.qualification;
    if (!level) return;
    if (level === 'A Level') {
      const types = A_LEVEL_TYPES.filter(type =>
        (Array.isArray(entry.aLevelTypes) ? entry.aLevelTypes : entry.types || []).includes(type)
      );
      if (types.length) {
        types.forEach(type => {
          rows.push(rowFromDetail('A Level', { ...(entry.stages?.[type] || {}), aLevelType: type }));
        });
        return;
      }
    }
    rows.push(rowFromDetail(level, entry));
  });

  return rows.filter(row =>
    row.education_level &&
    (row.institute_name || row.subjects || row.result || row.start_date || row.end_date)
  );
};
