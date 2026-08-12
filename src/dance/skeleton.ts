/**
 * 人型スケルトンと順運動学（FK）。
 *
 * 振り付けは「関節の回転」で持つ。関節の位置ではなく回転で持つ理由は2つある。
 *
 * 1. 左右反転がただの符号反転で済む（位置で持つと骨の長さが崩れる）
 * 2. 中間フレームを補間しても手足が伸び縮みしない
 *
 * 座標系は Y が上、Z がカメラ側（＝キャラの正面）、X がキャラから見て左。
 * 回転は度数の XYZ オイラー角で、合成順は Ry・Rx・Rz。
 * つまり「横に振って（Z）、前後に上げて（X）、最後にひねる（Y）」の順で、
 * 振り付けを書くときに一番考えやすい並びにしてある。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** XYZ オイラー角（度）。 */
export type Rot = [number, number, number];

/** 3x3 行列。row-major で 9 要素。 */
export type Mat3 = readonly number[];

export type JointName =
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "headTop"
  | "upperArmL"
  | "forearmL"
  | "handL"
  | "handTipL"
  | "upperArmR"
  | "forearmR"
  | "handR"
  | "handTipR"
  | "thighL"
  | "shinL"
  | "footL"
  | "toeL"
  | "thighR"
  | "shinR"
  | "footR"
  | "toeR";

interface JointDef {
  name: JointName;
  parent: JointName | null;
  /** 親の位置からこの関節までのベクトル（親のローカル座標系）。 */
  offset: Vec3;
}

/**
 * 骨格の定義。長さは「身長がおよそ 1.6」になる比率で置いてある。
 * 体型の指定は受けていないので、男女どちらにも寄らない標準的な比率にした。
 */
const JOINTS: JointDef[] = [
  { name: "hips", parent: null, offset: { x: 0, y: 0, z: 0 } },
  { name: "spine", parent: "hips", offset: { x: 0, y: 0.1, z: 0 } },
  { name: "chest", parent: "spine", offset: { x: 0, y: 0.18, z: 0 } },
  { name: "neck", parent: "chest", offset: { x: 0, y: 0.18, z: 0 } },
  { name: "head", parent: "neck", offset: { x: 0, y: 0.11, z: 0 } },
  { name: "headTop", parent: "head", offset: { x: 0, y: 0.16, z: 0 } },

  { name: "upperArmL", parent: "chest", offset: { x: 0.19, y: 0.13, z: 0 } },
  { name: "forearmL", parent: "upperArmL", offset: { x: 0, y: -0.28, z: 0 } },
  { name: "handL", parent: "forearmL", offset: { x: 0, y: -0.26, z: 0 } },
  { name: "handTipL", parent: "handL", offset: { x: 0, y: -0.15, z: 0 } },

  { name: "upperArmR", parent: "chest", offset: { x: -0.19, y: 0.13, z: 0 } },
  { name: "forearmR", parent: "upperArmR", offset: { x: 0, y: -0.28, z: 0 } },
  { name: "handR", parent: "forearmR", offset: { x: 0, y: -0.26, z: 0 } },
  { name: "handTipR", parent: "handR", offset: { x: 0, y: -0.15, z: 0 } },

  { name: "thighL", parent: "hips", offset: { x: 0.115, y: -0.04, z: 0 } },
  { name: "shinL", parent: "thighL", offset: { x: 0, y: -0.45, z: 0 } },
  { name: "footL", parent: "shinL", offset: { x: 0, y: -0.43, z: 0 } },
  { name: "toeL", parent: "footL", offset: { x: 0, y: -0.04, z: 0.15 } },

  { name: "thighR", parent: "hips", offset: { x: -0.115, y: -0.04, z: 0 } },
  { name: "shinR", parent: "thighR", offset: { x: 0, y: -0.45, z: 0 } },
  { name: "footR", parent: "shinR", offset: { x: 0, y: -0.43, z: 0 } },
  { name: "toeR", parent: "footR", offset: { x: 0, y: -0.04, z: 0.15 } },
];

export const JOINT_NAMES: JointName[] = JOINTS.map((j) => j.name);

