import fs from 'fs';
import path from 'path';
import { ensureUploadSubdir, absoluteFromPublicPath } from '../config/uploads.js';

/** Student registration document_name -> visa document_type */
export const STUDENT_TO_VISA_DOC_MAP = {
  'Passport': 'Passport',
  'Birth Certificate': 'Birth Certificate',
};

async function ensureVisaDocumentsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS visa_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      visa_id INT NOT NULL,
      document_type VARCHAR(100) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      original_name VARCHAR(255) NULL,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_visa_documents_visa (visa_id)
    )
  `);
}

async function copyFileToVisaDocs(srcPath, originalName, copiedFiles) {
  const visaUploadDir = ensureUploadSubdir('visa-documents');
  if (!fs.existsSync(visaUploadDir)) {
    fs.mkdirSync(visaUploadDir, { recursive: true });
  }

  const srcFull = absoluteFromPublicPath(srcPath);
  if (!fs.existsSync(srcFull)) return null;

  const ext = path.extname(originalName || srcFull) || path.extname(srcFull) || '';
  const newFilename = `visa-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const destFull = path.join(visaUploadDir, newFilename);
  const destPath = `/uploads/visa-documents/${newFilename}`;

  fs.copyFileSync(srcFull, destFull);
  copiedFiles.push(destFull);

  if (!fs.existsSync(destFull)) return null;

  return {
    destPath,
    originalName: originalName || path.basename(srcFull),
  };
}

/**
 * Transfer Passport + Birth Certificate from a student registration onto a visa.
 */
export async function transferStudentDocsToVisa(connection, studentId, visaDbId) {
  const copiedFiles = [];
  await ensureVisaDocumentsTable(connection);

  const names = Object.keys(STUDENT_TO_VISA_DOC_MAP);
  const [studentDocs] = await connection.query(
    `SELECT id, document_name, file_path
     FROM student_documents
     WHERE student_id = ?
       AND document_name IN (?)
     ORDER BY display_order ASC, uploaded_at ASC`,
    [studentId, names]
  );

  let transferred = 0;
  for (const doc of studentDocs) {
    const visaType = STUDENT_TO_VISA_DOC_MAP[doc.document_name];
    if (!visaType) continue;

    const copied = await copyFileToVisaDocs(doc.file_path, path.basename(doc.file_path || ''), copiedFiles);
    if (!copied) {
      console.warn(`Student→Visa transfer: source missing for student doc #${doc.id}`);
      continue;
    }

    await connection.query(
      `INSERT INTO visa_documents (visa_id, document_type, file_path, original_name)
       VALUES (?, ?, ?, ?)`,
      [visaDbId, visaType, copied.destPath, copied.originalName]
    );
    transferred += 1;
  }

  return { transferred, copiedFiles };
}

/**
 * Copy all documents from an existing visa onto a new visa.
 */
export async function transferVisaDocsToVisa(connection, sourceVisaId, newVisaDbId) {
  const copiedFiles = [];
  await ensureVisaDocumentsTable(connection);

  const [visaDocs] = await connection.query(
    `SELECT id, document_type, file_path, original_name
     FROM visa_documents
     WHERE visa_id = ?
     ORDER BY uploaded_at ASC`,
    [sourceVisaId]
  );

  let transferred = 0;
  for (const doc of visaDocs) {
    const copied = await copyFileToVisaDocs(
      doc.file_path,
      doc.original_name || path.basename(doc.file_path || ''),
      copiedFiles
    );
    if (!copied) {
      console.warn(`Visa→Visa transfer: source missing for visa doc #${doc.id}`);
      continue;
    }

    await connection.query(
      `INSERT INTO visa_documents (visa_id, document_type, file_path, original_name)
       VALUES (?, ?, ?, ?)`,
      [newVisaDbId, doc.document_type, copied.destPath, copied.originalName]
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
