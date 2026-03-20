/**
 * Quick Heat Loss Sketch — app.js
 *
 * A standalone PWA that lets a surveyor sketch a house perimeter and get
 * a fast whole-house heat loss estimate.
 */

'use strict';

// ── U-values (W/m²K) ─────────────────────────────────────────────────────────
const U_WALL = {
  solidBrick:        2.1,
  cavityUninsulated: 1.5,
  cavityPartialFill: 0.5,
  cavityFullFill:    0.28,
  timberFrame:       0.25,
  solidStone:        1.7,
};

const U_LOFT = {
  none:      2.3,
  mm100:     0.35,
  mm200:     0.18,
  mm270plus: 0.13,
};

const U_GLAZING = {
  single:       4.8,
  doubleOld:    2.8,
  doubleArated: 1.4,
  triple:       0.8,
};

const U_FLOOR = {
  solidUninsulated:     0.70,
  suspendedUninsulated: 0.80,
  insulated:            0.20,
};

// Glazing as fraction of gross exposed wall area
const GLAZING_FRACTION = { low: 0.12, medium: 0.18, high: 0.25 };

const PARTY_WALL_FACTOR = 0.1; // residual heat loss through party walls

const DELTA_T = 20;  // °C design temperature difference
const ACH     = 0.75; // air changes per hour (typical UK existing dwelling)
const SNAP    = 0.5;  // snap grid size in metres
const CLOSE_PX = 14; // pixel distance to auto-close polygon

// ── Layer colours ─────────────────────────────────────────────────────────────
const LAYER_COLOURS = {
  original:    '#1a56db',
  extension:   '#059669',
  upper_floor: '#7c3aed',
  reference:   '#9ca3af',
};

// ── Layer helpers ─────────────────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function createLayer(name, kind, level) {
  return { id: generateId(), name, kind, level, visible: true, points: [], closed: false, edges: [] };
}

function getActiveLayer() {
  return state.layers.find(l => l.id === state.activeLayerId) || null;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── App state ─────────────────────────────────────────────────────────────────
// Create the initial default layer
const _initLayer = createLayer('Original footprint', 'original', 0);

const state = {
  // Layers
  layers:        [_initLayer],
  activeLayerId: _initLayer.id,

  // Drawing
  hoverPt:   null, // snapped cursor position while drawing

  // View transform (world coords at canvas top-left in metres)
  scale:  40,   // CSS pixels per metre
  panX:  -2,    // world X at left edge
  panY:  -2,    // world Y at top edge

  // Interaction
  isPanning:       false,
  lastPointer:     null,
  dragIndex:       -1,
  lastPinchDist:   null,
  lastPinchCenter: null,

  // Settings (mirrors defaults in HTML)
  storeys:        2,
  ceilingHeight:  2.4,
  dwellingType:   'semi',
  wallType:       'cavityUninsulated',
  loftInsulation: 'mm270plus',
  glazingType:    'doubleArated',
  glazingAmount:  'medium',
  floorType:      'suspendedUninsulated',
};

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas  = document.getElementById('drawingCanvas');
const ctx     = canvas.getContext('2d');
let   cssW    = 0;
let   cssH    = 0;

function resizeCanvas() {
  const wrapper = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  cssW = wrapper.clientWidth;
  cssH = wrapper.clientHeight;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

// ── Coordinate conversions ────────────────────────────────────────────────────
/**
 * Convert world metres to CSS-pixel position on the canvas.
 */
function w2c(mx, my) {
  return {
    x: (mx - state.panX) * state.scale,
    y: (my - state.panY) * state.scale,
  };
}

/**
 * Convert a client (screen) position to world metres.
 */
function client2world(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left)  / state.scale + state.panX,
    y: (clientY - rect.top)   / state.scale + state.panY,
  };
}

function snap(wx, wy) {
  return {
    x: Math.round(wx / SNAP) * SNAP,
    y: Math.round(wy / SNAP) * SNAP,
  };
}

// ── Edge helpers ──────────────────────────────────────────────────────────────
/**
 * Perpendicular distance from point (px, py) to segment (ax,ay)-(bx,by).
 */
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Returns the index of the edge closest to (clientX, clientY) within a
 * fixed pixel threshold, or -1 if none is close enough.
 */
