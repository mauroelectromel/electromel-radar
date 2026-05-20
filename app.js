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

/* ======================================================================
   CAMPAÑA WHATSAPP — EXPORTACIÓN MASIVA INTELIGENTE
   ======================================================================
   Genera una lista de contactos con mensajes personalizados.
   El usuario los envía uno por uno desde el modal de campaña.

   FLUJO:
   1. Usuario abre "CAMPAÑA WHATSAPP"
   2. Elige: qué leads incluir (filtro por estado/prioridad)
   3. Elige: tipo de mensaje (primer contacto / seguimiento / cierre)
   4. Ve la lista con preview del mensaje para cada lead
   5. Toca "ENVIAR" en cada uno → abre WhatsApp con el mensaje listo
   6. La app marca automáticamente el lead como "contactado"
   ====================================================================== */

function abrirCampanaWhatsApp() {
  /* Solo leads con teléfono */
  const conTel = state.leads.filter(l =>
    l.telefono && limpiarTel(l.telefono).length >= 6 &&
    l.estado !== 'descartado'
  );

  if (!conTel.length) {
    toast('Sin leads con teléfono cargado');
    return;
  }

  /* Crear overlay modal */
  const overlay = document.createElement('div');
  overlay.id    = 'modal-campana-wa';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:900;' +
    'display:flex;flex-direction:column;overflow:hidden;';

  overlay.innerHTML =
    '<div style="background:var(--bg-card);border-bottom:1px solid var(--border-lit);' +
      'padding:14px;flex-shrink:0;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
        '<div style="font-family:var(--cond);font-size:17px;font-weight:800;color:var(--blue);">' +
          '📱 CAMPAÑA WHATSAPP' +
        '</div>' +
        '<button id="wa-camp-cerrar" class="btn btn-sm" style="padding:5px 10px;min-height:30px;">✕</button>' +
      '</div>' +

      /* Filtros */
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">' +
        '<select id="wa-camp-tipo" style="flex:1;min-width:0;">' +
          '<option value="primero">Primer contacto</option>' +
          '<option value="seguimiento">Seguimiento</option>' +
          '<option value="cierre">Cierre / Propuesta</option>' +
        '</select>' +
        '<select id="wa-camp-filtro" style="flex:1;min-width:0;">' +
          '<option value="todos">Todos con tel.</option>' +
          '<option value="no-contactado">Sin contactar</option>' +
          '<option value="contactado">Contactados</option>' +
          '<option value="seguimiento-hoy">Seguimiento hoy</option>' +
          '<option value="alta">Prioridad alta</option>' +
          '<option value="cliente">Clientes</option>' +
        '</select>' +
      '</div>' +

      /* Stats y botón aplicar */
      '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<div id="wa-camp-stats" style="font-family:var(--mono);font-size:11px;' +
          'color:var(--text-dim);"></div>' +
        '<button id="wa-camp-aplicar" class="btn btn-sm btn-b" ' +
          'style="padding:5px 12px;min-height:30px;font-size:11px;">APLICAR</button>' +
      '</div>' +
    '</div>' +

    /* Lista de contactos */
    '<div id="wa-camp-lista" style="flex:1;overflow-y:auto;padding:10px 12px 24px;' +
      '-webkit-overflow-scrolling:touch;"></div>';

  document.body.appendChild(overlay);

  function getLeadsFiltrados() {
    const filtro = $('#wa-camp-filtro').value;
    const ahora  = Date.now();
    return conTel.filter(l => {
      if (filtro === 'no-contactado')   return l.estado === 'no-contactado';
      if (filtro === 'contactado')      return ['contactado','respondio','visitado'].includes(l.estado);
      if (filtro === 'seguimiento-hoy') return l.seguimientoFecha && new Date(l.seguimientoFecha).getTime() <= ahora;
      if (filtro === 'alta')            return l.prioridad === 'alta' || calcularIUT(l) >= 45;
      if (filtro === 'cliente')         return ['cliente','recurrente','mantenimiento'].includes(l.estado);
      return true; /* todos */
    }).sort((a, b) => calcularIUT(b) - calcularIUT(a));
  }

  function buildMensaje(lead, tipo) {
    const rubro = lead.rubro || 'comercio';
    const tpl   = state.mensajes[rubro]?.[tipo]
               || state.mensajes.comercio?.[tipo]
               || '';
    return tpl.replace(/\{nombre\}/gi, lead.nombre);
  }

  function renderLista() {
    const tipo    = $('#wa-camp-tipo').value;
    const leads   = getLeadsFiltrados();
    const cont    = $('#wa-camp-lista');
    const stats   = $('#wa-camp-stats');

    if (stats) stats.textContent = leads.length + ' contacto(s) seleccionados';

    if (!leads.length) {
      cont.innerHTML = '<div class="empty-state"><span class="ico">📭</span>' +
        'Sin leads con ese filtro.</div>';
      return;
    }

    cont.innerHTML = leads.map((l, i) => {
      const iut = calcularIUT(l);
      const msg = buildMensaje(l, tipo);
      const prio = calcularPrioridadTactica(l);

      return '<div style="background:var(--bg-panel);border:1px solid var(--border);' +
        'border-radius:var(--r);padding:11px 12px;margin-bottom:8px;" data-wid="' + l.id + '">' +

        /* Header: nombre + IUT */
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;' +
          'gap:8px;margin-bottom:4px;">' +
          '<div>' +
            '<div style="font-size:14px;font-weight:800;">' + esc(l.nombre) + '</div>' +
            '<div style="font-size:11px;color:var(--text-dim);">📞 ' + esc(l.telefono) + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">' +
            '<span class="iut-badge ' + iutClase(iut) + '" style="font-size:9px;">' +
              iutLabel(iut) + iut + '</span>' +
            '<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid;' +
              prio.css + '">' + prio.ico + ' ' + prio.label + '</span>' +
          '</div>' +
        '</div>' +

        /* Preview del mensaje (primeras 2 líneas) */
        '<div style="font-size:11px;color:var(--text-dim);font-style:italic;' +
          'background:rgba(45,143,255,0.06);border-left:2px solid var(--blue);' +
          'padding:5px 8px;border-radius:0 5px 5px 0;margin-bottom:8px;' +
          'white-space:pre-wrap;max-height:52px;overflow:hidden;">' +
          esc(msg.split('\n').slice(0,3).join('\n')) +
          (msg.split('\n').length > 3 ? '\n...' : '') +
        '</div>' +

        /* Botones */
        '<div style="display:flex;gap:6px;">' +
          '<button class="btn btn-sm btn-b wa-camp-enviar" data-idx="' + i + '" ' +
            'style="flex:1;">📤 ENVIAR</button>' +
          '<button class="btn btn-sm wa-camp-skip" data-idx="' + i + '" ' +
            'style="padding:7px 10px;min-height:34px;font-size:11px;">SALTAR</button>' +
        '</div>' +
      '</div>';
    }).join('');

    /* Bindear botones */
    cont.querySelectorAll('.wa-camp-enviar').forEach(btn => {
      btn.addEventListener('click', async () => {
        const lead = leads[+btn.dataset.idx];
        if (!lead) return;
        const tipo2 = $('#wa-camp-tipo').value;
        const msg2  = buildMensaje(lead, tipo2);
        const tel   = limpiarTel(lead.telefono);

        /* Abrir WhatsApp */
        window.open('https://wa.me/' + tel + '?text=' + encodeURIComponent(msg2), '_blank');

        /* Actualizar estado del lead */
        const upd = {
          ...lead,
          estado:           lead.estado === 'no-contactado' ? 'contactado' : lead.estado,
          intentosContacto: (lead.intentosContacto || 0) + 1,
          historial:        [...(lead.historial||[]), {
            fecha:  new Date().toISOString(),
            accion: 'WhatsApp ' + tipo2 + ' (campaña)'
          }]
        };
        await dbSaveLead(upd);

        /* Marcar visualmente como enviado */
        const card = cont.querySelector('[data-wid="' + lead.id + '"]');
        if (card) {
          card.style.opacity = '0.45';
          card.style.pointerEvents = 'none';
          const envBtn = card.querySelector('.wa-camp-enviar');
          if (envBtn) { envBtn.textContent = '✓ ENVIADO'; envBtn.classList.remove('btn-b'); }
        }
      });
    });

    cont.querySelectorAll('.wa-camp-skip').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = cont.querySelector('[data-wid="' + leads[+btn.dataset.idx]?.id + '"]');
        if (card) { card.style.display = 'none'; }
      });
    });
  }

  /* Listeners de filtros */
  $('#wa-camp-aplicar').addEventListener('click', renderLista);
  $('#wa-camp-tipo').addEventListener('change', renderLista);
  $('#wa-camp-cerrar').addEventListener('click', () => {
    if (overlay.parentNode) document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', e => {
    if (e.target === overlay && overlay.parentNode) document.body.removeChild(overlay);
  });

  /* Render inicial */
  renderLista();
}

/* Listener del botón */
$('#btn-exportar-wa').addEventListener('click', abrirCampanaWhatsApp);

/* ======================================================================
   SISTEMA DE EXPORTACIÓN AVANZADA
   ======================================================================
   Formatos:
   - JSON completo (backup/sync entre dispositivos)
   - CSV de leads (para Excel / Google Sheets)
   - TXT de contactos (nombres + teléfonos para copiar)
   - Filtros: todos / solo clientes / solo con teléfono / por estado

   Importación inteligente:
   - Merge: agrega leads nuevos sin borrar los existentes
   - Reemplazar: sobreescribe todo (comportamiento anterior)
   - Detecta duplicados por id y googleId
   ====================================================================== */

function descargarArchivo(contenido, nombre, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

function exportarJSON() {
  const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'_');
  const data  = {
    version:  6,
    fecha:    new Date().toISOString(),
    leads:    state.leads,
    ruta:     state.ruta,
    mensajes: state.mensajes
  };
  descargarArchivo(JSON.stringify(data, null, 2), 'electromel_radar_' + fecha + '.json', 'application/json');
  toast('✓ JSON exportado — ' + state.leads.length + ' leads');
}

