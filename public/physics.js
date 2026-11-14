'use strict';

/*
 * Rigid-body simulation of the board and rider using planck.js (a port of Box2D). planck works in metres and
 * kilograms; the rest of the app works in cm, so positions are converted on the way in and out.
 *
 * The rider's weight sits on the deck as two point masses, one at each foot: the front foot over the front truck
 * and the back foot on the tail, just behind the back truck. Board, wheels and rider are one rigid body. Shifting
 * the weight between the feet moves the rider's centre of gravity along the board.
 *
 * The rider can also kick: for a moment their legs push one foot into the deck harder than their weight and ease off
 * the other, to flick the nose up or press it down. Each kick is followed by easing off by the same amount, as the
 * rider's body would rise and settle, so on average the feet still carry just the rider's weight.
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
// If the front wheels are against the coping and the board slows below this, the rider kicks the nose up over it.
const ROCK_CATCH_SPEED_CM_PER_S = 60;
// Smoothing of each foot's measured acceleration, which jumps at every bump, for the foot forces shown.
const FOOT_FORCE_SMOOTHING_S = 0.03;
// How long the board stays on the coping before the rider kicks back off it.
const ROCK_STALL_S = 0.5;
// If the board is still this slow this long after kicking back off the coping, the rider kicks again.
const ROCK_RETRY_S = 0.35;
const ROCK_STUCK_SPEED_CM_PER_S = 20;
// Kicks as pushes from each foot in multiples of the rider's weight. The first part kicks, the second eases off.
const LIFT_KICK = [{ seconds: 0.15, back: 1.5, front: 0 }, { seconds: 0.15, back: 0.5, front: 0 }];
const RETURN_KICK = [{ seconds: 0.12, back: 1.4, front: 0 }, { seconds: 0.12, back: 0.6, front: 0 }];
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

  // The feet carry the rider's weight but don't collide with anything.
  const feet = footPositions(geo);
  const footRadiusM = 0.02;
  const footArea = Math.PI * footRadiusM * footRadiusM;
  // On top of the deck, which is higher where a foot is on a kick.
  const footLocal = (along) => planck.Vec2(toM(along - wheelbase / 2), toM(BOARD_THICKNESS_CM / 2 + deckRiseAt(geo, along)));
  const foot = (along) => deck.createFixture(new planck.Circle(footLocal(along), footRadiusM), {
    density: 0,
    filterMaskBits: 0,
  });
  const frontFoot = foot(feet.frontFoot);
  const backFoot = foot(feet.backFoot);
  const footPoints = { front: footLocal(feet.frontFoot), back: footLocal(feet.backFoot) };
  let frontShare = 0.5;
  const setFrontShare = (share) => {
    frontFoot.setDensity((riderMass * share) / footArea);
    backFoot.setDensity((riderMass * (1 - share)) / footArea);
    deck.resetMassData();
    frontShare = share;
  };

  // The wheels are part of the same rigid body and slide without friction, which behaves like frictionless
  // rolling. Separate wheel bodies on joints sag and lose energy under a rider many times their weight.
  const axleBelowCentre = BOARD_THICKNESS_CM / 2 + deckUndersideHeight - wheelRadius;
  const wheelFixtures = [-wheelbase / 2, wheelbase / 2].map((along) =>
    deck.createFixture(new planck.Circle(planck.Vec2(toM(along), -toM(axleBelowCentre)), toM(wheelRadius)), {
      density: TRUCK_MASS_KG / (Math.PI * toM(wheelRadius) ** 2),
      friction: 0,
    }));

  /**
   * Pushes each foot into the deck with the given multiple of the rider's weight. Their weight already pushes as
   * it is split between the feet, so only the difference is added. Returns the extra push from each foot, in newtons.
   */
  const pushFeet = (pushes) => {
    const into = deck.getWorldVector(planck.Vec2(0, -1));
    const weight = riderMass * 9.81;
    const extra = { front: (pushes.front - frontShare) * weight, back: (pushes.back - (1 - frontShare)) * weight };
    for (const side of ['front', 'back']) {
      deck.applyForce(planck.Vec2.mul(into, extra[side]), deck.getWorldPoint(footPoints[side]));
    }
    return extra;
  };

  return {
    world, deck, wheelFixtures, footPoints, riderMass, setFrontShare, getFrontShare: () => frontShare, pushFeet,
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
 * In the air, the rider turns the board towards the angle of the surface below, ready to land on it, rather
 * than letting it keep spinning. Torque for a critically damped turn at AIR_CONTROL_RATE.
 */
function applyAirControl(geo, deck) {
  const below = surfaceAngleBelow(geo, deck.getWorldCenter().x * 100);
  let error = below - deck.getAngle();
  error = Math.atan2(Math.sin(error), Math.cos(error));
  const inertia = deck.getInertia() - deck.getMass() * planck.Vec2.lengthSquared(deck.getLocalCenter());
  deck.applyTorque(inertia * (AIR_CONTROL_RATE ** 2 * error - 2 * AIR_CONTROL_RATE * deck.getAngularVelocity()));
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
 * Measures how hard each foot really pushes into the deck. The rider's weight at a foot moves with the board, so the
 * deck has to push it along with everything the board does: hold it up against gravity, and turn it with the curve.
 * The foot's push is its share of the rider's mass times the gravity it feels (gravity less the foot's own
 * acceleration, which includes the push of the curve), plus any kick, so it rises at the bottom of the transition,
 * falls near the top, and is nothing in the air.
 */
function createFootForceGauge(sim) {
  const smoothing = PHYSICS_STEP_S / (FOOT_FORCE_SMOOTHING_S + PHYSICS_STEP_S);
  const velocityAt = (side) => sim.deck.getLinearVelocityFromLocalPoint(sim.footPoints[side]);
  const previous = { front: velocityAt('front').clone(), back: velocityAt('back').clone() };
  const acceleration = { front: planck.Vec2(0, 0), back: planck.Vec2(0, 0) };

  return {
    /** Updates each foot's acceleration over the step just taken. */
    measure() {
      for (const side of ['front', 'back']) {
        const velocity = velocityAt(side).clone();
        const latest = planck.Vec2.mul(planck.Vec2.sub(velocity, previous[side]), 1 / PHYSICS_STEP_S);
        acceleration[side] = planck.Vec2.add(acceleration[side],
          planck.Vec2.mul(planck.Vec2.sub(latest, acceleration[side]), smoothing));
        previous[side] = velocity;
      }
    },
    /** Each foot's push into the deck, in newtons, given any extra kick from each. */
    forces(kickExtra) {
      const into = sim.deck.getWorldVector(planck.Vec2(0, -1));
      const share = sim.getFrontShare();
      const mass = { front: sim.riderMass * share, back: sim.riderMass * (1 - share) };
      const result = {};
      for (const side of ['front', 'back']) {
        const felt = planck.Vec2.sub(planck.Vec2(0, -9.81), acceleration[side]);
        result[side] = Math.max(0, mass[side] * planck.Vec2.dot(felt, into) + (kickExtra?.[side] ?? 0));
      }
      return result;
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
  sim.setFrontShare(geo.board.frontShare);
  sim.deck.setLinearVelocity(planck.Vec2(toM(geo.board.speed), 0));
  // Find what the board starts out touching, so the first frame knows it's on the ground.
  sim.world.step(0);
  const gauge = createFootForceGauge(sim);
  const standingWeight = geo.board.riderMass * 9.81;

  const feet = footPositions(geo);
  const leftEdge = surfacePoint(geo, range.from).x;
  const rightEdge = surfacePoint(geo, range.to).x;
  const poses = [];
  let kick = null;
  let action = 'Rolling';
  const startKick = (parts, t) => { kick = { parts, start: t }; };
  /** Each foot's push during the current kick, or null when not kicking. */
  const kickPushes = (t) => {
    if (!kick) return null;
    let elapsed = t - kick.start;
    for (const part of kick.parts) {
      if (elapsed < part.seconds) return part;
      elapsed -= part.seconds;
    }
    kick = null;
    return null;
  };

  for (let t = 0; t < PHYSICS_MAX_S; t += PHYSICS_STEP_S) {
    const pose = poseFromDeck(geo, sim.deck);
    const velocity = vecCm(sim.deck.getLinearVelocity());
    const nearX = Math.min(pose.back.x, pose.front.x);
    const farX = Math.max(pose.back.x, pose.front.x);
    const state = { cog: vecCm(sim.deck.getWorldCenter()), speed: len(velocity) };
    if ((velocity.x < 0 && farX < leftEdge) || (velocity.x > 0 && nearX > rightEdge)) {
      poses.push({ ...pose, rider: { ...poses[poses.length - 1]?.rider, ...feet, ...state } });
      break;
    }
    riderScript?.({
      t, pose, velocity,
      setFrontShare: sim.setFrontShare,
      kick: (parts) => startKick(parts, t),
      say: (text) => { action = text; },
    });

    // Feet only kick against the board while it's on something; in the air the rider steers it instead.
    const onSomething = touchingAnything(sim.deck);
    const pushes = onSomething ? kickPushes(t) : null;
    const kickExtra = pushes ? sim.pushFeet(pushes) : null;
    if (!wheelsTouching(sim)) applyAirControl(geo, sim.deck);
    const forces = gauge.forces(kickExtra);
    const loads = standingWeight > 0
      ? { front: forces.front / standingWeight, back: forces.back / standingWeight }
      : { front: 0, back: 0 };
    poses.push({ ...pose, rider: { ...feet, ...state, loads, forces, action: onSomething ? action : 'In the air' } });
    sim.world.step(PHYSICS_STEP_S, 8, 3);
    gauge.measure();
  }
  return poses;
}

/** Rolls in at the starting speed with the rider's weight fixed. Fast enough, the board gets air off the lip. */
function physicsRollTimeline(geo, range) {
  const poses = simulateBoard(geo, range);
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)]);
}

const ROCK_ACTIONS = {
  lift: 'Kicking the tail to lift the nose over the coping',
  place: 'Weight forward to set the front truck on the deck',
  stall: 'Rocking on the coping',
  return: 'Kicking the tail to lift back over the coping',
  away: 'Rolling away',
};

/**
 * Rolls in and up over the coping, kicking the tail to lift the nose over only if the front wheels catch on it. Once
 * the front truck is past, the rider moves their weight forward to set it down on the deck with the board resting on
 * the coping, holds it there for a moment, then kicks the tail to lift the front wheels back over and rolls away
 * fakie, kicking again if the front wheels catch on the coping.
 * How far over the coping the board gets depends on the speed.
 */
function physicsRockToFakieTimeline(geo, range) {
  const { poses, outcome } = simulateRockToFakie(geo, range);
  const notes = {
    short: 'Not fast enough to reach the coping for a rock to fakie.',
    over: 'Too fast for a rock to fakie: the board went right over onto the deck.',
  };
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)], notes[outcome] ?? null);
}

