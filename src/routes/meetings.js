// routes/meetings.js
// Mount this in your main app as:
//   import meetingsRouter from './routes/meetings.js';
//   app.use('/api', meetingsRouter);   // or whatever your base path is
//
// This gives you:  GET /meetings/all
//                  PUT /meetings/:meetingId/status   (optional convenience)

import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// ─── GET /meetings/all ────────────────────────────────────────────────────────
// Returns every row from counselor_meetings, enriched with counselor info and
// — where the meeting belongs to a student — the student's email.
// Differentiates leads vs students via the presence of lead_id / user_id.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/meetings/all', async (req, res) => {
  try {
    const [meetings] = await pool.query(
      `SELECT
         cm.id,
         cm.counselor_id,
         cm.lead_id,
         cm.user_id,
         cm.student_name,
         cm.student_id,
         cm.meeting_date,
         cm.meeting_time,
         cm.duration_minutes,
         cm.status,
         cm.notes,
         cm.meeting_notes_image,
         cm.created_at,

         -- Counselor details
         c.name          AS counselor_name,
         c.counselor_id  AS counselor_id_code,
         c.email         AS counselor_email,
         c.phone         AS counselor_phone,

         -- Student email (NULL for lead meetings)
         u.email         AS student_email,

         -- Lead email (NULL for student meetings)
         l.email         AS lead_email

       FROM counselor_meetings cm

       INNER JOIN counselors c
         ON cm.counselor_id = c.id

       LEFT JOIN users u
         ON cm.user_id = u.id AND u.role = 'client'

       LEFT JOIN leads l
         ON cm.lead_id = l.id

       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`
    );

    // Normalise: for lead meetings student_email comes from lead_email
    const normalised = meetings.map(m => ({
      ...m,
      meeting_date:  m.meeting_date
        ? (typeof m.meeting_date === 'string'
            ? m.meeting_date.split('T')[0]
            : m.meeting_date.toISOString().split('T')[0])
        : null,
      student_email: m.student_email || m.lead_email || null,
      // Handy boolean flags for the frontend
      is_lead_meeting:    !!m.lead_id && !m.user_id,
      is_student_meeting: !!m.user_id,
    }));

    res.json({ success: true, meetings: normalised, total: normalised.length });
  } catch (error) {
    console.error('Error fetching all meetings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch meetings' });
  }
});

// ─── PUT /meetings/:meetingId/status ──────────────────────────────────────────
// Quick status update (Scheduled → Completed | Cancelled etc.)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/meetings/:meetingId/status', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { meetingId } = req.params;
    const { status } = req.body;

    const VALID_STATUSES = ['Scheduled', 'Completed', 'Cancelled'];
    if (!status || !VALID_STATUSES.includes(status)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const [existing] = await connection.query(
      'SELECT id FROM counselor_meetings WHERE id = ?', [meetingId]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }

    await connection.query(
      'UPDATE counselor_meetings SET status = ? WHERE id = ?',
      [status, meetingId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Meeting status updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating meeting status:', error);
    res.status(500).json({ success: false, message: 'Failed to update meeting status' });
  } finally {
    connection.release();
  }
});

export default router;