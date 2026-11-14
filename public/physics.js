'use strict';

/*
 * Rigid-body simulation of the board and rider using planck.js (a port of Box2D). planck works in metres and
 * kilograms; the rest of the app works in cm, so positions are converted on the way in and out.
 *
 * The rider is a body of their own, pinned to the board by a pivot at deck height. Its weight presses down on the
 * board through the pivot, so where the pivot is between the feet sets how the weight is shared between them. The
 * rider's legs twist the board against their body: the board, being far lighter, turns under the body, which barely
 * moves, so the rider can lift the nose while their weight keeps the back wheels down. The moves' twists and steering
 * in the air are these twists.
 */

const PHYSICS_STEP_S = SIM_STEP_S;
const PHYSICS_MAX_S = 15;
const DECK_MASS_KG = 1.6;
// Each truck with its pair of wheels
const TRUCK_MASS_KG = 0.9;
// Maple sliding on waxed steel coping
const DECK_FRICTION = 0.15;
// Where the back foot stands, behind the back axle, as a fraction of the tail's length.
const BACK_FOOT_TAIL_FRACTION = 0.5;
// How hard a person is to turn end over end, per kg: about 12 kg m² for a 70 kg rider.
const RIDER_TURNING_INERTIA_PER_KG = 12 / 70;
// How fast the rider can move their weight along the board.
const WEIGHT_SHIFT_CM_PER_S = 150;
const VELOCITY_ITERATIONS = 20;
const POSITION_ITERATIONS = 8;
// Smoothing of the measured push through the pivot, which jumps at every bump, for the foot forces shown.
const FOOT_FORCE_SMOOTHING_S = 0.03;
// Below this speed along the board, it counts as having come to a stop.
const STOPPED_SPEED_CM_PER_S = 5;
// How quickly the rider turns the board in the air to line it up with the landing, in radians per second.
const AIR_CONTROL_RATE = 8;

const toM = (cm) => cm / 100;
const vecM = (p) => planck.Vec2(toM(p.x), toM(p.y));
const vecCm = (p) => ({ x: p.x * 100, y: p.y * 100 });

/** Foot positions along the board, in cm from the back axle. */
function footPositions(geo) {
  return { backFoot: -deckProfile(geo).overhang * BACK_FOOT_TAIL_FRACTION, frontFoot: geo.board.wheelbase };
}

/**
 * Adds the ramp to the body: the ground in front and the transition as one smooth surface, a solid block for the
 * deck (whose face is also any vert), and the coping. The deck is solid because the board slams down onto it and a
 * solid block pushes anything forced into it back out on top, where a thin surface can be pushed through from the
 * wrong side. The ground and transition are one continuous surface because a wheel rolling across a join between
 * separate shapes catches on the corner and jumps. As on a real ramp, the corner of the lip is cut away where the
 * coping sits, so the board only ever meets the round coping there.
 */
function addRamp(geo, body, runOut) {
  const coping = copingCentre(geo);
  const r = geo.coping.diameter / 2;
  const insideCoping = (p) => Math.hypot(p.x - coping.x, p.y - coping.y) < r;
  const surface = { friction: DECK_FRICTION };
  const depth = 100;
  const polygon = (points) => new planck.Polygon(points.map(vecM));

  // The deck block, with its top corner cut away under the coping where the coping reaches over it.
  const L = geo.groundLength;
  const deckCut = r * r - (geo.height - coping.y) ** 2;
  const deckStart = deckCut > 0 ? Math.max(L, coping.x + Math.sqrt(deckCut)) : L;
  const faceTop = { x: L, y: Math.min(geo.height, coping.y) };
  const cutCorner = deckStart > L && insideCoping(faceTop);
  body.createFixture(polygon([
    { x: L, y: -depth },
    { x: L + runOut, y: -depth },
    { x: L + runOut, y: geo.height },
    ...(cutCorner ? [{ x: deckStart, y: geo.height }, faceTop] : [{ x: L, y: geo.height }]),
  ]), surface);

  // The ground and the transition, stopping where it meets the coping.
  const pointAt = (phi) => ({ x: geo.radius * Math.sin(phi), y: geo.radius * (1 - Math.cos(phi)) });
  const segments = Math.max(8, Math.ceil((geo.angleRad * 180) / Math.PI));
  const arc = [{ x: -runOut, y: 0 }];
  for (let i = 0; i <= segments; i++) {
    const phi = (geo.angleRad * i) / segments;
    if (insideCoping(pointAt(phi))) {
      const lastOutside = (geo.angleRad * (i - 1)) / segments;
      const meets = bisect((angle) => Math.hypot(pointAt(angle).x - coping.x, pointAt(angle).y - coping.y) - r,
        lastOutside, phi);
      if (meets !== null) arc.push(pointAt(meets));
      break;
    }
    arc.push(pointAt(phi));
  }
  const transition = new planck.Chain(arc.map(vecM), false);
  const end = arc[arc.length - 1];
  const onward = geo.vertHeight > 0 && !insideCoping(end) ? { x: L, y: end.y + 1 } : coping;
  transition.setNextVertex(vecM(onward));
  body.createFixture(transition, surface);

  body.createFixture(new planck.Circle(vecM(coping), toM(r)), surface);
}

