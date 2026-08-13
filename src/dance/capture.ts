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

/**
 * 各段階の待ち時間の上限（ミリ秒）。
 *
 * **ここを入れていなかったせいで、読めない動画を渡すと無言で止まったままに
 * なっていた。** 何も起きないのが一番たちが悪い。行き詰まったら必ず理由を
 * 返して終わること。
 */
const LOAD_TIMEOUT = 20000;
const SEEK_TIMEOUT = 10000;
const MODEL_TIMEOUT = 120000;

/** 期限付きで待つ。時間切れなら `null` を返す。 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/**
 * このブラウザがこの動画を再生できそうか。
 *
 * iPhone で撮った .mov（HEVC）は Chrome や Firefox では開けないことが多い。
 * 読み込みが失敗してから言うより、選んだ時点で言うほうが親切。
 */
export function playabilityOf(file: Blob): "yes" | "maybe" | "no" {
  if (typeof document === "undefined") return "maybe";
  const probe = document.createElement("video");
  const type = file.type || "";
  if (!type) return "maybe";
  const can = probe.canPlayType(type);
  return can === "probably" ? "yes" : can === "maybe" ? "maybe" : "no";
}

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

/** 形式そのものが開けなかったときの案内。 */
const UNSUPPORTED =
  "この動画をブラウザが開けませんでした。形式が対応していない可能性があります" +
  "（iPhone の .mov / HEVC は Chrome や Firefox で開けないことが多い）。" +
  "MP4（H.264）に変換して試してください。";

/** 一度だけ発火するイベントを待つ。 */
function once(el: EventTarget, name: string): Promise<void> {
  return new Promise((resolve) => {
    const hit = (): void => {
      el.removeEventListener(name, hit);
      resolve();
    };
    el.addEventListener(name, hit);
  });
}

/**
 * 動画を読み込んで、コマを取り出せる状態まで持っていく。
 *
 * **iOS Safari がここで引っかかる。** 画面に無い `<video>` を作って
 * `loadeddata` を待つ、という素直な書き方だと、iOS では再生を一度始めるまで
 * データを読み進めないので、いつまでもイベントが来ない（`error` すら来ない
 * ので「20秒待っても開かない」で終わる）。実際に iPhone の Safari で、
 * ふつうの .mp4 がそれで止まった。
 *
 * 対策は3つとも要る。
 *
 * 1. `<video>` を DOM に入れる。画面外でも、繋がっていないと iOS は読まない
 * 2. `muted` と `playsinline` を**属性としても**付ける。プロパティだけだと
 *    iOS の自動再生の判定に引っかかることがある
 * 3. 一度 `play()` してすぐ `pause()` する。これでデコーダが動いて最初の
 *    コマが用意される。ここを省くと、読み込めても `drawImage` が真っ白になる
 */
async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  // 画面外に置くが、DOM には入れる（iOS は繋がっていない video を読まない）
  video.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);

  let failed = false;
  video.addEventListener("error", () => {
    failed = true;
  });

  // 大きさが分かった時点でいったん先へ進む。iOS は loadeddata まで来ないことがある
  const sized = new Promise<void>((resolve) => {
    const check = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
    };
    for (const name of ["loadedmetadata", "loadeddata", "canplay", "durationchange"]) {
      video.addEventListener(name, check);
    }
  });

  video.src = url;
  video.load();

  if ((await withTimeout(sized, LOAD_TIMEOUT)) === null) {
    if (failed) throw new Error(UNSUPPORTED);
    throw new Error(
      `${LOAD_TIMEOUT / 1000} 秒待っても動画が開きませんでした。` +
        "ファイルが大きすぎるか、この端末で扱えない形式かもしれません。" +
        "短く切るか、MP4（H.264）に変換して試してください。",
    );
  }
  if (failed) throw new Error(UNSUPPORTED);

  // デコーダを一度回して最初のコマを用意させる。これが無いと iOS では
  // 読み込めていても canvas に転写した絵が空になる
  try {
    const playing = once(video, "timeupdate");
    await video.play();
    await withTimeout(playing, 3000);
    video.pause();
    video.currentTime = 0;
  } catch {
    // 自動再生を断られても、コマが取れるなら続行する
  }

  return video;
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

/**
 * 指定の時刻まで送って、その絵が出るまで待つ。
 *
 * 時間切れになっても投げない。1コマ送れなかっただけで全体を落とすより、
 * そのコマを諦めて先へ進むほうがまし。
 */
async function seekTo(video: HTMLVideoElement, seconds: number): Promise<boolean> {
  // すでにその時刻なら `seeked` は飛んでこない。待つと時間切れになるだけ。
  // 最初のコマ（0秒）が必ずこれに当たるので、入れておかないと毎回そこで詰まる
  if (Math.abs(video.currentTime - seconds) < 1e-3 && video.readyState >= 2) return true;

  const done = new Promise<boolean>((resolve) => {
    const hit = (): void => {
      video.removeEventListener("seeked", hit);
      resolve(true);
    };
    video.addEventListener("seeked", hit);
    video.currentTime = seconds;
  });
  return (await withTimeout(done, SEEK_TIMEOUT)) ?? false;
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
  let video: HTMLVideoElement | null = null;

  try {
    opts.onProgress?.(0, `動画を読み込んでいます（${(file.size / 1048576).toFixed(1)}MB）`);
    video = await loadVideo(url);
    throwIfAborted(signal);

    opts.onProgress?.(0.01, `${video.videoWidth}×${video.videoHeight} ／ 長さを調べています`);
    const duration = Math.min(MAX_SECONDS, await durationOf(video));
    if (!(duration > 0)) throw new Error("動画の長さが取れませんでした。");
    throwIfAborted(signal);

    opts.onProgress?.(0.02, "姿勢推定の準備をしています（初回は 17MB 落とします）");
    const landmarker = await withTimeout(getLandmarker(base), MODEL_TIMEOUT);
    if (!landmarker) {
      throw new Error(
        "姿勢推定の読み込みが終わりませんでした（初回は 17MB 落とします）。" +
          "通信の状態を確かめて、もう一度試してください。",
      );
    }
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

    let stalled = 0;
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      if (!(await seekTo(video, i / CAPTURE_FPS))) stalled++;
      if (stalled > 5) {
        throw new Error(
          "動画のコマ送りが進まなくなりました。別の形式（MP4／H.264）で試してください。",
        );
      }
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
        `${total} コマ調べましたが、人を検出できませんでした。` +
          "全身（頭から足先まで）が入っていて、明るく、1人だけ写っている動画にしてください。",
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
    video?.remove();
    URL.revokeObjectURL(url);
  }
}
