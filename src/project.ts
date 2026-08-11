/**
 * 設定モデルと、その保存・受け渡し。
 *
 * このアプリが振り付けを組むのに必要な入力は4つだけ:
 * BPM・拍子・小節数・くり返し。コード進行やメロディは使っていない
 * （振り付けの生成がそれらを見ていないので、持っていても意味がない）。
 *
 * 保存先は localStorage、他の端末へ渡すときは URL ハッシュ。どちらも
 * 外から壊れた値が来うるので、読み込みは必ず normalizeProject を通す。
 */

import { DEFAULT_DANCE, normalizeDance, type DanceSettings } from "./dance/choreo";
import { DEFAULT_BODY, type Body } from "./dance/skeleton";

export interface DanceProject {
  /** テンポ。 */
  bpm: number;
  /** 1小節の拍数。 */
  beatsPerBar: number;
  /** 1ループの小節数。 */
  bars: number;
  /** 書き出すときに何回くり返すか。 */
  repeats: number;
  dance: DanceSettings;
  /** マネキンの体型。 */
  body: Body;
}

/**
 * 体型の可動範囲。
 *
 * 極端にすると足が地面から離れたり、頭が体に埋まったりするので、
 * 破綻しない幅に留めてある。
 */
export const BODY_RANGE = { min: 0.7, max: 1.4 } as const;

export const BPM_RANGE = { min: 40, max: 240 } as const;
export const BARS_RANGE = { min: 1, max: 64 } as const;
export const REPEATS_RANGE = { min: 1, max: 8 } as const;

/** 選べる拍子。8カウントを割り切れるものだけにしてある。 */
export const BEATS_PER_BAR = [2, 3, 4, 6] as const;

export const DEFAULT_PROJECT: DanceProject = {
  bpm: 120,
  beatsPerBar: 4,
  bars: 8,
  repeats: 2,
  dance: DEFAULT_DANCE,
  body: DEFAULT_BODY,
};

/** 1ループの拍数。振り付けの長さはこれで決まる。 */
export function beatsPerLoop(project: DanceProject): number {
  return project.beatsPerBar * project.bars;
}

/** 1拍の秒数。 */
export function secondsPerBeat(project: DanceProject): number {
  return 60 / project.bpm;
}

/** 1ループの秒数。 */
export function loopSeconds(project: DanceProject): number {
  return beatsPerLoop(project) * secondsPerBeat(project);
}

/** 書き出される動画の長さ（秒）。 */
export function totalSeconds(project: DanceProject): number {
  return loopSeconds(project) * project.repeats;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 任意の入力を安全な DanceProject に整える。
 * 保存データと共有リンクの両方がここを通る。
 */
export function normalizeProject(raw: unknown): DanceProject {
  const o = (raw ?? {}) as Record<string, unknown>;

  const beats = clampInt(o.beatsPerBar, 2, 6, DEFAULT_PROJECT.beatsPerBar);
  return {
    bpm: clampInt(o.bpm, BPM_RANGE.min, BPM_RANGE.max, DEFAULT_PROJECT.bpm),
    // 一覧に無い拍子（5拍子など）が来たら既定に落とす
    beatsPerBar: (BEATS_PER_BAR as readonly number[]).includes(beats)
      ? beats
      : DEFAULT_PROJECT.beatsPerBar,
    bars: clampInt(o.bars, BARS_RANGE.min, BARS_RANGE.max, DEFAULT_PROJECT.bars),
    repeats: clampInt(o.repeats, REPEATS_RANGE.min, REPEATS_RANGE.max, DEFAULT_PROJECT.repeats),
    dance: normalizeDance(o.dance),
    body: normalizeBody(o.body),
  };
}

/** 任意の入力を安全な Body に整える。 */
export function normalizeBody(raw: unknown): Body {
  const o = (raw ?? {}) as Record<string, unknown>;
  const part = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(BODY_RANGE.max, Math.max(BODY_RANGE.min, n));
  };
  return {
    head: part(o.head, DEFAULT_BODY.head),
    legs: part(o.legs, DEFAULT_BODY.legs),
    arms: part(o.arms, DEFAULT_BODY.arms),
    build: part(o.build, DEFAULT_BODY.build),
    shoulders: part(o.shoulders, DEFAULT_BODY.shoulders),
  };
}

// --- 保存 ---

export const STORAGE_KEY = "dance-studio:project";

/** localStorage に保存する。使えない環境（プライベートモード等）では黙って諦める。 */
export function saveProject(project: DanceProject): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch {
    // 保存できなくてもアプリは動くので、ここで止めない
  }
}

/** localStorage から読む。無ければ null。 */
export function loadStoredProject(): DanceProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

// --- 共有リンク ---

/**
 * URL ハッシュに載せる文字列へ変換する。
 *
 * base64 をそのまま使うと `+` `/` がURLで化けるので base64url に直す。
 * 日本語は入らない想定だが、将来入っても壊れないよう UTF-8 を経由する。
 */
export function encodeProject(project: DanceProject): string {
  const json = JSON.stringify(project);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** encodeProject の逆。壊れていれば null。 */
export function decodeProject(encoded: string): DanceProject | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return normalizeProject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** 共有用の URL を作る。 */
export function shareUrl(project: DanceProject, base: string): string {
  return `${base.split("#")[0]}#p=${encodeProject(project)}`;
}

/** URL ハッシュから設定を取り出す。載っていなければ null。 */
export function projectFromHash(hash: string): DanceProject | null {
  const match = /[#&]p=([^&]+)/.exec(hash);
  if (!match) return null;
  return decodeProject(match[1]);
}

/**
 * 起動時に読む設定。
 *
 * 共有リンクを開いたときはそちらを優先する（リンクを踏んだのに自分の
 * 保存内容が出てくると、何も起きていないように見えるため）。
 */
export function loadProject(): DanceProject {
  if (typeof window !== "undefined") {
    const fromLink = projectFromHash(window.location.hash);
    if (fromLink) return fromLink;
  }
  return loadStoredProject() ?? DEFAULT_PROJECT;
}
