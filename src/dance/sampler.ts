/**
 * 振り付けデータから「今この瞬間のポーズ」を作る。
 *
 * やっていることは3つ。
 *
 * 1. キーフレーム間の補間（イージング付き）
 * 2. ブロックの切り替わりでの短いブレンド。ここを繋がないと、8カウントごとに
 *    ポーズが飛んで、動きがぶつ切りに見える
 * 3. ビートに乗った上下動（バウンス）を全身に足す
 *
 * 3 が効く。これが無いと、どれだけ丁寧にポーズを作っても「ポーズの連続」に
 * しか見えない。逆にこれがあるだけで、拍に乗って踊っているように見える。
 */

import { getMove, type Ease, type Move } from "./moves";
import type { ChoreoBlock, Choreography } from "./choreo";
import { plantFeet } from "./ground";
import {
  blendPose,
  DEFAULT_BODY,
  HIP_HEIGHT,
  type Body,
  mirrorPose,
  solvePose,
  type JointName,
  type Pose,
  type PosedSkeleton,
  type Rot,
} from "./skeleton";

/**
 * ブロックの切り替わりを繋ぐ長さ（カウント）。境界の前後にこのぶんずつ取る。
 *
 * 境界の後ろだけで繋ぐと、前の振りが最後まで残ってから急に次の振りへ移るので、
 * 手先の速度が上がりすぎる。境界をまたいで対称に混ぜると、同じ滑らかさを
 * 倍の時間をかけて稼げる。
 */
const BLEND_HALF = 0.25;

/**
 * キメのブロックに接する境界での繋ぎ幅。
 *
 * 締めのポーズは決まった瞬間に止まって見えてほしいが、通常の繋ぎ幅だと
 * その前後 0.25 カウントが常にクロスフェードに食われて、キメが丸くなる。
 * ここだけ狭くして、締めをはっきりさせる。
 *
 * 狭くするほど手先の速度が上がるので、際限なく詰められるわけではない。
 * この値は「動きが飛ばない」テストの実測値を見ながら決めてある。
 */
const ACCENT_BLEND_HALF = 0.14;

/** バウンスの最大の沈み込み（ワールド単位）。 */
const MAX_DIP = 0.055;

/**
 * 1ビートのうち、沈み込みに使う割合。残りは戻り（浮き上がり）に使う。
 *
 * 対称な cos で上下させると「浮いている」ように見える。実際の体は
 * ゆっくり伸び上がって素早く落ちるので、落ちる側を短くすると重さが出る。
 */
const DROP_SHARE = 0.38;

/** ダイナミクス最大のときに上下動を何倍まで深くするか。 */
const BOUNCE_GAIN = 0.7;

/** 太もも＋すねの長さ。しゃがみ角度の計算に使う。 */
const LEG_SEGMENT = 0.44;

/** 脚全体の長さ。横に振ったときの足の位置の打ち消しに使う。 */
const LEG_TOTAL = 0.88;

/** 横ノリの最大の重心移動（ワールド単位）。 */
const MAX_SWAY = 0.05;

/**
 * ダイナミクス最大のとき、キーフレーム間のどれだけを静止に回すか。
 *
 * キレは「速く動く」ではなく「速く動いて止まる」で作る。1カウントかけて
 * 動き続けると、どれだけ鋭い曲線を使っても体操にしか見えない。
 */
const HOLD_SHARE = 0.55;

/** 行き過ぎて戻る量。0 で行き過ぎなし。 */
const OVERSHOOT = 1.7;

