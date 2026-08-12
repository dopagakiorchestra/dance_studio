/**
 * 振り付けを動画ファイルとして書き出す。
 *
 * canvas.captureStream() の映像を MediaRecorder に流す。音声は入れない。
 * 音を別にする理由は、この動画をそのまま完成品として使わないため。
 * Domo AI のような映像変換に通すと音は落ちるか尺がずれるので、音は
 * 変換が終わったあとに動画編集側で合わせるのが確実。
 *
 * MediaRecorder は実時間でしか録れない（40秒の動画なら40秒かかる）。
 * 音声の書き出しと同じ制約で、ここも同じ扱いにしてある。
 */

import { readMp4SampleEntry } from "../mp4";
import type { Choreography } from "./choreo";
import type { MotionClip } from "./landmarks";
import { drawFrame, type DrawOptions, type Stage } from "./render";
import { sampleSkeleton } from "./sampler";
import type { Body } from "./skeleton";

export interface VideoFormat {
  mime: string;
  extension: "mp4" | "webm";
  label: string;
}

/**
 * 優先順に試す形式。
 *
 * H.264 の MP4 が最優先。動画変換サービスも SNS もスマホも、これなら確実に扱える。
 *
 * 注意すべきは、コーデックを書かない "video/mp4" を上位に置かないこと。
 * これを頼むと、H.264 を持たないブラウザが VP9 入りの MP4 を返してくる。
 * ファイルとしては正しいが受け取れないツールが多く、拡張子が .mp4 なだけに
 * 「壊れている」ように見える。それなら素直に WebM を出したほうがいい。
 */
const CANDIDATES: VideoFormat[] = [
  { mime: 'video/mp4;codecs="avc1.42E01E"', extension: "mp4", label: "MP4（H.264）" },
  { mime: 'video/mp4;codecs="avc1.4D401E"', extension: "mp4", label: "MP4（H.264）" },
  { mime: 'video/webm;codecs="vp9"', extension: "webm", label: "WebM（VP9）" },
  { mime: 'video/webm;codecs="vp8"', extension: "webm", label: "WebM（VP8）" },
  { mime: "video/webm", extension: "webm", label: "WebM" },
  { mime: "video/mp4", extension: "mp4", label: "MP4" },
];

/** この端末で使える動画形式。使えなければ null。 */
export function pickVideoFormat(): VideoFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate.mime)) return candidate;
    } catch {
      // isTypeSupported が例外を投げる実装もあるので次の候補へ
    }
  }
  return null;
}

