/*
 * core.js — Núcleo compartido de «El destino de los aventureros: El juicio de los Celestiales».
 * Sin DOM, sin red y sin dependencias: lo usan igual el servidor Twitch (game.js) y la versión manual (navegador).
 * Contiene: configuración central (valores por defecto, límites y validación), rotación de Celestiales,
 * reglas de elegibilidad y el motor del evento (fases, temporizadores, resolución, historial).
 *
 * NOTA: este archivo existe como copia idéntica en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual. Cualquier cambio va a los dos, byte a byte
 * (si ambos están clonados uno junto al otro, una prueba del repositorio Twitch lo comprueba).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n'));
  else root.Core = factory(root.I18n);
})(typeof self !== 'undefined' ? self : this, function (I18n) {
  'use strict';

  /* =====================================================================
     CONFIGURACIÓN CENTRAL  ← aquí viven TODOS los tiempos y límites
     ===================================================================== */
  const DEFAULT_CONFIG = {
    prizes: 3,            // cantidad de ganadores / rondas principales
    confirmSec: 120,      // plazo para confirmar presencia (empieza cuando el nombre ya es visible y se escucha el chat)
    countdownSec: 5,      // cuenta regresiva antes de cada selección
    rollSec: 8,           // animación de selección
    revealSec: 5,         // revelación del elegido (el plazo de confirmación empieza al terminar)
    winnerSec: 8,         // visualización del ganador confirmado
    absentSec: 5,         // visualización de un participante ausente
    transitionSec: 5,     // transición entre rondas (y duración del aviso «ronda desierta»)
    introSec: 8,          // introducción de cada Celestial
    lateSec: 3,           // avanzado: margen de entrega de un mensaje enviado justo antes de 0:00 (0 = estricto)
    graceSec: 30,         // avanzado: plazo extra tras recuperar la conexión si hubo una caída
  };
  const MAX_PRIZES = 50;
  const LIMITS = {        // [mín, máx] (enteros)
    prizes: [1, MAX_PRIZES], confirmSec: [10, 600], countdownSec: [0, 30], rollSec: [0, 60], revealSec: [0, 30],
    winnerSec: [0, 60], absentSec: [0, 60], transitionSec: [0, 60], introSec: [0, 60], lateSec: [0, 10], graceSec: [0, 300],
  };
  // Orden de las opciones en el panel. Etiquetas y textos de ayuda: catálogos (cfg.label.<clave>, cfg.help.<clave>).
  const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

  // Reglas de los datos que escribe el presentador. La interfaz las usa para avisar al instante; quien valida de verdad
  // (el servidor de Twitch o el motor) usa la MISMA definición, así que nunca pueden discrepar.
  const LOGIN_RE = /^\w{1,25}$/;       // usuario de Twitch: letras, números y «_» (1–25); \w sin la bandera u = [A-Za-z0-9_]

  /**
   * Valida una configuración. Acepta números o textos numéricos enteros. Devuelve {ok, config, errors}.
   * Cada error es un código traducible por la interfaz: {code:'number'|'integer'|'range'|'max_participants', min?, max?, count?}.
   * `participantCount` (opcional): si se indica, la cantidad de premios no puede superarlo.
   * Con `trusted` (solo pruebas) no se aplican los rangos ni la entereza.
   */
  function validateConfig(raw, participantCount, trusted) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const config = {}, errors = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      let v = src[key];
      if (v === undefined || v === null) { config[key] = DEFAULT_CONFIG[key]; continue; }
      if (typeof v === 'string') v = v.trim() === '' ? NaN : Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors[key] = { code: 'number' }; continue; }
      if (!trusted) {
        if (!Number.isInteger(v)) { errors[key] = { code: 'integer' }; continue; }
        const [lo, hi] = LIMITS[key];
        if (v < lo || v > hi) { errors[key] = { code: 'range', min: lo, max: hi }; continue; }
      }
      config[key] = v;
    }
    if (!errors.prizes && participantCount !== undefined && participantCount !== null && config.prizes > participantCount)
      errors.prizes = { code: 'max_participants', count: participantCount };
    return { ok: Object.keys(errors).length === 0, config, errors };
  }
  const toMs = c => ({ confirm: c.confirmSec * 1000, countdown: c.countdownSec * 1000, roll: c.rollSec * 1000, reveal: c.revealSec * 1000,
    winner: c.winnerSec * 1000, absent: c.absentSec * 1000, transition: c.transitionSec * 1000, intro: c.introSec * 1000,
    late: c.lateSec * 1000, grace: c.graceSec * 1000 });

  /* =====================================================================
     CELESTIALES Y ROTACIÓN
     ===================================================================== */
  const CELESTIALS = [
    { index: 0, key: 'niuzao', name: 'Niuzao' },
    { index: 1, key: 'yulon', name: "Yu'lon" },
    { index: 2, key: 'chiji', name: 'Chi-ji' },
  ];
  const XUEN = { index: 3, key: 'xuen', name: 'Xuen', xuen: true };      // exclusivo de las rondas de recuperación

  /** Celestial de la ronda `round` (0..prizes-1 = principales, rotación circular; round >= prizes = recuperación con Xuen). */
  const roundCelestial = (round, prizes) => (round >= prizes ? XUEN : CELESTIALS[round % CELESTIALS.length]);
  /** Vista previa del orden: [{prize: 1, celestial: 'Niuzao'}, …] */
  const preview = n => Array.from({ length: n }, (_, k) => ({ prize: k + 1, celestial: CELESTIALS[k % CELESTIALS.length].name, index: k % CELESTIALS.length }));

  /* =====================================================================
     ALEATORIEDAD SEGURA (uniforme, sin sesgo de módulo)
     ===================================================================== */
  function secureIndex(n) {
    const c = globalThis.crypto;
    const range = 4294967296, limit = range - (range % n), b = new Uint32Array(1);
    let x; do { c.getRandomValues(b); x = b[0]; } while (x >= limit);
    return x % n;
  }
  // Barajado Fisher-Yates con la misma aleatoriedad segura (todas las permutaciones equiprobables).
  function secureShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = secureIndex(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /* =====================================================================
     MOTOR DEL EVENTO
     Fases (cada una con su duración configurable; el servidor/página solo la representa):
       intro → countdown → rolling → reveal → confirming → [won | absent] → transition → intro …
     Todas las fases pasan por UN solo programador (schedule) que cancela la anterior: no puede haber temporizadores duplicados.
     ===================================================================== */
  const LIVE = ['reveal', 'confirming', 'paused', 'verifying'];            // estados en los que se escucha el chat (y corre el reloj del candidato)
  const REVEALED = [...LIVE, 'won', 'absent', 'deserted'];                 // estados en los que el nombre del candidato ya puede viajar a la interfaz
  const SKIPPABLE = ['intro', 'won', 'absent', 'transition', 'deserted'];  // esperas que el presentador puede saltar
  const ok = () => ({ ok: true });
  // Los errores viajan como código + parámetros (la interfaz los traduce: err.<código>); `error` lleva el texto en inglés por si hiciera falta.
  const err = (code, params = {}) => ({ ok: false, errorKey: 'err.' + code, errorParams: params, error: I18n.tIn('en', 'err.' + code, params) });

  /**
   * ÚNICA definición del estado del evento: lo usan resetState (valores iniciales) y snapshot/restore (qué se guarda).
   * Añadir un campo aquí basta para que se reinicie y sobreviva a un F5; `ms` (derivado de cfg) y `ph` (se guarda aparte) no se persisten.
   */
  const freshState = () => ({
    screen: 'admin', status: 'idle', round: 0, prizes: 0, cfg: null, ms: null,
    participants: [],     // [{name, key, userId?}] lista completa, fija durante el evento
    winners: [],          // [{name, key, round, prize, source, at}]  round = ronda donde ganó; prize = premio que se lleva
    absent: [],           // [{name, key, round, reason, at}]  ausencias: excluyen SOLO de esa ronda (en Xuen: de toda la ronda)
    disqualified: [],     // [{name, key, round, reason, at}]  descalificación global
    deserted: [],         // índices de rondas principales declaradas desiertas
    xuen: { total: 0 },   // premios pendientes con los que arrancó la recuperación
    outcome: null, history: [], cur: null, final: null, rollNames: [], ph: null, step: null, replacement: false,
    eventId: null, seq: 0,
  });
  const PERSISTED = Object.keys(freshState()).filter(k => k !== 'ms' && k !== 'ph');

  class Engine {
    /**
     * deps: { now, setT, clearT, pick, shuffle, connection(), onChange(), onLog(entry) }
     * shuffle(lista) → lista: por defecto barajado seguro al iniciar; con un `pick` inyectado (pruebas) no se baraja salvo que se pase `shuffle`.
     * La conexión (Twitch) solo importa a la versión integrada; la manual pasa siempre 'connected'.
     */
    constructor(deps = {}) {
      this.o = {
        now: deps.now || (() => Date.now()),
        setT: deps.setT || ((f, m) => setTimeout(f, m)),
        clearT: deps.clearT || (t => clearTimeout(t)),
        pick: deps.pick || secureIndex,
        shuffle: deps.shuffle || (deps.pick ? null : secureShuffle),
        connection: deps.connection || (() => 'connected'),
        onChange: deps.onChange || (() => {}),
        onLog: deps.onLog || (() => {}),
      };
      this.seenChat = new Set();
      this.resetState();
    }

    resetState() {
      if (this.ph) { this.o.clearT(this.ph.handle); }
      Object.assign(this, freshState());
    }

    /* ---------- utilidades ---------- */
    get inXuen() { return this.screen === 'stage' && this.round >= this.prizes; }
    celestial(round = this.round) { return roundCelestial(round, this.prizes); }
    /** Premios (0..prizes-1) sin ganador, en orden. */
    pendingPrizes() { const o = []; for (let i = 0; i < this.prizes; i++) if (!this.winners.some(w => w.prize === i)) o.push(i); return o; }
    /** Elegibles de la ronda `round`: todos − ganadores − descalificados globales − ausentes DE ESA ronda − candidato pendiente. */
    eligible(round = this.round) {
      const out = new Set([...this.winners, ...this.disqualified].map(x => x.key));
      for (const a of this.absent) if (a.round === round) out.add(a.key);
      if (this.cur && !this.cur.settled) out.add(this.cur.key);
      return this.participants.filter(p => !out.has(p.key));
    }
    change() { this.o.onChange(); }
    // El historial guarda CLAVE + PARÁMETROS (la interfaz lo traduce al idioma activo) y `text` en inglés (para data/historial.jsonl).
    // `prize` (índice 0-based) puede forzarse: p. ej. el premio que acaba de recibir un ganador de Xuen ya no figura como pendiente.
    log(kind, key, params = {}, prize) {
      const r = this.round, x = this.round >= this.prizes;
      if (prize === undefined) prize = this.screen !== 'stage' ? null : (x ? (this.pendingPrizes()[0] ?? null) : r);
      const e = { id: ++this.seq, t: this.o.now(), kind, key, params, text: I18n.tIn('en', 'log.' + key, params), phase: x ? 'recovery' : 'main',
        celestial: this.screen === 'stage' ? this.celestial().name : null, prize: prize === null ? null : prize + 1 };
      this.history.push(e); this.o.onLog(e, this.eventId); return e;
    }

    /* ---------- programador único de fases ---------- */
    schedule(name, ms) {
      this.clearPhase();
      const ph = { name, total: ms, endsAt: this.o.now() + ms, remaining: ms, paused: false, handle: null };
      this.ph = ph; ph.handle = this.o.setT(() => this.fire(ph), ms);
    }
    clearPhase() { if (this.ph) { this.o.clearT(this.ph.handle); this.ph = null; } }
    fire(ph) {                                    // un callback de una fase ya sustituida o pausada se ignora
      if (this.ph !== ph || ph.paused) return;
      this.ph = null; this.phaseFn(ph.name)();
    }
    phaseFn(name) {
      switch (name) {
        case 'intro': return () => this.startCountdown(false);
        case 'countdown': return () => this.doDraw();
        case 'rolling': return () => this.reveal();
        case 'reveal': return () => this.beginConfirm();
        case 'confirming': case 'grace': return () => this.onDeadline();
        case 'closing': return () => this.finalExpire();
        case 'won': return () => this.afterWon();
        case 'absent': return () => this.startCountdown(true);
        case 'transition': return () => this.gotoNext();
        case 'deserted': return () => this.afterDeserted();
        default: return () => {};
      }
    }
    enter(status, name, ms) { this.status = status; this.schedule(name, ms); this.change(); }

    /* ---------- inicio ---------- */
    start(participants, cfg, eventId) {
      if (this.screen !== 'admin') return err('already_running');
      if (!cfg || !participants || participants.length < cfg.prizes) return err('not_enough_participants');
      this.resetState(); this.seenChat.clear();
      this.eventId = eventId || new Date(this.o.now()).toISOString();
      this.cfg = { ...cfg }; this.ms = toMs(cfg); this.prizes = cfg.prizes;     // configuración BLOQUEADA durante el evento
      this.participants = participants.map(p => ({ ...p })); this.screen = 'stage';
      if (this.o.shuffle) this.participants = this.o.shuffle(this.participants);   // el orden de inscripción no influye en nada
      this.log('sys', 'event_started', { prizes: this.prizes, participants: this.participants.length,
        rotation: preview(Math.min(this.prizes, 6)).map(p => p.celestial).join(' → ') + (this.prizes > 6 ? ' …' : '') });
      if (this.o.shuffle) this.log('sys', 'shuffled', { count: this.participants.length });
      this.beginRound(0); return ok();
    }

    beginRound(round) {
      this.round = round; this.cur = null; this.outcome = null; this.step = null;
      if (!this.eligible().length) { this.desertRound(); return; }
      this.log('ronda', 'round_begin', { prize: round + 1, prizes: this.prizes, celestial: this.celestial().name });
      this.enter('intro', 'intro', this.ms.intro);
    }
    startXuen() {
      const pending = this.pendingPrizes();
      this.round = this.prizes; this.cur = null; this.outcome = null; this.step = null; this.xuen = { total: pending.length };
      this.log('xuen', 'xuen_activated', { count: pending.length, list: pending.map(i => '#' + (i + 1)).join(', ') });
      if (!this.eligible().length) { this.desertRound(); return; }
      this.enter('intro', 'intro', this.ms.intro);
    }

    /* ---------- selección ---------- */
    startCountdown(replacement) {
      this.replacement = !!replacement;
      // Un solo elegible (p. ej. los demás no respondieron o ya ganaron, también en Xuen): no hay nada que sortear, se salta la cuenta atrás y el roll.
      if (this.eligible().length === 1) { this.doDraw(true); return; }
      this.enter('countdown', 'countdown', this.ms.countdown);
    }
    // EXTRACCIÓN: ocurre aquí, al terminar la cuenta atrás; nunca se calcula por adelantado. El elegido sale del conjunto al instante.
    doDraw(onlyOne = false) {
      const elig = this.eligible();
      if (!elig.length) { this.desertRound(); return; }
      const pick = elig[this.o.pick(elig.length)];
      this.cur = { name: pick.name, key: pick.key, userId: pick.userId || null, round: this.round, settled: false,
        total: this.ms.confirm, deadline: 0, gap: false, closing: false, grace: false, revealedAt: 0 };
      this.rollNames = onlyOne ? [] : elig.map(p => p.name);
      if (onlyOne) this.log('sys', 'last_candidate', { name: pick.name });
      this.log('sel', (this.inXuen ? 'draw_xuen' : 'draw_main') + (this.replacement ? '_repl' : ''),
        { prize: (this.inXuen ? this.pendingPrizes()[0] : this.round) + 1, celestial: this.celestial().name, name: pick.name });
      if (onlyOne) this.reveal(); else this.enter('rolling', 'rolling', this.ms.roll);
    }
    // Revelación: el nombre ya es visible y se empieza a escuchar el chat; el plazo de confirmación AÚN no corre.
    reveal() {
      this.rollNames = []; this.cur.revealedAt = this.o.now();
      this.cur.gap = this.o.connection() !== 'connected';
      if (this.cur.gap) this.log('sys', 'no_conn_reveal');
      this.enter('reveal', 'reveal', this.ms.reveal);
    }
    beginConfirm() {
      this.cur.total = this.ms.confirm; this.cur.deadline = this.o.now() + this.ms.confirm;
      this.enter('confirming', 'confirming', this.ms.confirm);
    }
    // Fin del plazo: margen de entrega y, si hubo incertidumbre de conexión, verificación en vez de ausencia.
    onDeadline() {
      const c = this.cur; if (!c || c.settled || this.status !== 'confirming') return;
      c.closing = true; this.enter('confirming', 'closing', this.ms.late);
    }
    finalExpire() {
      const c = this.cur; if (!c || c.settled || this.status !== 'confirming') return;
      if (this.o.connection() !== 'connected' || c.gap) {
        c.closing = false; this.status = 'verifying'; this.clearPhase();
        this.log('sys', 'verifying', { name: c.name });
        this.change();
        if (this.o.connection() === 'connected') this.startGrace();
        return;
      }
      this.settle('timeout', 'timer');
    }
    // Conexión recuperada: Twitch no reenvía mensajes perdidos, así que se concede un plazo extra.
    startGrace() {
      const c = this.cur; if (!c || c.settled || this.status !== 'verifying') return;
      c.gap = false; c.grace = true; c.closing = false; c.total = this.ms.grace; c.deadline = this.o.now() + this.ms.grace;
      this.log('sys', 'grace', { name: c.name, sec: Math.round(this.ms.grace / 1000) });
      this.enter('confirming', 'grace', this.ms.grace);
    }
    onConnection(status) {
      const c = this.cur;
      if (c && !c.settled && LIVE.includes(this.status)) {
        if (status !== 'connected' && !c.gap) {
          c.gap = true; this.log('sys', 'conn_interrupted', { status });
        } else if (status === 'connected' && this.status === 'verifying') this.startGrace();
      }
      this.change();
    }
    // Mensaje de chat → ¿confirma al candidato? Se compara el ID de usuario que entrega Twitch.
    handleChat(m) {
      if (m.messageId) { if (this.seenChat.has(m.messageId)) return; this.seenChat.add(m.messageId); if (this.seenChat.size > 5000) this.seenChat.delete(this.seenChat.values().next().value); }
      const c = this.cur;
      if (!c || c.settled || !LIVE.includes(this.status)) return;
      if (m.receivedAt < c.revealedAt) return;               // solo cuentan mensajes posteriores a la revelación
      if (!c.userId || m.chatterId !== c.userId) return;     // cualquier otro usuario se ignora
      this.settle('confirmed', 'chat', { messageId: m.messageId });
    }

    /* ---------- resolución: único punto, el primer resultado válido gana ---------- */
    //   confirmed    → ganador (excluido de todo lo posterior). En Xuen se lleva el primer premio pendiente.
    //   timeout      → ausencia: excluido SOLO de la ronda actual (en Xuen, de toda su ronda).
    //   disqualified → descalificación global con motivo: excluido de todas las rondas restantes, Xuen incluida.
    settle(result, source, extra = {}) {
      const c = this.cur;
      if (!c || c.settled || !LIVE.includes(this.status)) return false;
      c.settled = true; c.closing = false; this.clearPhase();
      const x = c.round >= this.prizes, who = this.celestial(c.round).name;
      const rec = { name: c.name, key: c.key, round: c.round, at: this.o.now() };
      if (result === 'confirmed') {
        const prize = x ? this.pendingPrizes()[0] : c.round;
        this.winners.push({ ...rec, prize, source });
        this.outcome = null;
        this.log('conf', x ? 'won_xuen' : 'won_main', { prize: prize + 1, celestial: who, name: c.name,
          via: { $t: source === 'chat' ? 'log.via.chat' : 'log.via.manual' } }, prize);
        this.enter('won', 'won', this.ms.winner); return true;
      }
      if (result === 'timeout') {
        this.absent.push({ ...rec, reason: 'timeout' }); this.outcome = 'timeout';
        this.log('aus', x ? 'absent_xuen' : 'absent_main', { prize: c.round + 1, celestial: who, name: c.name });
      } else {
        this.disqualified.push({ ...rec, reason: extra.reason }); this.outcome = 'disqualified';
        this.log('dq', 'dq', { name: c.name, reason: extra.reason });
      }
      if (this.eligible().length) this.enter('absent', 'absent', this.ms.absent);   // mismo Celestial: se selecciona a otro
      else this.desertRound();
      return true;
    }

    /* ---------- fin de ronda ---------- */
    // Sin elegibles: una ronda principal se declara desierta (su premio pasa a recuperación); en Xuen, candidatos agotados.
    desertRound() {
      if (this.round >= this.prizes) this.log('des', 'xuen_exhausted', { count: this.pendingPrizes().length });
      else {
        this.deserted.push(this.round);
        this.log('des', 'round_deserted', { prize: this.round + 1, celestial: this.celestial().name });
      }
      this.enter('deserted', 'deserted', this.ms.transition);
    }
    // ¿Qué sigue? El avance NO depende del número de ganadores.
    nextStep(endedBy) {
      const pending = this.pendingPrizes().length;
      if (this.round >= this.prizes) {
        if (pending === 0) return { type: 'finish', kind: 'complete' };
        if (endedBy === 'deserted') return { type: 'finish', kind: 'incomplete' };
        return { type: 'xuen-next' };
      }
      if (this.round + 1 >= this.prizes) return pending === 0 ? { type: 'finish', kind: 'complete' } : { type: 'xuen' };
      return { type: 'round', round: this.round + 1 };
    }
    afterWon() {
      const step = this.nextStep('won');
      if (step.type === 'finish') { this.finish(step.kind); return; }
      this.step = step; this.enter('transition', 'transition', this.ms.transition);
    }
    afterDeserted() {
      const step = this.nextStep('deserted');
      if (step.type === 'finish') { this.finish(step.kind); return; }
      this.runStep(step);
    }
    gotoNext() { this.runStep(this.step || this.nextStep('won')); }
    runStep(step) {
      this.step = null;
      if (step.type === 'round') this.beginRound(step.round);
      else if (step.type === 'xuen') this.startXuen();
      else if (step.type === 'xuen-next') {
        this.cur = null; this.outcome = null;
        if (!this.eligible().length) this.desertRound(); else this.startCountdown(false);
      }
    }
    finish(kind) {
      this.clearPhase(); this.final = kind; this.screen = 'final'; this.status = 'idle'; this.step = null;
      const open = this.pendingPrizes();
      const lines = this.winners.slice().sort((x, y) => x.prize - y.prize)
        .map(w => `#${w.prize + 1} (${CELESTIALS[w.prize % CELESTIALS.length].name})=${w.name}${w.round >= this.prizes ? ' [Xuen]' : ''}`);
      const openList = open.map(i => '#' + (i + 1)).join(', ');
      if (kind === 'complete') this.log('sys', 'finish_complete');
      else if (kind === 'incomplete') this.log('sys', 'finish_incomplete', { winners: this.winners.length, prizes: this.prizes, count: open.length });
      else this.log('sys', 'finish_cancelled');
      this.log('result', open.length ? (lines.length ? 'result_open' : 'result_none_open') : (lines.length ? 'result' : 'result_none'),
        { list: lines.join(', '), open: openList });
      this.change();
    }

    /* ---------- órdenes del presentador ---------- */
    confirmManual() { return this.settle('confirmed', 'manual') ? ok() : err('no_active_confirm'); }
    // Descalificación GLOBAL del candidato actual por incumplir las reglas; exige motivo (la interfaz pide confirmación).
    disqualify(reason) {
      const r = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (r.length < 3) return err('reason_required');
      return this.settle('disqualified', 'manual', { reason: r }) ? ok() : err('no_active_confirm');
    }
    // Pausa genérica de la fase con tiempo en curso (en la confirmación, además, se muestra el aviso de pausa).
    pauseToggle() {
      const ph = this.ph;
      if (!ph) return err('no_timed_phase');
      if (!ph.paused) {
        if (ph.name === 'closing') return err('no_pause_closing');
        ph.remaining = Math.max(0, ph.endsAt - this.o.now()); this.o.clearT(ph.handle); ph.handle = null; ph.paused = true;
        if (this.status === 'confirming') this.status = 'paused';
        this.log('sys', 'paused', { sec: Math.ceil(ph.remaining / 1000), phase: { $t: 'phase.' + ph.name } });
      } else {
        ph.paused = false; ph.endsAt = this.o.now() + ph.remaining; ph.handle = this.o.setT(() => this.fire(ph), ph.remaining);
        if (this.status === 'paused') { this.status = 'confirming'; if (this.cur) this.cur.deadline = ph.endsAt; }
        this.log('sys', 'resumed');
      }
      this.change(); return ok();
    }
    // Salta una espera de visualización (introducción, ganador, ausente, transición, ronda desierta).
    skip() {
      const ph = this.ph;
      if (!ph || ph.paused || !SKIPPABLE.includes(ph.name)) return err('cannot_skip');
      this.o.clearT(ph.handle); this.ph = null; this.phaseFn(ph.name)(); return ok();
    }
    cancel() {
      if (this.screen !== 'stage') return err('no_event');
      this.clearPhase();
      if (this.cur && !this.cur.settled) {
        this.cur.settled = true;
        this.log('sys', 'cancelled_pending', { name: this.cur.name });
      } else this.log('sys', 'cancelled_host');
      this.finish('cancelled'); return ok();
    }
    reset() {
      if (this.screen !== 'stage') return err('no_event');
      this.log('sys', 'reset_note');
      this.resetState(); this.change(); return ok();
    }
    back() {
      if (this.screen !== 'final') return err('back_only_final');
      this.resetState(); this.change(); return ok();
    }

    /* ---------- vista pública (lo único que consume la interfaz) ---------- */
    view() { return buildView(this); }

    /* ---------- persistencia (versión manual: sobrevivir a un F5) ---------- */
    snapshot() {
      const ph = this.ph && { name: this.ph.name, total: this.ph.total, endsAt: this.ph.endsAt, remaining: this.ph.remaining, paused: this.ph.paused };
      return JSON.parse(JSON.stringify({ v: 1, ...Object.fromEntries(PERSISTED.map(k => [k, this[k]])), ph: ph || null }));
    }
    restore(s) {
      if (!s || s.v !== 1) return false;
      this.resetState(); this.seenChat.clear();
      Object.assign(this, Object.fromEntries(PERSISTED.map(k => [k, s[k]])),
        { ms: s.cfg ? toMs(s.cfg) : null, rollNames: s.rollNames || [], replacement: !!s.replacement });
      if (s.ph) {
        const ph = { name: s.ph.name, total: s.ph.total, endsAt: s.ph.endsAt, remaining: s.ph.remaining, paused: !!s.ph.paused, handle: null };
        this.ph = ph;
        if (!ph.paused) { const left = Math.max(0, ph.endsAt - this.o.now()); ph.handle = this.o.setT(() => this.fire(ph), left); }
      }
      this.change(); return true;
    }
  }

  /**
   * Proyección de PRESENTACIÓN del estado (lo único que consume la interfaz): función pura de lectura sobre el motor.
   * No modifica nada; el nombre del candidato solo sale cuando ya está revelado.
   */
  function buildView(e) {
    const c = e.cur, st = e.status, now = e.o.now(), ph = e.ph, stage = e.screen === 'stage';
    const revealed = c && REVEALED.includes(st);
    const pending = e.pendingPrizes(), x = e.round >= e.prizes;
    const cel = e.celestial();
    // estado de cada premio
    const finished = e.screen === 'final';
    const prizeStates = Array.from({ length: e.prizes }, (_, i) => {
      const w = e.winners.find(v => v.prize === i), c0 = CELESTIALS[i % CELESTIALS.length];
      let state;
      if (w) state = w.round >= e.prizes ? 'recovered' : 'delivered';
      else if (e.deserted.includes(i)) state = finished ? 'unassigned' : 'in_recovery';
      else if (finished) state = 'unassigned';
      else if (!x && i === e.round) state = 'in_progress';
      else state = 'pending';
      return { prize: i + 1, celestial: c0.name, celIndex: c0.index, state, winner: w ? w.name : null, via: w ? (w.round >= e.prizes ? 'xuen' : 'main') : null };
    });
    // aviso de candidatos insuficientes
    let notice = null;
    if (stage && !x) {
      const resolved = st === 'won' || st === 'deserted' ? e.round + 1 : e.round;
      const people = e.participants.filter(p => !e.winners.some(w => w.key === p.key) && !e.disqualified.some(d => d.key === p.key)).length;
      if (e.prizes - resolved > 0 && people < e.prizes - resolved)
        notice = { key: 'notice.rounds', params: { people, count: e.prizes - resolved } };
    } else if (stage && x && st !== 'won' && st !== 'deserted') {
      const avail = e.eligible(e.prizes).length + (c && !c.settled ? 1 : 0);
      if (avail < pending.length) notice = { key: 'notice.xuen', params: { people: avail, count: pending.length } };
    }
    const timerOn = c && LIVE.includes(st);
    const next = st === 'transition' && e.step ? (e.step.type === 'round'
      ? { kind: 'round', round: e.step.round, prize: e.step.round + 1, celestial: roundCelestial(e.step.round, e.prizes) }
      : e.step.type === 'xuen' ? { kind: 'xuen', celestial: XUEN }
      : { kind: 'xuen-next', celestial: XUEN, prize: pending[0] + 1 }) : null;
    return {
      serverNow: now, screen: e.screen, status: st, round: e.round, prizes: e.prizes,
      celestial: cel, prize: stage && (x ? pending[0] : e.round) != null ? (x ? pending[0] : e.round) + 1 : null,   // premio en juego (1-based)
      phase: ph ? { name: ph.name, total: ph.total, paused: ph.paused, endsAt: ph.paused ? null : ph.endsAt,
                    remaining: ph.paused ? ph.remaining : Math.max(0, ph.endsAt - now) } : null,
      rollNames: st === 'rolling' ? e.rollNames : [],
      candidate: revealed ? c.name : null,           // el nombre no se envía hasta la revelación
      timer: timerOn ? {
        total: c.total, closing: !!(ph && ph.name === 'closing'), grace: !!c.grace, paused: st === 'paused', started: st !== 'reveal',
        deadline: st === 'confirming' && ph && !ph.paused ? ph.endsAt : null,
        remaining: st === 'reveal' ? c.total : st === 'verifying' ? 0 : ph ? (ph.paused ? ph.remaining : Math.max(0, ph.endsAt - now)) : 0,
      } : null,
      flowPaused: !!(ph && ph.paused),
      next,
      xuen: { active: x && stage, total: e.xuen.total, remaining: pending.length, recovered: e.winners.filter(w => w.round >= e.prizes).length },
      prizeStates,
      winners: e.winners, absent: e.absent, disqualified: e.disqualified, deserted: e.deserted, outcome: e.outcome,
      counts: {
        eligible: stage ? e.eligible().length : 0, winners: e.winners.length, disqualified: e.disqualified.length,
        desertedRounds: e.deserted.length, absentEvents: e.absent.length, absentPeople: new Set(e.absent.map(a => a.key)).size,
        prizesPending: stage || finished ? pending.length : 0,
        prizesDelivered: e.winners.filter(w => w.round < e.prizes).length,
        prizesRecovered: e.winners.filter(w => w.round >= e.prizes).length,
      },
      history: e.history.slice(-300), final: e.final, notice,
      skippable: !!(ph && !ph.paused && SKIPPABLE.includes(ph.name)),
    };
  }

  return { DEFAULT_CONFIG, LIMITS, CONFIG_KEYS, MAX_PRIZES, validateConfig, toMs, CELESTIALS, XUEN, roundCelestial, preview, secureIndex, secureShuffle, Engine, LIVE, ok, err, LOGIN_RE };
});
