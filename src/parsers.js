import * as cheerio from 'cheerio';

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function tableCells($table) {
  const out = [];
  $table.find('tr').each((_, tr) => {
    const cells = $table.find(tr).children('th, td').map((_, td) => clean($table.find(td).text())).get();
    if (cells.length) out.push(cells);
  });
  return out;
}

// First table whose text contains every needle, else null.
function findTable(html, contains) {
  const $ = cheerio.load(html);
  let best = null;
  let bestLen = Infinity;
  $('table').each((_, tbl) => {
    const txt = clean($(tbl).text());
    if (contains.every((c) => txt.toLowerCase().includes(c.toLowerCase()))) {
      const len = txt.length;
      // Prefer the innermost table that actually holds the data grid.
      if (len < bestLen) {
        best = tbl;
        bestLen = len;
      }
    }
  });
  return best ? $(best) : null;
}

// Turn a generic 2-column key/value table into an object.
function kvTable($table) {
  const kv = {};
  tableCells($table).forEach((cells) => {
    if (cells.length === 2) {
      const k = cells[0].replace(/:$/, '').trim();
      if (k && k.length < 60) kv[k] = cells[1];
    } else if (cells.length > 2) {
      // odd-length key/value rows (e.g. label, value, label, value)
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const k = cells[i].replace(/:$/, '').trim();
        if (k && k.length < 60 && !kv[k]) kv[k] = cells[i + 1];
      }
    }
  });
  return kv;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract `label : value` where the body text is collapsed to single spaces.
// The value runs until the next known label, a double space, or end of string.
function regexValue(body, label, otherLabels = []) {
  const start = body.search(new RegExp(escapeReg(label) + '\\s*:?\\s', 'i'));
  if (start < 0) return null;
  let valueStart = body.slice(start + label.length).search(/\S/) + start + label.length;
  if (body.slice(start, start + label.length + 2).includes(':')) {
    valueStart = start + label.length + body.slice(start + label.length).search(/\S/) + 1;
  }
  let end = body.length;
  for (const other of otherLabels) {
    if (other.toLowerCase() === label.toLowerCase()) continue;
    const idx = body.toLowerCase().indexOf(other.toLowerCase(), valueStart + 1);
    if (idx >= 0 && idx < end) end = idx;
  }
  const doubleSpace = body.indexOf('  ', valueStart);
  if (doubleSpace >= 0 && doubleSpace < end) end = doubleSpace;
  return body.slice(valueStart, end).trim();
}

export function parseProfile(html) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const kv = {};
  // The profile page renders label/value rows as <b>label</b><span>value</span>
  $('div.row, div.col-sm-4, div.col-sm-8').each((_, el) => {
    const b = $(el).find('b').first().text().replace(/:$/, '').trim();
    if (!b || b.length > 40) return;
    const span = $(el).find('span').first().text().trim();
    if (span) kv[b] = span;
  });
  const infoTable = findTable(html, ['UID', 'Name']);
  if (infoTable) Object.assign(kv, kvTable(infoTable));
  // Only fall back to text regex for unambiguous top-level labels.
  for (const label of ['UID', 'Name', 'CGPA', 'SGPA', 'Result Type']) {
    const v = regexValue(body, label, []);
    if (v && !kv[label]) kv[label] = v;
  }

  const sections = {};
  const sectionNames = ['Qualification Details', 'Contact Details', 'Student Mentor Details', 'Suspension Details', 'Facilities Availed'];
  for (const name of sectionNames) {
    const t = findTable(html, [name.replace(' Details', '')]);
    if (t) sections[name] = tableCells(t);
  }

  const mentor = {};
  const mentorTable = findTable(html, ['Mentor Name', 'MentorId']);
  if (mentorTable) {
    const rows = tableCells(mentorTable);
    if (rows[0]) {
      const head = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, ''));
      const data = rows[1] || [];
      head.forEach((h, i) => { if (data[i]) mentor[h] = data[i]; });
    }
  }

  let photo = null;
  $('img').each((_, img) => {
    const src = $(img).attr('src') || '';
    if (/^data:image\//.test(src)) photo = src;
  });

  const name = kv['Name'] || kv['Student Name'] || kv['Student'] || '';
  let email = '';
  let mobile = '';
  const contactTable = findTable(html, ['Contact Type', 'EmailId']);
  if (contactTable) {
    const rows = tableCells(contactTable);
    if (rows[0]) {
      const head = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, ''));
      rows.slice(1).forEach((r) => {
        head.forEach((h, i) => {
          const val = r[i] || '';
          if (h.includes('email') && val && !email) email = val;
          if (h.includes('mobile') && val && !mobile) mobile = val;
        });
      });
    }
  }
  if (!email && body.includes('EmailId:')) email = (body.match(/EmailId:\s*([^\s]+@[^\s]+)/i) || [])[1] || '';
  return {
    kv,
    name,
    uid: kv['UID'] || '',
    sections,
    mentor,
    photo,
    email,
    mobile,
  };
}

