// 批次三角定位工具 — batch-main.js — CSV batch UI, multi-group rendering

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  groups: [],          // [{ name, colorIndex, stations, calcStations, visible, result, error }]
  rawHeader: [],       // original CSV header cells
  rawRows: [],         // original CSV data rows (array of cell arrays)
  colIdx: null,        // { group, lat, lon, azimuth, date }
  northMode: 'true',   // 'true' | 'magnetic'
  dateMode: 'custom',  // 'custom' | 'csv'
  date: todayISO(),
  lineAlgorithm: 'planar',
  estimator: 'centroid',
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const errorBannerEl = document.getElementById('error-banner');
const uploadStatusEl = document.getElementById('upload-status');
const legendListEl   = document.getElementById('legend-list');
const legendEmptyEl  = document.getElementById('legend-empty');
const legendActionsEl = document.getElementById('legend-actions');
const btnSelectAll    = document.getElementById('btn-select-all');
const btnDeselectAll   = document.getElementById('btn-deselect-all');
const btnDeselectEmpty = document.getElementById('btn-deselect-empty');
const downloadSecEl  = document.getElementById('download-section');
const dropzoneEl     = document.getElementById('dropzone');
const fileInputEl    = document.getElementById('file-input');
const dateInputEl    = document.getElementById('date-input');
const dateLabelEl    = document.getElementById('date-label');

const btnNorthTrue    = document.getElementById('btn-north-true');
const btnNorthMag     = document.getElementById('btn-north-magnetic');
const btnDateCustom   = document.getElementById('btn-date-custom');
const btnDateCsv      = document.getElementById('btn-date-csv');
const btnLinePlanar   = document.getElementById('btn-line-planar');
const btnLineGeodesic = document.getElementById('btn-line-geodesic');
const btnEstCentroid  = document.getElementById('btn-est-centroid');
const btnEstMle       = document.getElementById('btn-est-mle');

// ── Init ───────────────────────────────────────────────────────────────────
initMap('map');
dateInputEl.value = state.date;
updateDateInputVisibility();

// ── CSV parsing ──────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop fully-blank lines
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function findColumns(header) {
  const norm = header.map(h => h.trim().toLowerCase());
  const idx = {
    group: norm.indexOf('group'),
    lat: norm.indexOf('lat'),
    lon: norm.indexOf('lon'),
    azimuth: norm.indexOf('azimuth'),
  };
  const missing = Object.keys(idx).filter(k => idx[k] === -1);
  if (missing.length) {
    throw new Error(`CSV 缺少必要欄位：${missing.join(', ')}（需要 group, lat, lon, azimuth）`);
  }
  idx.date = norm.indexOf('date'); // optional, -1 if absent
  return idx;
}

function validDate(str) {
  if (!str) return null;
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : str.trim();
}

// ── Load & build groups ────────────────────────────────────────────────────
function loadCSV(text) {
  hideError();
  let rows;
  try {
    rows = parseCSV(text);
    if (rows.length < 2) throw new Error('CSV 沒有資料列');
    state.colIdx = findColumns(rows[0]);
  } catch (e) {
    showError(e.message);
    return;
  }

  state.rawHeader = rows[0];
  state.rawRows = rows.slice(1);

  const { group: gi, lat: li, lon: oi, azimuth: ai, date: di } = state.colIdx;
  const byName = new Map();
  state.rawRows.forEach((r, rowIndex) => {
    const name = (r[gi] || '').trim();
    if (!name) return;
    if (!byName.has(name)) byName.set(name, { stations: [], invalidRows: [] });
    const entry = byName.get(name);
    const lat = parseFloat(r[li]);
    const lon = parseFloat(r[oi]);
    const az = parseFloat(r[ai]);
    if (isNaN(lat) || isNaN(lon) || isNaN(az)) {
      entry.invalidRows.push(rowIndex); // unparseable lat/lon/azimuth
      return;
    }
    const _date = di !== -1 ? (r[di] || '').trim() : '';
    entry.stations.push({ lat, lon, azimuth: az, _date, _row: rowIndex });
  });

  state.groups = [...byName.entries()].map(([name, e], idx) => ({
    name,
    colorIndex: idx,
    stations: e.stations,
    invalidRows: e.invalidRows,
    calcStations: null,
    visible: true,
    result: null,
    error: null,
    ignoredIds: [],
    dataInvalid: false,
  }));

  computeAll();
  renderLegend();
  redraw(true);

  const hasDate = state.colIdx.date !== -1;
  uploadStatusEl.textContent =
    `已載入 ${state.groups.length} 組、${state.rawRows.length} 列` + (hasDate ? '（含 date 欄）' : '');
  uploadStatusEl.hidden = false;
  downloadSecEl.hidden = state.groups.length === 0;
  legendActionsEl.hidden = state.groups.length === 0;
  legendEmptyEl.hidden = state.groups.length > 0;
  btnDateCsv.disabled = !hasDate;
  btnDateCsv.title = hasDate ? '' : 'CSV 無 date 欄';
}