function ease(kind: Ease | undefined, t: number, snap = 0): number {
  switch (kind) {
    case "linear":
      return t;
    case "inout":
      return t * t * (3 - 2 * t);
    case "hold":
      // 目標のカウントに来るまで動かない。キメを保つときに使う
      return t >= 1 ? 1 : 0;
    case "out":
    default: {
      // 到達に使う割合。残りは静止に回る
      const reach = 1 - HOLD_SHARE * snap;
      const u = Math.min(1, t / reach);
      // 速く入って落ち着く。snap を上げるほど出だしが鋭くなる
      const sharp = 1 - Math.pow(1 - u, 2.2 + 1.8 * snap);
      if (snap <= 0) return sharp;
      // 行き過ぎてから戻る（アンティシペーションの裏返し）。
      // 生き物の動きは目標でぴたりと止まらず、必ず少し越えて返ってくる
      const c1 = OVERSHOOT * snap;
      const c3 = c1 + 1;
      const back = 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
      return sharp + (back - sharp) * snap;
    }
  }
}

/** パーツ内のローカルカウント位置のポーズ。範囲外は端のキーフレームで留める。 */
function sampleMove(move: Move, localCount: number, snap: number): Pose {
  const frames = move.keyframes;
  if (frames.length === 0) return {};
  if (localCount <= frames[0].count) return frames[0].pose;

  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (localCount < b.count) {
      const span = b.count - a.count;
      const t = span <= 0 ? 1 : (localCount - a.count) / span;
      return blendPose(a.pose, b.pose, ease(b.ease, t, snap));
    }
  }
  return frames[frames.length - 1].pose;
}

/**
 * ブロックのローカルカウントにおけるポーズ。
 *
 * 左右反転は補間の後にかけている。反転は成分の符号反転と関節名の入れ替えだけ
 * なので、補間と順序を入れ替えても結果は変わらない。
 */
function samplePoseInBlock(block: ChoreoBlock, localCount: number, snap: number): Pose {
  const move = getMove(block.moveId);
  if (!move) return {};
  const pose = sampleMove(move, localCount, snap);
  return block.mirrored ? mirrorPose(pose) : pose;
}

function findBlockIndex(blocks: ChoreoBlock[], count: number): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (count >= blocks[i].startCount) return i;
  }
  return 0;
}

function addRot(j: Partial<Record<JointName, Rot>>, name: JointName, dx: number, dz = 0): void {
  const cur: Rot = j[name] ?? [0, 0, 0];
  j[name] = [cur[0] + dx, cur[1], cur[2] + dz];
}

/**
 * ビートに乗った上下動を足す。
 *
 * 腰を下げるだけだと足が地面にめり込むので、沈んだぶんだけ膝を曲げて
 * 足首の位置を保つ。太もも α・膝 2α で、足首がほぼ真下に留まる。
 */
/**
 * 拍の中の位相 0..1 に対する沈み込みの深さ 0..1。
 *
 * 位相 0（拍の頭）が一番沈んだ瞬間。そこから時間をかけて伸び上がり、
 * 次の拍の直前で一気に落ちる。両端とも cos の半波なので、繋ぎ目では
 * 速度が 0 になり、段差も折れも出ない。
 */
function bounceDip(beatPhase: number): number {
  const rise = 1 - DROP_SHARE;
  if (beatPhase < rise) {
    // 伸び上がり: 1 → 0。時間をかける
    return 0.5 + 0.5 * Math.cos(Math.PI * (beatPhase / rise));
  }
  // 沈み込み: 0 → 1。短く速く
  return 0.5 - 0.5 * Math.cos(Math.PI * ((beatPhase - rise) / DROP_SHARE));
}

/**
 * 横ノリの、拍をまたぐ重心の移り。0（今の側）→ 1（反対側）。
 *
 * 拍の頭で乗り切っていて、しばらくそこに留まり、次の拍の直前で一気に
 * 移る。等速で往復させると「揺れている」だけで、拍に乗って見えない。
 * 両端とも cos の半波なので、拍をまたいでも速度が 0 で繋がる。
 */
function swingPhase(beatPhase: number): number {
  const hold = 1 - DROP_SHARE;
  // 留まっている間もわずかには流れる。完全に止めると人形に見える
  const drift = 0.25;
  if (beatPhase < hold) {
    return drift * 0.5 * (1 - Math.cos(Math.PI * (beatPhase / hold)));
  }
  const t = (beatPhase - hold) / DROP_SHARE;
  return drift + (1 - drift) * 0.5 * (1 - Math.cos(Math.PI * t));
}

