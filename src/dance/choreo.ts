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
  /**
   * このブロックが始まるスロット番号（1小節＝1スロット）。
   * 手動指定はこの番号で覚える。ブロックの長さは振りによって変わるので、
   * 並び順で覚えるとシードを引き直したときに指定がずれてしまう。
   */
  slot: number;
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
  /** 拍に乗った体重移動の強さ 0..1。 */
  bounce: number;
  /**
   * ノリの向き 0..1。0 が縦（沈み込み）、1 が横（重心の左右移動）。
   *
   * 縦だけだとスクワットのように見えることがある。横に乗るほうが
   * ダンスとしては自然な場面が多いので、既定は横寄りにしてある。
   */
  groove: number;
  /**
   * 体の連鎖の強さ 0..1。
   *
   * 腰から手先へ向かって、動きの到達を少しずつ遅らせる量。0 だと全関節が
   * 同じ瞬間に到達して、人形が同時に折れ曲がったように見える。
   */
  chain: number;
  /**
   * ダイナミクス 0..1。
   *
   * 上げるほど「速く動いて止まる」に寄る。到達を早めて残りを静止に回し、
   * 行き過ぎてから戻り、上下動と腕の振りも大きくなる。
   * キレはここで作る。0 にすると終始等速で動き続ける体操になる。
   */
  snap: number;
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
  groove: 0.7,
  chain: 0.6,
  snap: 0.75,
  overrides: [],
};

/**
 * 振りを差し替える最小単位（カウント）。4/4 なら1小節。
 *
 * 以前は 8カウント（2小節）だったが、それだと同じ振りが2小節続くうえ、
 * 「次はその左右反転が来る」と読めてしまって単調になる。1小節ごとに
 * 変えられるようにして、8カウント必要な振りだけ2スロットを使う。
 */
export const SLOT_COUNTS = 4;