export function parseCourses(html) {
  const $ = cheerio.load(html);
  const tbl = findTable(html, ['Course Code', 'Course Name']) || findTable(html, ['Course Code', 'Course']);
  const courses = [];
  if (tbl) {
    const rows = tableCells(tbl);
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.some((c) => /course\s*code/i.test(c)) && r.some((c) => /course\s*name/i.test(c))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) headerIdx = 0;
    // Iterate raw <tr> elements so cell values and the row's download button
    // stay aligned even if some rows have no cells.
    const $trs = tbl.find('tr').toArray();
    $trs.forEach((trEl, trIdx) => {
      if (trIdx <= headerIdx) return;
      const $tr = $(trEl);
      const cells = $tr.children('th, td').map((_, td) => clean($(td).text())).get();
      if (cells.length < 2) return;
      const code = cells[0] && !/download|view|pdf/i.test(cells[0]) ? cells[0] : '';
      // The "Download PDF" lecture-plan button is a __doPostBack link in the row.
      let lecturePlanTarget = '';
      $tr.find('a').each((_, a) => {
        if (/download\s*pdf/i.test(clean($(a).text()))) {
          lecturePlanTarget = postBackTarget($(a).attr('href'));
        }
      });
      courses.push({
        code: code || cells[1] || '',
        name: cells[1] || '',
        section: cells[2] || '',
        type: cells[3] || '',
        lecturePlan: cells[4] || '',
        lecturePlanTarget,
      });
    });
    // Sometimes the code is missing; fall back to dropping the "My Courses" title row.
    if (courses.length && !courses[0].code && rows[headerIdx + 1]) {
      const c = courses[0];
      c.code = rows[headerIdx + 1][0] || '';
    }
  }
  return { courses, count: courses.length };
}

export function parseTimetable(html) {
  const $ = cheerio.load(html);
  const tables = [];
  $('table').each((_, tbl) => {
    const $t = $(tbl);
    const cells = tableCells($t);
    if (!cells.length) return;
    const headers = cells[0].map((h) => clean(h));
    const isGrid = headers.some((h) => /^(time|period|slot)/i.test(h)) ||
      headers.some((h) => /^(mon|tue|wed|thu|fri|sat|sun)/i.test(h));
    if (!isGrid) return;
    tables.push({ headers, rows: cells.slice(1).filter((r) => r.length > 1) });
  });
  // Also capture the course/title reference table that CUIMS shows with the grid.
  const ref = findTable(html, ['Course Code', 'Title']) || findTable(html, ['Course Code', 'Course Name']);
  const courseMap = {};
  if (ref) {
    tableCells(ref).forEach((r, i) => {
      if (i === 0 || r.length < 2) return;
      courseMap[r[0]] = r[1];
    });
  }
  return { tables, courseMap };
}

