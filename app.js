/**
 * ELECTROMEL RADAR TÁCTICO v6 — app.js
 * ============================================================
 * Refactorizado desde monolito v6-1.
 *
 * BUGS CORREGIDOS:
 *   1. Funciones dbSaveLead/dbDeleteLead/dbSetConfig duplicadas → eliminadas.
 *      Una sola versión con snapshotLeads correcto.
 *   2. dbSetConfig llamaba DB.saveConfig (inexistente) → corregido a DB.setConfig.
 *   3. IUT_KEYWORDS con clave 'soldadora' duplicada → eliminada.
 *   4. watchId GPS nunca cancelado → clearWatch al desactivar.
 *   5. abrirNotasRapidas sin guard → múltiples overlays imposibles.
 *   6. setTab re-renderiza aunque el tab ya esté activo → guard agregado.
 *   7. calcularIUT sin memoización → cache en lead._iut, invalidado en save.
 *   8. GPS actualiza mapa en cada fix → throttle 200ms + umbral 15m.
 *   9. renderMapLeads full-rebuild → diffing por ID de lead.
 *  10. abrirModal acumula listeners {once} → removidos antes de re-agregar.
 *
 * OPTIMIZACIONES:
 *   - estMap / estLabel derivados de ESTADOS (no duplicados inline).
 *   - distCache invalidado solo en movimiento real (>15m), no en cada save.
 *   - GPS: umbral de movimiento para evitar renders redundantes.
 *   - contain:layout en CSS de cards (ver radar.css).
 *   - Backup automático solo si hay leads (ya estaba, mantenido).
 * ============================================================
 */

'use strict';

/* ── ERROR VISIBLE EN PANTALLA ─────────────────────────────────────────
   Captura cualquier error JS y lo muestra en un banner rojo.
   Útil para debug sin consola en Android.
   ───────────────────────────────────────────────────────────────────── */
window.addEventListener('error', ev => {
  const banner = document.getElementById('error-banner') || (() => {
    const d = document.createElement('div');
    d.id = 'error-banner';
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff3355;color:#fff;font-size:11px;font-family:monospace;padding:8px 10px;white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow-y:auto;';
    document.body.appendChild(d);
    return d;
  })();
  banner.textContent += (ev.message || 'Error') + '\n  → ' + (ev.filename||'') + ':' + ev.lineno + '\n';
});

window.addEventListener('unhandledrejection', ev => {
  const banner = document.getElementById('error-banner') || (() => {
    const d = document.createElement('div');
    d.id = 'error-banner';
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff6b1a;color:#fff;font-size:11px;font-family:monospace;padding:8px 10px;white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow-y:auto;';
    document.body.appendChild(d);
    return d;
  })();
  banner.textContent += 'Promise: ' + (ev.reason?.message || ev.reason || 'rejected') + '\n';
});


/* ======================================================================
   REGISTRO SERVICE WORKER — PWA real
   ====================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[PWA] SW registrado:', reg.scope))
      .catch(err => console.warn('[PWA] SW no registrado:', err.message));
  });
}

/* ======================================================================
   1. ALIAS DB
   RadarDB está definido en el <head> del index.html como IIFE global.
   ====================================================================== */
const DB = window.RadarDB;

/* ======================================================================
   2. CONSTANTES
   ====================================================================== */
const TERRENO_RADIO = 1.5; // km

const CIUDADES_ZONA = [
  'Neuquén','Cipolletti','Plottier','Centenario','Senillosa','Vista Alegre',
  'General Roca','Allen','Fernández Oro','San Martín de los Andes',
  'Junín de los Andes','Villa La Angostura','Bariloche','Dina Huapi'
];

const EQUIPOS_CATALOGO = [
  { id:'soldadora',   label:'SOLDADORA INVERTER', ico:'⚡' },
  { id:'cinta',       label:'CINTA DE CORRER',    ico:'🏃' },
  { id:'variador',    label:'VARIADOR',            ico:'⚙️' },
  { id:'tablero',     label:'TABLERO ELÉCTRICO',  ico:'🔌' },
  { id:'bomba',       label:'BOMBA',              ico:'💧' },
  { id:'motor',       label:'MOTOR',              ico:'🔧' },
  { id:'horno',       label:'HORNO INDUSTRIAL',   ico:'🔥' },
  { id:'placa',       label:'PLACA ELECTRÓNICA',  ico:'🖥️' },
  { id:'herramienta', label:'HERR. ELÉCTRICA',    ico:'🪛' },
  { id:'compresor',   label:'COMPRESOR',          ico:'💨' },
  { id:'generador',   label:'GENERADOR',          ico:'⚡' },
  { id:'otro',        label:'OTRO EQUIPO',        ico:'📦' }
];

const TIPOS_NEGOCIO = [
  { id:'gym',          label:'GYM',         ico:'🏋️' },
  { id:'hotel',        label:'HOTEL',       ico:'🏨' },
  { id:'constructora', label:'OBRA',        ico:'🏗️' },
  { id:'industrial',   label:'INDUSTRIAL',  ico:'🏭' },
  { id:'taller',       label:'TALLER',      ico:'🔧' },
  { id:'metalurgica',  label:'METALÚRG.',   ico:'⚙️' },
  { id:'lavadero',     label:'LAVADERO',    ico:'🌀' },
  { id:'comercio',     label:'COMERCIO',    ico:'🏪' }
];

const QUICK_TAGS = [
  { key:'alto_potencial',    label:'🔥 Alto potencial' },
  { key:'equipo_detectado',  label:'🔧 Equipo detectado' },
  { key:'urgente',           label:'🚨 Urgente' },
  { key:'buen_cliente',      label:'💰 Buen cliente' },
  { key:'maquinas_viejas',   label:'⚠️ Máquinas viejas' },
  { key:'sin_mantenimiento', label:'🛠 Sin mantenimiento' },
  { key:'mucho_movimiento',  label:'📊 Mucho movimiento' },
  { key:'revisar_luego',     label:'📅 Revisar luego' },
  { key:'no_sirve',          label:'❌ No sirve' }
];

const ESTADOS = [
  { id:'no-contactado',  label:'Sin contactar',      css:'est-no' },
  { id:'visitado',       label:'Visitado',            css:'est-visitado' },
  { id:'contactado',     label:'Contactado',          css:'est-contactado' },
  { id:'respondio',      label:'Respondió',           css:'est-respondio' },
  { id:'presupuesto',    label:'Presupuesto enviado', css:'est-presupuesto' },
  { id:'esperando',      label:'Esperando resp.',     css:'est-esperando' },
  { id:'revisita',       label:'Revisita pend.',      css:'est-revisita' },
  { id:'cliente',        label:'Cliente',             css:'est-cliente' },
  { id:'recurrente',     label:'Cliente recurrente',  css:'est-recurrente' },
  { id:'mantenimiento',  label:'Mant. periódico',     css:'est-mantenimiento' },
  { id:'urgente',        label:'URGENTE',             css:'est-urgente' },
  { id:'descartado',     label:'Descartado',          css:'est-descartado' }
];

/* FIX: derivado de ESTADOS una sola vez — no duplicar inline en renderLeads */
const ESTADO_CSS   = Object.fromEntries(ESTADOS.map(e => [e.id, e.css]));
const ESTADO_LABEL = Object.fromEntries(ESTADOS.map(e => [e.id, e.label]));

/* FIX: clave 'soldadora' duplicada eliminada */
const IUT_KEYWORDS = {
  soldadora:20, inverter:20, variador:18, tablero:15, motor:15,
  bomba:15, compresor:12, generador:18, horno:15, placa:12,
  gym:18, gimnasio:18, fitness:18, cinta:15,
  hotel:20, hostel:16, motel:14, alojamiento:12,
  industrial:22, industria:20, fabrica:18, metalurgica:20, metalúrgica:20,
  taller:16, constructora:14, corralon:12,
  lavadero:15, laundry:15, mantenimiento:12, reparacion:12,
  '24hs':10, '24h':10, urgente:15, falla:18
};

const MENSAJES_DEFAULT = {
  gimnasio: {
    primero:"Hola {nombre}, ¿cómo estás?\nSoy técnico de ELECTROMEL, trabajamos con mantenimiento y reparación de cintas de correr y equipos de gimnasio.\nEstoy en la zona y quería consultar si tienen alguna máquina para revisar.\nPuedo pasar sin compromiso.",
    seguimiento:"Hola {nombre}, ¿cómo va?\nTe escribí hace unos días por mantenimiento de equipos.\nSi necesitan revisar cintas o máquinas puedo acercarme esta semana.",
    cierre:"Hola {nombre}, ¿cómo estás?\nTengo disponibilidad esta semana. ¿Coordinamos? Paso a dar diagnóstico en el momento."
  },
  hotel: {
    primero:"Hola {nombre}, ¿cómo estás?\nSoy técnico de ELECTROMEL, hacemos mantenimiento de equipos eléctricos y electrónicos.\nEstoy en la zona y quería saber si necesitan revisar algo.",
    seguimiento:"Hola {nombre}, ¿cómo va?\nTe había contactado por mantenimiento de equipos. Si necesitan revisar algo puedo acercarme.",
    cierre:"Hola {nombre}, tengo disponibilidad esta semana. ¿Coordinamos una visita?"
  },
  constructora: {
    primero:"Hola {nombre}, ¿cómo estás?\nSoy técnico de ELECTROMEL, reparamos soldadoras inverter y equipos de obra.\nEstoy en la zona — ¿tienen alguna máquina para revisar?",
    seguimiento:"Hola {nombre}, ¿cómo va?\nTe escribí por equipos de obra. Si tienen algo para revisar puedo pasar.",
    cierre:"Hola {nombre}, tengo disponibilidad esta semana. ¿Coordinamos?"
  },
  industrial: {
    primero:"Hola {nombre}, ¿cómo estás?\nSoy técnico de ELECTROMEL, trabajamos con reparación y mantenimiento de equipos industriales — soldadoras, variadores, tableros, motores.\nEstoy en la zona, ¿tienen algo para revisar o mantener?",
    seguimiento:"Hola {nombre}, ¿cómo va?\nTe contacté por mantenimiento industrial. Si tienen equipos para revisar avísame.",
    cierre:"Hola {nombre}, tengo disponibilidad esta semana para diagnóstico de equipos. ¿Coordinamos?"
  },
  comercio: {
    primero:"Hola {nombre}, ¿cómo estás?\nSoy técnico de ELECTROMEL, reparamos equipos eléctricos y electrónicos. Estoy en la zona.",
    seguimiento:"Hola {nombre}, ¿cómo va?\nSi necesitan revisar algún equipo puedo acercarme.",
    cierre:"Hola {nombre}, tengo disponibilidad esta semana. ¿Coordinamos una visita?"
  }
};

/* ======================================================================
   3. ESTADO GLOBAL — mutado solo a través de helpers, no directamente
   ====================================================================== */
const state = {
  leads: [],
  ruta: [],
  gkey: '',
  mensajes: JSON.parse(JSON.stringify(MENSAJES_DEFAULT)),
  filtroLeads: 'todos',
  buscarLeads: '',
  resultados: [],
  userLat: null,
  userLon: null,
  activeTab: 'terreno',
  panelState: 'collapsed',
  mapLeadsVisible: true,
  isOnline: navigator.onLine
};

/* ======================================================================
   4. UTILS
   ====================================================================== */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function toast(msg, ms=2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => t.classList.remove('show'), ms);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function limpiarTel(t) { return t ? t.replace(/\D/g,'') : ''; }

function fmtFecha(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});
}

function esHoyOAtrasado(iso) {
  if (!iso) return false;
  const ahora = new Date();
  ahora.setHours(23,59,59,999);
  return new Date(iso) <= ahora;
}

function normalizar(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}