function getEdgeIndexAtClient(clientX, clientY) {
  const layer = getActiveLayer();
  if (!layer || !layer.closed) return -1;
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const thresholdPx = 12;
  let best = -1, bestDist = thresholdPx;
  const pts = layer.points;
  for (let i = 0; i < pts.length; i++) {
    const a = w2c(pts[i].x, pts[i].y);
    const b = w2c(pts[(i + 1) % pts.length].x, pts[(i + 1) % pts.length].y);
    const d = pointToSegmentDistance(cx, cy, a.x, a.y, b.x, b.y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Auto-assign party walls based on dwelling type.
 * Longest edge(s) are made party walls for semi/end-terrace/mid-terrace.
 */
function applyDefaultExposure(layer) {
  if (!layer || layer.edges.length === 0) return;
  layer.edges.forEach(e => { e.isPartyWall = false; });

  const type = state.dwellingType;
  if (type === 'detached') return;

  const pts = layer.points;
  const sorted = layer.edges
    .map((e, i) => {
      const next = pts[(i + 1) % pts.length];
      return { i, length: Math.hypot(next.x - pts[i].x, next.y - pts[i].y) };
    })
    .sort((a, b) => b.length - a.length);

  if (type === 'semi' || type === 'endTerrace') {
    layer.edges[sorted[0].i].isPartyWall = true;
  } else if (type === 'midTerrace') {
    layer.edges[sorted[0].i].isPartyWall = true;
    if (sorted.length > 1) layer.edges[sorted[1].i].isPartyWall = true;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, cssW, cssH);
  drawGrid();

  // Render inactive visible layers first (behind active layer)
  state.layers.forEach(layer => {
    if (!layer.visible || layer.id === state.activeLayerId) return;
    drawLayerPolygon(layer, false);
    drawLayerVertices(layer, false);
  });

  // Render active layer on top
  const active = getActiveLayer();
  if (active) {
    if (active.visible) {
      drawLayerPolygon(active, true);
      drawLayerVertices(active, true);
    }
    drawCursorSnap();
    drawEdgeLengths(active);
  }

  drawScaleBar();
}

function drawGrid() {
  const minX = state.panX;
  const minY = state.panY;
  const maxX = minX + cssW / state.scale;
  const maxY = minY + cssH / state.scale;

  // Minor grid (every 1 m)
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth   = 0.5;
  ctx.beginPath();
  for (let x = Math.floor(minX); x <= maxX; x++) {
    const px = (x - state.panX) * state.scale;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, cssH);
  }
  for (let y = Math.floor(minY); y <= maxY; y++) {
    const py = (y - state.panY) * state.scale;
    ctx.moveTo(0, py);
    ctx.lineTo(cssW, py);
  }
  ctx.stroke();

  // Major grid (every 5 m)
  ctx.strokeStyle = '#cbd5e0';
  ctx.lineWidth   = 0.8;
  ctx.beginPath();
  const x0 = Math.floor(minX / 5) * 5;
  const y0 = Math.floor(minY / 5) * 5;
  for (let x = x0; x <= maxX; x += 5) {
    const px = (x - state.panX) * state.scale;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, cssH);
  }
  for (let y = y0; y <= maxY; y += 5) {
    const py = (y - state.panY) * state.scale;
    ctx.moveTo(0, py);
    ctx.lineTo(cssW, py);
  }
  ctx.stroke();

  // Axis labels
  ctx.fillStyle   = '#9ca3af';
  ctx.font        = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';

  ctx.textAlign = 'center';
  for (let x = x0; x <= maxX; x += 5) {
    if (x === 0) continue;
    const px = (x - state.panX) * state.scale;
    if (px > 30 && px < cssW - 10) ctx.fillText(x + ' m', px, 4);
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let y = y0; y <= maxY; y += 5) {
    if (y === 0) continue;
    const py = (y - state.panY) * state.scale;
    if (py > 14 && py < cssH - 10) ctx.fillText(y + ' m', 28, py);
  }

  // Origin marker
  const ox = (0 - state.panX) * state.scale;
  const oy = (0 - state.panY) * state.scale;
  if (ox >= -1 && ox <= cssW + 1 && oy >= -1 && oy <= cssH + 1) {
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(ox - 7, oy); ctx.lineTo(ox + 7, oy);
    ctx.moveTo(ox, oy - 7); ctx.lineTo(ox, oy + 7);
    ctx.stroke();
  }
}

function drawLayerPolygon(layer, isActive) {
  const pts = layer.points;
  if (pts.length < 2) return;

  const baseColour  = LAYER_COLOURS[layer.kind] || '#1a56db';
  const isRef       = layer.kind === 'reference';
  const strokeAlpha = isActive ? 1 : 0.3;
  const fillAlpha   = isActive ? (isRef ? 0.04 : 0.10) : 0.04;

  if (layer.closed) {
    // Fill
    ctx.beginPath();
    const s = w2c(pts[0].x, pts[0].y);
    ctx.moveTo(s.x, s.y);
    for (let i = 1; i < pts.length; i++) {
      const p = w2c(pts[i].x, pts[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = hexToRgba(baseColour, fillAlpha);
    ctx.fill();

    // Edges
    for (let i = 0; i < pts.length; i++) {
      const a = w2c(pts[i].x, pts[i].y);
      const b = w2c(pts[(i + 1) % pts.length].x, pts[(i + 1) % pts.length].y);
      const isParty = layer.edges[i] && layer.edges[i].isPartyWall;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (isRef) {
        ctx.strokeStyle = hexToRgba(baseColour, strokeAlpha * 0.7);
        ctx.setLineDash([8, 5]);
      } else if (isParty) {
        ctx.strokeStyle = `rgba(136,136,136,${strokeAlpha})`;
        ctx.setLineDash([6, 4]);
      } else {
        ctx.strokeStyle = hexToRgba(baseColour, strokeAlpha);
        ctx.setLineDash([]);
      }
      ctx.lineWidth = isActive ? 2.5 : 1.5;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  } else if (isActive) {
    // Open polygon preview (only for active layer)
    ctx.beginPath();
    const s0 = w2c(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = w2c(pts[i].x, pts[i].y);
      ctx.lineTo(p.x, p.y);
    }
    if (state.hoverPt) {
      const hp = w2c(state.hoverPt.x, state.hoverPt.y);
      ctx.lineTo(hp.x, hp.y);
    }
    ctx.strokeStyle = baseColour;
    ctx.lineWidth   = 2;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawLayerVertices(layer, isActive) {
  if (!isActive) return; // Only show handles for the active layer
  const baseColour = LAYER_COLOURS[layer.kind] || '#1a56db';
  layer.points.forEach((pt, i) => {
    const cp = w2c(pt.x, pt.y);
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
    if (i === 0 && !layer.closed) {
      ctx.fillStyle   = '#10b981';
      ctx.strokeStyle = '#ffffff';
    } else {
      ctx.fillStyle   = baseColour;
      ctx.strokeStyle = '#ffffff';
    }
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

function drawCursorSnap() {
  if (!state.hoverPt) return;
  const cp = w2c(state.hoverPt.x, state.hoverPt.y);

  // Snap dot
  ctx.beginPath();
  ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(26, 86, 219, 0.35)';
  ctx.fill();

  // Coordinate label
  const label = `${state.hoverPt.x.toFixed(1)}, ${state.hoverPt.y.toFixed(1)} m`;
  ctx.font        = '11px system-ui, sans-serif';
  ctx.textAlign   = 'left';
  ctx.textBaseline = 'alphabetic';
  const tw = ctx.measureText(label).width;

  // Keep label inside canvas
  let lx = cp.x + 12;
  let ly = cp.y - 8;
  if (lx + tw > cssW - 6) lx = cp.x - tw - 12;
  if (ly < 14) ly = cp.y + 18;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(lx - 2, ly - 11, tw + 4, 14);
  ctx.fillStyle = '#1e293b';
  ctx.fillText(label, lx, ly);
}

function drawEdgeLengths(layer) {
  if (!layer || !layer.closed || layer.points.length < 2) return;
  const pts = layer.points;

  ctx.font        = '11px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.4) continue; // skip tiny edges

    const ca = w2c(a.x, a.y);
    const cb = w2c(b.x, b.y);
    const mx = (ca.x + cb.x) / 2;
    const my = (ca.y + cb.y) / 2;

    let angle = Math.atan2(cb.y - ca.y, cb.x - ca.x);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);

    const text = len.toFixed(1) + ' m';
    const tw   = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillRect(-tw / 2 - 3, -14, tw + 6, 14);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#475569';
    ctx.fillText(text, 0, -2);
    ctx.restore();
  }
}

function drawScaleBar() {
  const barM  = 5;
  const barPx = barM * state.scale;
  if (barPx < 30 || barPx > cssW * 0.4) return;

  const x = cssW - barPx - 18;
  const y = cssH - 16;

  ctx.strokeStyle = '#374151';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + barPx, y);
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
  ctx.moveTo(x + barPx, y - 5); ctx.lineTo(x + barPx, y + 5);
  ctx.stroke();

  ctx.fillStyle  = '#374151';
  ctx.font       = '11px system-ui, sans-serif';
  ctx.textAlign  = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('5 m', x + barPx / 2, y - 8);
}

// ── Pointer utilities ──────────────────────────────────────────────────────────
function clientPos(e) {
  return e.touches
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
    : { x: e.clientX, y: e.clientY };
}

function pinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}

function pinchCenter(e) {
  return {
    x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
    y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
  };
}

function pixelDistToPoint(clientX, clientY, ptIndex) {
  const layer = getActiveLayer();
  if (!layer) return Infinity;
  const rect = canvas.getBoundingClientRect();
  const cp   = w2c(layer.points[ptIndex].x, layer.points[ptIndex].y);
  return Math.hypot(clientX - rect.left - cp.x, clientY - rect.top - cp.y);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function zoomAt(clientX, clientY, factor) {
  const rect = canvas.getBoundingClientRect();
  const cx   = clientX - rect.left;
  const cy   = clientY - rect.top;

  // World point under cursor before zoom
  const wx = cx / state.scale + state.panX;
  const wy = cy / state.scale + state.panY;

  state.scale = Math.min(200, Math.max(6, state.scale * factor));

  // Adjust pan so same world point remains under cursor
  state.panX = wx - cx / state.scale;
  state.panY = wy - cy / state.scale;

  render();
}

// ── Pointer event handlers ────────────────────────────────────────────────────
function onPointerDown(e) {
  const pos   = clientPos(e);
  const layer = getActiveLayer();

  // Pan: middle-mouse or Alt+drag
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    state.isPanning   = true;
    state.lastPointer = pos;
    e.preventDefault();
    return;
  }

  if (layer && layer.closed) {
    // Drag existing vertex?
    for (let i = 0; i < layer.points.length; i++) {
      if (pixelDistToPoint(pos.x, pos.y, i) < 14) {
        state.dragIndex = i;
        return;
      }
    }
    // Toggle party wall on edge click
    const edgeIdx = getEdgeIndexAtClient(pos.x, pos.y);
    if (edgeIdx >= 0) {
      layer.edges[edgeIdx].isPartyWall = !layer.edges[edgeIdx].isPartyWall;
      updateResults();
      render();
    }
    return;
  }

  if (!layer) return;

  const wp      = client2world(pos.x, pos.y);
  const snapped = snap(wp.x, wp.y);

  // Auto-close if clicking near the first vertex (and >= 3 points exist)
  if (layer.points.length >= 3 && pixelDistToPoint(pos.x, pos.y, 0) < CLOSE_PX) {
    closePolygon();
    return;
  }

  layer.points.push(snapped);
  updateButtons();
  updateHint();
  render();
}

function onPointerMove(e) {
  const pos   = clientPos(e);
  const layer = getActiveLayer();

  if (state.isPanning) {
    const dx = (pos.x - state.lastPointer.x) / state.scale;
    const dy = (pos.y - state.lastPointer.y) / state.scale;
    state.panX -= dx;
    state.panY -= dy;
    state.lastPointer = pos;
    render();
    return;
  }

  if (state.dragIndex >= 0 && layer) {
    const wp  = client2world(pos.x, pos.y);
    layer.points[state.dragIndex] = snap(wp.x, wp.y);
    updateResults();
    render();
    return;
  }

  if (layer && !layer.closed) {
    const wp  = client2world(pos.x, pos.y);
    state.hoverPt = snap(wp.x, wp.y);
    render();
  }
}

function onPointerUp() {
  state.isPanning = false;
  if (state.dragIndex >= 0) {
    state.dragIndex = -1;
    updateResults();
    render();
  }
}

// Touch events
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (e.touches.length === 1) {
    onPointerDown(e);
  } else if (e.touches.length === 2) {
    state.isPanning      = false;
    state.lastPinchDist  = pinchDist(e);
    state.lastPinchCenter = pinchCenter(e);
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();

  if (e.touches.length === 2) {
    const dist   = pinchDist(e);
    const center = pinchCenter(e);
    const rect   = canvas.getBoundingClientRect();

    if (state.lastPinchDist && state.lastPinchCenter) {
      const ratio = dist / state.lastPinchDist;
      const lc    = state.lastPinchCenter;

      // World point under the OLD pinch centre
      const wx = (lc.x - rect.left) / state.scale + state.panX;
      const wy = (lc.y - rect.top)  / state.scale + state.panY;

      state.scale = Math.min(200, Math.max(6, state.scale * ratio));

      // Pan so the world point now sits under the NEW pinch centre
      state.panX = wx - (center.x - rect.left) / state.scale;
      state.panY = wy - (center.y - rect.top)  / state.scale;
    }

    state.lastPinchDist   = dist;
    state.lastPinchCenter = center;
    render();
    return;
  }

  onPointerMove(e);
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  onPointerUp();
  state.lastPinchDist   = null;
  state.lastPinchCenter = null;
}, { passive: false });

// Mouse events
canvas.addEventListener('mousedown',  onPointerDown);
canvas.addEventListener('mousemove',  onPointerMove);
canvas.addEventListener('mouseup',    onPointerUp);
canvas.addEventListener('mouseleave', () => {
  state.hoverPt = null;
  const active = getActiveLayer();
  if (!active || !active.closed) render();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

// Right-click = undo
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  undoLastPoint();
});

// ── Polygon operations ────────────────────────────────────────────────────────
function closePolygon() {
  const layer = getActiveLayer();
  if (!layer || layer.points.length < 3) return;
  layer.edges  = layer.points.map(() => ({ isPartyWall: false }));
  applyDefaultExposure(layer);
  layer.closed  = true;
  state.hoverPt = null;
  updateButtons();
  updateHint();
  updateResults();
  renderLayerPanel();
  render();
}

function undoLastPoint() {
  const layer = getActiveLayer();
  if (!layer) return;
  if (layer.closed) {
    layer.closed = false;
    layer.edges  = [];
    updateResults();
  } else if (layer.points.length > 0) {
    layer.points.pop();
  }
  updateButtons();
  updateHint();
  renderLayerPanel();
  render();
}

function clearAll() {
  const layer = getActiveLayer();
  if (layer) {
    layer.points  = [];
    layer.closed  = false;
    layer.edges   = [];
  }
  state.hoverPt   = null;
  state.dragIndex = -1;
  updateButtons();
  updateHint();
  clearResults();
  renderLayerPanel();
  render();
}

function fitToView() {
  const allPts = state.layers.filter(l => l.visible).flatMap(l => l.points);
  if (allPts.length === 0) {
    state.scale = 40; state.panX = -2; state.panY = -2;
    render(); return;
  }
  const xs   = allPts.map(p => p.x);
  const ys   = allPts.map(p => p.y);
  const minX = Math.min(...xs) - 2;
  const maxX = Math.max(...xs) + 2;
  const minY = Math.min(...ys) - 2;
  const maxY = Math.max(...ys) + 2;
  const scX  = cssW / (maxX - minX);
  const scY  = cssH / (maxY - minY);
  state.scale = Math.min(scX, scY, 100);
  state.panX  = minX;
  state.panY  = minY;
  render();
}

// ── Heat loss calculation ─────────────────────────────────────────────────────
function polygonArea(pts) {
  // Shoelace / Gauss's area formula
  let area = 0;
  const n  = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function polygonPerimeter(pts) {
  let perim = 0;
  const n   = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    perim += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return perim;
}

function r(v, dp) {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}

function calculateHeatLoss() {
  const layer = getActiveLayer();
  if (!layer || !layer.closed || layer.kind === 'reference' || layer.points.length < 3) return null;

  const pts         = layer.points;
  const floorArea   = polygonArea(pts);
  const perimeter   = polygonPerimeter(pts);
  const totalHeight = state.storeys * state.ceilingHeight;
  const volume      = floorArea * totalHeight;

  // Compute exposed and party perimeters from edge flags
  let exposedPerimeter = 0;
  let partyPerimeter   = 0;
  layer.edges.forEach((edge, i) => {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (edge.isPartyWall) {
      partyPerimeter += len;
    } else {
      exposedPerimeter += len;
    }
  });

  const grossWallArea  = exposedPerimeter * totalHeight;
  const glazingFrac    = GLAZING_FRACTION[state.glazingAmount];
  const glazingArea    = grossWallArea * glazingFrac;
  const netWallArea    = grossWallArea - glazingArea;
  const roofArea       = floorArea; // top storey ceiling only

  const uWall    = U_WALL[state.wallType];
  const uLoft    = U_LOFT[state.loftInsulation];
  const uGlazing = U_GLAZING[state.glazingType];
  const uFloor   = U_FLOOR[state.floorType];

  // Exposed wall + small residual through party walls
  const partyWallArea = partyPerimeter * totalHeight;
  const wallHL    = (netWallArea * uWall + partyWallArea * uWall * PARTY_WALL_FACTOR) * DELTA_T;
  const glazingHL = glazingArea * uGlazing * DELTA_T;
  const roofHL    = roofArea    * uLoft    * DELTA_T;
  const floorHL   = floorArea   * uFloor   * DELTA_T;
  const ventHL    = volume * ACH * 0.33 * DELTA_T;   // 0.33 Wh/m³K · s/h conversion
  const totalHL   = wallHL + glazingHL + roofHL + floorHL + ventHL;

  return {
    floorArea:   r(floorArea,   1),
    perimeter:   r(perimeter,   1),
    netWallArea: r(netWallArea, 1),
    glazingArea: r(glazingArea, 1),
    roofArea:    r(roofArea,    1),
    volume:      r(volume,      0),
    wallHL:      r(wallHL    / 1000, 2),
    glazingHL:   r(glazingHL / 1000, 2),
    roofHL:      r(roofHL    / 1000, 2),
    floorHL:     r(floorHL   / 1000, 2),
    ventHL:      r(ventHL    / 1000, 2),
    totalHL:     r(totalHL   / 1000, 1),
  };
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function updateButtons() {
  const layer = getActiveLayer();
  document.getElementById('undoBtn').disabled       = !layer || layer.points.length === 0;
  document.getElementById('closeShapeBtn').disabled = !layer || layer.points.length < 3 || layer.closed;
}

function updateHint() {
  const hint  = document.getElementById('canvasHint');
  const layer = getActiveLayer();
  if (!layer) {
    hint.textContent = 'Select or create a layer to start drawing';
    hint.classList.remove('hidden');
    return;
  }
  if (layer.closed) {
    hint.textContent = 'Click or tap walls to mark as party walls · Drag corners to adjust';
  } else if (layer.points.length === 0) {
    hint.textContent = 'Click to place first corner point';
  } else if (layer.points.length < 3) {
    hint.textContent = `${layer.points.length} point${layer.points.length > 1 ? 's' : ''} — keep clicking to add corners`;
  } else {
    hint.textContent = 'Click the green point to close, or press Close Shape';
  }
  hint.classList.remove('hidden');
}

function updateResults() {
  const res = calculateHeatLoss();
  if (!res) { clearResults(); return; }

  document.getElementById('resultsPlaceholder').hidden = true;
  document.getElementById('resultsContent').hidden     = false;

  document.getElementById('resFloorArea').textContent  = res.floorArea;
  document.getElementById('resPerimeter').textContent  = res.perimeter;
  document.getElementById('resWallArea').textContent   = res.netWallArea;
  document.getElementById('resGlazingArea').textContent = res.glazingArea;
  document.getElementById('resRoofArea').textContent   = res.roofArea;
  document.getElementById('resVolume').textContent     = res.volume;
  document.getElementById('resHeatLoss').textContent   = res.totalHL;
  document.getElementById('resWallHL').textContent     = res.wallHL;
  document.getElementById('resGlazingHL').textContent  = res.glazingHL;
  document.getElementById('resRoofHL').textContent     = res.roofHL;
  document.getElementById('resFloorHL').textContent    = res.floorHL;
  document.getElementById('resVentHL').textContent     = res.ventHL;
}

function clearResults() {
  document.getElementById('resultsPlaceholder').hidden = false;
  document.getElementById('resultsContent').hidden     = true;
}

// ── Layer management ──────────────────────────────────────────────────────────

function addLayer() {
  const count    = state.layers.length + 1;
  const newLayer = createLayer(`Layer ${count}`, 'original', 0);
  state.layers.push(newLayer);
  selectLayer(newLayer.id);
}

function selectLayer(id) {
  state.activeLayerId = id;
  state.hoverPt       = null;
  state.dragIndex     = -1;
  updateButtons();
  updateHint();
  updateResults();
  renderLayerPanel();
  render();
}

function removeLayer(id) {
  if (state.layers.length <= 1) return;
  const idx = state.layers.findIndex(l => l.id === id);
  if (idx < 0) return;
  state.layers.splice(idx, 1);
  if (state.activeLayerId === id) {
    state.activeLayerId = state.layers[Math.max(0, idx - 1)].id;
  }
  updateButtons();
  updateHint();
  updateResults();
  renderLayerPanel();
  render();
}

function renameLayer(id, name) {
  const layer = state.layers.find(l => l.id === id);
  if (layer) { layer.name = name.trim() || layer.name; }
}

function setLayerKind(id, kind) {
  const layer = state.layers.find(l => l.id === id);
  if (layer) {
    layer.kind = kind;
    updateResults();
    renderLayerPanel();
    render();
  }
}

function setLayerLevel(id, level) {
  const layer = state.layers.find(l => l.id === id);
  if (layer) {
    layer.level = parseInt(level, 10) || 0;
    renderLayerPanel();
  }
}

function toggleLayerVisibility(id) {
  const layer = state.layers.find(l => l.id === id);
  if (layer) {
    layer.visible = !layer.visible;
    renderLayerPanel();
    render();
  }
}

// ── Layer panel rendering ─────────────────────────────────────────────────────

function renderLayerPanel() {
  const list = document.getElementById('layerList');
  if (!list) return;

  list.innerHTML = '';
  state.layers.forEach(layer => {
    const isActive = layer.id === state.activeLayerId;
    const item = document.createElement('div');
    item.className = 'layer-item' + (isActive ? ' layer-item--active' : '');
    item.setAttribute('role', 'listitem');

    // Visibility toggle
    const visBtn = document.createElement('button');
    visBtn.className = 'layer-vis-btn';
    visBtn.setAttribute('aria-label', layer.visible ? 'Hide layer' : 'Show layer');
    visBtn.title     = layer.visible ? 'Hide layer' : 'Show layer';
    visBtn.textContent = layer.visible ? '●' : '○';
    visBtn.addEventListener('click', e => { e.stopPropagation(); toggleLayerVisibility(layer.id); });

    // Info area
    const info = document.createElement('div');
    info.className = 'layer-info';

    const nameEl = document.createElement('span');
    nameEl.className   = 'layer-name';
    nameEl.textContent = layer.name;

    const badges = document.createElement('div');
    badges.className = 'layer-badges';

    const kindBadge = document.createElement('span');
    kindBadge.className   = `layer-badge layer-badge--${layer.kind}`;
    kindBadge.textContent = layer.kind.replaceAll('_', '\u202F');

    const levelBadge = document.createElement('span');
    levelBadge.className   = 'layer-badge layer-badge--level';
    levelBadge.textContent = 'L' + layer.level;

    badges.appendChild(kindBadge);
    badges.appendChild(levelBadge);
    info.appendChild(nameEl);
    info.appendChild(badges);

    item.appendChild(visBtn);
    item.appendChild(info);
    item.addEventListener('click', () => selectLayer(layer.id));
    list.appendChild(item);
  });

  // Populate edit panel for active layer
  const active    = getActiveLayer();
  const editPanel = document.getElementById('layerEditPanel');
  if (!editPanel) return;

  if (active) {
    editPanel.hidden = false;
    const nameInput  = document.getElementById('layerNameInput');
    const kindSelect = document.getElementById('layerKindSelect');
    const levelInput = document.getElementById('layerLevelInput');
    const removeBtn  = document.getElementById('removeLayerBtn');

    if (nameInput)  nameInput.value  = active.name;
    if (kindSelect) kindSelect.value = active.kind;
    if (levelInput) levelInput.value = active.level;
    if (removeBtn)  removeBtn.disabled = state.layers.length <= 1;
  } else {
    editPanel.hidden = true;
  }
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
document.getElementById('undoBtn').addEventListener('click', undoLastPoint);
document.getElementById('closeShapeBtn').addEventListener('click', closePolygon);
document.getElementById('clearBtn').addEventListener('click', clearAll);
document.getElementById('zoomInBtn').addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2);
});
document.getElementById('zoomOutBtn').addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2);
});
document.getElementById('zoomFitBtn').addEventListener('click', fitToView);

// Help overlay
document.getElementById('helpBtn').addEventListener('click', () => {
  document.getElementById('helpOverlay').hidden = false;
});
document.getElementById('helpCloseBtn').addEventListener('click', () => {
  document.getElementById('helpOverlay').hidden = true;
});
document.getElementById('helpOverlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});

// Keyboard
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undoLastPoint();
  }
  if (e.key === 'Escape') {
    document.getElementById('helpOverlay').hidden = true;
  }
});

