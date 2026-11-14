'use strict';

const heightInput = document.getElementById('height');
const radiusInput = document.getElementById('radius');
const copingInput = document.getElementById('coping');
const copingAboveDeckInput = document.getElementById('coping-above-deck');
const copingFromRampInput = document.getElementById('coping-from-ramp');
const angleOut = document.getElementById('angle-out');
const arcOut = document.getElementById('arc-out');
const lengthOut = document.getElementById('length-out');
const vertStat = document.getElementById('vert-stat');
const vertOut = document.getElementById('vert-out');
const errorOut = document.getElementById('error');
const canvas = document.getElementById('ramp-canvas');
const detailCanvas = document.getElementById('detail-canvas');

// The context of whichever canvas is being drawn; see useCanvas.
let ctx;

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
function computeGeometry(height, radius, coping) {
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
    coping,
  };
}

const UNITS = {
  cm: { cmPerUnit: 1, decimals: 1 },
  ft: { cmPerUnit: 30.48, decimals: 2 },
  mm: { cmPerUnit: 0.1, decimals: 1 },
  in: { cmPerUnit: 2.54, decimals: 3 },
};


/** Each group of inputs has its own independent unit selection. */
const UNIT_GROUPS = {
  ramp: { radioName: 'units', labelClass: 'unit-name', inputs: [heightInput, radiusInput], current: 'ft' },
  coping: { radioName: 'coping-units', labelClass: 'coping-unit-name', inputs: [copingInput], current: 'in' },
  protrusion: {
    radioName: 'protrusion-units',
    labelClass: 'protrusion-unit-name',
    inputs: [copingAboveDeckInput, copingFromRampInput],
    current: 'in',
  },
};

function formatLength(cm, group = 'ramp') {
  const unitName = UNIT_GROUPS[group].current;
  const unit = UNITS[unitName];
  return `${(cm / unit.cmPerUnit).toFixed(unit.decimals)} ${unitName}`;
}

function toCm(input, group) {
  return Number(input.value) * UNITS[UNIT_GROUPS[group].current].cmPerUnit;
}

/** Returns the entered dimensions converted to cm. */
function readInputs() {
  const height = toCm(heightInput, 'ramp');
  const radius = toCm(radiusInput, 'ramp');
  const coping = {
    diameter: toCm(copingInput, 'coping'),
    aboveDeck: toCm(copingAboveDeckInput, 'protrusion'),
    fromRamp: toCm(copingFromRampInput, 'protrusion'),
  };
  if (!(height > 0) || !(radius > 0)) {
    return { error: 'Height and radius must both be positive numbers.' };
  }
  if (!(coping.diameter > 0)) {
    return { error: 'Coping diameter must be a positive number.' };
  }
  if (copingAboveDeckInput.value === '' || copingFromRampInput.value === ''
    || !Number.isFinite(coping.aboveDeck) || !Number.isFinite(coping.fromRamp)) {
    return { error: 'Coping protrusions must be numbers.' };
  }
  return { height, radius, coping };
}

function showUnitLabels(group) {
  const { labelClass, current } = UNIT_GROUPS[group];
  document.querySelectorAll(`.${labelClass}`).forEach((el) => { el.textContent = current; });
}

/** Converts the group's entered values into the new unit so the sizes stay the same. */
function changeUnit(group, newUnit) {
  const unitGroup = UNIT_GROUPS[group];
  const fromCmPerUnit = UNITS[unitGroup.current].cmPerUnit;
  const to = UNITS[newUnit];
  for (const input of unitGroup.inputs) {
    const value = Number(input.value);
    if (input.value !== '' && Number.isFinite(value)) {
      input.value = Number((value * fromCmPerUnit / to.cmPerUnit).toFixed(to.decimals));
    }
  }
  unitGroup.current = newUnit;
  showUnitLabels(group);
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
    clearCanvases();
    return;
  }
  errorOut.hidden = true;

  const geo = computeGeometry(inputs.height, inputs.radius, inputs.coping);
  angleOut.textContent = `${geo.angleDeg.toFixed(1)}°`;
  arcOut.textContent = formatLength(geo.surfaceLength);
  lengthOut.textContent = formatLength(geo.groundLength);
  vertStat.hidden = geo.vertHeight === 0;
  vertOut.textContent = formatLength(geo.vertHeight);

  draw(geo);
}

/** Sizes the canvas for the device pixel ratio and makes it the target of all drawing helpers. */
function useCanvas(target) {
  ctx = target.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = target.getBoundingClientRect();
  target.width = Math.round(rect.width * dpr);
  target.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { width: rect.width, height: rect.height };
}