/**
 * Adds the deck to the board's body, with its origin in the middle of the deck: a flat section between the kicks,
 * and the nose and tail each as a few straight pieces following their curve, so they can strike the ramp.
 */
function addDeckShape(geo, deck) {
  const { wheelbase } = geo.board;
  const { flat, kickLength } = deckProfile(geo);
  const halfThickness = BOARD_THICKNESS_CM / 2;
  const kickPieces = kickLength > 0 ? 4 : 0;
  const totalArea = toM(wheelbase + flat * 2 + kickLength * 2) * toM(BOARD_THICKNESS_CM);
  const fixture = (shape) => deck.createFixture(shape, { density: DECK_MASS_KG / totalArea, friction: DECK_FRICTION });

  fixture(new planck.Box(toM(wheelbase / 2 + flat), toM(halfThickness)));
  // In the body's frame, from the middle of the deck.
  const point = (along) => ({ x: along - wheelbase / 2, y: deckRiseAt(geo, along) - halfThickness });
  for (const side of [-1, 1]) {
    const axle = side < 0 ? 0 : wheelbase;
    for (let i = 0; i < kickPieces; i++) {
      const a = point(axle + side * (flat + (kickLength * i) / kickPieces));
      const b = point(axle + side * (flat + (kickLength * (i + 1)) / kickPieces));
      const corners = [a, b, { x: b.x, y: b.y + BOARD_THICKNESS_CM }, { x: a.x, y: a.y + BOARD_THICKNESS_CM }];
      fixture(new planck.Polygon((side < 0 ? corners.reverse() : corners).map(vecM)));
    }
  }
}

/**
 * Builds the world with the board at the given starting pose. Returns the bodies and a function to change how the
 * rider's weight is split between the feet.
 */