// ── Compute all groups ───────────────────────────────────────────────────
// Convert each station's azimuth to true north, using per-station CSV date
// when dateMode is 'csv', otherwise the global custom date. Assigns 1-based id.
function correctStations(stations) {
  const useCsv = state.dateMode === 'csv' && state.colIdx && state.colIdx.date !== -1;
  return stations.map((s, i) => {
    const base = { id: i + 1, ...s };
    if (state.northMode !== 'magnetic') return base;
    const d = useCsv ? (validDate(s._date) || state.date) : state.date;
    base.azimuth = magneticToTrue(s.azimuth, s.lat, s.lon, d);
    return base;
  });
}

function computeAll() {
  for (const g of state.groups) {
    g.result = null;
    g.error = null;
    g.ignoredIds = [];
    g.dataInvalid = false;
    g.singlePoint = false;

    if (g.invalidRows.length > 0) {
      g.dataInvalid = true;   // bad data — flag whole group, don't compute or draw
      g.calcStations = [];
      continue;
    }

    const stations = correctStations(g.stations);
    g.calcStations = stations;

    if (stations.length < 2) {
      g.singlePoint = true;   // only one定位點 — cannot triangulate
      continue;
    }

    try {
      const res = calculateTargetTolerant(stations, {
        lineAlgorithm: state.lineAlgorithm,
        estimator: state.estimator,
      });
      g.result = res;
      g.ignoredIds = res.ignoredIds;
    } catch (e) {
      g.error = e.message;
    }
  }
}

// ── Map rendering ────────────────────────────────────────────────────────
function redraw(fit) {
  clearOverlays();
  const points = [];

  for (const g of state.groups) {
    if (!g.visible || !g.calcStations || g.calcStations.length === 0) continue;
    const color = groupColor(g.colorIndex);
    const lineLength = computeLineLength(g.calcStations);

    g.calcStations.forEach(s => {
      drawGroupStation(s.lat, s.lon, color);
      drawBearingLine(s.lat, s.lon, s.azimuth, lineLength, color);
      points.push({ lat: s.lat, lon: s.lon });
    });

    if (g.result) {
      drawTarget(g.result.target.lat, g.result.target.lon, color);
      points.push(g.result.target);
    }
  }

  if (fit && points.length) fitToPoints(points);
}

// ── Legend ───────────────────────────────────────────────────────────────
function renderLegend() {
  legendListEl.innerHTML = '';

  state.groups.forEach(g => {
    const color = groupColor(g.colorIndex);
    const n = g.stations.length;

    let detail, cls;
    if (g.dataInvalid) {
      detail = '資料無效，請檢查 lat/lon/azimuth';
      cls = 'legend-detail danger';
    } else if (g.singlePoint) {
      detail = '僅有 1 筆定位點';
      cls = 'legend-detail danger';
    } else if (g.result) {
      const t = g.result.target;
      const a = g.result.minAcuteAngle;
      const warn = a.value < 30;
      const ignoredN = g.ignoredIds.length;
      const stnText = ignoredN ? `${n} 站（忽略 ${ignoredN}）` : `${n} 站`;
      detail = `${stnText} · ${t.lat.toFixed(5)}, ${t.lon.toFixed(5)} · 銳角 ${a.value.toFixed(1)}°${warn ? ' ⚠' : ''}`;
      cls = ignoredN ? 'legend-detail partial' : (warn ? 'legend-detail warn' : 'legend-detail');
    } else {
      detail = `${n} 站 · 無交點`;
      cls = 'legend-detail danger';
    }

    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `
      <input type="checkbox" data-name="${escapeHtml(g.name)}" ${g.visible ? 'checked' : ''}>
      <span class="legend-swatch" style="background:${color}"></span>
      <div class="legend-body">
        <div class="legend-name">${escapeHtml(g.name)}</div>
        <div class="${cls}">${escapeHtml(detail)}</div>
      </div>`;
    legendListEl.appendChild(row);

    const chk = row.querySelector('input');
    chk.addEventListener('change', () => {
      g.visible = chk.checked;
      redraw(false);
    });

    row.addEventListener('click', e => {
      if (e.target === chk) return;
      fitToGroup(g);
    });
  });
}

