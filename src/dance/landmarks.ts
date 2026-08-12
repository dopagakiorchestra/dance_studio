/**
 * 姿勢推定の点群を、この骨格のポーズに移す（リターゲット）。
 *
 * MediaPipe Pose が返すのは 33 個の点で、こちらが必要なのは関節の回転。
 * **点をそのまま関節位置にすると骨の長さが毎コマ変わる**ので、位置は使わず
 * 「骨の向き」だけを取り出して回転に直す。こうすると被写体の体格がこちらの
 * 骨格と違っても、比率の違いが出ない（腕が長い人の動きでも腕は伸びない）。
 *
 * ## 座標系の違い
 *
 * MediaPipe の world landmarks は「腰の中点が原点・メートル・画像と同じ向き」。
 * つまり x は画面右、y は下、z はカメラに近いほど小さい。こちらは Y が上、
 * Z がキャラの正面、X がキャラの左なので、`toWorld()` で入れ替える。
 *
 * ## ねじれ（twist）の決め方
 *
 * 骨の向きだけでは軸まわりのねじれが決まらない。腕と脚は**曲がっている面**が
 * 分かるので、そこから決める（上腕のねじれは肘がどちら側へ出ているかで決まる）。
 * 胴と頭は肩・腰・耳の並びから横方向を取る。ここを適当にすると、向きは合って
 * いるのに肘が横向きに折れる、という壊れ方をする。
 */

import {
  blendPose,
  composeRot,
  eulerOf,
  invertRot,
  rotationMatrix,
  type JointName,
  type Mat3,
  type Pose,
  type Rot,
  type Vec3,
} from "./skeleton";

/** 使う点の番号（MediaPipe Pose の 33 点のうち）。 */
export const LM = {
  nose: 0,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  pinkyL: 17,
  pinkyR: 18,
  indexL: 19,
  indexR: 20,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
  toeL: 31,
  toeR: 32,
} as const;

/** 推定器が返す1点。visibility は 0..1 で、低いところは信用しない。 */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** この骨格の脚の長さ（股関節→足首）。腰の高さを合わせるのに使う。 */
const LEG_LENGTH = 0.88;

/** 直立時の腰の高さ。`skeleton.ts` の HIP_HEIGHT と同じ。 */
const HIP_HEIGHT = 0.96;

/**
 * 骨盤が上体の傾きにどれだけ付いていくか 0..1。
 *
 * 点群からは骨盤の前後の傾きが直接は取れない（腰の2点だけでは軸まわりが
 * 決まらない）。素直に「腰の中点→肩の中点」を骨盤の上向きにすると、
 * **上体を前に倒しただけで骨盤ごと回り、脚が後ろへ振れる**。
 * 実際そうなって、取り込んだ動きが元より大きく傾いた。
 *
 * 上向きの基準を鉛直寄りにして、上体の傾きは背骨と胸に持たせる。
 */
const PELVIS_FOLLOW = 0.3;

/**
 * この可視度を下回る点は使わない。
 * 隠れている手足を無理に合わせると、そこだけ暴れる。
 */
const MIN_VISIBILITY = 0.5;

// --- ベクトル ---

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const mid = (a: Vec3, b: Vec3): Vec3 => mul(add(a, b), 0.5);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function unit(v: Vec3): Vec3 | null {
  const l = len(v);
  return l < 1e-9 ? null : mul(v, 1 / l);
}

/** v から u 方向の成分を抜いて正規化する。 */
function ortho(v: Vec3, u: Vec3): Vec3 | null {
  return unit(sub(v, mul(u, dot(v, u))));
}

/**
 * MediaPipe の座標をこちらの座標へ。
 * x はそのまま（画面右＝キャラの左）、y と z は向きが逆。
 */
export function toWorld(p: Landmark): Vec3 {
  return { x: p.x, y: -p.y, z: -p.z };
}

/**
 * 骨の向き `down`（ローカルの -Y が向く先）と横方向 `side`（ローカルの +X）から
 * ワールド回転行列を組む。side は down に直交化してから使う。
 */
function frame(down: Vec3, side: Vec3): Mat3 | null {
  const axisY = unit(mul(down, -1));
  if (!axisY) return null;
  const axisX = ortho(side, axisY);
  if (!axisX) return null;
  const axisZ = cross(axisX, axisY);
  return [
    axisX.x, axisY.x, axisZ.x,
    axisX.y, axisY.y, axisZ.y,
    axisX.z, axisY.z, axisZ.z,
  ];
}

