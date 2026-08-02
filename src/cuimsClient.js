import { CookieJar } from './cookieJar.js';

const BASE = 'https://students.cuchd.in';

export class CuimsClient {
  constructor() {
    this.jar = new CookieJar();
    this.uid = null;
  }

  async _fetch(url, opts = {}) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      ...(opts.headers || {}),
    };
    const cookie = this.jar.getHeader(url);
    if (cookie) headers['Cookie'] = cookie;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) this.jar.set(sc, url);
    return res;
  }

  async _get(url, redirects = 0) {
    const res = await this._fetch(url);
    if (res.status >= 300 && res.status < 400 && redirects < 5) {
      const loc = res.headers.get('location');
      if (loc) return this._get(new URL(loc, BASE).href, redirects + 1);
    }
    return { status: res.status, html: await res.text(), url: res.url };
  }

  // Fetch a page and return its HTML (used by data endpoints).
  async _getHtml(url) {
    const { html, url: finalUrl } = await this._get(url);
    return { html, url: finalUrl };
  }

  // POST a form body and return the raw binary response (used for ASP.NET
  // __doPostBack downloads like receipt PDFs and lecture-plan PDFs).
  // Redirects are followed with GET (a postback usually 302s to the file URL).
  async _postRaw(url, fields, redirects = 0) {
    const body = new URLSearchParams(fields).toString();
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status >= 300 && res.status < 400 && redirects < 5) {
      const loc = res.headers.get('location');
      if (loc) return this._getRaw(new URL(loc, BASE).href, redirects + 1);
    }
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  // GET a URL and return the raw binary response (used after postback redirects).
  async _getRaw(url, redirects = 0) {
    const res = await this._fetch(url);
    if (res.status >= 300 && res.status < 400 && redirects < 5) {
      const loc = res.headers.get('location');
      if (loc) return this._getRaw(new URL(loc, BASE).href, redirects + 1);
    }
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  // POST a JSON body (ASP.NET PageMethod style) and return parsed JSON.
  async _postJson(url, payload) {
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON response */
    }
    return { status: res.status, json, text };
  }

  async _post(url, fields, redirects = 0, extraHeaders = {}) {
    const body = new URLSearchParams(fields).toString();
    const res = await this._fetch(url, { method: 'POST', body, headers: extraHeaders });
    if (res.status >= 300 && res.status < 400 && redirects < 5) {
      const loc = res.headers.get('location');
      if (loc) {
        const followUrl = new URL(loc, BASE).href;
        // A 302 after form post often lands on a new page; return it
        const r2 = await this._get(followUrl, 5);
        return { status: r2.status, html: r2.html, url: r2.url, redirectedFrom: followUrl };
      }
    }
    return { status: res.status, html: await res.text(), url: res.url };
  }

  // Step 1: GET / then POST txtUserId. Returns step-2 page (password form).
  async startLogin(uid) {
    this.uid = uid;
    const first = await this._get(BASE + '/');
    const vs = extractViewState(first.html);
    const step2 = await this._post(BASE + '/', {
      __EVENTTARGET: 'btnNext',
      __EVENTARGUMENT: '',
      __VIEWSTATE: vs.viewState,
      __VIEWSTATEGENERATOR: vs.viewStateGenerator,
      txtUserId: uid,
      btnNext: 'NEXT',
    });
    return step2;
  }

  parseStep2(html) {
    const vs = extractViewState(html);
    const captchaMatch = html.match(/GenerateCaptcha\.aspx\?(\d+)/);
    return {
      viewState: vs.viewState,
      viewStateGenerator: vs.viewStateGenerator,
      captchaUrl: captchaMatch ? `${BASE}/GenerateCaptcha.aspx?${captchaMatch[1]}` : null,
      hasPassword: html.includes('txtLoginPassword'),
      hasCaptcha: html.includes('txtcaptcha'),
    };
  }

  async getCaptchaImage(captchaUrl) {
    const res = await this._fetch(captchaUrl);
    return Buffer.from(await res.arrayBuffer());
  }

  // Step 3: POST password + captcha to the step-2 URL.
  async submitLogin(password, captcha, step2Html, step2Url) {
    const vs = extractViewState(step2Html);
    const fields = {
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      __VIEWSTATE: vs.viewState,
      __VIEWSTATEGENERATOR: vs.viewStateGenerator,
      txtLoginPassword: password,
      txtcaptcha: captcha,
      btnLogin: 'LOGIN',
    };
    if (vs.hfCurrentBackground) fields.hfcurrentbackground = vs.hfCurrentBackground;
    if (vs.hfData) fields.hfdata = vs.hfData;
    const result = await this._post(step2Url, fields, 0, { Referer: step2Url });
    return result;
  }

  async isLoggedIn() {
    const r = await this._get(BASE + '/StudentHome.aspx');
    const html = r.html;
    const loggedIn = !html.includes('Login.aspx?identifier') && html.includes('StudentHome');
    return { loggedIn, html, url: r.url };
  }

  // Replay the LMS SSO postback (ctl00$lbtnLMSSSO) from the student home page.
  // The postback 302s to the university LMS (lms.cuchd.in, Moodle) which drops
  // its own session cookies into our jar, so later LMS requests are authed.
  // Returns { url, html, status } with url = the LMS landing page.
  async ssoLms() {
    const home = await this._getHtml(BASE + '/StudentHome.aspx');
    const vs = extractViewState(home.html);
    const res = await this._post(BASE + '/StudentHome.aspx', {
      __EVENTTARGET: 'ctl00$lbtnLMSSSO',
      __EVENTARGUMENT: '',
      __VIEWSTATE: vs.viewState,
      __VIEWSTATEGENERATOR: vs.viewStateGenerator,
      __EVENTVALIDATION: vs.eventValidation,
    });
    // _post follows redirects, so res.url is usually already the LMS landing.
    let url = res.url || '';
    let html = res.html || '';
    // Fallback: CUIMS sometimes renders an intermediate page that JS-navigates.
    if (!/lms\.cuchd\.in|moodle/i.test(url) && html) {
      const m = html.match(/https?:\/\/[^"'\s]*lms[^"'\s]*/i) || html.match(/window\.location[^;]{0,200}/i);
      if (m) {
        const target = (m[0].match(/https?:\/\/[^"'\s]+/) || [])[0];
        if (target) {
          const r2 = await this._get(target);
          url = r2.url;
          html = r2.html;
        }
      }
    }
    return { url, html, status: res.status };
  }
}

export function extractViewState(html) {
  const get = (name) => {
    const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
    return m ? decodeURIComponent(m[1]) : '';
  };
  return {
    viewState: get('__VIEWSTATE'),
    viewStateGenerator: get('__VIEWSTATEGENERATOR'),
    eventValidation: get('__EVENTVALIDATION'),
    hfCurrentBackground: get('hfcurrentbackground'),
    hfData: get('hfdata'),
  };
}
