'use strict';

/*
 * The experimental body rider: lower legs, thighs and a torso (with the pelvis, trunk, and shoulders and head as
 * masses on it), joined at the ankles (to the board), knees and hips by muscles: damped springs driving each joint
 * towards a target angle, no harder than a person could. The targets come from a pose (where the rider wants their
 * weight, how deep they crouch, how far they lean their shoulders, how much they lift each knee), and a balance
 * controller moves the hips to keep the rider's weight over the chosen point between the feet.
 */

// Shares of the rider's weight and height (standard human proportions).
const BODY = {
  lowerLeg: { mass: 0.0465, length: 0.246 },
  thigh: { mass: 0.1, length: 0.245 },
  torso: { length: 0.288 },
  pelvisMass: 0.142,
  trunkMass: 0.355,
  upperMass: 0.182,
};
// Strongest each muscle can push, in N m. The ankles are weak, as a foot can only grip the board so hard.
const MUSCLE_TORQUE = { ankle: 20, knee: 300, hip: 300 };
// Muscles as springs with damping: stiffness in N m per radian off target, and damping in N m per radian per second.
const MUSCLE_STIFFNESS = { ankle: 40, knee: 800, hip: 600 };
const MUSCLE_DAMPING = { ankle: 4, knee: 60, hip: 50 };
const RIDER_SUBSTEPS = 4;
const RIDER_VELOCITY_ITERATIONS = 30;
const RIDER_POSITION_ITERATIONS = 10;
// Balance: how far the hips move per cm the weight is off target, how quickly a lasting error is taken out (per
// second), and how much its rate of change counts (seconds).
const BALANCE_GAIN = 1;
const BALANCE_INTEGRAL = 3;
const BALANCE_DAMPING = 0.1;
// Crouch: the legs reach this fraction of their full length standing (0) and in a deep crouch (1).
const STANDING_REACH = 0.95;
// How long the rider's body takes to follow the board's turns (the knees take up the difference meanwhile).
const FRAME_FOLLOW_S = 0.12;
const CROUCHED_REACH = 0.6;

/** A segment body from `start` to `end` (world cm), its own mass at its middle plus any extra masses along it. */
function segmentBody(world, start, end, ownMass, extras = []) {
  const length = len(sub(end, start));
  const body = world.createBody({ type: 'dynamic', position: vecM(start), angle: Math.atan2(end.y - start.y, end.x - start.x) });
  const masses = [{ at: length / 2, mass: ownMass, own: true }, ...extras];
  const total = masses.reduce((sum, m) => sum + m.mass, 0);
  const centre = masses.reduce((sum, m) => sum + m.at * m.mass, 0) / total;
  // Rotational inertia about the body's origin (its start): point masses, plus the segment's own spread.
  const inertia = masses.reduce((sum, m) => sum + m.mass * toM(m.at) ** 2, 0) + (ownMass * toM(length) ** 2) / 12;
  body.setMassData({ mass: total, center: planck.Vec2(toM(centre), 0), I: inertia });
  return { body, length };
}

/**
 * Where the rider's segments should point, as world angles, for a pose on a board at `pose`: the hips at (hipAlong,
 * hipHeight) above the deck in the board's frame, the torso leaning `lean` radians towards the nose, and each leg
 * bent `lift` cm more than reaching the hips needs, so a lifted knee pulls that foot (and the board) up towards them.
 * The knees bend outwards, the front one towards the nose and the back one towards the tail.
 */