/**
 * Simulates the rock to fakie described above. The outcome is 'rock' when it works, 'short' when the board doesn't
 * reach the coping, and 'over' when it goes right over onto the deck.
 */
function simulateRockToFakie(geo, range) {
  const coping = copingCentre(geo);
  const copingRadius = geo.coping.diameter / 2;
  const wheelRadius = geo.board.deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  let phase = 'approach';
  let phaseStart = 0;
  let reachedCoping = false;
  let rolledOnto = false;

  const poses = simulateBoard(geo, range, ({ t, pose, velocity, setFrontShare, kick, say }) => {
    if (rolledOnto) return;
    const frontAxle = add(pose.front, mul(pose.v, wheelRadius));
    const alongBoard = dot(velocity, pose.u);
    const enter = (next) => { phase = next; phaseStart = t; say(ROCK_ACTIONS[next]); };
    const frontPastCoping = frontAxle.x > coping.x + copingRadius;

    const backAxle = add(pose.back, mul(pose.v, wheelRadius));
    if (['place', 'stall', 'return'].includes(phase) && backAxle.x > coping.x + copingRadius + wheelRadius) {
      // Came in too fast: the whole board has gone over onto the deck, so ride away along it.
      rolledOnto = true;
      setFrontShare(geo.board.frontShare);
      say('Went right over onto the deck');
    } else if (phase === 'approach' && !frontPastCoping && alongBoard > 0 && alongBoard < ROCK_CATCH_SPEED_CM_PER_S
      && len(sub(frontAxle, coping)) < wheelRadius + copingRadius + 1) {
      // The front wheels are catching on the face of the coping: kick the nose up over it.
      enter('lift');
      setFrontShare(0.3);
      kick(LIFT_KICK);
    } else if ((phase === 'approach' || phase === 'lift') && frontPastCoping) {
      enter('place');
      reachedCoping = true;
      setFrontShare(0.85);
    } else if (phase === 'place' && alongBoard <= 0) {
      enter('stall');
    } else if (phase === 'stall' && t - phaseStart >= ROCK_STALL_S) {
      enter('return');
      setFrontShare(0.15);
      kick(RETURN_KICK);
    } else if (phase === 'return' && t - phaseStart >= ROCK_RETRY_S && Math.abs(alongBoard) < ROCK_STUCK_SPEED_CM_PER_S) {
      // The front wheels have caught on the coping on the way back; kick again.
      enter('return');
      kick(RETURN_KICK);
    } else if ((phase === 'return' && frontAxle.x < coping.x - copingRadius - wheelRadius)
      || ((phase === 'approach' || phase === 'lift') && alongBoard < 0)) {
      enter('away');
      setFrontShare(geo.board.frontShare);
    }
  });
  let outcome = 'rock';
  if (!reachedCoping) outcome = 'short';
  if (rolledOnto) outcome = 'over';
  return { poses, outcome };
}

