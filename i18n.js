/*
 * i18n.js — Internacionalización de «El destino de los aventureros». Sin dependencias; funciona en Node y en el navegador.
 * Convención (igual que DocFlow): el idioma por defecto es INGLÉS, independientemente del idioma del navegador;
 * el otro idioma soportado es español. Si falta una clave en el idioma activo se usa la inglesa.
 *
 * Catálogos: locales/en.js y locales/es.js (objetos anidados; las claves se usan «aplanadas»: 'admin.tabs.people').
 * Uso:   I18n.t('stage.ask')            I18n.t('log.won_main', { prize: 3, celestial: 'Niuzao', name: 'Ana' })
 *        Plural: si pasas { count } se busca primero la clave con sufijo _one (count === 1) o _other.
 *        Un parámetro puede ser { $t: 'otra.clave' } para traducir un fragmento dentro de la misma frase.
 *
 * NOTA: este archivo y locales/ existen como copia idéntica en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual. Cualquier cambio va a los dos, byte a byte
 * (si ambos están clonados uno junto al otro, una prueba del repositorio Twitch lo comprueba).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./locales/en'), require('./locales/es'));
  else root.I18n = factory((root.CELESTIALES_LOCALES || {}).en, (root.CELESTIALES_LOCALES || {}).es);
})(typeof self !== 'undefined' ? self : this, function (en, es) {
  'use strict';

  const DEFAULT = 'en';
  const SUPPORTED = ['en', 'es'];
  const STORAGE_KEY = 'celestiales.locale';       // preferencia en el navegador
  const COOKIE_KEY = 'celestiales_lang';          // para que las páginas del servidor (errores de OAuth) usen el mismo idioma

  const flatten = (o, prefix = '', out = {}) => {
    for (const k of Object.keys(o || {})) {
      const v = o[k], key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
    }
    return out;
  };
  const catalogs = { en: flatten(en), es: flatten(es) };
  let locale = DEFAULT;
  const listeners = [];

  const isSupported = v => typeof v === 'string' && SUPPORTED.includes(v);
  const lookup = (loc, key) => (catalogs[loc] ? catalogs[loc][key] : undefined);

  function format(loc, str, params) {
    return str.replace(/\{(\w+)\}/g, (m, k) => {
      if (!params || !(k in params)) return m;
      const v = params[k];
      if (v && typeof v === 'object' && v.$t) return tIn(loc, v.$t, v.params || {});
      return v === null || v === undefined ? '' : String(v);
    });
  }
  /** Traduce `key` en el idioma `loc` (respaldo: inglés; último recurso: la propia clave). */
  function tIn(loc, key, params) {
    let k = key;
    if (params && typeof params.count === 'number') {
      const pk = key + (params.count === 1 ? '_one' : '_other');
      if (lookup(loc, pk) !== undefined || lookup(DEFAULT, pk) !== undefined) k = pk;
    }
    const s = lookup(loc, k) !== undefined ? lookup(loc, k) : lookup(DEFAULT, k);
    return s === undefined ? key : format(loc, s, params || {});
  }
  const has = key => lookup(locale, key) !== undefined || lookup(DEFAULT, key) !== undefined;

  /* ---------- navegador: elección y persistencia del idioma ---------- */
  function stored() {
    try { const v = localStorage.getItem(STORAGE_KEY); return isSupported(v) ? v : null; } catch (e) { return null; }
  }
  function remember(loc) {
    try { localStorage.setItem(STORAGE_KEY, loc); } catch (e) { /* sin almacenamiento: dura mientras la página esté abierta */ }
    try { document.cookie = `${COOKIE_KEY}=${loc}; path=/; max-age=31536000; SameSite=Lax`; } catch (e) {}
  }
  /** Cambia el idioma activo. `persist`: lo recuerda como elección del usuario. */
  function setLocale(loc, persist) {
    if (!isSupported(loc)) loc = DEFAULT;
    const changed = loc !== locale;
    locale = loc;
    if (typeof document !== 'undefined') document.documentElement.lang = loc;
    if (persist) remember(loc);
    if (changed) listeners.forEach(fn => { try { fn(loc); } catch (e) { console.error(e); } });
    return loc;
  }
  /** Arranque en el navegador: ?lang=xx > elección guardada > inglés (nunca el idioma del navegador). */
  function init() {
    let loc = stored() || DEFAULT;
    try { const q = new URLSearchParams(location.search).get('lang'); if (isSupported(q)) { loc = q; remember(q); } } catch (e) {}
    setLocale(loc, false); return locale;
  }
  /** Idioma indicado en una cabecera Cookie (páginas del servidor). */
  function fromCookie(header) {
    const m = String(header || '').match(new RegExp('(?:^|;\\s*)' + COOKIE_KEY + '=([a-z]{2})'));
    return m && isSupported(m[1]) ? m[1] : DEFAULT;
  }

  return {
    DEFAULT, SUPPORTED, isSupported, catalogs, tIn, has, setLocale, init, fromCookie,
    t: (key, params) => tIn(locale, key, params),
    get locale() { return locale; },
    onChange: fn => { listeners.push(fn); },
  };
});