/** 横ノリの重心位置 -1..1。拍ごとに左右が入れ替わる（周期は2拍）。 */
function swayAt(pos: number): number {
  const beat = Math.floor(pos);
  const phase = pos - beat;
  const side = beat % 2 === 0 ? 1 : -1;
  return side * (1 - 2 * swingPhase(phase));
}

/**
 * 拍に乗った体重の移動を足す。
 *
 * 縦（沈み込み）と横（重心の左右移動）を groove で混ぜる。
 * 縦だけだとスクワットのように見えることがあり、実際のダンスでは
 * 横に乗るほうが多い。どちらが合うかは曲によるので選べるようにしてある。
 */
function applyGroove(
  pose: Pose,
  pos: number,
  amount: number,
  snap: number,
  groove: number,
): Pose {
  if (amount <= 0) return pose;
  const gain = 1 + BOUNCE_GAIN * snap;
  const beatPhase = pos - Math.floor(pos);

  const dip = MAX_DIP * gain * amount * (1 - groove) * bounceDip(beatPhase);
  const shift = MAX_SWAY * gain * amount * groove * swayAt(pos);
  if (dip <= 0.0005 && Math.abs(shift) <= 0.0005) return pose;

  const j: Partial<Record<JointName, Rot>> = { ...pose.j };

  if (dip > 0.0005) {
    const cos = Math.min(1, Math.max(-1, 1 - dip / (2 * LEG_SEGMENT)));
    const alpha = (Math.acos(cos) * 180) / Math.PI;
    addRot(j, "thighL", -alpha);
    addRot(j, "thighR", -alpha);
    addRot(j, "shinL", 2 * alpha);
    addRot(j, "shinR", 2 * alpha);
    // 沈むときに上体がわずかに前へ出ると、重さが乗って見える
    addRot(j, "spine", -alpha * 0.22);
    addRot(j, "head", alpha * 0.12);
  }

  if (Math.abs(shift) > 0.0005) {
    // 腰を横へ運ぶと足が地面から離れるので、太ももを逆に倒して打ち消す。
    // weight() が振り付け側でやっているのと同じ補正
    const comp = (Math.atan2(shift, LEG_TOTAL) * 180) / Math.PI;
    addRot(j, "thighL", 0, -comp);
    addRot(j, "thighR", 0, -comp);
    // 腰が出た側と逆へ上体を返すと、重心が乗って見える
    const lean = (shift / MAX_SWAY) * 4;
    addRot(j, "hips", 0, -lean * 0.8);
    addRot(j, "spine", 0, lean * 0.9);
    addRot(j, "chest", 0, lean * 0.7);
    addRot(j, "head", 0, -lean * 0.5);
  }

  const root = pose.root ?? {};
  return {
    root: { ...root, x: (root.x ?? 0) + shift, y: (root.y ?? HIP_HEIGHT) - dip },
    j,
  };
}

/**
 * 体の連鎖（キネティックチェーン）の段。
 *
 * 実際の体は腰から手先へ向かって順に動く。腰が向きを変え、少し遅れて胸が
 * ついてきて、最後に手先が振られる。全関節が同時に到達すると、人形が一斉に
 * 折れ曲がったように見えて、これが硬さの正体になる。
 *
 * 脚は体重を支えていて先に動くので段 0。そこから背骨を上って手先が最後。
 * 遅れの量は「拍に対する割合」で持つ。テンポが変われば遅れも一緒に伸び縮み
 * するほうが、音に対する乗り方としては自然。
 */
const CHAIN_TIERS: Array<{ steps: number; joints: JointName[] }> = [
  { steps: 1, joints: ["spine"] },
  { steps: 2, joints: ["chest", "neck", "upperArmL", "upperArmR"] },
  { steps: 3, joints: ["head", "headTop", "forearmL", "forearmR"] },
  { steps: 4, joints: ["handL", "knuckleL", "handTipL", "handR", "knuckleR", "handTipR"] },
];