export function parseResult(html) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const info = {};
  const resultLabels = ['UID', 'Name', "Father's Name", "Mother's Name", 'CGPA', 'SGPA', 'Result Type', 'Session'];
  for (const label of resultLabels) {
    const v = regexValue(body, label, resultLabels);
    if (v) info[label] = v;
  }
  // Tidy values that swallowed extra text.
  if (info.SGPA) info.SGPA = (info.SGPA.match(/^\d+(\.\d+)?/) || [])[0] || info.SGPA;
  if (info.CGPA) info.CGPA = (info.CGPA.match(/^\d+(\.\d+)?/) || [])[0] || info.CGPA;
  if (info.Session) info.Session = info.Session.replace(/SubjectCode.*$/i, '').trim();

  const semesters = [];
  const grid = $('table').filter((_, t) => {
    const $t = $(t);
    return $t.find('span[id*="lblSem"]').length > 0 || /dlResult/.test($t.attr('id') || '');
  }).first();
  if (grid.length) {
    grid.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const semId = ($tr.find('span[id*="lblSem"]').attr('id') || '').match(/lblSem_(\d+)/);
      const semEl = $tr.find('span[id*="lblSem"]').first();
      const semester = semId ? (semId[1] === '' ? semEl.text().trim() : semEl.text().trim()) : '';
      const blockText = clean($tr.text());
      const sgpaM = blockText.match(/SGPA\s*:?\s*([\d.]+)/i);
      const sgpa = sgpaM ? sgpaM[1] : '';
      const $inner = $tr.find('table').first();
      if (!$inner.length) return;
      const txt = clean($inner.text());
      if (!/(subject code|grade)/i.test(txt)) return;
      const rows = tableCells($inner);
      const subjects = rows.filter((r) => r.length >= 3 && !/subject code/i.test(clean(r.join(' ')))).map((r) => ({
        code: r[0],
        name: r[1],
        credits: r[2],
        grade: r[3] || '',
        marks: r[4] || '',
      }));
      if (!subjects.length) return;
      semesters.push({
        semester: semester || semesters.length + 1,
        sgpa,
        header: [],
        subjects,
        credits: subjects.reduce((a, s) => a + (parseFloat(s.credits) || 0), 0),
      });
    });
  }

  return { info, semesters, semesterCount: semesters.length };
}

export function parseAttendance(html) {
  const $ = cheerio.load(html);
  const tbl = findTable(html, ['Course', '%']) || findTable(html, ['Attendance', '%']) || findTable(html, ['Held', 'Attended']) || $('table').first();
  const rows = [];
  if (!tbl || !tbl.length) return { rows, count: 0 };

  const cells = tableCells(tbl);
  if (!cells.length) return { rows, count: 0 };

  // Locate a header row so we can map columns reliably (CUIMS grids often merge cells).
  let headerIdx = -1;
  let header = [];
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i];
    const text = r.join(' ').toLowerCase();
    if (/(subject|course|held|attended|%|percentage)/.test(text) && r.length >= 3) {
      headerIdx = i;
      header = r.map((h) => h.toLowerCase());
      break;
    }
  }

  const col = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const dataRows = headerIdx >= 0 ? cells.slice(headerIdx + 1) : cells.slice(1);
  for (const r of dataRows) {
    if (r.length < 2) continue;
    const joined = clean(r.join(' '));
    if (/^(s\.?no|subject|course|%|held|attended|sl\.?)/i.test(joined) || !/\S/.test(joined)) continue;

    const pctIdx = r.findIndex((c) => /%/.test(c));
    const pctCell = pctIdx >= 0 ? r[pctIdx].replace('%', '') : '';

    let code = '';
    let name = '';
    let held = '';
    let attended = '';
    let percentage = pctCell;

    if (headerIdx >= 0) {
      const cIdx = col(['code', 'course']);
      const nIdx = col(['subject', 'name']);
      const hIdx = col(['held']);
      const aIdx = col(['attend']);
      const pIdx = col(['%']);
      if (nIdx >= 0 && nIdx < r.length) name = r[nIdx];
      if (cIdx >= 0 && cIdx < r.length) code = r[cIdx];
      else if (/^[\w-]{5,}$/.test(r[0]) && !/[a-z]{3,}/.test(r[0])) code = r[0];
      if (hIdx >= 0 && hIdx < r.length) held = r[hIdx];
      if (aIdx >= 0 && aIdx < r.length) attended = r[aIdx];
      if (pIdx >= 0 && pIdx < r.length && r[pIdx]) percentage = r[pIdx].replace('%', '');
    } else {
      // Fallback: [code, name, held, attended, pct] ordering.
      const pctBefore = r.findIndex((c) => /%/.test(c));
      name = r[1] || r[0];
      code = /^[\w-]{4,}$/.test(r[0]) ? r[0] : '';
      if (pctBefore >= 2) {
        held = r[pctBefore - 2] || '';
        attended = r[pctBefore - 1] || '';
      } else {
        held = r[2] || '';
        attended = r[3] || '';
      }
    }

    if (!name && !code && !pctCell) continue;
    rows.push({
      code,
      name: name || code,
      held,
      attended,
      percentage,
      status: percentage ? (parseFloat(percentage) >= 75 ? 'OK' : 'Low') : '',
    });
  }
  return { rows, count: rows.length };
}

