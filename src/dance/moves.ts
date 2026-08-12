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

/** 振りの持ち味。生成する系統の絞り込みと、一覧の並べ分けに使う。 */
export type Mood = "cool" | "sultry" | "cute" | "conduct";

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
  /** 持ち味。生成でどの系統を使うかの絞り込みと、一覧の並べ分けに使う。 */
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

// --- 指揮 ---
//
// オーケストラを正面から見た向き（＝奏者から見た指揮者）で作ってある。
// 右手がタクト、左手が表情づけ、という古典的な役割分担。
//
// 打点の角度は「手をこの位置に置きたい」から逆運動学で解いて丸めたもの。
// 手で当てると必ず腕が伸び切るか肩が上がるので、位置から逆算している。

interface Hand {
  arm: Rot;
  /** 肘の曲げ（度）。生の配列ではなく必ずこの数値から `elbow()` で作る。 */
  elbow: number;
}

/** 右手（タクト）の置き場所。振る箱の中の打点。 */
const R = {
  /** 1拍目。体の正面やや下 */
  down: { arm: [-5, 0, 4], elbow: 60 },
  /** 2拍目。体を横切って内側へ */
  in: { arm: [-6, 0, 41], elbow: 52 },
  /** 3拍目。外へ払う */
  out: { arm: [1, 0, -45], elbow: 60 },
  /** 4拍目。跳ね上げ */
  up: { arm: [-100, 0, -28], elbow: 100 },
  /** 構え。胸の高さ */
  ready: { arm: [0, 0, -24], elbow: 91 },
  /** 大きく上へ */
  high: { arm: [-135, 0, -21], elbow: 58 },
  /** 大きく外へ */
  wide: { arm: [16, 0, -73], elbow: 43 },
  /** 低く抑える */
  low: { arm: [-13, 0, -5], elbow: 22 },
  /** 刻みの上。振り幅の小さい打点 */
  tickUp: { arm: [2, 0, -34], elbow: 109 },
  /** 刻みの下 */
  tickDown: { arm: [-1, 0, -16], elbow: 79 },
  /** 重い打点。腕ごと落とす */
  heavy: { arm: [-13, 0, 1], elbow: 30 },
  /** 内へ締める（カットオフ） */
  close: { arm: [9, 0, 25], elbow: 95 },
  /** 体側に下ろす（お辞儀） */
  side: { arm: [4, 0, -6], elbow: 22 },
} satisfies Record<string, Hand>;

/** 左手（表情づけ）の置き場所。 */
const L = {
  ready: { arm: [0, 0, 24], elbow: 91 },
  /** 手のひらを上に。引き出す */
  palm: { arm: [-7, 0, 35], elbow: 70 },
  /** 手のひらを下に。抑える */
  down: { arm: [-13, 0, 11], elbow: 26 },
  /** 高く開く */
  open: { arm: [-38, 0, 110], elbow: 64 },
  /** 大きく外へ */
  wide: { arm: [16, 0, 73], elbow: 43 },
  /** 指さし（合図） */
  point: { arm: [7, 0, 76], elbow: 69 },
  /** 内へ締める（カットオフ） */
  close: { arm: [9, 0, -25], elbow: 95 },
  /** 胸に当てる */
  chest: { arm: [30, 0, -10], elbow: 113 },
  /** 体側に下ろす（お辞儀） */
  side: { arm: [4, 0, 6], elbow: 22 },
} satisfies Record<string, Hand>;

/**
 * 体を斜めに向ける角度（度）。
 *
 * 指揮はほぼ全部が「前へ差し出す」動きで、カメラが正面固定だと前腕が
 * 短縮して消え、手が顔の横に上がっているようにしか見えない（実際そうなった）。
 * 体を斜めにすると前後の動きが画面上の左右に化けて読めるようになる。
 * README の「前後を見せたい振りは hips の Y 回転で体を斜めに向けること」。
 */
const PODIUM_TURN = 22;