/** 段ひとつぶんの遅れ（カウント）。最大でも 4 段なので全体で 0.2 カウント。 */
const CHAIN_STEP = 0.05;

/**
 * 追従（二次運動）を掛ける関節。先端ほど強い。
 *
 * 脚と腰には掛けない。接地の解決が足の位置を決めているところへ後から角度を
 * 足すと、せっかく床に置いた足がまた浮く。`AMPLIFY` と同じ線引き。
 */
const FOLLOW_TIERS: Array<{ gain: number; joints: JointName[] }> = [
  { gain: 0.4, joints: ["chest", "upperArmL", "upperArmR"] },
  { gain: 0.7, joints: ["neck", "head", "headTop", "forearmL", "forearmR"] },
  { gain: 1, joints: ["handL", "knuckleL", "handTipL", "handR", "knuckleR", "handTipR"] },
];

/**
 * 加速度を測る幅（カウント）。
 *
 * 広げるほど、ゆっくりした動きの追従まで拾って全体が重くなる。狭めると
 * 鋭い止まりにだけ反応する。1拍の 1/8 に置いてある。
 */
const FOLLOW_STEP = 0.12;

/** 追従の最大の強さ（`follow` が 1 のとき）。 */
const FOLLOW_MAX = 0.55;

const ZERO_ROT: Rot = [0, 0, 0];

/**
 * 肘がロックアウトしない量（度）。
 *
 * 人は腕を上げるとき、肘を完全に伸ばし切らない。伸び切った腕は「棒」に
 * 見えるので、腕を上げた分だけわずかに緩める。バウンスが「腰を沈めた分だけ
 * 膝を曲げる」のと同じ層の処理。
 */
const ELBOW_SOFT_MAX = 14;

/**
 * 腕を下ろしていても残る最低限の曲がり（度）。
 *
 * 上腕だけを書いたキーフレームは前腕を持たないので、これが無いと
 * そこだけ肘が伸び切る。脱力した腕も真っ直ぐにはならない。
 */
const ELBOW_BASE = 8;

/**
 * これ以上曲げてあるパーツには手を出さない（度）。
 *
 * 振り付け側が意図して曲げているときに上から足すと、狙った形が崩れる。
 * 境目で角度が飛ばないよう、しきい値へ向けて滑らかに 0 にする。
 */
const ELBOW_AUTHORED = 20;

/**
 * 上腕を上げた分だけ肘を緩める。
 *
 * 肘の曲がりに効くのは X（前後）と Z（横）だけで、Y は前腕の軸まわりの
 * ひねりなので見た目が変わらない。振り付け側がここを取り違えていて、
 * 肘を曲げたつもりの指定が長らく効いていなかった（moves.ts の elbow() を参照）。
 */
function softenElbows(pose: Pose): Pose {
  const j: Partial<Record<JointName, Rot>> = { ...pose.j };
  let touched = false;

  for (const [foreName, upperName] of [
    ["forearmL", "upperArmL"],
    ["forearmR", "upperArmR"],
  ] as Array<[JointName, JointName]>) {
    const fore = j[foreName] ?? [0, 0, 0];

    // 既に曲げてあるほど効かなくする。しきい値で完全に手を引く
    const flex = Math.hypot(fore[0], fore[2]);
    const damp = Math.max(0, 1 - flex / ELBOW_AUTHORED);
    if (damp <= 0) continue;

    const upper = j[upperName] ?? [0, 0, 0];
    const lift = Math.min(1, Math.hypot(upper[0], upper[2]) / 120);
    // 下ろしていても ELBOW_BASE、上げるほど ELBOW_SOFT_MAX に近づく
    const want = ELBOW_BASE + (ELBOW_SOFT_MAX - ELBOW_BASE) * lift;

    j[foreName] = [fore[0] - want * damp, fore[1], fore[2]];
    touched = true;
  }

  return touched ? { root: pose.root, j } : pose;
}