/** 書き出しの解像度。9:16 は SNS 向け、1:1 と 16:9 も選べるようにしてある。 */
export interface VideoSize {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const VIDEO_SIZES: VideoSize[] = [
  { id: "portrait", name: "縦 9:16（720×1280）", width: 720, height: 1280 },
  { id: "square", name: "正方形 1:1（900×900）", width: 900, height: 900 },
  { id: "landscape", name: "横 16:9（1280×720）", width: 1280, height: 720 },
];

export function getVideoSize(id: string): VideoSize {
  return VIDEO_SIZES.find((s) => s.id === id) ?? VIDEO_SIZES[0];
}

export const FRAME_RATES = [24, 30] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export interface RecordDanceOptions {
  canvas: HTMLCanvasElement;
  choreo: Choreography | MotionClip;
  stage: Stage;
  draw: DrawOptions;
  bounce: number;
  /** ノリの向き 0..1。0 が縦、1 が横。 */
  groove?: number;
  /** 体の連鎖の強さ 0..1。 */
  chain?: number;
  /** ダイナミクス 0..1。 */
  snap?: number;
  /** 追従（二次運動）0..1。 */
  follow?: number;
  /** 体型。骨格のサンプリングと描画で必ず同じものを使う。 */
  body?: Body;
  /** 1拍の秒数。 */
  secondsPerBeat: number;
  /** 書き出す長さ（拍）。 */
  totalBeats: number;
  fps: FrameRate;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface RecordDanceResult {
  blob: Blob;
  format: VideoFormat;
  seconds: number;
  /** 実際に入っていた映像コーデック。判定できなければ null。 */
  codec: string | null;
}

/** FourCC からコーデック名へ。 */
const CODEC_NAMES: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265",
  hev1: "H.265",
  vp08: "VP8",
  vp09: "VP9",
  av01: "AV1",
};

/**
 * 出来上がったファイルに実際に入っている映像コーデックを調べる。
 *
 * 指定した mime のとおりの中身が入っているとは限らないので、推測ではなく
 * 実物を見る。音声書き出し側と同じ考え方で、同じ解析処理を使い回している。
 */
async function inspectVideoCodec(blob: Blob, format: VideoFormat): Promise<string | null> {
  if (format.extension !== "mp4") {
    if (format.mime.includes("vp9")) return "VP9";
    if (format.mime.includes("vp8")) return "VP8";
    return null;
  }
  try {
    // fragmented MP4 は moov が先頭付近にあるので、冒頭だけ読めば足りる
    const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
    const entry = readMp4SampleEntry(head);
    return entry ? (CODEC_NAMES[entry] ?? entry) : null;
  } catch {
    return null;
  }
}

/**
 * 映像のビットレート。
 *
 * 高めに取っている。この動画は視聴用ではなく変換の入力なので、
 * ブロックノイズが乗ると変換結果までぼやける。
 */
function bitrateFor(size: { width: number; height: number }, fps: number): number {
  const pixels = size.width * size.height;
  return Math.round(Math.min(16_000_000, Math.max(4_000_000, pixels * fps * 0.12)));
}

/** 中断されたときに投げるエラー。呼び出し側で握りつぶす目印。 */
export class RecordAborted extends Error {
  constructor() {
    super("書き出しを中止しました。");
    this.name = "RecordAborted";
  }
}

/**
 * canvas に振り付けを実時間で描きながら録画する。
 *
 * タブが裏に回ると requestAnimationFrame が止まるため、書き出し中は
 * 画面を開いたままにしてもらう必要がある（UI 側で案内している）。
 */
export async function recordDance(opts: RecordDanceOptions): Promise<RecordDanceResult> {
  const format = pickVideoFormat();
  if (!format) {
    throw new Error("このブラウザは動画の作成（MediaRecorder）に対応していません。");
  }

  const ctx = opts.canvas.getContext("2d");
  if (!ctx) throw new Error("canvas を初期化できませんでした。");

  const stream = opts.canvas.captureStream(opts.fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: format.mime,
    videoBitsPerSecond: bitrateFor(opts.stage, opts.fps),
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("録画中にエラーが発生しました。"));
  });

  const duration = opts.totalBeats * opts.secondsPerBeat;
  let aborted = false;

  recorder.start(500);
  const startedAt = performance.now();

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (opts.signal?.aborted) {
        aborted = true;
        resolve();
        return;
      }
      const elapsed = (performance.now() - startedAt) / 1000;
      const clamped = Math.min(elapsed, duration);
      const skeleton = sampleSkeleton(opts.choreo, clamped / opts.secondsPerBeat, {
        bounce: opts.bounce,
        groove: opts.groove,
        chain: opts.chain,
        snap: opts.snap,
        follow: opts.follow,
        body: opts.body,
      });
      drawFrame(ctx, skeleton, opts.stage, opts.draw);
      opts.onProgress?.(Math.max(0, Math.min(0.999, elapsed / duration)));

      if (elapsed >= duration) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 最後のフレームが確実に1枚入るよう、少し置いてから止める
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();

  if (aborted) throw new RecordAborted();

  opts.onProgress?.(1);
  const blob = new Blob(chunks, { type: format.mime });
  return { blob, format, seconds: duration, codec: await inspectVideoCodec(blob, format) };
}
