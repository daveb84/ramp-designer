'use strict';

const heightInput = document.getElementById('height');
const radiusInput = document.getElementById('radius');
const copingInput = document.getElementById('coping');
const copingAboveDeckInput = document.getElementById('coping-above-deck');
const copingFromRampInput = document.getElementById('coping-from-ramp');
const wheelbaseInput = document.getElementById('wheelbase');
const deckLengthInput = document.getElementById('deck-length');
const boardHeightInput = document.getElementById('board-height');
const speedInput = document.getElementById('speed');
const animationControls = document.getElementById('animation-controls');
const riderMassInput = document.getElementById('rider-mass');
const playbackInput = document.getElementById('playback');
const presetSelect = document.getElementById('page-preset');
const presetStatus = document.getElementById('preset-status');
const deletePresetButton = document.getElementById('delete-preset');
const saveAsPanel = document.getElementById('save-as');
const saveAsName = document.getElementById('save-as-name');
const addButton = document.getElementById('add-move');
const addAboveButton = document.getElementById('add-above');
const addBelowButton = document.getElementById('add-below');
const movesBody = document.getElementById('moves-body');
const rollSpeedOut = document.getElementById('roll-speed-out');
const movesSpeedOut = document.getElementById('moves-speed-out');
const boardNote = document.getElementById('board-note');
const boardReadout = document.getElementById('board-readout');
const readouts = {
  backFoot: document.getElementById('back-foot-out'),
  backForce: document.getElementById('back-foot-force'),
  frontFoot: document.getElementById('front-foot-out'),
  frontForce: document.getElementById('front-foot-force'),
  totalFeet: document.getElementById('total-feet-out'),
  totalForce: document.getElementById('total-feet-force'),
  cog: document.getElementById('cog-out'),
  speed: document.getElementById('speed-out'),
  action: document.getElementById('action-out'),
  progress: document.getElementById('progress-out'),
};
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
const boardControls = document.getElementById('board-controls');
const pauseButton = document.getElementById('pause-button');

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
    current: 'mm',
  },
  wheelbase: {
    radioName: 'wheelbase-units',
    labelClass: 'wheelbase-unit-name',
    inputs: [deckLengthInput, wheelbaseInput],
    current: 'in',
  },
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
    moves: [],
    wheelbase: toBaseUnits(wheelbaseInput, 'wheelbase'),
    deckLength: toBaseUnits(deckLengthInput, 'wheelbase'),
    deckUndersideHeight: toBaseUnits(boardHeightInput, 'boardHeight'),
    speed: toBaseUnits(speedInput, 'speed'),
    riderMass: toBaseUnits(riderMassInput, 'riderMass'),
  };
  if (!(board.deckLength >= board.wheelbase)) {
    return { error: 'Skateboard deck length must be at least the wheelbase.' };
  }
  if (!(board.wheelbase > 0) || !(board.deckUndersideHeight > 0)) {
    return { error: 'Skateboard wheelbase and deck underside height must both be positive numbers.' };
  }
  if (board.position === 'animation' && (speedInput.value === '' || !(board.speed >= 0))) {
    return { error: 'Starting speed must be zero or more.' };
  }
  if (board.position === 'animation' && (riderMassInput.value === '' || !(board.riderMass >= 0))) {
    return { error: 'Rider weight must be zero or more.' };
  }
  if (board.position === 'animation') {
    const moves = readMoves();
    if (moves.error) return { error: moves.error };
    board.moves = moves;
  }
  return { height, radius, coping, board };
}

/*
 * The rider's moves: the changes they make on the way up, at the top and on the way back. They're kept as entered,
 * so a half-typed number isn't lost, and checked when read. They start as a rock to fakie.
 */
const MOVE_TRIGGERS = { up: 'Going up', stop: 'Board stops', down: 'Coming down' };
const DEFAULT_MOVES = [
  { when: 'up', at: '0', delay: '0', frontWeight: '50', kickBack: '', kickFront: '', kickTime: '' },
  { when: 'up', at: '105', delay: '0', frontWeight: '85', kickBack: '', kickFront: '', kickTime: '' },
  { when: 'stop', at: '', delay: '0.5', frontWeight: '15', kickBack: '140', kickFront: '0', kickTime: '0.12' },
  { when: 'down', at: '90', delay: '0', frontWeight: '50', kickBack: '', kickFront: '', kickTime: '' },
];
const copyMoves = (moves) => moves.map((move) => ({ ...move }));
let riderMoves = copyMoves(DEFAULT_MOVES);

