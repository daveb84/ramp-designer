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
// How close the front wheels get to the coping before the rider kicks the nose up over it.
const ROCK_LIFT_LEAD_CM = 8;
// How long the board stays on the coping before the rider kicks back off it.
const ROCK_STALL_S = 0.3;
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
  const { wheelbase } = geo.board;
  const overhang = wheelbase * BOARD_OVERHANG_PER_WHEELBASE;
  return { backFoot: -overhang * BACK_FOOT_TAIL_FRACTION, frontFoot: wheelbase };
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
 * Builds the world with the board at the given starting pose. Returns the bodies and a function to change how the
 * rider's weight is split between the feet.
 */
function buildWorld(geo, startPose) {
  const { wheelbase, deckUndersideHeight, riderMass } = geo.board;
  const overhang = wheelbase * BOARD_OVERHANG_PER_WHEELBASE;
  const wheelRadius = deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  const world = new planck.World({ gravity: planck.Vec2(0, -9.81) });

  const ramp = world.createBody();
  addRamp(geo, ramp, 10000);

  const { u, v } = startPose;
  const onBoard = (along, up) => add(add(startPose.back, mul(u, along)), mul(v, up));

  // The body's origin is the middle of the deck, half way between the axles.
  const deckLength = wheelbase + overhang * 2;
  const deck = world.createBody({
    type: 'dynamic',
    position: vecM(onBoard(wheelbase / 2, deckUndersideHeight + BOARD_THICKNESS_CM / 2)),
    angle: Math.atan2(u.y, u.x),
  });
  deck.createFixture(new planck.Box(toM(deckLength / 2), toM(BOARD_THICKNESS_CM / 2)), {
    density: DECK_MASS_KG / (toM(deckLength) * toM(BOARD_THICKNESS_CM)),
    friction: DECK_FRICTION,
  });

  // The feet carry the rider's weight but don't collide with anything.
  const feet = footPositions(geo);
  const footRadiusM = 0.02;
  const footArea = Math.PI * footRadiusM * footRadiusM;
  const foot = (along) => deck.createFixture(
    new planck.Circle(planck.Vec2(toM(along - wheelbase / 2), toM(BOARD_THICKNESS_CM / 2)), footRadiusM),
    { density: 0, filterMaskBits: 0 },
  );
  const frontFoot = foot(feet.frontFoot);
  const backFoot = foot(feet.backFoot);
  const footPoints = {
    front: planck.Vec2(toM(feet.frontFoot - wheelbase / 2), toM(BOARD_THICKNESS_CM / 2)),
    back: planck.Vec2(toM(feet.backFoot - wheelbase / 2), toM(BOARD_THICKNESS_CM / 2)),
  };
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
   * it is split between the feet, so only the difference is added.
   */
  const pushFeet = (pushes) => {
    const into = deck.getWorldVector(planck.Vec2(0, -1));
    const weight = riderMass * 9.81;
    const extra = { front: pushes.front - frontShare, back: pushes.back - (1 - frontShare) };
    for (const side of ['front', 'back']) {
      deck.applyForce(planck.Vec2.mul(into, extra[side] * weight), deck.getWorldPoint(footPoints[side]));
    }
  };

  return { world, deck, wheelFixtures, setFrontShare, getFrontShare: () => frontShare, pushFeet };
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
 * Simulates the board rolling in from back wheel position range.from at the starting speed. Stops once the board
 * has left the visible area (rolled back off the left, or along the deck past range.to), or after PHYSICS_MAX_S.
 * The rider script is called every step with the current state and can shift the rider's weight, start a kick,
 * or describe what the rider is doing. Returns a pose every PHYSICS_STEP_S, each with where the feet are, how hard
 * each pushes as a multiple of the rider's weight, the centre of gravity of board and rider, the speed, and what
 * the rider is doing.
 */
function simulateBoard(geo, range, riderScript) {
  const start = ridePose(geo, range.from);
  const sim = buildWorld(geo, start);
  sim.setFrontShare(geo.board.frontShare);
  sim.deck.setLinearVelocity(planck.Vec2(toM(geo.board.speed), 0));

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

    // Feet only push against the board while it's on something; in the air the rider steers it instead.
    const share = sim.getFrontShare();
    let loads = { front: share, back: 1 - share };
    const onSomething = touchingAnything(sim.deck);
    if (onSomething) {
      const pushes = kickPushes(t);
      if (pushes) {
        sim.pushFeet(pushes);
        loads = { front: pushes.front, back: pushes.back };
      }
    }
    if (!wheelsTouching(sim)) applyAirControl(geo, sim.deck);
    poses.push({ ...pose, rider: { ...feet, ...state, loads, action: onSomething ? action : 'In the air' } });
    sim.world.step(PHYSICS_STEP_S, 8, 3);
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
 * Rolls in, then the rider: kicks the tail as the front wheels near the coping to flick the nose up over it, moves
 * their weight forward once the front truck is past to set it down on the deck with the board resting on the coping,
 * holds it there for a moment, then kicks the tail again to lift the front wheels back over and rolls away fakie,
 * kicking again if the front wheels catch on the coping.
 * How far over the coping the board gets depends on the speed.
 */
function physicsRockToFakieTimeline(geo, range) {
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
    } else if (phase === 'approach' && len(sub(frontAxle, coping)) < wheelRadius + copingRadius + ROCK_LIFT_LEAD_CM) {
      enter('lift');
      setFrontShare(0.3);
      kick(LIFT_KICK);
    } else if (phase === 'lift' && frontPastCoping) {
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
  let note = null;
  if (!reachedCoping) note = 'Not fast enough to reach the coping for a rock to fakie.';
  if (rolledOnto) note = 'Too fast for a rock to fakie: the board went right over onto the deck.';
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)], note);
}
