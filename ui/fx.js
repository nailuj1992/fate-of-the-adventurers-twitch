/*
 * ui/fx.js — Partículas mágicas (solo estéticas).
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
/* =====================================================================
   PARTÍCULAS MÁGICAS (solo estéticas)
   ===================================================================== */
const cv = $('fx'), cx = cv.getContext('2d'), frame = $('frame');
let parts = [];
const COLORS = ['#e3b956','#f6e2a6','#3fbf9a','#9fd8ff'];
const XUEN_COLORS = ['#8fdcff','#ffffff','#a77bff','#5fd0ff'];     // azul eléctrico, blanco y violeta
const pickColor = () => { const p = frame.classList.contains('xuen') ? XUEN_COLORS : COLORS; return p[secureIndex(p.length)]; };
function fit(){ cv.width = frame.clientWidth; cv.height = frame.clientHeight; }
function spawn(x,y,vx,vy,life,size,col,glow){ parts.push({x,y,vx,vy,life,max:life,size,col,glow}); }
function ambient(){
  const ambientCount = parts.filter(p => !p.glow).length;
  if (ambientCount < AMBIENT_PARTICLES && randFloat() < .3)
    spawn(randFloat()*cv.width, cv.height+10, (randFloat()-.5)*.4, -(.3+randFloat()*.7), 500+randFloat()*400, 1+randFloat()*2.5, pickColor(), false);
}
function burst(n){
  const x = cv.width/2, y = cv.height*.45;
  for (let i = 0; i < n; i++){
    const a = randFloat()*Math.PI*2, v = 2+randFloat()*7;
    spawn(x, y, Math.cos(a)*v, Math.sin(a)*v - 1.5, 70+randFloat()*70, 2+randFloat()*3.5, pickColor(), true);
  }
}
function loop(){
  cx.clearRect(0,0,cv.width,cv.height); ambient();
  parts = parts.filter(p => p.life-- > 0 && p.y > -20);
  for (const p of parts){
    p.x += p.vx; p.y += p.vy; if (p.glow){ p.vy += .07; p.vx *= .985; }
    cx.globalAlpha = Math.max(0, Math.min(1, p.life/p.max*(p.glow?1.4:2)));
    cx.fillStyle = p.col; cx.shadowColor = p.col; cx.shadowBlur = 10;
    cx.beginPath(); cx.arc(p.x, p.y, p.size, 0, 6.283); cx.fill();
  }
  requestAnimationFrame(loop);
}
/** Arranca los efectos: ajuste al tamaño del marco, bucle de partículas y sonido ambiente (si lo hay). */
function startFx(){
  window.addEventListener('resize', fit); fit();
  loop();
  if (SOUNDS.ambient){ try { const a = new Audio(SOUNDS.ambient); a.loop = true; document.addEventListener('click', () => a.play().catch(()=>{}), {once:true}); } catch(e){} }
}