function poseAngles(geo, pose, feet, deckTop, target, frameAngle = Math.atan2(pose.u.y, pose.u.x)) {
  const legLength = geo.rider.lowerLeg + geo.rider.thigh;
  const ankle = (along) => add(add(pose.back, mul(pose.u, along)), mul(pose.v, deckTop + deckRiseAt(geo, along)));
  // The hips and torso are placed in the rider's own frame, which follows the board but smoothly, so the knees soak
  // up the board's sudden turns rather than the whole body being flung round with it.
  const fu = { x: Math.cos(frameAngle), y: Math.sin(frameAngle) };
  const fv = { x: -fu.y, y: fu.x };
  const middleAlong = (feet.backFoot + feet.frontFoot) / 2;
  const middle = ankle(middleAlong);
  const hip = add(add(middle, mul(fu, target.hipAlong - middleAlong)), mul(fv, target.hipHeight));
  const leg = (along, lift, outward) => {
    const a = ankle(along);
    const toHip = sub(hip, a);
    const reach = Math.min(0.999 * legLength, Math.max(0.3 * legLength, len(toHip) - lift));
    const direction = Math.atan2(toHip.y, toHip.x);
    const { lowerLeg, thigh } = geo.rider;
    const bend = Math.acos(Math.min(1, Math.max(-1, (lowerLeg ** 2 + reach ** 2 - thigh ** 2) / (2 * lowerLeg * reach))));
    const end = add(a, mul({ x: Math.cos(direction), y: Math.sin(direction) }, reach));
    const knees = [direction + bend, direction - bend].map((angle) => add(a, mul({ x: Math.cos(angle), y: Math.sin(angle) }, lowerLeg)));
    const knee = dot(sub(knees[0], knees[1]), pose.u) * outward > 0 ? knees[0] : knees[1];
    return {
      lowerLeg: Math.atan2(knee.y - a.y, knee.x - a.x),
      thigh: Math.atan2(end.y - knee.y, end.x - knee.x),
    };
  };
  return {
    back: leg(feet.backFoot, target.backLift, -1),
    front: leg(feet.frontFoot, target.frontLift, 1),
    torso: Math.atan2(fv.y, fv.x) - target.lean,
  };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Adds the rider to a world with the board `deck` at `pose`, standing in `target`'s pose. Returns the bodies, joints,
 * and functions to drive the muscles towards a pose and to measure the rider.
 */
function addRider(geo, world, deck, pose, feet, target) {
  const { riderMass } = geo.board;
  const deckTop = geo.board.deckUndersideHeight + BOARD_THICKNESS_CM;
  const angles = poseAngles(geo, pose, feet, deckTop, target);
  const onBoard = (along, up) => add(add(pose.back, mul(pose.u, along)), mul(pose.v, up));
  const step = (from, angle, length) => add(from, mul({ x: Math.cos(angle), y: Math.sin(angle) }, length));

  const legs = {};
  let hipPoint = null;
  for (const side of ['back', 'front']) {
    const along = side === 'back' ? feet.backFoot : feet.frontFoot;
    const ankle = onBoard(along, deckTop + deckRiseAt(geo, along));
    const knee = step(ankle, angles[side].lowerLeg, geo.rider.lowerLeg);
    const hip = step(knee, angles[side].thigh, geo.rider.thigh);
    hipPoint = hipPoint ? mul(add(hipPoint, hip), 0.5) : hip;
    legs[side] = { ankle, knee, hip, along };
  }
  const torsoTop = step(hipPoint, angles.torso, geo.rider.torso);

  const parts = {};
  const joints = {};
  const motor = () => ({ referenceAngle: 0 });
  parts.torso = segmentBody(world, hipPoint, torsoTop, riderMass * BODY.trunkMass, [
    { at: 0, mass: riderMass * BODY.pelvisMass },
    { at: geo.rider.torso, mass: riderMass * BODY.upperMass },
  ]);
  for (const side of ['back', 'front']) {
    const leg = legs[side];
    parts[`${side}LowerLeg`] = segmentBody(world, leg.ankle, leg.knee, riderMass * BODY.lowerLeg.mass);
    parts[`${side}Thigh`] = segmentBody(world, leg.knee, hipPoint, riderMass * BODY.thigh.mass);
    joints[`${side}Ankle`] = world.createJoint(new planck.RevoluteJoint(motor(MUSCLE_TORQUE.ankle), deck, parts[`${side}LowerLeg`].body, vecM(leg.ankle)));
    joints[`${side}Knee`] = world.createJoint(new planck.RevoluteJoint(motor(MUSCLE_TORQUE.knee), parts[`${side}LowerLeg`].body, parts[`${side}Thigh`].body, vecM(leg.knee)));
    joints[`${side}Hip`] = world.createJoint(new planck.RevoluteJoint(motor(), parts[`${side}Thigh`].body, parts.torso.body, vecM(hipPoint)));
  }
  const bodies = Object.values(parts).map((p) => p.body);

  // The rider's own frame: the board's angle, smoothed.
  let frameAngle = deck.getAngle();
  /** Moves the rider's frame towards the board's angle over the given time. */
  const follow = (seconds) => {
    frameAngle += wrapAngle(deck.getAngle() - frameAngle) * Math.min(1, seconds / FRAME_FOLLOW_S);
  };
  /** Sets each muscle's speed to close the gap to the joint angles for a pose; boardOffset turns the board too. */
  const drive = (currentPose, wanted, boardOffset = 0) => {
    const a = poseAngles(geo, currentPose, feet, deckTop, wanted, frameAngle);
    const board = deck.getAngle() + boardOffset;
    // A muscle twists the two segments it joins towards its target angle, equal and opposite, as a damped spring no
    // stronger than the rider could manage.
    const set = (joint, targetAngle, kind) => {
      const error = wrapAngle(targetAngle - joint.getJointAngle());
      const rate = joint.getBodyB().getAngularVelocity() - joint.getBodyA().getAngularVelocity();
      const limit = MUSCLE_TORQUE[kind];
      const torque = Math.max(-limit, Math.min(limit, MUSCLE_STIFFNESS[kind] * error - MUSCLE_DAMPING[kind] * rate));
      joint.getBodyB().applyTorque(torque);
      joint.getBodyA().applyTorque(-torque);
    };
    for (const side of ['back', 'front']) {
      set(joints[`${side}Ankle`], wrapAngle(a[side].lowerLeg - board), 'ankle');
      set(joints[`${side}Knee`], wrapAngle(a[side].thigh - a[side].lowerLeg), 'knee');
      set(joints[`${side}Hip`], wrapAngle(a.torso - a[side].thigh), 'hip');
    }
  };

  /** The rider's centre of gravity (world cm) and total mass. */
  const centreOfGravity = () => {
    let mass = 0;
    let sum = { x: 0, y: 0 };
    for (const body of bodies) {
      mass += body.getMass();
      sum = add(sum, mul(vecCm(body.getWorldCenter()), body.getMass()));
    }
    return { cog: mul(sum, 1 / mass), mass };
  };

  /** Where the joints are (world cm), for drawing. */
  const skeleton = () => ({
    backAnkle: vecCm(joints.backAnkle.getAnchorA()),
    frontAnkle: vecCm(joints.frontAnkle.getAnchorA()),
    backKnee: vecCm(joints.backKnee.getAnchorA()),
    frontKnee: vecCm(joints.frontKnee.getAnchorA()),
    hip: vecCm(parts.torso.body.getPosition()),
    shoulder: vecCm(parts.torso.body.getWorldPoint(planck.Vec2(toM(geo.rider.torso), 0))),
  });

  /** How hard each foot pushes into the deck, in newtons: the ankle joint's push on the lower leg, along the deck's up. */
  const footForces = (inverseStep) => {
    const up = deck.getWorldVector(planck.Vec2(0, 1));
    return {
      back: planck.Vec2.dot(joints.backAnkle.getReactionForce(inverseStep), up),
      front: planck.Vec2.dot(joints.frontAnkle.getReactionForce(inverseStep), up),
    };
  };

  return { parts, joints, bodies, drive, follow, centreOfGravity, skeleton, footForces, deckTop };
}

/** Body dimensions in cm from the rider's height. */
function riderDimensions(heightCm) {
  return { lowerLeg: BODY.lowerLeg.length * heightCm, thigh: BODY.thigh.length * heightCm, torso: BODY.torso.length * heightCm };
}

/** The hip height above the deck for a crouch (0 standing to 1 deep), with the feet `stance` cm apart. */
function hipHeightFor(geo, stance, crouch) {
  const legLength = geo.rider.lowerLeg + geo.rider.thigh;
  const reach = legLength * (STANDING_REACH + (CROUCHED_REACH - STANDING_REACH) * crouch);
  return Math.sqrt(Math.max(1, reach ** 2 - (stance / 2) ** 2));
}

/**
 * Keeps the rider's weight over a chosen point along the board. With frictionless wheels, the gravity the rider feels
 * on the ramp (gravity plus the push of the curve) points straight into the deck, so their weight bears on the deck
 * directly below their centre of gravity, measured at right angles to the deck. Each step the hips move to bring that
 * point to the target: in proportion to how far off it is, taking out any lasting error, and damped by how fast it's
 * changing.
 */
function createBalance() {
  let offset = 0;
  let lastError = null;
  return {
    /** The hips' position along the board (cm from the back axle) to aim for, and where the weight bears now. */
    hipAlong(pose, cog, targetAlong, seconds, onSomething) {
      const bearing = dot(sub(cog, pose.back), pose.u);
      const error = targetAlong - bearing;
      if (onSomething) offset = Math.max(-30, Math.min(30, offset + BALANCE_INTEGRAL * error * seconds));
      const rate = lastError === null ? 0 : (error - lastError) / seconds;
      lastError = error;
      return { hipAlong: targetAlong + BALANCE_GAIN * error + offset + BALANCE_DAMPING * rate, bearing };
    },
  };
}

/**
 * Simulates the board and the body rider rolling in from back wheel position range.from at the starting speed, as
 * simulateBoard does for the pivot rider and with the same rider script. The rider holds the crouch and shoulder lean
 * set on the page; the script sets where they keep their weight. Twists aren't used. Each pose carries the rider's
 * skeleton for drawing, and the foot forces measured at the ankles.
 */
function simulateBoardWithBody(geo, range, riderScript) {
  const bodyGeo = { ...geo, rider: riderDimensions(geo.board.riderHeight) };
  const start = ridePose(bodyGeo, range.from);
  const { world, deck } = buildBoardWorld(bodyGeo, start);
  const feet = footPositions(bodyGeo);
  const stance = feet.frontFoot - feet.backFoot;
  const weightAlong = (share) => feet.backFoot + share * stance;
  let frontShare = 0.5;
  const stancePose = {
    hipAlong: weightAlong(frontShare),
    hipHeight: hipHeightFor(bodyGeo, stance, geo.board.crouch),
    lean: geo.board.lean,
    frontLift: 0,
    backLift: 0,
  };
  const rider = addRider(bodyGeo, world, deck, start, feet, stancePose);
  for (const body of [deck, ...rider.bodies]) body.setLinearVelocity(planck.Vec2(toM(geo.board.speed), 0));
  // Find what the board starts out touching, so the first frame knows it's on the ground.
  world.step(0);
  const balance = createBalance();
  const standingWeight = geo.board.riderMass * 9.81;
  const substep = PHYSICS_STEP_S / RIDER_SUBSTEPS;
  const smoothing = PHYSICS_STEP_S / (FOOT_FORCE_SMOOTHING_S + PHYSICS_STEP_S);
  let forces = { back: standingWeight / 2, front: standingWeight / 2 };
  let action = 'Rolling';

  const leftEdge = surfacePoint(bodyGeo, range.from).x;
  const rightEdge = surfacePoint(bodyGeo, range.to).x;
  const poses = [];
  for (let t = 0; t < PHYSICS_MAX_S; t += PHYSICS_STEP_S) {
    const boardNow = poseFromDeck(bodyGeo, deck);
    const velocity = vecCm(deck.getLinearVelocity());
    const { cog: riderCog, mass: riderMassNow } = rider.centreOfGravity();
    const cog = mul(add(mul(vecCm(deck.getWorldCenter()), deck.getMass()), mul(riderCog, riderMassNow)),
      1 / (deck.getMass() + riderMassNow));
    const state = { cog, speed: len(velocity), progress: frontProgress(bodyGeo, boardNow) };
    const nearX = Math.min(boardNow.back.x, boardNow.front.x);
    const farX = Math.max(boardNow.back.x, boardNow.front.x);
    if ((velocity.x < 0 && farX < leftEdge) || (velocity.x > 0 && nearX > rightEdge)) {
      poses.push({ ...boardNow, rider: { ...poses[poses.length - 1]?.rider, ...feet, ...state } });
      break;
    }
    const onSomething = touchingAnything(deck);
    riderScript?.({
      t,
      pose: boardNow,
      velocity,
      onSomething,
      setFrontShare: (share) => { frontShare = share; },
      twistFor: () => {},
      say: (text) => { action = text; },
    });

    const { hipAlong } = balance.hipAlong(boardNow, riderCog, weightAlong(frontShare), PHYSICS_STEP_S, onSomething);
    const wanted = { ...stancePose, hipAlong };
    const measured = { back: 0, front: 0 };
    for (let i = 0; i < RIDER_SUBSTEPS; i++) {
      rider.follow(substep);
      rider.drive(poseFromDeck(bodyGeo, deck), wanted);
      world.step(substep, RIDER_VELOCITY_ITERATIONS, RIDER_POSITION_ITERATIONS);
      const ankle = rider.footForces(1 / substep);
      measured.back += ankle.back / RIDER_SUBSTEPS;
      measured.front += ankle.front / RIDER_SUBSTEPS;
    }
    forces = {
      back: forces.back + (measured.back - forces.back) * smoothing,
      front: forces.front + (measured.front - forces.front) * smoothing,
    };
    const shown = { back: Math.max(0, forces.back), front: Math.max(0, forces.front) };
    const loads = standingWeight > 0 ? { back: shown.back / standingWeight, front: shown.front / standingWeight } : { back: 0, front: 0 };
    poses.push({
      ...boardNow,
      rider: { ...feet, ...state, loads, forces: shown, skeleton: rider.skeleton(), action: onSomething ? action : 'In the air' },
    });
  }
  return poses;
}
