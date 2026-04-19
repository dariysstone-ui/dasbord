// api/index.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { start, end, compStart, compEnd } = req.body;
    if (!start || !end || !compStart || !compEnd) {
      return res.status(400).json({ error: 'Заполните все 4 поля с датами' });
    }

    const SHEET_ID = process.env.SHEET_ID;
    const API_KEY = process.env.GOOGLE_API_KEY;
    const RANGE = 'Sheet1!A:Z';

    if (!SHEET_ID || !API_KEY) {
      return res.status(500).json({ error: 'Не настроены переменные окружения' });
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${RANGE}?key=${API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) throw new Error(`Ошибка Google Sheets: ${response.status}`);
    
    const data = await response.json();
    if (!data.values || data.values.length < 2) return res.status(400).json({ error: 'Таблица пуста' });

    const headers = data.values[0].map(h => h.trim());
    const rows = data.values.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = (row[i] || '').trim());
      return obj;
    });

    // --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
    const parseDate = (val) => {
      if (!val) return null;
      if (typeof val === 'string') {
        const m1 = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m1) return val;
        const m2 = val.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
      }
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    };

    const filter = (data, s, e) => data.filter(r => {
      const d = parseDate(r['Дата (первого взятия в работу)'] || r['Дата']);
      return d && d >= s && d <= e;
    });

    const buildStats = (data) => {
      const groups = {};
      data.forEach(r => {
        const sg = (r['Синт. группа'] || '').trim() || 'Без группы';
        if (!groups[sg]) groups[sg] = { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
        groups[sg].total++;

        const sub = (r['Подтема'] || '').trim() || 'Нет';
        groups[sg].sub[sub] = (groups[sg].sub[sub] || 0) + 1;

        const omsu = (r['ОМСУ'] || '').trim() || 'Нет';
        if (!groups[sg].omsu[omsu]) groups[sg].omsu[omsu] = { c: 0, subs: {} };
        groups[sg].omsu[omsu].c++;
        groups[sg].omsu[omsu].subs[sub] = (groups[sg].omsu[omsu].subs[sub] || 0) + 1;

        const fact = (r['Факт'] || '').trim() || 'Нет';
        groups[sg].fact[fact] = (groups[sg].fact[fact] || 0) + 1;

        // ИСПРАВЛЕННАЯ ЛОГИКА ДЛЯ ЗАЯВИТЕЛЕЙ
        const mail = ((r['Почта заявителя'] || '').trim()).toLowerCase();
        if (mail && mail !== 'нет') {
          if (!groups[sg].mail[mail]) groups[sg].mail[mail] = { c: 0, facts: {}, omsus: new Set() };
          groups[sg].mail[mail].c++;
          // Считаем факты заявителя
          groups[sg].mail[mail].facts[fact] = (groups[sg].mail[mail].facts[fact] || 0) + 1;
          // Сохраняем ОМСУ
          if (omsu !== 'Нет') groups[sg].mail[mail].omsus.add(omsu);
        }

        const fullAddr = (r['Адрес'] || '').trim();
        const street = (r['Улица'] || '').trim();
        if (street && fullAddr) {
          if (!groups[sg].addr[fullAddr]) groups[sg].addr[fullAddr] = { c: 0, subs: {} };
          groups[sg].addr[fullAddr].c++;
          groups[sg].addr[fullAddr].subs[sub] = (groups[sg].addr[fullAddr].subs[sub] || 0) + 1;
        }
      });
      return groups;
    };

    const getTop = (obj, n) => Object.entries(obj).sort((a, b) => b[1].c - a[1].c).slice(0, n);

    // --- ОСНОВНАЯ ЛОГИКА ---
    const mainData = filter(rows, start, end);
    const compData = filter(rows, compStart, compEnd);
    const statsMain = buildStats(mainData);
    const statsComp = buildStats(compData);

    const result = [];
    for (const [name, m] of Object.entries(statsMain)) {
      const c = statsComp[name] || { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
      const entry = { name, total: m.total, compTotal: c.total, subs: [], facts: [], omsus: [], mails: [], addrs: [] };

      // Топ-5 Подтем
      Object.entries(m.sub).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([k, v]) => {
        const cv = c.sub[k] || 0;
        const diff = v - cv;
        const pct = cv === 0 ? (v > 0 ? 100 : 0) : Math.round((diff / cv) * 100);
        entry.subs.push({ name: k, count: v, pctGroup: Math.round((v / m.total) * 100), dynPct: pct, dynAbs: diff });
      });

      // Топ-5 Фактов
      Object.entries(m.fact).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([k, v]) => {
        const cv = c.fact[k] || 0;
        const diff = v - cv;
        const pct = cv === 0 ? (v > 0 ? 100 : 0) : Math.round((diff / cv) * 100);
        entry.facts.push({ name: k, count: v, dynPct: pct, dynAbs: diff });
      });

      // Топ-10 ОМСУ
      Object.entries(m.omsu).sort((a, b) => b[1].c - a[1].c).slice(0, 10).forEach(([k, d]) => {
        const cv = c.omsu[k]?.c || 0;
        const diff = d.c - cv;
        const pct = cv === 0 ? (d.c > 0 ? 100 : 0) : Math.round((diff / cv) * 100);
        const sortedSubs = Object.entries(d.subs).sort((a, b) => b[1] - a[1]);
        const mainSt = sortedSubs[0]?.[0] || '-';
        const mainStCnt = sortedSubs[0]?.[1] || 0;
        const stPct = d.c > 0 ? Math.round((mainStCnt / d.c) * 100) : 0;
        entry.omsus.push({ name: k, count: d.c, dynPct: pct, dynAbs: diff, mainSub: mainSt, mainSubCnt: mainStCnt, mainSubPct: stPct });
      });

      // Топ-10 Заявителей (ИСПРАВЛЕНО)
      getTop(m.mail, 10).forEach(([k, d]) => {
        // Сортируем факты заявителя по убыванию
        const sortedFacts = Object.entries(d.facts).sort((a, b) => b[1] - a[1]);
        entry.mails.push({ 
          email: k, 
          count: d.c, 
          facts: sortedFacts,
          omsus: Array.from(d.omsus).slice(0, 3) // Первые 3 ОМСУ
        });
      });

      // Топ-10 Адресов
      Object.entries(m.addr).sort((a, b) => b[1].c - a[1].c).slice(0, 10).forEach(([k, d]) => {
        const sortedSubs = Object.entries(d.subs).sort((a, b) => b[1] - a[1]);
        const mainSt = sortedSubs[0]?.[0] || '-';
        const mainStCnt = sortedSubs[0]?.[1] || 0;
        const stPct = d.c > 0 ? Math.round((mainStCnt / d.c) * 100) : 0;
        entry.addrs.push({ address: k, count: d.c, mainSub: mainSt, mainSubCnt: mainStCnt, mainSubPct: stPct });
      });

      result.push(entry);
    }

    result.sort((a, b) => b.total - a.total);
    return res.status(200).json({ data: result, counts: [mainData.length, compData.length] });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
}