// Parser for the attendance AJAX PageMethod (GetReport) payload: an array of
// per-course records. Keeps the same row shape as parseAttendance() so the UI
// works unchanged, and adds the lecture/practical/tutorial breakdown.
export function parseAttendanceReport(rows) {
  const out = (rows || []).map((r) => {
    const held = r.Total_Delv ?? r.EligibilityDelivered ?? '';
    const attended = r.Total_Attd ?? r.EligibilityAttended ?? '';
    const percentage = r.TotalPercentage ?? r.EligibilityPercentage ?? '';
    // Keep the app's threshold semantics (below 75% = Low) consistent with the
    // Dashboard's "Below 75%" label; CUIMS's colorcode uses a different rule.
    // Courses with no lectures delivered yet get no status instead of "Low".
    const hasData = held && parseFloat(held) > 0;
    const pct = parseFloat(percentage);
    const status = !hasData || Number.isNaN(pct) ? '' : pct >= 75 ? 'OK' : 'Low';
    return {
      code: r.Code || '',
      name: r.Title || '',
      held,
      attended,
      percentage,
      status,
      semester: r.Semester,
      uid: r.UId,
      student: r.name,
      lecAttd: r.Lec_Attd, lecDelv: r.Lec_Delv, lecPerc: r.Lec_Perc,
      pracAttd: r.Prac_Attd, pracDelv: r.Prac_Delv, pracPerc: r.Prac_Perc,
      trlAttd: r.Trl_Attd, trlDelv: r.Trl_Delv, trlPerc: r.Trl_Perc,
      dutyLeaveNP: r.DutyLeave_N_P, dutyLeaveADL: r.DutyLeave_ADL,
      dutyLeaveOthers: r.DutyLeave_Others, medicalLeave: r.MedicalLeave,
      eligibleDelivered: r.EligibilityDelivered,
      eligibleAttended: r.EligibilityAttended,
      eligiblePercentage: r.EligibilityPercentage,
      colorcode: r.colorcode,
    };
  });
  return { rows: out, count: out.length };
}

export function parseFees(html) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const transactions = [];
  // Each payment row is its own <table> with date + reference + total + status.
  $('table').each((_, tbl) => {
    const $t = $(tbl);
    const txt = clean($t.text());
    if (!/(transaction ref|payment mode|total)/i.test(txt)) return;
    const dateM = txt.match(/^\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i) ||
      txt.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\b/i);
    const refNo = (txt.match(/Transaction REF NO:\s*([A-Z0-9-]+)/i) || [])[1] || '';
    const bankRef = (txt.match(/BANK REF NO:\s*([\w-]+)/i) || [])[1] || '';
    const mode = (txt.match(/PAYMENT MODE:\s*([^T]+?)(?:\s+)?(?:GATEWAY|Total|$)/i) || [])[1] || '';
    const total = (txt.match(/Total:\s*(Rs\.?\s*[\d.,]+)/i) || [])[1] || '';
    const status = /SUCCESS/i.test(txt) ? 'SUCCESS' : (/FAILED/i.test(txt) ? 'FAILED' : '');
    if (!refNo && !status) return;
    transactions.push({ date: dateM ? dateM[1] : '', refNo, bankRef, mode: mode.trim(), total, status });
  });

  const summary = {};
  const mAmount = body.match(/Payment Amount:\s*([\s\S]{0,40}?)(?:Transaction Id:|$)/i);
  if (mAmount) summary.paymentAmount = clean(mAmount[1]);
  const mTxnId = body.match(/Transaction Id:\s*([\s\S]{0,40}?)(?:Transaction Date:|$)/i);
  if (mTxnId) summary.transactionId = clean(mTxnId[1]);

  const paid = transactions.filter((t) => t.status === 'SUCCESS');
  const totalPaid = paid.reduce((a, t) => {
    const m = t.total.match(/[\d.]+/);
    return a + (m ? parseFloat(m[0]) : 0);
  }, 0);

  return { transactions, summary, totalPaid, count: transactions.length };
}

