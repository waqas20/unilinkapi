import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Root folder for all uploaded files.
 * On Railway, set UPLOAD_DIR to a mounted volume path (e.g. /data/uploads)
 * so files survive deploys. Local disk on Railway is ephemeral and is wiped
 * on every restart/redeploy — which is why previews become "Route not found".
 */
export const UPLOADS_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../uploads');

export function ensureUploadSubdir(subdir) {
  const dir = path.join(UPLOADS_ROOT, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function publicUploadPath(subdir, filename) {
  return `/uploads/${subdir}/${filename}`;
}

/** Map a stored public path like /uploads/application-forms/x.pdf to an absolute file path */
export function absoluteFromPublicPath(publicPath) {
  const cleaned = String(publicPath || '').replace(/^\/+/, '');
  const withoutPrefix = cleaned.startsWith('uploads/')
    ? cleaned.slice('uploads/'.length)
    : cleaned;
  return path.join(UPLOADS_ROOT, withoutPrefix);
}
