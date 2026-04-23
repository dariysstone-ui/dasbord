// api/index.js — Vercel Serverless Function
// Fetches CSV files from GitHub Releases, aggregates on server, returns dashboard JSON.
// Supports multi-year queries (e.g. main=2026, comp=2025 → fetches both files).
//
// GitHub Release structure:
//   Tag:  data-2025  →  file: 2025.csv
//   Tag:  data-2026  →  file: 2026.csv
//
// Required env vars in Vercel:
//   GITHUB_OWNER  — your GitHub username, e.g. "myusername"
//   GITHUB_REPO   — repository name, e.g. "dashboard"
//   GITHUB_TOKEN  — personal access token (Settings → Developer settings → PAT)
//                   Needs only "public_repo" scope. Avoids rate limits (60 req/hr anon).

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { start, end, compStart, compEnd, omsuFilter = [] } = req.body;
    if (!start || !end || !compStart || !compEnd) {
      return res.status(400).json({ error: 'Заполните все 4 поля с датами' });
    }

    const OWNER = process.env.GITHUB_OWNER;
    const REPO  = process.env.GITHUB_REPO;
    const TOKEN = process.env.GITHUB_TOKEN; // optional but recommended

    if (!OWNER || !REPO) {
      return res.status(500).json({ error: 'GITHUB_OWNER и GITHUB_REPO не настроены' });
    }

    // URL for GitHub Releases asset: data-{year} tag, file {year}.csv
    const csvUrl = (year) =>
      `https://github.com/${OWNER}/${REPO}/releases/download/data-${year}/${year}.csv`;

    // Determine which year files we need
    const yearsNeeded = new Set();
    const addYears = (s, e) => {
      const y1 = parseInt(s.slice(0, 4)), y2 = parseInt(e.slice(0, 4));
      for (let y = y1; y <= y2; y++) yearsNeeded.add(y);
    };
    addYears(start, end);
    addYears(compStart, compEnd);

    // Fetch and parse all needed CSV files in parallel
    const yearData = {};
    await Promise.all([...yearsNeeded].map(async (year) => {
      const url = csvUrl(year);
      const headers = TOKEN
        ? { Authorization: `token ${TOKEN}`, Accept: 'application/octet-stream' }
        : { Accept: 'application/octet-stream' };

      const resp = await fetch(url, { headers, redirect: 'follow' });
      if (!resp.ok) {
        if (resp.status === 404) {
          console.warn(`${year}.csv not found (tag: data-${year})`);
          yearData[year] = [];
          return;
        }
        throw new Error(`Ошибка загрузки ${year}.csv: ${resp.status}`);
      }
      const text = await resp.text();
      yearData[year] = parseCSV(text);
      console.log(`Loaded ${year}.csv: ${yearData[year].length} rows`);
    }));

    // Merge all rows into one flat array
    const allRows = Object.values(yearData).flat();

    // Aggregate
    const mainGroups = aggregate(allRows, start, end, omsuFilter);
    const compGroups = aggregate(allRows, compStart, compEnd, omsuFilter);
    const dashboardData = processDashboardData(mainGroups, compGroups);

    // Daily counts for sparkline (main period only)
    const daily = buildDaily(allRows, start, end, omsuFilter);

    return res.status(200).json({
      data: dashboardData,
      daily,
      yearsLoaded: [...yearsNeeded],
      counts: {
        main: allRows.filter(r => inRange(r, start, end, omsuFilter)).length,
        comp: allRows.filter(r => inRange(r, compStart, compEnd, omsuFilter)).length,
      }
    });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
}

// ─── CSV Parser (handles semicolon delimiter, quoted multiline fields) ───
function parseCSV(text) {
  const rows = [];
  let headers = null;
  let colIdx = {};
  let delim = ';';
  let inQ = false, field = '', fields = [];

  const commitField = () => { fields.push(inQ ? field : field.trim()); field = ''; inQ = false; };
  const commitRow = () => {
    const row = fields; fields = [];
    if (!row.length || (row.length === 1 && !row[0])) return;
    if (!headers) {
      // Auto-detect delimiter
      if (row.length === 1 && row[0].includes(',')) {
        delim = ',';
        const reVals = row[0].split(',').map(h => h.replace(/^\uFEFF/, '').trim());
        headers = reVals;
      } else {
        headers = row.map(h => h.replace(/^\uFEFF/, '').trim());
      }
      headers.forEach((h, i) => colIdx[h] = i);
      return;
    }
    const obj = {};
    headers.forEach((h, i) => obj[h] = (row[i] || '').trim());
    rows.push(obj);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"' && field === '') inQ = true;
      else if (ch === delim) commitField();
      else if (ch === '\n') { commitField(); commitRow(); }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field || fields.length) { commitField(); commitRow(); }
  return rows;
}

// ─── Date helper ───
function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function inRange(row, start, end, omsuFilter) {
  const date = parseDate(row['Дата (первого взятия в работу)']);
  if (!date || date < start || date > end) return false;
  if (omsuFilter.length > 0 && !omsuFilter.includes((row['ОМСУ'] || '').trim())) return false;
  return true;
}