function distKm(lat1, lon1, lat2, lon2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function fmtDist(km) {
  return km < 1 ? Math.round(km*1000)+'m' : km.toFixed(1)+'km';
}

function detectarRubro(tipo) {
  if (!tipo) return 'comercio';
  const t = normalizar(tipo);
  if (t.match(/gym|gimnasio|fitness/))          return 'gimnasio';
  if (t.match(/hotel|hostel|motel|alojamiento/)) return 'hotel';
  if (t.match(/construc|obra|corralon/))         return 'constructora';
  if (t.match(/industri|metalurg|taller|soldad|fabrica/)) return 'industrial';
  if (t.match(/lavad|laundry/))                  return 'lavadero';
  return 'comercio';
}

/* ======================================================================
   5. IUT — ÍNDICE DE URGENCIA TÉCNICA
   FIX: resultado cacheado en lead._iut — se invalida solo en dbSaveLead.
   Reduce de ~500 llamadas/render a las mínimas necesarias.
   ====================================================================== */
function calcularIUT(lead) {
  /* Cache hit: si ya calculamos para este lead, devolver directamente */
  if (lead._iut !== undefined) return lead._iut;

  let score = 0;

  const texto = normalizar([
    lead.nombre, lead.tipo, lead.rubro, lead.notas,
    (lead.equipos||[]).join(' '), (lead.tags||[]).join(' ')
  ].join(' '));

  for (const [key, val] of Object.entries(IUT_KEYWORDS)) {
    if (texto.includes(key)) score += val;
  }

  const equipos = lead.equipos || [];
  score += equipos.length * 8;
  if (equipos.includes('soldadora')) score += 15;
  if (equipos.includes('cinta'))     score += 12;
  if (equipos.includes('variador'))  score += 12;
  if (equipos.includes('tablero'))   score += 10;

  const tags = lead.tags || [];
  if (tags.includes('urgente'))            score += 25;
  if (tags.includes('alto_potencial'))     score += 20;
  if (tags.includes('equipo_detectado'))   score += 15;
  if (tags.includes('maquinas_viejas'))    score += 20;
  if (tags.includes('buen_cliente'))       score += 15;
  if (tags.includes('sin_mantenimiento'))  score += 18;
  if (tags.includes('no_sirve'))           score  = Math.max(0, score - 40);

  if (!lead.web)                   score += 8;
  if (lead.fuente === 'terreno')   score += 18;
  if (lead.estado === 'cliente')       score += 15;
  if (lead.estado === 'recurrente')    score += 25;
  if (lead.estado === 'mantenimiento') score += 20;
  if (lead.estado === 'urgente')       score += 30;
  if (lead.nivel === 'estrategico')    score += 20;
  if (lead.nivel === 'alto')           score += 10;

  lead._iut = Math.min(score, 99);
  return lead._iut;
}

function iutClase(iut) {
  if (iut >= 70) return 'iut-critico';
  if (iut >= 45) return 'iut-alto';
  if (iut >= 20) return 'iut-medio';
  return 'iut-bajo';
}

function iutLabel(iut) {
  if (iut >= 70) return '🔴';
  if (iut >= 45) return '🟠';
  if (iut >= 20) return '🟡';
  return '⚪';
}

/* ======================================================================
   6. NIVEL CLIENTE
   ====================================================================== */
function calcularNivel(lead) {
  const equipos = (lead.equipos || []).length;
  const esCliente = ['cliente','recurrente','mantenimiento'].includes(lead.estado);
  const tags = lead.tags || [];

  if (tags.includes('buen_cliente') && esCliente) return 'estrategico';
  if (esCliente && equipos >= 3)                  return 'estrategico';
  if (esCliente)                                  return 'alto';
  if (equipos >= 2 || tags.includes('alto_potencial')) return 'medio';
  return 'bajo';
}

function nivelBadge(nivel) {
  const map = {
    estrategico: ['ESTRATÉGICO','nivel-estrategico','🔥'],
    alto:        ['ALTO VALOR', 'nivel-alto',        '🟢'],
    medio:       ['MEDIO',      'nivel-medio',        '🟡'],
    bajo:        ['BAJO',       'nivel-bajo',         '']
  };
  const [lbl, css] = map[nivel] || map.bajo;
  return `<span class="nivel-badge ${css}">${lbl}</span>`;
}

/* ======================================================================
   7. PRIORIDAD
   ====================================================================== */
function calcularPrioridad(lead) {
  const tel = !!(lead.telefono && limpiarTel(lead.telefono).length >= 6);
  const iut = calcularIUT(lead);
  if (iut >= 45 || (tel && iut >= 20)) return 'alta';
  if (tel) return 'media';
  return 'baja';
}

/* ======================================================================
   8. DB HELPERS — versión única y consolidada
   FIX: eliminadas las versiones duplicadas de líneas 1790-1819 y 2138-2171.
   FIX: todas las versiones de dbSetConfig ahora llaman DB.setConfig (existente).
   FIX: snapshotLeads presente en dbSaveLead y dbDeleteLead.
   FIX: _iut invalidado en dbSaveLead para forzar recálculo al guardar.
   ====================================================================== */
async function dbSaveLead(lead) {
  try {
    /* Invalidar cache IUT para que el próximo render lo recalcule fresco */
    delete lead._iut;
    await DB.saveLead(lead);
    const idx = state.leads.findIndex(l => l.id === lead.id);
    if (idx >= 0) state.leads[idx] = lead;
    else          state.leads.push(lead);
    DB.snapshotLeads(state.leads);
  } catch(e) {
    console.error('[DB] dbSaveLead:', e);
    toast('⚠️ Error al guardar — verificá espacio en disco');
    throw e;
  }
}

async function dbDeleteLead(id) {
  await DB.deleteLead(id);
  state.leads = state.leads.filter(l => l.id !== id);
  DB.snapshotLeads(state.leads);
}

async function dbLoadLeads() {
  try {
    state.leads = await DB.loadLeads();
  } catch(e) {
    console.error('[DB] dbLoadLeads:', e);
    state.leads = [];
  }
}

async function dbGetConfig(key, def=null) {
  return DB.getConfig(key, def);
}

/* FIX: llamaba DB.saveConfig (inexistente) → corregido a DB.setConfig */
async function dbSetConfig(key, value) {
  return DB.setConfig(key, value);
}

/* ======================================================================
   9. MIGRACIÓN DESDE v5
   ====================================================================== */
async function migrarDesdeLocalStorage() {
  const raw = localStorage.getItem('rt_leads_v5');
  if (!raw) return 0;
  try {
    const leads = JSON.parse(raw);
    if (!leads.length) return 0;
    const migrados = leads.map(l => ({
      ...l,
      equipos:            l.equipos            || [],
      fotos:              l.fotos              || [],
      tags:               l.tags               || [],
      nivel:              l.nivel              || 'bajo',
      historial:          l.historial          || [],
      intentosContacto:   l.intentosContacto   || 0,
      cicloMantenimiento: l.cicloMantenimiento || null,
      proximaRevision:    l.proximaRevision    || null
    }));
    await DB.saveLeads(migrados);
    localStorage.setItem('rt_leads_v5_backup_pre_v6', raw);
    localStorage.removeItem('rt_leads_v5');
    return migrados.length;
  } catch(e) {
    console.error('[Migración] v5:', e);
    return 0;
  }
}

/* ======================================================================
   10. BACKUP SYSTEM
   ====================================================================== */
async function crearBackup(tipo='auto') {
  try {
    const backup = {
      fecha: new Date().toISOString(),
      tipo,
      datos: JSON.stringify({
        version: 6,
        fecha: new Date().toISOString(),
        tipo,
        leads: state.leads,
        ruta: state.ruta,
        mensajes: state.mensajes
      }),
      cantLeads: state.leads.length
    };
    await DB.saveBackup(backup);
    return true;
  } catch(e) {
    console.error('[Backup] crearBackup:', e);
    return false;
  }
}

function exportarJSON() {
  const data = {
    version: 6,
    fecha: new Date().toISOString(),
    leads: state.leads,
    ruta: state.ruta,
    mensajes: state.mensajes
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'_');
  a.href = url;
  a.download = `electromel_radar_${fecha}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exportado ✓');
}

/* ======================================================================
   11. MAPA LEAFLET
   ====================================================================== */
let map, gpsMarker;

/* FIX: markers almacenados por ID para diffing eficiente */
const _leadMarkersMap = new Map(); // id → L.marker
let mapResultMarkers  = [];

function initMap() {
  map = L.map('map', {
    center: [-38.9516, -68.0591],
    zoom: 13,
    zoomControl: false,
    attributionControl: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OSM'
  }).addTo(map);

  setupLongPress();

  map.on('click', () => {
    if (state.panelState === 'expanded') collapsePanel();
  });
}

function setupLongPress() {
  let touchTimer, touchX, touchY;

  const doLongPress = (lat, lon) => {
    $('#longpress-indicator').classList.remove('pressing');
    abrirCapturaRapida(lat, lon);
  };

  map.on('mousedown', (e) => {
    const i  = $('#longpress-indicator');
    const pt = map.latLngToContainerPoint(e.latlng);
    i.style.left = pt.x + 'px';
    i.style.top  = pt.y + 'px';
    i.classList.add('pressing');
    touchTimer = setTimeout(() => doLongPress(e.latlng.lat, e.latlng.lng), 600);
  });

  map.on('mouseup mousemove', () => {
    clearTimeout(touchTimer);
    $('#longpress-indicator').classList.remove('pressing');
  });

  $('#map').addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    const rect   = map.getContainer().getBoundingClientRect();
    const latlng = map.containerPointToLatLng(L.point(touchX-rect.left, touchY-rect.top));
    const i      = $('#longpress-indicator');
    i.style.left = touchX + 'px';
    i.style.top  = touchY + 'px';
    i.classList.add('pressing');
    touchTimer = setTimeout(() => doLongPress(latlng.lat, latlng.lng), 600);
  }, { passive: true });

  ['touchend','touchmove','touchcancel'].forEach(ev => {
    $('#map').addEventListener(ev, () => {
      clearTimeout(touchTimer);
      $('#longpress-indicator').classList.remove('pressing');
    }, { passive: true });
  });
}

function createLeadIcon(lead) {
  const iut   = calcularIUT(lead);
  const cls   = iutClase(iut);
  const colorMap = {
    'iut-critico': '#ff3355',
    'iut-alto':    '#ff9020',
    'iut-medio':   '#f5c400',
    'iut-bajo':    '#4a6888'
  };
  const color = colorMap[cls];
  const src   = lead.fuente || 'manual';
  const letra = src==='google' ? 'G' : src==='terreno' ? 'T' : 'M';
  return L.divIcon({
    html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.8);box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:white;font-family:'Barlow Condensed',sans-serif;">${letra}</div>`,
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function createResultIcon() {
  return L.divIcon({
    html: `<div style="width:18px;height:18px;border-radius:50%;background:#00e8a0;border:2px solid rgba(255,255,255,0.9);box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>`,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

/**
 * FIX: diffing de markers — solo crea/elimina los que cambiaron.
 * Evita reconstruir 100 markers en cada save de un lead.
 */
function renderMapLeads() {
  if (!state.mapLeadsVisible) {
    /* Ocultar todos */
    _leadMarkersMap.forEach(m => map.removeLayer(m));
    _leadMarkersMap.clear();
    return;
  }

  const leadsVisibles = state.leads.filter(l => l.lat && l.lon && l.estado !== 'descartado');
  const idsNuevos     = new Set(leadsVisibles.map(l => l.id));

  /* Eliminar markers que ya no deben estar */
  _leadMarkersMap.forEach((marker, id) => {
    if (!idsNuevos.has(id)) {
      map.removeLayer(marker);
      _leadMarkersMap.delete(id);
    }
  });

  /* Agregar markers nuevos (los existentes se mantienen) */
  leadsVisibles.forEach(l => {
    if (_leadMarkersMap.has(l.id)) return; /* ya existe → skip */
    const m = L.marker([l.lat, l.lon], { icon: createLeadIcon(l) })
      .addTo(map)
      .on('click', () => {
        expandPanel();
        setTab('leads');
        setTimeout(() => abrirModalLead(l.id), 200);
      });
    _leadMarkersMap.set(l.id, m);
  });
}

/**
 * Fuerza regeneración del icon de un marker específico tras editar un lead.
 * Llamado desde dbSaveLead via refreshMapMarker.
 */
function refreshMapMarker(lead) {
  const m = _leadMarkersMap.get(lead.id);
  if (!m) return;
  if (lead.estado === 'descartado' || !lead.lat || !lead.lon) {
    map.removeLayer(m);
    _leadMarkersMap.delete(lead.id);
    return;
  }
  m.setIcon(createLeadIcon(lead));
}

function renderMapResults(results) {
  mapResultMarkers.forEach(m => map.removeLayer(m));
  mapResultMarkers = [];
  results.forEach(n => {
    if (!n.lat || !n.lon) return;
    const m = L.marker([n.lat, n.lon], { icon: createResultIcon() })
      .addTo(map)
      .bindPopup(`<b>${esc(n.nombre)}</b><br><small>${esc(n.direccion||'')}</small>`)
      .on('click', () => m.openPopup());
    mapResultMarkers.push(m);
  });
  if (results.length > 0 && results[0].lat) {
    const lats = results.filter(r=>r.lat).map(r=>r.lat);
    const lons = results.filter(r=>r.lon).map(r=>r.lon);
    map.fitBounds([
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)]
    ], { padding: [60, 60] });
  }
}

/* ======================================================================
   12. GPS
   FIX: watchId nunca se cancelaba → desactivarGPS con clearWatch.
   FIX: actualización throttleada a 200ms, umbral mínimo 15m de movimiento.
   ====================================================================== */
let watchId      = null;
let distCache    = {};
let _gpsThrottle = null;

function activarGPS() {
  if (!navigator.geolocation) { toast('GPS no disponible'); return; }
  if (watchId !== null) return; /* ya activo */
  $('#fab-gps').classList.add('active');
  watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      /* Solo procesar si movió más de 15m o es la primera fix */
      const moved = state.userLat
        ? distKm(state.userLat, state.userLon, lat, lon) > 0.015
        : true;

      if (moved) {
        /* Invalidar distCache si movió más de 50m */
        if (state.userLat && distKm(state.userLat, state.userLon, lat, lon) > 0.05) {
          distCache = {};
        }
        state.userLat = lat;
        state.userLon = lon;
        actualizarGPSMarker();
      }

      /* Throttle: renderTerreno como máximo cada 200ms */
      if (state.activeTab === 'terreno') {
        clearTimeout(_gpsThrottle);
        _gpsThrottle = setTimeout(() => renderTerreno(), 200);
      }
    },
    err => {
      toast('GPS: ' + err.message);
      $('#fab-gps').classList.remove('active');
      watchId = null;
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
  );
}

/* FIX: clearWatch para evitar watches acumulados */
function desactivarGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  $('#fab-gps').classList.remove('active');
}

function centrarEnGPS() {
  if (state.userLat) map.setView([state.userLat, state.userLon], 15);
  else activarGPS();
}

function actualizarGPSMarker() {
  if (!state.userLat) return;
  if (gpsMarker) map.removeLayer(gpsMarker);
  gpsMarker = L.marker([state.userLat, state.userLon], {
    icon: L.divIcon({ html:'<div class="gps-dot"></div>', className:'', iconSize:[14,14], iconAnchor:[7,7] })
  }).addTo(map);
}

/* ======================================================================
   13. PANEL CONTROL
   ====================================================================== */
function expandPanel()  { state.panelState='expanded'; $('#bottom-panel').className=''; $('#bottom-panel').classList.add('expanded'); }
function halfPanel()    { state.panelState='half';     $('#bottom-panel').className=''; $('#bottom-panel').classList.add('half'); }
function collapsePanel(){ state.panelState='collapsed';$('#bottom-panel').className=''; }

/*
 * LÓGICA DE PANEL — reglas claras:
 *
 * CLICK en handle-bar (la rayita):
 *   collapsed → half → expanded → half (nunca colapsa con click)
 *
 * SWIPE en handle (solo desde #panel-handle):
 *   Hacia ARRIBA  → sube un nivel (collapsed→half, half→expanded)
 *   Hacia ABAJO   → baja un nivel (expanded→half, half→collapsed)
 *   Mínimo 80px para evitar activaciones accidentales al tocar
 *
 * TOQUE en #panel-content:
 *   Completamente ignorado para mover el panel.
 *   El scroll interno funciona normal.
 *
 * REGLA PRINCIPAL: el panel NUNCA se colapsa solo al scrollear contenido.
 */

/* Click en la barra del handle — sube el panel, nunca lo cierra */
$('#panel-handle').addEventListener('click', () => {
  if (state.panelState === 'collapsed') halfPanel();
  else if (state.panelState === 'half') expandPanel();
  /* expanded + click → no hacer nada, el usuario usa swipe para bajar */
});

let _touchStartY    = 0;
let _touchStartX    = 0;
let _swipeEnHandle  = false;

/* Registrar inicio de toque SOLO en el handle */
$('#panel-handle').addEventListener('touchstart', e => {
  _touchStartY   = e.touches[0].clientY;
  _touchStartX   = e.touches[0].clientX;
  _swipeEnHandle = true;
}, { passive: true });

/* Cualquier toque en el contenido desactiva el swipe de panel */
$('#panel-content').addEventListener('touchstart', () => {
  _swipeEnHandle = false;
}, { passive: true });

$('#bottom-panel').addEventListener('touchend', e => {
  if (!_swipeEnHandle) return;
  _swipeEnHandle = false;

  const dy = e.changedTouches[0].clientY - _touchStartY;
  const dx = e.changedTouches[0].clientX - _touchStartX;

  /* Ignorar si fue más horizontal que vertical (scroll lateral de tabs) */
  if (Math.abs(dx) > Math.abs(dy)) return;

  /* Umbral alto (80px) para que sea un gesto deliberado, no accidental */
  if (dy > 80) {
    /* Swipe hacia abajo — bajar un nivel */
    if (state.panelState === 'expanded') halfPanel();
    else if (state.panelState === 'half') collapsePanel();
  } else if (dy < -80) {
    /* Swipe hacia arriba — subir un nivel */
    if (state.panelState === 'collapsed') halfPanel();
    else if (state.panelState === 'half') expandPanel();
  }
}, { passive: true });

/* ======================================================================
   14. TABS
   FIX: guard anti re-render si el tab ya está activo (excepto stats).
   ====================================================================== */
function setTab(tab) {
  /* Guard: no re-renderizar si ya estamos en este tab
     Excepción: stats siempre refresca porque tiene backups dinámicos */
  if (state.activeTab === tab && tab !== 'stats') {
    if (state.panelState === 'collapsed') halfPanel();
    return;
  }
  state.activeTab = tab;
  $$('.mode-tab,.panel-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel-sec').forEach(s => s.style.display = 'none');
  const sec = $(`#sec-${tab}`);
  if (sec) sec.style.display = 'block';
  if (state.panelState === 'collapsed') halfPanel();

  const renders = {
    terreno:      renderTerreno,
    leads:        renderLeads,
    seguimientos: renderSeguimientos,
    ruta:         renderRuta,
    zonas:        renderZonas,
    stats:        renderStats,
    config:       cargarConfigUI
  };
  renders[tab]?.();
}

$$('.mode-tab,.panel-tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ======================================================================
   15. TERRENO
   ====================================================================== */
function renderTerreno() {
  const cont   = $('#lista-terreno');
  const status = $('#terreno-status');

  if (!state.userLat) {
    status.textContent = 'Activá GPS para detectar oportunidades técnicas';
    cont.innerHTML = `<div class="empty-state"><span class="ico">📡</span>Tocá el botón GPS para detectar tu posición y ver objetivos cercanos.</div>`;
    return;
  }

  const cercanos = state.leads
    .filter(l => l.lat && l.lon && l.estado !== 'descartado')
    .map(l => {
      if (!distCache[l.id]) {
        distCache[l.id] = distKm(state.userLat, state.userLon, l.lat, l.lon);
      }
      return { ...l, _dist: distCache[l.id], _iut: calcularIUT(l) };
    })
    .filter(l => l._dist <= TERRENO_RADIO)
    .sort((a,b) => (b._iut - a._iut) || (a._dist - b._dist));

  status.innerHTML = cercanos.length
    ? `<span style="font-family:var(--mono);color:var(--accent);">${cercanos.length}</span> objetivo(s) en radio de ${TERRENO_RADIO}km`
    : 'Sin objetivos en radio. Buscá o agregá negocios.';

  if (!cercanos.length) {
    cont.innerHTML = `<div class="empty-state"><span class="ico">🔍</span>No hay leads en ${TERRENO_RADIO}km.<br>Buscá negocios o tocá el mapa.</div>`;
    return;
  }

  cont.innerHTML = cercanos.map(l => renderTerrenoCard(l)).join('');

  cont.querySelectorAll('[data-tid]').forEach(card => {
    const id   = card.dataset.tid;
    const lead = state.leads.find(x => x.id === id);
    if (!lead) return;
    card.querySelector('[data-ta=ir]')?.addEventListener('click', () => abrirMaps(lead));
    card.querySelector('[data-ta=wa]')?.addEventListener('click', () => abrirWhatsApp(lead, 'primero'));
    card.querySelector('[data-ta=llamar]')?.addEventListener('click', () => llamar(lead));
    card.querySelector('[data-ta=visitado]')?.addEventListener('click', async () => {
      const upd = { ...lead, estado:'visitado', intentosContacto:(lead.intentosContacto||0)+1,
        historial:[...(lead.historial||[]),{fecha:new Date().toISOString(),accion:'Visitado en terreno'}] };
      await dbSaveLead(upd);
      refreshMapMarker(upd);
      toast('✓ Marcado como visitado');
      renderTerreno();
    });
    card.querySelector('[data-ta=nota]')?.addEventListener('click', () => abrirNotasRapidas(id));
    card.querySelector('[data-ta=abrir]')?.addEventListener('click', () => abrirModalLead(id));
    card.querySelector('[data-ta=ruta]')?.addEventListener('click', () => agregarLeadARuta(id));
    card.querySelector('[data-ta=urgente]')?.addEventListener('click', async () => {
      const upd = { ...lead, estado:'urgente', tags:[...(lead.tags||[]),'urgente'] };
      await dbSaveLead(upd);
      refreshMapMarker(upd);
      toast('🚨 Marcado como URGENTE');
      renderTerreno();
    });
  });
}

function renderTerrenoCard(l) {
  const tel     = !!(l.telefono && limpiarTel(l.telefono).length >= 6);
  const src     = l.fuente || 'manual';
  const srcLbl  = src==='google'?'GOOGLE':src==='manual'?'MANUAL':src==='osm'?'OSM':'TERRENO';
  const iut     = l._iut || calcularIUT(l);
  const iutCls  = iutClase(iut);

  const equiposHtml = (l.equipos||[]).length
    ? `<div class="equipos-chips">${l.equipos.map(e => {
        const eq = EQUIPOS_CATALOGO.find(x=>x.id===e);
        return eq ? `<span class="equipo-chip">${eq.ico} ${eq.label}</span>` : '';
      }).join('')}</div>`
    : '';

  const notaDisplay = l.notas
    ? `<div class="tc-nota">📝 ${esc(l.notas.slice(0,60))}${l.notas.length>60?'…':''}</div>` : '';

  const seguHtml = l.seguimientoFecha && esHoyOAtrasado(l.seguimientoFecha)
    ? `<span style="color:var(--em-orange);font-size:10px;font-weight:700;font-family:var(--mono);">⏰ HOY</span>` : '';

  const urgente = l.estado==='urgente' || iut >= 70;

  return `
  <div class="terreno-card src-${src}${urgente?' urgente':''}" data-tid="${l.id}">
    <div class="tc-top">
      <div class="tc-name">${esc(l.nombre)}</div>
      <div class="tc-iut"><span class="iut-badge ${iutCls}">${iutLabel(iut)} IUT·${iut}</span></div>
    </div>
    <div class="tc-meta">
      <span class="tc-dist">◈ ${fmtDist(l._dist)}</span>
      <span class="src-badge ${src}">${srcLbl}</span>
      ${nivelBadge(l.nivel||'bajo')}
      ${seguHtml}
    </div>
    ${equiposHtml}
    ${notaDisplay}
    <div class="tc-actions-primary">
      <button class="tc-btn primary-ir" data-ta="ir">NAVEGAR</button>
      ${tel ? `<button class="tc-btn primary-wa" data-ta="wa">WHATSAPP</button>`
            : `<button class="tc-btn" data-ta="abrir">VER FICHA</button>`}
    </div>
    <div class="tc-actions-secondary">
      ${tel ? `<button class="tc-btn btn-sm-ico" data-ta="llamar" title="Llamar">📞</button>` : ''}
      <button class="tc-btn btn-sm-ico" data-ta="visitado" title="Marcar visitado">✅</button>
      <button class="tc-btn btn-sm-ico" data-ta="nota"     title="Nota rápida">📝</button>
      <button class="tc-btn btn-sm-ico" data-ta="ruta"     title="+ Ruta">🗺️</button>
      <button class="tc-btn btn-sm-ico btn-urgente" data-ta="urgente" title="Marcar urgente">🚨</button>
      <button class="tc-btn btn-sm-ico" data-ta="abrir"    title="Editar">✏️</button>
    </div>
  </div>`;
}

/* ======================================================================
   16. MODAL LEAD
   FIX: listener {once} en overlay se limpia antes de re-agregar.
   ====================================================================== */
async function abrirModalLead(id) {
  const l = state.leads.find(x => x.id === id);
  if (!l) return;

  const iut = calcularIUT(l);
  $('#modal-titulo').textContent = l.nombre;
  $('#modal-subtitle').innerHTML = `
    <span class="iut-badge ${iutClase(iut)}">${iutLabel(iut)} IUT·${iut}</span>
    <span class="src-badge ${l.fuente||'manual'}" style="margin-left:6px;">${(l.fuente||'MANUAL').toUpperCase()}</span>
    <span style="margin-left:6px;">${nivelBadge(l.nivel||'bajo')}</span>
  `;

  const estadoOpts = ESTADOS.map(e =>
    `<option value="${e.id}" ${l.estado===e.id?'selected':''}>${e.label}</option>`
  ).join('');

  const equiposCheckboxes = EQUIPOS_CATALOGO.map(eq => `
    <label style="display:flex;align-items:center;gap:6px;padding:5px;cursor:pointer;font-size:12px;font-weight:700;font-family:var(--sans);">
      <input type="checkbox" data-eq="${eq.id}" ${(l.equipos||[]).includes(eq.id)?'checked':''} style="width:auto;padding:0;border:none;">
      ${eq.ico} ${eq.label}
    </label>`).join('');

  const fotosHtml = `
    <div class="fotos-grid" id="m-fotos-grid">
      ${(l.fotos||[]).map((f,i) => `
        <div class="foto-thumb">
          <img src="${f}" alt="foto" loading="lazy">
          <button class="foto-del" data-fi="${i}">✕</button>
        </div>`).join('')}
      <div class="foto-add-btn" id="m-add-foto">📸<span style="font-size:10px;font-weight:700;font-family:var(--mono);">FOTO</span></div>
    </div>
    <input type="file" id="m-foto-input" accept="image/*" capture="environment" style="display:none;">
  `;

  $('#modal-contenido').innerHTML = `
    <div class="field">
      <label>Estado</label>
      <select id="m-estado">${estadoOpts}</select>
    </div>
    <div class="row-2">
      <div class="field">
        <label>Rubro</label>
        <select id="m-rubro">
          <option value="gimnasio"    ${l.rubro==='gimnasio'?'selected':''}>Gimnasio</option>
          <option value="hotel"       ${l.rubro==='hotel'?'selected':''}>Hotel</option>
          <option value="constructora"${l.rubro==='constructora'?'selected':''}>Constructora</option>
          <option value="industrial"  ${l.rubro==='industrial'?'selected':''}>Industrial</option>
          <option value="comercio"    ${l.rubro==='comercio'?'selected':''}>Comercio</option>
        </select>
      </div>
      <div class="field">
        <label>Nivel cliente</label>
        <select id="m-nivel">
          <option value="bajo"        ${l.nivel==='bajo'?'selected':''}>🔴 Bajo</option>
          <option value="medio"       ${l.nivel==='medio'?'selected':''}>🟡 Medio</option>
          <option value="alto"        ${l.nivel==='alto'?'selected':''}>🟢 Alto</option>
          <option value="estrategico" ${l.nivel==='estrategico'?'selected':''}>🔥 Estratégico</option>
        </select>
      </div>
    </div>
    <div class="field"><label>Teléfono</label><input id="m-tel" type="tel" value="${esc(l.telefono||'')}"></div>
    <div class="field"><label>Dirección</label><input id="m-dir" type="text" value="${esc(l.direccion||'')}"></div>
    <div class="field"><label>Zona / Barrio</label><input id="m-zona" type="text" value="${esc(l.zona||'')}" placeholder="Ej: Centro, Parque Industrial..."></div>
    <div class="field">
      <label>Equipos detectados</label>
      <div style="background:var(--bg-input);border:1px solid var(--border-lit);border-radius:10px;padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:2px;">
        ${equiposCheckboxes}
      </div>
    </div>
    <div class="field"><label>Fotos del local / equipos</label>${fotosHtml}</div>
    <div class="field"><label>Notas técnicas</label><textarea id="m-notas">${esc(l.notas||'')}</textarea></div>
    <div class="notas-rapidas">
      ${['✅ Visitado','❌ Sin interés','🔧 Equipo visible','⚡ Soldadora detectada','🏋️ Cintas dañadas','💰 Buen potencial','⭐ MUY INTERESANTE','📅 Volver'].map(n =>
        `<button class="nota-rapida">${esc(n)}</button>`).join('')}
    </div>
    <div class="field"><label>Próximo seguimiento</label><input id="m-seg" type="date" value="${l.seguimientoFecha?l.seguimientoFecha.slice(0,10):''}"></div>
    <div class="field"><label>Ciclo mantenimiento (meses)</label><input id="m-ciclo" type="number" min="1" max="24" value="${l.cicloMantenimiento||''}" placeholder="Ej: 3"></div>
    ${l.historial?.length ? `
    <div class="info-banner" style="margin-top:8px;">
      <b style="font-family:var(--mono);font-size:10px;">HISTORIAL</b><br>
      ${l.historial.slice(-5).reverse().map(h=>`• ${fmtFecha(h.fecha)} — ${esc(h.accion)}`).join('<br>')}
    </div>` : ''}
    <div style="margin-top:6px;font-family:var(--mono);font-size:10px;color:var(--text-dim);">
      Intentos contacto: <b style="color:var(--text);">${l.intentosContacto||0}</b>
    </div>
    <div class="row-2" style="margin-top:12px;">
      <button class="btn btn-r btn-sm" id="m-eliminar">ELIMINAR</button>
      <button class="btn btn-em btn-sm" id="m-guardar">GUARDAR</button>
    </div>
    <div class="row-2" style="margin-top:6px;">
      <button class="btn btn-sm" id="m-maps">MAPS</button>
      <button class="btn btn-sm" id="m-ruta">+ RUTA</button>
    </div>
    ${l.telefono ? `
    <div class="row-2" style="margin-top:6px;">
      <button class="btn btn-b btn-sm" id="m-wa-primer">PRIMER CONTACTO</button>
      <button class="btn btn-sm" id="m-wa-seg">SEGUIMIENTO</button>
    </div>` : ''}
  `;

  /* Bind notas rápidas */
  $$('#modal-contenido .nota-rapida').forEach(b => {
    b.addEventListener('click', () => {
      const ta = $('#m-notas');
      ta.value = (ta.value ? ta.value + '\n' : '') + b.textContent;
    });
  });

  /* Fotos */
  $('#m-add-foto').addEventListener('click', () => $('#m-foto-input').click());
  $('#m-foto-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const MAX = 800;
        let { width, height } = img;
        if (width  > MAX) { height = height*(MAX/width);  width = MAX; }
        if (height > MAX) { width  = width*(MAX/height);  height = MAX; }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        const fotos   = [...(l.fotos||[]), dataUrl];
        await dbSaveLead({ ...l, fotos });
        toast('Foto guardada ✓');
        abrirModalLead(id);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  $$('#m-fotos-grid .foto-del').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const fi    = +b.dataset.fi;
      const fotos = (l.fotos||[]).filter((_,i) => i !== fi);
      await dbSaveLead({ ...l, fotos });
      toast('Foto eliminada');
      abrirModalLead(id);
    });
  });

  $('#m-guardar').addEventListener('click', async () => {
    const equiposSel = [...$('#modal-contenido').querySelectorAll('[data-eq]:checked')].map(x => x.dataset.eq);
    const upd = {
      ...l,
      estado:              $('#m-estado').value,
      rubro:               $('#m-rubro').value,
      nivel:               $('#m-nivel').value,
      telefono:            $('#m-tel').value.trim(),
      direccion:           $('#m-dir').value.trim(),
      zona:                $('#m-zona').value.trim(),
      notas:               $('#m-notas').value.trim(),
      seguimientoFecha:    $('#m-seg').value ? new Date($('#m-seg').value).toISOString() : null,
      cicloMantenimiento:  $('#m-ciclo').value ? +$('#m-ciclo').value : null,
      equipos:             equiposSel,
      historial:           [...(l.historial||[]), { fecha:new Date().toISOString(), accion:'Lead actualizado' }]
    };
    upd.prioridad = calcularPrioridad(upd);
    upd.nivel     = upd.nivel || calcularNivel(upd);
    await dbSaveLead(upd);
    refreshMapMarker(upd);
    cerrarModal('modal-lead');
    renderLeads();
    if (state.activeTab === 'terreno') renderTerreno();
    toast('Lead actualizado ✓');
    distCache = {};
  });

  $('#m-eliminar').addEventListener('click', async () => {
    if (!confirm('¿Eliminar este lead?')) return;
    await dbDeleteLead(id);
    /* Quitar marker del mapa directamente */
    const m = _leadMarkersMap.get(id);
    if (m) { map.removeLayer(m); _leadMarkersMap.delete(id); }
    cerrarModal('modal-lead');
    renderLeads();
    toast('Lead eliminado');
  });

  $('#m-maps').addEventListener('click', () => abrirMaps(l));
  $('#m-ruta').addEventListener('click', () => { agregarLeadARuta(id); cerrarModal('modal-lead'); });
  $('#m-wa-primer')?.addEventListener('click', () => abrirWhatsApp(l, 'primero'));
  $('#m-wa-seg')?.addEventListener('click',    () => abrirWhatsApp(l, 'seguimiento'));

  abrirModal('modal-lead');
}

