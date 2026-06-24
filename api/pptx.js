// api/pptx.js — generates PPTX via Python script
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { title, period, rows } = req.body;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows' });

  const scriptPath = path.join(__dirname, '..', 'generate_pptx.py');
  const data = JSON.stringify({ title, period, rows });

  try {
    const pptxBuf = await new Promise((resolve, reject) => {
      const proc = execFile('python3', [scriptPath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(Buffer.from(stdout, 'binary'));
      });
      proc.stdin.write(data);
      proc.stdin.end();
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="Метрика_${period}.pptx"`);
    res.setHeader('Content-Length', pptxBuf.length);
    res.status(200).end(pptxBuf);
  } catch (err) {
    console.error('PPTX generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