// ─── Aggregation ───
function aggregate(rows, start, end, omsuFilter) {
  const groups = {};
  for (const row of rows) {
    if (!inRange(row, start, end, omsuFilter)) continue;
    const sg   = row['Синт. группа']?.trim() || 'Без группы';
    const sub  = row['Подтема']?.trim()      || 'Нет';
    const fact = row['Факт']?.trim()         || 'Нет';
    const omsu = row['ОМСУ']?.trim()         || 'Нет';
    const mail = (row['Почта заявителя'] || '').trim().toLowerCase();
    const addr = row['Адрес']?.trim()        || '';
    const street = row['Улица']?.trim()      || '';

    if (!groups[sg]) groups[sg] = { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
    const g = groups[sg];
    g.total++;

    if (!g.sub[sub]) g.sub[sub] = { count: 0, facts: {} };
    g.sub[sub].count++;
    g.sub[sub].facts[fact] = (g.sub[sub].facts[fact] || 0) + 1;

    if (!g.omsu[omsu]) g.omsu[omsu] = { c: 0, subs: {} };
    g.omsu[omsu].c++;
    g.omsu[omsu].subs[sub] = (g.omsu[omsu].subs[sub] || 0) + 1;

    if (!g.fact[fact]) g.fact[fact] = { count: 0 };
    g.fact[fact].count++;

    if (mail && mail !== 'нет' && mail.includes('@')) {
      if (!g.mail[mail]) g.mail[mail] = { c: 0, facts: {}, omsus: new Set() };
      g.mail[mail].c++;
      g.mail[mail].facts[fact] = (g.mail[mail].facts[fact] || 0) + 1;
      if (omsu !== 'Нет') g.mail[mail].omsus.add(omsu);
    }

    if (street && addr) {
      if (!g.addr[addr]) g.addr[addr] = { c: 0, subs: {} };
      g.addr[addr].c++;
      g.addr[addr].subs[sub] = (g.addr[addr].subs[sub] || 0) + 1;
    }
  }
  return groups;
}

function buildDaily(rows, start, end, omsuFilter) {
  const daily = {};
  for (const row of rows) {
    if (!inRange(row, start, end, omsuFilter)) continue;
    const date = parseDate(row['Дата (первого взятия в работу)']);
    const sg = row['Синт. группа']?.trim() || 'Без группы';
    if (!daily[date]) daily[date] = {};
    daily[date][sg] = (daily[date][sg] || 0) + 1;
  }
  return daily;
}

// ─── Process into dashboard format ───
function processDashboardData(main, comp) {
  const result = [];
  const dyn = (v, cv) => {
    const diff = v - cv;
    return { pct: cv === 0 ? (v > 0 ? 100 : 0) : Math.round((diff / cv) * 100), abs: diff };
  };

  for (const [name, m] of Object.entries(main)) {
    const c = comp[name] || { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
    const entry = { name, total: m.total, compTotal: c.total, subs: [], facts: [], omsus: [], mails: [], addrs: [] };

    Object.entries(m.sub).sort((a, b) => b[1].count - a[1].count).forEach(([k, v]) => {
      const { pct, abs } = dyn(v.count, c.sub[k]?.count || 0);
      entry.subs.push({ name: k, count: v.count, pctGroup: Math.round((v.count / m.total) * 100), dynPct: pct, dynAbs: abs, facts: Object.entries(v.facts).sort((a, b) => b[1] - a[1]) });
    });
    Object.entries(m.fact).sort((a, b) => b[1].count - a[1].count).forEach(([k, v]) => {
      const { pct, abs } = dyn(v.count, c.fact[k]?.count || 0);
      entry.facts.push({ name: k, count: v.count, dynPct: pct, dynAbs: abs });
    });
    Object.entries(m.omsu).sort((a, b) => b[1].c - a[1].c).forEach(([k, d]) => {
      const { pct, abs } = dyn(d.c, c.omsu[k]?.c || 0);
      const ss = Object.entries(d.subs).sort((a, b) => b[1] - a[1]);
      entry.omsus.push({ name: k, count: d.c, dynPct: pct, dynAbs: abs, mainSub: ss[0]?.[0] || '-', mainSubCnt: ss[0]?.[1] || 0, mainSubPct: d.c > 0 ? Math.round((ss[0]?.[1] || 0) / d.c * 100) : 0 });
    });
    Object.entries(m.mail).sort((a, b) => b[1].c - a[1].c).forEach(([k, d]) => {
      entry.mails.push({ email: k, count: d.c, facts: Object.entries(d.facts).sort((a, b) => b[1] - a[1]), omsus: [...d.omsus] });
    });
    Object.entries(m.addr).sort((a, b) => b[1].c - a[1].c).forEach(([k, d]) => {
      const ss = Object.entries(d.subs).sort((a, b) => b[1] - a[1]);
      entry.addrs.push({ address: k, count: d.c, mainSub: ss[0]?.[0] || '-', mainSubCnt: ss[0]?.[1] || 0, mainSubPct: d.c > 0 ? Math.round((ss[0]?.[1] || 0) / d.c * 100) : 0 });
    });
    result.push(entry);
  }
  return result.sort((a, b) => b.total - a.total);
}