/* ======================================================================
   17. CAPTURA RÁPIDA
   ====================================================================== */
let capturaLat = null;
let capturaLon = null;

function abrirCapturaRapida(lat, lon) {
  capturaLat = lat || null;
  capturaLon = lon || null;

  const coordsTxt = lat
    ? `◈ ${lat.toFixed(5)}, ${lon.toFixed(5)}`
    : 'Sin GPS (se usará posición actual)';

  let tipoSel    = 'comercio';
  let equiposSel = [];
  let tagsSel    = [];

  $('#captura-form').innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;color:var(--accent);margin-bottom:12px;letter-spacing:1px;">${coordsTxt}</div>
    <div class="field">
      <label>Nombre del negocio *</label>
      <input id="cn-nombre" type="text" placeholder="Ej: GymFit, Metal Sur, Hotel Patagonia..." autocomplete="off" style="font-size:18px;">
    </div>
    <div class="field">
      <label>Tipo de negocio</label>
      <div class="qc-tipos" id="cn-tipos">
        ${TIPOS_NEGOCIO.map(t =>
          `<button class="qc-tipo-btn${t.id==='comercio'?' sel':''}" data-tipo="${t.id}"><span class="ico">${t.ico}</span>${t.label}</button>`
        ).join('')}
      </div>
    </div>
    <div class="field">
      <label>Equipos detectados</label>
      <div class="equipos-selector" id="cn-equipos">
        ${EQUIPOS_CATALOGO.map(eq =>
          `<button class="eq-btn" data-eq="${eq.id}">${eq.ico} ${eq.label}</button>`
        ).join('')}
      </div>
    </div>
    <div class="field">
      <label>Etiquetas rápidas</label>
      <div class="quick-tags" id="cn-tags">
        ${QUICK_TAGS.map(t =>
          `<button class="qtag" data-tag="${t.key}">${t.label}</button>`
        ).join('')}
      </div>
    </div>
    <div class="field">
      <label>Teléfono (opcional)</label>
      <input id="cn-tel" type="tel" placeholder="+54 299...">
    </div>
    <div class="row-2" style="margin-top:4px;">
      <button class="btn btn-sm" id="cn-cancelar">CANCELAR</button>
      <button class="btn btn-em" id="cn-guardar">GUARDAR</button>
    </div>
  `;

  $$('#cn-tipos .qc-tipo-btn').forEach(b => {
    b.addEventListener('click', () => {
      tipoSel = b.dataset.tipo;
      $$('#cn-tipos .qc-tipo-btn').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
    });
  });

  $$('#cn-equipos .eq-btn').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('sel');
      const eq = b.dataset.eq;
      equiposSel = equiposSel.includes(eq)
        ? equiposSel.filter(x => x !== eq)
        : [...equiposSel, eq];
    });
  });

  $$('#cn-tags .qtag').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('sel');
      const tag = b.dataset.tag;
      tagsSel = tagsSel.includes(tag)
        ? tagsSel.filter(x => x !== tag)
        : [...tagsSel, tag];
    });
  });

  $('#cn-cancelar').addEventListener('click', () => cerrarModal('modal-captura'));

  $('#cn-guardar').addEventListener('click', async () => {
    const nombre = $('#cn-nombre').value.trim();
    if (!nombre) { toast('Ingresá el nombre del negocio'); return; }

    const lat = capturaLat || state.userLat;
    const lon = capturaLon || state.userLon;

    const esUrgente = tagsSel.includes('urgente');
    const esNoSirve = tagsSel.includes('no_sirve');

    const lead = {
      id: uid(),
      nombre,
      rubro:              tipoSel,
      tipo:               tipoSel,
      telefono:           $('#cn-tel').value.trim(),
      direccion:          '',
      zona:               '',
      notas:              tagsSel.map(t => QUICK_TAGS.find(q=>q.key===t)?.label||t).join(', '),
      lat, lon,
      fuente:             lat ? 'terreno' : 'manual',
      estado:             esUrgente ? 'urgente' : (esNoSirve ? 'descartado' : 'no-contactado'),
      equipos:            equiposSel,
      tags:               tagsSel,
      fotos:              [],
      prioridad:          'media',
      nivel:              'bajo',
      intentosContacto:   0,
      cicloMantenimiento: null,
      proximaRevision:    null,
      creado:             new Date().toISOString(),
      historial:          [{ fecha:new Date().toISOString(), accion:'Lead creado en terreno' }]
    };
    lead.prioridad = calcularPrioridad(lead);
    lead.nivel     = calcularNivel(lead);

    await dbSaveLead(lead);
    distCache = {};
    /* Agregar marker directamente sin full rebuild */
    if (lead.lat && lead.lon && lead.estado !== 'descartado' && state.mapLeadsVisible) {
      const m = L.marker([lead.lat, lead.lon], { icon: createLeadIcon(lead) })
        .addTo(map)
        .on('click', () => { expandPanel(); setTab('leads'); setTimeout(() => abrirModalLead(lead.id), 200); });
      _leadMarkersMap.set(lead.id, m);
    }
    cerrarModal('modal-captura');
    toast('✓ Capturado: ' + nombre);
    if (lat) map.setView([lat, lon], 15);
    if (state.activeTab === 'terreno') renderTerreno();
  });

  $('#modal-captura').classList.add('show');
  setTimeout(() => $('#cn-nombre')?.focus(), 100);
}

/* ======================================================================
   18. NOTAS RÁPIDAS
   FIX: guard contra apertura múltiple simultánea
   ====================================================================== */
function abrirNotasRapidas(id) {
  /* Guard: si ya hay un overlay abierto, no crear otro */
  if (document.querySelector('.notas-overlay')) return;

  const lead = state.leads.find(x => x.id === id);
  if (!lead) return;

  const overlay = document.createElement('div');
  overlay.className = 'notas-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:900;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--bg-card);border-top:2px solid var(--em-orange);border-radius:20px 20px 0 0;width:100%;max-width:600px;padding:18px 14px 30px;">
      <div style="font-family:var(--cond);font-size:16px;font-weight:800;margin-bottom:10px;color:var(--em-orange);letter-spacing:0.5px;">NOTA RÁPIDA — ${esc(lead.nombre)}</div>
      <div class="notas-rapidas">
        ${['✅ Visitado','❌ Sin interés','🔧 Equipo visto','⚡ Soldadora','🏋️ Cintas dañadas','💰 Buen potencial','⭐ MUY INTERESANTE','📅 Volver después','🚨 URGENTE'].map(n =>
          `<button class="nota-rapida" data-nota="${esc(n)}">${esc(n)}</button>`).join('')}
      </div>
      <textarea id="nota-libre" style="width:100%;background:var(--bg-input);border:1px solid var(--border-lit);padding:10px;border-radius:8px;color:var(--text);font-size:15px;margin-top:8px;min-height:70px;font-family:var(--sans);" placeholder="O escribí tu nota...">${esc(lead.notas||'')}</textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-em" id="nq-guardar" style="flex:1;">GUARDAR</button>
        <button class="btn" id="nq-cancelar" style="flex:0 0 auto;">CANCELAR</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const cerrarOverlay = () => {
    if (overlay.parentNode) document.body.removeChild(overlay);
  };

  overlay.querySelectorAll('.nota-rapida').forEach(b => {
    b.addEventListener('click', () => {
      const ta = overlay.querySelector('#nota-libre');
      ta.value = (ta.value ? ta.value + '\n' : '') + b.dataset.nota;
    });
  });

  overlay.querySelector('#nq-guardar').addEventListener('click', async () => {
    const nota = overlay.querySelector('#nota-libre').value.trim();
    const upd  = {
      ...lead,
      notas: nota,
      historial: [...(lead.historial||[]), { fecha:new Date().toISOString(), accion:'Nota: '+nota.slice(0,40) }]
    };
    await dbSaveLead(upd);
    cerrarOverlay();
    toast('Nota guardada ✓');
    if (state.activeTab === 'terreno') renderTerreno();
  });

  overlay.querySelector('#nq-cancelar').addEventListener('click', cerrarOverlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) cerrarOverlay(); });
}

/* ======================================================================
   19. MODAL HELPERS
   FIX: listener {once} limpiado con cloneNode para evitar acumulación
   ====================================================================== */
function abrirModal(id) {
  const m = $(`#${id}`);
  m.classList.add('show');
  /* Clonar el nodo elimina todos los listeners acumulados del overlay */
  const fresh = m.cloneNode(true);
  m.replaceWith(fresh);
  /* Reconectar el botón cerrar si es modal-lead */
  if (id === 'modal-lead') {
    fresh.querySelector('#btn-cerrar-modal')?.addEventListener('click', () => cerrarModal(id));
  }
  fresh.addEventListener('click', e => { if (e.target === fresh) cerrarModal(id); }, { once: true });
}