/**
 * 体型。すべて 1 が標準。
 *
 * 画角は振り付け全体に自動で合わせるので、体を一様に拡大しても画面上の
 * 見え方は変わらない。映像変換が拾うのは絶対的な背丈ではなく比率なので、
 * ここで持つのは長さそのものではなく「標準からの倍率」にしてある。
 */
export interface Body {
  /** 頭の大きさ。上げるほど頭身が下がって幼く見える。 */
  head: number;
  /** 脚の長さ。全身の背丈もこれで決まる。 */
  legs: number;
  /** 腕の長さ。 */
  arms: number;
  /** 手足と胴の太さ。 */
  build: number;
  /** 肩幅。 */
  shoulders: number;
}

export const DEFAULT_BODY: Body = { head: 1, legs: 1, arms: 1, build: 1, shoulders: 1 };

/** 脚の長さに関わる関節（親からの距離が脚の長さを作る）。 */
const LEG_JOINTS = new Set<JointName>(["thighL", "shinL", "footL", "toeL", "thighR", "shinR", "footR", "toeR"]);

/** 腕の長さに関わる関節。 */
const ARM_JOINTS = new Set<JointName>([
  "forearmL", "handL", "handTipL", "forearmR", "handR", "handTipR",
]);

/** 体型を反映した関節の位置ずれ。 */
function scaledOffset(joint: JointDef, body: Body): Vec3 {
  const o = joint.offset;
  if (joint.name === "headTop") return { x: o.x, y: o.y * body.head, z: o.z };
  if (joint.name === "upperArmL" || joint.name === "upperArmR") {
    return { x: o.x * body.shoulders, y: o.y, z: o.z };
  }
  if (LEG_JOINTS.has(joint.name)) {
    return { x: o.x * body.shoulders, y: o.y * body.legs, z: o.z * body.legs };
  }
  if (ARM_JOINTS.has(joint.name)) return { x: o.x, y: o.y * body.arms, z: o.z };
  return o;
}

/** その体型での腰の高さ。 */
export function hipHeightOf(body: Body): number {
  return HIP_HEIGHT * body.legs;
}

/** その体型での身長（足裏から頭頂まで）。 */
export function restHeightOf(body: Body): number {
  return hipHeightOf(body) + 0.1 + 0.18 + 0.18 + 0.11 + 0.16 * body.head;
}

/**
 * 頭身（身長 ÷ 頭の大きさ）。表示用。
 *
 * 骨格の首から頭頂までの長さではなく、実際に描かれる球の直径で割る。
 * 見ている人が数えるのはそちらなので、骨格上の値で出すと実物より
 * 小さい数字になる（標準が 5.4 頭身に見えてしまっていた）。
 */
export function headToBody(body: Body): number {
  const radius = headRadiusOf(body);
  // 描かれる頭は head と headTop の中間を中心にした球。てっぺんはその上端
  const headJointY = hipHeightOf(body) + 0.1 + 0.18 + 0.18 + 0.11;
  const silhouetteTop = headJointY + 0.08 * body.head + radius;
  return silhouetteTop / (radius * 2);
}

/** その体型での頭の半径。 */
export function headRadiusOf(body: Body): number {
  return HEAD_RADIUS * body.head;
}

/** その体型での体のパーツ（太さを反映）。 */
export function limbsOf(body: Body): Limb[] {
  return LIMBS.map((l) => ({ ...l, r0: l.r0 * body.build, r1: l.r1 * body.build }));
}

/** 直立時の腰の高さ。足の裏がちょうど y=0 に来る。 */
export const HIP_HEIGHT = 0.04 + 0.45 + 0.43 + 0.04;

/** 直立時の身長（足裏から頭頂まで）。フレーミングの基準に使う。 */
export const REST_HEIGHT = HIP_HEIGHT + 0.1 + 0.18 + 0.18 + 0.11 + 0.16;

/** 左右で対になる関節。反転時に入れ替える。 */
const MIRROR_PAIRS: Array<[JointName, JointName]> = [
  ["upperArmL", "upperArmR"],
  ["forearmL", "forearmR"],
  ["handL", "handR"],
  ["handTipL", "handTipR"],
  ["thighL", "thighR"],
  ["shinL", "shinR"],
  ["footL", "footR"],
  ["toeL", "toeR"],
];

