/*
 * ui/util.js — Personalización, utilidades, aleatoriedad visual e ilustraciones de los Celestiales.
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
/* =====================================================================
   PERSONALIZACIÓN · TEXTOS, NOMBRES, TIEMPOS Y SONIDOS
   ===================================================================== */

// Color de brillo de cada Celestial. Los textos narrativos (título, introducción y mensaje de victoria) están en los
// catálogos de idioma: locales/en.js y locales/es.js → story.<celestial>.*   ({name} se sustituye por el nombre del ganador).
const STORY = [
  { key:'niuzao', glow:'#7fa6e8' },
  { key:'yulon',  glow:'#3fbf9a' },
  { key:'chiji',  glow:'#ff9a5a' },
  { key:'xuen',   glow:'#8fdcff' }      // ronda extraordinaria de recuperación
];
// 0-2 = Niuzao / Yu'lon / Chi-ji (rotación circular); 3 = Xuen (solo recuperación). Los textos siguen el idioma activo.
const celInfo = i => { const k = STORY[i].key; return { glow: STORY[i].glow,
  get title(){ return I18n.t(`story.${k}.title`); }, get intro(){ return I18n.t(`story.${k}.intro`); }, get victory(){ return I18n.t(`story.${k}.victory`); },
  get long(){ return I18n.t(`celestial.${k}.long`); } }; };      // .long = nombre completo («Niuzao, el Buey Negro»)

// Cantidad de premios y TODOS los tiempos se configuran desde el panel «Configuración» (valores por defecto: core.js → DEFAULT_CONFIG).
const AMBIENT_PARTICLES = 70;    // partículas mágicas de fondo

// Sonidos: rellena con la ruta de un archivo (p. ej. 'sonidos/gong.mp3'). Vacío = silencio.
const SOUNDS = { countdown:'', roll:'', reveal:'', expire:'', ambient:'' };

/* =====================================================================
   UTILIDADES
   ===================================================================== */
const $ = id => document.getElementById(id);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ÚNICA fuente de aleatoriedad: crypto.getRandomValues (no se usa Math.random en ningún sitio).
function rand32(){ const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0]; }
function randFloat(){ return rand32() / 4294967296; }   // solo para efectos visuales
// Para elegir un índice (colores, nombre inicial del roll) se usa Core.secureIndex: la misma extracción uniforme que el motor.
function play(name){
  const src = SOUNDS[name]; if (!src) return;
  try { const a = new Audio(src); a.play().catch(()=>{}); } catch(e){ /* el sonido es opcional: sin audio disponible o con un archivo inválido simplemente no suena */ }
}
// Fuerza al navegador a recalcular el diseño (para poder reiniciar una animación CSS quitando y volviendo a poner su clase o estilo).
const forceReflow = el => el.getBoundingClientRect();
const fmtTime = d => d.toLocaleTimeString('es-ES');

/* =====================================================================
   ILUSTRACIONES (SVG en línea). Sustituye por <img> si prefieres arte propio.
   ===================================================================== */
const EMBLEMS = [
  // Imágenes en la carpeta img/. Para cambiarlas, sustituye los archivos o edita estas rutas.
  // object-position encuadra la cara dentro del medallón circular.
  '<img class="emb" src="img/niuzao.png" alt="Niuzao" style="object-position:50% 30%">',
  '<img class="emb" src="img/yulon.webp" alt="Yu&#39;lon" style="object-position:30% 40%">',
  '<img class="emb" src="img/chiji.png" alt="Chi-ji" style="object-position:50% 25%">',
  '<img class="emb" src="img/xuen.webp" alt="Xuen" style="object-position:50% 30%">'   // ronda extraordinaria de Xuen
];

