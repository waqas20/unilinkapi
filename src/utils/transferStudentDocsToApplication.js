import fs from 'fs';
import path from 'path';
import { ensureUploadSubdir, absoluteFromPublicPath } from '../config/uploads.js';

/** Student document_name -> application document_type */
export const STUDENT_TO_APP_DOC_MAP = {
  'Passport': 'Passport',
  'Updated CV / Resume': 'CV',
  'English Proficiency Test': 'English Proficiency Test',
  'Extracurricular Certificates': 'Extra Curriculum Certificates',
  'Essay or SOP': 'Essay/SOP',
};

/**
 * Copy matching student registration documents onto an application.
 * @returns {{ transferred: number, copiedFiles: string[] }}
 */
export async function transferStudentDocsToApplication(connection, studentId, applicationDbId) {
  const copiedFiles = [];

  await connection.query(`
    CREATE TABLE IF NOT EXISTS application_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      application_id INT NOT NULL,
      document_type VARCHAR(100) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      original_name VARCHAR(255) NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_application_documents_app (application_id)
    )
  `);

  const transferableNames = Object.keys(STUDENT_TO_APP_DOC_MAP);
  const [studentDocs] = await connection.query(
    `SELECT id, document_name, document_type, file_path
     FROM student_documents
     WHERE student_id = ?
       AND document_name IN (?)
     ORDER BY display_order ASC, uploaded_at ASC`,
    [studentId, transferableNames]
  );

  const appUploadDir = ensureUploadSubdir('application-forms');
  if (!fs.existsSync(appUploadDir)) {
    fs.mkdirSync(appUploadDir, { recursive: true });
  }

  let transferred = 0;
  for (const doc of studentDocs) {
    const appType = STUDENT_TO_APP_DOC_MAP[doc.document_name];
    if (!appType) continue;

    const srcFull = absoluteFromPublicPath(doc.file_path);
    if (!fs.existsSync(srcFull)) {
      console.warn(`Student→Application transfer: source missing for student doc #${doc.id}: ${srcFull}`);
      continue;
    }

    const ext = path.extname(doc.file_path || srcFull) || '';
    const newFilename = `form-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const destFull = path.join(appUploadDir, newFilename);
    const destPath = `/uploads/application-forms/${newFilename}`;

    fs.copyFileSync(srcFull, destFull);
    copiedFiles.push(destFull);

    if (!fs.existsSync(destFull)) {
      console.warn(`Student→Application transfer: copy failed for student doc #${doc.id}`);
      continue;
    }

    const originalName = path.basename(doc.file_path || srcFull);
    await connection.query(
      `INSERT INTO application_documents (application_id, document_type, file_path, original_name)
       VALUES (?, ?, ?, ?)`,
      [applicationDbId, appType, destPath, originalName]
    );
    transferred += 1;
  }

  return { transferred, copiedFiles };
}

export function cleanupCopiedFiles(copiedFiles = []) {
  for (const f of copiedFiles) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* ignore */ }
  }
}
