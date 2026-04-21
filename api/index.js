export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  async function fetchWithRetry(url, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) return response;
        if (response.status === 503 || response.status === 429) {
          const waitTime = delay * Math.pow(2, i);
          console.log(`Retry ${i + 1}/${retries} after ${waitTime}ms (status: ${response.status})`);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
        const errorText = await response.text();
        throw new Error(`Google Sheets API error ${response.status}: ${errorText.substring(0, 200)}`);
      } catch (error) {
        if (i === retries - 1) throw error;
        console.log(`Request failed, retrying (${i + 1}/${retries}):`, error.message);
        await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
      }
    }
  }

  try {
    const { start, end, compStart, compEnd, omsuFilter = [] } = req.body;
    
    if (!start || !end || !compStart || !compEnd) {
      return res.status(400).json({ error: 'Заполните все 4 поля с датами' });
    }

    const SHEET_ID = process.env.SHEET_ID;
    const API_KEY = process.env.GOOGLE_API_KEY;
    
    if (!SHEET_ID || !API_KEY) {
      return res.status(500).json({ error: 'Не настроены переменные окружения', hasSheetId: !!SHEET_ID, hasApiKey: !!API_KEY });
    }

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?key=${API_KEY}`;
    const metaResponse = await fetchWithRetry(metaUrl);
    if (!metaResponse.ok) throw new Error(`Ошибка метаданных: ${metaResponse.status}`);
    
    const metadata = await metaResponse.json();
    const sheetName = metadata.sheets?.[0]?.properties?.title || 'Лист1';
    const RANGE = `${sheetName}!A:Z`;

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${RANGE}?key=${API_KEY}`;
    const response = await fetchWithRetry(url);
    const data = await response.json();
    
    if (!data.values || data.values.length < 2) {
      return res.status(400).json({ error: 'Таблица пуста или содержит только заголовки', rowCount: data.values?.length || 0 });
    }

    const headers = data.values[0].map(h => String(h || '').trim());
    const rows = data.values.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(row[i] || '').trim(); });
      return obj;
    });

    const parseDate = (val) => {
      if (!val) return null;
      let d = val instanceof Date ? val : new Date(val);
      return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    };

    const filter = (data, start, end, omsuFilter = []) => {
      return data.filter(r => {
        const date = parseDate(r['Дата (первого взятия в работу)']);
        if (!date || date < start || date > end) return false;
        const omsu = (r['ОМСУ'] || '').trim();
        if (omsuFilter.length > 0 && !omsuFilter.includes(omsu)) return false;
        return true;
      });
    };

    // === ОБНОВЛЕННАЯ АГРЕГАЦИЯ ДЛЯ GOOGLE SHEETS ===
    const aggregateData = (data) => {
      const groups = {};
      data.forEach(row => {
        const sg = (row['Синт. группа'] || '').trim() || 'Без группы';
        if (!groups[sg]) groups[sg] = { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
        groups[sg].total++;

        const sub = (row['Подтема'] || '').trim() || 'Нет';
        // Sub теперь объект { count, facts }
        if (!groups[sg].sub[sub]) groups[sg].sub[sub] = { count: 0, facts: {} };
        groups[sg].sub[sub].count++;
        
        const fact = (row['Факт'] || '').trim() || 'Нет';
        groups[sg].sub[sub].facts[fact] = (groups[sg].sub[sub].facts[fact] || 0) + 1;

        const omsu = (row['ОМСУ'] || '').trim() || 'Нет';
        if (!groups[sg].omsu[omsu]) groups[sg].omsu[omsu] = { c: 0, subs: {} };
        groups[sg].omsu[omsu].c++;
        groups[sg].omsu[omsu].subs[sub] = (groups[sg].omsu[omsu].subs[sub] || 0) + 1;

        if (!groups[sg].fact[fact]) groups[sg].fact[fact] = { count: 0 };
        groups[sg].fact[fact].count++;

        const mail = ((row['Почта заявителя'] || '').trim()).toLowerCase();
        if (mail && mail !== 'нет') {
          if (!groups[sg].mail[mail]) groups[sg].mail[mail] = { c: 0, facts: {}, omsus: new Set() };
          groups[sg].mail[mail].c++;
          groups[sg].mail[mail].facts[fact] = (groups[sg].mail[mail].facts[fact] || 0) + 1;
          if (omsu && omsu !== 'Нет') groups[sg].mail[mail].omsus.add(omsu);
        }

        const fullAddr = (row['Адрес'] || '').trim();
        const street = (row['Улица'] || '').trim();
        if (street && fullAddr) {
          if (!groups[sg].addr[fullAddr]) groups[sg].addr[fullAddr] = { c: 0, subs: {} };
          groups[sg].addr[fullAddr].c++;
          groups[sg].addr[fullAddr].subs[sub] = (groups[sg].addr[fullAddr].subs[sub] || 0) + 1;
        }
      });
      return groups;
    };

    const processDashboardData = (main, comp) => {
      const result = [];
      for (const [name, m] of Object.entries(main)) {
        const c = comp[name] || { total: 0, sub: {}, omsu: {}, fact: {}, mail: {}, addr: {} };
        const entry = { name, total: m.total, compTotal: c.total, subs: [], facts: [], omsus: [], mails: [], addrs: [] };

        // Подтемы с фактами
        Object.entries(m.sub).sort((a,b)=>b[1].count-a[1].count).slice(0,5).forEach(([k,v]) => {
          const cv = c.sub[k]?.count || 0;
          const diff = v.count - cv;
          const pct = cv === 0 ? (v.count>0?100:0) : Math.round((diff/cv)*100);
          entry.subs.push({ 
            name: k, 
            count: v.count, 
            pctGroup: Math.round((v.count/m.total)*100), 
            dynPct: pct, 
            dynAbs: diff,
            facts: Object.entries(v.facts).sort((a,b)=>b[1]-a[1])
          });
        });

        Object.entries(m.fact).sort((a,b)=>b[1].count-a[1].count).slice(0,5).forEach(([k,v]) => {
          const cv = c.fact[k]?.count || 0;
          const diff = v.count - cv;
          const pct = cv === 0 ? (v.count>0?100:0) : Math.round((diff/cv)*100);
          entry.facts.push({ name: k, count: v.count, dynPct: pct, dynAbs: diff });
        });

        Object.entries(m.omsu).sort((a,b)=>b[1].c-a[1].c).slice(0,10).forEach(([k,d]) => {
          const cv = c.omsu[k]?.c || 0;
          const diff = d.c - cv;
          const pct = cv === 0 ? (d.c>0?100:0) : Math.round((diff/cv)*100);
          const sortedSubs = Object.entries(d.subs).sort((a,b)=>b[1]-a[1]);
          const mainSt = sortedSubs[0]?.[0] || '-';
          const mainStCnt = sortedSubs[0]?.[1] || 0;
          const stPct = d.c > 0 ? Math.round((mainStCnt / d.c) * 100) : 0;
          entry.omsus.push({ name: k, count: d.c, dynPct: pct, dynAbs: diff, mainSub: mainSt, mainSubCnt: mainStCnt, mainSubPct: stPct });
        });

        Object.entries(m.mail).sort((a,b)=>b[1].c-a[1].c).slice(0,10).forEach(([k,d]) => {
          entry.mails.push({ email: k, count: d.c, facts: Object.entries(d.facts).sort((a,b)=>b[1]-a[1]), omsus: Array.from(d.omsus) });
        });

        Object.entries(m.addr).sort((a,b)=>b[1].c-a[1].c).slice(0,10).forEach(([k,d]) => {
          const sortedSubs = Object.entries(d.subs).sort((a,b)=>b[1]-a[1]);
          const mainSt = sortedSubs[0]?.[0] || '-';
          const mainStCnt = sortedSubs[0]?.[1] || 0;
          const stPct = d.c > 0 ? Math.round((mainStCnt / d.c) * 100) : 0;
          entry.addrs.push({ address: k, count: d.c, mainSub: mainSt, mainSubCnt: mainStCnt, mainSubPct: stPct });
        });

        result.push(entry);
      }
      return result.sort((a,b) => b.total - a.total);
    };

    const mainData = filter(rows, start, end, omsuFilter);
    const compData = filter(rows, compStart, compEnd, omsuFilter);
    
    const statsMain = aggregateData(mainData);
    const statsComp = aggregateData(compData);
    
    const dashboardData = processDashboardData(statsMain, statsComp);

    return res.status(200).json({ 
      data: dashboardData, 
      counts: [mainData.length, compData.length],
      rawData: rows.filter(r => {
        const date = parseDate(r['Дата (первого взятия в работу)']);
        return date && date >= start && date <= end && 
               (omsuFilter.length === 0 || omsuFilter.includes((r['ОМСУ'] || '').trim()));
      })
    });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
}
