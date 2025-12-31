import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Server is working!');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Working!' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});