/** The moves as numbers, with blanks as null, or an error naming the first move that doesn't make sense. */
function readMoves() {
  const moves = [];
  for (const [i, entered] of riderMoves.entries()) {
    const number = (text) => (text.trim() === '' ? null : Number(text));
    const move = {
      when: entered.when,
      at: number(entered.at),
      delay: number(entered.delay) ?? 0,
      frontWeight: number(entered.frontWeight),
      kickBack: number(entered.kickBack) ?? 0,
      kickFront: number(entered.kickFront) ?? 0,
      kickTime: number(entered.kickTime) ?? 0,
    };
    const problem = move.when !== 'stop' && !Number.isFinite(move.at) ? 'needs a position for the front wheels'
      : !(move.delay >= 0) ? 'needs a delay of zero or more'
        : move.frontWeight !== null && !(move.frontWeight >= 0 && move.frontWeight <= 100)
          ? 'needs the weight on the front foot between 0 and 100%'
          : !(move.kickTime >= 0) || !(move.kickBack >= 0) || !(move.kickFront >= 0)
            ? 'needs kicks and kick time of zero or more' : null;
    if (problem) return { error: `Move ${i + 1} ${problem}.` };
    moves.push(move);
  }
  return moves;
}

// The row with focus in one of its controls, if any, which Add above and Add below add next to.
let selectedMove = null;

/** Draws the moves table from the moves as entered. */
function renderMoves() {
  movesBody.replaceChildren(...riderMoves.map((move, i) => {
    const row = document.createElement('tr');
    row.dataset.index = String(i);
    if (i === selectedMove) row.classList.add('selected');
    const cell = (child) => {
      const td = document.createElement('td');
      td.append(child);
      row.append(td);
    };
    const when = document.createElement('select');
    when.dataset.field = 'when';
    when.setAttribute('aria-label', `Move ${i + 1}: when`);
    for (const [value, label] of Object.entries(MOVE_TRIGGERS)) when.add(new Option(label, value, false, value === move.when));
    cell(when);
    const numberInput = (field, label) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = move[field];
      input.dataset.field = field;
      input.setAttribute('aria-label', `Move ${i + 1}: ${label}`);
      return input;
    };
    const at = numberInput('at', 'front wheels at (%)');
    at.disabled = move.when === 'stop';
    cell(at);
    cell(numberInput('delay', 'delay (s)'));
    cell(numberInput('frontWeight', 'weight on front foot (%)'));
    cell(numberInput('kickBack', 'kick, back foot (%)'));
    cell(numberInput('kickFront', 'kick, front foot (%)'));
    cell(numberInput('kickTime', 'kick time (s)'));
    const buttons = document.createElement('div');
    buttons.className = 'row-buttons';
    const rowButton = (action, label, ariaLabel, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'row-button';
      button.dataset[action] = String(i);
      button.textContent = label;
      button.disabled = disabled;
      button.setAttribute('aria-label', ariaLabel);
      buttons.append(button);
    };
    rowButton('up', '↑', `Move move ${i + 1} up`, i === 0);
    rowButton('down', '↓', `Move move ${i + 1} down`, i === riderMoves.length - 1);
    rowButton('remove', 'Remove', `Remove move ${i + 1}`);
    cell(buttons);
    return row;
  }));
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
    stopSpeedSearch();
    rollSpeedOut.textContent = '–';
    movesSpeedOut.textContent = '–';
    vertStat.hidden = true;
    boardNote.hidden = true;
    boardReadout.hidden = true;
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
  hitsOut.textContent = deckHitsCoping(geo) ? 'Yes' : 'No';
  startSpeedSearch(geo);

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
  boardView.hidden = false;
  boardNote.hidden = true;
  boardReadout.hidden = position !== 'animation';
  boardControls.hidden = position !== 'animation';

  if (position === 'animation') {
    const bounds = boardViewBounds(geo, sampleRide(geo, rideRange(geo)));
    // Leave room above for air: the most height the starting speed could buy, plus a board length.
    const { wheelbase, speed } = geo.board;
    const boardLength = geo.board.deckLength;
    bounds.maxY = Math.max(bounds.maxY, Math.min(geo.height + boardLength * 2, (speed * speed) / (2 * GRAVITY_CM_PER_S2) + boardLength));
    const range = offCanvasRange(geo, visibleBoardArea(bounds));
    const timeline = physicsMovesTimeline(geo, range);
    if (timeline.note) showBoardNote(timeline.note);
    startAnimation(geo, timeline, bounds);
    return;
  }

  const placement = position === 'animation' ? null : placeBoard(geo);
  if (position !== 'animation' && !placement) {
    showBoardNote(`The skateboard can't sit in the ${POSITION_NAMES[position]} position on this ramp.`);
  }
  drawBoardView(geo, placement ?? ridePose(geo, rideRange(geo).from));
}

const POSITION_NAMES = {
  top: 'Top',
  'over-coping': 'Over coping',
  'middle-ramp': 'Middle - ramp',
  'middle-deck': 'Middle - deck',
  high: 'High',
};

function showBoardNote(text) {
  boardNote.textContent = text;
  boardNote.hidden = false;
}

const GRAVITY_CM_PER_S2 = 981;
const SIM_STEP_S = 1 / 240;
const END_HOLD_S = 0.6;

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

let speedSearch = null;

/**
 * Works out the speeds needed by simulating, one simulation at a time between frames so the page stays responsive.
 * Starting again, or a change to the inputs, abandons any search still running.
 */
