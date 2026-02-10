import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import leadRoutes from './routes/LeadRoutes.js';
import counselorRoutes from './routes/CounselorRoutes.js';
import studentRoutes from './routes/StudentRoutes.js';
import visitorLogRoutes from './routes/VisitorLogRoutes.js';
import countryRoutes from './routes/countryRoutes.js';
import universityRoutes from './routes/universityRoutes.js';
import intakeRoutes from './routes/intakeRoutes.js';
import ApplicationRoutes from './routes/ApplicationRoutes.js';
import VisaRoutes from './routes/VisaRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Simple CORS - same domain now, but keep for local development
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes - IMPORTANT: No /api prefix here since .htaccess strips it
app.use('/auth', authRoutes);
app.use('/', leadRoutes);
app.use('/', counselorRoutes);
app.use('/', studentRoutes);
app.use('/', visitorLogRoutes);
app.use('/', countryRoutes);
app.use('/', universityRoutes);
app.use('/', intakeRoutes);
app.use('/', ApplicationRoutes);
app.use('/', VisaRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

export default app;