function exportarCSV(leads) {
  const cols = ['nombre','telefono','direccion','zona','rubro','estado','nivel','notas','fuente','lat','lon','creado'];
  const esc2 = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };
  const header = cols.join(',');
  const rows   = leads.map(l =>
    cols.map(c => {
      if (c === 'creado') return esc2(l.creado ? new Date(l.creado).toLocaleDateString('es-AR') : '');
      return esc2(l[c]);
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

function exportarTXT(leads) {
  return leads
    .filter(l => l.telefono && limpiarTel(l.telefono).length >= 6)
    .map(l => l.nombre + '\t' + l.telefono + (l.direccion ? '\t' + l.direccion : ''))
    .join('\n');
}

function abrirExportadorAvanzado() {
  if (document.getElementById('modal-exportar')) return;

  const overlay = document.createElement('div');
  overlay.id    = 'modal-exportar';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:900;' +
    'display:flex;align-items:flex-end;justify-content:center;';

  /* Estado del exportador */
  let filtroActivo = 'todos';
  let formatoActivo = 'json';

  const FILTROS = [
    { id:'todos',       label:'Todos',             fn: l => l.estado !== 'descartado' },
    { id:'con-tel',     label:'Con teléfono',       fn: l => l.telefono && limpiarTel(l.telefono).length >= 6 },
    { id:'clientes',    label:'Clientes',           fn: l => ['cliente','recurrente','mantenimiento'].includes(l.estado) },
    { id:'no-contact',  label:'Sin contactar',      fn: l => l.estado === 'no-contactado' },
    { id:'alta',        label:'Prioridad alta',     fn: l => calcularIUT(l) >= 45 },
    { id:'con-coords',  label:'Con coordenadas',    fn: l => l.lat && l.lon }
  ];

  const FORMATOS = [
    { id:'json', label:'JSON', desc:'Backup completo, importable en otro dispositivo' },
    { id:'csv',  label:'CSV',  desc:'Excel / Google Sheets — una fila por lead' },
    { id:'txt',  label:'TXT',  desc:'Lista de contactos: nombre + teléfono' }
  ];

  function getLeadsFiltrados() {
    const f = FILTROS.find(x => x.id === filtroActivo);
    return f ? state.leads.filter(f.fn) : state.leads;
  }

  function buildHTML() {
    const leads = getLeadsFiltrados();
    return '<div style="background:var(--bg-card);border-top:2px solid var(--accent);' +
      'border-radius:20px 20px 0 0;width:100%;max-width:600px;' +
      'padding:16px 14px 32px;max-height:88vh;overflow-y:auto;">' +

      /* Header */
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
        '<div style="font-family:var(--cond);font-size:17px;font-weight:800;color:var(--accent);">⬇ EXPORTAR DATOS</div>' +
        '<button id="exp-cerrar" class="btn btn-sm" style="padding:5px 10px;min-height:30px;">✕</button>' +
      '</div>' +

      /* Filtro qué exportar */
      '<div style="font-size:10px;font-weight:700;font-family:var(--mono);color:var(--text-dim);' +
        'letter-spacing:1px;margin-bottom:6px;">¿QUÉ EXPORTAR?</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;">' +
        FILTROS.map(f =>
          '<button class="filtro-btn exp-filtro' + (f.id===filtroActivo?' active':'') + '" data-fid="' + f.id + '">' +
          f.label + '</button>'
        ).join('') +
      '</div>' +

      /* Formato */
      '<div style="font-size:10px;font-weight:700;font-family:var(--mono);color:var(--text-dim);' +
        'letter-spacing:1px;margin-bottom:6px;">FORMATO</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px;">' +
        FORMATOS.map(f =>
          '<button class="exp-fmt' + (f.id===formatoActivo?' btn btn-g btn-sm':' btn btn-sm') + '" ' +
          'data-fmt="' + f.id + '" style="flex-direction:column;height:auto;padding:8px 6px;text-align:center;">' +
            '<span style="font-size:14px;display:block;margin-bottom:2px;">' +
              (f.id==='json'?'📦':f.id==='csv'?'📊':'📋') + '</span>' +
            '<span style="font-size:12px;font-weight:800;">' + f.label + '</span>' +
            '<span style="font-size:9px;color:' + (f.id===formatoActivo?'rgba(0,26,14,0.7)':'var(--text-dim)') + ';' +
              'display:block;line-height:1.2;margin-top:2px;">' + f.desc + '</span>' +
          '</button>'
        ).join('') +
      '</div>' +

      /* Preview */
      '<div style="background:var(--bg-panel);border:1px solid var(--border-lit);border-radius:var(--r);' +
        'padding:10px;margin-bottom:12px;">' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-bottom:5px;">' +
          'RESUMEN' +
        '</div>' +
        '<div id="exp-preview" style="font-size:13px;"></div>' +
      '</div>' +

      /* Botón exportar */
      '<button class="btn btn-g btn-block" id="exp-descargar" style="font-size:15px;">' +
        '⬇ DESCARGAR' +
      '</button>' +

      /* Separador importación */
      '<hr style="margin:14px 0;">' +
      '<div style="font-size:13px;font-weight:800;font-family:var(--cond);margin-bottom:8px;">IMPORTAR DATOS</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
        '<button class="btn btn-sm" id="exp-merge" style="flex-direction:column;height:auto;padding:9px 6px;text-align:center;">' +
          '<span style="font-size:13px;display:block;">🔀</span>' +
          '<span style="font-size:12px;font-weight:800;">MERGE</span>' +
          '<span style="font-size:9px;color:var(--text-dim);display:block;">Agrega sin borrar</span>' +
        '</button>' +
        '<button class="btn btn-sm btn-r" id="exp-reemplazar" style="flex-direction:column;height:auto;padding:9px 6px;text-align:center;">' +
          '<span style="font-size:13px;display:block;">♻️</span>' +
          '<span style="font-size:12px;font-weight:800;">REEMPLAZAR</span>' +
          '<span style="font-size:9px;color:var(--text-dim);display:block;">Sobreescribe todo</span>' +
        '</button>' +
      '</div>' +
      '<input type="file" id="exp-file-input" accept=".json" style="display:none;">' +
    '</div>';
  }

  function actualizarPreview() {
    const leads    = getLeadsFiltrados();
    const conTel   = leads.filter(l => l.telefono && limpiarTel(l.telefono).length >= 6).length;
    const clientes = leads.filter(l => ['cliente','recurrente','mantenimiento'].includes(l.estado)).length;
    const prev     = document.getElementById('exp-preview');
    if (!prev) return;
    prev.innerHTML =
      '<b style="color:var(--accent);font-family:var(--mono);">' + leads.length + '</b> leads · ' +
      '<span style="color:var(--text-dim);">' + conTel + ' con teléfono · ' + clientes + ' clientes</span>';
  }

  function bindListeners() {
    document.getElementById('exp-cerrar').addEventListener('click', () => {
      if (overlay.parentNode) document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay && overlay.parentNode) document.body.removeChild(overlay);
    });

    /* Filtros */
    overlay.querySelectorAll('.exp-filtro').forEach(b => {
      b.addEventListener('click', () => {
        filtroActivo = b.dataset.fid;
        overlay.querySelector('.modal-inner').innerHTML = buildHTML();
        bindListeners();
      });
    });

    /* Formatos */
    overlay.querySelectorAll('.exp-fmt').forEach(b => {
      b.addEventListener('click', () => {
        formatoActivo = b.dataset.fmt;
        overlay.querySelector('.modal-inner').innerHTML = buildHTML();
        bindListeners();
      });
    });

    actualizarPreview();

    /* Descargar */
    document.getElementById('exp-descargar').addEventListener('click', () => {
      const leads = getLeadsFiltrados();
      const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'_');
      if (formatoActivo === 'json') {
        const data = { version:6, fecha:new Date().toISOString(), leads, ruta:state.ruta, mensajes:state.mensajes };
        descargarArchivo(JSON.stringify(data, null, 2), 'electromel_' + fecha + '.json', 'application/json');
        toast('✓ JSON — ' + leads.length + ' leads');
      } else if (formatoActivo === 'csv') {
        descargarArchivo(exportarCSV(leads), 'electromel_' + fecha + '.csv', 'text/csv;charset=utf-8');
        toast('✓ CSV — ' + leads.length + ' filas');
      } else {
        const txt = exportarTXT(leads);
        descargarArchivo(txt, 'electromel_contactos_' + fecha + '.txt', 'text/plain;charset=utf-8');
        const n = txt.split('\n').filter(Boolean).length;
        toast('✓ TXT — ' + n + ' contactos con teléfono');
      }
    });

    /* Merge */
    document.getElementById('exp-merge').addEventListener('click', () => {
      const inp = document.getElementById('exp-file-input');
      inp.dataset.modo = 'merge';
      inp.click();
    });

    /* Reemplazar */
    document.getElementById('exp-reemplazar').addEventListener('click', () => {
      if (!confirm('¿Reemplazar TODOS los leads? Los actuales se perderán.')) return;
      const inp = document.getElementById('exp-file-input');
      inp.dataset.modo = 'reemplazar';
      inp.click();
    });

    /* File input */
    document.getElementById('exp-file-input').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const modo = e.target.dataset.modo;
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.leads) throw new Error('Archivo sin leads');

          if (modo === 'merge') {
            /* Merge: agrega solo los que no existen */
            const idsExistentes = new Set([
              ...state.leads.map(l => l.id),
              ...state.leads.map(l => l.googleId).filter(Boolean),
              ...state.leads.map(l => l.osmId).filter(Boolean)
            ]);
            const nuevos = data.leads.filter(l => {
              if (idsExistentes.has(l.id)) return false;
              if (l.googleId && idsExistentes.has(l.googleId)) return false;
              if (l.osmId    && idsExistentes.has(l.osmId))    return false;
              return true;
            });
            if (!nuevos.length) { toast('Sin leads nuevos para agregar'); return; }
            for (const l of nuevos) { delete l._iut; await DB.saveLead(l); }
            state.leads = [...state.leads, ...nuevos];
            state.leads.forEach(l => delete l._iut);
            renderLeads(); renderMapLeads();
            toast('✓ Merge: +' + nuevos.length + ' leads nuevos');
          } else {
            /* Reemplazar */
            await DB.clearLeads();
            await DB.saveLeads(data.leads);
            state.leads = data.leads;
            state.leads.forEach(l => delete l._iut);
            if (data.mensajes) state.mensajes = data.mensajes;
            if (data.ruta)     state.ruta     = data.ruta;
            _leadMarkersMap.forEach(m => map.removeLayer(m));
            _leadMarkersMap.clear();
            renderLeads(); renderMapLeads();
            toast('✓ Importados ' + data.leads.length + ' leads');
          }
          if (overlay.parentNode) document.body.removeChild(overlay);
        } catch(err) {
          toast('Error: ' + err.message);
        }
      };
      reader.readAsText(f);
      e.target.value = '';
    });
  }

  overlay.innerHTML = '<div class="modal-inner" style="width:100%;max-width:600px;">' + buildHTML() + '</div>';
  document.body.appendChild(overlay);
  bindListeners();
}