function buildWorld(geo, startPose) {
  const { wheelbase, deckUndersideHeight, riderMass } = geo.board;
  const wheelRadius = deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const world = new planck.World({ gravity: planck.Vec2(0, -9.81) });

  const ramp = world.createBody();
  addRamp(geo, ramp, 10000);

  const { u, v } = startPose;
  const onBoard = (along, up) => add(add(startPose.back, mul(u, along)), mul(v, up));

  // The body's origin is the middle of the deck, half way between the axles.
  const deck = world.createBody({
    type: 'dynamic',
    position: vecM(onBoard(wheelbase / 2, deckUndersideHeight + BOARD_THICKNESS_CM / 2)),
    angle: Math.atan2(u.y, u.x),
  });
  addDeckShape(geo, deck);

  // The rider's body, pinned to the deck at the point their weight is over. It doesn't collide with anything.
  const feet = footPositions(geo);
  const stance = feet.frontFoot - feet.backFoot;
  const deckPoint = (along) => planck.Vec2(toM(along - wheelbase / 2), toM(BOARD_THICKNESS_CM / 2 + deckRiseAt(geo, along)));
  const weightAlong = (share) => feet.backFoot + share * stance;
  let frontShare = 0.5;
  let pivotAlong = weightAlong(frontShare);
  const body = world.createBody({ type: 'dynamic', position: deck.getWorldPoint(deckPoint(pivotAlong)) });
  body.createFixture(new planck.Circle(0.05), { density: 1, filterMaskBits: 0 });
  const mass = Math.max(riderMass, 0.1);
  body.setMassData({ mass, center: planck.Vec2(0, 0), I: mass * RIDER_TURNING_INERTIA_PER_KG });
  const pivot = world.createJoint(new planck.RevoluteJoint({}, deck, body, body.getPosition()));

  /** Where the rider wants their weight, as a share on the front foot. They move it there over the next steps. */
  const setFrontShare = (share) => { frontShare = share; };
  /** Moves the pivot a step towards where the rider wants their weight. */
  const shiftWeight = (seconds) => {
    const shift = weightAlong(frontShare) - pivotAlong;
    const most = WEIGHT_SHIFT_CM_PER_S * seconds;
    pivotAlong += Math.max(-most, Math.min(most, shift));
    pivot.m_localAnchorA = deckPoint(pivotAlong);
  };

  /** The rider's legs twisting the board against their body (anticlockwise positive); the body gets the opposite. */
  const twist = (torque) => {
    deck.applyTorque(torque);
    body.applyTorque(-torque);
  };
  // The wheels are part of the same rigid body and slide without friction, which behaves like frictionless
  // rolling. Separate wheel bodies on joints sag and lose energy under a rider many times their weight.
  const axleBelowCentre = BOARD_THICKNESS_CM / 2 + deckUndersideHeight - wheelRadius;
  const wheelFixtures = [-wheelbase / 2, wheelbase / 2].map((along) =>
    deck.createFixture(new planck.Circle(planck.Vec2(toM(along), -toM(axleBelowCentre)), toM(wheelRadius)), {
      density: TRUCK_MASS_KG / (Math.PI * toM(wheelRadius) ** 2),
      friction: 0,
    }));

  return {
    world,
    deck,
    body,
    pivot,
    wheelFixtures,
    feet,
    setFrontShare,
    getPivotAlong: () => pivotAlong,
    shiftWeight,
    twist,
    step: () => world.step(PHYSICS_STEP_S, VELOCITY_ITERATIONS, POSITION_ITERATIONS),
  };
}

function touchingAnything(body) {
  for (let edge = body.getContactList(); edge; edge = edge.next) {
    if (edge.contact.isTouching()) return true;
  }
  return false;
}

function wheelsTouching(sim) {
  for (let edge = sim.deck.getContactList(); edge; edge = edge.next) {
    const c = edge.contact;
    if (c.isTouching() && (sim.wheelFixtures.includes(c.getFixtureA()) || sim.wheelFixtures.includes(c.getFixtureB()))) {
      return true;
    }
  }
  return false;
}

/** Angle from horizontal of the riding surface below x, with the deck level beyond the lip. */
function surfaceAngleBelow(geo, x) {
  if (x <= 0 || x >= geo.groundLength) return 0;
  return Math.asin(Math.min(1, x / geo.radius));
}

/**
 * In the air, the rider twists the board towards the angle of the surface below, ready to land on it, rather
 * than letting it keep spinning. Torque for a critically damped turn of the board at AIR_CONTROL_RATE, which it
 * returns.
 */
function applyAirControl(geo, sim) {
  const { deck } = sim;
  const below = surfaceAngleBelow(geo, deck.getWorldCenter().x * 100);
  let error = below - deck.getAngle();
  error = Math.atan2(Math.sin(error), Math.cos(error));
  const inertia = deck.getInertia() - deck.getMass() * planck.Vec2.lengthSquared(deck.getLocalCenter());
  const torque = inertia * (AIR_CONTROL_RATE ** 2 * error - 2 * AIR_CONTROL_RATE * deck.getAngularVelocity());
  sim.twist(torque);
  return torque;
}

/** Board pose, in the app's terms, from the deck body. */
function poseFromDeck(geo, deck) {
  const { wheelbase, deckUndersideHeight } = geo.board;
  const angle = deck.getAngle();
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const v = { x: -u.y, y: u.x };
  const centre = vecCm(deck.getPosition());
  const back = sub(sub(centre, mul(u, wheelbase / 2)), mul(v, deckUndersideHeight + BOARD_THICKNESS_CM / 2));
  return boardPose(back, u, wheelbase);
}

/**
 * Measures how hard each foot really pushes into the deck. The rider's body presses on the board through the pivot
 * (holding the rider up against gravity and turning them with the curve), and their legs twist the board about it.
 * Together those are the two feet's pushes: they add up to the pivot's push, and the difference between them makes the
 * twist. So the pushes rise at the bottom of the transition, fall near the top, and are nothing in the air.
 */
