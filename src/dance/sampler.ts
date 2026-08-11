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
import {
  blendPose,
  HIP_HEIGHT,
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

/** 太もも＋すねの長さ。しゃがみ角度の計算に使う。 */
const LEG_SEGMENT = 0.44;

function ease(kind: Ease | undefined, t: number): number {
  switch (kind) {
    case "linear":
      return t;
    case "inout":
      return t * t * (3 - 2 * t);
    case "hold":
      // 目標のカウントに来るまで動かない。キメを保つときに使う
      return t >= 1 ? 1 : 0;
    case "out":
    default:
      // 速く入って落ち着く。ダンスの当て方に一番近い。
      // 3乗にすると出だしがもっと鋭くなるが、手先の速度が上がりすぎて
      // 映像変換にかけたときにフレーム間の整合が崩れるので、2.2乗に留めてある。
      return 1 - Math.pow(1 - t, 2.2);
  }
}

/** パーツ内のローカルカウント位置のポーズ。範囲外は端のキーフレームで留める。 */
function sampleMove(move: Move, localCount: number): Pose {
  const frames = move.keyframes;
  if (frames.length === 0) return {};
  if (localCount <= frames[0].count) return frames[0].pose;

  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (localCount < b.count) {
      const span = b.count - a.count;
      const t = span <= 0 ? 1 : (localCount - a.count) / span;
      return blendPose(a.pose, b.pose, ease(b.ease, t));
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
function samplePoseInBlock(block: ChoreoBlock, localCount: number): Pose {
  const move = getMove(block.moveId);
  if (!move) return {};
  const pose = sampleMove(move, localCount);
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

function applyBounce(pose: Pose, beatPhase: number, amount: number): Pose {
  if (amount <= 0) return pose;
  const dip = MAX_DIP * amount * bounceDip(beatPhase);
  if (dip <= 0.0005) return pose;

  const cos = Math.min(1, Math.max(-1, 1 - dip / (2 * LEG_SEGMENT)));
  const alpha = (Math.acos(cos) * 180) / Math.PI;

  const j: Partial<Record<JointName, Rot>> = { ...pose.j };
  addRot(j, "thighL", -alpha);
  addRot(j, "thighR", -alpha);
  addRot(j, "shinL", 2 * alpha);
  addRot(j, "shinR", 2 * alpha);
  // 沈むときに上体がわずかに前へ出ると、重さが乗って見える
  addRot(j, "spine", -alpha * 0.22);
  addRot(j, "head", alpha * 0.12);

  const root = pose.root ?? {};
  return { root: { ...root, y: (root.y ?? HIP_HEIGHT) - dip }, j };
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
  { steps: 4, joints: ["handL", "handTipL", "handR", "handTipR"] },
];

/** 段ひとつぶんの遅れ（カウント）。最大でも 4 段なので全体で 0.2 カウント。 */
const CHAIN_STEP = 0.05;

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

export interface SampleOptions {
  /** 上下動の強さ 0..1。 */
  bounce: number;
  /** 体の連鎖の強さ 0..1。省略時は連鎖なし。 */
  chain?: number;
}

/**
 * ループ内のカウント位置に対応するポーズを返す。
 * countPos はループ長で自動的に巻き戻すので、何拍目でも渡してよい。
 */
/** そのブロックに接する境界で使う繋ぎ幅。キメだけ狭くする。 */
function blendHalfFor(block: ChoreoBlock): number {
  return getMove(block.moveId)?.accent ? ACCENT_BLEND_HALF : BLEND_HALF;
}

/**
 * ブロックの繋ぎまで含めた、ある時刻の振り付けのポーズ。
 * バウンスと体の連鎖はここには入らない。
 */
function choreoPoseAt(choreo: Choreography, pos: number): Pose {
  const blocks = choreo.blocks;
  const index = findBlockIndex(blocks, pos);
  const block = blocks[index];
  const local = pos - block.startCount;
  const prev = blocks[(index - 1 + blocks.length) % blocks.length];
  const next = blocks[(index + 1) % blocks.length];

  // 繋ぎの幅は境界の両側で同じ値でなければならない。境界に入っていく側の
  // ブロックで決めると、どちらから見ても同じ値になる。
  // 短いブロックに合わせて縮めるのも従来どおり。
  const halfIn = Math.min(blendHalfFor(block), block.counts / 2, prev.counts / 2);
  const halfOut = Math.min(blendHalfFor(next), block.counts / 2, next.counts / 2);

  const pose = samplePoseInBlock(block, local);

  if (local < halfIn) {
    // 境界の後ろ半分。前のブロックは終わりのポーズで止まっている。
    // 先頭ブロックの1つ前は最後のブロックなので、ループの継ぎ目もここで繋がる。
    const from = samplePoseInBlock(prev, prev.counts + local);
    return blendPose(from, pose, ease("inout", 0.5 + local / (2 * halfIn)));
  }
  if (local > block.counts - halfOut) {
    // 境界の手前半分。次のブロックは頭のポーズで待っている
    const to = samplePoseInBlock(next, local - block.counts);
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
function chainedPose(choreo: Choreography, pos: number, total: number, chain: number): Pose {
  const base = choreoPoseAt(choreo, pos);
  if (chain <= 0) return base;

  const j = { ...base.j };
  for (const tier of CHAIN_TIERS) {
    const lagged = choreoPoseAt(choreo, wrap(pos - CHAIN_STEP * tier.steps * chain, total));
    for (const name of tier.joints) {
      const rot = lagged.j?.[name];
      // 遅れた側に指定が無ければ回転 0。base の値を残すと連鎖が崩れる
      if (rot) j[name] = rot;
      else delete j[name];
    }
  }
  return { root: base.root, j };
}

export function samplePose(
  choreo: Choreography,
  countPos: number,
  opts: SampleOptions = { bounce: 0 },
): Pose {
  if (choreo.blocks.length === 0) return {};

  const total = choreo.totalCounts;
  const pos = wrap(countPos, total);
  const pose = softenElbows(chainedPose(choreo, pos, total, opts.chain ?? 0));

  return applyBounce(pose, pos - Math.floor(pos), opts.bounce);
}

/** ポーズを解いてワールド座標まで求める。描画側の入口。 */
export function sampleSkeleton(
  choreo: Choreography,
  countPos: number,
  opts?: SampleOptions,
): PosedSkeleton {
  return solvePose(samplePose(choreo, countPos, opts));
}