$('#btn-exportar-avanzado').addEventListener('click', abrirExportadorAvanzado);

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

/* ── Score táctico de prioridad diaria ─────────────────────────────── */
function calcularPrioridadTactica(l) {
  const ahora = Date.now();

  /* CONTACTAR HOY */
  if (l.estado === 'urgente') return { nivel:'hoy', ico:'🔴', label:'CONTACTAR HOY', css:'color:#ff3355;background:rgba(255,51,85,0.12);border-color:rgba(255,51,85,0.4);' };
  if (l.seguimientoFecha && new Date(l.seguimientoFecha).getTime() <= ahora) return { nivel:'hoy', ico:'⏰', label:'CONTACTAR HOY', css:'color:#ff6b1a;background:rgba(255,107,26,0.12);border-color:rgba(255,107,26,0.4);' };
  if (calcularIUT(l) >= 70) return { nivel:'hoy', ico:'⚡', label:'CONTACTAR HOY', css:'color:#ff3355;background:rgba(255,51,85,0.12);border-color:rgba(255,51,85,0.4);' };

  /* ESTA SEMANA */
  if (l.estado === 'presupuesto' || l.estado === 'esperando') return { nivel:'semana', ico:'💰', label:'ESTA SEMANA', css:'color:#f5c400;background:rgba(245,196,0,0.1);border-color:rgba(245,196,0,0.35);' };
  if (l.seguimientoFecha) {
    const diasHasta = (new Date(l.seguimientoFecha).getTime() - ahora) / 86400000;
    if (diasHasta <= 7) return { nivel:'semana', ico:'📅', label:'ESTA SEMANA', css:'color:#f5c400;background:rgba(245,196,0,0.1);border-color:rgba(245,196,0,0.35);' };
  }
  if (calcularIUT(l) >= 45) return { nivel:'semana', ico:'🎯', label:'ESTA SEMANA', css:'color:#f5c400;background:rgba(245,196,0,0.1);border-color:rgba(245,196,0,0.35);' };
  if (['cliente','recurrente','mantenimiento'].includes(l.estado)) return { nivel:'semana', ico:'⭐', label:'REVISITA', css:'color:#00e8a0;background:rgba(0,232,160,0.1);border-color:rgba(0,232,160,0.35);' };

  /* SIN URGENCIA */
  return { nivel:'baja', ico:'🔵', label:'SIN URGENCIA', css:'color:#4a6888;background:rgba(74,104,136,0.08);border-color:rgba(74,104,136,0.25);' };
}