/**
 * 脱力した手の、指の丸まり（度）。
 *
 * 手を開いても指は真っ直ぐには伸びない。伸ばし切った手は手刀に見える。
 * 折れを指の付け根に置くのが要点で、手首で折ると「手を反らせている」に
 * なってしまう。
 */
const FINGER_CURL = 26;

/** 手首のわずかな落ち（度）。前腕と一直線だと棒に見える。 */
const WRIST_DROP = 10;

/** 手首をわずかに小指側へ倒す量（度）。左右対称に外へ開く。 */
const WRIST_SPREAD = 7;

/**
 * これ以上曲げてあるときは手を出さない（度）。
 * 振り付けが手の形を作っているところを上書きしない。
 */
const HAND_AUTHORED = 20;

/**
 * 手を脱力した形にする。
 *
 * 振り付け側は手をほとんど書かない（書くのは「きらきら」など数個だけ）。
 * 既定が真っ直ぐだと、伸ばした指の板がずっと腕の先に付いていることになる。
 */
function relaxHands(pose: Pose): Pose {
  const j: Partial<Record<JointName, Rot>> = { ...pose.j };
  let touched = false;

  for (const [handName, knuckleName, outward] of [
    ["handL", "knuckleL", 1],
    ["handR", "knuckleR", -1],
  ] as Array<[JointName, JointName, number]>) {
    const hand = j[handName] ?? [0, 0, 0];
    const knuckle = j[knuckleName] ?? [0, 0, 0];

    // 指はいつも丸めておく。ここは振り付け側がまず書かない
    if (Math.abs(knuckle[0]) < HAND_AUTHORED) {
      j[knuckleName] = [knuckle[0] - FINGER_CURL, knuckle[1], knuckle[2]];
      touched = true;
    }

    // 手首は、振り付けが手を回しているときは触らない
    if (Math.hypot(hand[0], hand[2]) < HAND_AUTHORED) {
      j[handName] = [hand[0] - WRIST_DROP, hand[1], hand[2] + WRIST_SPREAD * outward];
      touched = true;
    }
  }

  return touched ? { root: pose.root, j } : pose;
}

/**
 * ダイナミクスで振り幅を広げる関節。
 *
 * 脚・腰・root は触らない。weight() が足の位置を角度で打ち消していたり、
 * turnHalf が hips の回転量そのものでターンを作っていたりするので、
 * 一律に倍率をかけると足が地面を離れたり回転角が変わったりする。
 */
const AMPLIFY: JointName[] = [
  "spine", "chest", "neck", "head", "headTop",
  "upperArmL", "forearmL", "handL", "knuckleL", "handTipL",
  "upperArmR", "forearmR", "handR", "knuckleR", "handTipR",
];

/**
 * ダイナミクス最大のときの振り幅の倍率。
 *
 * 上げるほど大ぶりになるが、画角は振り付け全体の極値に合わせて引くので、
 * 上げすぎると被写体が小さくなる（＝変換に渡せる情報が減る）。
 * 縦 9:16 で占有率が 50% を割らない範囲の上限として決めた。
 */
const AMPLIFY_MAX = 1.22;

function amplify(pose: Pose, snap: number): Pose {
  if (snap <= 0) return pose;
  const k = 1 + (AMPLIFY_MAX - 1) * snap;
  const j: Partial<Record<JointName, Rot>> = { ...pose.j };
  for (const name of AMPLIFY) {
    const r = j[name];
    if (r) j[name] = [r[0] * k, r[1] * k, r[2] * k];
  }
  return { root: pose.root, j };
}