/**
 * ポーズ。指定のない関節は回転 0（＝直立）として扱う。
 * 疎に持てるので、振り付けデータに「動かす関節だけ」書けばよくなる。
 */
export interface Pose {
  /** 腰の位置。省略時は直立の位置。 */
  root?: Partial<Vec3>;
  /** 関節ごとの回転。 */
  j?: Partial<Record<JointName, Rot>>;
}

/** FK を解いた結果。 */
export interface PosedSkeleton {
  /** 関節名 → ワールド座標。 */
  pos: Record<JointName, Vec3>;
  /**
   * 関節名 → ワールド回転。
   * 頭の向き（正面がどちらか）を知るのに使う。回転して背中を向けたときに
   * 顔を描かないようにするため、位置だけでなく向きも要る。
   */
  rot: Record<JointName, Mat3>;
}

// --- 行列とベクトル ---

const DEG = Math.PI / 180;

function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function apply(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** XYZ オイラー角（度）を回転行列にする。合成順は Ry・Rx・Rz。 */
export function rotationMatrix(rot: Rot): Mat3 {
  const [rx, ry, rz] = rot;
  if (rx === 0 && ry === 0 && rz === 0) return IDENTITY;
  const cx = Math.cos(rx * DEG);
  const sx = Math.sin(rx * DEG);
  const cy = Math.cos(ry * DEG);
  const sy = Math.sin(ry * DEG);
  const cz = Math.cos(rz * DEG);
  const sz = Math.sin(rz * DEG);

  const mx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const my: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const mz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(my, mul(mx, mz));
}

const ZERO: Rot = [0, 0, 0];

/**
 * ポーズを解いてワールド座標を得る。
 *
 * 各関節は「親の回転で運ばれた位置」に置かれ、自分の回転は子から先に効く。
 * 一般的なスケルトンアニメーションと同じ規約。
 */
export function solvePose(pose: Pose, body: Body = DEFAULT_BODY): PosedSkeleton {
  const pos = {} as Record<JointName, Vec3>;
  const rot = {} as Record<JointName, Mat3>;

  // 振り付けは脚の長さが標準のつもりで書かれている。腰の位置をまとめて
  // 脚の倍率で伸ばすと、しゃがみの深さも横への体重移動も同じ比率で付いてくる。
  // weight() が足の位置を打ち消すのに使う角度も、比が変わらないので崩れない。
  const rootSpec = pose.root ?? {};
  const rootPos: Vec3 = {
    x: (rootSpec.x ?? 0) * body.legs,
    y: (rootSpec.y ?? HIP_HEIGHT) * body.legs,
    z: (rootSpec.z ?? 0) * body.legs,
  };

  for (const joint of JOINTS) {
    const local = rotationMatrix(pose.j?.[joint.name] ?? ZERO);
    if (joint.parent === null) {
      pos[joint.name] = rootPos;
      rot[joint.name] = local;
      continue;
    }
    const parentRot = rot[joint.parent] ?? IDENTITY;
    const parentPos = pos[joint.parent];
    const moved = apply(parentRot, scaledOffset(joint, body));
    pos[joint.name] = {
      x: parentPos.x + moved.x,
      y: parentPos.y + moved.y,
      z: parentPos.z + moved.z,
    };
    rot[joint.name] = mul(parentRot, local);
  }
  return { pos, rot };
}

/** 回転行列で向きベクトルを回す。頭の正面方向を求めるのに使う。 */
export function rotate(m: Mat3, v: Vec3): Vec3 {
  return apply(m, v);
}

/**
 * ポーズを左右反転する。
 *
 * x → -x の鏡映なので、回転行列は M R M（M = diag(-1,1,1)）に移る。
 * オイラー角で書くと Y と Z の符号が反転し、X はそのまま。
 */
export function mirrorPose(pose: Pose): Pose {
  const j: Partial<Record<JointName, Rot>> = {};
  const swap = new Map<JointName, JointName>();
  for (const [a, b] of MIRROR_PAIRS) {
    swap.set(a, b);
    swap.set(b, a);
  }
  for (const [name, rot] of Object.entries(pose.j ?? {}) as Array<[JointName, Rot]>) {
    j[swap.get(name) ?? name] = [rot[0], -rot[1], -rot[2]];
  }
  const out: Pose = { j };
  if (pose.root) {
    out.root = { ...pose.root };
    if (pose.root.x !== undefined) out.root.x = -pose.root.x;
  }
  return out;
}

/** 2つのポーズを t（0..1）で混ぜる。指定のない関節は 0 として扱う。 */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  const names = new Set<JointName>([
    ...(Object.keys(a.j ?? {}) as JointName[]),
    ...(Object.keys(b.j ?? {}) as JointName[]),
  ]);
  const j: Partial<Record<JointName, Rot>> = {};
  for (const name of names) {
    const ra = a.j?.[name] ?? ZERO;
    const rb = b.j?.[name] ?? ZERO;
    j[name] = [
      ra[0] + (rb[0] - ra[0]) * t,
      ra[1] + (rb[1] - ra[1]) * t,
      ra[2] + (rb[2] - ra[2]) * t,
    ];
  }

  const ar = a.root ?? {};
  const br = b.root ?? {};
  const mixAxis = (x: number | undefined, y: number | undefined, fallback: number): number => {
    const va = x ?? fallback;
    const vb = y ?? fallback;
    return va + (vb - va) * t;
  };
  return {
    root: {
      x: mixAxis(ar.x, br.x, 0),
      y: mixAxis(ar.y, br.y, HIP_HEIGHT),
      z: mixAxis(ar.z, br.z, 0),
    },
    j,
  };
}