// Extract the __doPostBack('EVENTTARGET','arg') target from a JS href.
function postBackTarget(href) {
  const m = String(href || '').match(/__doPostBack\(\s*'([^']+)'/);
  return m ? m[1] : '';
}

export function parseReceipts(html) {
  const $ = cheerio.load(html);
  const tbl = findTable(html, ['Receipt No', 'Receipt Date']) || findTable(html, ['Receipt']);
  const receipts = [];
  if (tbl) {
    tableCells(tbl).forEach((cells, i) => {
      if (i === 0) return;
      if (cells.length < 2) return;
      const href = $(tbl).find('tr').eq(i).find('a').attr('href') || '';
      const target = postBackTarget(href);
      receipts.push({
        financialYear: cells[0],
        receiptNo: cells[1],
        receiptDate: cells[2] || '',
        download: href,
        downloadTarget: target,
      });
    });
  }
  return { receipts, count: receipts.length };
}

export function parseDatesheet(html) {
  const $ = cheerio.load(html);
  const tables = [];
  $('table').each((_, tbl) => {
    const $t = $(tbl);
    const rows = tableCells($t);
    if (rows.length < 2) return;
    const headers = rows[0];
    if (!headers.some((h) => /(date|exam|subject|course|time|day|paper)/i.test(h))) return;
    tables.push({ headers, rows: rows.slice(1) });
  });
  return { tables, count: tables.length };
}

export function parseExamForms(html) {
  return parseDatesheet(html);
}

export function parseMarks(html) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const tables = [];
  $('table').each((_, tbl) => {
    const $t = $(tbl);
    const rows = tableCells($t);
    if (rows.length < 2) return;
    const headers = rows[0];
    if (!headers.some((h) => /(subject|marks|grade|credit|internal|theory)/i.test(h))) return;
    tables.push({ headers, rows: rows.slice(1) });
  });
  return { tables, count: tables.length, raw: body.slice(0, 500) };
}

export function parseAnnouncements(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('tr, li, .announcement, .item').each((_, el) => {
    const txt = clean($(el).text());
    if (txt.length > 4 && !/^(loading|ok|cancel|title)/i.test(txt)) items.push(txt);
  });
  if (!items.length) {
    const body = $('body').text().replace(/\s+/g, ' ').trim();
    if (body) items.push(body);
  }
  return { items, count: items.length };
}

export function parseNotices(html) {
  const $ = cheerio.load(html);
  const items = [];
  // Announcements render inside a dedicated container (empty until AJAX fills it).
  const container = $('#divAnnouncements, #Announcementscroll, [class*="announcement"], [class*="notice"]').first();
  const scope = container.length ? container : $('body');
  scope.find('li, .item, .announcement, [class*="notice-item"]').each((_, el) => {
    const txt = clean($(el).text());
    if (txt.length > 4 && !/loading|announcement/i.test(txt)) items.push(txt);
  });
  return { items, count: items.length };
}