export interface SampleOptions {
  /** 上下動の強さ 0..1。 */
  bounce: number;
  /** 体の連鎖の強さ 0..1。省略時は連鎖なし。 */
  chain?: number;
  /** ダイナミクス 0..1。到達を早めて静止を作り、行き過ぎと振り幅を足す。 */
  snap?: number;
  /** 体型。省略時は標準。 */
  body?: Body;
  /** ノリの向き 0..1。0 が縦（沈み込み）、1 が横（重心の左右移動）。 */
  groove?: number;
  /** 追従（二次運動）の強さ 0..1。省略時は追従なし。 */
  follow?: number;
  /**
   * 足を床に置く処理を通すか。既定は通す。
   * 切れるようにしてあるのは、直る前と後を比べて測るため。
   */
  ground?: boolean;
}

/**
 * ループ内のカウント位置に対応するポーズを返す。
 * countPos はループ長で自動的に巻き戻すので、何拍目でも渡してよい。
 */
/** そのブロックに接する境界で使う繋ぎ幅。キメだけ狭くする。 */
function blendHalfFor(block: ChoreoBlock, snap: number): number {
  const base = getMove(block.moveId)?.accent ? ACCENT_BLEND_HALF : BLEND_HALF;
  // ダイナミクスを上げるほど繋ぎを詰める。長いクロスフェードは
  // ブロックの頭と尻を丸めてしまい、振りの角が消える
  return base * (1 - 0.55 * snap);
}

/**
 * ブロックの繋ぎまで含めた、ある時刻の振り付けのポーズ。
 * バウンスと体の連鎖はここには入らない。
 */
function choreoPoseAt(choreo: Choreography, pos: number, snap: number): Pose {
  const blocks = choreo.blocks;
  const index = findBlockIndex(blocks, pos);
  const block = blocks[index];
  const local = pos - block.startCount;
  const prev = blocks[(index - 1 + blocks.length) % blocks.length];
  const next = blocks[(index + 1) % blocks.length];

  // 繋ぎの幅は境界の両側で同じ値でなければならない。境界に入っていく側の
  // ブロックで決めると、どちらから見ても同じ値になる。
  // 短いブロックに合わせて縮めるのも従来どおり。
  const halfIn = Math.min(blendHalfFor(block, snap), block.counts / 2, prev.counts / 2);
  const halfOut = Math.min(blendHalfFor(next, snap), block.counts / 2, next.counts / 2);

  const pose = samplePoseInBlock(block, local, snap);

  if (local < halfIn) {
    // 境界の後ろ半分。前のブロックは終わりのポーズで止まっている。
    // 先頭ブロックの1つ前は最後のブロックなので、ループの継ぎ目もここで繋がる。
    const from = samplePoseInBlock(prev, prev.counts + local, snap);
    return blendPose(from, pose, ease("inout", 0.5 + local / (2 * halfIn)));
  }
  if (local > block.counts - halfOut) {
    // 境界の手前半分。次のブロックは頭のポーズで待っている
    const to = samplePoseInBlock(next, local - block.counts, snap);
    const t = (local - (block.counts - halfOut)) / (2 * halfOut);
    return blendPose(pose, to, ease("inout", t));
  }
  return pose;
}

/** ループ長で巻き戻した位置。 */
function wrap(countPos: number, total: number): number {
  return total > 0 ? ((countPos % total) + total) % total : 0;
}

/**
 * 段ごとに時刻をずらしてサンプルし、体の連鎖を作る。
 *
 * 腰（段 0）が今の時刻、手先（段 4）が一番過去を見る。関節の回転を
 * 差し替えるだけなので、骨の長さは変わらない。
 */
function chainedPose(
  choreo: Choreography,
  pos: number,
  total: number,
  chain: number,
  snap: number,
): Pose {
  const base = choreoPoseAt(choreo, pos, snap);
  if (chain <= 0) return base;

  const j = { ...base.j };
  for (const tier of CHAIN_TIERS) {
    const lagged = choreoPoseAt(choreo, wrap(pos - CHAIN_STEP * tier.steps * chain, total), snap);
    for (const name of tier.joints) {
      const rot = lagged.j?.[name];
      // 遅れた側に指定が無ければ回転 0。base の値を残すと連鎖が崩れる
      if (rot) j[name] = rot;
      else delete j[name];
    }
  }
  return { root: base.root, j };
}