/**
 * 指揮台の上の構え。
 *
 * 足はほとんど動かさない。指揮者の下半身は踊らないので、ここを動かすと
 * 途端に「指揮者っぽさ」が消える。`lean` は前傾（度）、`turn` は上体の振り向き。
 */
function podium(lean = 0, turn = 0): Pose {
  return {
    root: { y: HIP_HEIGHT },
    j: {
      hips: [0, PODIUM_TURN, 0],
      thighL: [0, 0, 5],
      thighR: [0, 0, -5],
      shinL: [5, 0, 0],
      shinR: [5, 0, 0],
      spine: [-lean * 0.55, turn * 0.3, 0],
      chest: [-lean * 0.45, turn * 0.7, 0],
    },
  };
}

/** 指揮の両腕。右手（タクト）と左手（表情づけ）を別々に置く。 */
function baton(right: Hand, left: Hand): Pose {
  return arms(left.arm, right.arm, elbow(left.elbow), elbow(right.elbow));
}

/** 顔と目線。`turn` は正で キャラの左（画面右）を向く。 */
function gaze(turn: number, tilt = 0): Pose {
  return { j: { neck: [tilt * 0.4, turn * 0.35, 0], head: [tilt * 0.6, turn * 0.65, 0] } };
}

export const MOVES: Move[] = [
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

  // --- ステップ（足で刻む） ---
  {
    id: "twoStep",
    name: "ツーステップ",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(0.8), arms([-22, 0, 36], [-22, 0, -36], ...elbows(62, 18)))),
      kf(1, merge(weight(0.8), { j: { thighR: [-28, 0, -16], shinR: [32, 0, 0], footR: [-12, 0, 0], upperArmL: [-26, 0, 44], forearmL: elbow(72), upperArmR: [-26, 0, -26], forearmR: elbow(72), chest: [0, 12, 0] } })),
      kf(2, merge(weight(-0.8), arms([-22, 0, 30], [-22, 0, -42], ...elbows(62, 18)))),
      kf(3, merge(weight(-0.8), { j: { thighL: [-28, 0, 16], shinL: [32, 0, 0], footL: [-12, 0, 0], upperArmR: [-26, 0, -44], forearmR: elbow(72), upperArmL: [-26, 0, 26], forearmL: elbow(72), chest: [0, -12, 0] } })),
      kf(4, merge(weight(0.8), arms([-22, 0, 36], [-22, 0, -36], ...elbows(62, 18)))),
    ],
  },
  {
    id: "crossStep",
    name: "クロスステップ",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    keyframes: [
      kf(0, merge(weight(1), arms([-14, 0, 28], [-14, 0, -28], ...elbows(54, 16)))),
      kf(1, merge(weight(1), { j: { thighR: [-20, 0, 28], shinR: [26, 0, 0], footR: [-10, 0, 0], chest: [0, 16, 0], head: [0, 10, 0], upperArmL: [-32, 0, 54], forearmL: elbow(68), upperArmR: [-20, 0, -32], forearmR: elbow(54) } })),
      kf(2, merge(weight(-1), { j: { thighR: [2, 0, -8], shinR: [10, 0, 0], chest: [0, -12, 0] } })),
      kf(3, merge(weight(-1), { j: { thighL: [-20, 0, -28], shinL: [26, 0, 0], footL: [-10, 0, 0], chest: [0, -16, 0], head: [0, -10, 0], upperArmR: [-32, 0, -54], forearmR: elbow(68), upperArmL: [-20, 0, 32], forearmL: elbow(54) } })),
      kf(4, merge(weight(1), arms([-14, 0, 28], [-14, 0, -28], ...elbows(54, 16)))),
    ],
  },
  {
    id: "slideStep",
    name: "滑るステップ",
    counts: 4,
    energy: 2,
    mirrorable: true,
    mood: "cool",
    // 足の位置を打ち消さずに腰ごと横へ運ぶ。踏み替えずに滑って見えるのが狙い。
    // 出て戻る形にして、ブロックの終わりで元の位置へ返す（次の振りへ飛ばないため）
    keyframes: [
      kf(0, { root: { y: HIP_HEIGHT }, j: { upperArmL: [-20, 0, 38], forearmL: elbow(58), upperArmR: [-20, 0, -38], forearmR: elbow(58) } }),
      kf(1, { root: { x: 0.13, y: HIP_HEIGHT }, j: { thighL: [-14, 0, 8], shinL: [24, 0, 0], footL: [-26, 0, 0], thighR: [10, 0, -8], shinR: [10, 0, 0], chest: [0, 0, -8], upperArmL: [-24, 0, 30], forearmL: elbow(64), upperArmR: [-16, 0, -46], forearmR: elbow(50) } }, "inout"),
      kf(2, { root: { y: HIP_HEIGHT }, j: { upperArmL: [-20, 0, 38], forearmL: elbow(58), upperArmR: [-20, 0, -38], forearmR: elbow(58) } }, "inout"),
      kf(3, { root: { x: -0.13, y: HIP_HEIGHT }, j: { thighR: [-14, 0, -8], shinR: [24, 0, 0], footR: [-26, 0, 0], thighL: [10, 0, 8], shinL: [10, 0, 0], chest: [0, 0, 8], upperArmR: [-24, 0, -30], forearmR: elbow(64), upperArmL: [-16, 0, 46], forearmL: elbow(50) } }, "inout"),
      kf(4, { root: { y: HIP_HEIGHT }, j: { upperArmL: [-20, 0, 38], forearmL: elbow(58), upperArmR: [-20, 0, -38], forearmR: elbow(58) } }, "inout"),
    ],
  },
  {
    id: "sideStep",
    name: "サイドステップ",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.9), { j: { upperArmL: [-24, 0, 42], forearmL: elbows(78, 26)[0], upperArmR: [-24, 0, -42], forearmR: elbows(78, 26)[1], head: [0, 0, 10] } })),
      kf(1, merge(weight(0.9), { j: { thighR: [-10, 0, -22], shinR: [18, 0, 0], footR: [-14, 0, 0], upperArmL: [-30, 0, 56], forearmL: elbows(64, 20)[0], upperArmR: [-30, 0, -30], forearmR: elbows(64, 20)[1], head: [0, 0, 12] } })),
      kf(2, merge(weight(-0.9), { j: { upperArmL: [-24, 0, 42], forearmL: elbows(78, 26)[0], upperArmR: [-24, 0, -42], forearmR: elbows(78, 26)[1], head: [0, 0, -10] } })),
      kf(3, merge(weight(-0.9), { j: { thighL: [-10, 0, 22], shinL: [18, 0, 0], footL: [-14, 0, 0], upperArmR: [-30, 0, -56], forearmR: elbows(64, 20)[1], upperArmL: [-30, 0, 30], forearmL: elbows(64, 20)[0], head: [0, 0, -12] } })),
      kf(4, merge(weight(0.9), { j: { upperArmL: [-24, 0, 42], forearmL: elbows(78, 26)[0], upperArmR: [-24, 0, -42], forearmR: elbows(78, 26)[1], head: [0, 0, 10] } })),
    ],
  },
  {
    id: "heelStep",
    name: "かかとで刻む",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "cute",
    keyframes: [
      kf(0, merge(weight(0.9), { j: { upperArmL: [-30, 0, 34], forearmL: elbows(92, 40)[0], upperArmR: [-30, 0, -34], forearmR: elbows(92, 40)[1] } })),
      kf(1, merge(weight(0.9), { j: { thighR: [-24, 0, -6], shinR: [6, 0, 0], footR: [-30, 0, 0], upperArmL: [-36, 0, 44], forearmL: elbows(84, 34)[0], upperArmR: [-36, 0, -44], forearmR: elbows(84, 34)[1], head: [0, 0, 8] } })),
      kf(2, merge(weight(0.9), { j: { thighR: [4, 0, -6], shinR: [30, 0, 0], footR: [28, 0, 0], upperArmL: [-30, 0, 34], forearmL: elbows(92, 40)[0], upperArmR: [-30, 0, -34], forearmR: elbows(92, 40)[1], head: [0, 0, -8] } })),
      kf(3, merge(weight(-0.9), { j: { upperArmL: [-30, 0, 34], forearmL: elbows(92, 40)[0], upperArmR: [-30, 0, -34], forearmR: elbows(92, 40)[1] } })),
      kf(4, merge(weight(-0.9), { j: { thighL: [-24, 0, 6], shinL: [6, 0, 0], footL: [-30, 0, 0], upperArmL: [-36, 0, 44], forearmL: elbows(84, 34)[0], upperArmR: [-36, 0, -44], forearmR: elbows(84, 34)[1], head: [0, 0, -8] } })),
    ],
  },
  {
    id: "backStep",
    name: "下がって戻る",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "sultry",
    keyframes: [
      kf(0, merge(weight(0.7), arms([-12, 0, 26], [-12, 0, -26], ...elbows(50, 14)))),
      kf(1, merge(weight(0.7), { j: { thighR: [22, 0, -8], shinR: [34, 0, 0], footR: [18, 0, 0], spine: [10, 0, 0], chest: [0, 10, 0], head: [6, 10, 0], upperArmL: [-26, 0, 30], forearmL: elbows(86, 34)[0], upperArmR: [8, 0, -28], forearmR: elbow(32) } })),
      kf(2, merge(weight(0.7), { j: { thighR: [22, 0, -8], shinR: [34, 0, 0], footR: [18, 0, 0], spine: [10, 0, 0], chest: [0, 10, 0], head: [6, 10, 0], upperArmL: [-26, 0, 30], forearmL: elbows(86, 34)[0], upperArmR: [8, 0, -28], forearmR: elbow(32) } }), "hold"),
      kf(4, merge(weight(-0.7), arms([-12, 0, 26], [-12, 0, -26], ...elbows(50, 14)))),
    ],
  },
  {
    id: "poseCross",
    name: "キメ（腕クロス）",
    counts: 4,
    mood: "cool",
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
    mood: "cool",
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
  // --- 指揮 ---
  {
    id: "conduct4",
    name: "4拍子を振る",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(3), baton(R.down, L.ready), gaze(0, 4))),
      kf(1, merge(podium(3, 6), baton(R.in, L.ready), gaze(6))),
      kf(2, merge(podium(3, -8), baton(R.out, L.ready), gaze(-8))),
      kf(3, merge(podium(1), baton(R.up, L.ready), gaze(0, -6))),
      kf(4, merge(podium(3), baton(R.down, L.ready), gaze(0, 4))),
    ],
  },
  {
    id: "conduct3",
    name: "3拍子を振る",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    // 3拍子は丸い三角形を描く。4カウントの枠に3つの打点を等間隔で入れるので、
    // ここだけキーフレームが表拍から外れる（このアプリで初めて裏拍に置いた振り）
    keyframes: [
      kf(0, merge(podium(3), baton(R.down, L.ready), gaze(0, 4))),
      kf(4 / 3, merge(podium(2, -7), baton(R.out, L.ready), gaze(-7)), "inout"),
      kf(8 / 3, merge(podium(1), baton(R.up, L.ready), gaze(0, -5)), "inout"),
      kf(4, merge(podium(3), baton(R.down, L.ready), gaze(0, 4))),
    ],
  },
  {
    id: "conduct2",
    name: "2拍子を振る",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(4), baton(R.heavy, L.ready), gaze(0, 6))),
      kf(1, merge(podium(0), baton(R.high, L.ready), gaze(0, -8))),
      kf(2, merge(podium(4), baton(R.heavy, L.ready), gaze(0, 6))),
      kf(3, merge(podium(0), baton(R.high, L.ready), gaze(0, -8))),
      kf(4, merge(podium(4), baton(R.heavy, L.ready), gaze(0, 6))),
    ],
  },
  {
    id: "subdivide",
    name: "刻みを細かく",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    // 6分割。1拍の中を3つに割るので打点は 2/3 カウントおき
    keyframes: [
      kf(0, merge(podium(2), baton(R.tickDown, L.down), gaze(0, 3))),
      kf(2 / 3, merge(podium(2), baton(R.tickUp, L.down), gaze(0, -3))),
      kf(4 / 3, merge(podium(2), baton(R.tickDown, L.down), gaze(0, 3))),
      kf(2, merge(podium(2), baton(R.tickUp, L.down), gaze(0, -3))),
      kf(8 / 3, merge(podium(2), baton(R.tickDown, L.down), gaze(0, 3))),
      kf(10 / 3, merge(podium(2), baton(R.tickUp, L.down), gaze(0, -3))),
      kf(4, merge(podium(2), baton(R.tickDown, L.down), gaze(0, 3))),
    ],
  },
  {
    id: "batonReady",
    name: "タクトを構える",
    counts: 4,
    energy: 0,
    mirrorable: false,
    mood: "conduct",
    // 曲が始まる前の一瞬。ここで止まるから次の打点が生きる
    keyframes: [
      kf(0, merge(podium(0), baton(R.low, L.down), gaze(0, 2))),
      kf(1, merge(podium(2), baton(R.ready, L.ready), gaze(0, -4))),
      kf(2, merge(podium(2), baton(R.ready, L.ready), gaze(0, -4)), "hold"),
      kf(3, merge(podium(2), baton(R.ready, L.ready), gaze(0, -4)), "hold"),
      kf(4, merge(podium(2), baton(R.ready, L.ready), gaze(0, -4)), "hold"),
    ],
  },
  {
    id: "upbeat",
    name: "アウフタクト",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    // 息を吸って上げ、落として1拍目を出す
    keyframes: [
      kf(0, merge(podium(2), baton(R.ready, L.ready), gaze(0, -2))),
      kf(1, merge(podium(-2), baton(R.high, L.palm), gaze(0, -10))),
      kf(2, merge(podium(6), baton(R.down, L.ready), gaze(0, 8))),
      kf(3, merge(podium(3, -6), baton(R.out, L.ready), gaze(-6))),
      kf(4, merge(podium(2), baton(R.ready, L.ready), gaze(0, -2))),
    ],
  },
  {
    id: "cuePoint",
    name: "合図を出す",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "conduct",
    // 左手で指して、必ず目線も向ける。手だけ向けても合図に見えない
    keyframes: [
      kf(0, merge(podium(2), baton(R.ready, L.ready), gaze(0))),
      kf(1, merge(podium(2, 16), baton(R.tickUp, L.point), gaze(24, -4))),
      kf(2, merge(podium(2, 16), baton(R.tickDown, L.point), gaze(24, -4))),
      kf(3, merge(podium(2, 6), baton(R.ready, L.palm), gaze(10))),
      kf(4, merge(podium(2), baton(R.ready, L.ready), gaze(0))),
    ],
  },
  {
    id: "crescendo",
    name: "クレッシェンド",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    // 左手が下から開きながら上がる。上体も一緒に起きていく
    keyframes: [
      kf(0, merge(podium(5), baton(R.down, L.down), gaze(0, 6))),
      kf(1, merge(podium(3), baton(R.out, L.palm), gaze(-4, 2)), "inout"),
      kf(2, merge(podium(0), baton(R.down, L.palm), gaze(0, -2)), "inout"),
      kf(3, merge(podium(-3), baton(R.up, L.open), gaze(0, -10)), "inout"),
      kf(4, merge(podium(-5), baton(R.high, L.open), gaze(0, -14)), "inout"),
    ],
  },
  {
    id: "diminuendo",
    name: "ディミヌエンド",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(-4), baton(R.high, L.open), gaze(0, -12)), "inout"),
      kf(1, merge(podium(0), baton(R.out, L.palm), gaze(-4, -2)), "inout"),
      kf(2, merge(podium(3), baton(R.tickDown, L.palm), gaze(0, 4)), "inout"),
      kf(3, merge(podium(6), baton(R.low, L.down), gaze(0, 10)), "inout"),
      kf(4, merge(podium(7), baton(R.low, L.down), gaze(0, 12)), "inout"),
    ],
  },
  {
    id: "hushDown",
    name: "静かに抑える",
    counts: 4,
    energy: 0,
    mirrorable: false,
    mood: "conduct",
    // 左の手のひらを下へ押さえながら、右は小さく刻む
    keyframes: [
      kf(0, merge(podium(4), baton(R.tickUp, L.palm), gaze(0, 6))),
      kf(1, merge(podium(6), baton(R.tickDown, L.down), gaze(0, 10))),
      kf(2, merge(podium(6), baton(R.tickUp, L.down), gaze(0, 10))),
      kf(3, merge(podium(7), baton(R.tickDown, L.down), gaze(0, 12))),
      kf(4, merge(podium(7), baton(R.tickUp, L.down), gaze(0, 12))),
    ],
  },
  {
    id: "tutti",
    name: "全員で",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(3), baton(R.ready, L.ready), gaze(0, 2))),
      kf(1, merge(podium(-2), baton(R.wide, L.wide), gaze(0, -8))),
      kf(2, merge(podium(-5), baton(R.high, L.open), gaze(0, -14))),
      kf(3, merge(podium(-2), baton(R.wide, L.wide), gaze(0, -8))),
      kf(4, merge(podium(3), baton(R.ready, L.ready), gaze(0, 2))),
    ],
  },
  {
    id: "sforzando",
    name: "鋭く出す",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    // 打点で全身が止まる。止まるから鋭く見える
    keyframes: [
      kf(0, merge(podium(0), baton(R.high, L.chest), gaze(0, -10))),
      kf(1, merge(podium(10), baton(R.heavy, L.close), gaze(0, 14))),
      kf(2, merge(podium(10), baton(R.heavy, L.close), gaze(0, 14)), "hold"),
      kf(3, merge(podium(3), baton(R.ready, L.ready), gaze(0, 2))),
      kf(4, merge(podium(0), baton(R.high, L.chest), gaze(0, -10))),
    ],
  },
  {
    id: "legato",
    name: "レガート",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    // 打点を作らず横へ流す。ease を inout にして角を消す
    keyframes: [
      kf(0, merge(podium(2, -8), baton(R.out, L.palm), gaze(-8, -2))),
      kf(1, merge(podium(2, 8), baton(R.in, L.wide), gaze(8, -2)), "inout"),
      kf(2, merge(podium(2, -8), baton(R.out, L.open), gaze(-8, -4)), "inout"),
      kf(3, merge(podium(2, 8), baton(R.in, L.palm), gaze(8, -2)), "inout"),
      kf(4, merge(podium(2, -8), baton(R.out, L.palm), gaze(-8, -2)), "inout"),
    ],
  },
  {
    id: "staccato",
    name: "スタッカート",
    counts: 4,
    energy: 1,
    mirrorable: false,
    mood: "conduct",
    // 手首から先だけの小さい打点を裏拍まで刻む
    keyframes: [
      kf(0, merge(podium(3), baton(R.tickDown, L.down), gaze(0, 4))),
      kf(0.5, merge(podium(3), baton(R.tickUp, L.down), gaze(0, 1))),
      kf(1, merge(podium(3), baton(R.tickDown, L.down), gaze(0, 4))),
      kf(1.5, merge(podium(3), baton(R.tickUp, L.down), gaze(0, 1))),
      kf(2, merge(podium(3), baton(R.tickDown, L.down), gaze(0, 4))),
      kf(2.5, merge(podium(3), baton(R.tickUp, L.down), gaze(0, 1))),
      kf(3, merge(podium(3), baton(R.tickDown, L.down), gaze(0, 4))),
      kf(3.5, merge(podium(3), baton(R.tickUp, L.down), gaze(0, 1))),
      kf(4, merge(podium(3), baton(R.tickDown, L.down), gaze(0, 4))),
    ],
  },
  {
    id: "marcato",
    name: "マルカート",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(0), baton(R.ready, L.ready), gaze(0, -4))),
      kf(1, merge(podium(8, 5), baton(R.heavy, L.down), gaze(4, 12))),
      kf(2, merge(podium(0), baton(R.up, L.ready), gaze(0, -6))),
      kf(3, merge(podium(8, -5), baton(R.heavy, L.down), gaze(-4, 12))),
      kf(4, merge(podium(0), baton(R.ready, L.ready), gaze(0, -4))),
    ],
  },
  {
    id: "singGesture",
    name: "歌わせる",
    counts: 4,
    energy: 1,
    mirrorable: true,
    mood: "conduct",
    // 手のひらを上に、引き出すように。上体を寄せて顔を傾ける
    keyframes: [
      kf(0, merge(podium(2), baton(R.ready, L.palm), gaze(4, 2))),
      kf(1, merge(podium(6, 10), baton(R.tickDown, L.palm), gaze(16, 8)), "inout"),
      kf(2, merge(podium(4, 12), baton(R.tickUp, L.wide), gaze(18, 4)), "inout"),
      kf(3, merge(podium(2, 6), baton(R.ready, L.palm), gaze(10, 2)), "inout"),
      kf(4, merge(podium(2), baton(R.ready, L.palm), gaze(4, 2)), "inout"),
    ],
  },
  {
    id: "leanIn",
    name: "乗り出して煽る",
    counts: 4,
    energy: 2,
    mirrorable: false,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(2), baton(R.ready, L.ready), gaze(0, 2))),
      kf(1, merge(podium(14), baton(R.low, L.down), gaze(0, 16))),
      kf(2, merge(podium(8), baton(R.tickUp, L.palm), gaze(0, 6))),
      kf(3, merge(podium(14), baton(R.heavy, L.down), gaze(0, 16))),
      kf(4, merge(podium(2), baton(R.ready, L.ready), gaze(0, 2))),
    ],
  },
  {
    id: "cutoff",
    name: "キメ（切る）",
    counts: 4,
    energy: 2,
    mirrorable: false,
    accent: true,
    mood: "conduct",
    // 両手で輪を閉じて、そこで完全に止める
    keyframes: [
      kf(0, merge(podium(-2), baton(R.wide, L.wide), gaze(0, -8))),
      kf(1, merge(podium(4), baton(R.close, L.close), gaze(0, 6))),
      kf(2, merge(podium(4), baton(R.close, L.close), gaze(0, 6)), "hold"),
      kf(3, merge(podium(4), baton(R.close, L.close), gaze(0, 6)), "hold"),
      kf(4, merge(podium(4), baton(R.close, L.close), gaze(0, 6)), "hold"),
    ],
  },
  {
    id: "fermata",
    name: "キメ（フェルマータ）",
    counts: 4,
    energy: 2,
    mirrorable: false,
    accent: true,
    mood: "conduct",
    // 伸ばす。上げ切ったまま動かないのがフェルマータ
    keyframes: [
      kf(0, merge(podium(3), baton(R.ready, L.ready), gaze(0, 2))),
      kf(1, merge(podium(-6), baton(R.high, L.open), gaze(0, -16))),
      kf(2, merge(podium(-6), baton(R.high, L.open), gaze(0, -16)), "hold"),
      kf(3, merge(podium(-6), baton(R.high, L.open), gaze(0, -16)), "hold"),
      kf(4, merge(podium(-6), baton(R.high, L.open), gaze(0, -16)), "hold"),
    ],
  },
  {
    id: "maestroBow",
    name: "キメ（お辞儀）",
    counts: 4,
    energy: 0,
    mirrorable: false,
    accent: true,
    mood: "conduct",
    keyframes: [
      kf(0, merge(podium(0), baton(R.ready, L.ready), gaze(0, -2))),
      kf(1, merge(podium(0), baton(R.side, L.side), gaze(0, 2))),
      kf(2, merge(podium(42), baton(R.side, L.side), gaze(0, 14))),
      kf(3, merge(podium(42), baton(R.side, L.side), gaze(0, 14)), "hold"),
      kf(4, merge(podium(42), baton(R.side, L.side), gaze(0, 14)), "hold"),
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
