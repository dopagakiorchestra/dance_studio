/**
 * 振り付けのパーツ辞書。
 *
 * 1つのパーツは原則 4カウント（＝4/4なら1小節）ぶんの動き。
 * 以前は 8カウント単位だったが、それだと「次に何が来るか」が読めてしまって
 * 単調になる。1小節ごとに振りが変わるほうが見ていて飽きない。
 * ボックスステップと半回転だけは、1小節では形が完成しないので 8カウントのまま。
 *
 * ここに並んだパーツを組み替えることで曲全体の振り付けを作る。1曲ぶんの振りを
 * 毎回考えるかわりに、部品を用意して並べ方を自動化する、というのがこの設計の要点。
 *
 * 角度の約束（skeleton.ts の座標系に従う）:
 * - 腕の Z 回転は +で画面右（キャラの左）へ振れる。左腕は + が外、右腕は - が外。
 * - 腕・脚の X 回転は + で後ろへ。前に出すときは負の値。
 * - 膝（shin）の X 回転は + のみ。人体は前には曲がらない。
 * - 上下動（ビートに乗ったバウンス）は sampler が足すので、ここには書かない。
 */

import { HIP_HEIGHT, type JointName, type Pose, type Rot, type Vec3 } from "./skeleton";

export type Ease = "linear" | "out" | "inout" | "hold";

export interface MoveKeyframe {
  /** パーツ先頭からのカウント位置。 */
  count: number;
  pose: Pose;
  /** このキーフレームへ向かう補間の効き方。既定は "out"（速く入って落ち着く）。 */
  ease?: Ease;
}

/** 振りの持ち味。生成では使わず、一覧の並べ分けに使う。 */
export type Mood = "cool" | "sultry" | "cute";

export interface Move {
  id: string;
  name: string;
  /** 長さ（カウント）。基本は 4（＝4/4 で1小節）。 */
  counts: number;
  /** 動きの大きさ。0=小 1=中 2=大。 */
  energy: 0 | 1 | 2;
  /** 左右反転しても成立するか。 */
  mirrorable: boolean;
  /** フレーズの締めに置きたいキメ技か。 */
  accent?: boolean;
  /** 持ち味。未指定は基本の振り。 */
  mood?: Mood;
  keyframes: MoveKeyframe[];
}

type Joints = Partial<Record<JointName, Rot>>;

/** 複数のポーズを重ねる。後から渡したものが優先。 */
function merge(...poses: Pose[]): Pose {
  const j: Joints = {};
  let root: Partial<Vec3> | undefined;
  for (const p of poses) {
    Object.assign(j, p.j);
    if (p.root) root = { ...root, ...p.root };
  }
  return root ? { root, j } : { j };
}

/**
 * 肘を脱力させたときの曲がり（度）。
 *
 * 人の腕は力を抜いていても完全には伸びない。0 にすると全身が棒に見えるので、
 * 既定でこれだけ曲げておく。ここを 0 にしていたせいで、腕の指定を書かない
 * 限り必ず真っ直ぐになっていた。
 */
const ELBOW_REST = 10;

/**
 * 腕だけのポーズ。
 *
 * 前腕の既定は「少し曲げた状態」。まっすぐが既定だと、書き手が意識して
 * 指定しない限り棒の腕になってしまう。
 */
function arms(
  l: Rot,
  r: Rot,
  foreL: Rot = [-ELBOW_REST, 0, 0],
  foreR: Rot = [-ELBOW_REST, 0, 0],
): Pose {
  return { j: { upperArmL: l, upperArmR: r, forearmL: foreL, forearmR: foreR } };
}

/**
 * 肘の曲げ。左右で同じ値を渡す。
 *
 * 肘は X 回転でしか曲がらない。前腕は -Y 方向に伸びているので、Y 回転は
 * その軸まわりのひねりにしかならず、見た目は一切変わらない（実測 0.0 度）。
 * 左右反転は Y と Z の符号を反転して X はそのまま通すので、両腕とも同じ
 * 負の値を入れておけば反転しても正しく曲がったままになる。
 */
function elbow(deg: number): Rot {
  return [-Math.abs(deg), 0, 0];
}

/**
 * 左右の肘の曲げをまとめて作る。`inward` を足すと前腕が体の内側へ寄る。
 *
 * 肘を前へ曲げるだけだと、手拍子や腕クロスのように「手を体の中心へ
 * 持ってくる」振りが成立しない（前腕が上を向いてしまう）。
 * 横方向は Z で、左腕は + が外なので内寄せは符号を反転する。
 * 戻り値は [左, 右] で、`arms()` にそのまま展開して渡せる。
 */
function elbows(deg: number, inward = 0): [Rot, Rot] {
  const x = -Math.abs(deg);
  return [
    [x, 0, -inward],
    [x, 0, inward],
  ];
}

/**
 * 体重を左右どちらかに乗せた土台の姿勢。dir=+1 でキャラの左足に乗る。
 *
 * 腰を横にずらすと足が地面から離れてしまうので、太ももを逆に倒して
 * 足の位置を元に戻している（簡易的な IK の代わり）。
 */
function weight(dir: number, amount = 1): Pose {
  const shift = 0.055 * dir * amount;
  // 脚の長さ 0.88 に対する横ずれ分を角度で打ち消す
  const comp = (Math.atan2(shift, 0.88) * 180) / Math.PI;
  return {
    root: { x: shift, y: HIP_HEIGHT },
    j: {
      hips: [0, 0, -3 * dir * amount],
      spine: [0, 0, 2 * dir * amount],
      chest: [0, 0, 2 * dir * amount],
      head: [0, 0, -1.5 * dir * amount],
      thighL: [0, 0, -comp],
      thighR: [0, 0, -comp],
      // 体重の乗っていない側の膝を少し緩める
      shinL: [dir > 0 ? 0 : 6 * amount, 0, 0],
      shinR: [dir > 0 ? 6 * amount : 0, 0, 0],
    },
  };
}

