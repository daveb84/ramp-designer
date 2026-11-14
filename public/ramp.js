'use strict';

const heightInput = document.getElementById('height');
const radiusInput = document.getElementById('radius');
const copingInput = document.getElementById('coping');
const copingAboveDeckInput = document.getElementById('coping-above-deck');
const copingFromRampInput = document.getElementById('coping-from-ramp');
const wheelbaseInput = document.getElementById('wheelbase');
const boardHeightInput = document.getElementById('board-height');
const speedInput = document.getElementById('speed');
const animationControls = document.getElementById('animation-controls');
const riderMassInput = document.getElementById('rider-mass');
const frontShareInput = document.getElementById('front-share');
const rollSpeedOut = document.getElementById('roll-speed-out');
const rockSpeedOut = document.getElementById('rock-speed-out');
const boardNote = document.getElementById('board-note');
const hitsOut = document.getElementById('hits-out');
const angleOut = document.getElementById('angle-out');
const arcOut = document.getElementById('arc-out');
const lengthOut = document.getElementById('length-out');
const vertStat = document.getElementById('vert-stat');
const vertOut = document.getElementById('vert-out');
const errorOut = document.getElementById('error');
const canvas = document.getElementById('ramp-canvas');
const detailCanvas = document.getElementById('detail-canvas');
const boardCanvas = document.getElementById('board-canvas');
const boardView = document.getElementById('board-view');

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
  boardDeck: '#111827',
  boardGrip: '#374151',
  rider: '#7c3aed',
  truck: '#6b7280',
  wheel: '#f5f5f4',
  wheelEdge: '#57534e',
};

/**
 * Side-profile geometry of a quarter pipe whose transition starts flat on the ground at x = 0
 * and curves up to the right. All values are in cm with y pointing up, whatever unit is displayed.
 * When the height exceeds the radius, the transition reaches vertical at y = r and continues
 * straight up as vert.
 */
function computeGeometry(height, radius, coping, board) {
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
    board,
  };
}

// basePerUnit converts to the units used internally: cm for lengths, cm/s for speeds and kg for masses.
const UNITS = {
  cm: { basePerUnit: 1, decimals: 1 },
  ft: { basePerUnit: 30.48, decimals: 2 },
  mm: { basePerUnit: 0.1, decimals: 1 },
  in: { basePerUnit: 2.54, decimals: 3 },
  // Speeds
  'km/h': { basePerUnit: 100000 / 3600, decimals: 1 },
  mph: { basePerUnit: 160934.4 / 3600, decimals: 1 },
  // Masses
  kg: { basePerUnit: 1, decimals: 1 },
  lb: { basePerUnit: 0.45359237, decimals: 1 },
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
  wheelbase: { radioName: 'wheelbase-units', labelClass: 'wheelbase-unit-name', inputs: [wheelbaseInput], current: 'in' },
  boardHeight: {
    radioName: 'board-height-units',
    labelClass: 'board-height-unit-name',
    inputs: [boardHeightInput],
    current: 'in',
  },
  speed: { radioName: 'speed-units', labelClass: 'speed-unit-name', inputs: [speedInput], current: 'mph' },
  riderMass: { radioName: 'rider-mass-units', labelClass: 'rider-mass-unit-name', inputs: [riderMassInput], current: 'kg' },
};

function formatLength(cm, group = 'ramp') {
  const unitName = UNIT_GROUPS[group].current;
  const unit = UNITS[unitName];
  return `${(cm / unit.basePerUnit).toFixed(unit.decimals)} ${unitName}`;
}

function toBaseUnits(input, group) {
  return Number(input.value) * UNITS[UNIT_GROUPS[group].current].basePerUnit;
}