function startSpeedSearch(geo) {
  stopSpeedSearch();
  rollSpeedOut.textContent = 'Working out…';
  movesSpeedOut.textContent = 'Working out…';
  const search = speedsNeeded(geo);
  const step = () => {
    const { done, value } = search.next();
    if (!done) {
      speedSearch = setTimeout(step, 0);
      return;
    }
    speedSearch = null;
    const speed = (cmPerS) => formatLength(cmPerS, 'speed');
    rollSpeedOut.textContent = value.roll === null ? 'Not possible' : speed(value.roll);
    const { moves } = value;
    movesSpeedOut.textContent = moves === null ? 'Not possible'
      : moves.to === null ? `${speed(moves.from)} and up`
        : `${speed(moves.from).split(' ')[0]} – ${speed(moves.to)}`;
  };
  speedSearch = setTimeout(step, 0);
}

function stopSpeedSearch() {
  clearTimeout(speedSearch);
  speedSearch = null;
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
  const { overhang } = deckProfile(geo);
  const clearance = wheelbase * 0.1;
  return {
    from: visible.minX - wheelbase - overhang - clearance,
    to: geo.surfaceLength + (visible.maxX - geo.groundLength) + overhang + clearance,
  };
}

let animation = null;

/** Loops the timeline on the skateboard canvas with the view fitted to the given bounds. */
/** Playback speed as a fraction of real life, from 1% to 100%; anything else entered plays in real time. */
function playbackRate() {
  const percent = Number(playbackInput.value);
  return percent >= 1 && percent <= 100 ? percent / 100 : 1;
}

// Whether the animation is paused. It stays paused when the animation restarts after a change, showing the start.
let paused = false;

/** Pauses or plays the animation. */
function setPaused(pause) {
  paused = pause;
  pauseButton.textContent = pause ? 'Play' : 'Pause';
  pauseButton.setAttribute('aria-pressed', String(pause));
}

function startAnimation(geo, timeline, bounds) {
  let last = performance.now();
  let elapsed = 0;
  animation = { frame: 0 };

  // Reads the playback speed and whether it's paused every frame, so changing either carries on from where the
  // animation is. While paused it keeps drawing the same moment, so the position marker still shows.
  const step = (now) => {
    if (!paused) elapsed = (elapsed + (now - last) * playbackRate()) % timeline.durationMs;
    last = now;
    const progress = elapsed / timeline.durationMs;
    const pose = timeline.poseAt(progress);
    if (pose) {
      drawBoardView(geo, pose, bounds);
      showReadout(geo, pose);
    }
    animation.frame = requestAnimationFrame(step);
  };
  step(last);
}