// ---------- CUMAIL ----------
// The student home page carries the university Outlook email + one-time password
// inside a #divUniEmail block.
export function parseCumail(html) {
  const $ = cheerio.load(html);
  const el = $('#divUniEmail').first();
  if (!el.length) return { available: false };
  const text = el.text().replace(/\s+/g, ' ').trim();
  const email = (text.match(/EmailId:\s*([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/i) || [])[1] || '';
  const password = (text.match(/Password:\s*([^\s(]+)/i) || [])[1] || '';
  const name = (text.match(/Dear\s+([^,]+),/i) || [])[1] || '';
  const mailUrl = el.find('a[href]').first().attr('href') || '';
  return {
    available: true,
    name: name.trim(),
    email,
    password,
    mailUrl,
    note: 'This is a one-time password for your outlook ID. You need to use your changed password every time you log in to your account.',
  };
}

// ---------- LMS ----------
// The LMS SSO postback (ctl00$lbtnLMSSSO) redirects to the university LMS
// (lms.cuchd.in, Moodle-based) and drops session cookies in our jar. We parse
// the landing page for the dashboard data (site name, user, enrolled courses).
export function parseLmsHome(html) {
  const $ = cheerio.load(html);
  const siteName = $('title').first().text().replace(/\s+/g, ' ').trim() || 'CU LMS';
  // NOTE: do NOT select `.loggedin` — Moodle puts that class on <body>, so it
  // would return the entire page text. `.logininfo` is the real user element.
  const user = $('.logininfo, .usertext, .userfullname').first().text().replace(/\s+/g, ' ').trim();
  const courses = [];
  // Moodle course cards / lists link to /course/view.php?id=N
  $('a[href*="course/view.php"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const name = $(a).text().replace(/\s+/g, ' ').trim();
    if (!name) return;
    const id = (href.match(/[?&]id=(\d+)/) || [])[1] || '';
    if (!courses.some((c) => c.id === id)) courses.push({ id, name, href });
  });
  return { siteName, user, courses, count: courses.length };
}

// ---------- GENERIC SERVER-RENDERED PAGE PARSER ----------
// CUIMS renders most secondary pages as ASP.NET GridViews. This extracts every
// meaningful data grid (header row + data rows), skipping layout/toolbar tables.
export function parseGenericTables(html) {
  const $ = cheerio.load(html);
  const tables = [];
  const seen = new Set();
  $('table').each((_, tbl) => {
    const $t = $(tbl);
    const rows = tableCells($t);
    if (rows.length < 2) return;
    const headers = rows[0].map((h) => clean(h));
    // A plausible header row: short, non-empty cells and at least two columns.
    if (!headers.some((h) => h && h.length < 40)) return;
    if (headers.length < 2) return;
    // Skip obvious navigation/link tables.
    if (headers.every((h) => /^https?:|download|pdf|view$/i.test(h))) return;
    const dataRows = rows.slice(1).filter((r) => r.some((c) => /\S/.test(c)));
    if (!dataRows.length) return;
    const key = headers.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    tables.push({ headers, rows: dataRows });
  });
  return { tables, count: tables.length };
}

// Rewrite an LMS page so it works inside our iframe clone: rewrite absolute
// lms.cuchd.in links/assets to go through our proxy, and strip things that
// would break framing. baseUrl is the canonical LMS origin; token is the
// session token appended to rewritten URLs so the iframe can authenticate.
export function rewriteLmsHtml(html, baseUrl, token) {
  const $ = cheerio.load(html);
  // Kill meta refresh / JS redirects to the real host.
  $('meta[http-equiv="refresh"]').remove();
  $('script').each((_, s) => {
    const t = $(s).text() || '';
    if (/location\.(href|replace)\s*=|window\.location/.test(t)) {
      $(s).text('/* rewritten: redirect stripped */');
    }
  });
  const q = token ? '&t=' + encodeURIComponent(token) : '';
  const host = baseUrl.replace(/^https?:\/\//i, '');
  const rewrite = (el, attr) => {
    const v = $(el).attr(attr);
    if (!v) return;
    // Host-boundary matching: only rewrite when v is exactly baseUrl or starts
    // with baseUrl + '/' so lookalike hosts (lms.cuchd.in.evil.com) are skipped.
    if (v === baseUrl || v.startsWith(baseUrl + '/')) {
      $(el).attr(attr, '/api/lms/proxy?url=' + encodeURIComponent(v) + q);
    } else if (v === '//' + host || v.startsWith('//' + host + '/')) {
      // Protocol-relative assets (//lms.cuchd.in/...) must also go through the
      // proxy or the browser would fetch them without the LMS session.
      $(el).attr(attr, '/api/lms/proxy?url=' + encodeURIComponent('https:' + v) + q);
    } else if (v.startsWith('/') && !v.startsWith('//')) {
      $(el).attr(attr, '/api/lms/proxy?url=' + encodeURIComponent(baseUrl + v) + q);
    }
  };
  $('a[href]').each((_, el) => rewrite(el, 'href'));
  $('form[action]').each((_, el) => rewrite(el, 'action'));
  $('link[href]').each((_, el) => rewrite(el, 'href'));
  $('img[src]').each((_, el) => rewrite(el, 'src'));
  $('script[src]').each((_, el) => rewrite(el, 'src'));
  return $.html();
}