function createFootForceGauge(sim) {
  const smoothing = PHYSICS_STEP_S / (FOOT_FORCE_SMOOTHING_S + PHYSICS_STEP_S);
  let push = 0;
  return {
    /** Updates the pivot's push into the deck over the step just taken. */
    measure() {
      const onBody = sim.pivot.getReactionForce(1 / PHYSICS_STEP_S);
      const latest = planck.Vec2.dot(onBody, sim.deck.getWorldVector(planck.Vec2(0, 1)));
      push += (latest - push) * smoothing;
    },
    /** Each foot's push into the deck, in newtons, given the legs' twist on the board. */
    forces(twist) {
      const { backFoot, frontFoot } = sim.feet;
      const pivotAlong = sim.getPivotAlong();
      const back = toM(backFoot - pivotAlong);
      const front = toM(frontFoot - pivotAlong);
      // Feet pushing into the deck turn it about the pivot the opposite way to the twist they make.
      const frontPush = (-twist - push * back) / (front - back);
      return { front: Math.max(0, frontPush), back: Math.max(0, push - frontPush) };
    },
  };
}

/**
 * Simulates the board rolling in from back wheel position range.from at the starting speed. Stops once the board
 * has left the visible area (rolled back off the left, or along the deck past range.to), or after PHYSICS_MAX_S.
 * The rider script is called every step with the current state and can shift the rider's weight, start a kick,
 * or describe what the rider is doing. Returns a pose every PHYSICS_STEP_S, each with where the feet are, how hard
 * each really pushes into the deck as a multiple of the rider's standing weight, the centre of gravity of board and
 * rider, the speed, and what the rider is doing.
 */
function simulateBoard(geo, range, riderScript) {
  const start = ridePose(geo, range.from);
  const sim = buildWorld(geo, start);
  // The rider starts balanced, their weight even between the feet, rolling along with the board.
  sim.deck.setLinearVelocity(planck.Vec2(toM(geo.board.speed), 0));
  sim.body.setLinearVelocity(planck.Vec2(toM(geo.board.speed), 0));
  // Find what the board starts out touching, so the first frame knows it's on the ground.
  sim.world.step(0);
  const gauge = createFootForceGauge(sim);
  const standingWeight = geo.board.riderMass * 9.81;

  const feet = footPositions(geo);
  const leftEdge = surfacePoint(geo, range.from).x;
  const rightEdge = surfacePoint(geo, range.to).x;
  const poses = [];
  // The twist the rider's legs are making, in N m, and until when.
  let legTwist = { torque: 0, until: 0 };
  let action = 'Rolling';

  for (let t = 0; t < PHYSICS_MAX_S; t += PHYSICS_STEP_S) {
    const pose = poseFromDeck(geo, sim.deck);
    const velocity = vecCm(sim.deck.getLinearVelocity());
    const nearX = Math.min(pose.back.x, pose.front.x);
    const farX = Math.max(pose.back.x, pose.front.x);
    const cog = mul(add(mul(vecCm(sim.deck.getWorldCenter()), sim.deck.getMass()), mul(vecCm(sim.body.getWorldCenter()), sim.body.getMass())),
      1 / (sim.deck.getMass() + sim.body.getMass()));
    const state = { cog, speed: len(velocity), progress: frontProgress(geo, pose) };
    if ((velocity.x < 0 && farX < leftEdge) || (velocity.x > 0 && nearX > rightEdge)) {
      poses.push({ ...pose, rider: { ...poses[poses.length - 1]?.rider, ...feet, ...state } });
      break;
    }
    riderScript?.({
      t, pose, velocity,
      onSomething: touchingAnything(sim.deck),
      setFrontShare: sim.setFrontShare,
      twistFor: (torque, seconds) => { legTwist = { torque, until: t + seconds }; },
      say: (text) => { action = text; },
    });

    // The legs only twist the board while it's on something; in the air the rider steers it instead.
    sim.shiftWeight(PHYSICS_STEP_S);
    const onSomething = touchingAnything(sim.deck);
    const twist = onSomething && t < legTwist.until ? legTwist.torque : 0;
    if (twist) sim.twist(twist);
    const steer = wheelsTouching(sim) ? 0 : applyAirControl(geo, sim);
    const forces = gauge.forces(twist);
    const loads = standingWeight > 0
      ? { front: forces.front / standingWeight, back: forces.back / standingWeight }
      : { front: 0, back: 0 };
    const rider = { ...feet, ...state, loads, forces, pivotAlong: sim.getPivotAlong(), twist: twist + steer };
    poses.push({ ...pose, rider: { ...rider, action: onSomething ? action : 'In the air' } });
    sim.step();
    gauge.measure();
  }
  return poses;
}

