// 無線電追蹤三角定位工具 — map.js — Leaflet map wrapper

'use strict';

const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
  '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
  '#9c755f', '#bab0ac',
];

const BASE_LAYERS = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }),
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenTopoMap contributors',
    maxZoom: 17,
  }),
  'Esri Imagery': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri', maxZoom: 19 }
  ),
};

let map = null;
let layerControl = null;
let overlayGroup = null;  // holds all drawn features
// groupName -> [Leaflet layers], so clicking any feature can identify its group
let groupLayers = new Map();

/** Register a layer under a group so map clicks can resolve back to it. */
function tagLayer(layer, groupName, infoHtml, onSelect) {
  if (groupName == null) return layer;
  if (!groupLayers.has(groupName)) groupLayers.set(groupName, []);
  groupLayers.get(groupName).push(layer);
  if (infoHtml) layer.bindPopup(infoHtml);
  layer.on('click', () => onSelect && onSelect(groupName));
  return layer;
}

function initMap(containerId) {
  map = L.map(containerId, {
    center: [23.5, 121.0],
    zoom: 8,
    layers: [BASE_LAYERS['OpenStreetMap']],
  });

  layerControl = L.control.layers(BASE_LAYERS, {}, { position: 'topright' }).addTo(map);
  overlayGroup = L.layerGroup().addTo(map);
  return map;
}

/**
 * Color for station index (0-based).
 */
function stationColor(index) {
  return PALETTE[index % PALETTE.length];
}

/**
 * Color for a group index (0-based), for the batch view.
 * Generates well-spread hues via the golden angle; cycles after 100.
 */
function groupColor(index) {
  const i = index % 100;
  const hue = (i * 137.508) % 360;
  const sat = 60 + (i % 3) * 12;   // 60/72/84 %
  const light = 42 + (i % 2) * 8;  // 42/50 %
  return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
}

/**
 * Draw a group's observation station as a small filled dot (no label).
 */
function drawGroupStation(lat, lon, color, groupName, infoHtml, onSelect) {
  const m = L.circleMarker([lat, lon], {
    radius: 6,
    color: '#fff',
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).addTo(overlayGroup);
  return tagLayer(m, groupName, infoHtml, onSelect);
}

/**
 * Clear all drawn overlays (markers, lines, target).
 */
function clearOverlays() {
  overlayGroup.clearLayers();
  groupLayers.clear();
}

/**
 * Draw station marker with label.
 */
function drawStation(lat, lon, label, color) {
  const icon = L.divIcon({
    className: '',
    html: `<div class="station-marker" style="background:${color}">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  L.marker([lat, lon], { icon }).addTo(overlayGroup);
}

/**
 * Draw bearing line from station toward azimuth, given length in km.
 * Adds intermediate points every ~2 km so the polyline approximates a
 * true straight line in lat/lon space, matching the planar intersection
 * calculation even at high zoom levels.
 */
function drawBearingLine(lat, lon, azimuth, lineLength, color, groupName, infoHtml, onSelect) {
  const azRad = azimuth * Math.PI / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const stepKm = 2;
  const n = Math.max(2, Math.ceil(lineLength / stepKm));
  const stepDeg = lineLength / n / 111;
  const points = [];
  for (let i = 0; i <= n; i++) {
    const d = stepDeg * i;
    points.push([lat + d * cosAz, lon + d * sinAz]);
  }
  const line = L.polyline(points, {
    color,
    weight: 2,
    opacity: 0.85,
  }).addTo(overlayGroup);
  tagLayer(line, groupName, infoHtml, onSelect);
  // Wider invisible line underneath makes the thin bearing line easier to click.
  const hit = L.polyline(points, { color, weight: 14, opacity: 0 }).addTo(overlayGroup);
  tagLayer(hit, groupName, infoHtml, onSelect);
  return line;
}

/**
 * Draw estimated target as a cross marker.
 */
function drawTarget(lat, lon, color, groupName, infoHtml, onSelect) {
  const style = color ? ` style="color:${color}"` : '';
  const icon = L.divIcon({
    className: '',
    html: `<div class="target-marker"${style}>✕</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
  const m = L.marker([lat, lon], { icon }).addTo(overlayGroup);
  if (groupName != null) return tagLayer(m, groupName, infoHtml, onSelect);
  m.bindPopup(`目標: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  return m;
}

/**
 * Draw pairwise intersection small dots.
 */
function drawIntersection(lat, lon) {
  L.circleMarker([lat, lon], {
    radius: 4,
    color: '#555',
    fillColor: '#aaa',
    fillOpacity: 0.6,
    weight: 1,
  }).addTo(overlayGroup);
}

/**
 * Fit map view to all visible points.
 */
function fitToPoints(points) {
  if (!points.length) return;
  const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [40, 40] });
}

/**
 * Enable click-to-pick mode; calls callback({lat, lon}) once then disables.
 */
function enablePickMode(callback) {
  map.getContainer().style.cursor = 'crosshair';
  map.once('click', e => {
    map.getContainer().style.cursor = '';
    callback({ lat: e.latlng.lat, lon: e.latlng.lng });
  });
}