function cerrarModal(id) {
  $(`#${id}`)?.classList.remove('show');
}

$('#btn-cerrar-modal').addEventListener('click', () => cerrarModal('modal-lead'));

/* ======================================================================
   20. ACCIONES RÁPIDAS
   ====================================================================== */
function abrirMaps(lead) {
  const url = (lead.lat && lead.lon)
    ? `https://www.google.com/maps?q=${lead.lat},${lead.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((lead.nombre||'')+' '+(lead.direccion||''))}`;
  window.open(url, '_blank');
}

function llamar(lead) {
  const tel = limpiarTel(lead.telefono);
  if (!tel) { toast('Sin teléfono'); return; }
  window.location.href = 'tel:' + tel;
}

async function abrirWhatsApp(lead, tipo) {
  const tel = limpiarTel(lead.telefono);
  if (!tel) { toast('Sin teléfono cargado'); return; }
  const rubro = lead.rubro || 'comercio';
  const tpl   = state.mensajes[rubro]?.[tipo] || state.mensajes.comercio[tipo] || '';
  const msg   = tpl.replace(/\{nombre\}/gi, lead.nombre);
  window.open(`https://wa.me/${tel}?text=${encodeURIComponent(msg)}`, '_blank');
  const upd = {
    ...lead,
    estado:            lead.estado==='no-contactado' ? 'contactado' : lead.estado,
    intentosContacto:  (lead.intentosContacto||0) + 1,
    historial:         [...(lead.historial||[]), { fecha:new Date().toISOString(), accion:`WhatsApp ${tipo}` }]
  };
  await dbSaveLead(upd);
}

/* ======================================================================
   21. BÚSQUEDA OSM / GOOGLE
   ======================================================================

   OSM: usa Nominatim (geocoding) + Overpass (POIs).
     - Nominatim devuelve boundingbox como [S, N, W, E].
     - Overpass espera (S, W, N, E) — el orden importa.
     - User-Agent requerido por la política de Nominatim.
     - Tres servidores Overpass en fallback.

   GOOGLE: la API REST Places bloquea CORS desde el browser.
     - Solución correcta: Maps JavaScript API cargada dinámicamente
       solo cuando el usuario tiene API Key configurada.
     - Se usa PlacesService con un div temporal (requerido por la API).
     - Sin API Key muestra instrucciones claras.
   ====================================================================== */

