'use strict';
/**
 * Texto para la consola del servidor: sin saltos de línea ni caracteres de control (evita inyectar líneas falsas en el registro con
 * mensajes que pueden venir de la red o de la URL de retorno de Twitch) y con una longitud máxima.
 */
const MAX_LOG_CHARS = 300;

const forLog = s => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_LOG_CHARS);

module.exports = { forLog, MAX_LOG_CHARS };