/**
 * How far round the ramp the front wheels are, as a percentage: 0% with the front axle at the start of the curve and
 * 100% with the front wheels touching the coping. It's measured as the angle of the front axle around the centre of
 * the transition, so beyond 100% it carries on following the board, over the coping and onto the deck. Before the
 * curve it goes negative, at the rate it starts round the curve (see percentPerCmOnFlat).
 */
function frontProgress(geo, pose) {
  const wheelRadius = geo.board.deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const angleAround = (p) => Math.atan2(p.x, geo.radius - p.y);
  const frontAxle = add(pose.front, mul(pose.v, wheelRadius));
  if (frontAxle.x <= 0) return frontAxle.x * percentPerCmOnFlat(geo, wheelRadius);
  return (100 * angleAround(frontAxle)) / angleAround(axleTouchingCoping(geo, wheelRadius).axle);
}

/**
 * How much the front wheels' percentage changes per cm along the flat in front of the ramp: the rate it changes as
 * they start round the curve, so the two join smoothly at 0%.
 */
function percentPerCmOnFlat(geo, wheelRadius) {
  const touching = axleTouchingCoping(geo, wheelRadius).axle;
  return 100 / ((geo.radius - wheelRadius) * Math.atan2(touching.x, geo.radius - touching.y));
}

/** What a move does, in words, for the readout. */
function describeMove(move, index) {
  const parts = [];
  if (move.frontWeight !== null) parts.push(`weight ${move.frontWeight}% on the front foot`);
  if (move.twistTime > 0) parts.push(`twist ${move.twist > 0 ? '+' : ''}${move.twist} N m for ${move.twistTime} s`);
  return `Move ${index + 1}: ${parts.join(', ') || 'no change'}`;
}


/**
 * Rolls in at the starting speed, with the rider making the moves set out in the table in order, each once the one
 * before it has happened. A move happens a delay after its moment comes: the front wheels at or past a point while
 * going up, the board coming to a stop on the ramp or the coping, or the front wheels back at or below a point while
 * coming down. A move can shift the rider's weight between the feet and twist the board under their body. With no moves the rider just balances.
 * When there are moves, a note says if the front truck didn't get over the coping, or the whole board went over onto
 * the deck.
 */
function physicsMovesTimeline(geo, range) {
  const { poses, outcome } = simulateMoves(geo, range);
  const notes = {
    short: "The front truck didn't get over the coping.",
    over: 'The board went right over onto the deck.',
  };
  const note = geo.board.moves.length > 0 ? notes[outcome] ?? null : null;
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)], note);
}

/**
 * Simulates the ride described above. The outcome is 'back' when the front truck gets over the coping and the board
 * comes back, 'short' when it doesn't get over the coping, and 'over' when the whole board goes over onto the deck.
 */