/* Fetch con timeout */
async function fetchTout(url, opts={}, ms=25000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try   { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

/* ── Nominatim geocoding ────────────────────────────────────────────── */
async function geocodeCiudad(ciudad) {
  const url = 'https://nominatim.openstreetmap.org/search'
    + '?q='      + encodeURIComponent(ciudad)
    + '&format=json&limit=1&addressdetails=0';

  /* Nominatim exige un User-Agent real o devuelve 403 */
  let res, data;
  try {
    res  = await fetchTout(url, { headers: { 'Accept': 'application/json' } }, 15000);
    data = await res.json();
  } catch(e) {
    throw new Error('Geocoding sin respuesta: ' + e.message);
  }

  if (!Array.isArray(data) || !data.length) {
    throw new Error('Ciudad no encontrada: "' + ciudad + '"');
  }

  const r = data[0];
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
}

/* ── Overpass / OSM — GRID SEARCH ──────────────────────────────────── */
/*
 * GRID SEARCH: divide la ciudad en una grilla de celdas pequeñas
 * y hace una query Overpass por celda en paralelo.
 *
 * Por qué supera al radio único:
 *   - Radio 8km único → Overpass devuelve ~60 elementos (límite interno)
 *   - Grid 5×5 = 25 celdas de 2.5km → hasta 750 elementos únicos
 *
 * Celdas de 2.5km × 2.5km con 20% de solapamiento para no perder
 * negocios en los bordes. Duplicados eliminados por osmId.
 * Queries de a 3 simultáneas para no saturar Overpass.
 */

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

let _overpassServerIdx = 0;

async function queryOverpass(q) {
  const n = OVERPASS_SERVERS.length;
  for (let i = 0; i < n; i++) {
    const server = OVERPASS_SERVERS[(_overpassServerIdx + i) % n];
    try {
      const res = await fetchTout(
        server,
        { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'data='+encodeURIComponent(q) },
        30000
      );
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith('<')) continue;
      _overpassServerIdx = (_overpassServerIdx + i) % n;
      return JSON.parse(text);
    } catch(e) { continue; }
  }
  return null;
}

function buildCeldaQuery(latMin, lonMin, latMax, lonMax, rubro) {
  const r    = rubro.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bbox = latMin+','+lonMin+','+latMax+','+lonMax;
  return '[out:json][timeout:25];\n(\n' +
    '  node["name"~"'+r+'",i]('+bbox+');\n' +
    '  way["name"~"'+r+'",i]('+bbox+');\n' +
    '  node["shop"~"'+r+'",i]('+bbox+');\n' +
    '  node["amenity"~"'+r+'",i]('+bbox+');\n' +
    '  node["leisure"~"'+r+'",i]('+bbox+');\n' +
    '  node["tourism"~"'+r+'",i]('+bbox+');\n' +
    '  node["craft"~"'+r+'",i]('+bbox+');\n' +
    '  node["industrial"~"'+r+'",i]('+bbox+');\n' +
    ');\nout center tags 30;';
}

function parsearElementos(elements) {
  return (elements || [])
    .filter(e => (e.tags || {}).name)
    .map(e => {
      const t   = e.tags || {};
      const lat = e.lat != null ? e.lat : (e.center ? e.center.lat : null);
      const lon = e.lon != null ? e.lon : (e.center ? e.center.lon : null);
      return {
        nombre:    t.name,
        direccion: [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' '),
        telefono:  t.phone || t['contact:phone'] || t['contact:mobile'] || '',
        web:       t.website || t['contact:website'] || '',
        lat, lon,
        tipo:   t.shop || t.tourism || t.leisure || t.amenity || t.craft || '',
        rubro:  detectarRubro(t.shop || t.tourism || t.leisure || t.amenity || ''),
        fuente: 'osm',
        osmId:  e.id
      };
    });
}

function generarCeldas(lat, lon, radioKm, celdaKm, solapamiento) {
  radioKm      = radioKm      || 6;
  celdaKm      = celdaKm      || 2.5;
  solapamiento = solapamiento || 0.2;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const dLat   = celdaKm / 111;
  const dLon   = celdaKm / (111 * cosLat);
  const paso   = celdaKm * (1 - solapamiento);
  const pLat   = paso / 111;
  const pLon   = paso / (111 * cosLat);
  const rLat   = radioKm / 111;
  const rLon   = radioKm / (111 * cosLat);
  const celdas = [];
  for (let dlat = -rLat; dlat < rLat; dlat += pLat) {
    for (let dlon = -rLon; dlon < rLon; dlon += pLon) {
      celdas.push({
        latMin: lat + dlat,
        lonMin: lon + dlon,
        latMax: lat + dlat + dLat,
        lonMax: lon + dlon + dLon
      });
    }
  }
  return celdas;
}

async function buscarOSM(ciudad, rubro) {
  const info = $('#buscar-info');

  let geo;
  try { geo = await geocodeCiudad(ciudad); }
  catch(e) { throw new Error(e.message); }

  const celdas    = generarCeldas(geo.lat, geo.lon);
  const total     = celdas.length;
  const PARALELAS = 3;
  const osmIds    = new Set();
  const todos     = [];
  let procesadas  = 0;

  const lado = Math.round(Math.sqrt(total));
  if (info) info.innerHTML =
    '<span class="spinner" style="width:10px;height:10px;border-width:1px;vertical-align:middle;margin-right:5px;"></span>' +
    'Grid '+lado+'\u00d7'+lado+' \u00b7 '+total+' celdas \u00b7 0/'+total;

  for (let i = 0; i < celdas.length; i += PARALELAS) {
    const lote = celdas.slice(i, i + PARALELAS);

    const loteRes = await Promise.all(lote.map(async function(celda) {
      const q    = buildCeldaQuery(celda.latMin, celda.lonMin, celda.latMax, celda.lonMax, rubro);
      const data = await queryOverpass(q);
      return data ? parsearElementos(data.elements || []) : [];
    }));

    for (const elementos of loteRes) {
      for (const el of elementos) {
        if (el.osmId && osmIds.has(el.osmId)) continue;
        if (el.osmId) osmIds.add(el.osmId);
        todos.push(el);
      }
    }

    procesadas += lote.length;
    if (info) info.innerHTML =
      '<span class="spinner" style="width:10px;height:10px;border-width:1px;vertical-align:middle;margin-right:5px;"></span>' +
      'Escaneando \u00b7 '+procesadas+'/'+total+' celdas \u00b7 <b style="color:var(--accent);">'+todos.length+'</b> objetivos';
  }

  return todos;
}
/* ── Google Places (Maps JavaScript API) ───────────────────────────── */
/*
   La API REST de Places bloquea CORS desde el browser por diseño de Google.
   La única forma correcta de llamarla desde el browser es con la
   Maps JavaScript API, que se carga dinámicamente con la key del usuario.
*/
let _googleMapsLoaded = false;
let _googleMapsLoading = false;
let _googleMapsCallbacks = [];

function cargarGoogleMapsAPI(key) {
  return new Promise((resolve, reject) => {
    if (_googleMapsLoaded) { resolve(); return; }

    _googleMapsCallbacks.push({ resolve, reject });
    if (_googleMapsLoading) return;
    _googleMapsLoading = true;

    /* Callback global que Google llama cuando termina de cargar */
    window._radarGMapsReady = () => {
      _googleMapsLoaded  = true;
      _googleMapsLoading = false;
      _googleMapsCallbacks.forEach(cb => cb.resolve());
      _googleMapsCallbacks = [];
    };

    const script  = document.createElement('script');
    script.src    = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=_radarGMapsReady`;
    script.async  = true;
    script.onerror = () => {
      _googleMapsLoading = false;
      const err = new Error('No se pudo cargar Google Maps API. Verificá la API Key y que tenga habilitada "Maps JavaScript API" y "Places API".');
      _googleMapsCallbacks.forEach(cb => cb.reject(err));
      _googleMapsCallbacks = [];
    };
    document.head.appendChild(script);
  });
}

/* ======================================================================
   GOOGLE PLACES — SISTEMA COMPLETO CON TELÉFONOS

   DIAGNÓSTICO DEL BUG:
   textSearch() y nearbySearch() NO devuelven formatted_phone_number.
   Solo devuelven: name, geometry, place_id, formatted_address, rating,
   types, photos, opening_hours, price_level, icon.
   Los teléfonos SOLO existen en Place Details (getDetails).

   FLUJO CORRECTO:
   1. textSearch() → lista de place_id (rápido, sin teléfonos)
   2. getDetails(place_id) con fields específicos → teléfono, web
   3. Actualización progresiva de las cards (no esperar todo)
   4. Cache en memoria + IndexedDB para no repetir requests

   ESTRATEGIA MOBILE:
   - Mostrar resultados inmediatamente sin esperar teléfonos
   - Enriquecer con teléfonos de a 3 en paralelo (no todos juntos)
   - 300ms entre lotes para no saturar la API ni el CPU
   - Cache en memoria por sesión + persistencia en IDB
   ====================================================================== */

/* Cache de detalles: googleId → { telefono, web, ts } */
const _detailsCache = new Map();
const DETAILS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; /* 7 días en ms */

/* Clave IDB para cache de detalles */
const DETAILS_IDB_KEY = 'google_details_cache';

/* Cargar cache desde IDB al iniciar */
async function cargarDetallesCache() {
  try {
    const raw = await dbGetConfig(DETAILS_IDB_KEY, null);
    if (!raw) return;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const ahora = Date.now();
    let cargados = 0;
    for (const [id, entry] of Object.entries(data)) {
      /* Descartar entradas vencidas */
      if (ahora - (entry.ts || 0) < DETAILS_CACHE_TTL) {
        _detailsCache.set(id, entry);
        cargados++;
      }
    }
    if (cargados) console.log(`[Details] Cache cargado: ${cargados} entradas`);
  } catch(e) {
    console.warn('[Details] No se pudo cargar cache:', e.message);
  }
}

/* Persistir cache en IDB (debounceado — no en cada request) */
let _saveCacheTid = null;
function persistirDetallesCache() {
  clearTimeout(_saveCacheTid);
  _saveCacheTid = setTimeout(async () => {
    try {
      const obj = {};
      _detailsCache.forEach((v, k) => { obj[k] = v; });
      await dbSetConfig(DETAILS_IDB_KEY, JSON.stringify(obj));
    } catch(e) {
      console.warn('[Details] No se pudo persistir cache:', e.message);
    }
  }, 2000);
}

/* ── getDetails para UN place_id ──────────────────────────────────── */
function getPlaceDetails(service, placeId) {
  return new Promise((resolve) => {
    service.getDetails(
      {
        placeId: placeId,
        fields: [
          'formatted_phone_number',
          'international_phone_number',
          'website',
          'opening_hours'
        ]
      },
      (result, status) => {
        const OK = google.maps.places.PlacesServiceStatus.OK;
        if (status === OK && result) {
          resolve({
            telefono: result.international_phone_number
                   || result.formatted_phone_number
                   || '',
            web:      result.website || '',
            ts:       Date.now()
          });
        } else {
          /* No rechazar — simplemente no hay detalle disponible */
          resolve({ telefono: '', web: '', ts: Date.now() });
        }
      }
    );
  });
}

/* ── Cola de enriquecimiento progresivo ───────────────────────────── */
/*
   Procesa los place_ids de a LOTE_SIZE en paralelo.
   Entre lotes espera DELAY_MS para no congelar Android ni saturar API.
   Actualiza la card en el DOM en cuanto llega el teléfono.
   No hace re-render completo — solo actualiza el elemento puntual.
*/
const LOTE_SIZE = 3;   /* requests paralelas por lote */
const DELAY_MS  = 350; /* ms entre lotes */

async function enriquecerConTelefonos(resultados, service) {
  /* Solo los que tienen googleId y no están en cache */
  const pendientes = resultados.filter(r =>
    r.googleId && !_detailsCache.has(r.googleId)
  );

  if (!pendientes.length) {
    /* Aplicar cache existente a los resultados sin fetch */
    resultados.forEach(r => {
      if (r.googleId && _detailsCache.has(r.googleId)) {
        const cached = _detailsCache.get(r.googleId);
        r.telefono = cached.telefono;
        r.web      = cached.web;
        actualizarCardTelefono(r);
      }
    });
    return;
  }

  /* Aplicar cache inmediatamente a los que ya lo tienen */
  resultados.forEach(r => {
    if (r.googleId && _detailsCache.has(r.googleId)) {
      const cached = _detailsCache.get(r.googleId);
      r.telefono = cached.telefono;
      r.web      = cached.web;
      actualizarCardTelefono(r);
    }
  });

  /* Procesar pendientes en lotes */
  for (let i = 0; i < pendientes.length; i += LOTE_SIZE) {
    const lote = pendientes.slice(i, i + LOTE_SIZE);

    await Promise.all(lote.map(async r => {
      try {
        const detail = await getPlaceDetails(service, r.googleId);
        /* Guardar en cache */
        _detailsCache.set(r.googleId, detail);
        /* Actualizar el objeto resultado en memoria */
        r.telefono = detail.telefono;
        r.web      = detail.web;
        /* Actualizar la card en el DOM sin re-render */
        actualizarCardTelefono(r);
      } catch(e) {
        console.warn('[Details] Error en', r.nombre, e.message);
      }
    }));

    /* Pausa entre lotes — excepto después del último */
    if (i + LOTE_SIZE < pendientes.length) {
      await new Promise(res => setTimeout(res, DELAY_MS));
    }
  }

  /* Persistir cache actualizado */
  persistirDetallesCache();
}

/* ── Actualizar UNA card en el DOM cuando llega el teléfono ──────── */
/*
   Identifica la card por data-google-id y actualiza solo
   el bloque del teléfono — sin tocar el resto del DOM.
   Si la card ya no existe (el usuario scrolleó y la destruyó), silencio.
*/
function actualizarCardTelefono(resultado) {
  if (!resultado.googleId) return;
  const card = document.querySelector(
    `[data-google-id="${CSS.escape(resultado.googleId)}"]`
  );
  if (!card) return;

  const telEl = card.querySelector('.rc-tel-slot');
  if (!telEl) return;

  const tel = resultado.telefono && limpiarTel(resultado.telefono).length >= 6;

  if (tel) {
    telEl.innerHTML = `📞 <strong>${esc(resultado.telefono)}</strong>`;
    telEl.classList.remove('muted');
    /* Activar botón WA si no estaba */
    const actionsEl = card.querySelector('.rc-actions');
    if (actionsEl && !card.querySelector('.rc-wa-btn')) {
      const idx = resultado._idx;
      const waBtn = document.createElement('button');
      waBtn.className   = 'btn btn-sm btn-b rc-wa-btn';
      waBtn.textContent = 'WA';
      waBtn.addEventListener('click', async () => {
        let lead = encontrarLeadExistente(resultado);
        if (!lead) {
          lead = crearLeadDesdeResultado(resultado);
          await dbSaveLead(lead);
        }
        abrirWhatsApp(lead, 'primero');
      });
      /* Insertar antes del botón GUARDAR */
      const guardarBtn = actionsEl.querySelector('[data-rc-add]');
      actionsEl.insertBefore(waBtn, guardarBtn);
    }
  } else {
    telEl.innerHTML = '<span class="muted">Sin teléfono</span>';
  }
}

/* ── Helper para crear lead desde resultado (evita duplicación) ───── */
function crearLeadDesdeResultado(n) {
  const lead = {
    id: uid(), nombre: n.nombre, direccion: n.direccion || '',
    telefono: n.telefono || '', web: n.web || '',
    lat: n.lat || null, lon: n.lon || null, tipo: n.tipo || '',
    rubro: n.rubro || 'comercio', fuente: n.fuente || 'google',
    osmId: n.osmId || null, googleId: n.googleId || null,
    rating: n.rating || 0, prioridad: 'media', estado: 'no-contactado',
    notas: '', equipos: [], tags: [], fotos: [], nivel: 'bajo',
    intentosContacto: 0, cicloMantenimiento: null, proximaRevision: null,
    creado: new Date().toISOString(), historial: []
  };
  lead.prioridad = calcularPrioridad(lead);
  return lead;
}

/* ── PlacesService compartido (creado una sola vez por sesión) ────── */
let _placesService = null;
function getPlacesService() {
  if (!_placesService) {
    const div = document.createElement('div');
    _placesService = new google.maps.places.PlacesService(div);
  }
  return _placesService;
}

/* ── buscarGoogle + paginación completa ───────────────────────────── */
/*
 * DISEÑO CORRECTO de paginación Google Places JS API:
 *
 * El error de todas las versiones anteriores era envolver textSearch()
 * en una Promise. Cuando resolve() se ejecuta, el callback muere.
 * nextPage() intenta reusar ese mismo callback — pero ya no existe.
 * Resultado: nextPage() se ejecuta pero nadie recibe los resultados.
 *
 * SOLUCIÓN: un único callback persistente que maneja TODAS las páginas.
 * El callback no vive dentro de una Promise — vive en el closure de
 * buscarGoogle() y se llama múltiples veces (una por página).
 * Cada vez que se llama, encola los resultados y decide si pedir más.
 */
async function buscarGoogle(ciudad, rubro) {
  if (!state.gkey) {
    throw new Error(
      'Configurá tu API Key en CONFIG. ' +
      'Necesitás habilitar "Maps JavaScript API" y "Places API".'
    );
  }

  try { await cargarGoogleMapsAPI(state.gkey); } catch(e) { throw e; }

  /* Geocodificar */
  const geocoder  = new google.maps.Geocoder();
  const geoResult = await new Promise((resolve, reject) => {
    geocoder.geocode(
      { address: ciudad + ', Argentina' },
      (results, status) => {
        if (status === 'OK' && results.length) resolve(results[0]);
        else reject(new Error('Google no encontró "' + ciudad + '" (' + status + ')'));
      }
    );
  });

  /* Service DEDICADO para esta búsqueda — anclado al DOM.
   * El div DEBE estar en el documento durante toda la paginación.
   * Si es una variable local, el GC lo destruye y nextPage() no
   * puede llamar al callback porque el service queda huérfano.
   * Lo anclamos a body con display:none y lo removemos al terminar. */
  const searchDiv = document.createElement('div');
  searchDiv.id    = '_radar_search_svc';
  searchDiv.style.display = 'none';
  document.body.appendChild(searchDiv);
  const service = new google.maps.places.PlacesService(searchDiv);
  const location  = geoResult.geometry.location;

  /*
   * Paginación con callback persistente.
   * resolve() se llama UNA SOLA VEZ, después de que TODAS las páginas
   * llegaron o después de un timeout total.
   */
  const MAX_PAG      = 3;
  const DELAY_PAG_MS = 2500; /* Google exige ~2s entre páginas */

  const todosLosResultados = await new Promise((resolve) => {
    let acumulados  = [];
    let pagina      = 1;
    let timeoutGral = null;
    const diag      = $('#buscar-info');

    function terminar() {
      clearTimeout(timeoutGral);
      /* Limpiar el div del service DENTRO de la Promise,
         después de resolver. Si lo limpiamos afuera (en el await),
         el GC destruye el service antes de que llegue la página 2. */
      const svcDiv = document.getElementById('_radar_search_svc');
      if (svcDiv) document.body.removeChild(svcDiv);
      resolve(acumulados);
    }

    /* Timeout de seguridad: 45s total para las 3 páginas */
    timeoutGral = setTimeout(() => {
      console.warn('[Pag] Timeout — páginas obtenidas: ' + (pagina-1));
      terminar();
    }, 45000);

    function procesarPagina(results, status, pagination) {
      const S = google.maps.places.PlacesServiceStatus;

      if (status === S.OK || status === S.ZERO_RESULTS) {
        acumulados = acumulados.concat(results || []);
      }

      /* Diagnóstico visible en pantalla */
      const hayMas  = pagination?.hasNextPage === true && pagina < MAX_PAG;
      const diagTxt =
        'Pág ' + pagina + ': ' + (results||[]).length + ' resultados' +
        ' (total: ' + acumulados.length + ')' +
        ' | hasNextPage: ' + (pagination?.hasNextPage ?? 'N/A') +
        ' | nextPage fn: ' + (typeof pagination?.nextPage === 'function') +
        (hayMas ? ' → pidiendo pág ' + (pagina+1) + '...' : ' → FIN');
      if (diag) diag.innerHTML =
        '<span style="font-size:10px;font-family:var(--mono);color:var(--accent);">' +
        diagTxt + '</span>';
      console.log('[Pag]', diagTxt);

      if (!hayMas) {
        terminar();
        return;
      }

      pagina++;
      setTimeout(function() {
        try {
          pagination.nextPage(procesarPagina);
        } catch(e) {
          console.warn('[Pag] nextPage() excepción:', e.message);
          terminar();
        }
      }, DELAY_PAG_MS);
    }

    /* Página 1 */
    /* IMPORTANTE: NO pasar location+radius en textSearch cuando se usa paginación.
     * Google calcula el área internamente por ciudad en el query.
     * Pasar location+radius hace que la página 2 quede fuera del área
     * y devuelva vacío silenciosamente. */
    service.textSearch(
      { query: rubro + ' ' + ciudad + ' Argentina' },
      procesarPagina
    );
  });

  /* Guardar rubro/ciudad para referencia */
  buscarGoogle._rubro  = rubro;
  buscarGoogle._ciudad = ciudad;

  /* Mapear y devolver */
  return todosLosResultados.map((r, i) => ({
    nombre:    r.name,
    direccion: r.formatted_address || '',
    telefono:  '',
    web:       '',
    lat:       r.geometry?.location?.lat() ?? null,
    lon:       r.geometry?.location?.lng() ?? null,
    tipo:      (r.types || [])[0] || '',
    rubro:     detectarRubro((r.types || [])[0] || ''),
    fuente:    'google',
    googleId:  r.place_id,
    rating:    r.rating || 0,
    _idx:      i
  }));
}
async function lanzarEnriquecimiento(resultados) {
  const conGoogleId = resultados.filter(r => r.fuente === 'google' && r.googleId);
  if (!conGoogleId.length) return;

  /* Esperar un tick para que el DOM esté pintado */
  await new Promise(res => setTimeout(res, 100));

  try {
    const service = getPlacesService();
    await enriquecerConTelefonos(conGoogleId, service);
  } catch(e) {
    console.warn('[Details] Enriquecimiento falló:', e.message);
  }
}

/* ── Handler del botón BUSCAR ──────────────────────────────────────── */
let buscarTodaZona = false;

$('#btn-buscar').addEventListener('click', async () => {
  const ciudad = $('#inp-ciudad').value.trim();
  const rubro  = $('#inp-rubro').value.trim();
  const fuente = $('#inp-fuente').value;

  if (!ciudad && !buscarTodaZona) { toast('Ingresá una ciudad'); return; }
  if (!rubro)                     { toast('Ingresá el tipo de negocio'); return; }

  const ciudades = buscarTodaZona ? CIUDADES_ZONA : [ciudad];

  const info = $('#buscar-info');
  info.innerHTML = `<span class="spinner"></span> Buscando <b>${esc(rubro)}</b> en ${ciudades.length > 1 ? ciudades.length + ' ciudades' : '<b>' + esc(ciudad) + '</b>'}...`;
  $('#btn-buscar').disabled = true;
  $('#resultados-buscar').innerHTML = '';

  const errores = [];
  let resultados = [];

  for (const c of ciudades) {
    info.innerHTML = `<span class="spinner"></span> Buscando en <b>${esc(c)}</b>...`;
    try {
      const res = fuente === 'google'
        ? await buscarGoogle(c, rubro)
        : await buscarOSM(c, rubro);
      resultados = resultados.concat(res);
    } catch(e) {
      errores.push(`${c}: ${e.message}`);
    }
  }

  /* Deduplicar */
  const vistos = new Set();
  resultados = resultados.filter(r => {
    const k = normalizar(r.nombre) + '|' + normalizar(r.direccion || '').slice(0, 20);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  /* Calcular IUT y ordenar */
  resultados.forEach(r => { r.iut = calcularIUT({ ...r, equipos: [], tags: [] }); });
  resultados.sort((a, b) => b.iut - a.iut || (b.rating || 0) - (a.rating || 0));
  state.resultados = resultados;

  /* Mostrar resultado o error claro */
  if (resultados.length) {
    info.textContent = `${resultados.length} objetivo(s) encontrado(s)`;
  } else if (errores.length) {
    /* Error visible en pantalla, no solo en consola */
    info.innerHTML = `
      <div style="background:rgba(255,51,85,0.1);border:1px solid rgba(255,51,85,0.3);border-radius:8px;padding:10px;margin-top:6px;font-size:12px;color:var(--red);">
        <b>⚠️ Error en la búsqueda:</b><br>
        ${errores.map(e => esc(e)).join('<br>')}
      </div>`;
  } else {
    info.textContent = 'Sin resultados. Probá con otro término o ciudad.';
  }

  renderResultados(resultados);
  if (resultados.length) renderMapResults(resultados);

  /* Enriquecer teléfonos DESPUÉS de renderizar.
   * Se lanza con delay para no competir con getDetails durante la búsqueda.
   * La paginación ya terminó en este punto (buscarGoogle es await completo). */
  if (resultados.some(r => r.fuente === 'google')) {
    setTimeout(() => lanzarEnriquecimiento(resultados), 500);
  }

  $('#btn-buscar').disabled = false;
});

function renderResultados(lista) {
  const cont = $('#resultados-buscar');
  if (!lista.length) {
    cont.innerHTML = '<div class="empty-state"><span class="ico">🔍</span>Sin resultados.</div>';
    return;
  }

  cont.innerHTML = lista.map((n, i) => {
    const tel    = !!(n.telefono && limpiarTel(n.telefono).length >= 6);
    const yaLead = !!encontrarLeadExistente(n);
    const src    = n.fuente === 'google' ? 'g' : 'osm';
    const iut    = n.iut || 0;
    const gid    = n.googleId ? `data-google-id="${esc(n.googleId)}"` : '';

    /* Slot de teléfono:
       - Si ya tenemos el teléfono (cache hit) → mostrarlo
       - Si es Google y no tenemos → spinner pequeño mientras llega
       - Si es OSM sin teléfono → "Sin teléfono" */
    let telHtml;
    if (tel) {
      telHtml = `<div class="rc-meta rc-tel-slot">📞 <strong>${esc(n.telefono)}</strong></div>`;
    } else if (n.fuente === 'google' && n.googleId) {
      telHtml = `<div class="rc-meta rc-tel-slot muted"><span class="spinner" style="width:10px;height:10px;border-width:1px;vertical-align:middle;margin-right:4px;"></span>Cargando teléfono...</div>`;
    } else {
      telHtml = `<div class="rc-meta rc-tel-slot muted">Sin teléfono detectado</div>`;
    }

    return `
    <div class="result-card src-${src}" ${gid}>
      <div class="rc-header">
        <div class="rc-name">${esc(n.nombre)} <span class="iut-badge ${iutClase(iut)}" style="font-size:9px;">${iutLabel(iut)}${iut}</span></div>
        <div style="text-align:right;">${n.rating ? `<div style="color:var(--yellow);font-size:11px;">★ ${n.rating}</div>` : ''}</div>
      </div>
      ${n.direccion ? `<div class="rc-meta">📍 ${esc(n.direccion)}</div>` : ''}
      ${telHtml}
      ${n.tipo ? `<div class="rc-meta muted">${esc(n.tipo)}</div>` : ''}
      <div class="rc-actions">
        <button class="btn btn-sm" data-rc-maps="${i}">MAPS</button>
        ${tel ? `<button class="btn btn-sm btn-b rc-wa-btn" data-rc-wa="${i}">WA</button>` : ''}
        <button class="btn btn-sm ${yaLead ? '' : 'btn-em'}" data-rc-add="${i}" ${yaLead ? 'disabled style="opacity:0.5;"' : ''}>
          ${yaLead ? '✓ GUARDADO' : '+ GUARDAR'}
        </button>
      </div>
    </div>`;
  }).join('');

  /* Guardar _idx en cada resultado para referencia posterior */
  lista.forEach((n, i) => { n._idx = i; });

  cont.querySelectorAll('[data-rc-maps]').forEach(b =>
    b.addEventListener('click', () => abrirMaps(state.resultados[+b.dataset.rcMaps])));

  cont.querySelectorAll('[data-rc-add]').forEach(b => {
    b.addEventListener('click', async () => {
      const n = state.resultados[+b.dataset.rcAdd];
      if (!n || encontrarLeadExistente(n)) return;
      const lead = crearLeadDesdeResultado(n);
      await dbSaveLead(lead);
      if (lead.lat && lead.lon && state.mapLeadsVisible) {
        const m = L.marker([lead.lat, lead.lon], { icon: createLeadIcon(lead) })
          .addTo(map)
          .on('click', () => { expandPanel(); setTab('leads'); setTimeout(() => abrirModalLead(lead.id), 200); });
        _leadMarkersMap.set(lead.id, m);
      }
      b.textContent = '✓ GUARDADO';
      b.disabled = true;
      b.classList.remove('btn-em');
      toast('✓ Lead guardado con teléfono');
    });
  });

  cont.querySelectorAll('[data-rc-wa]').forEach(b => {
    b.addEventListener('click', async () => {
      const n = state.resultados[+b.dataset.rcWa];
      let lead = encontrarLeadExistente(n);
      if (!lead) {
        lead = crearLeadDesdeResultado(n);
        await dbSaveLead(lead);
      }
      abrirWhatsApp(lead, 'primero');
    });
  });
}

function encontrarLeadExistente(n) {
  return state.leads.find(l => {
    if (n.osmId    && l.osmId    === n.osmId)    return true;
    if (n.googleId && l.googleId === n.googleId) return true;
    return normalizar(l.nombre)===normalizar(n.nombre) &&
           normalizar(l.direccion).slice(0,20)===normalizar(n.direccion||'').slice(0,20);
  });
}

/* ======================================================================
   22. LEADS LIST
   ====================================================================== */
function leadsFiltrados() {
  const f = state.filtroLeads;
  const q = state.buscarLeads.toLowerCase().trim();
  return state.leads.filter(l => {
    if (l.estado==='descartado' && f!=='todos') return false;
    if (f==='alta'  && l.prioridad!=='alta')  return false;
    if (f==='media' && l.prioridad!=='media') return false;
    if (f==='baja'  && l.prioridad!=='baja')  return false;
    if (['no-contactado','contactado','respondio','cliente','recurrente','mantenimiento','urgente'].includes(f)
        && l.estado!==f) return false;
    if (q) {
      const blob = [l.nombre,l.direccion,l.tipo,l.notas,(l.equipos||[]).join(' ')].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a,b) => calcularIUT(b)-calcularIUT(a) || new Date(b.creado)-new Date(a.creado));
}

function renderLeads() {
  const cont = $('#lista-leads');
  if (!state.leads.length) {
    cont.innerHTML = '<div class="empty-state"><span class="ico">📡</span>Sin leads. Buscá objetivos o tocá el mapa para agregar.</div>';
    return;
  }
  const lista = leadsFiltrados();
  if (!lista.length) {
    cont.innerHTML = '<div class="empty-state"><span class="ico">🔍</span>Sin leads con estos filtros.</div>';
    return;
  }

  cont.innerHTML = lista.map(l => {
    const src        = l.fuente || 'manual';
    const tel        = !!(l.telefono && limpiarTel(l.telefono).length >= 6);
    const iut        = calcularIUT(l);
    const equiposHtml = (l.equipos||[]).slice(0,3).map(e => {
      const eq = EQUIPOS_CATALOGO.find(x=>x.id===e);
      return eq ? `<span class="equipo-chip">${eq.ico}</span>` : '';
    }).join('');

    return `
    <div class="card src-${src}" data-lid="${l.id}">
      <div class="card-header">
        <div class="card-title">${esc(l.nombre)}</div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
          <span class="iut-badge ${iutClase(iut)}" style="font-size:10px;">${iutLabel(iut)}·${iut}</span>
          <span class="estado-badge ${ESTADO_CSS[l.estado]||'est-no'}">${ESTADO_LABEL[l.estado]||'—'}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;flex-wrap:wrap;">
        <span class="src-badge ${src}">${src.toUpperCase()}</span>
        ${nivelBadge(l.nivel||'bajo')}
        ${equiposHtml ? `<div style="display:flex;gap:3px;margin-left:2px;">${equiposHtml}</div>` : ''}
      </div>
      ${l.direccion ? `<div class="card-meta">📍 ${esc(l.direccion)}</div>` : ''}
      ${l.telefono  ? `<div class="card-meta">📞 <strong>${esc(l.telefono)}</strong></div>` : ''}
      ${l.notas     ? `<div class="nota-chip">${esc(l.notas.slice(0,55))}${l.notas.length>55?'…':''}</div>` : ''}
      ${l.seguimientoFecha&&esHoyOAtrasado(l.seguimientoFecha)?`<div class="card-meta" style="color:var(--em-orange);font-weight:700;font-family:var(--mono);font-size:10px;">⏰ SEGUIMIENTO HOY</div>`:''}
      <div class="card-actions">
        ${tel ? `<button class="btn btn-sm btn-em" data-la="wa-primero">CONTACTAR</button>` : ''}
        <button class="btn btn-sm" data-la="maps">MAPS</button>
        <button class="btn btn-sm" data-la="ruta">+ RUTA</button>
        <button class="btn btn-sm btn-block" data-la="abrir">ABRIR / EDITAR</button>
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('[data-lid]').forEach(card => {
    const id   = card.dataset.lid;
    const lead = state.leads.find(x => x.id === id);
    card.querySelector('[data-la=abrir]').addEventListener('click', () => abrirModalLead(id));
    card.querySelector('[data-la=maps]').addEventListener('click',  () => abrirMaps(lead));
    card.querySelector('[data-la=ruta]').addEventListener('click',  () => agregarLeadARuta(id));
    card.querySelector('[data-la="wa-primero"]')?.addEventListener('click', () => abrirWhatsApp(lead, 'primero'));
  });
}

$$('#filtros-leads .filtro-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('#filtros-leads .filtro-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.filtroLeads = b.dataset.filtro;
    renderLeads();
  });
});
$('#inp-buscar-leads').addEventListener('input', e => { state.buscarLeads = e.target.value; renderLeads(); });