/**
 * 二次運動（追従）。速く動いて止まったとき、手先が行き過ぎて戻る。
 *
 * ばねの過渡応答をそのまま積分すると、ポーズが「それまでの履歴」に依存して
 * しまい、時刻だけの関数でなくなる（画角の走査も書き出しもランダムアクセス
 * できなくなる）。そこで、減衰の弱いばねの低周波展開
 *
 *   y ≒ x - 2ζ/ωn・ẋ + (4ζ² - 1)/ωn²・ẍ
 *
 * を使う。第2項の遅れは既に `chain` が担っているので、ここでは第3項だけを
 * 足す。ζ < 0.5 では係数が負なので、**加速度を引く**ことになる。
 *
 * これで何が起きるか。振りに入るとき（加速中）は手先がわずかに遅れ、
 * 振り終わり（減速中）は目標を越えて戻る。`snap` の行き過ぎが全関節に同じ
 * 形で掛かる決め打ちなのに対して、こちらは**実際にどれだけ急に止まったか**
 * で量が決まる。重さがあるものの止まり方に見えるのはこちら。
 *
 * 代償として手先の最高速度が上がる。映像変換がフレーム間で追随できるかは
 * 未検証なので、既定は控えめにしてある（`DEFAULT_DANCE.follow`）。
 */
function followThrough(
  choreo: Choreography,
  pos: number,
  total: number,
  chain: number,
  snap: number,
  amount: number,
): Pose {
  const cur = chainedPose(choreo, pos, total, chain, snap);
  if (amount <= 0) return cur;

  const back = chainedPose(choreo, wrap(pos - FOLLOW_STEP, total), total, chain, snap);
  const fwd = chainedPose(choreo, wrap(pos + FOLLOW_STEP, total), total, chain, snap);

  const j: Partial<Record<JointName, Rot>> = { ...cur.j };
  for (const tier of FOLLOW_TIERS) {
    const k = amount * tier.gain * FOLLOW_MAX;
    for (const name of tier.joints) {
      const c = cur.j?.[name] ?? ZERO_ROT;
      const b = back.j?.[name] ?? ZERO_ROT;
      const f = fwd.j?.[name] ?? ZERO_ROT;
      const out: Rot = [
        c[0] - k * (f[0] - 2 * c[0] + b[0]),
        c[1] - k * (f[1] - 2 * c[1] + b[1]),
        c[2] - k * (f[2] - 2 * c[2] + b[2]),
      ];
      // 指定の無かった関節に、丸め誤差だけの回転を生やさない
      if (cur.j?.[name] || Math.hypot(out[0], out[1], out[2]) > 0.01) j[name] = out;
    }
  }
  return { root: cur.root, j };
}

export function samplePose(
  choreo: Choreography,
  countPos: number,
  opts: SampleOptions = { bounce: 0 },
): Pose {
  if (choreo.blocks.length === 0) return {};

  const total = choreo.totalCounts;
  const pos = wrap(countPos, total);
  const snap = opts.snap ?? 0;
  const swung = followThrough(choreo, pos, total, opts.chain ?? 0, snap, opts.follow ?? 0);
  const pose = relaxHands(softenElbows(amplify(swung, snap)));

  return applyGroove(pose, pos, opts.bounce, snap, opts.groove ?? 0);
}

/**
 * ポーズを解いてワールド座標まで求める。描画側の入口。
 *
 * 接地の解決はここで掛ける。`samplePose` は振り付けそのものを返す層に
 * しておきたいので、床の都合を混ぜない。
 */
export function sampleSkeleton(
  choreo: Choreography,
  countPos: number,
  opts?: SampleOptions,
): PosedSkeleton {
  const body = opts?.body ?? DEFAULT_BODY;
  const pose = samplePose(choreo, countPos, opts);
  return solvePose(opts?.ground === false ? pose : plantFeet(pose, body), body);
}
