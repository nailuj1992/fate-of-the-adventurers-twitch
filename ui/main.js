/*
 * ui/main.js — Arranque: idioma, campos de configuración, efectos y flujo de estados del adaptador. Se carga el último.
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
I18n.init();                   // idioma: ?lang= > elección guardada > inglés (nunca el del navegador)
applyStatic(); buildCfgFields();
startFx();

boot();                        // arranca el flujo de estados (según la versión)