function fitToGroup(g) {
  if (!g.calcStations || !g.calcStations.length) return;
  const points = g.calcStations.map(s => ({ lat: s.lat, lon: s.lon }));
  if (g.result) points.push(g.result.target);
  fitToPoints(points);
}

btnSelectAll.addEventListener('click', () => {
  state.groups.forEach(g => { g.visible = true; });
  renderLegend();
  redraw(false);
});

btnDeselectAll.addEventListener('click', () => {
  state.groups.forEach(g => { g.visible = false; });
  renderLegend();
  redraw(false);
});

btnDeselectEmpty.addEventListener('click', () => {
  state.groups.forEach(g => { if (!g.result) g.visible = false; });
  renderLegend();
  redraw(false);
});

// ── Global setting toggles ─────────────────────────────────────────────────
function recompute() {
  if (!state.groups.length) return;
  computeAll();
  renderLegend();
  redraw(false);
}

// Hide the date picker when reading dates from the CSV's date column.
function updateDateInputVisibility() {
  dateInputEl.hidden = state.dateMode === 'csv';
}

function setNorth(mode) {
  if (state.northMode === mode) return;
  state.northMode = mode;
  btnNorthTrue.classList.toggle('active', mode === 'true');
  btnNorthMag.classList.toggle('active', mode === 'magnetic');
  dateLabelEl.hidden = mode !== 'magnetic';
  recompute();
}
btnNorthTrue.addEventListener('click', () => setNorth('true'));
btnNorthMag.addEventListener('click', () => setNorth('magnetic'));

dateInputEl.addEventListener('change', e => {
  state.date = e.target.value;
  if (state.northMode === 'magnetic') recompute();
});

function setDateMode(mode) {
  if (state.dateMode === mode) return;
  state.dateMode = mode;
  btnDateCustom.classList.toggle('active', mode === 'custom');
  btnDateCsv.classList.toggle('active', mode === 'csv');
  updateDateInputVisibility();
  if (state.northMode === 'magnetic') recompute();
}
btnDateCustom.addEventListener('click', () => setDateMode('custom'));
btnDateCsv.addEventListener('click', () => { if (!btnDateCsv.disabled) setDateMode('csv'); });

function setLine(algo) {
  if (state.lineAlgorithm === algo) return;
  state.lineAlgorithm = algo;
  btnLinePlanar.classList.toggle('active', algo === 'planar');
  btnLineGeodesic.classList.toggle('active', algo === 'geodesic');
  recompute();
}
btnLinePlanar.addEventListener('click', () => setLine('planar'));
btnLineGeodesic.addEventListener('click', () => setLine('geodesic'));

function setEst(est) {
  if (state.estimator === est) return;
  state.estimator = est;
  btnEstCentroid.classList.toggle('active', est === 'centroid');
  btnEstMle.classList.toggle('active', est === 'mle');
  recompute();
}
btnEstCentroid.addEventListener('click', () => setEst('centroid'));
btnEstMle.addEventListener('click', () => setEst('mle'));

// ── File input & drag-drop ─────────────────────────────────────────────────
document.getElementById('btn-choose').addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) readFile(file);
  fileInputEl.value = '';
});

