/**
 * 振り付けの生成。
 *
 * 「1曲ぶんの振りを考える」のは大変だが、「8カウントの部品を曲の構造に沿って
 * 並べる」なら自動化できる。ここがこのツールの中心。
 *
 * 並べ方には、実際のダンスの組み立てに倣った規則を入れてある。
 *
 * - 盛り上がりに合わせて動きの大きさを選ぶ（前半は小さく、終盤で大きく）
 * - 8カウントを2つ1組にして、2つ目は同じ振りの左右反転にすることが多い
 *   （AA' の繰り返し構造。これが無いと、ただ動きが流れていくだけに見える）
 * - ループの最後はキメで締める
 * - 同じ振りが続けて出ないようにする
 *
 * 生成はシード付きの擬似乱数なので、同じシードなら必ず同じ振り付けになる。
 * 気に入らなければシードを変えて引き直す、という使い方を想定している。
 */

import { getMove, hasMove, MOVES, type Move } from "./moves";

/** 振り付けの1ブロック（原則8カウント）。 */
export interface ChoreoBlock {
  /** ループ先頭からの開始カウント。 */
  startCount: number;
  /** このブロックの長さ（カウント）。末尾は8未満になることがある。 */
  counts: number;
  moveId: string;
  mirrored: boolean;
  /** ユーザーが手で選んだブロックか。 */
  manual: boolean;
}

export interface Choreography {
  seed: number;
  /** 1ループの総カウント数。 */
  totalCounts: number;
  blocks: ChoreoBlock[];
}

/** 曲データに保存する振り付けの設定。 */
export interface DanceSettings {
  /** 生成シード。変えると別の振り付けになる。 */
  seed: number;
  /** 動きの大きさ 0..1。 */
  intensity: number;
  /** ビートに乗った上下動の強さ 0..1。 */
  bounce: number;
  /**
   * ブロックごとの手動指定。長さはブロック数と一致しなくてよく、
   * 範囲外や未指定（null）のブロックは自動生成に任せる。
   */
  overrides: Array<DanceOverride | null>;
}

export interface DanceOverride {
  moveId: string;
  mirrored: boolean;
}

export const DEFAULT_DANCE: DanceSettings = {
  seed: 1,
  intensity: 0.7,
  bounce: 0.6,
  overrides: [],
};

/** 1ブロックの標準の長さ。ダンスの数え方に合わせて8カウント。 */
export const BLOCK_COUNTS = 8;

/** 決定的な擬似乱数（mulberry32）。同じシードなら必ず同じ列になる。 */
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * ループをブロックに割る。
 *
 * 端数が2カウント未満だと振りとして成立しないので、手前のブロックに足しておく。
 */
export function blockLayout(totalCounts: number): Array<{ startCount: number; counts: number }> {
  const total = Math.max(1, Math.round(totalCounts));
  const out: Array<{ startCount: number; counts: number }> = [];
  for (let start = 0; start < total; start += BLOCK_COUNTS) {
    out.push({ startCount: start, counts: Math.min(BLOCK_COUNTS, total - start) });
  }
  if (out.length >= 2 && out[out.length - 1].counts < 2) {
    const tail = out.pop();
    if (tail) out[out.length - 1].counts += tail.counts;
  }
  return out;
}

/**
 * ブロックの位置から目標の動きの大きさを決める。
 *
 * 頭は中くらい、序盤で一度落として、終盤に向けて上げていく。
 * ずっと同じ強さで動き続けると、見ていて起伏がなくなるため。
 */
function energyCurve(position: number, intensity: number): number {
  // 出だしを低くしすぎない。ループが短いと（8小節など）ブロック数が少なく、
  // 頭が最小・最後がキメ、で終わってしまって動きの無い動画になる
  const rise = 0.55 + 0.45 * position;
  // 前半 1/4 あたりに谷を作る
  const dip = 0.14 * Math.max(0, 1 - Math.abs(position - 0.25) / 0.25);
  return Math.max(0, Math.min(1, (rise - dip) * (0.45 + 0.75 * intensity)));
}

/** 0..1 の強さを energy の段階（0/1/2）に落とす。 */
function energyLevel(value: number): 0 | 1 | 2 {
  if (value < 0.42) return 0;
  if (value < 0.74) return 1;
  return 2;
}

/**
 * 目標の段階に合うパーツを選ぶ。
 * ぴったりが無ければ隣の段階まで広げる。
 */