function simulateMoves(geo, range) {
  const coping = copingCentre(geo);
  const copingRadius = geo.coping.diameter / 2;
  const wheelRadius = geo.board.deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const moves = geo.board.moves ?? [];
  let next = 0;
  let due = null;
  let wasMovingUp = false;
  let reachedCoping = false;
  let rolledOnto = false;

  const poses = simulateBoard(geo, range, ({ t, pose, velocity, onSomething, setFrontShare, twistFor, say }) => {
    const progress = frontProgress(geo, pose);
    const alongBoard = dot(velocity, pose.u);
    const movingUp = alongBoard > STOPPED_SPEED_CM_PER_S;
    const movingDown = alongBoard < -STOPPED_SPEED_CM_PER_S;
    // Stopped on the ramp or the coping: not the moment the board hangs still at the top of a flight through the air.
    const stopped = wasMovingUp && onSomething && alongBoard <= STOPPED_SPEED_CM_PER_S;
    if (movingUp) wasMovingUp = true;

    const frontAxle = add(pose.front, mul(pose.v, wheelRadius));
    const backAxle = add(pose.back, mul(pose.v, wheelRadius));
    if (frontAxle.x > coping.x + copingRadius) reachedCoping = true;
    if (backAxle.x > coping.x + copingRadius + wheelRadius && alongBoard > 0) rolledOnto = true;

    // The next move waits for its moment, then for its delay.
    const move = moves[next];
    if (move && due === null) {
      const time = (move.when === 'up' && movingUp && progress >= move.at)
        || (move.when === 'down' && movingDown && progress <= move.at)
        || (move.when === 'stop' && stopped);
      if (time) due = t + move.delay;
    }
    if (move && due !== null && t >= due) {
      const share = move.frontWeight === null ? null : move.frontWeight / 100;
      if (share !== null) setFrontShare(share);
      if (move.twistTime > 0) twistFor(move.twist, move.twistTime);
      say(describeMove(move, next));
      next += 1;
      due = null;
    }
  });
  let outcome = 'back';
  if (!reachedCoping) outcome = 'short';
  if (rolledOnto) outcome = 'over';
  return { poses, outcome };
}

// The fastest starting speed the speed searches try, in cm/s (about 45 mph).
const SEARCH_MAX_SPEED_CM_PER_S = 2000;
// How closely the speed searches pin down a speed, in cm/s (about 0.05 mph).
const SEARCH_PRECISION_CM_PER_S = 2;
// The steps, in cm/s (about 2 mph), in which the speed searches first go up through the speeds.
const SEARCH_STEP_CM_PER_S = 90;

/** The board at the given starting speed, starting on the flat in front of the ramp. */
function atSpeed(geo, speed) {
  return { ...geo, board: { ...geo.board, speed } };
}

/** Whether the board, simply rolling in at this starting speed, ends up on the deck. */
function rollReachesDeck(geo, speed) {
  const poses = simulateBoard(atSpeed(geo, speed), rideRange(geo));
  return poses[poses.length - 1].back.x > geo.groundLength;
}

/**
 * Finds the lowest starting speed from `from` at which a yes/no answer about the speed becomes yes: it goes up through
 * the speeds in steps to the first yes, then halves the gap back to the last no. Stepping up first matters because
 * the answers aren't always tidy at high speed: a board fast enough to fly can come back down the ramp. A generator,
 * so the caller can run one simulation at a time and keep the page responsive; it returns null if the answer is never
 * yes up to SEARCH_MAX_SPEED_CM_PER_S.
 */
function* lowestSpeed(answer, from) {
  let no = from;
  let yes = null;
  for (let speed = from + SEARCH_STEP_CM_PER_S; speed <= SEARCH_MAX_SPEED_CM_PER_S && yes === null; speed += SEARCH_STEP_CM_PER_S) {
    if (answer(speed)) yes = speed; else no = speed;
    yield;
  }
  if (yes === null) return null;
  while (yes - no > SEARCH_PRECISION_CM_PER_S) {
    const middle = (no + yes) / 2;
    if (answer(middle)) yes = middle; else no = middle;
    yield;
  }
  return yes;
}

/**
 * Works out, by simulating, the lowest starting speed that rolls onto the deck with no moves, and the range of
 * starting speeds for which the rider's moves get the front truck over the coping and back. The range runs from the
 * lowest speed that gets the front truck over to the lowest speed above that at which the board goes right over onto
 * the deck, or has no top when it never does. Null where there isn't one within SEARCH_MAX_SPEED_CM_PER_S. A
 * generator that yields after each simulation; its result is { roll, moves: { from, to } }, with to null for no top.
 */
function* speedsNeeded(geo) {
  const roll = yield* lowestSpeed((speed) => rollReachesDeck(geo, speed), 0);

  const outcome = (speed) => simulateMoves(atSpeed(geo, speed), rideRange(geo)).outcome;
  const reaches = yield* lowestSpeed((speed) => outcome(speed) !== 'short', 0);
  if (reaches === null || outcome(reaches) !== 'back') return { roll, moves: null };
  const goesOver = yield* lowestSpeed((speed) => outcome(speed) === 'over', reaches);
  return { roll, moves: { from: reaches, to: goesOver === null ? null : goesOver - SEARCH_PRECISION_CM_PER_S } };
}