function renderTerrenoCard(l) {
  const tel    = !!(l.telefono && limpiarTel(l.telefono).length >= 6);
  const src    = l.fuente || 'manual';
  const srcLbl = src==='google'?'GOOGLE':src==='manual'?'MANUAL':src==='osm'?'OSM':'TERRENO';
  const iut    = l._iut || calcularIUT(l);
  const iutCls = iutClase(iut);
  const prio   = calcularPrioridadTactica(l);

  const equiposHtml = (l.equipos||[]).length
    ? '<div class="equipos-chips">' + l.equipos.map(e => {
        const eq = EQUIPOS_CATALOGO.find(x=>x.id===e);
        return eq ? '<span class="equipo-chip">' + eq.ico + ' ' + eq.label + '</span>' : '';
      }).join('') + '</div>'
    : '';

  const notaDisplay = l.notas
    ? '<div class="tc-nota">📝 ' + esc(l.notas.slice(0,60)) + (l.notas.length>60?'…':'') + '</div>'
    : '';

  const urgente = l.estado==='urgente' || iut >= 70;

  /* Indicador de prioridad táctica — barra superior de la card */
  const prioBar = '<div style="display:flex;align-items:center;justify-content:space-between;' +
    'margin-bottom:7px;padding:5px 8px;border-radius:6px;border:1px solid;' + prio.css + '">' +
    '<span style="font-size:11px;font-weight:800;font-family:var(--mono);letter-spacing:0.5px;">' +
      prio.ico + ' ' + prio.label +
    '</span>' +
    /* Días desde último contacto */
    (function() {
      if (!l.historial?.length) return '<span style="font-size:10px;opacity:0.7;">Sin contacto previo</span>';
      const diasSin = Math.round((Date.now() - new Date(l.historial[l.historial.length-1].fecha).getTime()) / 86400000);
      if (diasSin === 0) return '<span style="font-size:10px;opacity:0.7;">Contactado hoy</span>';
      if (diasSin === 1) return '<span style="font-size:10px;opacity:0.7;">Ayer</span>';
      return '<span style="font-size:10px;opacity:0.7;">Hace ' + diasSin + ' días</span>';
    })() +
  '</div>';

  return '<div class="terreno-card src-' + src + (urgente?' urgente':'') + '" data-tid="' + l.id + '">' +
    prioBar +
    '<div class="tc-top">' +
      '<div class="tc-name">' + esc(l.nombre) + '</div>' +
      '<div class="tc-iut"><span class="iut-badge ' + iutCls + '">' + iutLabel(iut) + ' IUT·' + iut + '</span></div>' +
    '</div>' +
    '<div class="tc-meta">' +
      '<span class="tc-dist">◈ ' + fmtDist(l._dist) + '</span>' +
      '<span class="src-badge ' + src + '">' + srcLbl + '</span>' +
      nivelBadge(l.nivel||'bajo') +
    '</div>' +
    equiposHtml +
    notaDisplay +
    '<div class="tc-actions-primary">' +
      '<button class="tc-btn primary-ir" data-ta="ir">NAVEGAR</button>' +
      (tel ? '<button class="tc-btn primary-wa" data-ta="wa">WHATSAPP</button>'
           : '<button class="tc-btn" data-ta="abrir">VER FICHA</button>') +
    '</div>' +
    '<div class="tc-actions-secondary">' +
      (tel ? '<button class="tc-btn btn-sm-ico" data-ta="llamar" title="Llamar">📞</button>' : '') +
      '<button class="tc-btn btn-sm-ico" data-ta="visitado" title="Marcar visitado">✅</button>' +
      '<button class="tc-btn btn-sm-ico" data-ta="nota"     title="Nota rápida">📝</button>' +
      '<button class="tc-btn btn-sm-ico" data-ta="ruta"     title="+ Ruta">🗺️</button>' +
      '<button class="tc-btn btn-sm-ico btn-urgente" data-ta="urgente" title="Marcar urgente">🚨</button>' +
      '<button class="tc-btn btn-sm-ico" data-ta="abrir"    title="Editar">✏️</button>' +
    '</div>' +
  '</div>';
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

/* ======================================================================
   SISTEMA DE PROSPECCIÓN INTELIGENTE — ZONAS SEMÁNTICAS + GRID
   ======================================================================

   ESTRATEGIA:
   Google Places devuelve resultados diferentes según la query exacta.
   "Gym Neuquén" ≠ "Gym Neuquén centro" ≠ "Gym Neuquén parque industrial"
   Combinando ciudad + zonas semánticas multiplicamos los resultados
   sin depender de paginación limitada.

   FLUJO:
   1. generarConsultas(ciudad, rubro) → lista de queries únicas
   2. Cada query → buscarGoogle() con paginación real (hasta 60/query)
   3. Deduplicar por googleId/place_id
   4. Renderizar progresivamente
   5. Enriquecer teléfonos en background
   ====================================================================== */

/* ── Zonas semánticas por defecto ─────────────────────────────────── */
/*
 * ZONAS POR TIPO DE RUBRO
 *
 * Zonas genéricas: funcionan para cualquier negocio.
 * Zonas industriales: solo para rubros técnicos/industriales.
 * La función generarConsultas() detecta el tipo y elige las correctas.
 */
const ZONAS_GENERICAS = [
  '',           /* búsqueda base — siempre primera */
  'centro',
  'zona norte',
  'zona sur',
  'zona este',
  'zona oeste',
  'zona comercial',
  'barrio centro',
  'avenida principal'
];

const ZONAS_INDUSTRIALES = [
  '',           /* búsqueda base */
  'parque industrial',
  'zona industrial',
  'zona talleres',
  'zona oeste',
  'zona norte',
  'ruta 22',
  'corredor productivo',
  'barrio industrial',
  'área logística',
  'polo industrial',
  'zona sur'
];

/* Keywords que indican rubro industrial/técnico */
const KEYWORDS_INDUSTRIALES = [
  'metalurg', 'taller', 'soldad', 'tornería', 'torneria',
  'herrería', 'herreria', 'industrial', 'industria', 'fabrica',
  'fábrica', 'motor', 'variador', 'tablero', 'eléctric', 'electric',
  'mecánic', 'mecanica', 'corralon', 'corralón', 'logística',
  'logistica', 'depósito', 'deposito', 'galpón', 'galpon',
  'construcc', 'pintura industrial', 'plástic', 'plastic',
  'caucho', 'hidráulic', 'hidraulic', 'neumátic', 'neumatic',
  'generador', 'compresor', 'bomba', 'refriger', 'frigorif'
];

function esRubroIndustrial(rubro) {
  const r = normalizar(rubro);
  return KEYWORDS_INDUSTRIALES.some(k => r.includes(normalizar(k)));
}

const ZONAS_DEFAULT = ZONAS_INDUSTRIALES; /* compatibilidad */

/* Zonas extra configurables por el usuario (se persisten en IDB) */
let _zonasExtra = [];

async function cargarZonasExtra() {
  try {
    const raw = await dbGetConfig('zonas_extra', null);
    _zonasExtra = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch { _zonasExtra = []; }
}

async function guardarZonasExtra(zonas) {
  _zonasExtra = zonas;
  await dbSetConfig('zonas_extra', JSON.stringify(zonas));
}

function getZonas() {
  return [...ZONAS_DEFAULT, ..._zonasExtra];
}

/* ── Generador de consultas ────────────────────────────────────────── */
/*
 * Genera todas las combinaciones ciudad × zonas.
 * Limita a MAX_CONSULTAS para no agotar la cuota de API.
 * Prioriza las zonas con mayor probabilidad de resultados industriales.
 */
function generarConsultas(ciudad, rubro, zonas) {
  const MAX_CONSULTAS = 12;

  /* Elegir zonas según el tipo de rubro — no mezclar industriales con comerciales */
  let zonasBase;
  if (zonas) {
    zonasBase = zonas; /* zonas manuales del usuario */
  } else if (_zonasExtra.length > 0) {
    zonasBase = ['', ..._zonasExtra]; /* zonas configuradas en CONFIG */
  } else if (esRubroIndustrial(rubro)) {
    zonasBase = ZONAS_INDUSTRIALES;   /* metalúrgica, taller, soldadora... */
  } else {
    zonasBase = ZONAS_GENERICAS;      /* panadería, gym, hotel... */
  }

  const queries = [];
  for (const zona of zonasBase) {
    const q = zona
      ? rubro + ' ' + ciudad + ' ' + zona
      : rubro + ' ' + ciudad + ' Argentina';
    queries.push(q.trim());
    if (queries.length >= MAX_CONSULTAS) break;
  }

  return queries;
}

/* ── Deduplicación inteligente ─────────────────────────────────────── */
function deduplicarResultados(lista) {
  const porGoogleId = new Map();
  const porNombre   = new Map();

  for (const r of lista) {
    /* Prioridad 1: deduplicar por googleId (más confiable) */
    if (r.googleId) {
      if (!porGoogleId.has(r.googleId)) {
        porGoogleId.set(r.googleId, r);
      } else {
        /* Fusionar: conservar el que tenga más datos */
        const existing = porGoogleId.get(r.googleId);
        if (!existing.telefono && r.telefono) existing.telefono = r.telefono;
        if (!existing.web && r.web)           existing.web      = r.web;
        if (!existing.direccion && r.direccion) existing.direccion = r.direccion;
      }
      continue;
    }

    /* Prioridad 2: deduplicar por nombre+ciudad normalizado */
    const key = normalizar(r.nombre) + '|' + normalizar(r.direccion || '').slice(0, 25);
    if (!porNombre.has(key)) {
      porNombre.set(key, r);
    }
  }

  /* Combinar ambos mapas, sin duplicar entre sí */
  const resultado = [...porGoogleId.values()];
  const idsEnGoogleMap = new Set(resultado.map(r => r.googleId).filter(Boolean));

  for (const r of porNombre.values()) {
    if (!r.googleId || !idsEnGoogleMap.has(r.googleId)) {
      resultado.push(r);
    }
  }

  return resultado;
}

/* ── Motor de búsqueda multi-zona ──────────────────────────────────── */
async function buscarMultiZona(ciudad, rubro, fuente, onProgreso) {
  const queries = generarConsultas(ciudad, rubro);
  const total   = queries.length;
  let acumulados = [];
  let errores    = 0;

  /* Geocodificar la ciudad UNA SOLA VEZ para todas las queries */
  let geo = null;
  if (fuente === 'google' && state.gkey) {
    try {
      geo = await geocodificarCiudadGoogle(ciudad);
      if (geo) {
        console.log('[GEO] Ciudad:', ciudad, '| País:', geo.pais,
          '| Provincia:', geo.provincia, '| Radio máx:', geo.radioMaxKm.toFixed(1) + 'km');
      }
    } catch(e) {
      console.warn('[GEO] No se pudo geocodificar:', e.message);
    }
  }

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    onProgreso({
      fase:        'buscando',
      consulta:    i + 1,
      total,
      query:       q,
      encontrados: acumulados.length
    });

    try {
      let res;
      if (fuente === 'google') {
        /* Pasar geo para filtrado geográfico en cada query */
        res = await buscarGoogleQuery(q, geo);
      } else {
        /* OSM: grid search cubre toda la ciudad, no necesita multi-zona */
        res = await buscarOSM(ciudad, rubro);
        acumulados = acumulados.concat(res);
        break;
      }
      acumulados = acumulados.concat(res);
    } catch(e) {
      errores++;
      console.warn('[MultiZona] Error en query:', q, e.message);
      if (errores > Math.floor(total / 2)) break;
    }

    if (i < queries.length - 1) {
      await new Promise(res => setTimeout(res, 800));
    }
  }

  return deduplicarResultados(acumulados);
}

/* ======================================================================
   VALIDACIÓN GEOGRÁFICA DE RESULTADOS
   ======================================================================

   PROBLEMA: Google Places devuelve resultados de cualquier parte del mundo
   cuando el query coincide semánticamente. "hotel San Martín de los Andes"
   puede devolver hoteles en España o México.

   SOLUCIÓN:
   1. Geocodificar la ciudad objetivo → obtener lat/lon + bbox + país
   2. Cada resultado pasa por validarResultadoGeo():
      - ¿Tiene coordenadas? → calcular distancia al centro
      - ¿Tiene formatted_address? → verificar que mencione Argentina
      - ¿Está dentro del radio máximo? → descartar si no
   3. Score geográfico para ordenar: exactos primero
   ====================================================================== */

/* Cache de geocodificación para no repetir por ciudad */
const _geoCache = new Map();

async function geocodificarCiudadGoogle(ciudad) {
  const key = normalizar(ciudad);
  if (_geoCache.has(key)) return _geoCache.get(key);

  await cargarGoogleMapsAPI(state.gkey);
  const geocoder = new google.maps.Geocoder();

  const result = await new Promise((resolve) => {
    geocoder.geocode(
      { address: ciudad + ', Argentina' },
      (results, status) => {
        if (status === 'OK' && results.length) resolve(results[0]);
        else resolve(null);
      }
    );
  });

  if (!result) return null;

  const loc      = result.geometry.location;
  const viewport = result.geometry.viewport;

  /* Extraer provincia y país de los address_components */
  const comps     = result.address_components || [];
  const provincia = comps.find(c => c.types.includes('administrative_area_level_1'))?.long_name || '';
  const pais      = comps.find(c => c.types.includes('country'))?.short_name || '';

  const geo = {
    lat:      loc.lat(),
    lon:      loc.lng(),
    pais,
    provincia,
    /* Bounding box del viewport de Google: más preciso que Nominatim */
    bbSW: { lat: viewport.getSouthWest().lat(), lon: viewport.getSouthWest().lng() },
    bbNE: { lat: viewport.getNorthEast().lat(), lon: viewport.getNorthEast().lng() },
    /* Radio máximo: diagonal del bbox / 2 + 20% de margen */
    radioMaxKm: distKm(
      viewport.getSouthWest().lat(), viewport.getSouthWest().lng(),
      viewport.getNorthEast().lat(), viewport.getNorthEast().lng()
    ) / 2 * 1.2
  };

  /* Asegurar radio mínimo de 8km y máximo de 60km */
  geo.radioMaxKm = Math.max(8, Math.min(60, geo.radioMaxKm));

  _geoCache.set(key, geo);
  console.log('[Geo]', ciudad, '→', pais, provincia, '| radio:', geo.radioMaxKm.toFixed(1) + 'km');
  return geo;
}

function estaDentroDelBoundingBox(lat, lon, geo) {
  if (!lat || !lon) return null; /* sin coordenadas — no podemos validar */
  return lat  >= geo.bbSW.lat && lat  <= geo.bbNE.lat &&
         lon  >= geo.bbSW.lon && lon  <= geo.bbNE.lon;
}

/*
 * Valida un resultado de Google Places contra la geo de la ciudad objetivo.
 * Devuelve: { valido: bool, score: number, razon: string }
 */
function validarResultadoGeo(resultado, geo) {
  const { lat, lon, direccion } = resultado;
  const addr = normalizar(direccion || '');

  /* ── Validación por país en formatted_address ─────────────────────
   * Google siempre incluye el país en formatted_address.
   * "Argentina" debe aparecer para resultados locales. */
  const tieneArgentina = addr.includes('argentina');
  const tieneEspana    = addr.includes('espana') || addr.includes('españa');
  const tieneMexico    = addr.includes('mexico') || addr.includes('méxico');

  if (tieneEspana || tieneMexico) {
    return { valido: false, score: -1000, razon: 'País incorrecto: ' + direccion.split(',').pop().trim() };
  }

  /* Si no tiene Argentina pero sí otro país conocido → descartar */
  const PAISES_ERRONEOS = ['spain', 'españa', 'mexico', 'colombia', 'chile',
    'peru', 'perú', 'brasil', 'brazil', 'uruguay', 'paraguay', 'bolivia',
    'venezuela', 'ecuador', 'united states', 'estados unidos'];
  for (const p of PAISES_ERRONEOS) {
    if (addr.includes(normalizar(p))) {
      return { valido: false, score: -1000, razon: 'País incorrecto: ' + p };
    }
  }

  /* ── Validación por distancia (si tiene coordenadas) ──────────────── */
  if (lat && lon) {
    const dist = distKm(geo.lat, geo.lon, lat, lon);

    if (dist > geo.radioMaxKm) {
      return {
        valido: false,
        score: -500,
        razon: 'Distancia excesiva: ' + dist.toFixed(1) + 'km (máx ' + geo.radioMaxKm.toFixed(1) + 'km)'
      };
    }

    /* ── Bounding box ─────────────────────────────────────────────── */
    const enBbox = estaDentroDelBoundingBox(lat, lon, geo);
    if (enBbox === false) {
      return {
        valido: false,
        score: -200,
        razon: 'Fuera del bounding box'
      };
    }

    /* Score por distancia: más cerca = más score */
    const scoreDistancia = Math.max(0, 100 - Math.round(dist * 10));

    /* Score por provincia en dirección */
    const scoreProvincia = addr.includes(normalizar(geo.provincia)) ? 50 : 0;

    /* Score por Argentina */
    const scorePais = tieneArgentina ? 20 : 0;

    return {
      valido: true,
      score:  scoreDistancia + scoreProvincia + scorePais,
      razon:  'OK · dist:' + dist.toFixed(1) + 'km'
    };
  }

  /* Sin coordenadas — validar solo por dirección */
  if (!tieneArgentina && addr.length > 10) {
    /* Dirección existe pero no menciona Argentina → sospechoso */
    return { valido: false, score: -100, razon: 'Sin Argentina en dirección: ' + direccion.slice(0, 40) };
  }

  /* Sin coordenadas y sin dirección clara — aceptar con score bajo */
  return {
    valido: true,
    score:  tieneArgentina ? 20 : 5,
    razon:  'Sin coords — aceptado por dirección'
  };
}

/*
 * Filtra y ordena una lista de resultados por validez geográfica.
 * Descarta los inválidos, ordena los válidos por score geo + IUT.
 */
function filtrarPorGeo(resultados, geo, debugPrefix) {
  const validos    = [];
  let descartados  = 0;

  for (const r of resultados) {
    const check = validarResultadoGeo(r, geo);
    if (check.valido) {
      r._geoScore = check.score;
      validos.push(r);
      console.log('[GEO OK]', (debugPrefix || ''), r.nombre, '|', check.razon);
    } else {
      descartados++;
      console.log('[GEO DESC]', (debugPrefix || ''), r.nombre, '|', check.razon);
    }
  }

  if (descartados > 0) {
    console.log('[GEO]', descartados, 'resultados descartados de', resultados.length);
  }

  /* Ordenar: score geográfico + IUT */
  validos.sort((a, b) => (b._geoScore || 0) - (a._geoScore || 0));
  return validos;
}

/* ── buscarGoogleQuery: acepta query completo (con zona incluida) ──── */
async function buscarGoogleQuery(queryCompleto, geo) {
  if (!state.gkey) throw new Error('Sin API Key');
  await cargarGoogleMapsAPI(state.gkey);

  const MAX_PAG      = 3;
  const DELAY_PAG_MS = 2500;

  const searchDiv    = document.createElement('div');
  searchDiv.id       = '_radar_sq_' + Date.now();
  searchDiv.style.display = 'none';
  document.body.appendChild(searchDiv);
  const service = new google.maps.places.PlacesService(searchDiv);

  const todosLosResultados = await new Promise((resolve) => {
    let acumulados = [];
    let pagina     = 1;
    let tid        = null;

    function terminar() {
      clearTimeout(tid);
      const d = document.getElementById(searchDiv.id);
      if (d) document.body.removeChild(d);
      resolve(acumulados);
    }

    tid = setTimeout(() => terminar(), 40000);

    function procesarPagina(results, status, pagination) {
      const S = google.maps.places.PlacesServiceStatus;
      if (status === S.OK || status === S.ZERO_RESULTS) {
        acumulados = acumulados.concat(results || []);
      }
      const hayMas = pagination?.hasNextPage === true && pagina < MAX_PAG;
      if (!hayMas) { terminar(); return; }
      pagina++;
      setTimeout(function() {
        try { pagination.nextPage(procesarPagina); }
        catch(e) { terminar(); }
      }, DELAY_PAG_MS);
    }

    service.textSearch({ query: queryCompleto }, procesarPagina);
  });

  /* Mapear resultados crudos */
  const mapeados = todosLosResultados.map(r => ({
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
    rating:    r.rating || 0
  }));

  /* Filtrar geográficamente si tenemos la geo de la ciudad */
  if (geo) {
    return filtrarPorGeo(mapeados, geo, queryCompleto);
  }

  return mapeados;
}

/* ======================================================================
   SISTEMA MULTI-RUBRO
   ======================================================================
   El usuario puede buscar varios rubros a la vez.
   Cada rubro genera su propio set de queries multi-zona.
   Los resultados se acumulan y deduplicán en un solo pool.

   Formas de agregar rubros:
   1. Escribir en el campo y presionar Enter o coma
   2. Tocar un chip de "rubros frecuentes"
   3. Escribir múltiples separados por coma: "taller, metalurgica, soldadora"
   ====================================================================== */

let _rubrosActivos = []; /* array de strings */

function actualizarChipsRubros() {
  const chips = $('#rubros-chips');
  const input = $('#inp-rubro');
  if (!chips) return;

  if (!_rubrosActivos.length) {
    chips.style.display = 'none';
    return;
  }

  chips.style.display = 'flex';
  chips.innerHTML = _rubrosActivos.map(r =>
    '<span style="display:inline-flex;align-items:center;gap:4px;' +
    'background:rgba(255,107,26,0.15);border:1px solid rgba(255,107,26,0.4);' +
    'color:var(--em-orange);border-radius:14px;padding:4px 10px;' +
    'font-size:12px;font-weight:700;font-family:var(--sans);">' +
    esc(r) +
    '<button data-del-rubro="' + esc(r) + '" style="background:none;border:none;' +
    'color:var(--em-orange);cursor:pointer;font-size:13px;padding:0;line-height:1;' +
    'margin-left:2px;">×</button></span>'
  ).join('');

  chips.querySelectorAll('[data-del-rubro]').forEach(b => {
    b.addEventListener('click', () => {
      _rubrosActivos = _rubrosActivos.filter(r => r !== b.dataset.delRubro);
      /* Desmarcar el botón sugerido si corresponde */
      $$('#rubros-sugeridos [data-rubro]').forEach(btn => {
        btn.classList.toggle('active', _rubrosActivos.includes(btn.dataset.rubro));
      });
      actualizarChipsRubros();
    });
  });

  /* Limpiar el input cuando hay chips */
  if (input) input.placeholder = 'Agregar más rubros...';
}

function agregarRubro(rubro) {
  const r = rubro.trim().toLowerCase();
  if (!r) return;
  if (_rubrosActivos.includes(r)) return;
  _rubrosActivos.push(r);
  actualizarChipsRubros();
}

function parsearRubrosDelInput(valor) {
  /* Soporta: "taller, metalurgica, soldadora" o "taller metalurgica" */
  return valor.split(/[,;]+/)
    .map(r => r.trim().toLowerCase())
    .filter(Boolean);
}

/* Inicializar listeners del sistema multi-rubro */
function initMultiRubro() {
  const input = $('#inp-rubro');
  if (!input) return;

  /* Enter o coma en el campo → agregar rubro */
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const rubros = parsearRubrosDelInput(input.value);
      rubros.forEach(agregarRubro);
      input.value = '';
    }
  });

  /* Perder foco con texto → agregar como rubro */
  input.addEventListener('blur', () => {
    if (!input.value.trim()) return;
    const rubros = parsearRubrosDelInput(input.value);
    rubros.forEach(agregarRubro);
    input.value = '';
  });

  /* Chips de rubros sugeridos */
  $$('#rubros-sugeridos [data-rubro]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.rubro;
      if (_rubrosActivos.includes(r)) {
        /* Toggle: si ya está, quitar */
        _rubrosActivos = _rubrosActivos.filter(x => x !== r);
        btn.classList.remove('active');
      } else {
        agregarRubro(r);
        btn.classList.add('active');
      }
      actualizarChipsRubros();
    });
  });
}

