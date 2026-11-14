'use strict';

/*
 * Rigid-body simulation of the board and rider using planck.js (a port of Box2D). planck works in metres and
 * kilograms; the rest of the app works in cm, so positions are converted on the way in and out.
 *
 * The rider's weight sits on the deck as two point masses, one at each foot: the front foot over the front truck
 * and the back foot on the tail, just behind the back truck. Board, wheels and rider are one rigid body.
 */

const PHYSICS_STEP_S = SIM_STEP_S;
const PHYSICS_MAX_S = 15;
const DECK_MASS_KG = 1.6;
// Each truck with its pair of wheels
const TRUCK_MASS_KG = 0.9;
// Maple sliding on steel coping
const DECK_FRICTION = 0.3;
// Where the back foot stands, behind the back axle, as a fraction of the tail's length.
const BACK_FOOT_TAIL_FRACTION = 0.5;
const ROCK_LIFT_CLEARANCE_CM = 3;
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

/** The riding surface as a chain: ground in front, the transition, any vert, then the deck. */
function rampChain(geo, runOut) {
  const points = [{ x: -runOut, y: 0 }, { x: 0, y: 0 }];
  const segments = Math.max(8, Math.ceil((geo.angleRad * 180) / Math.PI));
  for (let i = 1; i <= segments; i++) {
    const phi = (geo.angleRad * i) / segments;
    points.push({ x: geo.radius * Math.sin(phi), y: geo.radius * (1 - Math.cos(phi)) });
  }
  if (geo.vertHeight > 0) points.push({ x: geo.groundLength, y: geo.height });
  points.push({ x: geo.groundLength + runOut, y: geo.height });
  return new planck.Chain(points.map(vecM), false);
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
  ramp.createFixture(rampChain(geo, 10000), { friction: DECK_FRICTION });
  const coping = copingCentre(geo);
  ramp.createFixture(new planck.Circle(vecM(coping), toM(geo.coping.diameter / 2)), { friction: DECK_FRICTION });

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

  return { world, deck, wheelFixtures, setFrontShare, getFrontShare: () => frontShare };
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
 * The rider script is called every step with the current state and can shift the rider's weight.
 * Returns a pose every PHYSICS_STEP_S, each with where the feet are and the share of weight on each.
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
  for (let t = 0; t < PHYSICS_MAX_S; t += PHYSICS_STEP_S) {
    const pose = poseFromDeck(geo, sim.deck);
    const share = sim.getFrontShare();
    poses.push({ ...pose, rider: { ...feet, loads: { front: share, back: 1 - share } } });
    const velocity = vecCm(sim.deck.getLinearVelocity());
    const nearX = Math.min(pose.back.x, pose.front.x);
    const farX = Math.max(pose.back.x, pose.front.x);
    if ((velocity.x < 0 && farX < leftEdge) || (velocity.x > 0 && nearX > rightEdge)) break;
    riderScript?.({ t, pose, velocity, setFrontShare: sim.setFrontShare });
    if (!wheelsTouching(sim)) applyAirControl(geo, sim.deck);
    sim.world.step(PHYSICS_STEP_S, 8, 3);
  }
  return poses;
}

/** Rolls in at the starting speed with the rider's weight fixed. Fast enough, the board gets air off the lip. */
function physicsRollTimeline(geo, range) {
  const poses = simulateBoard(geo, range);
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)]);
}

/**
 * Rolls in, then the rider: leans back to lift the nose as the front wheels reach the coping, shifts their weight
 * forward once the front truck is past the coping to set the board down on it, then leans back again as the board
 * stops to roll away fakie. How far over the coping the board gets depends on the speed.
 */
function physicsRockToFakieTimeline(geo, range) {
  const coping = copingCentre(geo);
  const copingRadius = geo.coping.diameter / 2;
  const wheelRadius = geo.board.deckUndersideHeight * WHEEL_RADIUS_PER_DECK_UNDERSIDE_HEIGHT;
  let phase = 'approach';
  let reachedCoping = false;

  const poses = simulateBoard(geo, range, ({ pose, velocity, setFrontShare }) => {
    const frontAxle = add(pose.front, mul(pose.v, wheelRadius));
    const alongBoard = dot(velocity, pose.u);
    if (phase === 'approach' && len(sub(frontAxle, coping)) < wheelRadius + copingRadius + ROCK_LIFT_CLEARANCE_CM) {
      phase = 'lift';
      setFrontShare(0.05);
    } else if (phase === 'lift' && frontAxle.x > coping.x + copingRadius) {
      phase = 'rock';
      reachedCoping = true;
      setFrontShare(0.9);
    } else if (phase === 'rock' && alongBoard <= 0) {
      phase = 'fakie';
      setFrontShare(0.2);
    } else if ((phase === 'fakie' && frontAxle.x < coping.x - copingRadius - wheelRadius)
      || ((phase === 'approach' || phase === 'lift') && alongBoard < 0)) {
      phase = 'away';
      setFrontShare(geo.board.frontShare);
    }
  });
  const note = reachedCoping ? null : 'Not fast enough to reach the coping for a rock to fakie.';
  return timelineFromPoses([...poses, ...holdLast(poses, END_HOLD_S)], note);
}
