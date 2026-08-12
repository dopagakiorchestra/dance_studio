/**
 * 接地の解決（脚の逆運動学）。
 *
 * ここができるまで、このアプリには床という概念が無かった。脚は骨盤から
 * ぶら下がっているだけで、体重移動に見えていたものは全部「腰を動かした分を
 * 太ももの角度で打ち消す」という近似だった。実測では足が床を腰高の 5.5%
 * 突き抜けていて、これが「人形っぽさ」の残りの正体だった。
 *
 * やることは3つ。
 *
 * 1. 接地している足の裏を床と平行にする（床に刺さって見えるのを直す）
 * 2. 床より下へ行く足を引き上げる。両足とも沈んでいるなら体ごと持ち上げ、
 *    片足だけならその脚を縮める（2ボーンIK）
 * 3. 床のすぐ上に浮いている足を、床まで下ろす
 *
 * **ポーズは時刻だけの関数のままにしてある。** 「前のフレームで足を置いた
 * 場所」を覚えると、画角の走査も動画の書き出しもランダムアクセスできなく
 * なるし、同じ時刻を2回サンプルして違う結果が出るようになる。そのため
 * ここで直せるのは縦方向だけで、接地した足が横へ滑るのは残っている。
 */

import {
  composeRot,
  eulerOf,
  HIP_HEIGHT,
  invertRot,
  jointRadiusOf,
  rotationMatrix,
  solvePose,
  type Body,
  type JointName,
  type Mat3,
  type Pose,
  type PosedSkeleton,
  type Rot,
  type Vec3,
} from "./skeleton";

/** 床の高さ。骨格は「直立で足の裏が y=0」に来るよう作られている。 */
const GROUND_Y = 0;

/** 太もも（股関節→膝）の長さ。体型の脚倍率を掛けて使う。 */
const THIGH_LEN = 0.45;

/**
 * すね（膝→足首）の長さ。
 * calf はふくらはぎの膨らみを作るための中間点で曲がらないので、足し込む。
 */
const SHIN_LEN = 0.15 + 0.28;

/**
 * 床からこの高さまでにある足は「接地しているつもり」とみなして床へ下ろす
 * （腰高に対する比率ではなく脚の倍率でスケールする）。
 *
 * 広げると、わざと上げた足まで引っぱられてステップが潰れる。実測では
 * 上げた足は腰高の 33% まで行くので、そこに触らない値にしてある。
 */
const PLANT_BAND = 0.035;

/**
 * 足首をこれ以上寝かせてある振りには、足の裏をならす補正を掛けない（度）。
 *
 * つま先立ちやかかと上げは振り付け側が意図してやっているので、
 * 水平に戻してしまうと振りが消える。肘の `ELBOW_AUTHORED` と同じ考え方。
 */
const FOOT_AUTHORED = 22;

/** 脚を縮めきる手前で止める下限（伸ばし切った長さに対する割合）。 */
const MIN_EXTENSION = 0.4;

const DEGREES = 180 / Math.PI;

interface LegDef {
  hip: JointName;
  knee: JointName;
  ankle: JointName;
  toe: JointName;
}

const LEGS: LegDef[] = [
  { hip: "thighL", knee: "shinL", ankle: "footL", toe: "toeL" },
  { hip: "thighR", knee: "shinR", ankle: "footR", toe: "toeR" },
];

// --- ベクトル ---

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function scale(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  return len < 1e-9 ? null : scale(v, 1 / len);
}

/** v から u 方向の成分を抜いて正規化する。 */
function perpendicular(v: Vec3, u: Vec3): Vec3 | null {
  const k = dot(v, u);
  return normalize({ x: v.x - u.x * k, y: v.y - u.y * k, z: v.z - u.z * k });
}