/**
 * 骨の「休めの向き」がローカルの -Y でない関節のための版。
 *
 * ほとんどの骨はローカルの -Y へ伸びているが、**足だけは前へ伸びている**
 * （足首→つま先が (0,-0.042,0.17)）。-Y だと思って組むと 77 度ずれた向きに
 * なり、round trip で実際につま先が身長の 15% 分ずれていた。
 *
 * 休めの向きを -Y に持っていく回転 R0 を作り、目標の向きの枠に後ろから
 * 掛ける（R = R1・R0⁻¹）。こうすると R・休めの向き = 目標の向きになる。
 */
function alignFrame(restDir: Vec3, targetDir: Vec3, side: Vec3): Mat3 | null {
  const target = frame(targetDir, side);
  if (!target) return null;
  const rest = frame(restDir, { x: 1, y: 0, z: 0 });
  if (!rest) return null;
  return composeRot(target, invertRot(rest));
}

/** 足首→つま先の休めの向き。`skeleton.ts` の toe のオフセットと揃えること。 */
const FOOT_REST: Vec3 = { x: 0, y: -0.042, z: 0.17 };

/** 親のワールド回転を打ち消して、その関節のローカル回転（オイラー角）にする。 */
function localOf(parent: Mat3, world: Mat3): Rot {
  return eulerOf(composeRot(invertRot(parent), world));
}

interface Body3 {
  pos: Vec3[];
  ok: (i: number) => boolean;
}

/**
 * 腕または脚。曲がっている面からねじれを決める。
 *
 * 上腕のねじれは「肘がどちら側へ出ているか」で決まる。ここを固定値にすると、
 * 腕を上げたときに肘が横へ張り出す（`ground.ts` の膝と同じ話）。
 */
function limbChain(
  body: Body3,
  parentWorld: Mat3,
  upper: JointName,
  lower: JointName,
  a: number,
  b: number,
  c: number,
  fallbackSide: Vec3,
): { j: Partial<Record<JointName, Rot>>; lowerWorld: Mat3 } | null {
  if (!body.ok(a) || !body.ok(b) || !body.ok(c)) return null;
  const upperDir = unit(sub(body.pos[b], body.pos[a]));
  const lowerDir = unit(sub(body.pos[c], body.pos[b]));
  if (!upperDir || !lowerDir) return null;

  // 曲がる面の法線。伸び切っているときは決まらないので横方向で代用する
  const hinge = unit(cross(upperDir, lowerDir)) ?? unit(cross(upperDir, fallbackSide));
  const side = hinge ? cross(upperDir, hinge) : fallbackSide;

  const upperWorld = frame(upperDir, side);
  if (!upperWorld) return null;
  const lowerWorld = frame(lowerDir, side);
  if (!lowerWorld) return null;

  return {
    j: {
      [upper]: localOf(parentWorld, upperWorld),
      [lower]: localOf(upperWorld, lowerWorld),
    } as Partial<Record<JointName, Rot>>,
    lowerWorld,
  };
}

export interface RetargetOptions {
  /** 体型の脚倍率。腰の高さをこの骨格に合わせるのに使う。 */
  legs?: number;
}

/**
 * 点群1コマ分をポーズに直す。
 *
 * 腰の**横移動は取らない**。world landmarks は腰が原点なので平行移動が
 * そもそも入っておらず、画像側の点から取るとカメラの動きと混ざる。
 * 上下だけは足の位置から復元できるので、しゃがみは拾える。
 */