/** 後方互換のための別名。 */
export const BLOCK_COUNTS = SLOT_COUNTS;

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
  for (let start = 0; start < total; start += SLOT_COUNTS) {
    out.push({ startCount: start, counts: Math.min(SLOT_COUNTS, total - start) });
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
 *
 * ぴったりが無ければ隣の段階まで広げる。直近に使った振りは避ける。
 * 避けるのを直前1つだけにしていた頃は、数小節おきに同じ振りが戻ってきて
 * 「次に何が来るか」が読めてしまっていた。
 */
function pickMove(
  level: 0 | 1 | 2,
  opts: {
    accent: boolean;
    recent: string[];
    maxCounts: number;
    random: () => number;
  },
): Move {
  const fits = (m: Move): boolean =>
    (opts.accent ? m.accent === true : m.accent !== true) && m.counts <= opts.maxCounts;

  // キメは動きの大きさで絞らない。締めの振りはどれも「締めるためのもの」で、
  // energy で選ぶと一番大きい1つだけが毎回出てきてしまう
  const spreads = opts.accent ? [2] : [0, 1, 2];

  // 避ける範囲を狭めながら探す。候補が尽きるより、少し繰り返すほうがまし
  for (const memory of [opts.recent.length, 2, 1, 0]) {
    const avoid = new Set(opts.recent.slice(-memory));
    for (const spread of spreads) {
      const pool = MOVES.filter(
        (m) => fits(m) && Math.abs(m.energy - level) <= spread && !avoid.has(m.id),
      );
      if (pool.length > 0) return pool[Math.floor(opts.random() * pool.length) % pool.length];
    }
  }
  // キメが1つも無いなど、どうしても見つからない場合の保険
  const pool = MOVES.filter(fits);
  return (pool.length > 0 ? pool : MOVES)[
    Math.floor(opts.random() * (pool.length > 0 ? pool.length : MOVES.length))
  ];
}

/** 直近に使った振りを何個まで覚えて避けるか。 */
const RECENT_MEMORY = 3;

/**
 * 同じ振りを左右反転して次の小節で繰り返す確率。
 *
 * 高いほど「振り付けらしい」形になるが、高すぎると次が読めて退屈になる。
 * 8カウント単位だった頃は 0.65 だった。1小節単位ではこの繰り返しが
 * 倍の頻度で来るので、下げてある。
 */
const MIRROR_REPEAT = 0.32;

/**
 * i 番目のスロットから moveCounts ぶんを賄うのに要るスロット数。
 * 足りなければ 0。
 */
function slotsNeeded(
  layout: Array<{ counts: number }>,
  i: number,
  moveCounts: number,
): number {
  let acc = 0;
  let n = 0;
  while (i + n < layout.length && acc < moveCounts) {
    acc += layout[i + n].counts;
    n++;
  }
  return acc >= moveCounts ? n : 0;
}

/**
 * 振り付けを生成する。
 *
 * overrides はスロット番号（1小節）で覚える。ブロックの長さは選ばれた振りに
 * よって変わるので、並び順で覚えるとシードを引き直したときに指定がずれる。
 */
export function generateChoreography(totalCounts: number, settings: DanceSettings): Choreography {
  const layout = blockLayout(totalCounts);
  const random = rng(settings.seed);
  const blocks: ChoreoBlock[] = [];

  const recent: string[] = [];
  /** 直前の振りを反転して繰り返す予約。 */
  let pendingMirror: { moveId: string; mirrored: boolean } | null = null;

  const remember = (id: string): void => {
    recent.push(id);
    if (recent.length > RECENT_MEMORY) recent.shift();
  };

  /** 選んだ振りをブロックとして置き、消費したスロット数を返す。 */
  const place = (
    i: number,
    moveId: string,
    mirrored: boolean,
    manual: boolean,
    span: number,
  ): number => {
    let counts = 0;
    for (let k = 0; k < span; k++) counts += layout[i + k].counts;
    blocks.push({
      startCount: layout[i].startCount,
      counts,
      moveId,
      mirrored,
      manual,
      slot: i,
    });
    remember(moveId);
    return span;
  };

  for (let i = 0; i < layout.length; ) {
    // 最後のスロットはキメで締める（1スロットしかない場合は普通の振りのまま）
    const isLastSlot = i === layout.length - 1;
    const override = settings.overrides[i];

    if (override && hasMove(override.moveId)) {
      const move = getMove(override.moveId)!;
      const span = Math.max(1, slotsNeeded(layout, i, move.counts));
      i += place(i, move.id, override.mirrored, true, span);
      pendingMirror = null;
      continue;
    }

    if (pendingMirror) {
      const move = getMove(pendingMirror.moveId);
      const span = move ? Math.max(1, slotsNeeded(layout, i, move.counts)) : 1;
      i += place(i, pendingMirror.moveId, pendingMirror.mirrored, false, span);
      pendingMirror = null;
      continue;
    }

    const position = layout.length === 1 ? 1 : i / (layout.length - 1);
    const level = energyLevel(energyCurve(position, settings.intensity));
    const accent = isLastSlot && layout.length > 1;

    // 長い振りは、最後のキメ用スロットを食い潰さない範囲でだけ許す
    const slotsLeft = layout.length - i;
    const reserve = accent ? 0 : 1;
    let maxCounts = 0;
    for (let k = 0; k < slotsLeft - reserve; k++) maxCounts += layout[i + k].counts;
    maxCounts = Math.max(layout[i].counts, maxCounts);

    const move = pickMove(level, { accent, recent, maxCounts, random });
    const mirrored = move.mirrorable && random() < 0.5;
    const span = Math.max(1, slotsNeeded(layout, i, move.counts));
    i += place(i, move.id, mirrored, false, span);

    // 次のスロットも自動で、かつ繰り返しても最後（キメ）のスロットを
    // 食い潰さないときだけ、反転の繰り返しを予約する。
    // 2スロット使う振りを繰り返すと締めのスロットまで届いてしまう
    const nextIsFree = i < layout.length && !settings.overrides[i];
    const repeatSpan = Math.max(1, slotsNeeded(layout, i, move.counts));
    const leavesAccentSlot = i + repeatSpan <= layout.length - 1;
    if (nextIsFree && leavesAccentSlot && move.mirrorable && random() < MIRROR_REPEAT) {
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
    groove: num(o.groove, 0, 1, DEFAULT_DANCE.groove),
    chain: num(o.chain, 0, 1, DEFAULT_DANCE.chain),
    snap: num(o.snap, 0, 1, DEFAULT_DANCE.snap),
    overrides,
  };
}
