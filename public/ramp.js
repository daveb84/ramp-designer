'use strict';

const heightInput = document.getElementById('height');
const radiusInput = document.getElementById('radius');
const angleOut = document.getElementById('angle-out');
const arcOut = document.getElementById('arc-out');
const lengthOut = document.getElementById('length-out');
const vertStat = document.getElementById('vert-stat');
const vertOut = document.getElementById('vert-out');
const errorOut = document.getElementById('error');
const canvas = document.getElementById('ramp-canvas');
const ctx = canvas.getContext('2d');

const COLOURS = {
  ground: '#6b5e4b',
  rampFill: '#e8c48f',
  rampEdge: '#7a4f1d',
  surface: '#3b2a14',
  coping: '#9aa3ad',
  copingEdge: '#4b5563',
  construction: '#2563eb',
  angle: '#c2410c',
  dimension: '#1f2328',
};

/**
 * Side-profile geometry of a quarter pipe whose transition starts flat on the ground at x = 0
 * and curves up to the right. All values are in cm with y pointing up, whatever unit is displayed.
 * When the height exceeds the radius, the transition reaches vertical at y = r and continues
 * straight up as vert.
 */
function computeGeometry(height, radius) {
  const reachesVert = height >= radius;
  const angleRad = reachesVert ? Math.PI / 2 : Math.acos((radius - height) / radius);
  const groundLength = radius * Math.sin(angleRad);
  return {
    height,
    radius,
    angleRad,
    angleDeg: angleRad * 180 / Math.PI,
    groundLength,
    surfaceLength: radius * angleRad + (reachesVert ? height - radius : 0),
    vertHeight: reachesVert ? height - radius : 0,
    transitionTop: { x: groundLength, y: radius * (1 - Math.cos(angleRad)) },
    centre: { x: 0, y: radius },
  };
}

const UNITS = {
  cm: { cmPerUnit: 1, decimals: 1 },
  ft: { cmPerUnit: 30.48, decimals: 2 },
};

let currentUnit = 'cm';

function formatLength(cm) {
  const unit = UNITS[currentUnit];
  return `${(cm / unit.cmPerUnit).toFixed(unit.decimals)} ${currentUnit}`;
}

/** Returns the entered height and radius converted to cm. */
function readInputs() {
  const height = Number(heightInput.value);
  const radius = Number(radiusInput.value);
  if (!(height > 0) || !(radius > 0)) {
    return { error: 'Height and radius must both be positive numbers.' };
  }
  const { cmPerUnit } = UNITS[currentUnit];
  return { height: height * cmPerUnit, radius: radius * cmPerUnit };
}

/** Converts the entered values into the new unit so the ramp keeps its size. */
function changeUnit(newUnit) {
  const fromCmPerUnit = UNITS[currentUnit].cmPerUnit;
  const to = UNITS[newUnit];
  for (const input of [heightInput, radiusInput]) {
    const value = Number(input.value);
    if (input.value !== '' && Number.isFinite(value)) {
      input.value = Number((value * fromCmPerUnit / to.cmPerUnit).toFixed(to.decimals));
    }
  }
  currentUnit = newUnit;
  document.querySelectorAll('.unit-name').forEach((el) => { el.textContent = newUnit; });
  update();
}

