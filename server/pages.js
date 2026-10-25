'use strict';
/**
 * Respuestas que no son JSON de la API: páginas HTML mínimas del servidor (acceso y errores de OAuth), el panel y los archivos estáticos
 * de lista cerrada (módulos compartidos con la página e imágenes). Nada más se sirve desde disco.
 */
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../i18n');

const ROOT = path.join(__dirname, '..');
const PAGE_STYLE = 'font:18px Georgia;background:#0a1226;color:#f6e2a6;padding:3em';
const LINK_STYLE = 'color:#3fbf9a';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (res, code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(body); };

// Sin sesión (modo remoto): solo un enlace para iniciar sesión con Twitch; no se sirve el panel ni ningún dato.
function loginPage(req, res) {
  const loc = I18n.fromCookie(req.headers.cookie), label = I18n.tIn(loc, 'twitch.connect');
  html(res, 200, `<!doctype html><html lang="${esc(loc)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(label)}</title><body style="${PAGE_STYLE};text-align:center"><h1>${esc(label)}</h1><p><a style="${LINK_STYLE}" href="/auth/login">${esc(label)}</a></p>`, { 'Cache-Control': 'no-store' });
}

// Página de error del servidor (OAuth): en el idioma elegido en la interfaz (cookie celestiales_lang; por defecto inglés).
// Solo texto fijo de i18n (se escapa igualmente): el mensaje de error nunca se refleja en la página, puede venir de la URL de retorno de Twitch; va a la consola.
function errorPage(req, res, code, titleKey, bodyKey) {
  const loc = I18n.fromCookie(req.headers.cookie), title = I18n.tIn(loc, titleKey), body = bodyKey ? I18n.tIn(loc, bodyKey) : '';
  html(res, code, `<!doctype html><html lang="${esc(loc)}"><meta charset="utf-8"><title>${esc(title)}</title><body style="${PAGE_STYLE}"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a style="${LINK_STYLE}" href="/">${esc(I18n.tIn(loc, 'srv.back'))}</a></p>`);
}

/** El panel (la única página de la aplicación). */
function panel(res) {
  html(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), { 'Cache-Control': 'no-store' });
}

// Módulos compartidos con la página (reglas/configuración e i18n con sus catálogos). Lista cerrada: nada más se sirve desde aquí.
const SHARED = { '/core.js': 'core.js', '/i18n.js': 'i18n.js', '/locales/en.js': 'locales/en.js', '/locales/es.js': 'locales/es.js' };
// Imágenes: solo public/img/<nombre>.(png|webp|jpg|jpeg), sin subcarpetas ni rutas relativas.
const IMG_RE = /^\/img\/([\w-]+\.(png|webp|jpe?g))$/i;
const IMG_TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** Sirve `p` si está en la lista cerrada de estáticos. Devuelve true si respondió. */
function serveStatic(p, res) {
  if (SHARED[p]) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(ROOT, SHARED[p])));
    return true;
  }
  const img = p.match(IMG_RE);
  if (!img) return false;
  try {
    const data = fs.readFileSync(path.join(ROOT, 'public', 'img', img[1]));
    res.writeHead(200, { 'Content-Type': IMG_TYPES[img[2].toLowerCase()], 'Cache-Control': 'max-age=3600' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
  return true;
}

module.exports = { loginPage, errorPage, panel, serveStatic, esc };