export function poseFromLandmarks(
  landmarks: Landmark[],
  opts: RetargetOptions = {},
): Pose | null {
  if (landmarks.length < 33) return null;
  const pos = landmarks.map(toWorld);
  const vis = (i: number): number => landmarks[i].visibility ?? 1;
  const body: Body3 = { pos, ok: (i) => vis(i) >= MIN_VISIBILITY };

  const need = [LM.shoulderL, LM.shoulderR, LM.hipL, LM.hipR];
  if (need.some((i) => !body.ok(i))) return null;

  const hipMid = mid(pos[LM.hipL], pos[LM.hipR]);
  const shoulderMid = mid(pos[LM.shoulderL], pos[LM.shoulderR]);

  // --- 腰の向き ---
  const hipSide = unit(sub(pos[LM.hipL], pos[LM.hipR]));
  const torsoUp = unit(sub(shoulderMid, hipMid));
  if (!hipSide || !torsoUp) return null;
  // 骨盤の上向きは鉛直寄りにする。上体の傾きをそのまま骨盤に入れると
  // 脚まで一緒に振れてしまう
  const pelvisUp = unit({
    x: torsoUp.x * PELVIS_FOLLOW,
    y: 1 - PELVIS_FOLLOW + torsoUp.y * PELVIS_FOLLOW,
    z: torsoUp.z * PELVIS_FOLLOW,
  }) ?? torsoUp;
  const hipsWorld = frame(mul(pelvisUp, -1), hipSide);
  if (!hipsWorld) return null;

  const j: Partial<Record<JointName, Rot>> = {};
  j.hips = eulerOf(hipsWorld);

  // --- 胴 ---
  // 肩の向きと腰の向きの差を、背骨と胸で分け合う。全部を胸に入れると
  // 胴が一枚板のまま折れて、体をひねる動きが板の回転に見える
  const shoulderSide = unit(sub(pos[LM.shoulderL], pos[LM.shoulderR])) ?? hipSide;
  const chestWorld = frame(mul(torsoUp, -1), shoulderSide);
  let spineWorld = hipsWorld;
  if (chestWorld) {
    const full = localOf(hipsWorld, chestWorld);
    const spineLocal: Rot = [full[0] * 0.4, full[1] * 0.4, full[2] * 0.4];
    j.spine = spineLocal;
    spineWorld = composeRot(hipsWorld, rotationMatrix(spineLocal));
    j.chest = localOf(spineWorld, chestWorld);
  }
  const chestFrame = chestWorld ?? spineWorld;

  // --- 頭 ---
  if (body.ok(LM.nose)) {
    const headUp = unit(sub(pos[LM.nose], shoulderMid));
    const earSide = body.ok(LM.earL) && body.ok(LM.earR)
      ? unit(sub(pos[LM.earL], pos[LM.earR]))
      : shoulderSide;
    // 鼻は前へ出ているので、そのまま上向きには使えない。首から鼻への向きを
    // 横方向で直交化して、頭の軸を作る
    const upAxis = earSide ? ortho(headUp ?? torsoUp, earSide) : null;
    const headWorld = frame(mul(upAxis ?? torsoUp, -1), earSide ?? shoulderSide);
    if (headWorld) {
      // 首と頭で分け合う。全部を首に入れると、首から頭までの間（0.11）が
      // まるごと余分に振られて、頭頂が身長の 14% ずれる
      const full = localOf(chestFrame, headWorld);
      const neckLocal: Rot = [full[0] * 0.5, full[1] * 0.5, full[2] * 0.5];
      j.neck = neckLocal;
      j.head = localOf(composeRot(chestFrame, rotationMatrix(neckLocal)), headWorld);
    }
  }

  // --- 腕 ---
  for (const [side, sh, el, wr, ix, pk, upper, lower, hand] of [
    [1, LM.shoulderL, LM.elbowL, LM.wristL, LM.indexL, LM.pinkyL, "upperArmL", "forearmL", "handL"],
    [-1, LM.shoulderR, LM.elbowR, LM.wristR, LM.indexR, LM.pinkyR, "upperArmR", "forearmR", "handR"],
  ] as Array<[number, number, number, number, number, number, JointName, JointName, JointName]>) {
    const arm = limbChain(body, chestFrame, upper, lower, sh, el, wr, mul(shoulderSide, side));
    if (!arm) continue;
    Object.assign(j, arm.j);
    if (body.ok(ix) && body.ok(pk)) {
      const handDir = unit(sub(mid(pos[ix], pos[pk]), pos[wr]));
      const palmSide = unit(sub(pos[ix], pos[pk]));
      if (handDir && palmSide) {
        const handWorld = frame(handDir, palmSide);
        if (handWorld) j[hand] = localOf(arm.lowerWorld, handWorld);
      }
    }
  }

  // --- 脚 ---
  for (const [side, hip, kn, an, toe, thigh, shin, foot] of [
    [1, LM.hipL, LM.kneeL, LM.ankleL, LM.toeL, "thighL", "shinL", "footL"],
    [-1, LM.hipR, LM.kneeR, LM.ankleR, LM.toeR, "thighR", "shinR", "footR"],
  ] as Array<[number, number, number, number, number, JointName, JointName, JointName]>) {
    const leg = limbChain(body, hipsWorld, thigh, shin, hip, kn, an, mul(hipSide, side));
    if (!leg) continue;
    Object.assign(j, leg.j);
    if (body.ok(toe)) {
      const footDir = unit(sub(pos[toe], pos[an]));
      if (footDir) {
        const footWorld = alignFrame(FOOT_REST, footDir, mul(hipSide, side));
        if (footWorld) j[foot] = localOf(leg.lowerWorld, footWorld);
      }
    }
  }

  // --- 腰の高さ ---
  // 被写体の脚の長さで割ってからこちらの脚に掛け直すので、背丈が違っても
  // しゃがみの深さの比率は保たれる
  const root: { y: number } = { y: HIP_HEIGHT * (opts.legs ?? 1) };
  const thighLen = len(sub(pos[LM.kneeL], pos[LM.hipL]));
  const shinLen = len(sub(pos[LM.ankleL], pos[LM.kneeL]));
  const subjectLeg = thighLen + shinLen;
  if (subjectLeg > 1e-6 && body.ok(LM.ankleL) && body.ok(LM.ankleR)) {
    const lowest = Math.min(pos[LM.ankleL].y, pos[LM.ankleR].y);
    const drop = (hipMid.y - lowest) / subjectLeg;
    root.y = Math.min(1.05, Math.max(0.45, drop)) * LEG_LENGTH * (opts.legs ?? 1);
  }

  return { root, j };
}

