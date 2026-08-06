// server.js — основной Express сервер для Timeweb VPS
require('dotenv').config();
const express = require('express');
const path    = require('path');
const handler = require('./api/handler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(express.json({ limit: '2mb' }));

// ── Static files (HTML pages) ──
app.use(express.static(path.join(__dirname, 'public')));

// ── API endpoint ──
app.options('/api', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});
app.post('/api', handler);

// ── Page routes ──
const pages = ['report', 'sms', 'metrics', 'spravka'];
pages.forEach(p => {
  app.get(`/${p}`, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', `${p}.html`))
  );
});

// ── Root ──
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  console.log(`✅ Дашборд запущен: http://localhost:${PORT}`);
  console.log(`   GITHUB_OWNER: ${process.env.GITHUB_OWNER || '⚠️  не задан'}`);
  console.log(`   GITHUB_REPO:  ${process.env.GITHUB_REPO  || '⚠️  не задан'}`);
});