/** The live figures under the skateboard canvas for the current moment of the animation. */
function showReadout(geo, pose) {
  const { rider } = pose;
  // Real pushes into the deck, including the curve's, as a share of the rider's standing weight and in newtons.
  const foot = (load, newtons) => [`${Math.round(load * 100)}%`, `of body weight · ${Math.round(newtons)} N`];
  [readouts.backFoot.textContent, readouts.backForce.textContent] = foot(rider.loads.back, rider.forces.back);
  [readouts.frontFoot.textContent, readouts.frontForce.textContent] = foot(rider.loads.front, rider.forces.front);
  [readouts.totalFeet.textContent, readouts.totalForce.textContent] = foot(
    rider.loads.back + rider.loads.front, rider.forces.back + rider.forces.front,
  );
  const cogAlong = dot(sub(rider.cog, pose.back), pose.u);
  const unit = UNIT_GROUPS.wheelbase.current;
  readouts.cog.textContent = `${(cogAlong / UNITS[unit].basePerUnit).toFixed(1)} ${unit}`;
  readouts.speed.textContent = formatLength(rider.speed, 'speed');
  readouts.action.textContent = rider.action;
  readouts.progress.textContent = `${Math.round(rider.progress)}%`;
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
  const { overhang, kickRise } = deckProfile(geo);
  const boardPoints = framePoses.flatMap((p) => {
    const top = mul(p.v, deckUndersideHeight + BOARD_THICKNESS_CM + kickRise);
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
  if (markedProgress !== null) drawProgressMarker(geo, markedProgress, vp, view);
}

// The "Front wheels at" percentage being edited in the moves table, marked on the skateboard canvas, or null.
let markedProgress = null;

/**
 * Where the front axle is at a percentage of the way round the ramp (see frontProgress): on the flat before the ramp
 * when negative, on its way up the ramp to 100%, then beyond that along its way over the coping onto the deck. On a ramp with vert the board goes straight up
 * past the coping into the air, so anything past 100% is marked at the coping.
 */
function frontAxleAtProgress(geo, percent) {
  const wheelRadius = geo.board.deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const touching = axleTouchingCoping(geo, wheelRadius).axle;
  if (percent <= 0) return { x: percent / percentPerCmOnFlat(geo, wheelRadius), y: wheelRadius };
  const angle = (percent / 100) * Math.atan2(touching.x, geo.radius - touching.y);
  const out = { x: Math.sin(angle), y: -Math.cos(angle) };
  if (percent <= 100) {
    if (angle <= geo.angleRad) return add(geo.centre, mul(out, geo.radius - wheelRadius));
    // Up the vert
    const x = geo.groundLength - wheelRadius;
    return { x, y: geo.radius - x / Math.tan(angle) };
  }
  // Over the coping, where the line from the centre of the transition meets the front axle's height on the deck.
  const below = geo.radius - (geo.height + wheelRadius);
  if (geo.vertHeight > 0 || out.y >= 0 || below <= 0) return touching;
  return add(geo.centre, mul(out, below / -out.y));
}

/** A dotted vertical line, labelled, where the front wheels would be at the given percentage. */
function drawProgressMarker(geo, percent, vp, view) {
  const x = vp.px(frontAxleAtProgress(geo, percent).x, 0).x;
  ctx.save();
  ctx.strokeStyle = COLOURS.angle;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, view.height);
  ctx.stroke();
  ctx.restore();
  drawLabel(`${percent}%`, x, 14, COLOURS.angle, 'center', true);
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
// Illustrative board proportions
const WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT = 0.33;
const BOARD_THICKNESS_CM = 1.2;
// The nose and tail start to curve up this far past each axle, about the end of the truck's baseplate, and finish
// at this angle.
const KICK_START_PAST_AXLE_CM = 6.35;
const KICK_ANGLE_RAD = (22 * Math.PI) / 180;

/**
 * The shape of the deck along its length: how far it reaches past each axle (half of the deck length beyond the
 * wheelbase, measured end to end across the kicks), how much of that is flat, and the length and rise of the kicks.
 */
function deckProfile(geo) {
  const { wheelbase, deckLength } = geo.board;
  const overhang = Math.max(0, (deckLength - wheelbase) / 2);
  const flat = Math.min(overhang, KICK_START_PAST_AXLE_CM);
  const kickLength = overhang - flat;
  return { overhang, flat, kickLength, kickRise: (kickLength * Math.tan(KICK_ANGLE_RAD)) / 2 };
}

/**
 * How far the deck has risen above its flat at a point along the board, measured from the back axle. The nose and
 * tail curve up smoothly from flat to the kick angle at the ends.
 */
function deckRiseAt(geo, along) {
  const { flat, kickLength, kickRise } = deckProfile(geo);
  const pastAxle = along < 0 ? -along : along - geo.board.wheelbase;
  if (pastAxle <= flat || kickLength === 0) return 0;
  return kickRise * Math.min(1, (pastAxle - flat) / kickLength) ** 2;
}

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
 * The still positions resting on the coping: which wheels the board rests on, and how far along the board, from the
 * back axle, the deck rests on the coping.
 */
function positionSupport(geo, position) {
  const { wheelbase } = geo.board;
  const copingRadius = geo.coping.diameter / 2;
  return {
    'over-coping': { wheels: 'back', alongBoard: wheelbase - copingRadius - TRUCK_CLEARANCE_CM },
    'middle-ramp': { wheels: 'back', alongBoard: wheelbase / 2 },
    'middle-deck': { wheels: 'front', alongBoard: wheelbase / 2 },
    high: { wheels: 'front', alongBoard: copingRadius + TRUCK_CLEARANCE_CM },
  }[position];
}

/**
 * Centre of a wheel resting on the ramp, a wheel's radius off the surface, at distance s along the surface from the
 * bottom of the transition: around the curve, then up any vert.
 */
function axleOnRamp(geo, s, wheelRadius) {
  const arcLength = geo.radius * geo.angleRad;
  if (s <= arcLength || geo.vertHeight === 0) {
    const phi = Math.min(s, arcLength) / geo.radius;
    return { x: (geo.radius - wheelRadius) * Math.sin(phi), y: geo.radius - (geo.radius - wheelRadius) * Math.cos(phi) };
  }
  return { x: geo.groundLength - wheelRadius, y: geo.radius + Math.min(s - arcLength, geo.vertHeight) };
}

/**
 * Where an axle is when its wheels, rolling up the ramp, first touch the coping, and its distance s along the ramp.
 */
function axleTouchingCoping(geo, wheelRadius) {
  const coping = copingCentre(geo);
  const touching = wheelRadius + geo.coping.diameter / 2;
  const sMax = geo.radius * geo.angleRad + geo.vertHeight;
  const s = bisect((sAt) => len(sub(axleOnRamp(geo, sAt, wheelRadius), coping)) - touching, 0, sMax) ?? sMax;
  return { axle: axleOnRamp(geo, s, wheelRadius), s };
}

/** Whether a wheel centred here is clear of the ground, ramp, deck and coping. */
function wheelClear(geo, axle, wheelRadius) {
  const tolerance = 1e-6;
  const coping = copingCentre(geo);
  if (len(sub(axle, coping)) < wheelRadius + geo.coping.diameter / 2 - tolerance) return false;
  if (axle.x <= 0) return axle.y >= wheelRadius - tolerance;
  if (axle.x < geo.groundLength) {
    // In front of any vert, the wall is the surface; below it, the curve.
    if (geo.vertHeight > 0 && axle.y > geo.radius) return axle.x <= geo.groundLength - wheelRadius + tolerance;
    return len(sub(axle, geo.centre)) <= geo.radius - wheelRadius + tolerance && axle.y >= wheelRadius - tolerance;
  }
  return axle.y >= geo.height + wheelRadius - tolerance;
}

/**
 * Places the board at the top of the ramp with both sets of wheels on it and the front wheels touching the coping.
 * Null if the deck would then go through the coping.
 */
function placeAtTop(geo, wheelRadius) {
  const { wheelbase, deckUndersideHeight } = geo.board;
  const front = axleTouchingCoping(geo, wheelRadius);
  const sBack = bisect((s) => len(sub(front.axle, axleOnRamp(geo, s, wheelRadius))) - wheelbase, 0, front.s);
  if (sBack === null) return null;
  const backAxle = axleOnRamp(geo, sBack, wheelRadius);
  const u = mul(sub(front.axle, backAxle), 1 / wheelbase);
  const v = { x: -u.y, y: u.x };
  const across = deckUndersideHeight - wheelRadius - geo.coping.diameter / 2;
  if (dot(sub(copingCentre(geo), backAxle), v) > across + 1e-6) return null;
  return { ...boardPose(sub(backAxle, mul(v, wheelRadius)), u, wheelbase), s: sBack };
}

/**
 * Places the board in one of the still positions. It rests on one set of wheels (the back wheels on the ramp, or the
 * front wheels on the deck) and on the coping under the deck, at the position's distance along the board. If the
 * other wheels would then go into the ramp or the deck, they rest on it instead, with both sets of wheels down.
 * Wheels sit a wheel's radius off the surface they rest on. The pose includes s, the back wheels' distance along the
 * ramp, when they're on it. Returns null when the board can't sit there.
 */
function placeBoard(geo) {
  const { wheelbase, deckUndersideHeight, position } = geo.board;
  const wheelRadius = deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  if (position === 'top') return placeAtTop(geo, wheelRadius);
  const coping = copingCentre(geo);
  const copingRadius = geo.coping.diameter / 2;
  const { wheels, alongBoard } = positionSupport(geo, position);
  // In the board's frame, from an axle: the coping centre sits copingRadius below the deck's underside.
  const across = deckUndersideHeight - wheelRadius - copingRadius;
  const deckAxleHeight = geo.height + wheelRadius;
  const sMax = geo.radius * geo.angleRad + geo.vertHeight;

  // Pose from the back axle and the board's direction, with the contact point a wheel's radius below the axle.
  const poseFrom = (backAxle, u, sBack = null) => {
    const v = { x: -u.y, y: u.x };
    return { ...boardPose(sub(backAxle, mul(v, wheelRadius)), u, wheelbase), s: sBack };
  };
  const direction = (angle) => ({ x: Math.cos(angle), y: Math.sin(angle) });

  // Resting on the given wheels and the coping.
  let pose = null;
  if (wheels === 'back') {
    const reach = Math.hypot(alongBoard, across);
    const sBack = bisect((sAt) => len(sub(coping, axleOnRamp(geo, sAt, wheelRadius))) - reach, 0, sMax);
    if (sBack !== null) {
      const backAxle = axleOnRamp(geo, sBack, wheelRadius);
      const toCoping = sub(coping, backAxle);
      const u = direction(Math.atan2(toCoping.y, toCoping.x) - Math.atan2(across, alongBoard));
      if (wheelClear(geo, add(backAxle, mul(u, wheelbase)), wheelRadius)) pose = poseFrom(backAxle, u, sBack);
    }
  } else {
    const reach = Math.hypot(alongBoard - wheelbase, across);
    const rise = deckAxleHeight - coping.y;
    if (reach > Math.abs(rise)) {
      const frontAxle = { x: coping.x + Math.sqrt(reach * reach - rise * rise), y: deckAxleHeight };
      const toCoping = sub(coping, frontAxle);
      const u = direction(Math.atan2(toCoping.y, toCoping.x) - Math.atan2(across, alongBoard - wheelbase));
      const backAxle = sub(frontAxle, mul(u, wheelbase));
      if (wheelClear(geo, backAxle, wheelRadius)) pose = poseFrom(backAxle, u);
    }
  }
  if (pose) return pose;

  // Both sets of wheels down: back wheels on the ramp, front wheels on the deck, with the coping at the position's
  // distance along the board.
  const onBoth = (sAt) => {
    const backAxle = axleOnRamp(geo, sAt, wheelRadius);
    const rise = deckAxleHeight - backAxle.y;
    if (Math.abs(rise) > wheelbase + 1e-6) return null;
    const frontAxle = { x: backAxle.x + Math.sqrt(Math.max(0, wheelbase * wheelbase - rise * rise)), y: deckAxleHeight };
    return { backAxle, u: mul(sub(frontAxle, backAxle), 1 / wheelbase) };
  };
  // Only where the back wheels are close enough below the deck for the front wheels to reach it.
  const sReach = bisect((sAt) => axleOnRamp(geo, sAt, wheelRadius).y - (deckAxleHeight - wheelbase), 0, sMax) ?? 0;
  const sBoth = onBoth(sReach) && bisect((sAt) => {
    const both = onBoth(sAt);
    return dot(sub(coping, both.backAxle), both.u) - alongBoard;
  }, sReach, sMax);
  const both = sBoth ? onBoth(sBoth) : null;
  if (!both) return null;
  const v = { x: -both.u.y, y: both.u.x };
  // The deck mustn't pass through the coping.
  if (dot(sub(coping, both.backAxle), v) > across + 1e-6) return null;
  return poseFrom(both.backAxle, both.u, sBoth);
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
    from: -(wheelbase + deckProfile(geo).overhang),
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
  const { overhang } = deckProfile(geo);
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

  // Deck, tail to nose along the underside and back along the top, curving up into the kicks
  const samples = 60;
  const alongAt = (i) => -overhang + ((wheelbase + overhang * 2) * i) / samples;
  const outline = [];
  for (let i = 0; i <= samples; i++) outline.push(deckAt(alongAt(i), deckRiseAt(geo, alongAt(i))));
  for (let i = samples; i >= 0; i--) outline.push(deckAt(alongAt(i), deckRiseAt(geo, alongAt(i)) + BOARD_THICKNESS_CM));
  ctx.beginPath();
  outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
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
 * Where the rider's weight is modelled: a semicircle on the deck at each foot, labelled with how hard it really
 * pushes into the deck as a share of the rider's standing weight, and the centre of gravity of board and rider with
 * a line straight down from it.
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
    const p = toPx(vp, add(add(pose.back, mul(pose.u, foot.along)), mul(pose.v, deckTop + deckRiseAt(geo, foot.along))));
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
  if (pose.rider.cog) drawCentreOfGravity(geo, pose.rider.cog, vp);
}

/** The usual quartered circle, with a dashed line straight down to the surface below it. */
function drawCentreOfGravity(geo, cog, vp) {
  const c = toPx(vp, cog);
  const below = toPx(vp, { x: cog.x, y: surfaceHeightBelow(geo, cog.x) });
  const radius = 7;

  ctx.save();
  ctx.strokeStyle = COLOURS.dimension;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(below.x, below.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let quarter = 0; quarter < 4; quarter++) {
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.arc(c.x, c.y, radius, (quarter * Math.PI) / 2, ((quarter + 1) * Math.PI) / 2);
    ctx.closePath();
    ctx.fillStyle = quarter % 2 === 0 ? COLOURS.dimension : '#ffffff';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Height of the riding surface (ground, transition or deck) below x. */
function surfaceHeightBelow({ radius, groundLength, height }, x) {
  if (x <= 0) return 0;
  if (x >= groundLength) return height;
  return radius - Math.sqrt(radius * radius - x * x);
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
  heightInput, radiusInput, copingInput, copingAboveDeckInput, copingFromRampInput, wheelbaseInput, deckLengthInput,
  boardHeightInput,
  speedInput, riderMassInput,
]) {
  input.addEventListener('input', update);
}
document.querySelectorAll('input[name="board-position"]').forEach((radio) => {
  radio.addEventListener('change', update);
});
window.addEventListener('resize', update);
pauseButton.addEventListener('click', () => setPaused(!paused));

// Editing the moves re-runs the ride. The table is only redrawn when rows come or go, so typing keeps its place.
// While any control in a row has focus, mark that row's "Front wheels at" position on the skateboard canvas.
const markFrom = (control) => {
  const row = control.closest('tr');
  const move = row ? riderMoves[Number(row.dataset.index)] : null;
  const percent = Number(move?.at);
  markedProgress = move && move.when !== 'stop' && move.at.trim() !== '' && Number.isFinite(percent) ? percent : null;
};
/** Selects a row, or none, highlighting it and offering to add above or below it. */
const selectMove = (index) => {
  selectedMove = index;
  for (const row of movesBody.children) row.classList.toggle('selected', Number(row.dataset.index) === index);
  addButton.hidden = index !== null;
  addAboveButton.hidden = index === null;
  addBelowButton.hidden = index === null;
};
const addButtons = [addButton, addAboveButton, addBelowButton];
// Keep the row selected while focus moves to Add above or Add below; clicking them doesn't take focus at all.
const keepsSelection = (element) => movesBody.contains(element) || addButtons.includes(element);
movesBody.addEventListener('focusin', (event) => {
  markFrom(event.target);
  selectMove(Number(event.target.closest('tr').dataset.index));
});
for (const element of [movesBody, ...addButtons]) {
  element.addEventListener('focusout', (event) => {
    if (element === movesBody) markedProgress = null;
    if (!keepsSelection(event.relatedTarget)) selectMove(null);
  });
}
for (const button of addButtons) button.addEventListener('mousedown', (event) => event.preventDefault());
movesBody.addEventListener('input', (event) => {
  const { field } = event.target.dataset;
  const row = event.target.closest('tr');
  if (!field || !row) return;
  riderMoves[Number(row.dataset.index)][field] = event.target.value;
  markFrom(event.target);
  if (field === 'when') row.querySelector('[data-field="at"]').disabled = event.target.value === 'stop';
  update();
});
const blankMove = () => ({ when: 'up', at: '', delay: '0', frontWeight: '', kickBack: '', kickFront: '', kickTime: '' });
/** Adds a blank move at the given place in the table and puts the cursor in its position. */
const addMoveAt = (index) => {
  riderMoves.splice(index, 0, blankMove());
  renderMoves();
  movesBody.children[index].querySelector('[data-field="at"]').focus();
};
/** Swaps a move with the one next to it (-1 for above, 1 for below), keeping focus on its button. */
const shiftMove = (index, by) => {
  const other = index + by;
  if (other < 0 || other >= riderMoves.length) return;
  [riderMoves[index], riderMoves[other]] = [riderMoves[other], riderMoves[index]];
  renderMoves();
  const button = movesBody.children[other].querySelector(by < 0 ? '[data-up]' : '[data-down]');
  (button.disabled ? movesBody.children[other].querySelector('[data-remove]') : button).focus();
  update();
};
movesBody.addEventListener('click', (event) => {
  const { up, down, remove } = event.target.dataset;
  if (up !== undefined) {
    shiftMove(Number(up), -1);
  } else if (down !== undefined) {
    shiftMove(Number(down), 1);
  } else if (remove !== undefined) {
    riderMoves.splice(Number(remove), 1);
    renderMoves();
    update();
  }
});
addButton.addEventListener('click', () => addMoveAt(riderMoves.length));
addAboveButton.addEventListener('click', () => addMoveAt(selectedMove ?? 0));
addBelowButton.addEventListener('click', () => addMoveAt((selectedMove ?? riderMoves.length - 1) + 1));
renderMoves();

/*
 * Presets: everything set on the page (every input, every choice of units, the skateboard position and the rider's
 * moves), saved in this browser's local storage and loaded again. Values are kept in the units they were entered in,
 * along with those units, so loading one never converts anything.
 */

/** The page's form controls, other than the moves table, which is kept separately. */
function pageControls() {
  return [...document.querySelectorAll('form input, form select')].filter((control) => !movesBody.contains(control));
}

/** Everything set on the page, or what it starts with when the page is first opened. */
function pageState(asFirstOpened = false) {
  const values = {};
  const choices = {};
  for (const control of pageControls()) {
    if (control.type === 'radio') {
      if (asFirstOpened ? control.defaultChecked : control.checked) choices[control.name] = control.value;
    } else if (control.id) {
      values[control.id] = asFirstOpened ? control.defaultValue : control.value;
    }
  }
  return { values, choices, moves: copyMoves(asFirstOpened ? DEFAULT_MOVES : riderMoves) };
}

/** Sets everything on the page from a saved state, then redraws. Anything the state doesn't mention is left alone. */
function applyPageState(state) {
  for (const control of pageControls()) {
    if (control.type === 'radio') {
      if (control.name in state.choices) control.checked = control.value === state.choices[control.name];
    } else if (control.id in state.values) {
      control.value = state.values[control.id];
    }
  }
  for (const [group, unitGroup] of Object.entries(UNIT_GROUPS)) {
    if (unitGroup.radioName in state.choices) unitGroup.current = state.choices[unitGroup.radioName];
    showUnitLabels(group);
  }
  riderMoves = copyMoves(state.moves ?? []);
  renderMoves();
  update();
}

const BUILT_IN_PRESETS = {
  default: { name: 'Default', state: () => pageState(true) },
  roll: {
    name: 'Roll',
    state: () => {
      const firstOpened = pageState(true);
      return { ...firstOpened, choices: { ...firstOpened.choices, 'board-position': 'animation' }, moves: [] };
    },
  },
  // Lifts the nose over the coping, rocks with the coping under the middle of the board, then lifts back over. Found
  // by searching the simulation on the page's first-opened ramp, where it works from about 10.4 to 10.8 mph.
  'rock-on-coping': {
    name: 'Rock on the coping',
    state: () => {
      const firstOpened = pageState(true);
      return {
        values: { ...firstOpened.values, speed: '10.5' },
        choices: { ...firstOpened.choices, 'board-position': 'animation', 'speed-units': 'mph' },
        moves: [
          { when: 'up', at: '0', delay: '0', frontWeight: '50', kickBack: '', kickFront: '', kickTime: '' },
          { when: 'up', at: '94', delay: '0', frontWeight: '30', kickBack: '150', kickFront: '0', kickTime: '0.12' },
          { when: 'up', at: '108', delay: '0', frontWeight: '85', kickBack: '0', kickFront: '150', kickTime: '0.08' },
          { when: 'stop', at: '', delay: '0.6', frontWeight: '15', kickBack: '160', kickFront: '0', kickTime: '0.12' },
          { when: 'down', at: '90', delay: '0', frontWeight: '50', kickBack: '', kickFront: '', kickTime: '' },
        ],
      };
    },
  },
};

// Saved presets: { [preset id]: { name, state } }. Ids of presets saved under a new name start "saved:". Storage can
// be unavailable (a private window, say), when nothing is kept between visits.
const SAVED_PRESETS_KEY = 'ramp-designer.presets';
function loadSavedPresets() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PRESETS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function storeSavedPresets(saved) {
  try {
    localStorage.setItem(SAVED_PRESETS_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}
let savedPresets = loadSavedPresets();

/** A preset's state: the saved version if there is one, otherwise the built-in one. */
const presetState = (preset) => savedPresets[preset]?.state ?? BUILT_IN_PRESETS[preset]?.state();
const presetName = (preset) => savedPresets[preset]?.name ?? BUILT_IN_PRESETS[preset]?.name ?? preset;

/** Fills the preset dropdown: the built-in presets, then any saved under a name of their own. */
function showPresetOptions(selected) {
  const saved = Object.keys(savedPresets).filter((id) => !(id in BUILT_IN_PRESETS))
    .sort((a, b) => presetName(a).localeCompare(presetName(b)));
  presetSelect.replaceChildren(...[...Object.keys(BUILT_IN_PRESETS), ...saved]
    .map((id) => new Option(presetName(id), id, false, id === selected)));
  presetSelect.value = selected;
  // Only a preset you've saved can be deleted.
  deletePresetButton.disabled = !(selected in savedPresets);
}

presetSelect.addEventListener('change', () => {
  deletePresetButton.disabled = !(presetSelect.value in savedPresets);
  applyPageState(presetState(presetSelect.value));
});

/** Shows a message by the presets for a few seconds. */
function showPresetStatus(message) {
  presetStatus.textContent = message;
  clearTimeout(showPresetStatus.timer);
  showPresetStatus.timer = setTimeout(() => { presetStatus.textContent = ''; }, 3000);
}

/** Saves everything on the page under a preset, and says so. */
function savePreset(preset, name) {
  savedPresets = { ...savedPresets, [preset]: { name, state: pageState() } };
  const stored = storeSavedPresets(savedPresets);
  showPresetOptions(preset);
  showPresetStatus(stored ? `Saved as "${name}"` : "Couldn't save: this browser isn't keeping data for the page");
}

/**
 * Deletes the saved version of the selected preset, once confirmed. A built-in preset goes back to its own values; one
 * saved under a name of its own goes, and the page switches to Default.
 */
deletePresetButton.addEventListener('click', () => {
  const preset = presetSelect.value;
  const name = presetName(preset);
  const builtIn = preset in BUILT_IN_PRESETS;
  const question = builtIn ? `Delete your saved "${name}" and go back to the built-in one?` : `Delete the preset "${name}"?`;
  if (!(preset in savedPresets) || !window.confirm(question)) return;
  const { [preset]: deleted, ...rest } = savedPresets;
  savedPresets = rest;
  storeSavedPresets(savedPresets);
  const showing = builtIn ? preset : 'default';
  showPresetOptions(showing);
  applyPageState(presetState(showing));
  showPresetStatus(builtIn ? `Deleted your saved "${name}"` : `Deleted "${name}"`);
});
document.getElementById('save-preset').addEventListener('click', () => savePreset(presetSelect.value, presetName(presetSelect.value)));

// Save as: a name box, saving under a built-in preset's id when the name matches one, otherwise as a new preset.
const closeSaveAs = () => {
  saveAsPanel.hidden = true;
  saveAsName.value = '';
};
const confirmSaveAs = () => {
  const name = saveAsName.value.trim();
  if (!name) {
    saveAsName.focus();
    return;
  }
  const builtIn = Object.keys(BUILT_IN_PRESETS).find((id) => BUILT_IN_PRESETS[id].name.toLowerCase() === name.toLowerCase());
  savePreset(builtIn ?? `saved:${name}`, builtIn ? BUILT_IN_PRESETS[builtIn].name : name);
  closeSaveAs();
};
document.getElementById('save-preset-as').addEventListener('click', () => {
  saveAsPanel.hidden = false;
  saveAsName.focus();
});
document.getElementById('save-as-confirm').addEventListener('click', confirmSaveAs);
document.getElementById('save-as-cancel').addEventListener('click', closeSaveAs);
saveAsName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') confirmSaveAs();
  if (event.key === 'Escape') closeSaveAs();
});

for (const [group, { radioName }] of Object.entries(UNIT_GROUPS)) {
  document.querySelectorAll(`input[name="${radioName}"]`).forEach((radio) => {
    radio.addEventListener('change', () => changeUnit(group, radio.value));
  });
}
// Open on the Default preset (your saved version, if you've saved one), once every script has loaded, as the
// animations use physics.js.
showPresetOptions('default');
document.addEventListener('DOMContentLoaded', () => applyPageState(presetState('default')));