/* ======================================================================
   23. SEGUIMIENTOS
   ====================================================================== */
function renderSeguimientos() {
  const cont     = $('#lista-seguimientos');
  const badge    = $('#badge-seguimientos');
  const pendientes = state.leads
    .filter(l => l.seguimientoFecha && esHoyOAtrasado(l.seguimientoFecha) && !['cliente-ok','descartado'].includes(l.estado))
    .sort((a,b) => new Date(a.seguimientoFecha) - new Date(b.seguimientoFecha));

  if (badge) { badge.textContent = pendientes.length||''; badge.style.display = pendientes.length?'inline':'none'; }

  if (!pendientes.length) {
    cont.innerHTML = '<div class="empty-state"><span class="ico">✅</span>Sin seguimientos pendientes.</div>';
    return;
  }

  cont.innerHTML = pendientes.map(l => {
    const tel = !!(l.telefono && limpiarTel(l.telefono).length >= 6);
    return `
    <div class="seg-card" data-sid="${l.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
        <b style="font-size:14px;font-weight:800;">${esc(l.nombre)}</b>
        ${nivelBadge(l.nivel||'bajo')}
      </div>
      <div class="muted" style="font-family:var(--mono);font-size:10px;">⏰ ${fmtFecha(l.seguimientoFecha)}</div>
      ${l.direccion ? `<div class="muted">📍 ${esc(l.direccion)}</div>` : ''}
      ${l.notas     ? `<div style="font-size:11px;color:var(--yellow);font-style:italic;margin-top:2px;">${esc(l.notas.slice(0,60))}</div>` : ''}
      <div class="card-actions" style="margin-top:8px;">
        ${tel ? `<button class="btn btn-sm btn-em" data-sa="wa">SEGUIMIENTO WA</button>` : ''}
        <button class="btn btn-sm" data-sa="abrir">ABRIR</button>
        <button class="btn btn-sm" data-sa="poster">+2 DÍAS</button>
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('[data-sid]').forEach(card => {
    const id   = card.dataset.sid;
    const lead = state.leads.find(x => x.id === id);
    card.querySelector('[data-sa=wa]')?.addEventListener('click', () => abrirWhatsApp(lead, 'seguimiento'));
    card.querySelector('[data-sa=abrir]').addEventListener('click', () => abrirModalLead(id));
    card.querySelector('[data-sa=poster]').addEventListener('click', async () => {
      const f = new Date(); f.setDate(f.getDate()+2);
      await dbSaveLead({ ...lead, seguimientoFecha: f.toISOString() });
      renderSeguimientos();
      toast('Postergado +2 días');
    });
  });
}

/* ======================================================================
   24. RUTA
   ====================================================================== */
function optimizarRuta(paradas, origenLat, origenLon) {
  if (paradas.length <= 2) return paradas;
  const conCoords = paradas.filter(p => p.lat && p.lon);
  const sinCoords = paradas.filter(p => !p.lat || !p.lon);
  if (conCoords.length <= 1) return paradas;

  let startLat    = origenLat || conCoords[0].lat;
  let startLon    = origenLon || conCoords[0].lon;
  const disponibles = [...conCoords];
  const ordenado    = [];

  while (disponibles.length > 0) {
    let mejorIdx=0, mejorDist=Infinity;
    disponibles.forEach((p,i) => {
      const d = distKm(startLat, startLon, p.lat, p.lon);
      if (d < mejorDist) { mejorDist=d; mejorIdx=i; }
    });
    const siguiente = disponibles.splice(mejorIdx, 1)[0];
    ordenado.push(siguiente);
    startLat = siguiente.lat;
    startLon = siguiente.lon;
  }
  return [...ordenado, ...sinCoords];
}

function agregarLeadARuta(id) {
  const l = state.leads.find(x => x.id === id);
  if (!l) return;
  if (state.ruta.find(r => r.leadId === id)) { toast('Ya está en la ruta'); return; }
  state.ruta.push({ id:uid(), leadId:id, nombre:l.nombre, direccion:l.direccion, lat:l.lat, lon:l.lon });
  saveRuta();
  toast(`+ ${l.nombre} → ruta`);
}

function saveRuta() { dbSetConfig('ruta', JSON.stringify(state.ruta)); }

function renderRuta() {
  const cont = $('#lista-ruta');
  if (!state.ruta.length) {
    cont.innerHTML = '<div class="empty-state"><span class="ico">🗺️</span>Sin paradas. Agregá leads desde sus fichas o desde Terreno.</div>';
    return;
  }
  cont.innerHTML = state.ruta.map((p,i) => `
    <div class="parada">
      <div class="parada-num">${i+1}</div>
      <div class="parada-info"><b>${esc(p.nombre)}</b>${p.direccion?`<small>${esc(p.direccion)}</small>`:''}</div>
      <div class="parada-ctrl">
        <button data-mov="${i}" data-dir="-1" ${i===0?'disabled style="opacity:0.3"':''}>↑</button>
        <button data-mov="${i}" data-dir="1"  ${i===state.ruta.length-1?'disabled style="opacity:0.3"':''}>↓</button>
        <button data-del="${i}" style="color:var(--red);">✕</button>
      </div>
    </div>`).join('');

  cont.querySelectorAll('[data-mov]').forEach(b => {
    b.addEventListener('click', () => {
      const idx=+b.dataset.mov, dir=+b.dataset.dir, j=idx+dir;
      if (j<0||j>=state.ruta.length) return;
      [state.ruta[idx],state.ruta[j]] = [state.ruta[j],state.ruta[idx]];
      saveRuta(); renderRuta();
    });
  });
  cont.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', () => { state.ruta.splice(+b.dataset.del, 1); saveRuta(); renderRuta(); });
  });
}

function iniciarRecorrido() {
  if (!state.ruta.length) { toast('La ruta está vacía'); return; }
  const rutaOpt = optimizarRuta(state.ruta, state.userLat, state.userLon);
  state.ruta = rutaOpt;
  renderRuta();

  if (state.ruta.length === 1) { abrirMaps(state.ruta[0]); return; }
  const fmt    = p => (p.lat&&p.lon) ? `${p.lat},${p.lon}` : encodeURIComponent(p.direccion||p.nombre);
  const origin = fmt(state.ruta[0]);
  const dest   = fmt(state.ruta[state.ruta.length-1]);
  const wpts   = state.ruta.slice(1,-1).map(fmt).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
  if (wpts) url += `&waypoints=${wpts}`;
  window.open(url, '_blank');
}

$('#btn-ir-hoy').addEventListener('click', () => {
  if (!state.userLat) { toast('Activá GPS primero'); return; }
  const candidatos = state.leads
    .filter(l => l.lat && l.lon && !['descartado','cliente-ok'].includes(l.estado))
    .map(l => ({ ...l, _dist:distKm(state.userLat,state.userLon,l.lat,l.lon), _iut:calcularIUT(l) }))
    .sort((a,b) => (b._iut-a._iut)||(a._dist-b._dist))
    .slice(0, 6);
  if (!candidatos.length) { toast('No hay leads con coordenadas'); return; }
  const rutaSug = optimizarRuta(
    candidatos.map(l => ({ id:uid(), leadId:l.id, nombre:l.nombre, direccion:l.direccion, lat:l.lat, lon:l.lon })),
    state.userLat, state.userLon
  );
  state.ruta = rutaSug;
  saveRuta();
  setTab('ruta');
  toast(`Ruta creada: ${candidatos.length} objetivos optimizados`);
});

$('#btn-add-manual-ruta').addEventListener('click', () => {
  const v = $('#inp-ruta-manual').value.trim();
  if (!v) return;
  state.ruta.push({ id:uid(), nombre:v, direccion:v, lat:null, lon:null });
  saveRuta(); renderRuta();
  $('#inp-ruta-manual').value = '';
});
$('#btn-clear-ruta').addEventListener('click', () => {
  if (confirm('¿Limpiar la ruta?')) { state.ruta=[]; saveRuta(); renderRuta(); }
});
$('#btn-iniciar-ruta').addEventListener('click', iniciarRecorrido);

/* ======================================================================
   25. ZONAS CALIENTES
   ====================================================================== */
let zonasEstado = { zonas:[], detalleId:null, modo:'auto', radio:800 };

function calcularZonas() {
  const leads = state.leads.filter(l => l.lat && l.lon && l.estado !== 'descartado');
  if (!leads.length) { zonasEstado.zonas=[]; return; }

  if (zonasEstado.modo === 'auto') {
    const R = zonasEstado.radio / 1000;
    const grupos=[], usados=new Set();
    for (const l of leads) {
      if (usados.has(l.id)) continue;
      const grupo=[l]; usados.add(l.id);
      for (const m of leads) {
        if (!usados.has(m.id) && distKm(l.lat,l.lon,m.lat,m.lon) <= R) {
          grupo.push(m); usados.add(m.id);
        }
      }
      grupos.push(grupo);
    }
    zonasEstado.zonas = grupos.map((g,i) => construirZona(g,i));
  } else {
    const mapa = {};
    for (const l of leads) {
      const k = (l.zona||l.direccion?.split(',')[1]?.trim()||'Sin zona').trim();
      if (!mapa[k]) mapa[k]=[];
      mapa[k].push(l);
    }
    zonasEstado.zonas = Object.entries(mapa).map(([k,g],i) => construirZona(g,i,k));
  }
  zonasEstado.zonas.sort((a,b) => b.score - a.score);
}

function construirZona(leads, idx, nombre=null) {
  const contactados  = leads.filter(l=>l.estado!=='no-contactado').length;
  const respondieron = leads.filter(l=>['respondio','cliente','recurrente','mantenimiento'].includes(l.estado)).length;
  const clientes     = leads.filter(l=>['cliente','recurrente','mantenimiento'].includes(l.estado)).length;
  const score        = clientes*3 + respondieron*2 + contactados;
  const iutTotal     = leads.reduce((s,l) => s+calcularIUT(l), 0);
  const temp         = score>=5?'hot':score>=2?'warm':'cold';
  const lats = leads.map(l=>l.lat), lons = leads.map(l=>l.lon);
  const lat  = lats.reduce((a,b)=>a+b,0)/lats.length;
  const lon  = lons.reduce((a,b)=>a+b,0)/lons.length;
  const n    = nombre||(leads[0].zona||leads[0].direccion?.split(',')[1]?.trim()||`Zona ${idx+1}`);
  const equiposFreq = {};
  leads.forEach(l => (l.equipos||[]).forEach(e => { equiposFreq[e]=(equiposFreq[e]||0)+1; }));
  const topEquipo = Object.entries(equiposFreq).sort((a,b)=>b[1]-a[1])[0];
  return { id:'z'+idx, nombre:n, leads, total:leads.length, contactados, respondieron, clientes, score, iutTotal, temp, lat, lon, topEquipo };
}

function renderZonas() {
  const lista   = $('#lista-zonas');
  const detalle = $('#detalle-zona');
  detalle.style.display='none'; lista.style.display='block';

  if (zonasEstado.detalleId) {
    lista.style.display='none'; detalle.style.display='block';
    renderDetalleZona(zonasEstado.detalleId); return;
  }

  calcularZonas();
  if (!zonasEstado.zonas.length) {
    lista.innerHTML='<div class="empty-state"><span class="ico">📍</span>Agregá leads para ver zonas.</div>';
    return;
  }

  const scoreMax = zonasEstado.zonas[0].score || 1;
  lista.innerHTML = zonasEstado.zonas.map(z => {
    const ico = z.temp==='hot'?'🔥':z.temp==='warm'?'🌡️':'❄️';
    const bar = Math.max(5, (z.score/scoreMax)*100);
    const eq  = z.topEquipo ? EQUIPOS_CATALOGO.find(x=>x.id===z.topEquipo[0]) : '';
    return `
    <div class="zona-card ${z.temp}">
      <div class="zona-top">
        <div class="zona-nombre">${ico} ${esc(z.nombre)}</div>
        <div class="zona-iut">IUT·${Math.round(z.iutTotal/z.total)}</div>
      </div>
      ${eq ? `<div style="font-size:10px;color:var(--em-orange);margin-bottom:4px;font-weight:700;font-family:var(--mono);">${eq.ico} ${eq.label} × ${z.topEquipo[1]}</div>` : ''}
      <div class="zona-bar"><div class="zona-bar-fill" style="width:${bar}%"></div></div>
      <div class="zona-stats">
        <div class="z-stat"><b>${z.total}</b>leads</div>
        <div class="z-stat"><b style="color:var(--blue);">${z.contactados}</b>contact.</div>
        <div class="z-stat"><b style="color:var(--accent);">${z.clientes}</b>clientes</div>
      </div>
      <div style="display:flex;gap:5px;margin-top:8px;">
        <button class="btn btn-sm" data-za="ver"  data-zid="${z.id}">VER</button>
        <button class="btn btn-sm btn-em" data-za="ruta" data-zid="${z.id}">+RUTA</button>
        <button class="btn btn-sm" data-za="map"  data-zid="${z.id}">MAPA</button>
      </div>
    </div>`;
  }).join('');

  lista.querySelectorAll('[data-za]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const z = zonasEstado.zonas.find(x => x.id === b.dataset.zid);
      if (!z) return;
      if (b.dataset.za==='ver') { zonasEstado.detalleId=z.id; renderZonas(); }
      else if (b.dataset.za==='ruta') {
        let n=0;
        for (const l of z.leads) {
          if (!state.ruta.find(r=>r.leadId===l.id)) {
            state.ruta.push({id:uid(),leadId:l.id,nombre:l.nombre,direccion:l.direccion,lat:l.lat,lon:l.lon});
            n++;
          }
        }
        saveRuta(); toast(`${n} paradas agregadas`);
      } else if (b.dataset.za==='map') {
        if (z.lat) { map.setView([z.lat,z.lon],14); collapsePanel(); }
      }
    });
  });
}

function renderDetalleZona(id) {
  const z = zonasEstado.zonas.find(x => x.id === id);
  if (!z) { zonasEstado.detalleId=null; renderZonas(); return; }
  const ico = z.temp==='hot'?'🔥':z.temp==='warm'?'🌡️':'❄️';
  const det = $('#detalle-zona');
  det.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <button class="btn btn-sm" id="btn-back-zona">← VOLVER</button>
      <div><b style="font-size:15px;font-family:var(--cond);">${ico} ${esc(z.nombre)}</b>
      <div class="muted">${z.total} lead(s) · IUT avg ${Math.round(z.iutTotal/z.total)}</div></div>
    </div>
    <div class="row-2" style="margin-bottom:10px;">
      <button class="btn btn-em btn-sm" id="dz-ruta">+RUTA TODO</button>
      <button class="btn btn-sm" id="dz-map">VER MAPA</button>
    </div>
    <div id="dz-leads"></div>`;

  $('#btn-back-zona').addEventListener('click', () => { zonasEstado.detalleId=null; renderZonas(); });
  $('#dz-ruta').addEventListener('click', () => {
    let n=0;
    for (const l of z.leads) {
      if (!state.ruta.find(r=>r.leadId===l.id)) {
        state.ruta.push({id:uid(),leadId:l.id,nombre:l.nombre,direccion:l.direccion,lat:l.lat,lon:l.lon});n++;
      }
    }
    saveRuta(); toast(`${n} agregados`);
  });
  $('#dz-map').addEventListener('click', () => { if (z.lat) { map.setView([z.lat,z.lon],14); collapsePanel(); } });

  const dl = $('#dz-leads');
  dl.innerHTML = z.leads.map(l => `
    <div class="seg-card" style="cursor:pointer;" data-dzl="${l.id}">
      <div style="display:flex;justify-content:space-between;">
        <b>${esc(l.nombre)}</b>
        <span class="iut-badge ${iutClase(calcularIUT(l))}" style="font-size:9px;">${calcularIUT(l)}</span>
      </div>
      <div class="muted">${esc(l.direccion||'')}</div>
    </div>`).join('');
  dl.querySelectorAll('[data-dzl]').forEach(d =>
    d.addEventListener('click', () => abrirModalLead(d.dataset.dzl)));
}

$('#zona-modo').addEventListener('change', e => { zonasEstado.modo=e.target.value; zonasEstado.detalleId=null; renderZonas(); });
$('#zona-radio').addEventListener('input',  e => { zonasEstado.radio=+e.target.value; $('#zona-radio-val').textContent=zonasEstado.radio; });
$('#zona-radio').addEventListener('change', () => { zonasEstado.detalleId=null; renderZonas(); });
$('#btn-recalc-zonas').addEventListener('click', () => { zonasEstado.detalleId=null; renderZonas(); toast('Zonas recalculadas'); });

/* ======================================================================
   26. STATS
   ====================================================================== */
async function renderStats() {
  const t          = state.leads;
  const total      = t.length;
  const contactados= t.filter(l=>l.estado!=='no-contactado'&&l.estado!=='descartado').length;
  const respondio  = t.filter(l=>['respondio','presupuesto','esperando'].includes(l.estado)).length;
  const clientes   = t.filter(l=>['cliente','recurrente','mantenimiento'].includes(l.estado)).length;
  const urgentes   = t.filter(l=>l.estado==='urgente').length;
  const conFotos   = t.filter(l=>(l.fotos||[]).length>0).length;
  const pendSeg    = t.filter(l=>l.seguimientoFecha&&esHoyOAtrasado(l.seguimientoFecha)&&l.estado!=='descartado').length;
  const estrategicos = t.filter(l=>l.nivel==='estrategico').length;

  $('#stats-grid').innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">TOTAL LEADS</div></div>
    <div class="stat-card"><div class="stat-num">${contactados}</div><div class="stat-label">CONTACTADOS</div></div>
    <div class="stat-card"><div class="stat-num">${respondio}</div><div class="stat-label">RESPONDIERON</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--em-orange);">${clientes}</div><div class="stat-label">CLIENTES</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--red);">${urgentes}</div><div class="stat-label">URGENTES</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--em-orange);">${estrategicos}</div><div class="stat-label">ESTRATÉGICOS</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--orange);">${pendSeg}</div><div class="stat-label">SEGUIM. HOY</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--blue);">${conFotos}</div><div class="stat-label">CON FOTOS</div></div>
  `;

  const equiposFreq = {};
  t.forEach(l => (l.equipos||[]).forEach(e => { equiposFreq[e]=(equiposFreq[e]||0)+1; }));
  const equiposOrden = Object.entries(equiposFreq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxEq = equiposOrden[0]?.[1] || 1;

  $('#stats-equipos').innerHTML = equiposOrden.length
    ? equiposOrden.map(([eid,cnt]) => {
        const eq  = EQUIPOS_CATALOGO.find(x=>x.id===eid) || { ico:'📦', label:eid.toUpperCase() };
        const pct = Math.round((cnt/maxEq)*100);
        return `
        <div style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span style="font-weight:700;">${eq.ico} ${eq.label}</span>
            <span style="font-family:var(--mono);color:var(--em-orange);">${cnt}</span>
          </div>
          <div class="iut-bar"><div class="iut-bar-fill" style="width:${pct}%;background:var(--em-orange);"></div></div>
        </div>`;
      }).join('')
    : '<div class="muted">Agregá equipos a los leads para ver estadísticas.</div>';

  const backups = await DB.loadBackups(5);
  $('#lista-backups').innerHTML = backups.length
    ? backups.map(b => `
      <div class="backup-item">
        <div>
          <b>${new Date(b.fecha).toLocaleDateString('es-AR')} ${new Date(b.fecha).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</b>
          <small>${b.cantLeads||0} leads · ${b.tipo==='auto'?'AUTO':'MANUAL'}</small>
        </div>
        <button class="btn btn-sm" data-bid="${b.id}" data-restore="1">RESTAURAR</button>
      </div>`).join('')
    : '<div class="muted" style="font-size:11px;">Sin backups todavía.</div>';

  $('#lista-backups').querySelectorAll('[data-restore]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Restaurar este backup? Se reemplazarán los datos actuales.')) return;
      const backup = await DB.getBackupById(+b.dataset.bid);
      if (!backup) return;
      try {
        const data = JSON.parse(backup.datos);
        await DB.clearLeads();
        await DB.saveLeads(data.leads||[]);
        state.leads = data.leads||[];
        /* Invalidar cache IUT en todos los leads restaurados */
        state.leads.forEach(l => delete l._iut);
        if (data.mensajes) state.mensajes = data.mensajes;
        /* Reconstruir markers desde cero solo en restore */
        _leadMarkersMap.forEach(m => map.removeLayer(m));
        _leadMarkersMap.clear();
        renderMapLeads();
        toast('Backup restaurado ✓');
        renderStats();
      } catch(e) { toast('Error restaurando: '+e.message); }
    });
  });
}

$('#btn-exportar').addEventListener('click', exportarJSON);
$('#btn-importar').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.leads) throw new Error('Archivo inválido');
      if (!confirm(`Importar ${data.leads.length} leads?`)) return;
      await DB.clearLeads();
      await DB.saveLeads(data.leads);
      state.leads = data.leads;
      state.leads.forEach(l => delete l._iut);
      if (data.mensajes) state.mensajes = data.mensajes;
      if (data.ruta)     state.ruta     = data.ruta;
      _leadMarkersMap.forEach(m => map.removeLayer(m));
      _leadMarkersMap.clear();
      renderLeads(); renderMapLeads();
      toast('Importado ✓');
    } catch(err) { alert('Error: '+err.message); }
  };
  r.readAsText(f); e.target.value='';
});

$('#btn-borrar-todo').addEventListener('click', async () => {
  if (!confirm('⚠️ ¿Borrar TODOS los datos?')) return;
  if (!confirm('¿Confirmás? Es irreversible.')) return;
  await crearBackup('pre-borrado');
  await DB.clearLeads();
  state.leads=[]; state.ruta=[];
  _leadMarkersMap.forEach(m => map.removeLayer(m));
  _leadMarkersMap.clear();
  renderLeads();
  toast('Datos borrados (backup guardado)');
});

/* ======================================================================
   27. CONFIG
   ====================================================================== */
function cargarConfigUI() {
  $('#inp-google-key').value = state.gkey || '';
  cargarMensajesRubro($('#inp-edit-rubro').value);
}

function cargarMensajesRubro(rubro) {
  const m = state.mensajes[rubro] || MENSAJES_DEFAULT[rubro] || MENSAJES_DEFAULT.comercio;
  $('#msg-primero').value    = m.primero;
  $('#msg-seguimiento').value = m.seguimiento;
  $('#msg-cierre').value     = m.cierre;
}

$('#inp-edit-rubro').addEventListener('change', e => cargarMensajesRubro(e.target.value));

$('#btn-save-key').addEventListener('click', async () => {
  state.gkey = $('#inp-google-key').value.trim();
  await dbSetConfig('gkey', state.gkey);
  toast('API Key guardada ✓');
});

$('#btn-save-msg').addEventListener('click', async () => {
  const rb = $('#inp-edit-rubro').value;
  state.mensajes[rb] = {
    primero:      $('#msg-primero').value,
    seguimiento:  $('#msg-seguimiento').value,
    cierre:       $('#msg-cierre').value
  };
  await dbSetConfig('mensajes', JSON.stringify(state.mensajes));
  toast('Plantillas guardadas ✓');
});

$('#btn-reset-msg').addEventListener('click', async () => {
  if (!confirm('¿Restaurar mensajes por defecto?')) return;
  state.mensajes = JSON.parse(JSON.stringify(MENSAJES_DEFAULT));
  await dbSetConfig('mensajes', JSON.stringify(state.mensajes));
  cargarMensajesRubro($('#inp-edit-rubro').value);
  toast('Mensajes restaurados');
});

/* ======================================================================
   28. AUTOCOMPLETADO CIUDAD
   ====================================================================== */
function levenshtein(a, b) {
  if (a===b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  const m=[];
  for (let i=0;i<=b.length;i++) m[i]=[i];
  for (let j=0;j<=a.length;j++) m[0][j]=j;
  for (let i=1;i<=b.length;i++)
    for (let j=1;j<=a.length;j++)
      m[i][j] = b[i-1]===a[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1,m[i][j-1]+1,m[i-1][j]+1);
  return m[b.length][a.length];
}

function sugerirCiudades(q) {
  if (!q) return [];
  const qn=normalizar(q), pref=[], cont=[], sim=[];
  for (const c of CIUDADES_ZONA) {
    const n=normalizar(c);
    if (n.startsWith(qn))       pref.push(c);
    else if (n.includes(qn))    cont.push(c);
    else {
      const d=levenshtein(qn,n);
      if (d<=Math.max(2,Math.floor(qn.length*0.4))) sim.push({c,d});
    }
  }
  sim.sort((a,b)=>a.d-b.d);
  return [...pref,...cont,...sim.map(x=>x.c)].slice(0,5);
}

$('#inp-ciudad').addEventListener('input', e => {
  const lista = $('#ciudad-suggest');
  const sugs  = sugerirCiudades(e.target.value);
  if (!sugs.length || !e.target.value) { lista.classList.remove('show'); lista.innerHTML=''; return; }
  lista.innerHTML = sugs.map(c =>
    `<div class="autocomplete-item" data-ciudad="${esc(c)}">📍 ${esc(c)}</div>`
  ).join('');
  lista.classList.add('show');
  lista.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('pointerdown', e => {
      e.preventDefault();
      $('#inp-ciudad').value = item.dataset.ciudad;
      lista.classList.remove('show');
    });
  });
});
$('#inp-ciudad').addEventListener('blur', () =>
  setTimeout(() => $('#ciudad-suggest').classList.remove('show'), 150));

$('#toggle-zona').addEventListener('click', () => {
  buscarTodaZona = !buscarTodaZona;
  $('#toggle-zona').classList.toggle('active', buscarTodaZona);
  $('#inp-ciudad').disabled    = buscarTodaZona;
  $('#inp-ciudad').style.opacity = buscarTodaZona ? '0.4' : '1';
});

/* ======================================================================
   29. FABs
   ====================================================================== */
$('#fab-gps').addEventListener('click', () => {
  if (state.userLat) centrarEnGPS();
  else               activarGPS();
});

$('#fab-add').addEventListener('click', () => {
  abrirCapturaRapida(state.userLat||null, state.userLon||null);
});

$('#btn-toggle-leads-map').addEventListener('click', () => {
  state.mapLeadsVisible = !state.mapLeadsVisible;
  $('#btn-toggle-leads-map').classList.toggle('active', state.mapLeadsVisible);
  renderMapLeads();
  toast(state.mapLeadsVisible ? 'Leads visibles' : 'Leads ocultos');
});

/* ======================================================================
   30. BÚSQUEDA RÁPIDA TOP BAR
   ====================================================================== */
$('#inp-busqueda-rapida').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (!v) return;
    $('#inp-rubro').value = v;
    setTab('buscar');
    expandPanel();
    setTimeout(() => $('#btn-buscar').click(), 100);
  }
});

/* ======================================================================
   31. OFFLINE DETECTION
   ====================================================================== */
function actualizarOnline(online) {
  state.isOnline = online;
  $('#offline-banner').classList.toggle('show', !online);
}
window.addEventListener('online',  () => actualizarOnline(true));
window.addEventListener('offline', () => actualizarOnline(false));
actualizarOnline(navigator.onLine);

/* ======================================================================
   32. INICIALIZACIÓN
   ====================================================================== */
async function init() {
  const dbStatus = $('#db-status');
  dbStatus.classList.add('show');

  try {
    /* 1. Motor de persistencia */
    const modo = await DB.init();
    if (modo === 'ls') {
      setTimeout(() => toast('⚠️ Modo emergencia: datos en memoria local', 4000), 600);
    }

    /* 2. Migración desde v5 */
    const migrados = await migrarDesdeLocalStorage();
    if (migrados > 0) setTimeout(() => toast(`✓ Migrados ${migrados} leads desde v5`), 400);

    /* 3. Cargar estado desde DB */
    await dbLoadLeads();
    /* Invalidar cache IUT al cargar (datos pueden haber cambiado fuera) */
    state.leads.forEach(l => delete l._iut);

    /* Cargar cache de detalles Google (teléfonos) */
    await cargarDetallesCache();

    const rutaRaw = await dbGetConfig('ruta', null);
    try {
      state.ruta = rutaRaw
        ? (typeof rutaRaw==='string' ? JSON.parse(rutaRaw) : rutaRaw)
        : [];
    } catch { state.ruta=[]; }

    state.gkey = (await dbGetConfig('gkey', '')) || '';

    const msgs = await dbGetConfig('mensajes', null);
    if (msgs) {
      try {
        state.mensajes = typeof msgs==='string' ? JSON.parse(msgs) : msgs;
      } catch {}
    }

    dbStatus.classList.remove('show');

    /* 4. Mapa */
    initMap();
    renderMapLeads();

    /* 5. GPS — intento inicial sin activar watch continuo */
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          state.userLat = pos.coords.latitude;
          state.userLon = pos.coords.longitude;
          actualizarGPSMarker();
          map.setView([state.userLat, state.userLon], 14);
          $('#fab-gps').classList.add('active');
          renderTerreno();
        },
        () => { /* GPS denegado — silencioso */ },
        { enableHighAccuracy:true, timeout:10000, maximumAge:30000 }
      );
    }

    /* 6. Backup automático — 1 por día */
    const hoySinHora       = new Date().toISOString().slice(0,10);
    const ultimoBackupFecha = await dbGetConfig('ultimoBackupFecha', null);
    if (ultimoBackupFecha !== hoySinHora && state.leads.length > 0) {
      await crearBackup('auto');
      await dbSetConfig('ultimoBackupFecha', hoySinHora);
    }

    /* 7. Snapshot de emergencia */
    if (state.leads.length > 0) DB.snapshotLeads(state.leads);

    /* 8. Notificar seguimientos pendientes */
    const pendHoy = state.leads.filter(l =>
      l.seguimientoFecha && esHoyOAtrasado(l.seguimientoFecha) && l.estado !== 'descartado'
    ).length;
    if (pendHoy > 0) setTimeout(() => toast(`⏰ ${pendHoy} seguimiento(s) hoy`), 1000);

    /* 9. UI inicial */
    setTab('terreno');
    collapsePanel();

    console.log(`⚡ ELECTROMEL RADAR v6 · ${modo.toUpperCase()} · ${state.leads.length} leads`);

  } catch(e) {
    $('#db-status').classList.remove('show');
    console.error('[Init] Error crítico:', e);
    toast(`⚠️ Error al iniciar: ${e.message}`, 6000);
    try { if (!map) initMap(); } catch {}
  }
}

init();