/** 行列の逆で回す（ワールド → 親のローカル）。 */
function unrotate(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- 接地の判定 ---

/**
 * その脚の、床からの余裕。負なら床にめり込んでいる。
 *
 * 足はカプセルの端＝球で描かれるので、一番低い点は関節の真下、半径のぶん
 * だけ下になる。足首とつま先の2点を見れば足の裏の最下点が取れる。
 */
function clearanceOf(skeleton: PosedSkeleton, leg: LegDef, radius: Radii): number {
  const heel = skeleton.pos[leg.ankle].y - radius[leg.ankle];
  const toe = skeleton.pos[leg.toe].y - radius[leg.toe];
  return Math.min(heel, toe) - GROUND_Y;
}

type Radii = Record<JointName, number>;

/** 接地しているとみなす度合い 0..1。境目で角度が飛ばないよう滑らかに落とす。 */
function plantWeight(clearance: number, band: number): number {
  if (clearance <= 0) return 1;
  if (clearance >= band) return 0;
  const t = 1 - clearance / band;
  return t * t * (3 - 2 * t);
}

// --- 足の裏をならす ---

/**
 * 接地している足の裏を床と平行にする補正（度）。足首の X 回転に足す。
 *
 * 骨格の足は、足首よりつま先のほうが低くなるように作ってある（描かれる
 * カプセルの半径まで含めると 7 度ほど前下がり）。そのまま床に置くと
 * つま先立ちに見えるので、接地している間だけ水平に寝かせる。
 *
 * 足首の X 回転は「＋でつま先が下がる」。足の裏が前下がり（つま先が低い）
 * なら傾きは負で、そのぶんを足すと水平に戻る。
 */
function levelSole(skeleton: PosedSkeleton, leg: LegDef, radius: Radii): number {
  const heel = skeleton.pos[leg.ankle];
  const toe = skeleton.pos[leg.toe];
  const rise = toe.y - radius[leg.toe] - (heel.y - radius[leg.ankle]);
  const run = Math.hypot(toe.x - heel.x, toe.z - heel.z);
  if (run < 1e-6) return 0;
  return Math.atan2(rise, run) * DEGREES;
}

// --- 2ボーンIK ---

/**
 * 股関節を固定したまま、足首を狙った位置へ持っていく脚の解。
 *
 * 膝の曲がる向きは、いま曲がっている向きをそのまま使う。定数（前向き）で
 * 決め打ちにすると、振り付けが脚を開いているところで膝の向きが変わって
 * しまう。狙いが今の位置と同じなら、答えも今のポーズと同じになる。
 *
 * @returns 太ももの新しい回転と、膝に足す曲げ角（度）
 */
function solveLeg(
  skeleton: PosedSkeleton,
  leg: LegDef,
  target: Vec3,
  upper: number,
  lower: number,
): { thigh: Rot; kneeDelta: number } | null {
  const hipsRot = skeleton.rot.hips;
  const origin = skeleton.pos[leg.hip];

  // 腰のローカル座標で解く。体の向き（hips の Y 回転）はこれで吸収される
  const now = unrotate(hipsRot, sub(skeleton.pos[leg.ankle], origin));
  const want = unrotate(hipsRot, sub(target, origin));
  const knee = unrotate(hipsRot, sub(skeleton.pos[leg.knee], origin));

  const nowDir = normalize(now);
  const wantDir = normalize(want);
  if (!nowDir || !wantDir) return null;

  const reach = upper + lower;
  const nowLen = clamp(length(now), reach * MIN_EXTENSION, reach);
  const wantLen = clamp(length(want), reach * MIN_EXTENSION, reach);

  // 膝の曲がり（伸ばし切りが 0 度）。余弦定理
  const flexOf = (len: number): number =>
    180 - Math.acos(clamp((upper * upper + lower * lower - len * len) / (2 * upper * lower), -1, 1)) * DEGREES;
  const kneeDelta = flexOf(wantLen) - flexOf(nowLen);

  // いまの膝が「股関節→足首」の線からどちら側へ出ているか。これが曲がる面
  const bend = perpendicular(knee, nowDir) ?? { x: 0, y: 0, z: 1 };
  const hinge = perpendicular(cross(nowDir, bend), wantDir);
  if (!hinge) return null;

  // 太ももは「股関節→足首」の線から、膝の出ている側へ φ だけ傾く
  const phi = Math.acos(
    clamp((upper * upper + wantLen * wantLen - lower * lower) / (2 * upper * wantLen), -1, 1),
  );
  const toward = cross(hinge, wantDir);
  const thighDir = {
    x: wantDir.x * Math.cos(phi) + toward.x * Math.sin(phi),
    y: wantDir.y * Math.cos(phi) + toward.y * Math.sin(phi),
    z: wantDir.z * Math.cos(phi) + toward.z * Math.sin(phi),
  };

  // 太ももの回転行列を軸から組む。ローカルの -Y が骨の向き、X が膝の回転軸
  const axisY = scale(thighDir, -1);
  const axisX = scale(hinge, -1);
  const axisZ = cross(axisX, axisY);
  const m: Mat3 = [
    axisX.x, axisY.x, axisZ.x,
    axisX.y, axisY.y, axisZ.y,
    axisX.z, axisY.z, axisZ.z,
  ];
  return { thigh: eulerOf(m), kneeDelta };
}

/**
 * 太ももとすねを動かした分だけ足首を戻して、足の向きをそのまま保つ。
 *
 * これをしないと、脚を縮めた角度がそのまま足首に伝わって、せっかく水平に
 * した足の裏がまた傾く。腰から下の回転を組み直せば FK を回さずに求まる。
 */
function keepFootOrientation(
  footLocal: Rot,
  thighBefore: Rot,
  shinBefore: Rot,
  thighAfter: Rot,
  shinAfter: Rot,
): Rot {
  const before = composeRot(rotationMatrix(thighBefore), rotationMatrix(shinBefore));
  const after = composeRot(rotationMatrix(thighAfter), rotationMatrix(shinAfter));
  return eulerOf(composeRot(composeRot(invertRot(after), before), rotationMatrix(footLocal)));
}

// --- 本体 ---

function rotOf(pose: Pose, name: JointName): Rot {
  const r = pose.j?.[name];
  return r ? [r[0], r[1], r[2]] : [0, 0, 0];
}

/**
 * 足を床に置く。ポーズを受け取って、直したポーズを返す。
 *
 * FK を3回回す（元のポーズ・足の裏をならしたポーズ・IK の結果）。関節は
 * 26 個しかないので、これで重くなることはない。
 */
export function plantFeet(pose: Pose, body: Body): Pose {
  const radius = jointRadiusOf(body) as Radii;
  const band = PLANT_BAND * body.legs;
  const upper = THIGH_LEN * body.legs;
  const lower = SHIN_LEN * body.legs;

  // 1周目: 接地しているのはどちらの足か
  const first = solvePose(pose, body);
  const weights = LEGS.map((leg) => plantWeight(clearanceOf(first, leg, radius), band));
  if (weights.every((w) => w <= 0)) return pose;

  // 2周目: 接地している足の裏を床と平行にしてから、床との差を測り直す
  const leveled: Partial<Record<JointName, Rot>> = { ...pose.j };
  const footBefore: Rot[] = [];
  LEGS.forEach((leg, i) => {
    const foot = rotOf(pose, leg.ankle);
    footBefore.push(foot);
    if (weights[i] <= 0) return;
    // 振り付けが足首を寝かせているところは、意図した形なので触らない
    const damp = Math.max(0, 1 - Math.abs(foot[0]) / FOOT_AUTHORED);
    if (damp <= 0) return;
    leveled[leg.ankle] = [foot[0] + levelSole(first, leg, radius) * weights[i] * damp, foot[1], foot[2]];
  });
  const flat = solvePose({ root: pose.root, j: leveled }, body);

  const clearances = LEGS.map((leg) => clearanceOf(flat, leg, radius));

  // 両足とも沈んでいるなら、脚ではなく体が低すぎる。腰ごと持ち上げる。
  // 片足だけを縮めると、跳ねたように見えるし体重が乗って見えない
  const lift = Math.max(0, -Math.max(clearances[0], clearances[1]));

  const j: Partial<Record<JointName, Rot>> = { ...leveled };
  LEGS.forEach((leg, i) => {
    const clearance = clearances[i] + lift;
    // 持ち上げたあとも沈んでいるなら、その脚だけが長い。浮いている足は
    // 接地しているとみなした度合いだけ床へ下ろす
    const drop = clearance <= 0 ? clearance : clearance * weights[i];
    if (Math.abs(drop) < 1e-5) return;

    const ankle = flat.pos[leg.ankle];
    const solved = solveLeg(flat, leg, { x: ankle.x, y: ankle.y - drop, z: ankle.z }, upper, lower);
    if (!solved) return;

    const thighBefore = rotOf({ j: leveled }, leg.hip);
    const shinBefore = rotOf({ j: leveled }, leg.knee);
    const shinAfter: Rot = [shinBefore[0] + solved.kneeDelta, shinBefore[1], shinBefore[2]];
    j[leg.hip] = solved.thigh;
    j[leg.knee] = shinAfter;
    j[leg.ankle] = keepFootOrientation(
      leveled[leg.ankle] ?? footBefore[i],
      thighBefore,
      shinBefore,
      solved.thigh,
      shinAfter,
    );
  });

  const root = pose.root ?? {};
  return { root: { ...root, y: (root.y ?? HIP_HEIGHT) + lift / body.legs }, j };
}