function clearCanvases() {
  useCanvas(canvas);
  useCanvas(detailCanvas);
}

/** Maps world cm (y up) onto the canvas so that the given bounds fit inside the padding. */
function createViewport(view, bounds, padding) {
  const scale = Math.min(
    (view.width - padding * 2) / (bounds.maxX - bounds.minX),
    (view.height - padding * 2) / (bounds.maxY - bounds.minY),
  );
  const offsetX = (view.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale;
  const offsetY = (view.height + (bounds.maxY - bounds.minY) * scale) / 2 + bounds.minY * scale;
  const px = (x, y) => ({ x: offsetX + x * scale, y: offsetY - y * scale });
  return {
    scale,
    px,
    moveTo: (x, y) => { const p = px(x, y); ctx.moveTo(p.x, p.y); },
    lineTo: (x, y) => { const p = px(x, y); ctx.lineTo(p.x, p.y); },
  };
}

function draw(geo) {
  drawOverview(geo);
  drawCopingDetail(geo);
}

function drawOverview(geo) {
  const view = useCanvas(canvas);
  const { height, radius, groundLength } = geo;
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
  const vp = createViewport(view, bounds, 48);

  // Ground
  ctx.strokeStyle = COLOURS.ground;
  ctx.lineWidth = 2;
  ctx.beginPath();
  vp.moveTo(bounds.minX, 0);
  vp.lineTo(bounds.maxX, 0);
  ctx.stroke();

  drawRampBody(geo, vp);
  const coping = drawCoping(geo, vp);
  drawLabel(
    `Ø ${formatLength(geo.coping.diameter, 'coping')}`,
    coping.x,
    coping.y - coping.radiusPx - 14,
    COLOURS.copingEdge,
    'center',
    true,
  );

  drawRadius(geo, vp);
  drawAngle(geo, vp.px, tangentLength);
  drawHeightDimension(geo, vp.px, dimOffset);
  drawLengthDimension(geo, vp.px, dimOffset);
}

/** Close-up of the top of the ramp showing the coping size and its protrusions. */
function drawCopingDetail(geo) {
  const view = useCanvas(detailCanvas);
  const { coping, groundLength, height } = geo;
  const r = coping.diameter / 2;
  const centre = copingCentre(geo);
  const extentX = coping.diameter * 1.6 + Math.abs(coping.fromRamp);
  const extentY = coping.diameter * 1.1 + Math.abs(coping.aboveDeck);

  const bounds = {
    minX: Math.min(centre.x, groundLength) - extentX,
    maxX: Math.max(centre.x, groundLength) + extentX,
    minY: Math.min(centre.y, height) - extentY,
    maxY: Math.max(centre.y, height) + extentY,
  };
  const vp = createViewport(view, bounds, 24);

  drawRampBody(geo, vp);
  drawCoping(geo, vp);

  const lip = vp.px(groundLength, height);
  const copingTop = vp.px(centre.x, centre.y + r);
  const copingFront = vp.px(centre.x - r, centre.y);
  const copingBack = vp.px(centre.x + r, centre.y);
  const gap = 28;

  ctx.save();
  ctx.strokeStyle = COLOURS.dimension;
  ctx.fillStyle = COLOURS.dimension;
  ctx.lineWidth = 1;

  // Protrusion above deck: from the deck level up to the top of the coping, measured to the right.
  const aboveX = copingBack.x + gap;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(lip.x, lip.y);
  ctx.lineTo(aboveX + 6, lip.y);
  ctx.moveTo(copingTop.x, copingTop.y);
  ctx.lineTo(aboveX + 6, copingTop.y);
  ctx.stroke();
  ctx.setLineDash([]);
  drawDimensionLine({ x: aboveX, y: lip.y }, { x: aboveX, y: copingTop.y });
  drawLabel(
    `${formatLength(coping.aboveDeck, 'protrusion')} above deck`,
    aboveX + 10,
    (lip.y + copingTop.y) / 2,
    COLOURS.dimension,
    'left',
    true,
  );

  // Protrusion from ramp: at right angles from the riding surface (extended past the lip) to the coping's edge.
  const n = rampNormal(geo);
  const along = { x: Math.cos(geo.angleRad), y: Math.sin(geo.angleRad) };
  const surfaceExtension = coping.diameter * 1.5;
  const surfaceEnd = vp.px(groundLength + along.x * surfaceExtension, height + along.y * surfaceExtension);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(lip.x, lip.y);
  ctx.lineTo(surfaceEnd.x, surfaceEnd.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const edgeWorld = { x: centre.x + n.x * r, y: centre.y + n.y * r };
  const edge = vp.px(edgeWorld.x, edgeWorld.y);
  const foot = vp.px(edgeWorld.x - n.x * coping.fromRamp, edgeWorld.y - n.y * coping.fromRamp);
  if (Math.hypot(edge.x - foot.x, edge.y - foot.y) > 2) {
    drawDimensionLine(foot, edge);
  }
  // Label sits beyond the outer end of the dimension, offset along the normal (canvas y is flipped).
  const outer = coping.fromRamp >= 0 ? edge : foot;
  drawLabel(
    `${formatLength(coping.fromRamp, 'protrusion')} from ramp`,
    outer.x + n.x * gap,
    outer.y - n.y * gap,
    COLOURS.dimension,
    'right',
    true,
  );

  // Diameter across the coping
  const c = vp.px(centre.x, centre.y);
  ctx.strokeStyle = COLOURS.copingEdge;
  ctx.fillStyle = COLOURS.copingEdge;
  drawDimensionLine(copingFront, copingBack);
  drawLabel(`Ø ${formatLength(coping.diameter, 'coping')}`, c.x, c.y + 16, COLOURS.copingEdge, 'center', true);
  ctx.restore();
}

/** The ramp's side profile and riding surface. */
function drawRampBody({ height, radius, groundLength, angleRad, centre }, vp) {
  const traceProfile = () => {
    vp.moveTo(0, 0);
    arcAroundCentre({ radius, centre }, vp, 0, angleRad);
    vp.lineTo(groundLength, height);
  };

  ctx.beginPath();
  traceProfile();
  vp.lineTo(groundLength, 0);
  ctx.closePath();
  ctx.fillStyle = COLOURS.rampFill;
  ctx.fill();
  ctx.strokeStyle = COLOURS.rampEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  traceProfile();
  ctx.strokeStyle = COLOURS.surface;
  ctx.lineWidth = 3.5;
  ctx.stroke();
}

/**
 * Adds part of the transition circle to the current path, with angles measured from the bottom of the circle.
 * Canvas y is flipped, so a counter-clockwise world arc maps to canvas angles running from +90° towards 0.
 */
function arcAroundCentre({ radius, centre }, vp, fromRad, toRad) {
  const c = vp.px(centre.x, centre.y);
  ctx.arc(c.x, c.y, radius * vp.scale, Math.PI / 2 - fromRad, Math.PI / 2 - toRad, true);
}

/** Unit vector at right angles to the riding surface at the lip, pointing out of the ramp. */
function rampNormal({ angleRad }) {
  return { x: -Math.sin(angleRad), y: Math.cos(angleRad) };
}

/**
 * Coping centre in world cm. Its top sits the given distance above the deck, and its edge sits the given
 * distance out from the riding surface at the lip, measured at right angles to that surface.
 */
function copingCentre(geo) {
  const { coping, groundLength, height } = geo;
  const r = coping.diameter / 2;
  const n = rampNormal(geo);
  const y = height + coping.aboveDeck - r;
  // Solve (centre - lip) · n = fromRamp - r for x.
  const x = groundLength + ((y - height) * n.y - (coping.fromRamp - r)) / -n.x;
  return { x, y };
}

/** Draws the coping and returns its centre and radius in canvas pixels. */
function drawCoping(geo, vp) {
  const centre = copingCentre(geo);
  const c = vp.px(centre.x, centre.y);
  const radiusPx = Math.max(3, (geo.coping.diameter / 2) * vp.scale);

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, radiusPx, 0, Math.PI * 2);
  ctx.fillStyle = COLOURS.coping;
  ctx.fill();
  ctx.strokeStyle = COLOURS.copingEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  return { x: c.x, y: c.y, radiusPx };
}

function drawRadius(geo, vp) {
  const { radius, transitionTop, centre } = geo;
  const { px } = vp;
  ctx.save();
  ctx.strokeStyle = COLOURS.construction;
  ctx.fillStyle = COLOURS.construction;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);

  // Full quarter of the transition circle, to show where the radius continues
  ctx.beginPath();
  arcAroundCentre(geo, vp, 0, Math.PI / 2);
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

for (const input of [heightInput, radiusInput, copingInput, copingAboveDeckInput, copingFromRampInput]) {
  input.addEventListener('input', update);
}
window.addEventListener('resize', update);

for (const [group, { radioName }] of Object.entries(UNIT_GROUPS)) {
  document.querySelectorAll(`input[name="${radioName}"]`).forEach((radio) => {
    radio.addEventListener('change', () => changeUnit(group, radio.value));
  });
  // The browser may restore the previous unit and values on reload, so adopt them without converting.
  UNIT_GROUPS[group].current = document.querySelector(`input[name="${radioName}"]:checked`).value;
  showUnitLabels(group);
}
update();