// The fastest starting speed the speed searches try, in cm/s (about 45 mph).
const SEARCH_MAX_SPEED_CM_PER_S = 2000;
// How closely the speed searches pin down a speed, in cm/s (about 0.05 mph).
const SEARCH_PRECISION_CM_PER_S = 2;

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
 * Finds where a yes/no answer about the starting speed changes, between a speed where it's no and one where it's
 * yes, by halving the gap. A generator, so the caller can run one simulation at a time and keep the page responsive;
 * it returns the speed at which the answer becomes yes.
 */
function* searchSpeed(answer, no, yes) {
  while (Math.abs(yes - no) > SEARCH_PRECISION_CM_PER_S) {
    const middle = (no + yes) / 2;
    if (answer(middle)) yes = middle; else no = middle;
    yield;
  }
  return yes;
}

/**
 * Works out, by simulating, the lowest starting speed that rolls onto the deck, and the range of starting speeds for
 * which the rock to fakie works. Null where there isn't one within SEARCH_MAX_SPEED_CM_PER_S. A generator that
 * yields after each simulation; its result is { roll, rock: { from, to } }.
 */
function* speedsNeeded(geo) {
  const max = SEARCH_MAX_SPEED_CM_PER_S;
  const roll = rollReachesDeck(geo, max) ? yield* searchSpeed((speed) => rollReachesDeck(geo, speed), 0, max) : null;
  yield;

  const rockOutcome = (speed) => simulateRockToFakie(atSpeed(geo, speed), rideRange(geo)).outcome;
  // Lowest speed that gets past falling short, then the lowest speed from there that goes right over.
  if (rockOutcome(max) === 'short') return { roll, rock: null };
  yield;
  const reaches = yield* searchSpeed((speed) => rockOutcome(speed) !== 'short', 0, max);
  if (rockOutcome(reaches) !== 'rock') return { roll, rock: null };
  yield;
  const goesOver = rockOutcome(max) === 'over'
    ? yield* searchSpeed((speed) => rockOutcome(speed) === 'over', reaches, max)
    : null;
  return { roll, rock: { from: reaches, to: goesOver === null ? max : goesOver - SEARCH_PRECISION_CM_PER_S } };
}