function update() {
  const inputs = readInputs();
  if (inputs.error) {
    errorOut.textContent = inputs.error;
    errorOut.hidden = false;
    angleOut.textContent = '–';
    arcOut.textContent = '–';
    lengthOut.textContent = '–';
    vertStat.hidden = true;
    clearCanvas();
    return;
  }
  errorOut.hidden = true;

  const geo = computeGeometry(inputs.height, inputs.radius);
  angleOut.textContent = `${geo.angleDeg.toFixed(1)}°`;
  arcOut.textContent = formatLength(geo.surfaceLength);
  lengthOut.textContent = formatLength(geo.groundLength);
  vertStat.hidden = geo.vertHeight === 0;
  vertOut.textContent = formatLength(geo.vertHeight);

  draw(geo);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function clearCanvas() {
  const { width, height } = resizeCanvas();
  ctx.clearRect(0, 0, width, height);
}

function draw(geo) {
  const view = resizeCanvas();
  ctx.clearRect(0, 0, view.width, view.height);

  const { height, radius, groundLength, angleRad, centre } = geo;
  const size = Math.max(height, radius);
  const tangentLength = size * 0.3;
  const dimOffset = size * 0.12;

  // World-space bounds of everything drawn, so the diagram always fits the canvas.
  const bounds = {
    minX: -size * 0.15,
    maxX: groundLength + dimOffset * 2,
    minY: -dimOffset * 1.6,
    maxY: Math.max(height, radius) + size * 0.08,
  };

  const padding = 48;
  const scale = Math.min(
    (view.width - padding * 2) / (bounds.maxX - bounds.minX),
    (view.height - padding * 2) / (bounds.maxY - bounds.minY),
  );
  const offsetX = (view.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale;
  const offsetY = (view.height + (bounds.maxY - bounds.minY) * scale) / 2 + bounds.minY * scale;

  const px = (x, y) => ({ x: offsetX + x * scale, y: offsetY - y * scale });
  const moveTo = (x, y) => { const p = px(x, y); ctx.moveTo(p.x, p.y); };
  const lineTo = (x, y) => { const p = px(x, y); ctx.lineTo(p.x, p.y); };

  // Canvas y is flipped, so a counter-clockwise world arc from the bottom of the circle
  // (world angle -90°) maps to canvas angles running from +90° towards 0.
  const arcAroundCentre = (fromRad, toRad) => {
    const c = px(centre.x, centre.y);
    ctx.arc(c.x, c.y, radius * scale, Math.PI / 2 - fromRad, Math.PI / 2 - toRad, true);
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Ground
  ctx.strokeStyle = COLOURS.ground;
  ctx.lineWidth = 2;
  ctx.beginPath();
  moveTo(bounds.minX, 0);
  lineTo(bounds.maxX, 0);
  ctx.stroke();

  // Ramp body
  ctx.beginPath();
  moveTo(0, 0);
  arcAroundCentre(0, angleRad);
  lineTo(groundLength, height);
  lineTo(groundLength, 0);
  ctx.closePath();
  ctx.fillStyle = COLOURS.rampFill;
  ctx.fill();
  ctx.strokeStyle = COLOURS.rampEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Riding surface
  ctx.beginPath();
  moveTo(0, 0);
  arcAroundCentre(0, angleRad);
  lineTo(groundLength, height);
  ctx.strokeStyle = COLOURS.surface;
  ctx.lineWidth = 3.5;
  ctx.stroke();

  // Coping
  const copingPx = Math.max(4, 3 * scale);
  const lip = px(groundLength, height);
  ctx.beginPath();
  ctx.arc(lip.x + copingPx * 0.4, lip.y - copingPx * 0.6, copingPx, 0, Math.PI * 2);
  ctx.fillStyle = COLOURS.coping;
  ctx.fill();
  ctx.strokeStyle = COLOURS.copingEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawRadius(geo, px, arcAroundCentre);
  drawAngle(geo, px, tangentLength);
  drawHeightDimension(geo, px, dimOffset);
  drawLengthDimension(geo, px, dimOffset);
}

function drawRadius({ radius, transitionTop, centre }, px, arcAroundCentre) {
  ctx.save();
  ctx.strokeStyle = COLOURS.construction;
  ctx.fillStyle = COLOURS.construction;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);

  // Full quarter of the transition circle, to show where the radius continues
  ctx.beginPath();
  arcAroundCentre(0, Math.PI / 2);
  ctx.stroke();

  // Radius line from the centre to the top of the transition
  const c = px(centre.x, centre.y);
  const t = px(transitionTop.x, transitionTop.y);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(t.x, t.y);
  ctx.stroke();

  // And down to the start of the transition
  const start = px(0, 0);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(start.x, start.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
  ctx.fill();

  const mid = { x: (c.x + t.x) / 2, y: (c.y + t.y) / 2 };
  drawLabel(`R = ${formatLength(radius)}`, mid.x + 8, mid.y - 8, COLOURS.construction, 'left');
  ctx.restore();
}

function drawAngle({ angleRad, angleDeg, transitionTop }, px, tangentLength) {
  const t = px(transitionTop.x, transitionTop.y);
  const scale = px(1, 0).x - px(0, 0).x;
  const lengthPx = tangentLength * scale;

  ctx.save();
  ctx.strokeStyle = COLOURS.angle;
  ctx.fillStyle = COLOURS.angle;
  ctx.lineWidth = 1.5;

  // Horizontal reference, extending the deck level out over the transition
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(t.x, t.y);
  ctx.lineTo(t.x - lengthPx, t.y);
  ctx.stroke();

  // Tangent to the transition at its top, running down along the ramp
  ctx.beginPath();
  ctx.moveTo(t.x, t.y);
  ctx.lineTo(t.x - Math.cos(angleRad) * lengthPx, t.y + Math.sin(angleRad) * lengthPx);
  ctx.stroke();
  ctx.setLineDash([]);

  // Angle arc between the horizontal and the tangent
  const arcPx = Math.min(lengthPx * 0.55, 70);
  ctx.beginPath();
  ctx.arc(t.x, t.y, arcPx, Math.PI - angleRad, Math.PI);
  ctx.stroke();

  const labelAngle = Math.PI - angleRad / 2;
  drawLabel(
    `${angleDeg.toFixed(1)}°`,
    t.x + Math.cos(labelAngle) * (arcPx + 10),
    t.y + Math.sin(labelAngle) * (arcPx + 10),
    COLOURS.angle,
    'right',
    true,
  );
  ctx.restore();
}

function drawHeightDimension({ height, groundLength }, px, dimOffset) {
  const x = groundLength + dimOffset;
  const bottom = px(x, 0);
  const top = px(x, height);
  const wallTop = px(groundLength, height);
  const wallBottom = px(groundLength, 0);

  ctx.save();
  ctx.strokeStyle = COLOURS.dimension;
  ctx.fillStyle = COLOURS.dimension;
  ctx.lineWidth = 1;

  // Extension lines
  ctx.beginPath();
  ctx.moveTo(wallTop.x + 6, wallTop.y);
  ctx.lineTo(top.x + 6, top.y);
  ctx.moveTo(wallBottom.x + 6, wallBottom.y);
  ctx.lineTo(bottom.x + 6, bottom.y);
  ctx.stroke();

  drawDimensionLine(bottom, top);

  ctx.translate(top.x, (top.y + bottom.y) / 2);
  ctx.rotate(-Math.PI / 2);
  drawLabel(formatLength(height), 0, 0, COLOURS.dimension, 'center', true);
  ctx.restore();
}

function drawLengthDimension({ groundLength }, px, dimOffset) {
  const y = -dimOffset;
  const left = px(0, y);
  const right = px(groundLength, y);
  const groundLeft = px(0, 0);
  const groundRight = px(groundLength, 0);

  ctx.save();
  ctx.strokeStyle = COLOURS.dimension;
  ctx.fillStyle = COLOURS.dimension;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(groundLeft.x, groundLeft.y + 4);
  ctx.lineTo(left.x, left.y + 6);
  ctx.moveTo(groundRight.x, groundRight.y + 4);
  ctx.lineTo(right.x, right.y + 6);
  ctx.stroke();

  drawDimensionLine(left, right);
  drawLabel(formatLength(groundLength), (left.x + right.x) / 2, left.y + 18, COLOURS.dimension, 'center', true);
  ctx.restore();
}

function drawDimensionLine(from, to) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  drawArrowHead(to, from);
  drawArrowHead(from, to);
}

function drawArrowHead(tip, tail) {
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
  const size = 8;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(angle - Math.PI / 7), tip.y - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(tip.x - size * Math.cos(angle + Math.PI / 7), tip.y - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawLabel(text, x, y, colour, align, withBackground = false) {
  ctx.save();
  ctx.font = '600 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (withBackground) {
    const width = ctx.measureText(text).width;
    const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(left - 4, y - 10, width + 8, 20);
  }
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.restore();
}

heightInput.addEventListener('input', update);
radiusInput.addEventListener('input', update);
window.addEventListener('resize', update);
document.querySelectorAll('input[name="units"]').forEach((radio) => {
  radio.addEventListener('change', () => changeUnit(radio.value));
});

// The browser may restore the previous unit and values on reload, so adopt them without converting.
currentUnit = document.querySelector('input[name="units"]:checked').value;
document.querySelectorAll('.unit-name').forEach((el) => { el.textContent = currentUnit; });
update();
