/**
 * 動画から動きを取り込む。
 *
 * MediaPipe Pose Landmarker をブラウザで走らせて、コマごとに 33 点を取り、
 * `landmarks.ts` でこの骨格の回転に移す。
 *
 * ## 資材は自前で持つ
 *
 * WASM とモデルは `public/pose/` に置いてある（`scripts/fetch-pose-assets.mjs`
 * がビルド時に用意する）。CDN から読むと、変換したい場面でネットワークの
 * 都合に振り回されるうえ、こちらでは配信元へ到達できず検証もできない。
 *
 * ## 読み込みは使うときまで遅らせる
 *
 * WASM が 11MB、モデルが 5.5MB ある。動画を取り込まない人にまで
 * 落とさせないよう、`import()` で分けてある。
 *
 * ## コマの進め方
 *
 * `currentTime` を動かして `seeked` を待つ、を繰り返す。実時間で再生しながら
 * 拾うより遅いが、**取りこぼしが無く、何度やっても同じ結果になる**。
 * 推定は VIDEO ではなく IMAGE モードで回す（シークで時刻が前後するため）。
 */

import { poseFromLandmarks, smoothPoses, type Landmark, type MotionClip } from "./landmarks";

/** 取り込む1秒あたりのコマ数。 */
export const CAPTURE_FPS = 15;

/**
 * 取り込む長さの上限（秒）。
 *
 * コマごとにシークして推定を回すので、長いほど素直に時間がかかる。
 * 素材動画は数小節あれば足りるので、まず短く切って試すほうが早い。
 */
export const MAX_SECONDS = 30;

/** 推定に渡す画像の長辺。大きくしても精度はほぼ変わらず、遅くなるだけ。 */
const DETECT_SIZE = 480;

/** 前後何コマで均すか。奇数にすること。 */
const SMOOTH_WINDOW = 5;

export interface CaptureOptions {
  file: Blob;
  /** 体型の脚倍率。腰の高さをこの骨格に合わせるのに使う。 */
  legs?: number;
  /** ループ1周のカウント数を出すための、1拍の秒数。 */
  secondsPerBeat: number;
  onProgress?: (ratio: number, note: string) => void;
  signal?: AbortSignal;
}

export class CaptureAborted extends Error {
  constructor() {
    super("取り込みを中止しました");
    this.name = "CaptureAborted";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CaptureAborted();
}

/** 動画を読み込んで、メタデータが揃うまで待つ。 */
function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error("この動画を読み込めませんでした。"));
    video.src = url;
  });
}

/**
 * 尺を出す。`duration` が Infinity のときの回り込み付き。
 *
 * MediaRecorder で録った動画は尺が「不明」として記録される（このアプリの
 * 書き出しもそう）。そのまま信じると、4秒の動画を 30秒として読んで、
 * 残りは最後のコマが止まったまま並ぶ。実際にそうなった。
 *
 * ありえない時刻へシークさせると、ブラウザが末尾まで読んで尺を確定する。
 */
async function durationOf(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      video.removeEventListener("timeupdate", done);
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("timeupdate", done);
    video.addEventListener("seeked", done);
    video.currentTime = 1e6;
    // それでも決まらない実装のために、待ちすぎない
    setTimeout(done, 3000);
  });
  const found = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime;
  video.currentTime = 0;
  return Number.isFinite(found) && found > 0 ? found : 0;
}

/** 指定の時刻まで送って、その絵が出るまで待つ。 */
function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = seconds;
  });
}

let landmarkerPromise: Promise<{
  detect: (image: HTMLCanvasElement) => { worldLandmarks: Landmark[][] };
  close: () => void;
}> | null = null;

/** 推定器を作る。2回目からは使い回す（読み込みに1秒かかるので）。 */
async function getLandmarker(base: string): Promise<{
  detect: (image: HTMLCanvasElement) => { worldLandmarks: Landmark[][] };
  close: () => void;
}> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(`${base}pose/wasm`);
      return (await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${base}pose/pose_landmarker_lite.task`,
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        numPoses: 1,
      })) as unknown as {
        detect: (image: HTMLCanvasElement) => { worldLandmarks: Landmark[][] };
        close: () => void;
      };
    })().catch((err) => {
      // 失敗を覚えたままにすると、二度と読み込めなくなる
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

/**
 * 動画1本を `MotionClip` にする。
 *
 * 検出できなかったコマは**前のコマで埋める**。捨てて詰めると、その部分だけ
 * 動きが速くなって尺もずれる。最初から検出できないときは、そのコマを飛ばす。
 */
export async function captureMotion(opts: CaptureOptions): Promise<MotionClip> {
  const { file, signal } = opts;
  const base = import.meta.env.BASE_URL ?? "/";
  const url = URL.createObjectURL(file);

  try {
    opts.onProgress?.(0, "動画を読み込んでいます");
    const video = await loadVideo(url);
    throwIfAborted(signal);

    const duration = Math.min(MAX_SECONDS, await durationOf(video));
    if (!(duration > 0)) throw new Error("動画の長さが取れませんでした。");
    throwIfAborted(signal);

    opts.onProgress?.(0.02, "姿勢推定の準備をしています");
    const landmarker = await getLandmarker(base);
    throwIfAborted(signal);

    const scale = Math.min(1, DETECT_SIZE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas を用意できませんでした。");

    const total = Math.max(1, Math.floor(duration * CAPTURE_FPS));
    const frames: import("./skeleton").Pose[] = [];
    let detected = 0;
    let missed = 0;

    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      await seekTo(video, i / CAPTURE_FPS);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const result = landmarker.detect(canvas);
      const world = result.worldLandmarks?.[0];
      const pose = world ? poseFromLandmarks(world, { legs: opts.legs }) : null;

      if (pose) {
        frames.push(pose);
        detected++;
      } else if (frames.length > 0) {
        // 直前のコマで埋める。詰めると尺がずれる
        frames.push(frames[frames.length - 1]);
        missed++;
      } else {
        missed++;
      }

      if (i % 3 === 0) {
        opts.onProgress?.(
          0.02 + 0.96 * ((i + 1) / total),
          `${i + 1} / ${total} コマ（検出 ${detected}）`,
        );
      }
    }

    if (detected === 0) {
      throw new Error(
        "人を検出できませんでした。全身が入っていて、明るく、1人だけ写っている動画にしてください。",
      );
    }

    opts.onProgress?.(0.99, "均しています");
    const smoothed = smoothPoses(frames, SMOOTH_WINDOW);

    return {
      name: file instanceof File ? file.name : "取り込んだ動き",
      fps: CAPTURE_FPS,
      totalCounts: (smoothed.length / CAPTURE_FPS) / opts.secondsPerBeat,
      detected,
      missed,
      frames: smoothed,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