['dragenter', 'dragover'].forEach(ev =>
  dropzoneEl.addEventListener(ev, e => { e.preventDefault(); dropzoneEl.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  dropzoneEl.addEventListener(ev, e => { e.preventDefault(); dropzoneEl.classList.remove('dragover'); }));

dropzoneEl.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadCSV(reader.result);
  reader.readAsText(file);
}

// ── Sample CSV download ────────────────────────────────────────────────────
const SAMPLE_CSV =
`group,lat,lon,azimuth,date
A,24.05,120.45,63.4,2026-05-01
A,24.05,120.65,296.6,2026-05-01
A,24.15,120.55,180,2026-05-01
B,23.75,120.30,45,2026-05-01
B,23.75,120.40,315,2026-05-01
C,24.45,121.45,45,2026-05-01
C,24.45,121.55,315,2026-05-01
D,23.30,120.10,90,2026-05-01
D,23.40,120.10,90,2026-05-01
E,24.00,121.00,45,2026-05-01
E,24.00,121.10,315,2026-05-01
E,24.20,121.05,0,2026-05-01
F,23.20,120.50,75,2026-05-01
G,23.00,120.00,,2026-05-01
`;

document.getElementById('btn-sample').addEventListener('click', () => {
  downloadCSV('sample-triangulation.csv', SAMPLE_CSV);
});

// ── Results CSV download ───────────────────────────────────────────────────
// Original columns are preserved in order; tri_lat / tri_long / tri_status are
// appended at the end. If those names already exist in the upload, a numeric
// suffix is used (tri_lat_1, …) so the original columns are kept intact.
// Successful groups fill lat/long on all their rows; status marks each station
// OK / 忽略：無交會 / 無交點：原因 / 資料無效.
function uniqueColumnName(base, taken) {
  if (!taken.has(base.toLowerCase())) { taken.add(base.toLowerCase()); return base; }
  let i = 1;
  while (taken.has(`${base}_${i}`.toLowerCase())) i++;
  const name = `${base}_${i}`;
  taken.add(name.toLowerCase());
  return name;
}

document.getElementById('btn-download').addEventListener('click', () => {
  if (!state.rawRows.length) return;

  // rowIndex → { lat, lon, status }. Status is per row:
  //   group has target, station used    → {group}{n}_ok      (e.g. A1_ok)
  //   group has target, station ignored  → {group}{n}_無交點  (e.g. A3_無交點)
  //   group has no target (no有效交會)    → 無交點
  //   group has invalid data rows         → 資料無效 (whole group)
  const rowInfo = new Map();
  for (const g of state.groups) {
    if (g.dataInvalid) {
      g.stations.forEach(s => rowInfo.set(s._row, { lat: '', lon: '', status: '資料無效' }));
      g.invalidRows.forEach(ri => rowInfo.set(ri, { lat: '', lon: '', status: '資料無效' }));
      continue;
    }
    if (g.singlePoint) {
      g.calcStations.forEach(s => rowInfo.set(s._row, { lat: '', lon: '', status: '僅有1筆定位點' }));
      continue;
    }
    const ignored = new Set(g.ignoredIds || []);
    for (const s of g.calcStations) {
      if (g.result) {
        rowInfo.set(s._row, {
          lat: g.result.target.lat.toFixed(5),
          lon: g.result.target.lon.toFixed(5),
          status: `${g.name}${s.id}_${ignored.has(s.id) ? '無交點' : 'ok'}`,
        });
      } else {
        rowInfo.set(s._row, { lat: '', lon: '', status: '無交點' });
      }
    }
  }

  // Exclude note/notes columns from the output
  const dropIdx = new Set();
  state.rawHeader.forEach((h, i) => {
    const n = h.trim().toLowerCase();
    if (n === 'note' || n === 'notes') dropIdx.add(i);
  });
  const keptHeader = state.rawHeader.filter((_, i) => !dropIdx.has(i));

  const taken = new Set(keptHeader.map(h => h.trim().toLowerCase()));
  const cLat = uniqueColumnName('tri_lat', taken);
  const cLong = uniqueColumnName('tri_long', taken);
  const cStatus = uniqueColumnName('tri_status', taken);

  const gi = state.colIdx.group;
  const header = keptHeader.concat(cLat, cLong, cStatus);
  const lines = [header.map(escapeCSV).join(',')];

  state.rawRows.forEach((r, rowIndex) => {
    const info = rowInfo.get(rowIndex);
    let lat = '', lon = '', status = '';
    if (info) {
      lat = info.lat; lon = info.lon; status = info.status;
    } else if ((r[gi] || '').trim()) {
      status = '資料無效'; // belongs to a group but lat/lon/azimuth unparseable
    }
    const kept = r.filter((_, i) => !dropIdx.has(i));
    lines.push(kept.concat(lat, lon, status).map(escapeCSV).join(','));
  });

  downloadCSV('triangulation-results.csv', lines.join('\r\n') + '\r\n');
});

// ── Clear data ─────────────────────────────────────────────────────────────
document.getElementById('btn-clear-data').addEventListener('click', () => {
  state.groups = [];
  state.rawHeader = [];
  state.rawRows = [];
  state.colIdx = null;
  clearOverlays();
  legendListEl.innerHTML = '';
  legendEmptyEl.hidden = false;
  legendActionsEl.hidden = true;
  downloadSecEl.hidden = true;
  uploadStatusEl.hidden = true;
  hideError();
});

// ── Help toggle ────────────────────────────────────────────────────────────
document.getElementById('help-toggle').addEventListener('click', () => {
  const body = document.getElementById('help-body');
  body.hidden = !body.hidden;
  document.getElementById('help-toggle').textContent =
    body.hidden ? '❓ 使用說明 ▶' : '❓ 使用說明 ▼';
});

function downloadCSV(filename, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escapeCSV(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showError(msg) {
  errorBannerEl.textContent = msg;
  errorBannerEl.hidden = false;
}

function hideError() {
  errorBannerEl.hidden = true;
}
