import { getStore } from '@netlify/blobs';
import QRCode from 'qrcode';
import crypto from 'node:crypto';

export const config = { path: ['/api/*', '/admin/print'] };

const QR_COUNT = parseInt(process.env.QR_COUNT || '20', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiame';
const store = () => getStore({ name: 'tesoro', consistency: 'strong' });

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const sign = (v) => crypto.createHmac('sha256', ADMIN_PASSWORD).update(v).digest('hex');
const cookies = (req) =>
  Object.fromEntries((req.headers.get('cookie') || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const cookieHeader = (name, value, days = 2) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; Secure; SameSite=Lax`;

// ---------- almacenamiento ----------
async function init(s) {
  const qrs = Array.from({ length: QR_COUNT }, (_, i) => ({ id: i + 1, token: crypto.randomBytes(5).toString('hex') }));
  await s.setJSON('qrs', qrs, { onlyIfNew: true }); // si hay carrera, gana el primero
  const mk = (id, name, code) => ({ id, name, code, final_message: '¡Llegaron al final! 🏆', started_at: null, finished_at: null, steps: [] });
  await s.setJSON('team:1', mk(1, 'Equipo Rojo', 'ROJO'), { onlyIfNew: true });
  await s.setJSON('team:2', mk(2, 'Equipo Azul', 'AZUL'), { onlyIfNew: true });
}
async function getQrs(s) {
  let qrs = await s.get('qrs', { type: 'json' });
  if (!qrs) { await init(s); qrs = await s.get('qrs', { type: 'json' }); }
  return qrs;
}
async function getTeams(s) {
  await getQrs(s);
  const { blobs } = await s.list({ prefix: 'team:' });
  const teams = await Promise.all(blobs.map((b) => s.get(b.key, { type: 'json' })));
  return teams.filter(Boolean).sort((a, b) => a.id - b.id);
}
const saveTeam = (s, t) => s.setJSON(`team:${t.id}`, t);

async function teamFromReq(req, s) {
  const code = cookies(req).team;
  if (!code) return null;
  return (await getTeams(s)).find((t) => t.code === code) || null;
}

function stateFor(team) {
  const steps = [...team.steps].sort((a, b) => a.pos - b.pos);
  const total = steps.length;
  const done = steps.filter((x) => x.scanned_at).length;
  const base = { team: { name: team.name }, total, done };
  if (!team.started_at) return { ...base, status: 'waiting' };
  const current = steps.find((x) => !x.scanned_at);
  if (!current && total > 0)
    return { ...base, status: 'finished', final_message: team.final_message, elapsed_ms: (team.finished_at || Date.now()) - team.started_at };
  if (!current) return { ...base, status: 'waiting' };
  return { ...base, status: 'playing', clue: current.clue, step: current.pos };
}

const isAdmin = (req) => cookies(req).admin === sign('admin');

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const s = store();
  const body = ['POST', 'PUT'].includes(method) ? await req.json().catch(() => ({})) : {};

  try {
    // ---------- jugadores ----------
    if (path === '/api/join' && method === 'POST') {
      const code = String(body.code || '').trim().toUpperCase();
      const team = (await getTeams(s)).find((t) => t.code === code);
      if (!team) return json({ error: 'Código de equipo inválido' }, 404);
      return json(stateFor(team), 200, { 'Set-Cookie': cookieHeader('team', team.code) });
    }
    if (path === '/api/state' && method === 'GET') {
      const team = await teamFromReq(req, s);
      return team ? json(stateFor(team)) : json({ error: 'sin equipo' }, 401);
    }
    if (path === '/api/scan' && method === 'POST') {
      const team = await teamFromReq(req, s);
      if (!team) return json({ error: 'sin equipo' }, 401);
      const qr = (await getQrs(s)).find((q) => q.token === String(body.token || ''));
      if (!qr) return json({ result: 'unknown', ...stateFor(team) });
      if (!team.started_at) return json({ result: 'not_started', ...stateFor(team) });
      const steps = [...team.steps].sort((a, b) => a.pos - b.pos);
      const current = steps.find((x) => !x.scanned_at);
      if (!current) return json({ result: 'finished', ...stateFor(team) });
      if (current.qr_id === qr.id) {
        const now = Date.now();
        current.scanned_at = now;
        team.steps = steps;
        if (steps.every((x) => x.scanned_at)) team.finished_at = now;
        await saveTeam(s, team);
        return json({ result: 'ok', ...stateFor(team) });
      }
      const already = steps.some((x) => x.scanned_at && x.qr_id === qr.id);
      return json({ result: already ? 'already' : 'wrong', ...stateFor(team) });
    }

    // ---------- admin ----------
    if (path === '/api/admin/login' && method === 'POST') {
      if (body.password !== ADMIN_PASSWORD) return json({ error: 'Contraseña incorrecta' }, 401);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('admin', sign('admin'), 7) });
    }
    if (path.startsWith('/api/admin/') || path === '/admin/print') {
      if (!isAdmin(req)) return path === '/admin/print' ? Response.redirect(new URL('/admin', url), 302) : json({ error: 'no autorizado' }, 401);
    }
    if (path === '/api/admin/me') return json({ ok: true });
    if (path === '/api/admin/data' && method === 'GET') {
      const qrs = await getQrs(s);
      return json({ teams: await getTeams(s), qr_count: qrs.length });
    }
    const m = path.match(/^\/api\/admin\/teams\/(\d+)$/);
    if (m && method === 'PUT') {
      const id = Number(m[1]);
      const team = (await getTeams(s)).find((t) => t.id === id);
      if (!team) return json({ error: 'equipo no existe' }, 404);
      const code = String(body.code).trim().toUpperCase();
      if ((await getTeams(s)).some((t) => t.id !== id && t.code === code)) return json({ error: 'Código repetido' }, 400);
      // el progreso sigue al QR (no a la posición), así reordenar no mezcla lo ya escaneado
      // cada QR se usa una sola vez: ni repetido en este equipo ni en otro equipo
      const ids = (body.steps || []).map((x) => (x.qr_id ? Number(x.qr_id) : null)).filter(Boolean);
      const dup = ids.find((q, i) => ids.indexOf(q) !== i);
      if (dup) return json({ error: `El QR #${dup} está repetido en este equipo` }, 400);
      const other = (await getTeams(s)).find((t) => t.id !== id && t.steps.some((x) => ids.includes(x.qr_id)));
      if (other) {
        const q = other.steps.find((x) => ids.includes(x.qr_id)).qr_id;
        return json({ error: `El QR #${q} ya lo usa ${other.name}. Sacáselo y guardá ese equipo primero.` }, 400);
      }
      const prev = new Map(team.steps.filter((x) => x.qr_id).map((x) => [x.qr_id, x.scanned_at]));
      team.name = String(body.name).trim();
      team.code = code;
      team.final_message = String(body.final_message || '');
      team.steps = (body.steps || []).map((x, i) => ({
        pos: i + 1, clue: String(x.clue || ''), location: String(x.location || ''), qr_id: x.qr_id ? Number(x.qr_id) : null, scanned_at: (x.qr_id && prev.get(Number(x.qr_id))) || null }));
      await saveTeam(s, team);
      return json({ ok: true });
    }
    if (path === '/api/admin/start' && method === 'POST') {
      for (const t of await getTeams(s)) if (!t.started_at) { t.started_at = Date.now(); await saveTeam(s, t); }
      return json({ ok: true });
    }
    if (path === '/api/admin/reset' && method === 'POST') {
      for (const t of await getTeams(s)) {
        t.started_at = null; t.finished_at = null; t.steps.forEach((x) => (x.scanned_at = null)); await saveTeam(s, t);
      }
      return json({ ok: true });
    }
    if (path === '/admin/print') {
      const base = (process.env.BASE_URL || url.origin).replace(/\/$/, '');
      const qrs = await getQrs(s);
      const cells = await Promise.all(qrs.map(async (q) => {
        const svg = await QRCode.toString(`${base}/q/${q.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return `<div class="cell"><div class="num">#${q.id}</div>${svg}<div class="small">Búsqueda del tesoro</div></div>`;
      }));
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>QRs</title><style>
  body{font-family:system-ui,sans-serif;margin:0}
  .bar{padding:10px;background:#fffbe6;border-bottom:1px solid #ddd;font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr)}
  .cell{border:1px dashed #999;padding:8px;text-align:center;break-inside:avoid;height:6.3cm;box-sizing:border-box}
  .cell svg{width:4.2cm;height:4.2cm}.num{font-size:20px;font-weight:700}.small{font-size:9px;color:#666}
  @media print{.bar{display:none}@page{size:A4;margin:0.8cm}}</style></head><body>
  <div class="bar">Los QR apuntan a <b>${base}</b>. Si no es el dominio final, configurá BASE_URL y recargá. Imprimir (Ctrl/Cmd+P) → A4. Cortá por las líneas punteadas.</div>
  <div class="grid">${cells.join('')}</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};
