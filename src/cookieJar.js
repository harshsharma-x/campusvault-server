export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  set(setCookieHeader, url) {
    if (!setCookieHeader) return;
    const parts = setCookieHeader.split(';');
    const first = parts[0];
    const eq = first.indexOf('=');
    if (eq < 0) return;
    const name = first.slice(0, eq).trim();
    let value = first.slice(eq + 1).trim();
    let domain = null;
    let path = '/';
    let expires = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      const [k, v = ''] = p.split('=');
      if (k.toLowerCase() === 'domain') domain = v.trim();
      else if (k.toLowerCase() === 'path') path = v.trim();
      else if (k.toLowerCase() === 'expires') expires = Date.parse(v.trim());
    }
    if (!domain) {
      try { domain = new URL(url).hostname; } catch { return; }
    }
    this.cookies.set(name, { value, domain, path, expires });
  }

  getHeader(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return ''; }
    const now = Date.now();
    const parts = [];
    for (const [name, c] of this.cookies) {
      if (c.expires && c.expires < now) continue;
      const hostOk = host === c.domain || host.endsWith('.' + c.domain);
      if (!hostOk) continue;
      parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
  }

  toJSON() {
    const out = {};
    for (const [name, c] of this.cookies) out[name] = c.value;
    return out;
  }
}