function pickMove(
  level: 0 | 1 | 2,
  opts: { accent: boolean; avoid: string | null; random: () => number },
): Move {
  const wants = (m: Move): boolean => (opts.accent ? m.accent === true : m.accent !== true);

  for (const spread of [0, 1, 2]) {
    const pool = MOVES.filter(
      (m) => wants(m) && Math.abs(m.energy - level) <= spread && m.id !== opts.avoid,
    );
    if (pool.length > 0) return pool[Math.floor(opts.random() * pool.length) % pool.length];
  }
  // キメが1つも無いなど、どうしても見つからない場合の保険
  const fallback = MOVES.filter((m) => m.id !== opts.avoid);
  const pool = fallback.length > 0 ? fallback : MOVES;
  return pool[Math.floor(opts.random() * pool.length) % pool.length];
}

/**
 * 振り付けを生成する。
 *
 * overrides に入っているブロックはそのまま採用し、残りだけ自動で埋める。
 * 手で直したブロックが、シードを引き直しても残るようにするため。
 */
export function generateChoreography(totalCounts: number, settings: DanceSettings): Choreography {
  const layout = blockLayout(totalCounts);
  const random = rng(settings.seed);
  const blocks: ChoreoBlock[] = [];

  let prevId: string | null = null;
  /** 直前のブロックを反転して繰り返せる状態か。 */
  let pendingMirror: { moveId: string; mirrored: boolean } | null = null;

  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    const override = settings.overrides[i];
    const isLast = i === layout.length - 1;

    if (override && hasMove(override.moveId)) {
      blocks.push({ ...slot, moveId: override.moveId, mirrored: override.mirrored, manual: true });
      prevId = override.moveId;
      pendingMirror = null;
      continue;
    }

    // 2つ1組の後半。前半と同じ振りを左右反転して繰り返すと、振り付けらしい形になる
    if (pendingMirror) {
      blocks.push({ ...slot, ...pendingMirror, manual: false });
      prevId = pendingMirror.moveId;
      pendingMirror = null;
      continue;
    }

    const position = layout.length === 1 ? 1 : i / (layout.length - 1);
    const level = energyLevel(energyCurve(position, settings.intensity));
    // 最後のブロックはキメで締める（1ブロックしかない場合は普通の振りのまま）
    const accent = isLast && layout.length > 1;
    const move = pickMove(level, { accent, avoid: prevId, random });
    const mirrored = move.mirrorable && random() < 0.5;

    blocks.push({ ...slot, moveId: move.id, mirrored, manual: false });
    prevId = move.id;

    // 次のブロックも自動で、かつ最後の1つ手前でなければ、反転の繰り返しを予約する
    const nextIsFree = i + 1 < layout.length && !settings.overrides[i + 1];
    const nextIsLast = i + 1 === layout.length - 1;
    if (nextIsFree && !nextIsLast && move.mirrorable && random() < 0.65) {
      pendingMirror = { moveId: move.id, mirrored: !mirrored };
    }
  }

  return { seed: settings.seed, totalCounts: Math.max(1, Math.round(totalCounts)), blocks };
}

/** ブロックに手動でパーツを割り当てた overrides を返す。 */
export function withOverride(
  settings: DanceSettings,
  index: number,
  value: DanceOverride | null,
): DanceSettings {
  const overrides = settings.overrides.slice();
  while (overrides.length <= index) overrides.push(null);
  overrides[index] = value;
  // 末尾の null は保存する意味がないので落とす
  while (overrides.length > 0 && overrides[overrides.length - 1] === null) overrides.pop();
  return { ...settings, overrides };
}

/** 表示用のパーツ名。 */
export function blockLabel(block: ChoreoBlock): string {
  const move = getMove(block.moveId);
  const name = move ? move.name : block.moveId;
  return block.mirrored ? `${name}（左右反転）` : name;
}

/** 任意の入力を安全な DanceSettings に整える。保存データと共有リンクの検証に使う。 */
export function normalizeDance(raw: unknown): DanceSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  };

  const rawOverrides = Array.isArray(o.overrides) ? o.overrides : [];
  const overrides = rawOverrides.slice(0, 128).map((entry): DanceOverride | null => {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e.moveId !== "string" || !hasMove(e.moveId)) return null;
    return { moveId: e.moveId, mirrored: e.mirrored === true };
  });
  while (overrides.length > 0 && overrides[overrides.length - 1] === null) overrides.pop();

  return {
    seed: Math.round(num(o.seed, 1, 999999, DEFAULT_DANCE.seed)),
    intensity: num(o.intensity, 0, 1, DEFAULT_DANCE.intensity),
    bounce: num(o.bounce, 0, 1, DEFAULT_DANCE.bounce),
    overrides,
  };
}
