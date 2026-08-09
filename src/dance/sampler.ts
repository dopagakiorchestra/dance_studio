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

/** バウンスの最大の沈み込み（ワールド単位）。 */
const MAX_DIP = 0.055;

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
function applyBounce(pose: Pose, beatPhase: number, amount: number): Pose {
  if (amount <= 0) return pose;
  const dip = MAX_DIP * amount * (0.5 + 0.5 * Math.cos(2 * Math.PI * beatPhase));
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

export interface SampleOptions {
  /** 上下動の強さ 0..1。 */
  bounce: number;
}

/**
 * ループ内のカウント位置に対応するポーズを返す。
 * countPos はループ長で自動的に巻き戻すので、何拍目でも渡してよい。
 */
export function samplePose(
  choreo: Choreography,
  countPos: number,
  opts: SampleOptions = { bounce: 0 },
): Pose {
  const blocks = choreo.blocks;
  if (blocks.length === 0) return {};

  const total = choreo.totalCounts;
  const pos = total > 0 ? ((countPos % total) + total) % total : 0;

  const index = findBlockIndex(blocks, pos);
  const block = blocks[index];
  const local = pos - block.startCount;
  const prev = blocks[(index - 1 + blocks.length) % blocks.length];
  const next = blocks[(index + 1) % blocks.length];

  // 繋ぎの幅は境界の両側で同じ値でなければならない。短いブロックに合わせて縮める。
  const halfIn = Math.min(BLEND_HALF, block.counts / 2, prev.counts / 2);
  const halfOut = Math.min(BLEND_HALF, block.counts / 2, next.counts / 2);

  let pose = samplePoseInBlock(block, local);

  if (local < halfIn) {
    // 境界の後ろ半分。前のブロックは終わりのポーズで止まっている。
    // 先頭ブロックの1つ前は最後のブロックなので、ループの継ぎ目もここで繋がる。
    const from = samplePoseInBlock(prev, prev.counts + local);
    pose = blendPose(from, pose, ease("inout", 0.5 + local / (2 * halfIn)));
  } else if (local > block.counts - halfOut) {
    // 境界の手前半分。次のブロックは頭のポーズで待っている
    const to = samplePoseInBlock(next, local - block.counts);
    const t = (local - (block.counts - halfOut)) / (2 * halfOut);
    pose = blendPose(pose, to, ease("inout", t));
  }

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