/** Returns the entered values converted to the units used internally. */
function readInputs() {
  const height = toBaseUnits(heightInput, 'ramp');
  const radius = toBaseUnits(radiusInput, 'ramp');
  const coping = {
    diameter: toBaseUnits(copingInput, 'coping'),
    aboveDeck: toBaseUnits(copingAboveDeckInput, 'protrusion'),
    fromRamp: toBaseUnits(copingFromRampInput, 'protrusion'),
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
  const board = {
    position: document.querySelector('input[name="board-position"]:checked').value,
    trick: document.querySelector('input[name="trick"]:checked').value,
    wheelbase: toBaseUnits(wheelbaseInput, 'wheelbase'),
    deckUndersideHeight: toBaseUnits(boardHeightInput, 'boardHeight'),
    speed: toBaseUnits(speedInput, 'speed'),
    riderMass: toBaseUnits(riderMassInput, 'riderMass'),
    frontShare: Number(frontShareInput.value) / 100,
  };
  if (board.position !== 'none' && (!(board.wheelbase > 0) || !(board.deckUndersideHeight > 0))) {
    return { error: 'Skateboard wheelbase and deck underside height must both be positive numbers.' };
  }
  if (board.position === 'animation' && (speedInput.value === '' || !(board.speed >= 0))) {
    return { error: 'Starting speed must be zero or more.' };
  }
  if (board.position === 'animation' && (riderMassInput.value === '' || !(board.riderMass >= 0))) {
    return { error: 'Rider weight must be zero or more.' };
  }
  if (board.position === 'animation'
    && (frontShareInput.value === '' || !(board.frontShare >= 0 && board.frontShare <= 1))) {
    return { error: 'Weight on the front foot must be between 0 and 100%.' };
  }
  return { height, radius, coping, board };
}

function showUnitLabels(group) {
  const { labelClass, current } = UNIT_GROUPS[group];
  document.querySelectorAll(`.${labelClass}`).forEach((el) => { el.textContent = current; });
}

/** Converts the group's entered values into the new unit so the sizes stay the same. */
function changeUnit(group, newUnit) {
  const unitGroup = UNIT_GROUPS[group];
  const fromBasePerUnit = UNITS[unitGroup.current].basePerUnit;
  const to = UNITS[newUnit];
  for (const input of unitGroup.inputs) {
    const value = Number(input.value);
    if (input.value !== '' && Number.isFinite(value)) {
      input.value = Number((value * fromBasePerUnit / to.basePerUnit).toFixed(to.decimals));
    }
  }
  unitGroup.current = newUnit;
  showUnitLabels(group);
  update();
}

function update() {
  animationControls.hidden = document.querySelector('input[name="board-position"]:checked').value !== 'animation';
  const inputs = readInputs();
  if (inputs.error) {
    errorOut.textContent = inputs.error;
    errorOut.hidden = false;
    angleOut.textContent = '–';
    arcOut.textContent = '–';
    lengthOut.textContent = '–';
    hitsOut.textContent = '–';
    rollSpeedOut.textContent = '–';
    rockSpeedOut.textContent = '–';
    vertStat.hidden = true;
    boardNote.hidden = true;
    stopAnimation();
    clearCanvases();
    return;
  }
  errorOut.hidden = true;

  const geo = computeGeometry(inputs.height, inputs.radius, inputs.coping, inputs.board);
  angleOut.textContent = `${geo.angleDeg.toFixed(1)}°`;
  arcOut.textContent = formatLength(geo.surfaceLength);
  lengthOut.textContent = formatLength(geo.groundLength);
  vertStat.hidden = geo.vertHeight === 0;
  vertOut.textContent = formatLength(geo.vertHeight);
  const boardSized = geo.board.wheelbase > 0 && geo.board.deckUndersideHeight > 0;
  hitsOut.textContent = boardSized ? (deckHitsCoping(geo) ? 'Yes' : 'No') : '–';
  const low = boardSized ? placeBoard({ ...geo, board: { ...geo.board, position: 'low' } }) : null;
  rollSpeedOut.textContent = boardSized ? formatLength(speedNeeded(geo, rideRange(geo).to), 'speed') : '–';
  rockSpeedOut.textContent = low ? formatLength(speedNeeded(geo, low.s), 'speed') : '–';

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
  boardView.hidden = true;
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
  stopAnimation();
  drawOverview(geo);
  drawCopingDetail(geo);

  const { position } = geo.board;
  boardView.hidden = position === 'none';
  boardNote.hidden = true;
  if (position === 'none') return;

  if (position === 'animation') {
    const bounds = boardViewBounds(geo, sampleRide(geo, rideRange(geo)));
    // Leave room above for air: the most height the starting speed could buy, plus a board length.
    const { wheelbase, speed } = geo.board;
    const boardLength = wheelbase * (1 + BOARD_OVERHANG_PER_WHEELBASE * 2);
    bounds.maxY = Math.max(bounds.maxY, Math.min(geo.height + boardLength * 2, (speed * speed) / (2 * GRAVITY_CM_PER_S2) + boardLength));
    const range = offCanvasRange(geo, visibleBoardArea(bounds));
    const timeline = geo.board.trick === 'roll'
      ? physicsRollTimeline(geo, range)
      : physicsRockToFakieTimeline(geo, range);
    if (timeline.note) showBoardNote(timeline.note);
    startAnimation(geo, timeline, bounds);
    return;
  }

  const placement = position === 'animation' ? null : placeBoard(geo);
  if (position !== 'animation' && !placement) {
    showBoardNote(`The skateboard can't sit in the ${position} position on this ramp.`);
  }
  drawBoardView(geo, placement ?? ridePose(geo, rideRange(geo).from));
}

function showBoardNote(text) {
  boardNote.textContent = text;
  boardNote.hidden = false;
}

const GRAVITY_CM_PER_S2 = 981;
const SIM_STEP_S = 1 / 240;
const END_HOLD_S = 0.6;

/** The board's centre of mass, taken as the middle of the deck. */
function centreOfMass(geo, pose) {
  const { wheelbase, deckUndersideHeight } = geo.board;
  return add(add(pose.back, mul(pose.u, wheelbase / 2)), mul(pose.v, deckUndersideHeight + BOARD_THICKNESS_CM / 2));
}

/** Plays poses sampled every SIM_STEP_S. */
function timelineFromPoses(poses, note = null) {
  return {
    durationMs: poses.length * SIM_STEP_S * 1000,
    poseAt: (progress) => poses[Math.min(poses.length - 1, Math.floor(progress * poses.length))],
    note,
  };
}

function holdLast(poses, seconds) {
  return Array.from({ length: Math.round(seconds / SIM_STEP_S) }, () => poses[poses.length - 1]);
}

/** Lowest starting speed (cm/s) at which the board's centre of mass can rise from the start to every point up to sTo. */
function speedNeeded(geo, sTo) {
  const range = rideRange(geo);
  const startHeight = centreOfMass(geo, ridePose(geo, range.from)).y;
  let maxRise = 0;
  const steps = 1000;
  for (let i = 0; i <= steps; i++) {
    const pose = ridePose(geo, range.from + ((sTo - range.from) * i) / steps);
    maxRise = Math.max(maxRise, centreOfMass(geo, pose).y - startHeight);
  }
  return Math.sqrt(2 * GRAVITY_CM_PER_S2 * maxRise);
}

const RIDE_FRAME_SAMPLES = 120;

/** Board poses along the ride between the range's back wheel positions, for framing the view. */
function sampleRide(geo, range) {
  return Array.from({ length: RIDE_FRAME_SAMPLES + 1 },
    (_, i) => ridePose(geo, range.from + ((range.to - range.from) * i) / RIDE_FRAME_SAMPLES)).filter(Boolean);
}

/** Back wheel positions with the whole board just off the left of the visible area, and just off the right along the deck. */
function offCanvasRange(geo, visible) {
  const { wheelbase } = geo.board;
  const overhang = wheelbase * BOARD_OVERHANG_PER_WHEELBASE;
  const clearance = wheelbase * 0.1;
  return {
    from: visible.minX - wheelbase - overhang - clearance,
    to: geo.surfaceLength + (visible.maxX - geo.groundLength) + overhang + clearance,
  };
}

let animation = null;

/** Loops the timeline on the skateboard canvas with the view fitted to the given bounds. */
function startAnimation(geo, timeline, bounds) {
  const startTime = performance.now();
  animation = { frame: 0 };

  const step = (now) => {
    const progress = ((now - startTime) % timeline.durationMs) / timeline.durationMs;
    const pose = timeline.poseAt(progress);
    if (pose) drawBoardView(geo, pose, bounds);
    animation.frame = requestAnimationFrame(step);
  };
  step(startTime);
}

function stopAnimation() {
  if (animation) cancelAnimationFrame(animation.frame);
  animation = null;
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

  drawDeck(geo, vp, bounds.maxX);

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

  // Protrusion above deck: from the deck up to the top of the coping, measured to the right.
  const aboveX = copingBack.x + gap;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
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

/** The skateboard in its chosen position, close up around the top of the ramp. */
const BOARD_VIEW_PADDING = 16;

/** World bounds that fit the top of the ramp, the coping and the board at every one of the given poses. */
function boardViewBounds(geo, framePoses) {
  const { wheelbase, deckUndersideHeight } = geo.board;
  const overhang = wheelbase * BOARD_OVERHANG_PER_WHEELBASE;
  const boardPoints = framePoses.flatMap((p) => {
    const top = mul(p.v, deckUndersideHeight + BOARD_THICKNESS_CM);
    return [add(p.back, mul(p.u, -overhang)), add(p.back, mul(p.u, wheelbase + overhang))]
      .flatMap((end) => [end, add(end, top)]);
  });
  const copingPos = copingCentre(geo);
  const r = geo.coping.diameter / 2;
  const points = [...boardPoints, { x: geo.groundLength, y: geo.height }, add(copingPos, { x: r, y: r })];
  const margin = deckUndersideHeight * 2;
  return {
    minX: Math.min(...points.map((p) => p.x)) - margin,
    maxX: Math.max(...points.map((p) => p.x)) + margin,
    minY: Math.min(...points.map((p) => p.y)) - margin,
    maxY: Math.max(...points.map((p) => p.y)) + margin,
  };
}

/** The world area actually visible on the skateboard canvas once the bounds are fitted to its shape. */
function visibleBoardArea(bounds) {
  const rect = boardCanvas.getBoundingClientRect();
  const vp = createViewport(rect, bounds, BOARD_VIEW_PADDING);
  const origin = vp.px(0, 0);
  return {
    minX: -origin.x / vp.scale,
    maxX: (rect.width - origin.x) / vp.scale,
  };
}

/** Draws the board at the given pose, with the view fitted to the given bounds. */
function drawBoardView(geo, pose, bounds = boardViewBounds(geo, [pose])) {
  const view = useCanvas(boardCanvas);
  const vp = createViewport(view, bounds, BOARD_VIEW_PADDING);
  const visible = visibleBoardArea(bounds);

  ctx.strokeStyle = COLOURS.ground;
  ctx.lineWidth = 2;
  ctx.beginPath();
  vp.moveTo(visible.minX, 0);
  vp.lineTo(Math.max(0, visible.minX), 0);
  ctx.stroke();

  drawRampBody(geo, vp);
  drawDeck(geo, vp, visible.maxX);
  drawCoping(geo, vp);
  drawBoard(geo, pose, vp);
}

/** Deck surface running back from the lip to toX. */
function drawDeck({ groundLength, height }, vp, toX) {
  ctx.beginPath();
  vp.moveTo(groundLength, height);
  vp.lineTo(toX, height);
  ctx.strokeStyle = COLOURS.surface;
  ctx.lineWidth = 3.5;
  ctx.stroke();
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

// Clearance between a truck's axle and the coping for the low and high positions, roughly half a baseplate.
const TRUCK_CLEARANCE_CM = 3;
// Illustrative board proportions, relative to the wheelbase and deck underside height entered.
const BOARD_OVERHANG_PER_WHEELBASE = 0.64;
const WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT = 0.33;
const BOARD_THICKNESS_CM = 1.2;

/**
 * Point on the riding surface at distance s along it from the bottom of the transition. Before the bottom it
 * is on the ground in front of the ramp, and past the top it continues back along the deck.
 */
function surfacePoint({ radius, angleRad, vertHeight, surfaceLength, groundLength, height }, s) {
  const arcLength = radius * angleRad;
  if (s < 0) {
    return { x: s, y: 0 };
  }
  if (s <= arcLength) {
    const phi = s / radius;
    return { x: radius * Math.sin(phi), y: radius * (1 - Math.cos(phi)) };
  }
  if (s <= surfaceLength) {
    return { x: radius, y: radius + Math.min(s - arcLength, vertHeight) };
  }
  return { x: groundLength + (s - surfaceLength), y: height };
}

function isInsideRamp({ radius, groundLength, height }, p) {
  const tolerance = 1e-6;
  if (p.x <= 0 || p.y <= 0) return false;
  // Points on a vertical section's face are on the surface, not inside.
  if (p.x <= groundLength + tolerance) {
    const x = Math.min(p.x, radius);
    return p.y < radius - Math.sqrt(radius * radius - x * x) - tolerance;
  }
  return p.y < height - tolerance;
}

/** Finds where f changes sign between lo and hi by bisection, or null if it doesn't. */
function bisect(f, lo, hi) {
  let fLo = f(lo);
  if (Math.sign(fLo) === Math.sign(f(hi))) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

const dot = (a, b) => a.x * b.x + a.y * b.y;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const toPx = (vp, p) => vp.px(p.x, p.y);

/** Board pose from its back wheel contact point and direction; v points from the wheels up to the deck. */
function boardPose(back, u, wheelbase) {
  return { back, u, v: { x: -u.y, y: u.x }, front: add(back, mul(u, wheelbase)) };
}

/**
 * Places the board going up the ramp with its back wheels on the transition. Its other support is the
 * underside of the deck resting on the coping, unless that would put the front wheels through the deck,
 * in which case the front wheels rest on the deck. The position sets how far along the board, from the
 * back truck, the coping sits. The pose includes s, the back wheels' distance along the surface. Returns null
 * when the board can't sit there.
 */
function placeBoard(geo) {
  const { wheelbase, deckUndersideHeight, position } = geo.board;
  const copingRadius = geo.coping.diameter / 2;
  const copingPos = copingCentre(geo);
  const alongBoard = {
    low: wheelbase - copingRadius - TRUCK_CLEARANCE_CM,
    middle: wheelbase / 2,
    high: copingRadius + TRUCK_CLEARANCE_CM,
  }[position];

  // Resting on the coping: in the board's frame the coping centre sits at (alongBoard, deckUndersideHeight - copingRadius)
  // from the back wheel contact, so the contact must be that far from the coping centre.
  const across = deckUndersideHeight - copingRadius;
  const reach = Math.hypot(alongBoard, across);
  const sBack = bisect((s) => len(sub(copingPos, surfacePoint(geo, s))) - reach, 0, geo.surfaceLength);
  if (sBack !== null) {
    const back = surfacePoint(geo, sBack);
    const toCoping = sub(copingPos, back);
    const angle = Math.atan2(toCoping.y, toCoping.x) - Math.atan2(across, alongBoard);
    const pose = boardPose(back, { x: Math.cos(angle), y: Math.sin(angle) }, wheelbase);
    if (!isInsideRamp(geo, pose.front)) return { ...pose, s: sBack };
  }

  // Both sets of wheels on the surface, with the coping at the required distance along the board.
  const sWheels = bisect((s) => {
    const pose = poseOnWheels(geo, s);
    return pose ? dot(sub(copingPos, pose.back), pose.u) - alongBoard : NaN;
  }, 0, geo.surfaceLength);
  if (sWheels === null) return null;
  const pose = poseOnWheels(geo, sWheels);
  // The deck mustn't pass through the coping.
  return pose && dot(sub(copingPos, pose.back), pose.v) <= across + 1e-6 ? { ...pose, s: sWheels } : null;
}

/** Board pose with its back wheels at distance s along the surface and its front wheels also on the surface. */
function poseOnWheels(geo, s) {
  const { wheelbase } = geo.board;
  const back = surfacePoint(geo, s);
  const sFront = bisect((t) => len(sub(surfacePoint(geo, t), back)) - wheelbase, s, s + wheelbase * 3);
  if (sFront === null) return null;
  return boardPose(back, mul(sub(surfacePoint(geo, sFront), back), 1 / wheelbase), wheelbase);
}

/**
 * Whether the underside of the deck hits the coping as the board rolls up the transition and over onto the
 * deck: at some point the coping is between the trucks and reaches above the deck's underside.
 */
function deckHitsCoping(geo) {
  const steps = 2000;
  for (let i = 0; i <= steps; i++) {
    const pose = poseOnWheels(geo, (geo.surfaceLength * i) / steps);
    if (pose && copingThroughDeck(geo, pose)) return true;
  }
  return false;
}

/** Whether the coping is between the trucks and reaches above the underside of the deck. */
function copingThroughDeck(geo, pose) {
  const toCoping = sub(copingCentre(geo), pose.back);
  const along = dot(toCoping, pose.u);
  return along > 0 && along < geo.board.wheelbase
    && dot(toCoping, pose.v) + geo.coping.diameter / 2 > geo.board.deckUndersideHeight + 1e-6;
}

/** Distances along the surface of the back wheels at the start and far end of the ride. */
function rideRange(geo) {
  const { wheelbase } = geo.board;
  const copingBack = copingCentre(geo).x + geo.coping.diameter / 2 - geo.groundLength;
  return {
    from: -wheelbase * (1 + BOARD_OVERHANG_PER_WHEELBASE),
    to: geo.surfaceLength + Math.max(0, copingBack) + wheelbase * 0.3,
  };
}

/**
 * Board pose with its back wheels at distance s along the surface. The front wheels roll on the surface too,
 * unless that would put the coping through the deck, in which case the board rides over on the coping.
 */
function ridePose(geo, s) {
  const pose = poseOnWheels(geo, s);
  if (!pose || !copingThroughDeck(geo, pose)) return pose;

  const toCoping = sub(copingCentre(geo), pose.back);
  const across = geo.board.deckUndersideHeight - geo.coping.diameter / 2;
  const distance = len(toCoping);
  if (distance <= Math.abs(across)) return pose;
  const along = Math.sqrt(distance * distance - across * across);
  const angle = Math.atan2(toCoping.y, toCoping.x) - Math.atan2(across, along);
  return boardPose(pose.back, { x: Math.cos(angle), y: Math.sin(angle) }, geo.board.wheelbase);
}

/** Draws the board: wheels touching the surface, trucks, and the deck with its nose and tail. */
function drawBoard(geo, pose, vp) {
  const { wheelbase, deckUndersideHeight } = geo.board;
  const wheelRadius = deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const overhang = wheelbase * BOARD_OVERHANG_PER_WHEELBASE;
  const { u, v } = pose;
  const deckAt = (along, up) => toPx(vp, add(add(pose.back, mul(u, along)), mul(v, deckUndersideHeight + up)));

  ctx.save();

  // Trucks, from the deck down to the axles
  for (const contact of [pose.back, pose.front]) {
    const axle = add(contact, mul(v, wheelRadius));
    const hangerHalf = wheelRadius * 0.9;
    const base = add(contact, mul(v, deckUndersideHeight));
    const a = toPx(vp, axle);
    ctx.beginPath();
    const p1 = toPx(vp, add(base, mul(u, -hangerHalf)));
    const p2 = toPx(vp, add(base, mul(u, hangerHalf)));
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(a.x, a.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fillStyle = COLOURS.truck;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(2, wheelRadius * vp.scale), 0, Math.PI * 2);
    ctx.fillStyle = COLOURS.wheel;
    ctx.fill();
    ctx.strokeStyle = COLOURS.wheelEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Deck
  const corners = [
    deckAt(-overhang, 0),
    deckAt(wheelbase + overhang, 0),
    deckAt(wheelbase + overhang, BOARD_THICKNESS_CM),
    deckAt(-overhang, BOARD_THICKNESS_CM),
  ];
  ctx.beginPath();
  corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = COLOURS.boardDeck;
  ctx.fill();
  ctx.strokeStyle = COLOURS.boardGrip;
  ctx.lineWidth = Math.max(1, Math.min(3, BOARD_THICKNESS_CM * vp.scale * 0.3));
  ctx.stroke();

  ctx.restore();
  if (pose.rider) drawRider(geo, pose, vp);
}

/**
 * Where the rider's weight is modelled: a semicircle on the deck at each foot, labelled with the share of their
 * weight on it.
 */
function drawRider(geo, pose, vp) {
  const { backFoot, frontFoot, loads } = pose.rider;
  const deckTop = geo.board.deckUndersideHeight + BOARD_THICKNESS_CM;
  const footRadius = Math.max(5, 3 * vp.scale);
  const boardAngle = Math.atan2(-pose.u.y, pose.u.x);
  // Away from the deck, on screen
  const outward = { x: pose.v.x, y: -pose.v.y };

  ctx.save();
  ctx.fillStyle = COLOURS.rider;
  for (const foot of [{ along: backFoot, load: loads.back }, { along: frontFoot, load: loads.front }]) {
    const p = toPx(vp, add(add(pose.back, mul(pose.u, foot.along)), mul(pose.v, deckTop)));
    // Flat side on the deck
    ctx.beginPath();
    ctx.arc(p.x, p.y, footRadius, boardAngle + Math.PI, boardAngle);
    ctx.closePath();
    ctx.fill();
    const labelGap = footRadius + 14;
    drawLabel(`${Math.round(foot.load * 100)}%`, p.x + outward.x * labelGap, p.y + outward.y * labelGap,
      COLOURS.rider, 'center', true);
  }
  ctx.restore();
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

for (const input of [
  heightInput, radiusInput, copingInput, copingAboveDeckInput, copingFromRampInput, wheelbaseInput, boardHeightInput,
  speedInput, riderMassInput, frontShareInput,
]) {
  input.addEventListener('input', update);
}
document.querySelectorAll('input[name="board-position"], input[name="trick"]').forEach((radio) => {
  radio.addEventListener('change', update);
});
window.addEventListener('resize', update);

for (const [group, { radioName }] of Object.entries(UNIT_GROUPS)) {
  document.querySelectorAll(`input[name="${radioName}"]`).forEach((radio) => {
    radio.addEventListener('change', () => changeUnit(group, radio.value));
  });
  // The browser may restore the previous unit and values on reload, so adopt them without converting.
  UNIT_GROUPS[group].current = document.querySelector(`input[name="${radioName}"]:checked`).value;
  showUnitLabels(group);
}
// Run once every script has loaded, as the animations use physics.js.
document.addEventListener('DOMContentLoaded', update);