/* ── Handler del botón BUSCAR ──────────────────────────────────────── */
let buscarTodaZona = false;

$('#btn-buscar').addEventListener('click', async () => {
  const ciudad = $('#inp-ciudad').value.trim();
  const fuente = $('#inp-fuente').value;

  /* Recolectar rubros: chips activos + lo que haya en el input */
  const inputVal = $('#inp-rubro').value.trim();
  if (inputVal) {
    parsearRubrosDelInput(inputVal).forEach(agregarRubro);
    $('#inp-rubro').value = '';
  }

  /* Si no hay chips ni input, usar el valor del input directamente */
  let rubros = [..._rubrosActivos];
  if (!rubros.length && inputVal) rubros = parsearRubrosDelInput(inputVal);
  if (!rubros.length) { toast('Ingresá al menos un rubro'); return; }
  if (!ciudad && !buscarTodaZona) { toast('Ingresá una ciudad'); return; }

  const ciudades = buscarTodaZona ? CIUDADES_ZONA : [ciudad];
  const info     = $('#buscar-info');
  const cont     = $('#resultados-buscar');

  /* Resumen de lo que se va a buscar */
  const totalCombinaciones = ciudades.length * rubros.length;
  info.innerHTML =
    '<span class="spinner"></span> Iniciando radar · ' +
    '<b>' + rubros.length + '</b> rubro(s) × ' +
    '<b>' + ciudades.length + '</b> ciudad(es) = ' +
    '<b>' + totalCombinaciones + '</b> campañas...';

  $('#btn-buscar').disabled = true;
  cont.innerHTML = '';
  state.resultados = [];
  _filtrarYaGuardados = false;

  const tsInicio     = Date.now();
  const idsGlobales  = new Set();
  let rubroActual    = 0;

  for (const rubro of rubros) {
    rubroActual++;
    for (const c of ciudades) {
      try {
        const parciales = await buscarMultiZona(c, rubro, fuente, (prog) => {
          const elapsed  = Math.round((Date.now() - tsInicio) / 1000);
          const restante = prog.total > 0 && prog.consulta > 0
            ? Math.round((elapsed / prog.consulta) * (prog.total - prog.consulta))
            : 0;

          info.innerHTML =
            '<span class="spinner" style="width:10px;height:10px;border-width:1px;' +
            'vertical-align:middle;margin-right:5px;"></span>' +
            '<b style="color:var(--em-orange);">' + esc(rubro) + '</b>' +
            ' (' + rubroActual + '/' + rubros.length + ')' +
            ' · <b>' + esc(c) + '</b>' +
            ' · Zona ' + prog.consulta + '/' + prog.total +
            ' · <b style="color:var(--accent);">' + state.resultados.length + '</b> únicos' +
            (restante > 0 ? ' · ~' + restante + 's' : '') +
            '<br><span style="font-size:10px;font-family:var(--mono);color:var(--text-dim);">' +
            '→ ' + esc(prog.query) + '</span>';
        });

        /* Calcular IUT y deduplicar globalmente */
        parciales.forEach(r => {
          r.iut  = calcularIUT({ ...r, equipos: [], tags: [] });
          r.rubro = r.rubro || detectarRubro(rubro);
        });

        const nuevos = parciales.filter(r => {
          const id = r.googleId || r.osmId;
          if (id && idsGlobales.has(id)) return false;
          /* Fallback: deduplicar por nombre+dirección */
          const k = normalizar(r.nombre) + '|' + normalizar(r.direccion || '').slice(0, 20);
          if (idsGlobales.has(k)) return false;
          if (id) idsGlobales.add(id);
          idsGlobales.add(k);
          return true;
        });

        state.resultados = state.resultados.concat(nuevos);
        state.resultados.sort((a, b) => b.iut - a.iut || (b.rating || 0) - (a.rating || 0));

        /* Render incremental después de cada rubro+ciudad */
        renderResultados(state.resultados);
        renderMapResults(state.resultados);

      } catch(e) {
        console.warn('[Buscar]', rubro, c, e.message);
      }
    }
  }

  /* Resumen final */
  const elapsed = Math.round((Date.now() - tsInicio) / 1000);
  if (state.resultados.length) {
    info.innerHTML =
      '✓ <b style="color:var(--accent);">' + state.resultados.length + '</b> objetivos únicos' +
      ' · <b>' + rubros.length + '</b> rubro(s)' +
      ' · ' + elapsed + 's' +
      ' · ' + (fuente === 'google' ? 'Google' : 'OSM');
  } else {
    info.textContent = 'Sin resultados. Probá con otros rubros o ciudad.';
  }

  /* Enriquecer teléfonos en background */
  if (state.resultados.some(r => r.fuente === 'google')) {
    setTimeout(() => lanzarEnriquecimiento(state.resultados), 500);
  }

  $('#btn-buscar').disabled = false;
});

