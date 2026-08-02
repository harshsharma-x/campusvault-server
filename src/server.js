import express from 'express';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CuimsClient, extractViewState } from './cuimsClient.js';
import {
  parseProfile, parseCourses, parseTimetable, parseResult,
  parseAttendance, parseAttendanceReport, parseFees, parseReceipts, parseDatesheet,
  parseExamForms, parseMarks, parseAnnouncements, parseNotices,
  parseGenericTables, parseCumail, parseLmsHome, rewriteLmsHtml,
} from './parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DISCOVERY_PORT = Number(process.env.CV_DISCOVERY_PORT) || 3001;
// Live CUIMS only — demo mode has been removed entirely.

// LAN IPv4 addresses of this machine — the phone needs one of these to reach us.
function lanAddresses() {
  const out = [];
  for (const name of Object.values(os.networkInterfaces())) {
    for (const iface of name || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// ---- LAN discovery beacon (optional) ----
// The mobile app can't know the PC's LAN IP, so it broadcasts a UDP ping on
// port DISCOVERY_PORT and we reply with the reachable server URL. This lets a
// phone on the same Wi-Fi auto-connect without typing an IP. It is best-effort:
// in cloud environments (Render etc.) UDP may be blocked — we must never let a
// beacon failure take down the web server.
if (process.env.RENDER) {
  console.log('[discovery] skipping LAN beacon on Render (UDP not routable)');
} else try {
  const beacon = dgram.createSocket('udp4');
  beacon.on('message', (msg, rinfo) => {
    const text = String(msg).trim();
    if (!text.startsWith('CAMPUSVAULT_DISCOVER')) return;
    for (const ip of lanAddresses()) {
      const reply = Buffer.from(`CAMPUSVAULT:http://${ip}:${PORT}`);
      beacon.send(reply, rinfo.port, rinfo.address, (err) => {
        if (err) console.log('[discovery] send failed:', err.message);
      });
    }
    console.log(`[discovery] ping from ${rinfo.address}:${rinfo.port} -> replied with LAN URLs`);
  });
  beacon.on('error', (err) => console.log('[discovery] beacon error:', err.message));
  beacon.bind(DISCOVERY_PORT, () => {
    console.log(`LAN discovery beacon listening on UDP :${DISCOVERY_PORT}`);
    const ips = lanAddresses();
    if (ips.length) console.log(`On your phone, point the app at: http://${ips[0]}:${PORT}`);
  });
} catch (e) {
  console.log('[discovery] beacon unavailable in this environment:', e.message);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
// Form posts from the LMS clone iframe (Moodle forms) come urlencoded.
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Allow the Expo web preview (localhost:8081) and other dev origins to call the
// API — the mobile app's web build is served from a different port than the
// portal server. Permissive for dev; the portal's own web build is same-origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the built React app first, then fall back to the static public/ dir.
for (const dir of [path.join(__dirname, '..', 'web', 'dist'), path.join(__dirname, '..', 'public')]) {
  if (fs.existsSync(dir)) app.use(express.static(dir));
}

// In-memory session store: token -> { client, uid, name, status }
const sessions = new Map();

function newToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function getClient(token) {
  return sessions.get(token);
}

function extractLoginError(html) {
  const clean = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const swal = html.match(/swal\(\s*'Error!'\s*,\s*'([^']{2,80})'\s*,\s*'error'\s*\)/);
  if (swal) return swal[1];
  const patterns = [
    /Invalid\s+(Captcha|captcha)\b[^<\n]{0,80}/i,
    /Captcha\s+(?:is\s+)?(?:Incorrect|Invalid|Wrong|Mismatch)\b[^<\n]{0,80}/i,
    /(?:Wrong|Incorrect)\s+Captcha\b[^<\n]{0,80}/i,
    /Invalid\s+(Password|password|User\s*ID|UserID|Credentials|Login|Username)\b[^<\n]{0,80}/,
    /Password\s+(?:is\s+)?(?:Incorrect|Invalid|Wrong)\b[^<\n]{0,80}/i,
    /Invalid\s+Login\b[^<\n]{0,80}/i,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

function requireSession(req, res, next) {
  const token = req.headers['x-session-token'];
  const s = token ? getClient(token) : null;
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.session = s;
  next();
}

// The LMS clone iframe can't send custom headers, so its proxied URLs carry the
// token as ?t=. Only the /api/lms* routes accept query tokens (keeps tokens out
// of URLs everywhere else).
function requireLmsSession(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.t;
  const s = token ? getClient(token) : null;
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.session = s;
  next();
}

const DATA_ENDPOINTS = {
  profile: { url: 'https://students.cuchd.in/frmStudentProfile.aspx', parse: parseProfile },
  courses: { url: 'https://students.cuchd.in/frmMyCourse.aspx', parse: parseCourses },
  timetable: { url: 'https://students.cuchd.in/frmMyTimeTable.aspx', parse: parseTimetable },
  result: { url: 'https://students.cuchd.in/result.aspx', parse: parseResult },
  attendance: { url: 'https://students.cuchd.in/frmStudentCourseWiseAttendanceSummary.aspx', parse: parseAttendance, page: 'frmStudentCourseWiseAttendanceSummary.aspx' },
  fees: { url: 'https://students.cuchd.in/frmAccountStudentDetails.aspx', parse: parseFees },
  receipts: { url: 'https://students.cuchd.in/frmAccountsStudentReceiptList.aspx', parse: parseReceipts },
  datesheet: { url: 'https://students.cuchd.in/frmStudentDatesheet.aspx', parse: parseDatesheet },
  examforms: { url: 'https://students.cuchd.in/FrmStudentFormsDetails.aspx', parse: parseExamForms },
  marks: { url: 'https://students.cuchd.in/frmStudentMarksView.aspx', parse: parseMarks },
  reappear: { url: 'https://students.cuchd.in/frmStudentReappearMarksView.aspx', parse: parseMarks },
  notices: { url: 'https://students.cuchd.in/StudentHome.aspx', parse: parseNotices },
  cumail: { url: 'https://students.cuchd.in/StudentHome.aspx', parse: parseCumail },

  // Secondary server-rendered pages (generic grid extraction).
  winattendance: { url: 'https://students.cuchd.in/frmStudentWinningCampAttendanceSummary.aspx', parse: parseGenericTables, page: 'frmStudentWinningCampAttendanceSummary.aspx' },
  wintimetable: { url: 'https://students.cuchd.in/frmWinningCampMyTimetable.aspx', parse: parseGenericTables },
  amcat: { url: 'https://students.cuchd.in/frmAMCATStudentResult.aspx', parse: parseGenericTables, page: 'frmAMCATStudentResult.aspx' },
  practicaldatesheet: { url: 'https://students.cuchd.in/frmStudentPracticleDateSheet.aspx', parse: parseGenericTables },
  feeappointment: { url: 'https://students.cuchd.in/frmFeeSubmissionAppointment.aspx', parse: parseGenericTables },
  projects: { url: 'https://students.cuchd.in/frmStudentProjectPolling.aspx', parse: parseGenericTables },
  projectproposals: { url: 'https://students.cuchd.in/frmProjectProposalFromStudent.aspx', parse: parseGenericTables },
  internship: { url: 'https://students.cuchd.in/frmStudentSocialInternshipEntry.aspx', parse: parseGenericTables },
  internshippart2: { url: 'https://students.cuchd.in/frmStudentSocialInternshipEntryPart2.aspx', parse: parseGenericTables },
  diary: { url: 'https://students.cuchd.in/frmStudentDailyDiary.aspx', parse: parseGenericTables },
  research: { url: 'https://students.cuchd.in/frmStudentResearchProfile.aspx', parse: parseGenericTables },
  leaves: { url: 'https://students.cuchd.in/frmStudentGeneralLeaveApply.aspx', parse: parseGenericTables },
  dutyleave: { url: 'https://students.cuchd.in/frmStudentApplyDutyLeave.aspx', parse: parseGenericTables },
  medicalleave: { url: 'https://students.cuchd.in/frmStudentMedicalLeaveApply.aspx', parse: parseGenericTables },
  swc: { url: 'https://students.cuchd.in/frmSWCRequest.aspx', parse: parseGenericTables },
  queries: { url: 'https://students.cuchd.in/StudentQueryMaster.aspx', parse: parseGenericTables },
  mentoring: { url: 'https://students.cuchd.in/frmMentee.aspx', parse: parseGenericTables },
  noc: { url: 'https://students.cuchd.in/frmStudentNoc.aspx', parse: parseGenericTables },
  loanletters: { url: 'https://students.cuchd.in/frmLoanLetterApplication.aspx', parse: parseGenericTables },
  referral: { url: 'https://students.cuchd.in/frmAdmissionReferralByStudent.aspx', parse: parseGenericTables },
  hostel: { url: 'https://students.cuchd.in/frmStudenHostelDetails.aspx', parse: parseGenericTables },
  hostelpolicies: { url: 'https://students.cuchd.in/frmHostelPolicies.aspx', parse: parseGenericTables },
  transport: { url: 'https://students.cuchd.in/frmTransportDetails.aspx', parse: parseGenericTables },
  library: { url: 'https://students.cuchd.in/frmResourceLibrary.aspx', parse: parseGenericTables },

  // ---- Full CUIMS menu coverage (secondary server-rendered pages) ----
  proficiency: { url: 'https://students.cuchd.in/frmGeneralProficiencyCoursesForStudent.aspx', parse: parseGenericTables },
  istp: { url: 'https://students.cuchd.in/frmCentreForGlobalEducationCGE_ISTP.aspx', parse: parseGenericTables },
  itp: { url: 'https://students.cuchd.in/frmCentreForGlobalEducationCGE_ITP.aspx', parse: parseGenericTables },
  sep: { url: 'https://students.cuchd.in/frmCentreForGlobalEducationCGE_SEP.aspx', parse: parseGenericTables },
  harassment: { url: 'https://students.cuchd.in/frmStudentComplaintAgainstHarassment.aspx', parse: parseGenericTables },
  docupload: { url: 'https://students.cuchd.in/frmStudentAdmissionDocumentsUpload.aspx', parse: parseGenericTables },
  golfcart: { url: 'https://students.cuchd.in/frmGolfCartFeedback.aspx', parse: parseGenericTables },
  intlstudent: { url: 'https://students.cuchd.in/frmInternationalStudentBasicInformation.aspx', parse: parseGenericTables },
  medinsurance: { url: 'https://students.cuchd.in/frmUploadInternationalStudentMedicalInsurance.aspx', parse: parseGenericTables },
  counselling: { url: 'https://students.cuchd.in/frmAppCounsellingTherapyClinicRegistration.aspx', parse: parseGenericTables },
  crnomination: { url: 'https://students.cuchd.in/frmGoFeedbackSurvey.aspx', parse: parseGenericTables },
  careeroptions: { url: 'https://students.cuchd.in/frmCareerOptionOther.aspx', parse: parseGenericTables },
  dcpd: { url: 'https://students.cuchd.in/frmresources.aspx', parse: parseGenericTables, page: 'frmresources.aspx' },
  mocktest: { url: 'https://students.cuchd.in/frmMockTestNew.aspx', parse: parseGenericTables },
  questionsolution: { url: 'https://students.cuchd.in/frmStuQuestionSolution.aspx', parse: parseGenericTables },
  mooc: { url: 'https://students.cuchd.in/frmDLLMOOCCoordinatorList.aspx', parse: parseGenericTables },
  ebsco: { url: 'https://students.cuchd.in/frmOpenAuthentication.aspx', parse: parseGenericTables },
  repository: { url: 'https://students.cuchd.in/frmLibraryRepository.aspx', parse: parseGenericTables },
  discussionroom: { url: 'https://students.cuchd.in/frmlibraryDiscussionRoomBooking.aspx', parse: parseGenericTables },
  taketest: { url: 'https://students.cuchd.in/frmTakeTest.aspx', parse: parseGenericTables },
  joinedclubs: { url: 'https://students.cuchd.in/StudentEntiryRegisterdDone.aspx', parse: parseGenericTables },
  registerentity: { url: 'https://students.cuchd.in/frmStudentEntityDashBoard.aspx', parse: parseGenericTables },
  eventreview: { url: 'https://students.cuchd.in/frmStudentEventReview.aspx', parse: parseGenericTables },
  talentsearch: { url: 'https://students.cuchd.in/frmTalentSearchProgram.aspx', parse: parseGenericTables },
  buggieconsent: { url: 'https://students.cuchd.in/frmStudentBuggiesConsent.aspx', parse: parseGenericTables },
  transportconsent: { url: 'https://students.cuchd.in/frmStudentTransportConsent.aspx', parse: parseGenericTables },
  importantlinks: { url: 'https://students.cuchd.in/frmImportantlink.aspx', parse: parseGenericTables },
  intlopportunities: { url: 'https://students.cuchd.in/frmInternationalStudyOpportunities.aspx', parse: parseGenericTables },
  bugreport: { url: 'https://students.cuchd.in/bugreport.aspx', parse: parseGenericTables },
};

// Extract tokenized nav URLs (with their ?type= tokens) from a home page.
function extractNavUrls(homeHtml) {
  const urls = {};
  const re = /href=["']([a-zA-Z0-9_.-]+\.aspx)(\?[^"']*)?["']/gi;
  let m;
  while ((m = re.exec(homeHtml))) {
    if (m[2] && m[2].includes('type=') && !urls[m[1].toLowerCase()]) {
      urls[m[1].toLowerCase()] = 'https://students.cuchd.in/' + m[1] + m[2];
    }
  }
  return urls;
}

// CUIMS shows an "UIMS Error" page when a URL is wrong (e.g. missing ?type token).
function isErrorPage(html) {
  return /UIMS Error|Whoops,? Something broke/i.test(html);
}

async function fetchParsed(session, name) {
  if (name === 'attendance') return fetchAttendance(session);
  const ep = DATA_ENDPOINTS[name];
  if (!ep) throw new Error(`Unknown data endpoint: ${name}`);
  // Some CUIMS pages require a ?type= token captured from the home page nav.
  let url = ep.url;
  if (ep.page && session && session.navUrls) {
    url = session.navUrls[ep.page.toLowerCase()] || ep.url;
  }
  const { html } = await session.client._getHtml(url);
  if (isErrorPage(html)) {
    console.log(`[diag] ${name} -> CUIMS error page, url=${url} htmlLen=${html.length}`);
    throw new Error(`${name} page returned a CUIMS error (URL may need a session token).`);
  }
  console.log(`[diag] ${name} OK url=${url} htmlLen=${html.length}`);
  return ep.parse(html);
}

// The attendance grid is rendered client-side: the page HTML only carries the
// header row. The real data is loaded via an AJAX PageMethod:
//   POST frmStudentCourseWiseAttendanceSummary.aspx/GetReport
//   body { UID: '<per-session token>', Session: '<session id>' }
//   -> { d: '<json string array of course rows>' }
// The token/session are embedded in the page as getReport('<token>','<sid>').
async function fetchAttendance(session) {
  const ep = DATA_ENDPOINTS.attendance;
  let url = ep.url;
  if (ep.page && session && session.navUrls) {
    url = session.navUrls[ep.page.toLowerCase()] || ep.url;
  }
  const { html } = await session.client._getHtml(url);
  if (isErrorPage(html)) {
    throw new Error('attendance page returned a CUIMS error (URL may need a session token).');
  }
  const m = html.match(/getReport\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
  if (!m) {
    console.log('[diag] attendance: no getReport token found, falling back to HTML parse');
    return parseAttendance(html);
  }
  // Some clients have no _postJson; fall back to the HTML parse in that case.
  if (typeof session.client._postJson !== 'function') {
    console.log('[diag] attendance: client has no _postJson, falling back to HTML parse');
    return parseAttendance(html);
  }
  const [, token, sessionId] = m;
  const methodUrl = url.replace(/\?.*$/, '') + '/GetReport';
  console.log(`[diag] attendance: calling GetReport (token=${token.slice(0, 12)}… session=${sessionId})`);
  const { status, json } = await session.client._postJson(methodUrl, { UID: token, Session: sessionId });
  if (status !== 200 || !json || typeof json.d !== 'string') {
    throw new Error(`attendance GetReport returned an unexpected response (HTTP ${status}).`);
  }
  let rows = [];
  try {
    rows = JSON.parse(json.d);
  } catch (e) {
    // CUIMS may return a plain message string (e.g. "No Data Found").
    console.log(`[diag] attendance: GetReport non-JSON payload: ${String(json.d).slice(0, 200)}`);
    return { rows: [], count: 0, note: String(json.d) };
  }
  if (!Array.isArray(rows)) {
    console.log('[diag] attendance: GetReport returned non-array:', String(json.d).slice(0, 200));
    return { rows: [], count: 0, note: String(json.d) };
  }
  console.log(`[diag] attendance OK via GetReport (${rows.length} rows)`);
  return parseAttendanceReport(rows);
}

// ASP.NET __doPostBack downloads (receipt PDFs, lecture-plan PDFs, etc.).
// We must replay the postback with a fresh page's __VIEWSTATE etc.
async function postbackDownload(session, name, target) {
  const ep = DATA_ENDPOINTS[name];
  if (!ep) throw new Error(`Unknown download endpoint: ${name}`);
  let url = ep.url;
  if (ep.page && session && session.navUrls) {
    url = session.navUrls[ep.page.toLowerCase()] || ep.url;
  }
  // Some clients have no _postRaw; downloads only work against live CUIMS.
  if (typeof session.client._postRaw !== 'function') {
    const e = new Error('Downloads are only available in live mode.');
    e.status = 501;
    throw e;
  }
  // Fresh GET to pick up valid view state for this session.
  const { html } = await session.client._getHtml(url);
  if (isErrorPage(html)) throw new Error(`${name} page returned a CUIMS error`);
  const vs = extractViewState(html);
  const res = await session.client._postRaw(url, {
    __EVENTTARGET: target,
    __EVENTARGUMENT: '',
    __VIEWSTATE: vs.viewState,
    __VIEWSTATEGENERATOR: vs.viewStateGenerator,
    __EVENTVALIDATION: vs.eventValidation,
  });
  return res;
}

// Send a raw file (PDF etc.) as an attachment download.
function sendDownload(res, dl, fallbackName) {
  const ctype = (dl.headers && dl.headers.get('content-type')) || 'application/octet-stream';
  res.setHeader('Content-Type', ctype.includes('text/html') ? 'application/octet-stream' : ctype);
  const disp = dl.headers && dl.headers.get('content-disposition');
  res.setHeader('Content-Disposition', disp || `attachment; filename="${fallbackName}"`);
  res.send(Buffer.isBuffer(dl.buffer) ? dl.buffer : Buffer.from(dl.buffer || []));
}

// GET /api/receipts/:idx/download -> re-parse receipts, replay the row's download postback
app.get('/api/receipts/:idx/download', requireSession, async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const data = await fetchParsed(req.session, 'receipts');
    const r = (data.receipts || [])[idx];
    if (!r || !r.downloadTarget) return res.status(404).json({ error: 'Receipt not found' });
    const dl = await postbackDownload(req.session, 'receipts', r.downloadTarget);
    sendDownload(res, dl, `receipt-${r.receiptNo || idx}.pdf`);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/courses/:idx/download -> re-parse courses, replay the lecture-plan download postback
app.get('/api/courses/:idx/download', requireSession, async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const data = await fetchParsed(req.session, 'courses');
    const c = (data.courses || [])[idx];
    if (!c || !c.lecturePlanTarget) return res.status(404).json({ error: 'Course lecture plan not found' });
    const dl = await postbackDownload(req.session, 'courses', c.lecturePlanTarget);
    sendDownload(res, dl, `lecture-plan-${c.code || idx}.pdf`);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- LMS ----------
// SSO into the university LMS (lms.cuchd.in) by replaying the home-page
// postback, then fetch + parse the landing page.
async function fetchLms(session) {
  if (typeof session.client.ssoLms !== 'function') {
    const e = new Error('LMS is only available in live mode.');
    e.status = 501;
    throw e;
  }
  const { url, html } = await session.client.ssoLms();
  const origin = url ? new URL(url).origin : 'https://lms.cuchd.in';
  session.lmsBase = origin;
  const parsed = parseLmsHome(html);
  return { available: true, origin, landing: url, ...parsed };
}

// GET /api/lms -> SSO into the LMS and return the parsed dashboard + landing URL
app.get('/api/lms', requireSession, async (req, res) => {
  try {
    res.json(await fetchLms(req.session));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// The LMS origin to allow proxying (learned from the SSO landing, with a
// sane default). Keeps the allowlist aligned with the actual SSO chain.
function lmsOrigin(session) {
  return (session && session.lmsBase) || 'https://lms.cuchd.in';
}

// GET /api/lms/proxy?url=<encoded lms url> -> fetch an LMS page with the
// session cookies, rewrite links to stay inside the proxy, and serve it framed.
app.get('/api/lms/proxy', requireLmsSession, async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: 'url is required' });
    const u = new URL(target);
    const allowed = lmsOrigin(req.session);
    if (u.origin !== allowed) {
      return res.status(403).json({ error: `Only ${allowed} pages can be proxied` });
    }
    if (typeof req.session.client._getRaw !== 'function') {
      return res.status(501).json({ error: 'LMS proxy is only available in live mode.' });
    }
    const dl = await req.session.client._getRaw(u.href);
    const ctype = (dl.headers && dl.headers.get('content-type')) || '';
    if (/text\/html/i.test(ctype)) {
      const html = dl.buffer.toString('utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rewriteLmsHtml(html, u.origin, req.query.t));
    } else {
      // Pass through binaries (PDFs, images, JS/CSS assets) untouched.
      res.setHeader('Content-Type', ctype || 'application/octet-stream');
      res.send(dl.buffer);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/lms/proxy?url=... -> forward Moodle form submissions (quizzes,
// forums, profile updates) to the LMS with the session cookies.
app.post('/api/lms/proxy', requireLmsSession, async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: 'url is required' });
    const u = new URL(target);
    const allowed = lmsOrigin(req.session);
    if (u.origin !== allowed) {
      return res.status(403).json({ error: `Only ${allowed} pages can be proxied` });
    }
    if (typeof req.session.client._post !== 'function') {
      return res.status(501).json({ error: 'LMS proxy is only available in live mode.' });
    }
    const r = await req.session.client._post(u.href, req.body || {}, 5, { Referer: u.href });
    const finalUrl = r.url || u.href;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // baseUrl must be the ORIGIN (not the full page URL) so link rewriting
    // matches; otherwise v.startsWith(baseUrl) matches almost nothing.
    res.send(rewriteLmsHtml(r.html || '', new URL(finalUrl).origin, req.query.t));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEBUG: dump the raw text of a data page so we can see what CUIMS actually returns.
app.get('/api/debug/raw/:name', requireSession, async (req, res) => {
  const ep = DATA_ENDPOINTS[req.params.name];
  if (!ep) return res.status(404).json({ error: 'Unknown endpoint' });
  try {
    let url = ep.url;
    if (ep.page && req.session && req.session.navUrls) {
      url = req.session.navUrls[ep.page.toLowerCase()] || ep.url;
    }
    const { html } = await req.session.client._getHtml(url);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    res.json({ url, htmlLen: html.length, isErrorPage: isErrorPage(html), snippet: text.slice(0, 12000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEBUG: full raw text of a data page (no truncation).
app.get('/api/debug/full/:name', requireSession, async (req, res) => {
  const ep = DATA_ENDPOINTS[req.params.name];
  if (!ep) return res.status(404).json({ error: 'Unknown endpoint' });
  try {
    let url = ep.url;
    if (ep.page && req.session && req.session.navUrls) {
      url = req.session.navUrls[ep.page.toLowerCase()] || ep.url;
    }
    const { html } = await req.session.client._getHtml(url);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    res.json({ url, htmlLen: html.length, isErrorPage: isErrorPage(html), text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic per-endpoint route
for (const [name, ep] of Object.entries(DATA_ENDPOINTS)) {
  app.get(`/api/${name}`, requireSession, async (req, res) => {
    try {
      const data = await fetchParsed(req.session, name);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ---------- LOGIN API ----------
// POST /api/login/start { uid } -> starts 2-step login, returns session token + captcha image
app.post('/api/login/start', async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  const token = newToken();
  const client = new CuimsClient();
  try {
    const step2 = await client.startLogin(uid);
    if (!step2.html.includes('txtLoginPassword')) {
      return res.status(401).json({ error: 'User ID not recognized or unexpected response. Check UID and try again.' });
    }
    const parsed = client.parseStep2(step2.html);
    if (!parsed.hasPassword) {
      return res.status(401).json({ error: 'User ID not recognized. Check UID and try again.' });
    }
    // fetch captcha image now and store it base64 with the session
    let captchaB64 = null;
    if (parsed.captchaUrl) {
      const img = await client.getCaptchaImage(parsed.captchaUrl);
      captchaB64 = img.length ? img.toString('base64') : null;
    }
    const s = { client, uid, status: 'awaiting_captcha', step2Html: step2.html, loginUrl: step2.url };
    sessions.set(token, s);
    res.json({
      sessionToken: token,
      status: 'captcha_required',
      captchaImage: captchaB64 ? 'data:image/jpeg;base64,' + captchaB64 : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// POST /api/login/complete { sessionToken, password, captcha }
app.post('/api/login/complete', async (req, res) => {
  const { password, captcha } = req.body || {};
  const sessionToken = (req.body && req.body.sessionToken) || req.headers['x-session-token'];
  const s = getClient(sessionToken);
  if (!s) return res.status(401).json({ error: 'Session expired. Start login again.', restartRequired: true });
  if (s.status !== 'awaiting_captcha') return res.status(400).json({ error: 'Login already completed or expired.' });

  try {
    const loginRes = await s.client.submitLogin(password, captcha, s.step2Html, s.loginUrl);
    const check = await s.client.isLoggedIn();
    if (check.loggedIn) {
      s.status = 'logged_in';
      s.homeHtml = check.html;
      s.navUrls = extractNavUrls(check.html);
      res.json({ success: true, status: 'logged_in' });
    } else {
      const errMsg = extractLoginError(loginRes.html) || extractLoginError(check.html);
      s.status = 'awaiting_captcha';
      res.status(401).json({
        success: false,
        error: errMsg || 'Login failed. Check password / captcha.',
        restartRequired: true,
      });
    }
  } catch (e) {
    res.status(500).json({ error: 'Login error: ' + e.message });
  }
});

// GET /api/session -> current status
app.get('/api/session', (req, res) => {
  const token = req.headers['x-session-token'];
  const s = token ? getClient(token) : null;
  if (!s) return res.json({ loggedIn: false });
  res.json({ loggedIn: s.status === 'logged_in', status: s.status, uid: s.uid });
});

// GET /api/dashboard -> fetch profile + result + attendance + fees + notices in parallel
app.get('/api/dashboard', requireSession, async (req, res) => {
  try {
    const [profile, result, attendance, fees, notices] = await Promise.allSettled([
      fetchParsed(req.session, 'profile'),
      fetchParsed(req.session, 'result'),
      fetchParsed(req.session, 'attendance'),
      fetchParsed(req.session, 'fees'),
      fetchParsed(req.session, 'notices'),
    ]);
    res.json({
      profile: profile.status === 'fulfilled' ? profile.value : { error: profile.reason?.message },
      result: result.status === 'fulfilled' ? result.value : { error: result.reason?.message },
      attendance: attendance.status === 'fulfilled' ? attendance.value : { error: attendance.reason?.message },
      fees: fees.status === 'fulfilled' ? fees.value : { error: fees.reason?.message },
      notices: notices.status === 'fulfilled' ? notices.value : { error: notices.reason?.message },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/all -> fetch every data endpoint in parallel (used after login)
app.get('/api/all', requireSession, async (req, res) => {
  const keys = Object.keys(DATA_ENDPOINTS);
  const settled = await Promise.allSettled(keys.map((k) => fetchParsed(req.session, k)));
  const out = {};
  settled.forEach((s, i) => {
    const k = keys[i];
    out[k] = s.status === 'fulfilled' ? s.value : { error: s.reason?.message };
  });
  res.json(out);
});

// GET / -> friendly status page so the deployed service doesn't look broken
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CampusVault API</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b0c16; color: #e6e8f5; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { text-align: center; padding: 48px 32px; border: 1px solid #2a2d4a; border-radius: 20px; background: #12132a; max-width: 420px; }
    h1 { font-size: 28px; margin: 0 0 10px; }
    .ok { color: #34d399; font-weight: 600; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #34d399; margin-right: 8px; animation: pulse 1.6s infinite; vertical-align: baseline; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    code { background: #1d1f3d; padding: 2px 8px; border-radius: 6px; font-size: 13px; }
    .muted { color: #8a8fb8; font-size: 13px; margin-top: 22px; }
    a { color: #7b80ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>&#128737;&#65039; CampusVault</h1>
    <p class="ok"><span class="dot"></span>CUIMS API server is running</p>
    <p class="muted">Health check &rarr; <code><a href="/api/health">/api/health</a></code></p>
  </div>
</body>
</html>`);
});

// GET /api/health
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// fallback for unknown API routes
app.get('/api/*', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

app.listen(PORT, () => {
  console.log(`CUIMS Student Portal running at http://localhost:${PORT}`);
});