function kf(count: number, pose: Pose, ease?: Ease): MoveKeyframe {
  return ease ? { count, pose, ease } : { count, pose };
}

/**
 * パーツ一覧。
 *
 * energy は生成側が曲の盛り上がりに合わせて選ぶために使う。
 * mirrorable が true のものは、同じ振りを左右反転して2回目に使える。
 */
export const MOVES: Move[] = [
  {
    id: "shimmy",
    name: "肩ゆらし",
    counts: 4,
    energy: 0,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(1, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
      kf(2, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(3, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
      kf(4, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
    ],
  },
  {
    id: "bodyRoll",
    name: "ボディロール",
    counts: 4,
    energy: 1,
    mirrorable: false,
    keyframes: [
      kf(0, merge(weight(0.3), arms([0, 0, 20], [0, 0, -20]))),
      kf(1, merge(weight(0.3), { j: { chest: [-16, 0, 0], spine: [6, 0, 0], head: [-8, 0, 0] } }), "inout"),
      kf(2, merge(weight(0.3), { j: { chest: [10, 0, 0], spine: [-12, 0, 0], head: [6, 0, 0] } }), "inout"),
      kf(3, merge(weight(0.3), arms([0, 0, 20], [0, 0, -20])), "inout"),
      kf(4, merge(weight(-0.3), arms([0, 0, 20], [0, 0, -20]))),
    ],
  },
  {
    id: "chestPop",
    name: "胸を出す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, merge(weight(0.5), { j: { chest: [-18, 0, 0], head: [10, 0, 0], upperArmL: [12, 0, 16], upperArmR: [12, 0, -16] } })),
      kf(2, merge(weight(0.5), { j: { chest: [8, 0, 0], head: [-4, 0, 0] } })),
      kf(3, merge(weight(0.5), { j: { chest: [-18, 0, 0], head: [10, 0, 0], upperArmL: [12, 0, 16], upperArmR: [12, 0, -16] } })),
      kf(4, merge(weight(-0.5), arms([0, 0, 16], [0, 0, -16]))),
    ],
  },
  {
    id: "wave",
    name: "ウェーブ",
    counts: 4,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.4), arms([0, 0, 86], [0, 0, -86]))),
      kf(1, merge(weight(0.4), { j: { upperArmL: [0, 0, 108], forearmL: [0, 0, -26], upperArmR: [0, 0, -86] } }), "inout"),
      kf(2, merge(weight(0.4), { j: { upperArmL: [0, 0, 86], chest: [0, 0, 8], upperArmR: [0, 0, -96] } }), "inout"),
      kf(3, merge(weight(-0.4), { j: { chest: [0, 0, -8], upperArmR: [0, 0, -108], forearmR: [0, 0, 26] } }), "inout"),
      kf(4, merge(weight(-0.4), arms([0, 0, 86], [0, 0, -86])), "inout"),
    ],
  },
  {
    id: "pointUp",
    name: "斜め上を指す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.8), arms([0, 0, 12], [0, 0, -12]))),
      kf(1, merge(weight(0.8), { j: { upperArmL: [-20, 0, 138], head: [-8, 0, 10], chest: [0, 0, 6] } })),
      kf(2, merge(weight(0.8), { j: { upperArmL: [-20, 0, 138], head: [-8, 0, 10], chest: [0, 0, 6] } }), "hold"),
      kf(3, merge(weight(0.8), arms([0, 0, 12], [0, 0, -12]))),
      kf(4, merge(weight(-0.8), arms([0, 0, 12], [0, 0, -12]))),
    ],
  },
  {
    id: "clap",
    name: "手拍子",
    counts: 4,
    energy: 1,
    mirrorable: false,
    keyframes: [
      kf(0, merge(weight(0.5), arms([-34, 0, 26], [-34, 0, -26], ...elbows(56, 34)))),
      kf(1, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
      kf(2, merge(weight(0.5), arms([-24, 0, 56], [-24, 0, -56], ...elbows(34, 18)))),
      kf(3, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
      kf(4, merge(weight(0.5), arms([-62, 0, 20], [-62, 0, -20], ...elbows(66, 38)))),
    ],
  },
  {
    id: "slide",
    name: "横スライド",
    counts: 4,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 40], [0, 0, -14]))),
      kf(2, merge(weight(1), { root: { x: 0.16 }, j: { upperArmL: [0, 0, 70], upperArmR: [0, 0, -20], chest: [0, 0, -6] } })),
      kf(4, merge(weight(-1), { root: { x: -0.02 }, j: { upperArmL: [0, 0, 20], upperArmR: [0, 0, -50] } })),
    ],
  },
  {
    id: "runningMan",
    name: "ランニングマン",
    counts: 4,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.2), { j: { thighL: [-40, 0, 2], shinL: [46, 0, 0], thighR: [16, 0, -2], shinR: [16, 0, 0], upperArmL: [26, 0, 12], upperArmR: [-30, 0, -12], forearmR: elbow(50) } })),
      kf(1, merge(weight(0.2), { root: { y: HIP_HEIGHT - 0.06 }, j: { thighL: [6, 0, 2], shinL: [24, 0, 0], thighR: [-10, 0, -2], shinR: [30, 0, 0], upperArmL: [0, 0, 12], upperArmR: [0, 0, -12] } })),
      kf(2, merge(weight(-0.2), { j: { thighR: [-40, 0, -2], shinR: [46, 0, 0], thighL: [16, 0, 2], shinL: [16, 0, 0], upperArmR: [26, 0, -12], upperArmL: [-30, 0, 12], forearmL: elbow(50) } })),
      kf(3, merge(weight(-0.2), { root: { y: HIP_HEIGHT - 0.06 }, j: { thighR: [6, 0, -2], shinR: [24, 0, 0], thighL: [-10, 0, 2], shinL: [30, 0, 0], upperArmL: [0, 0, 12], upperArmR: [0, 0, -12] } })),
      kf(4, merge(weight(0.2), { j: { thighL: [-40, 0, 2], shinL: [46, 0, 0], thighR: [16, 0, -2], shinR: [16, 0, 0], upperArmL: [26, 0, 12], upperArmR: [-30, 0, -12], forearmR: elbow(50) } })),
    ],
  },
  {
    id: "turnHalf",
    name: "背を向けて戻る",
    counts: 8,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    // 回転は必ず始点と同じ向きで終える。
    // 以前は 360度まで回してから最後のキーフレームで指定が消えていたので、
    // 1回転したあと逆回転で巻き戻る動きになっていた（実測で確認）。
    // オイラー角の補間は最短経路を選ばないので、行って戻る形にするしかない。
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 18], [0, 0, -18]))),
      kf(1, merge(weight(0.6), { j: { hips: [0, 66, 0], upperArmL: [-34, 0, 64], forearmL: elbow(52), upperArmR: [-34, 0, -24], forearmR: elbow(52) } })),
      kf(2, { root: { x: 0.02, y: HIP_HEIGHT }, j: { hips: [0, 134, 0], upperArmL: [-24, 0, 72], forearmL: elbow(40), upperArmR: [-24, 0, -72], forearmR: elbow(40), thighR: [-14, 0, 0], shinR: [20, 0, 0] } }),
      kf(3, { root: { y: HIP_HEIGHT }, j: { hips: [0, 180, 0], upperArmL: [-16, 0, 30], forearmL: elbow(64), upperArmR: [-16, 0, -30], forearmR: elbow(64) } }),
      kf(4, { root: { y: HIP_HEIGHT }, j: { hips: [0, 180, 0], upperArmL: [-16, 0, 30], forearmL: elbow(64), upperArmR: [-16, 0, -30], forearmR: elbow(64) } }, "hold"),
      kf(5, { root: { y: HIP_HEIGHT }, j: { hips: [0, 134, 0], upperArmL: [-24, 0, 72], forearmL: elbow(40), upperArmR: [-24, 0, -72], forearmR: elbow(40), thighL: [-14, 0, 0], shinL: [20, 0, 0] } }),
      kf(6, { root: { y: HIP_HEIGHT }, j: { hips: [0, 66, 0], upperArmL: [-34, 0, 24], forearmL: elbow(52), upperArmR: [-34, 0, -64], forearmR: elbow(52) } }),
      kf(8, merge(weight(0.6), arms([0, 0, 18], [0, 0, -18]))),
    ],
  },
  {
    id: "crouchPop",
    name: "沈んで跳ねる",
    counts: 4,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, { root: { y: HIP_HEIGHT - 0.16 }, j: { thighL: [-34, 0, 6], shinL: [66, 0, 0], thighR: [-34, 0, -6], shinR: [66, 0, 0], spine: [-16, 0, 0], upperArmL: [-30, 0, 24], upperArmR: [-30, 0, -24], forearmL: elbow(60), forearmR: elbow(60) } }),
      kf(1, { root: { y: HIP_HEIGHT + 0.05 }, j: { upperArmL: [0, 0, 150], upperArmR: [0, 0, -150], thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-20, 0, 0], footR: [-20, 0, 0] } }),
      kf(2, { root: { y: HIP_HEIGHT - 0.1 }, j: { thighL: [-24, 0, 6], shinL: [46, 0, 0], thighR: [-24, 0, -6], shinR: [46, 0, 0], spine: [-10, 0, 0], upperArmL: [-20, 0, 40], upperArmR: [-20, 0, -40] } }),
      kf(3, merge(weight(0.5), arms([0, 0, 20], [0, 0, -20]))),
      kf(4, { root: { y: HIP_HEIGHT - 0.16 }, j: { thighL: [-34, 0, 6], shinL: [66, 0, 0], thighR: [-34, 0, -6], shinR: [66, 0, 0], spine: [-16, 0, 0], upperArmL: [-30, 0, 24], upperArmR: [-30, 0, -24] } }),
    ],
  },
  {
    id: "kickOut",
    name: "蹴り出し",
    counts: 4,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 18], [0, 0, -18]))),
      kf(1, merge(weight(1), { j: { thighR: [-56, 0, -8], shinR: [10, 0, 0], upperArmL: [-70, 0, 20], upperArmR: [30, 0, -20], chest: [6, 0, 0] } })),
      kf(2, merge(weight(1), { j: { thighR: [10, 0, -8], shinR: [40, 0, 0], upperArmL: [0, 0, 18], upperArmR: [0, 0, -18] } })),
      kf(3, merge(weight(1), { j: { thighR: [-56, 0, -8], shinR: [10, 0, 0], upperArmL: [-70, 0, 20], upperArmR: [30, 0, -20] } })),
      kf(4, merge(weight(-1), arms([0, 0, 18], [0, 0, -18]))),
    ],
  },
  {
    id: "armPump",
    name: "突き上げ",
    counts: 4,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
      kf(1, merge(weight(0.6), { j: { upperArmL: [0, 0, 168], upperArmR: [-40, 0, -30], forearmR: elbow(110), head: [-10, 0, 0] } })),
      kf(2, merge(weight(-0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [0, 0, -168], head: [-10, 0, 0] } })),
      kf(3, merge(weight(-0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
      kf(4, merge(weight(0.6), { j: { upperArmL: [0, 0, 168], upperArmR: [0, 0, -168], spine: [-8, 0, 0] } })),
    ],
  },

  // --- かっこいい ---
  {
    id: "armSlice",
    name: "腕を切る",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.7), { j: { upperArmL: [-58, 0, -30], forearmL: elbow(76), upperArmR: [-16, 0, -30], forearmR: elbow(30), chest: [0, 20, 0], head: [0, 16, 0] } })),
      kf(1, merge(weight(-0.7), { j: { upperArmL: [-40, 0, 122], forearmL: elbow(14), upperArmR: [6, 0, -34], forearmR: elbow(26), chest: [0, -20, 0], head: [0, -16, 0] } })),
      kf(2, merge(weight(-0.7), { j: { upperArmL: [-40, 0, 122], forearmL: elbow(14), upperArmR: [6, 0, -34], forearmR: elbow(26), chest: [0, -20, 0], head: [0, -16, 0] } }), "hold"),
      kf(4, merge(weight(0.7), arms([0, 0, 16], [0, 0, -16]))),
    ],
  },
  {
    id: "shoulderPush",
    name: "肩で押す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.6), { j: { chest: [0, 26, 8], upperArmL: [-46, 0, 74], forearmL: elbow(88), upperArmR: [10, 0, -34], forearmR: elbow(26), head: [0, 14, 6] } })),
      kf(1, merge(weight(0.6), arms([0, 0, 20], [0, 0, -20]))),
      kf(2, merge(weight(-0.6), { j: { chest: [0, -26, -8], upperArmR: [-46, 0, -74], forearmR: elbow(88), upperArmL: [10, 0, 34], forearmL: elbow(26), head: [0, -14, -6] } })),
      kf(3, merge(weight(-0.6), arms([0, 0, 20], [0, 0, -20]))),
      kf(4, merge(weight(0.6), { j: { chest: [0, 26, 8], upperArmL: [-46, 0, 74], forearmL: elbow(88), upperArmR: [10, 0, -34], forearmR: elbow(26), head: [0, 14, 6] } })),
    ],
  },
  {
    id: "bodyWave",
    name: "ウェーブ（下から上）",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "cool",
    keyframes: [
      // 正面固定のカメラでは前後の波が見えないので、体を斜めに向けてから波打つ。
      // 向きは必ず正面に戻して終える（ブロックを跨ぐときに向きが飛ばないため）
      kf(0, merge(weight(0.3), { j: { upperArmL: [-14, 0, 40], forearmL: elbow(48), upperArmR: [-14, 0, -40], forearmR: elbow(48) } })),
      kf(1, merge(weight(0.3), { j: { hips: [0, 44, 0], spine: [18, 0, 0], chest: [-14, 0, 0], head: [8, 0, 0] } }), "inout"),
      kf(2, merge(weight(0.3), { j: { hips: [0, 44, 0], spine: [-20, 0, 0], chest: [22, 0, 0], head: [-12, 0, 0] } }), "inout"),
      kf(3, merge(weight(0.3), { j: { hips: [0, 44, 0], spine: [12, 0, 0], chest: [-18, 0, 0], head: [14, 0, 0] } }), "inout"),
      kf(4, merge(weight(-0.3), { j: { upperArmL: [-14, 0, 40], forearmL: elbow(48), upperArmR: [-14, 0, -40], forearmR: elbow(48) } }), "inout"),
    ],
  },
  {
    id: "stompHit",
    name: "踏んで止める",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 18], [0, 0, -18]))),
      kf(1, { root: { y: HIP_HEIGHT - 0.09 }, j: { thighL: [-20, 0, 8], shinL: [40, 0, 0], thighR: [-30, 0, -10], shinR: [46, 0, 0], spine: [-12, 0, 0], upperArmL: [-46, 0, 34], forearmL: elbow(64), upperArmR: [-46, 0, -34], forearmR: elbow(64), head: [8, 0, 0] } }),
      kf(2, { root: { y: HIP_HEIGHT - 0.09 }, j: { thighL: [-20, 0, 8], shinL: [40, 0, 0], thighR: [-30, 0, -10], shinR: [46, 0, 0], spine: [-12, 0, 0], upperArmL: [-46, 0, 34], forearmL: elbow(64), upperArmR: [-46, 0, -34], forearmR: elbow(64), head: [8, 0, 0] } }, "hold"),
      kf(4, merge(weight(-0.6), arms([0, 0, 18], [0, 0, -18]))),
    ],
  },

  // --- 妖艶 ---
  {
    id: "hipRoll",
    name: "腰を回す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(1), { j: { hips: [0, 0, -12], spine: [0, 0, 16], chest: [0, 0, 12], head: [0, 0, -10], upperArmL: [-10, 0, 46], forearmL: elbow(58), upperArmR: [-10, 0, -46], forearmR: elbow(58) } })),
      kf(1, merge(weight(0.4), { j: { hips: [0, 0, -4], spine: [0, 0, 4], chest: [0, 14, 4], head: [0, 10, -4] } }), "inout"),
      kf(2, merge(weight(-1), { j: { hips: [0, 0, 12], spine: [0, 0, -16], chest: [0, 0, -12], head: [0, 0, 10] } }), "inout"),
      kf(3, merge(weight(-0.4), { j: { hips: [0, 0, 4], spine: [0, 0, -4], chest: [0, -14, -4], head: [0, -10, 4] } }), "inout"),
      kf(4, merge(weight(1), { j: { hips: [0, 0, -12], spine: [0, 0, 16], chest: [0, 0, 12], head: [0, 0, -10] } }), "inout"),
    ],
  },
  {
    id: "handTrace",
    name: "体をなぞる",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.7), { j: { upperArmL: [-44, 0, 26], forearmL: elbows(124, 76)[0], head: [0, 0, 10], chest: [0, 0, 6], upperArmR: [0, 0, -24], forearmR: elbow(20) } })),
      kf(2, merge(weight(0.7), { j: { upperArmL: [-24, 0, 18], forearmL: elbows(84, 62)[0], head: [0, 0, 6], chest: [0, 0, 4], upperArmR: [0, 0, -24], forearmR: elbow(20) } }), "inout"),
      kf(4, merge(weight(-0.7), arms([0, 0, 24], [0, 0, -24])), "inout"),
    ],
  },
  {
    id: "hairFlip",
    name: "髪をかき上げる",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 18], [0, 0, -18]))),
      kf(1, merge(weight(0.5), { j: { upperArmL: [-20, 0, 130], forearmL: elbows(104, 62)[0], head: [-6, 0, 10], chest: [0, 0, 6] } })),
      kf(2, merge(weight(-0.5), { j: { upperArmL: [-26, 0, 154], forearmL: elbow(30), head: [10, 0, -6], chest: [0, 0, -6], spine: [8, 0, 0] } })),
      kf(4, merge(weight(-0.5), arms([0, 0, 18], [0, 0, -18])), "inout"),
    ],
  },
  {
    id: "leanBack",
    name: "反って戻る",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.4), arms([0, 0, 20], [0, 0, -20]))),
      kf(2, merge(weight(0.4), { j: { spine: [16, 0, 0], chest: [14, 0, 0], head: [16, 0, 0], upperArmL: [-28, 0, 62], forearmL: elbow(42), upperArmR: [-28, 0, -62], forearmR: elbow(42) } }), "inout"),
      kf(4, merge(weight(-0.4), arms([0, 0, 20], [0, 0, -20])), "inout"),
    ],
  },

  // --- かわいい ---
  {
    id: "headTilt",
    name: "首をかしげる",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.7), { j: { head: [0, 0, 22], chest: [0, 0, 8], upperArmL: [-30, 0, 58], forearmL: elbows(96, 42)[0], upperArmR: [0, 0, -26], forearmR: elbow(30) } })),
      kf(2, merge(weight(-0.7), { j: { head: [0, 0, -22], chest: [0, 0, -8], upperArmL: [0, 0, 26], forearmL: elbow(30), upperArmR: [-30, 0, -58], forearmR: elbows(96, 42)[1] } })),
      kf(4, merge(weight(0.7), { j: { head: [0, 0, 22], chest: [0, 0, 8], upperArmL: [-30, 0, 58], forearmL: elbows(96, 42)[0], upperArmR: [0, 0, -26], forearmR: elbow(30) } })),
    ],
  },
  {
    id: "cheekHands",
    name: "ほっぺに手",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.5), { j: { upperArmL: [-38, 0, 42], forearmL: elbows(116, 62)[0], upperArmR: [-38, 0, -42], forearmR: elbows(116, 62)[1], head: [0, 0, 12] } })),
      kf(2, merge(weight(-0.5), { j: { upperArmL: [-38, 0, 42], forearmL: elbows(116, 62)[0], upperArmR: [-38, 0, -42], forearmR: elbows(116, 62)[1], head: [0, 0, -12] } })),
      kf(4, merge(weight(0.5), { j: { upperArmL: [-38, 0, 42], forearmL: elbows(116, 62)[0], upperArmR: [-38, 0, -42], forearmR: elbows(116, 62)[1], head: [0, 0, 12] } })),
    ],
  },
  {
    id: "bunnyHop",
    name: "小さく跳ねる",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, { root: { y: HIP_HEIGHT - 0.07 }, j: { thighL: [-18, 0, 5], shinL: [36, 0, 0], thighR: [-18, 0, -5], shinR: [36, 0, 0], upperArmL: [-20, 0, 28], forearmL: elbow(82), upperArmR: [-20, 0, -28], forearmR: elbow(82), head: [0, 0, 8] } }),
      kf(1, { root: { y: HIP_HEIGHT + 0.05 }, j: { thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-18, 0, 0], footR: [-18, 0, 0], upperArmL: [-8, 0, 32], forearmL: elbow(70), upperArmR: [-8, 0, -32], forearmR: elbow(70) } }),
      kf(2, { root: { y: HIP_HEIGHT - 0.07 }, j: { thighL: [-18, 0, 5], shinL: [36, 0, 0], thighR: [-18, 0, -5], shinR: [36, 0, 0], upperArmL: [-20, 0, 28], forearmL: elbow(82), upperArmR: [-20, 0, -28], forearmR: elbow(82), head: [0, 0, -8] } }),
      kf(3, { root: { y: HIP_HEIGHT + 0.05 }, j: { thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-18, 0, 0], footR: [-18, 0, 0], upperArmL: [-8, 0, 32], forearmL: elbow(70), upperArmR: [-8, 0, -32], forearmR: elbow(70) } }),
      kf(4, { root: { y: HIP_HEIGHT - 0.07 }, j: { thighL: [-18, 0, 5], shinL: [36, 0, 0], thighR: [-18, 0, -5], shinR: [36, 0, 0], upperArmL: [-20, 0, 28], forearmL: elbow(82), upperArmR: [-20, 0, -28], forearmR: elbow(82), head: [0, 0, 8] } }),
    ],
  },
  {
    id: "twinkle",
    name: "きらきら",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.4), { j: { upperArmL: [-14, 0, 138], forearmL: elbow(28), handL: [0, 0, 34], upperArmR: [-14, 0, -138], forearmR: elbow(28), handR: [0, 0, -34], head: [-6, 0, 8] } })),
      kf(1, merge(weight(0.4), { j: { upperArmL: [-14, 0, 138], forearmL: elbow(28), handL: [0, 0, -34], upperArmR: [-14, 0, -138], forearmR: elbow(28), handR: [0, 0, 34], head: [-6, 0, -8] } })),
      kf(2, merge(weight(-0.4), { j: { upperArmL: [-14, 0, 138], forearmL: elbow(28), handL: [0, 0, 34], upperArmR: [-14, 0, -138], forearmR: elbow(28), handR: [0, 0, -34], head: [-6, 0, 8] } })),
      kf(3, merge(weight(-0.4), { j: { upperArmL: [-14, 0, 138], forearmL: elbow(28), handL: [0, 0, -34], upperArmR: [-14, 0, -138], forearmR: elbow(28), handR: [0, 0, 34], head: [-6, 0, -8] } })),
      kf(4, merge(weight(0.4), { j: { upperArmL: [-14, 0, 138], forearmL: elbow(28), handL: [0, 0, 34], upperArmR: [-14, 0, -138], forearmR: elbow(28), handR: [0, 0, -34], head: [-6, 0, 8] } })),
    ],
  },
  {
    id: "poseHeart",
    name: "キメ（手でハート）",
    counts: 4,
    energy: 1,
    mirrorable: false,
    accent: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, merge(weight(0.5), { j: { upperArmL: [-54, 0, 32], forearmL: elbows(98, 56)[0], upperArmR: [-54, 0, -32], forearmR: elbows(98, 56)[1], head: [-6, 0, 0], chest: [-6, 0, 0] } })),
      kf(2, merge(weight(0.5), { j: { upperArmL: [-54, 0, 32], forearmL: elbows(98, 56)[0], upperArmR: [-54, 0, -32], forearmR: elbows(98, 56)[1], head: [-6, 0, 0], chest: [-6, 0, 0] } }), "hold"),
      kf(4, merge(weight(0.5), { j: { upperArmL: [-54, 0, 32], forearmL: elbows(98, 56)[0], upperArmR: [-54, 0, -32], forearmR: elbows(98, 56)[1], head: [-6, 0, 0], chest: [-6, 0, 0] } }), "hold"),
    ],
  },
  {
    id: "poseLean",
    name: "キメ（流し目）",
    counts: 4,
    energy: 1,
    mirrorable: true,
    accent: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, merge(weight(-0.9), { j: { spine: [0, 0, -10], chest: [0, 12, -6], head: [0, 18, -12], upperArmL: [-30, 0, 46], forearmL: elbows(92, 48)[0], upperArmR: [12, 0, -30], forearmR: elbow(30) } })),
      kf(2, merge(weight(-0.9), { j: { spine: [0, 0, -10], chest: [0, 12, -6], head: [0, 18, -12], upperArmL: [-30, 0, 46], forearmL: elbows(92, 48)[0], upperArmR: [12, 0, -30], forearmR: elbow(30) } }), "hold"),
      kf(4, merge(weight(-0.9), { j: { spine: [0, 0, -10], chest: [0, 12, -6], head: [0, 18, -12], upperArmL: [-30, 0, 46], forearmL: elbows(92, 48)[0], upperArmR: [12, 0, -30], forearmR: elbow(30) } }), "hold"),
    ],
  },

  {
    id: "chestIso",
    name: "胸を左右に出す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.3), { j: { spine: [0, 0, -12], chest: [0, 0, 20], head: [0, 0, -10], upperArmL: [-16, 0, 54], forearmL: elbow(76), upperArmR: [-16, 0, -54], forearmR: elbow(76) } })),
      kf(1, merge(weight(0.3), { j: { spine: [0, 0, 12], chest: [0, 0, -20], head: [0, 0, 10], upperArmL: [-16, 0, 54], forearmL: elbow(76), upperArmR: [-16, 0, -54], forearmR: elbow(76) } })),
      kf(2, merge(weight(-0.3), { j: { spine: [0, 0, -12], chest: [0, 0, 20], head: [0, 0, -10], upperArmL: [-16, 0, 54], forearmL: elbow(76), upperArmR: [-16, 0, -54], forearmR: elbow(76) } })),
      kf(3, merge(weight(-0.3), { j: { spine: [0, 0, 12], chest: [0, 0, -20], head: [0, 0, 10], upperArmL: [-16, 0, 54], forearmL: elbow(76), upperArmR: [-16, 0, -54], forearmR: elbow(76) } })),
      kf(4, merge(weight(0.3), { j: { spine: [0, 0, -12], chest: [0, 0, 20], head: [0, 0, -10], upperArmL: [-16, 0, 54], forearmL: elbow(76), upperArmR: [-16, 0, -54], forearmR: elbow(76) } })),
    ],
  },
  {
    id: "armSnapDown",
    name: "腕を振り下ろす",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.6), { j: { upperArmL: [-20, 0, 152], forearmL: elbow(16), upperArmR: [0, 0, -24], forearmR: elbow(22), chest: [0, 0, 8] } })),
      kf(1, merge(weight(-0.8), { j: { upperArmL: [-34, 0, 24], forearmL: elbows(98, 40)[0], upperArmR: [0, 0, -24], forearmR: elbow(22), chest: [0, 0, -10], spine: [-10, 0, 0], head: [8, 0, 0] } })),
      kf(2, merge(weight(-0.8), { j: { upperArmL: [-34, 0, 24], forearmL: elbows(98, 40)[0], upperArmR: [0, 0, -24], forearmR: elbow(22), chest: [0, 0, -10], spine: [-10, 0, 0], head: [8, 0, 0] } }), "hold"),
      kf(4, merge(weight(0.6), arms([0, 0, 20], [0, 0, -20]))),
    ],
  },
  {
    id: "crossPunch",
    name: "クロスパンチ",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.5), { j: { upperArmL: [-74, 0, -28], forearmL: elbow(18), upperArmR: [-38, 0, 16], forearmR: elbows(104, 54)[1], chest: [0, 26, 0], head: [0, 14, 0] } })),
      kf(1, merge(weight(-0.5), { j: { upperArmR: [-74, 0, 28], forearmR: elbow(18), upperArmL: [-38, 0, -16], forearmL: elbows(104, 54)[0], chest: [0, -26, 0], head: [0, -14, 0] } })),
      kf(2, merge(weight(0.5), { j: { upperArmL: [-74, 0, -28], forearmL: elbow(18), upperArmR: [-38, 0, 16], forearmR: elbows(104, 54)[1], chest: [0, 26, 0], head: [0, 14, 0] } })),
      kf(3, merge(weight(-0.5), { j: { upperArmR: [-74, 0, 28], forearmR: elbow(18), upperArmL: [-38, 0, -16], forearmL: elbows(104, 54)[0], chest: [0, -26, 0], head: [0, -14, 0] } })),
      kf(4, merge(weight(0.5), { j: { upperArmL: [-74, 0, -28], forearmL: elbow(18), upperArmR: [-38, 0, 16], forearmR: elbows(104, 54)[1], chest: [0, 26, 0], head: [0, 14, 0] } })),
    ],
  },
  {
    id: "shoulderLean",
    name: "肩を入れる",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.9), { j: { spine: [0, 0, 16], chest: [0, 0, 12], head: [0, 0, -14], upperArmL: [-26, 0, 32], forearmL: elbows(88, 44)[0], upperArmR: [16, 0, -30], forearmR: elbow(30) } })),
      kf(2, merge(weight(-0.9), { j: { spine: [0, 0, -16], chest: [0, 0, -12], head: [0, 0, 14], upperArmR: [-26, 0, -32], forearmR: elbows(88, 44)[1], upperArmL: [16, 0, 30], forearmL: elbow(30) } })),
      kf(4, merge(weight(0.9), { j: { spine: [0, 0, 16], chest: [0, 0, 12], head: [0, 0, -14], upperArmL: [-26, 0, 32], forearmL: elbows(88, 44)[0], upperArmR: [16, 0, -30], forearmR: elbow(30) } })),
    ],
  },

  {
    id: "hipPush",
    name: "腰を突き出す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(1), { j: { hips: [0, 0, -14], spine: [0, 0, 20], chest: [0, 0, 12], head: [0, 0, -10], upperArmL: [-30, 0, 26], forearmL: elbows(112, 62)[0], upperArmR: [0, 0, -26], forearmR: elbow(22) } })),
      kf(2, merge(weight(-1), { j: { hips: [0, 0, 14], spine: [0, 0, -20], chest: [0, 0, -12], head: [0, 0, 10], upperArmL: [-30, 0, 26], forearmL: elbows(112, 62)[0], upperArmR: [0, 0, -26], forearmR: elbow(22) } })),
      kf(4, merge(weight(1), { j: { hips: [0, 0, -14], spine: [0, 0, 20], chest: [0, 0, 12], head: [0, 0, -10], upperArmL: [-30, 0, 26], forearmL: elbows(112, 62)[0], upperArmR: [0, 0, -26], forearmR: elbow(22) } })),
    ],
  },
  {
    id: "shoulderRoll",
    name: "肩を回す",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.5), { j: { upperArmL: [-32, 0, 24], forearmL: elbows(96, 50)[0], upperArmR: [0, 0, -24], forearmR: elbow(20), chest: [0, 12, 5] } })),
      kf(1, merge(weight(0.5), { j: { upperArmL: [18, 0, 28], forearmL: elbows(68, 36)[0], upperArmR: [0, 0, -24], forearmR: elbow(20), chest: [0, -8, 3] } }), "inout"),
      kf(2, merge(weight(-0.5), { j: { upperArmL: [-32, 0, 24], forearmL: elbows(96, 50)[0], upperArmR: [0, 0, -24], forearmR: elbow(20), chest: [0, 12, 5] } }), "inout"),
      kf(4, merge(weight(-0.5), arms([0, 0, 24], [0, 0, -24])), "inout"),
    ],
  },
  {
    id: "armDrape",
    name: "腕を絡める",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.6), { j: { upperArmL: [-36, 0, -20], forearmL: elbows(114, 76)[0], upperArmR: [-36, 0, 20], forearmR: elbows(114, 76)[1], chest: [0, 14, 0], head: [0, 10, 10] } })),
      kf(2, merge(weight(-0.6), { j: { upperArmL: [-36, 0, -20], forearmL: elbows(114, 76)[0], upperArmR: [-36, 0, 20], forearmR: elbows(114, 76)[1], chest: [0, -14, 0], head: [0, -10, -10] } })),
      kf(4, merge(weight(0.6), { j: { upperArmL: [-36, 0, -20], forearmL: elbows(114, 76)[0], upperArmR: [-36, 0, 20], forearmR: elbows(114, 76)[1], chest: [0, 14, 0], head: [0, 10, 10] } })),
    ],
  },
  {
    id: "legCross",
    name: "脚を組んで立つ",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 24], [0, 0, -24]))),
      kf(2, merge(weight(1), { j: { thighR: [-8, 0, 24], shinR: [18, 0, 0], footR: [12, 0, 0], spine: [0, 0, 12], chest: [0, 0, 8], head: [0, 0, -10], upperArmL: [-28, 0, 26], forearmL: elbows(98, 52)[0], upperArmR: [0, 0, -22], forearmR: elbow(20) } })),
      kf(4, merge(weight(1), arms([0, 0, 24], [0, 0, -24]))),
    ],
  },

  {
    id: "handWave",
    name: "手を振る",
    counts: 4,
    energy: 0,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.5), { j: { upperArmL: [-16, 0, 124], forearmL: elbow(42), handL: [0, 0, 28], upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 12] } })),
      kf(1, merge(weight(0.5), { j: { upperArmL: [-16, 0, 124], forearmL: elbow(42), handL: [0, 0, -28], upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 12] } })),
      kf(2, merge(weight(-0.5), { j: { upperArmL: [-16, 0, 124], forearmL: elbow(42), handL: [0, 0, 28], upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 12] } })),
      kf(3, merge(weight(-0.5), { j: { upperArmL: [-16, 0, 124], forearmL: elbow(42), handL: [0, 0, -28], upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 12] } })),
      kf(4, merge(weight(0.5), { j: { upperArmL: [-16, 0, 124], forearmL: elbow(42), handL: [0, 0, 28], upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 12] } })),
    ],
  },
  {
    id: "cutePoint",
    name: "指さし",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 22], [0, 0, -22]))),
      kf(1, merge(weight(0.6), { j: { upperArmL: [-54, 0, 64], forearmL: elbow(26), upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 20], chest: [0, 0, 8] } })),
      kf(2, merge(weight(0.6), { j: { upperArmL: [-54, 0, 64], forearmL: elbow(26), upperArmR: [0, 0, -24], forearmR: elbow(22), head: [0, 0, 20], chest: [0, 0, 8] } }), "hold"),
      kf(4, merge(weight(-0.6), arms([0, 0, 22], [0, 0, -22]))),
    ],
  },
  {
    id: "hopTurn",
    name: "跳ねて向きを変える",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.4), { j: { upperArmL: [-20, 0, 44], forearmL: elbow(72), upperArmR: [-20, 0, -44], forearmR: elbow(72) } })),
      kf(1, { root: { y: HIP_HEIGHT + 0.05 }, j: { hips: [0, 52, 0], upperArmL: [-20, 0, 58], forearmL: elbow(60), upperArmR: [-20, 0, -58], forearmR: elbow(60), thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-18, 0, 0], footR: [-18, 0, 0] } }),
      kf(2, merge(weight(-0.4), { j: { hips: [0, 52, 0], upperArmL: [-20, 0, 44], forearmL: elbow(72), upperArmR: [-20, 0, -44], forearmR: elbow(72) } })),
      kf(3, { root: { y: HIP_HEIGHT + 0.05 }, j: { hips: [0, 12, 0], upperArmL: [-20, 0, 58], forearmL: elbow(60), upperArmR: [-20, 0, -58], forearmR: elbow(60), thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-18, 0, 0], footR: [-18, 0, 0] } }),
      kf(4, merge(weight(0.4), { j: { upperArmL: [-20, 0, 44], forearmL: elbow(72), upperArmR: [-20, 0, -44], forearmR: elbow(72) } })),
    ],
  },
  {
    id: "armSwing",
    name: "腕をぶんぶん",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.6), { j: { upperArmL: [-30, 0, 74], forearmL: elbow(48), upperArmR: [-30, 0, -14], forearmR: elbow(48), chest: [0, 0, 8], head: [0, 0, -8] } })),
      kf(1, merge(weight(-0.6), { j: { upperArmL: [-30, 0, 14], forearmL: elbow(48), upperArmR: [-30, 0, -74], forearmR: elbow(48), chest: [0, 0, -8], head: [0, 0, 8] } })),
      kf(2, merge(weight(0.6), { j: { upperArmL: [-30, 0, 74], forearmL: elbow(48), upperArmR: [-30, 0, -14], forearmR: elbow(48), chest: [0, 0, 8], head: [0, 0, -8] } })),
      kf(3, merge(weight(-0.6), { j: { upperArmL: [-30, 0, 14], forearmL: elbow(48), upperArmR: [-30, 0, -74], forearmR: elbow(48), chest: [0, 0, -8], head: [0, 0, 8] } })),
      kf(4, merge(weight(0.6), { j: { upperArmL: [-30, 0, 74], forearmL: elbow(48), upperArmR: [-30, 0, -14], forearmR: elbow(48), chest: [0, 0, 8], head: [0, 0, -8] } })),
    ],
  },
  {
    id: "poseCross",
    name: "キメ（腕クロス）",
    counts: 4,
    energy: 1,
    mirrorable: true,
    accent: true,
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 14], [0, 0, -14]))),
      kf(1, merge(weight(0.6), arms([-30, 0, 80], [-30, 0, -80]))),
      kf(2, merge(weight(-0.8), { j: { upperArmL: [-80, 0, -20], forearmL: elbows(64, 52)[0], upperArmR: [-80, 0, 20], forearmR: elbows(64, 52)[1], chest: [0, 0, -8], head: [6, 0, -6] } })),
      kf(4, merge(weight(-0.8), { j: { upperArmL: [-80, 0, -20], forearmL: elbows(64, 52)[0], upperArmR: [-80, 0, 20], forearmR: elbows(64, 52)[1], chest: [0, 0, -8], head: [6, 0, -6] } }), "hold"),
    ],
  },
  {
    id: "poseFinish",
    name: "キメ（決めポーズ）",
    counts: 4,
    energy: 2,
    mirrorable: true,
    accent: true,
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, { root: { y: HIP_HEIGHT - 0.1 }, j: { thighL: [-26, 0, 8], shinL: [48, 0, 0], thighR: [-26, 0, -8], shinR: [48, 0, 0], spine: [-12, 0, 0], upperArmL: [-30, 0, 30], upperArmR: [-30, 0, -30] } }),
      kf(2, { root: { x: 0.03, y: HIP_HEIGHT }, j: { upperArmL: [-24, 0, 150], upperArmR: [20, 0, -44], forearmR: elbow(60), chest: [0, -20, 6], head: [-10, -18, 8], thighR: [-16, 0, -10], shinR: [26, 0, 0] } }),
      kf(4, { root: { x: 0.03, y: HIP_HEIGHT }, j: { upperArmL: [-24, 0, 150], upperArmR: [20, 0, -44], forearmR: elbow(60), chest: [0, -20, 6], head: [-10, -18, 8], thighR: [-16, 0, -10], shinR: [26, 0, 0] } }, "hold"),
    ],
  },
];

const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function getMove(id: string): Move | undefined {
  return BY_ID.get(id);
}

export function hasMove(id: string): boolean {
  return BY_ID.has(id);
}