// ── Setting controls ──────────────────────────────────────────────────────────
function wireChoiceGroup(groupId, stateKey, transform, postChange) {
  document.querySelectorAll(`#${groupId} .choice-btn`).forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll(`#${groupId} .choice-btn`)
        .forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      state[stateKey] = transform ? transform(this.dataset.value) : this.dataset.value;
      if (postChange) postChange();
    });
  });
}

wireChoiceGroup('storeysGroup',       'storeys',       v => parseInt(v, 10), updateResults);
wireChoiceGroup('glazingAmountGroup', 'glazingAmount', null,                 updateResults);

document.getElementById('ceilingHeight').addEventListener('input', function () {
  const v = parseFloat(this.value);
  if (v >= 2.0 && v <= 4.0) { state.ceilingHeight = v; updateResults(); }
});

['wallType', 'loftInsulation', 'glazingType', 'floorType']
  .forEach(id => {
    document.getElementById(id).addEventListener('change', function () {
      state[id] = this.value;
      updateResults();
    });
  });

document.getElementById('dwellingType').addEventListener('change', function () {
  state.dwellingType = this.value;
  const layer = getActiveLayer();
  if (layer && layer.closed && layer.edges.length > 0) {
    applyDefaultExposure(layer);
    render();
  }
  updateResults();
});

// ── Layer panel events ────────────────────────────────────────────────────────
document.getElementById('addLayerBtn').addEventListener('click', addLayer);

document.getElementById('removeLayerBtn').addEventListener('click', () => {
  const active = getActiveLayer();
  if (active) removeLayer(active.id);
});

document.getElementById('layerNameInput').addEventListener('input', function () {
  const active = getActiveLayer();
  if (active) { renameLayer(active.id, this.value); renderLayerPanel(); }
});

document.getElementById('layerKindSelect').addEventListener('change', function () {
  const active = getActiveLayer();
  if (active) setLayerKind(active.id, this.value);
});

document.getElementById('layerLevelInput').addEventListener('change', function () {
  const active = getActiveLayer();
  if (active) setLayerLevel(active.id, this.value);
});

// ── Initialise ────────────────────────────────────────────────────────────────
const resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(canvas.parentElement);

updateHint();
updateButtons();
renderLayerPanel();

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Service worker registration is best-effort
    });
  });
}
