/**
 * 振り付けのパーツ辞書。
 *
 * 1つのパーツは 8カウント（＝4/4なら2小節）ぶんの動き。ダンスはこの単位で
 * 組み立てるのが自然なので、生成側もこの粒度でパーツを並べていく。
 *
 * ここに並んだ20個を組み替えることで曲全体の振り付けを作る。1曲ぶんの振りを
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

export interface Move {
  id: string;
  name: string;
  /** 長さ（カウント）。基本は 8。 */
  counts: number;
  /** 動きの大きさ。0=小 1=中 2=大。 */
  energy: 0 | 1 | 2;
  /** 左右反転しても成立するか。 */
  mirrorable: boolean;
  /** フレーズの締めに置きたいキメ技か。 */
  accent?: boolean;
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

/**
 * 腕を下ろした自然な位置。
 * 真下に下ろすと胴のシルエットに溶けて腕が見えなくなるので、しっかり開く。
 */
const ARMS_DOWN: Pose = arms([0, 0, 17], [0, 0, -17]);

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
    id: "sway",
    name: "体重移動",
    counts: 8,
    energy: 0,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), ARMS_DOWN)),
      kf(2, merge(weight(-1), ARMS_DOWN)),
      kf(4, merge(weight(1), ARMS_DOWN)),
      kf(6, merge(weight(-1), ARMS_DOWN)),
      kf(8, merge(weight(1), ARMS_DOWN)),
    ],
  },
  {
    id: "stepTouch",
    name: "ステップタッチ",
    counts: 8,
    energy: 0,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 14], [0, 0, -14]))),
      kf(1, merge(weight(1), { j: { thighR: [0, 0, 10], shinR: [12, 0, 0] } })),
      kf(2, merge(weight(-1), arms([0, 0, 14], [0, 0, -14]))),
      kf(3, merge(weight(-1), { j: { thighL: [0, 0, -10], shinL: [12, 0, 0] } })),
      kf(4, merge(weight(1), arms([0, 0, 14], [0, 0, -14]))),
      kf(5, merge(weight(1), { j: { thighR: [0, 0, 10], shinR: [12, 0, 0] } })),
      kf(6, merge(weight(-1), arms([0, 0, 14], [0, 0, -14]))),
      kf(8, merge(weight(1), arms([0, 0, 14], [0, 0, -14]))),
    ],
  },
  {
    id: "heelToe",
    name: "かかと・つま先",
    counts: 8,
    energy: 0,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 12], [0, 0, -12]))),
      kf(1, merge(weight(1), { j: { thighR: [-18, 0, 4], shinR: [4, 0, 0], footR: [-24, 0, 0] } })),
      kf(2, merge(weight(1), { j: { thighR: [6, 0, 4], shinR: [34, 0, 0], footR: [26, 0, 0] } })),
      kf(3, merge(weight(1), arms([0, 0, 12], [0, 0, -12]))),
      kf(4, merge(weight(-1), arms([0, 0, 12], [0, 0, -12]))),
      kf(5, merge(weight(-1), { j: { thighL: [-18, 0, -4], shinL: [4, 0, 0], footL: [-24, 0, 0] } })),
      kf(6, merge(weight(-1), { j: { thighL: [6, 0, -4], shinL: [34, 0, 0], footL: [26, 0, 0] } })),
      kf(8, merge(weight(1), arms([0, 0, 12], [0, 0, -12]))),
    ],
  },
  {
    id: "shimmy",
    name: "肩ゆらし",
    counts: 8,
    energy: 0,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(1, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
      kf(2, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(3, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
      kf(4, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(5, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
      kf(6, merge(weight(0.4), { j: { chest: [0, 14, 0], upperArmL: [-12, 0, 12], upperArmR: [10, 0, -12] } })),
      kf(8, merge(weight(-0.4), { j: { chest: [0, -14, 0], upperArmL: [10, 0, 12], upperArmR: [-12, 0, -12] } })),
    ],
  },
  {
    id: "bodyRoll",
    name: "ボディロール",
    counts: 8,
    energy: 1,
    mirrorable: false,
    keyframes: [
      kf(0, merge(weight(0.3), arms([0, 0, 20], [0, 0, -20]))),
      kf(1, merge(weight(0.3), { j: { chest: [-16, 0, 0], spine: [6, 0, 0], head: [-8, 0, 0] } }), "inout"),
      kf(2, merge(weight(0.3), { j: { chest: [10, 0, 0], spine: [-12, 0, 0], head: [6, 0, 0] } }), "inout"),
      kf(3, merge(weight(0.3), arms([0, 0, 20], [0, 0, -20])), "inout"),
      kf(4, merge(weight(-0.3), arms([0, 0, 20], [0, 0, -20]))),
      kf(5, merge(weight(-0.3), { j: { chest: [-16, 0, 0], spine: [6, 0, 0], head: [-8, 0, 0] } }), "inout"),
      kf(6, merge(weight(-0.3), { j: { chest: [10, 0, 0], spine: [-12, 0, 0], head: [6, 0, 0] } }), "inout"),
      kf(8, merge(weight(-0.3), arms([0, 0, 20], [0, 0, -20])), "inout"),
    ],
  },
  {
    id: "chestPop",
    name: "胸を出す",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, merge(weight(0.5), { j: { chest: [-18, 0, 0], head: [10, 0, 0], upperArmL: [12, 0, 16], upperArmR: [12, 0, -16] } })),
      kf(2, merge(weight(0.5), { j: { chest: [8, 0, 0], head: [-4, 0, 0] } })),
      kf(3, merge(weight(0.5), { j: { chest: [-18, 0, 0], head: [10, 0, 0], upperArmL: [12, 0, 16], upperArmR: [12, 0, -16] } })),
      kf(4, merge(weight(-0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(5, merge(weight(-0.5), { j: { chest: [-18, 0, 0], head: [10, 0, 0], upperArmL: [12, 0, 16], upperArmR: [12, 0, -16] } })),
      kf(6, merge(weight(-0.5), { j: { chest: [8, 0, 0], head: [-4, 0, 0] } })),
      kf(8, merge(weight(-0.5), arms([0, 0, 16], [0, 0, -16]))),
    ],
  },
  {
    id: "boxStep",
    name: "ボックスステップ",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, merge(weight(1), { root: { z: 0.05 }, j: { thighR: [-26, 0, 6], shinR: [22, 0, 0] } })),
      kf(2, merge(weight(-1), { root: { z: 0.05 }, j: { thighL: [-22, 0, -6], shinL: [18, 0, 0] } })),
      kf(3, merge(weight(-1), { root: { z: -0.03 }, j: { thighR: [16, 0, 6], shinR: [24, 0, 0] } })),
      kf(4, merge(weight(1), { root: { z: -0.03 }, j: { thighL: [14, 0, -6], shinL: [20, 0, 0] } })),
      kf(5, merge(weight(1), { root: { z: 0.05 }, j: { thighR: [-26, 0, 6], shinR: [22, 0, 0] } })),
      kf(6, merge(weight(-1), { root: { z: 0.05 }, j: { thighL: [-22, 0, -6], shinL: [18, 0, 0] } })),
      kf(8, merge(weight(1), arms([0, 0, 16], [0, 0, -16]))),
    ],
  },
  {
    id: "armWave",
    name: "腕を開いて閉じる",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 10], [0, 0, -10]))),
      kf(2, merge(weight(0.6), arms([-10, 0, 88], [-10, 0, -88]))),
      kf(4, merge(weight(-0.6), arms([-20, 0, 30], [-20, 0, -30], elbow(40), elbow(40)))),
      kf(6, merge(weight(-0.6), arms([-10, 0, 88], [-10, 0, -88]))),
      kf(8, merge(weight(0.6), arms([0, 0, 10], [0, 0, -10]))),
    ],
  },
  {
    id: "wave",
    name: "ウェーブ",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.4), arms([0, 0, 86], [0, 0, -86]))),
      kf(1, merge(weight(0.4), { j: { upperArmL: [0, 0, 108], forearmL: [0, 0, -26], upperArmR: [0, 0, -86] } }), "inout"),
      kf(2, merge(weight(0.4), { j: { upperArmL: [0, 0, 86], chest: [0, 0, 8], upperArmR: [0, 0, -96] } }), "inout"),
      kf(3, merge(weight(-0.4), { j: { chest: [0, 0, -8], upperArmR: [0, 0, -108], forearmR: [0, 0, 26] } }), "inout"),
      kf(4, merge(weight(-0.4), arms([0, 0, 86], [0, 0, -86])), "inout"),
      kf(5, merge(weight(-0.4), { j: { upperArmR: [0, 0, -108], forearmR: [0, 0, 26] } }), "inout"),
      kf(6, merge(weight(0.4), { j: { chest: [0, 0, 8], upperArmL: [0, 0, 108], forearmL: [0, 0, -26] } }), "inout"),
      kf(8, merge(weight(0.4), arms([0, 0, 86], [0, 0, -86])), "inout"),
    ],
  },
  {
    id: "pointUp",
    name: "斜め上を指す",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.8), arms([0, 0, 12], [0, 0, -12]))),
      kf(1, merge(weight(0.8), { j: { upperArmL: [-20, 0, 138], head: [-8, 0, 10], chest: [0, 0, 6] } })),
      kf(2, merge(weight(0.8), { j: { upperArmL: [-20, 0, 138], head: [-8, 0, 10], chest: [0, 0, 6] } }), "hold"),
      kf(3, merge(weight(0.8), arms([0, 0, 12], [0, 0, -12]))),
      kf(4, merge(weight(-0.8), arms([0, 0, 12], [0, 0, -12]))),
      kf(5, merge(weight(-0.8), { j: { upperArmR: [-20, 0, -138], head: [-8, 0, -10], chest: [0, 0, -6] } })),
      kf(6, merge(weight(-0.8), { j: { upperArmR: [-20, 0, -138], head: [-8, 0, -10], chest: [0, 0, -6] } }), "hold"),
      kf(8, merge(weight(-0.8), arms([0, 0, 12], [0, 0, -12]))),
    ],
  },
  {
    id: "clap",
    name: "手拍子",
    counts: 8,
    energy: 1,
    mirrorable: false,
    keyframes: [
      kf(0, merge(weight(0.5), arms([-34, 0, 26], [-34, 0, -26], ...elbows(56, 34)))),
      kf(1, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
      kf(2, merge(weight(0.5), arms([-24, 0, 56], [-24, 0, -56], ...elbows(34, 18)))),
      kf(3, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
      kf(4, merge(weight(0.5), arms([-62, 0, 20], [-62, 0, -20], ...elbows(66, 38)))),
      kf(5, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
      kf(6, merge(weight(0.5), arms([-24, 0, 56], [-24, 0, -56], ...elbows(34, 18)))),
      kf(8, merge(weight(-0.5), arms([-44, 0, 12], [-44, 0, -12], ...elbows(76, 46)))),
    ],
  },
  {
    id: "slide",
    name: "横スライド",
    counts: 8,
    energy: 1,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 40], [0, 0, -14]))),
      kf(2, merge(weight(1), { root: { x: 0.16 }, j: { upperArmL: [0, 0, 70], upperArmR: [0, 0, -20], chest: [0, 0, -6] } })),
      kf(4, merge(weight(-1), { root: { x: -0.02 }, j: { upperArmL: [0, 0, 20], upperArmR: [0, 0, -50] } })),
      kf(6, merge(weight(-1), { root: { x: -0.16 }, j: { upperArmL: [0, 0, 20], upperArmR: [0, 0, -70], chest: [0, 0, 6] } })),
      kf(8, merge(weight(1), arms([0, 0, 40], [0, 0, -14]))),
    ],
  },
  {
    id: "reachSky",
    name: "両手を伸ばす",
    counts: 8,
    energy: 1,
    mirrorable: false,
    keyframes: [
      kf(0, merge(weight(0.3), arms([0, 0, 10], [0, 0, -10]))),
      kf(2, merge(weight(0.3), { j: { upperArmL: [0, 0, 165], upperArmR: [0, 0, -165], spine: [-6, 0, 0], head: [-12, 0, 0] } }), "inout"),
      kf(4, merge(weight(0.3), { j: { upperArmL: [0, 0, 150], upperArmR: [0, 0, -150], chest: [0, 0, 10], head: [0, 0, -6] } })),
      kf(6, merge(weight(-0.3), { j: { upperArmL: [0, 0, 150], upperArmR: [0, 0, -150], chest: [0, 0, -10], head: [0, 0, 6] } })),
      kf(8, merge(weight(-0.3), arms([0, 0, 10], [0, 0, -10])), "inout"),
    ],
  },
  {
    id: "runningMan",
    name: "ランニングマン",
    counts: 8,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.2), { j: { thighL: [-40, 0, 2], shinL: [46, 0, 0], thighR: [16, 0, -2], shinR: [16, 0, 0], upperArmL: [26, 0, 12], upperArmR: [-30, 0, -12], forearmR: elbow(50) } })),
      kf(1, merge(weight(0.2), { root: { y: HIP_HEIGHT - 0.06 }, j: { thighL: [6, 0, 2], shinL: [24, 0, 0], thighR: [-10, 0, -2], shinR: [30, 0, 0], upperArmL: [0, 0, 12], upperArmR: [0, 0, -12] } })),
      kf(2, merge(weight(-0.2), { j: { thighR: [-40, 0, -2], shinR: [46, 0, 0], thighL: [16, 0, 2], shinL: [16, 0, 0], upperArmR: [26, 0, -12], upperArmL: [-30, 0, 12], forearmL: elbow(50) } })),
      kf(3, merge(weight(-0.2), { root: { y: HIP_HEIGHT - 0.06 }, j: { thighR: [6, 0, -2], shinR: [24, 0, 0], thighL: [-10, 0, 2], shinL: [30, 0, 0], upperArmL: [0, 0, 12], upperArmR: [0, 0, -12] } })),
      kf(4, merge(weight(0.2), { j: { thighL: [-40, 0, 2], shinL: [46, 0, 0], thighR: [16, 0, -2], shinR: [16, 0, 0], upperArmL: [26, 0, 12], upperArmR: [-30, 0, -12], forearmR: elbow(50) } })),
      kf(5, merge(weight(0.2), { root: { y: HIP_HEIGHT - 0.06 }, j: { thighL: [6, 0, 2], shinL: [24, 0, 0], thighR: [-10, 0, -2], shinR: [30, 0, 0] } })),
      kf(6, merge(weight(-0.2), { j: { thighR: [-40, 0, -2], shinR: [46, 0, 0], thighL: [16, 0, 2], shinL: [16, 0, 0], upperArmR: [26, 0, -12], upperArmL: [-30, 0, 12], forearmL: elbow(50) } })),
      kf(8, merge(weight(0.2), { j: { thighL: [-40, 0, 2], shinL: [46, 0, 0], thighR: [16, 0, -2], shinR: [16, 0, 0] } })),
    ],
  },
  {
    id: "turnHalf",
    name: "半回転",
    counts: 8,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 14], [0, 0, -14]))),
      kf(1, merge(weight(0.6), { j: { hips: [0, 30, 0], upperArmL: [-30, 0, 60], upperArmR: [-30, 0, -20] } })),
      kf(2, { root: { x: 0.02, y: HIP_HEIGHT }, j: { hips: [0, 100, 0], upperArmL: [-20, 0, 70], upperArmR: [-20, 0, -70], thighR: [-14, 0, 0], shinR: [20, 0, 0] } }),
      kf(3, { root: { y: HIP_HEIGHT }, j: { hips: [0, 180, 0], upperArmL: [0, 0, 20], upperArmR: [0, 0, -20] } }),
      kf(4, { root: { y: HIP_HEIGHT }, j: { hips: [0, 180, 0], upperArmL: [-40, 0, 30], upperArmR: [-40, 0, -30] } }),
      kf(5, { root: { y: HIP_HEIGHT }, j: { hips: [0, 260, 0], upperArmL: [-20, 0, 70], upperArmR: [-20, 0, -70], thighL: [-14, 0, 0], shinL: [20, 0, 0] } }),
      kf(6, { root: { y: HIP_HEIGHT }, j: { hips: [0, 360, 0], upperArmL: [0, 0, 24], upperArmR: [0, 0, -24] } }),
      kf(8, merge(weight(0.6), arms([0, 0, 14], [0, 0, -14]))),
    ],
  },
  {
    id: "crouchPop",
    name: "沈んで跳ねる",
    counts: 8,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, { root: { y: HIP_HEIGHT - 0.16 }, j: { thighL: [-34, 0, 6], shinL: [66, 0, 0], thighR: [-34, 0, -6], shinR: [66, 0, 0], spine: [-16, 0, 0], upperArmL: [-30, 0, 24], upperArmR: [-30, 0, -24], forearmL: elbow(60), forearmR: elbow(60) } }),
      kf(1, { root: { y: HIP_HEIGHT + 0.05 }, j: { upperArmL: [0, 0, 150], upperArmR: [0, 0, -150], thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-20, 0, 0], footR: [-20, 0, 0] } }),
      kf(2, { root: { y: HIP_HEIGHT - 0.1 }, j: { thighL: [-24, 0, 6], shinL: [46, 0, 0], thighR: [-24, 0, -6], shinR: [46, 0, 0], spine: [-10, 0, 0], upperArmL: [-20, 0, 40], upperArmR: [-20, 0, -40] } }),
      kf(3, merge(weight(0.5), arms([0, 0, 20], [0, 0, -20]))),
      kf(4, { root: { y: HIP_HEIGHT - 0.16 }, j: { thighL: [-34, 0, 6], shinL: [66, 0, 0], thighR: [-34, 0, -6], shinR: [66, 0, 0], spine: [-16, 0, 0], upperArmL: [-30, 0, 24], upperArmR: [-30, 0, -24] } }),
      kf(5, { root: { y: HIP_HEIGHT + 0.05 }, j: { upperArmL: [0, 0, 150], upperArmR: [0, 0, -150], thighL: [0, 0, 4], thighR: [0, 0, -4], footL: [-20, 0, 0], footR: [-20, 0, 0] } }),
      kf(6, { root: { y: HIP_HEIGHT - 0.1 }, j: { thighL: [-24, 0, 6], shinL: [46, 0, 0], thighR: [-24, 0, -6], shinR: [46, 0, 0], upperArmL: [-20, 0, 40], upperArmR: [-20, 0, -40] } }),
      kf(8, merge(weight(0.5), arms([0, 0, 20], [0, 0, -20]))),
    ],
  },
  {
    id: "kickOut",
    name: "蹴り出し",
    counts: 8,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(1), arms([0, 0, 18], [0, 0, -18]))),
      kf(1, merge(weight(1), { j: { thighR: [-56, 0, -8], shinR: [10, 0, 0], upperArmL: [-70, 0, 20], upperArmR: [30, 0, -20], chest: [6, 0, 0] } })),
      kf(2, merge(weight(1), { j: { thighR: [10, 0, -8], shinR: [40, 0, 0], upperArmL: [0, 0, 18], upperArmR: [0, 0, -18] } })),
      kf(3, merge(weight(1), { j: { thighR: [-56, 0, -8], shinR: [10, 0, 0], upperArmL: [-70, 0, 20], upperArmR: [30, 0, -20] } })),
      kf(4, merge(weight(-1), arms([0, 0, 18], [0, 0, -18]))),
      kf(5, merge(weight(-1), { j: { thighL: [-56, 0, 8], shinL: [10, 0, 0], upperArmR: [-70, 0, -20], upperArmL: [30, 0, 20], chest: [6, 0, 0] } })),
      kf(6, merge(weight(-1), { j: { thighL: [10, 0, 8], shinL: [40, 0, 0], upperArmL: [0, 0, 18], upperArmR: [0, 0, -18] } })),
      kf(8, merge(weight(1), arms([0, 0, 18], [0, 0, -18]))),
    ],
  },
  {
    id: "armPump",
    name: "突き上げ",
    counts: 8,
    energy: 2,
    mirrorable: true,
    keyframes: [
      kf(0, merge(weight(0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
      kf(1, merge(weight(0.6), { j: { upperArmL: [0, 0, 168], upperArmR: [-40, 0, -30], forearmR: elbow(110), head: [-10, 0, 0] } })),
      kf(2, merge(weight(-0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [0, 0, -168], head: [-10, 0, 0] } })),
      kf(3, merge(weight(-0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
      kf(4, merge(weight(0.6), { j: { upperArmL: [0, 0, 168], upperArmR: [0, 0, -168], spine: [-8, 0, 0] } })),
      kf(5, merge(weight(0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
      kf(6, merge(weight(-0.6), { j: { upperArmL: [0, 0, 168], upperArmR: [0, 0, -168], spine: [-8, 0, 0] } })),
      kf(8, merge(weight(-0.6), { j: { upperArmL: [-40, 0, 30], forearmL: elbow(110), upperArmR: [-40, 0, -30], forearmR: elbow(110) } })),
    ],
  },
  {
    id: "poseCross",
    name: "キメ（腕クロス）",
    counts: 8,
    energy: 1,
    mirrorable: true,
    accent: true,
    keyframes: [
      kf(0, merge(weight(0.6), arms([0, 0, 14], [0, 0, -14]))),
      kf(1, merge(weight(0.6), arms([-30, 0, 80], [-30, 0, -80]))),
      kf(2, merge(weight(-0.8), { j: { upperArmL: [-80, 0, -20], forearmL: elbows(64, 52)[0], upperArmR: [-80, 0, 20], forearmR: elbows(64, 52)[1], chest: [0, 0, -8], head: [6, 0, -6] } })),
      kf(4, merge(weight(-0.8), { j: { upperArmL: [-80, 0, -20], forearmL: elbows(64, 52)[0], upperArmR: [-80, 0, 20], forearmR: elbows(64, 52)[1], chest: [0, 0, -8], head: [6, 0, -6] } }), "hold"),
      kf(5, merge(weight(0.6), arms([-20, 0, 60], [-20, 0, -60]))),
      kf(6, merge(weight(0.6), arms([0, 0, 14], [0, 0, -14]))),
      kf(8, merge(weight(-0.6), arms([0, 0, 14], [0, 0, -14]))),
    ],
  },
  {
    id: "poseFinish",
    name: "キメ（決めポーズ）",
    counts: 8,
    energy: 2,
    mirrorable: true,
    accent: true,
    keyframes: [
      kf(0, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
      kf(1, { root: { y: HIP_HEIGHT - 0.1 }, j: { thighL: [-26, 0, 8], shinL: [48, 0, 0], thighR: [-26, 0, -8], shinR: [48, 0, 0], spine: [-12, 0, 0], upperArmL: [-30, 0, 30], upperArmR: [-30, 0, -30] } }),
      kf(2, { root: { x: 0.03, y: HIP_HEIGHT }, j: { hips: [0, -14, 0], upperArmL: [-24, 0, 150], upperArmR: [20, 0, -44], forearmR: elbow(60), chest: [0, 8, 6], head: [-10, -10, 8], thighR: [-16, 0, -10], shinR: [26, 0, 0] } }),
      kf(4, { root: { x: 0.03, y: HIP_HEIGHT }, j: { hips: [0, -14, 0], upperArmL: [-24, 0, 150], upperArmR: [20, 0, -44], forearmR: elbow(60), chest: [0, 8, 6], head: [-10, -10, 8], thighR: [-16, 0, -10], shinR: [26, 0, 0] } }, "hold"),
      kf(6, { root: { x: 0.03, y: HIP_HEIGHT }, j: { hips: [0, -14, 0], upperArmL: [-24, 0, 150], upperArmR: [20, 0, -44], forearmR: elbow(60), chest: [0, 8, 6], head: [-10, -10, 8], thighR: [-16, 0, -10], shinR: [26, 0, 0] } }, "hold"),
      kf(8, merge(weight(0.5), arms([0, 0, 16], [0, 0, -16]))),
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