/* Estado del filtro de resultados */
let _filtrarYaGuardados = false;

function getResultadosFiltrados() {
  if (!_filtrarYaGuardados) return state.resultados;
  return state.resultados.filter(r => !encontrarLeadExistente(r));
}

function renderBotonesAccionMasiva() {
  const total   = state.resultados.length;
  const nuevos  = state.resultados.filter(r => !encontrarLeadExistente(r)).length;
  const ya      = total - nuevos;

  const barra = $('#barra-acciones-resultados');
  if (!barra) return;

  barra.style.display = total ? 'flex' : 'none';
  barra.innerHTML =
    /* Contador */
    '<div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">' +
      '<span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);">' +
        '<b style="color:var(--accent);">' + nuevos + '</b> nuevos · ' +
        '<b style="color:var(--text-dim);">' + ya + '</b> ya guardados' +
      '</span>' +
    '</div>' +
    /* Toggle ocultar ya guardados */
    '<button id="btn-toggle-ya-guardados" class="btn btn-sm' + (_filtrarYaGuardados ? ' btn-g' : '') + '" ' +
      'style="flex-shrink:0;font-size:11px;padding:6px 10px;">' +
      (_filtrarYaGuardados ? '✓ Solo nuevos' : 'Solo nuevos') +
    '</button>' +
    /* Guardar todos los nuevos */
    '<button id="btn-guardar-todos" class="btn btn-em btn-sm" ' +
      'style="flex-shrink:0;font-size:11px;padding:6px 10px;" ' +
      (nuevos === 0 ? 'disabled style="opacity:0.4;"' : '') + '>' +
      '⬇ GUARDAR ' + nuevos +
    '</button>';

  /* Toggle filtro */
  $('#btn-toggle-ya-guardados').addEventListener('click', () => {
    _filtrarYaGuardados = !_filtrarYaGuardados;
    renderBotonesAccionMasiva();
    renderResultados(state.resultados);
  });

  /* Guardar todos los nuevos */
  $('#btn-guardar-todos').addEventListener('click', async () => {
    const btn    = $('#btn-guardar-todos');
    const nuevos = state.resultados.filter(r => !encontrarLeadExistente(r));
    if (!nuevos.length) return;

    btn.disabled   = true;
    btn.textContent = '⏳ Guardando...';

    let guardados = 0;
    for (const n of nuevos) {
      const lead = crearLeadDesdeResultado(n);
      await dbSaveLead(lead);
      if (lead.lat && lead.lon && state.mapLeadsVisible) {
        const m = L.marker([lead.lat, lead.lon], { icon: createLeadIcon(lead) })
          .addTo(map)
          .on('click', () => { expandPanel(); setTab('leads'); setTimeout(() => abrirModalLead(lead.id), 200); });
        _leadMarkersMap.set(lead.id, m);
      }
      guardados++;
      /* Actualizar contador cada 5 para no bloquear UI */
      if (guardados % 5 === 0) {
        btn.textContent = '⏳ ' + guardados + '/' + nuevos.length;
        await new Promise(res => setTimeout(res, 0));
      }
    }

    toast('✓ ' + guardados + ' leads guardados');
    renderBotonesAccionMasiva();
    renderResultados(state.resultados);

    /* Enriquecer teléfonos de los recién guardados */
    if (nuevos.some(r => r.fuente === 'google')) {
      setTimeout(() => lanzarEnriquecimiento(nuevos), 500);
    }
  });
}