/** 描画に使う体のパーツ。太さは半径（ワールド単位）。 */
export interface Limb {
  from: JointName;
  to: JointName;
  /** 始点側の半径。 */
  r0: number;
  /** 終点側の半径。 */
  r1: number;
}

/**
 * マネキンの見た目を作るパーツ一覧。
 * Domo AI のような映像変換に渡す素材なので、シルエットが潰れないよう
 * 手足はやや太めにして、体の各部が離れて見えないようにしてある。
 *
 * 手だけは例外で、細長く先を絞ってある。握り拳と開いた手はシルエットの
 * 縦横比で見分けられていて、長さと幅が同じだと必ずグーに見える。
 * 指を作らずに「開いた手」を読ませるには、長さを幅の倍近くまで伸ばすのが早い。
 */
export const LIMBS: Limb[] = [
  { from: "hips", to: "spine", r0: 0.115, r1: 0.12 },
  { from: "spine", to: "chest", r0: 0.12, r1: 0.13 },
  // 首は太めにして頭の球に届かせる。細いと頭が浮いて見えるが、
  // head まで伸ばすと顔の下半分に首がかぶるので、neck で止めて太さで繋ぐ
  { from: "chest", to: "neck", r0: 0.078, r1: 0.068 },

  { from: "chest", to: "upperArmL", r0: 0.1, r1: 0.075 },
  { from: "upperArmL", to: "forearmL", r0: 0.065, r1: 0.05 },
  { from: "forearmL", to: "handL", r0: 0.05, r1: 0.04 },
  { from: "handL", to: "handTipL", r0: 0.045, r1: 0.018 },

  { from: "chest", to: "upperArmR", r0: 0.1, r1: 0.075 },
  { from: "upperArmR", to: "forearmR", r0: 0.065, r1: 0.05 },
  { from: "forearmR", to: "handR", r0: 0.05, r1: 0.04 },
  { from: "handR", to: "handTipR", r0: 0.045, r1: 0.018 },

  { from: "hips", to: "thighL", r0: 0.105, r1: 0.095 },
  { from: "thighL", to: "shinL", r0: 0.095, r1: 0.068 },
  { from: "shinL", to: "footL", r0: 0.068, r1: 0.048 },
  { from: "footL", to: "toeL", r0: 0.05, r1: 0.045 },

  { from: "hips", to: "thighR", r0: 0.105, r1: 0.095 },
  { from: "thighR", to: "shinR", r0: 0.095, r1: 0.068 },
  { from: "shinR", to: "footR", r0: 0.068, r1: 0.048 },
  { from: "footR", to: "toeR", r0: 0.05, r1: 0.045 },
];

/** 頭は球で描く。中心は head と headTop の中間。 */
export const HEAD_RADIUS = 0.128;