/**
 * 前後のコマで均す。
 *
 * 推定は1コマごとに独立なので、そのままだと細かく震える。角度の単純移動平均で
 * 十分に落ち着く（位置ではなく角度で均すので、均しても骨は伸び縮みしない）。
 */
export function smoothPoses(poses: Pose[], window: number): Pose[] {
  if (window <= 1 || poses.length === 0) return poses;
  const half = Math.floor(window / 2);
  const names = new Set<JointName>();
  for (const p of poses) for (const k of Object.keys(p.j ?? {})) names.add(k as JointName);

  return poses.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(poses.length - 1, i + half);
    const n = hi - lo + 1;
    const j: Partial<Record<JointName, Rot>> = {};
    for (const name of names) {
      let x = 0;
      let y = 0;
      let z = 0;
      let seen = 0;
      for (let k = lo; k <= hi; k++) {
        const r = poses[k].j?.[name];
        if (!r) continue;
        x += r[0];
        y += r[1];
        z += r[2];
        seen++;
      }
      if (seen > 0) j[name] = [x / seen, y / seen, z / seen];
    }
    let ry = 0;
    for (let k = lo; k <= hi; k++) ry += poses[k].root?.y ?? HIP_HEIGHT;
    return { root: { y: ry / n }, j };
  });
}

/**
 * 動画から取り込んだ動き。
 *
 * 振り付けの生成物（`Choreography`）と違って、こちらはコマごとの生のポーズ。
 * ブロックも小節も無いので、差し替えも左右反転もできない。再生するだけ。
 */
export interface MotionClip {
  /** 取り込み元のファイル名。表示用。 */
  name: string;
  /** 取り込んだときの1秒あたりのコマ数。 */
  fps: number;
  /** ループ1周のカウント数。BPM を変えたら作り直すこと。 */
  totalCounts: number;
  /** 検出できたコマ数と、取りこぼしたコマ数。 */
  detected: number;
  missed: number;
  frames: Pose[];
}

/** クリップの長さ（秒）。 */
export function clipSeconds(clip: MotionClip): number {
  return clip.frames.length / clip.fps;
}

/**
 * クリップの、あるカウント位置のポーズ。
 *
 * コマの間は線形に混ぜる。取り込みは 15fps 程度なので、混ぜないと 60fps の
 * プレビューでカクつく。混ぜるのは角度なので骨は伸び縮みしない。
 */
export function clipPoseAt(clip: MotionClip, countPos: number): Pose {
  const n = clip.frames.length;
  if (n === 0) return {};
  if (n === 1) return clip.frames[0];

  const total = clip.totalCounts > 0 ? clip.totalCounts : 1;
  const wrapped = ((countPos % total) + total) % total;
  const at = (wrapped / total) * n;
  const i = Math.floor(at);
  const t = at - i;
  return blendPose(clip.frames[i % n], clip.frames[(i + 1) % n], t);
}