function renderResultados(lista) {
  const cont = $('#resultados-buscar');

  /* Actualizar barra de acciones */
  renderBotonesAccionMasiva();

  /* Aplicar filtro de ya guardados */
  const listaFiltrada = _filtrarYaGuardados
    ? lista.filter(r => !encontrarLeadExistente(r))
    : lista;

  if (!listaFiltrada.length) {
    cont.innerHTML = _filtrarYaGuardados
      ? '<div class="empty-state"><span class="ico">✅</span>Todos los resultados ya están guardados.</div>'
      : '<div class="empty-state"><span class="ico">🔍</span>Sin resultados.</div>';
    return;
  }

  /* Guardar _idx */
  lista.forEach((n, i) => { n._idx = i; });

  cont.innerHTML = listaFiltrada.map((n, i) => {
    const tel    = !!(n.telefono && limpiarTel(n.telefono).length >= 6);
    const yaLead = !!encontrarLeadExistente(n);
    const src    = n.fuente === 'google' ? 'g' : 'osm';
    const iut    = n.iut || 0;
    const gid    = n.googleId ? 'data-google-id="' + esc(n.googleId) + '"' : '';

    let telHtml;
    if (tel) {
      telHtml = '<div class="rc-meta rc-tel-slot">📞 <strong>' + esc(n.telefono) + '</strong></div>';
    } else if (n.fuente === 'google' && n.googleId) {
      telHtml = '<div class="rc-meta rc-tel-slot muted"><span class="spinner" style="width:10px;height:10px;border-width:1px;vertical-align:middle;margin-right:4px;"></span>Cargando...</div>';
    } else {
      telHtml = '<div class="rc-meta rc-tel-slot muted">Sin teléfono</div>';
    }

    return '<div class="result-card src-' + src + '" ' + gid + '>' +
      '<div class="rc-header">' +
        '<div class="rc-name">' + esc(n.nombre) + ' <span class="iut-badge ' + iutClase(iut) + '" style="font-size:9px;">' + iutLabel(iut) + iut + '</span></div>' +
        (n.rating ? '<div style="color:var(--yellow);font-size:11px;">★ ' + n.rating + '</div>' : '') +
      '</div>' +
      (n.direccion ? '<div class="rc-meta">📍 ' + esc(n.direccion) + '</div>' : '') +
      telHtml +
      (n.tipo ? '<div class="rc-meta muted">' + esc(n.tipo) + '</div>' : '') +
      '<div class="rc-actions">' +
        '<button class="btn btn-sm" data-rc-maps="' + n._idx + '">MAPS</button>' +
        (tel ? '<button class="btn btn-sm btn-b rc-wa-btn" data-rc-wa="' + n._idx + '">WA</button>' : '') +
        '<button class="btn btn-sm ' + (yaLead ? '' : 'btn-em') + '" data-rc-add="' + n._idx + '" ' +
          (yaLead ? 'disabled style="opacity:0.5;"' : '') + '>' +
          (yaLead ? '✓ GUARDADO' : '+ GUARDAR') +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');

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
      b.disabled    = true;
      b.classList.remove('btn-em');
      renderBotonesAccionMasiva();
      toast('✓ Lead guardado');
    });
  });

  cont.querySelectorAll('[data-rc-wa]').forEach(b => {
    b.addEventListener('click', async () => {
      const n = state.resultados[+b.dataset.rcWa];
      let lead = encontrarLeadExistente(n);
      if (!lead) { lead = crearLeadDesdeResultado(n); await dbSaveLead(lead); }
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

/* ======================================================================
   MODO ARRANCAR DÍA
   ======================================================================
   Sugiere automáticamente los mejores objetivos del día basándose en:

   CRITERIOS DE SELECCIÓN (score compuesto):
   1. Seguimiento vencido hoy o atrasado        → +100 pts
   2. IUT alto (urgencia técnica)               → hasta +80 pts
   3. Estado urgente                            → +60 pts
   4. Nunca contactado con teléfono disponible  → +40 pts
   5. Cliente/recurrente (revisita productiva)  → +35 pts
   6. Proximidad GPS (radio 5km)                → hasta +30 pts
   7. Presupuesto enviado sin respuesta         → +25 pts
   8. Sin contacto hace más de 7 días           → +20 pts

   Devuelve hasta 8 objetivos ordenados y optimiza la ruta por cercanía.
   ====================================================================== */

function calcularScoreDia(lead, userLat, userLon) {
  let score = 0;
  const ahora = Date.now();

  /* Seguimiento vencido — máxima prioridad */
  if (lead.seguimientoFecha) {
    const diff = ahora - new Date(lead.seguimientoFecha).getTime();
    if (diff >= 0) score += 100; /* hoy o atrasado */
  }

  /* IUT */
  const iut = calcularIUT(lead);
  score += Math.round(iut * 0.8);

  /* Estado */
  if (lead.estado === 'urgente')       score += 60;
  if (lead.estado === 'presupuesto')   score += 25;
  if (lead.estado === 'esperando')     score += 20;
  if (['cliente','recurrente','mantenimiento'].includes(lead.estado)) score += 35;

  /* Sin contacto nunca + tiene teléfono */
  if (lead.estado === 'no-contactado' && lead.telefono &&
      limpiarTel(lead.telefono).length >= 6) score += 40;

  /* Días desde último contacto */
  if (lead.historial?.length) {
    const ultimo = new Date(lead.historial[lead.historial.length-1].fecha).getTime();
    const diasSin = (ahora - ultimo) / 86400000;
    if (diasSin > 7)  score += 20;
    if (diasSin > 30) score += 15;
  } else {
    score += 20; /* sin historial = nunca tocado */
  }

  /* Proximidad GPS */
  if (userLat && lead.lat && lead.lon) {
    const dist = distKm(userLat, userLon, lead.lat, lead.lon);
    if (dist <= 5) score += Math.round((1 - dist/5) * 30);
  }

  return score;
}

function generarObjetivosDia(max) {
  max = max || 8;
  const userLat = state.userLat;
  const userLon = state.userLon;

  return state.leads
    .filter(l => l.lat && l.lon && !['descartado'].includes(l.estado))
    .map(l => ({ ...l, _scoreDia: calcularScoreDia(l, userLat, userLon) }))
    .sort((a, b) => b._scoreDia - a._scoreDia)
    .slice(0, max);
}

function renderArrancarDia() {
  const panel = $('#panel-arrancar-dia');
  if (!panel) return;
  panel.style.display = 'block';

  /* Resumen del día */
  const ahora       = Date.now();
  const seguHoy     = state.leads.filter(l =>
    l.seguimientoFecha && new Date(l.seguimientoFecha).getTime() <= ahora &&
    !['descartado'].includes(l.estado)
  ).length;
  const urgentes    = state.leads.filter(l => l.estado === 'urgente').length;
  const sinContacto = state.leads.filter(l =>
    l.estado === 'no-contactado' && l.telefono &&
    limpiarTel(l.telefono).length >= 6
  ).length;

  $('#dia-resumen').innerHTML =
    '<div class="z-stat"><b style="color:var(--em-orange);">' + seguHoy + '</b>seguim. hoy</div>' +
    '<div class="z-stat"><b style="color:var(--red);">' + urgentes + '</b>urgentes</div>' +
    '<div class="z-stat"><b style="color:var(--accent);">' + sinContacto + '</b>sin contactar</div>';

  /* Objetivos sugeridos */
  const objetivos = generarObjetivosDia(8);
  const cont      = $('#dia-objetivos');

  if (!objetivos.length) {
    cont.innerHTML = '<div class="muted" style="font-size:12px;text-align:center;padding:8px;">Sin leads con coordenadas todavía.</div>';
    return;
  }

  cont.innerHTML = objetivos.map(l => {
    const iut      = calcularIUT(l);
    const dist     = state.userLat ? distKm(state.userLat, state.userLon, l.lat, l.lon) : null;
    const seguHoy2 = l.seguimientoFecha &&
      new Date(l.seguimientoFecha).getTime() <= ahora;

    /* Motivo principal */
    let motivo = '';
    if (seguHoy2)                       motivo = '⏰ Seguimiento hoy';
    else if (l.estado === 'urgente')    motivo = '🚨 Urgente';
    else if (l.estado === 'presupuesto') motivo = '💰 Presupuesto pendiente';
    else if (l.estado === 'no-contactado') motivo = '📞 Sin contactar';
    else if (['cliente','recurrente','mantenimiento'].includes(l.estado))
                                         motivo = '⭐ Cliente — revisita';
    else motivo = '🎯 IUT ' + iut;

    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;' +
      'border-bottom:1px solid var(--border);">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:800;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;">' + esc(l.nombre) + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim);">' +
          motivo +
          (dist !== null ? ' · ' + fmtDist(dist) : '') +
        '</div>' +
      '</div>' +
      '<span class="iut-badge ' + iutClase(iut) + '" style="font-size:9px;flex-shrink:0;">' +
        iutLabel(iut) + iut +
      '</span>' +
    '</div>';
  }).join('');

  /* Guardar los objetivos como ruta */
  panel._objetivos = objetivos;
}

$('#btn-ir-hoy').addEventListener('click', () => {
  if (!state.userLat) { toast('Activá GPS primero'); return; }
  if (!state.leads.filter(l => l.lat && l.lon).length) {
    toast('Sin leads con coordenadas todavía'); return;
  }
  renderArrancarDia();
  /* Scroll al panel */
  $('#panel-arrancar-dia').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#btn-cerrar-arrancar').addEventListener('click', () => {
  $('#panel-arrancar-dia').style.display = 'none';
});

$('#btn-dia-regenerar').addEventListener('click', () => {
  renderArrancarDia();
  toast('Objetivos regenerados');
});

$('#btn-dia-iniciar').addEventListener('click', () => {
  const panel    = $('#panel-arrancar-dia');
  const objetivos = panel?._objetivos;
  if (!objetivos?.length) { toast('Sin objetivos generados'); return; }

  const rutaOpt = optimizarRuta(
    objetivos.map(l => ({
      id: uid(), leadId: l.id, nombre: l.nombre,
      direccion: l.direccion, lat: l.lat, lon: l.lon
    })),
    state.userLat, state.userLon
  );
  state.ruta = rutaOpt;
  saveRuta();
  panel.style.display = 'none';
  setTab('ruta');
  toast('✓ Ruta del día: ' + objetivos.length + ' objetivos optimizados');
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
/* ── Helpers para stats de conversión ─────────────────────────────── */
function calcularConversionPorRubro() {
  const rubros = {};
  for (const l of state.leads) {
    if (l.estado === 'descartado') continue;
    const r = l.rubro || detectarRubro(l.tipo || '');
    if (!rubros[r]) rubros[r] = { total:0, contactados:0, clientes:0 };
    rubros[r].total++;
    if (l.estado !== 'no-contactado') rubros[r].contactados++;
    if (['cliente','recurrente','mantenimiento'].includes(l.estado)) rubros[r].clientes++;
  }
  return Object.entries(rubros)
    .map(([rubro, d]) => ({
      rubro,
      ...d,
      tasaContacto:  d.total > 0 ? Math.round((d.contactados / d.total) * 100) : 0,
      tasaCliente:   d.contactados > 0 ? Math.round((d.clientes / d.contactados) * 100) : 0
    }))
    .sort((a, b) => b.clientes - a.clientes || b.total - a.total);
}

function calcularRevisitasPendientes() {
  const ahora = Date.now();
  const pendientes = [];

  for (const l of state.leads) {
    if (['descartado'].includes(l.estado)) continue;

    /* Revisita por ciclo de mantenimiento */
    if (l.cicloMantenimiento && l.historial?.length) {
      const ultimoContacto = l.historial
        .filter(h => h.accion && (h.accion.includes('WhatsApp') || h.accion.includes('visitado') || h.accion.includes('cliente')))
        .sort((a,b) => new Date(b.fecha) - new Date(a.fecha))[0];

      if (ultimoContacto) {
        const fechaProxima = new Date(ultimoContacto.fecha);
        fechaProxima.setMonth(fechaProxima.getMonth() + l.cicloMantenimiento);
        const diasHasta = Math.round((fechaProxima.getTime() - ahora) / 86400000);

        if (diasHasta <= 30) { /* próximos 30 días */
          pendientes.push({
            lead:      l,
            tipo:      'mantenimiento',
            diasHasta,
            fecha:     fechaProxima,
            motivo:    'Ciclo de mantenimiento cada ' + l.cicloMantenimiento + ' mes(es)'
          });
        }
        continue;
      }
    }

    /* Revisita por seguimiento configurado */
    if (l.seguimientoFecha) {
      const diasHasta = Math.round((new Date(l.seguimientoFecha).getTime() - ahora) / 86400000);
      if (diasHasta >= 0 && diasHasta <= 14) {
        pendientes.push({
          lead:      l,
          tipo:      'seguimiento',
          diasHasta,
          fecha:     new Date(l.seguimientoFecha),
          motivo:    'Seguimiento programado'
        });
      }
    }

    /* Clientes sin visitar hace más del ciclo esperado por rubro */
    if (['cliente','recurrente'].includes(l.estado) && l.historial?.length) {
      const ultimo = l.historial[l.historial.length - 1];
      const diasSin = Math.round((ahora - new Date(ultimo.fecha).getTime()) / 86400000);
      if (diasSin > 45 && !l.seguimientoFecha) {
        pendientes.push({
          lead:      l,
          tipo:      'cliente-inactivo',
          diasHasta: -diasSin, /* negativo = hace N días */
          fecha:     new Date(ultimo.fecha),
          motivo:    'Cliente sin contacto hace ' + diasSin + ' días'
        });
      }
    }
  }

  return pendientes.sort((a, b) => a.diasHasta - b.diasHasta);
}

async function renderStats() {
  const t            = state.leads;
  const total        = t.length;
  const contactados  = t.filter(l=>l.estado!=='no-contactado'&&l.estado!=='descartado').length;
  const respondio    = t.filter(l=>['respondio','presupuesto','esperando'].includes(l.estado)).length;
  const clientes     = t.filter(l=>['cliente','recurrente','mantenimiento'].includes(l.estado)).length;
  const urgentes     = t.filter(l=>l.estado==='urgente').length;
  const conFotos     = t.filter(l=>(l.fotos||[]).length>0).length;
  const pendSeg      = t.filter(l=>l.seguimientoFecha&&esHoyOAtrasado(l.seguimientoFecha)&&l.estado!=='descartado').length;
  const estrategicos = t.filter(l=>l.nivel==='estrategico').length;

  $('#stats-grid').innerHTML =
    '<div class="stat-card"><div class="stat-num">' + total + '</div><div class="stat-label">TOTAL LEADS</div></div>' +
    '<div class="stat-card"><div class="stat-num">' + contactados + '</div><div class="stat-label">CONTACTADOS</div></div>' +
    '<div class="stat-card"><div class="stat-num">' + respondio + '</div><div class="stat-label">RESPONDIERON</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:var(--em-orange);">' + clientes + '</div><div class="stat-label">CLIENTES</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:var(--red);">' + urgentes + '</div><div class="stat-label">URGENTES</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:var(--em-orange);">' + estrategicos + '</div><div class="stat-label">ESTRATÉGICOS</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:var(--orange);">' + pendSeg + '</div><div class="stat-label">SEGUIM. HOY</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:var(--blue);">' + conFotos + '</div><div class="stat-label">CON FOTOS</div></div>';

  /* Equipos más detectados */
  const equiposFreq  = {};
  t.forEach(l => (l.equipos||[]).forEach(e => { equiposFreq[e]=(equiposFreq[e]||0)+1; }));
  const equiposOrden = Object.entries(equiposFreq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxEq        = equiposOrden[0]?.[1] || 1;

  $('#stats-equipos').innerHTML = equiposOrden.length
    ? equiposOrden.map(([eid,cnt]) => {
        const eq  = EQUIPOS_CATALOGO.find(x=>x.id===eid) || { ico:'📦', label:eid.toUpperCase() };
        const pct = Math.round((cnt/maxEq)*100);
        return '<div style="margin-bottom:6px;">' +
          '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">' +
            '<span style="font-weight:700;">' + eq.ico + ' ' + eq.label + '</span>' +
            '<span style="font-family:var(--mono);color:var(--em-orange);">' + cnt + '</span>' +
          '</div>' +
          '<div class="iut-bar"><div class="iut-bar-fill" style="width:' + pct + '%;background:var(--em-orange);"></div></div>' +
        '</div>';
      }).join('')
    : '<div class="muted">Agregá equipos a los leads para ver estadísticas.</div>';

  /* ── MEJORA 7: Conversiones por rubro ─────────────────────────────── */
  const conversiones = calcularConversionPorRubro();
  const contConv     = $('#stats-conversiones');
  if (contConv) {
    if (!conversiones.length) {
      contConv.innerHTML = '<div class="muted">Sin datos suficientes todavía.</div>';
    } else {
      const maxClientes = conversiones[0]?.clientes || 1;
      contConv.innerHTML = conversiones.slice(0,6).map(c => {
        const pct = Math.round((c.clientes / Math.max(maxClientes,1)) * 100);
        return '<div style="margin-bottom:8px;background:var(--bg-panel);border:1px solid var(--border);' +
          'border-radius:var(--r);padding:9px 10px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:12px;font-weight:800;text-transform:capitalize;">' + esc(c.rubro) + '</span>' +
            '<div style="display:flex;gap:6px;font-family:var(--mono);font-size:10px;">' +
              '<span style="color:var(--text-dim);">' + c.total + ' leads</span>' +
              '<span style="color:var(--blue);">' + c.tasaContacto + '% contactado</span>' +
              '<span style="color:var(--accent);font-weight:700;">' + c.clientes + ' clientes</span>' +
            '</div>' +
          '</div>' +
          /* Barra doble: contactados (azul) + clientes (naranja) */
          '<div style="height:6px;background:var(--bg-raised);border-radius:3px;overflow:hidden;">' +
            '<div style="height:100%;width:' + c.tasaContacto + '%;background:var(--blue);border-radius:3px;position:relative;">' +
              '<div style="position:absolute;top:0;left:0;height:100%;width:' + c.tasaCliente + '%;background:var(--em-orange);border-radius:3px;"></div>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:9px;color:var(--text-dim);margin-top:3px;font-family:var(--mono);">' +
            '■ <span style="color:var(--blue);">contactado</span> ' +
            '■ <span style="color:var(--em-orange);">cliente (' + c.tasaCliente + '% conv.)</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

  /* ── MEJORA 8: Alertas de revisita inteligente ─────────────────────── */
  const revisitas  = calcularRevisitasPendientes();
  const contRevis  = $('#stats-revisitas');
  if (contRevis) {
    if (!revisitas.length) {
      contRevis.innerHTML = '<div class="muted" style="font-size:12px;">' +
        'Sin revisitas pendientes en los próximos 30 días. ✓</div>';
    } else {
      contRevis.innerHTML = revisitas.slice(0,8).map(r => {
        const l        = r.lead;
        const esHoy    = r.diasHasta === 0;
        const esAtras  = r.diasHasta < 0;
        const esPronto = r.diasHasta > 0 && r.diasHasta <= 7;

        let colorBg, colorTxt, textoFecha;
        if (esAtras)      { colorBg='rgba(255,51,85,0.1)';    colorTxt='var(--red)';      textoFecha='Hace ' + Math.abs(r.diasHasta) + ' días'; }
        else if (esHoy)   { colorBg='rgba(255,107,26,0.12)';  colorTxt='var(--em-orange)'; textoFecha='HOY'; }
        else if (esPronto){ colorBg='rgba(245,196,0,0.1)';    colorTxt='var(--yellow)';   textoFecha='En ' + r.diasHasta + ' días'; }
        else               { colorBg='rgba(45,143,255,0.08)'; colorTxt='var(--blue)';     textoFecha='En ' + r.diasHasta + ' días'; }

        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;' +
          'background:' + colorBg + ';border:1px solid ' + colorTxt + '33;border-radius:var(--r);' +
          'margin-bottom:6px;cursor:pointer;" data-rev-id="' + l.id + '">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
              esc(l.nombre) +
            '</div>' +
            '<div style="font-size:10px;color:var(--text-dim);">' + esc(r.motivo) + '</div>' +
          '</div>' +
          '<div style="text-align:right;flex-shrink:0;">' +
            '<div style="font-size:11px;font-weight:800;font-family:var(--mono);color:' + colorTxt + ';">' +
              textoFecha +
            '</div>' +
            (l.telefono ? '<div style="font-size:9px;color:var(--text-dim);">📞</div>' : '') +
          '</div>' +
        '</div>';
      }).join('');

      /* Click en revisita → abrir ficha */
      contRevis.querySelectorAll('[data-rev-id]').forEach(el => {
        el.addEventListener('click', () => {
          expandPanel();
          abrirModalLead(el.dataset.revId);
        });
      });
    }
  }

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

/* Botones simples — el avanzado está en btn-exportar-avanzado */
$('#btn-exportar').addEventListener('click', exportarJSON);
$('#btn-importar').addEventListener('click', abrirExportadorAvanzado);
/* file-import legacy — ya no se usa, reemplazado por exp-file-input dentro del modal */

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
  renderZonasConfig();
}

function renderZonasConfig() {
  const cont = $('#zonas-config-lista');
  if (!cont) return;
  const todas = getZonas().filter(z => z); /* sin el vacío inicial */
  cont.innerHTML = todas.map((z, i) => {
    const esDefault = i < ZONAS_DEFAULT.filter(z=>z).length;
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">' +
      '<span style="flex:1;font-size:12px;font-family:var(--mono);color:' + (esDefault ? 'var(--text-dim)' : 'var(--accent)') + ';">' +
      esc(z) + (esDefault ? ' <span style=\"font-size:9px;\">(default)</span>' : '') + '</span>' +
      (!esDefault ? '<button class="btn btn-sm btn-r" style="padding:4px 8px;min-height:28px;" data-del-zona="' + esc(z) + '">✕</button>' : '') +
      '</div>';
  }).join('');

  cont.querySelectorAll('[data-del-zona]').forEach(b => {
    b.addEventListener('click', async () => {
      const z = b.dataset.delZona;
      await guardarZonasExtra(_zonasExtra.filter(x => x !== z));
      renderZonasConfig();
      toast('Zona eliminada');
    });
  });
}

function cargarMensajesRubro(rubro) {
  const m = state.mensajes[rubro] || MENSAJES_DEFAULT[rubro] || MENSAJES_DEFAULT.comercio;
  $('#msg-primero').value    = m.primero;
  $('#msg-seguimiento').value = m.seguimiento;
  $('#msg-cierre').value     = m.cierre;
}

$('#inp-edit-rubro').addEventListener('change', e => cargarMensajesRubro(e.target.value));

$('#btn-add-zona').addEventListener('click', async () => {
  const inp = $('#inp-nueva-zona');
  if (!inp) return;
  const z = inp.value.trim();
  if (!z) { toast('Escribí una zona'); return; }
  if (getZonas().includes(z)) { toast('Zona ya existe'); return; }
  await guardarZonasExtra([..._zonasExtra, z]);
  inp.value = '';
  renderZonasConfig();
  toast('Zona agregada: ' + z);
});

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

    /* Cargar zonas extra configuradas por el usuario */
    await cargarZonasExtra();

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
    initMultiRubro();
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
