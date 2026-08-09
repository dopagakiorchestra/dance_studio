/**
 * 出来上がった動画ファイルをユーザーに渡す。
 *
 * 「ダウンロードさせるだけ」で済まないのは iOS のせいで、blob URL に対する
 * `<a download>` が無視される。共有シートに File を渡すか、別タブで開いて
 * そこの共有ボタンから保存してもらうかしかない。どちらもユーザー操作の
 * 直後でないと実行できないので、UI 側は録画完了後に改めてボタンを出す。
 */

import { isAbortError, isIosLike, needsManualSaveTap, pickSaveStrategy, type SaveStrategy } from "./compat";

/** ブラウザにファイルを保存させる（通常のダウンロード）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ revoke するとダウンロードが始まらないブラウザがあるので少し待つ
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** この端末でファイルを共有シートに渡せるか。 */
export function canShareFiles(filename: string, type: string): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return false;
  }
  try {
    const probe = new File([new Uint8Array([0])], filename, { type });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** この端末で使う保存方法。 */
export function saveStrategyFor(filename: string, type: string): SaveStrategy {
  return pickSaveStrategy({
    ios: typeof navigator !== "undefined" && isIosLike(navigator),
    canShareFiles: canShareFiles(filename, type),
  });
}

/**
 * 書き出しが終わったあと、保存に改めてタップが必要か。
 *
 * iOS では共有シートも別タブも、ユーザー操作の中からしか開けない。
 */
export function saveNeedsUserTap(): boolean {
  return needsManualSaveTap({
    ios: typeof navigator !== "undefined" && isIosLike(navigator),
  });
}

/**
 * 埋め込み表示で使える保存機能。無ければ null。
 *
 * 埋め込みの中では通常のダウンロードが塞がれるので、これがあるときは
 * 必ずこちらを使う。
 */
export function artifactDownloads(): ClaudeDownloads | null {
  if (typeof window === "undefined") return null;
  return window.claude?.downloads ?? null;
}

/**
 * Artifact ランタイム経由で保存する。
 * 確認ダイアログが出るので、必ずユーザー操作の中から呼ぶこと。
 */
export async function saveViaArtifact(blob: Blob, filename: string): Promise<SaveOutcome> {
  const downloads = artifactDownloads();
  if (!downloads) return "blocked";
  try {
    await downloads.save({ filename, data: blob });
    return "downloaded";
  } catch (err) {
    const code = (err as ClaudeDownloadsError | null)?.code;
    // 閲覧者が断った / 確認が期限切れになった場合は失敗扱いにしない
    if (code === "declined") return "cancelled";
    throw new Error(describeArtifactError(code, (err as ClaudeDownloadsError | null)?.message));
  }
}

function describeArtifactError(code: string | undefined, message?: string): string {
  switch (code) {
    case "too_large":
      return "ファイルが大きすぎます（16MBまで）。くり返し回数を減らすか、短い尺でお試しください。";
    case "rejected_extension":
    case "extension_not_enabled":
      return "この形式のファイルは保存が許可されていません。";
    case "rate_limited":
      return "保存の確認が既に開いています。少し待ってからもう一度お試しください。";
    case "unavailable":
    case "not_granted":
    case "capability_disabled":
    case "capability_removed":
      return "この表示ではファイル保存が使えません。";
    default:
      return message ?? "原因不明のエラーです。";
  }
}

export type SaveOutcome =
  | "shared"
  | "downloaded"
  | "cancelled"
  /** 別タブでファイルを開いた。そこの共有ボタンから保存してもらう。 */
  | "opened"
  /** iOS で保存経路が残らなかった（埋め込み表示など）。 */
  | "blocked";

/**
 * ファイルを保存する。
 *
 * iOS Safari は blob URL に対する `<a download>` を無視するので、共有シートに
 * File を渡して「"ファイル"に保存」してもらう。必ずユーザー操作の中から呼ぶこと。
 *
 * iframe に埋め込まれていると Permissions Policy で web-share が拒否されるため、
 * iOS では保存経路が残らない。その場合は "blocked" を返して、UI 側で
 * 「別タブで開いてください」と案内する。黙って失敗させない。
 */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveOutcome> {
  const ios = typeof navigator !== "undefined" && isIosLike(navigator);

  if (saveStrategyFor(filename, blob.type) === "share") {
    try {
      await navigator.share({
        files: [new File([blob], filename, { type: blob.type })],
        title: filename,
      });
      return "shared";
    } catch (err) {
      // ユーザーが閉じただけならエラー扱いしない
      if (isAbortError(err)) return "cancelled";
      // 共有が拒否された場合は通常のダウンロードを試す
    }
  }

  if (!ios) {
    downloadBlob(blob, filename);
    return "downloaded";
  }

  // iOS では download 属性が無視されるので、ダウンロードは試すだけ無駄。
  // 代わりにファイルを別タブで開く。iOS はそこにプレイヤーを表示し、
  // その画面の共有ボタンから「"ファイル"に保存」できる。
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank");
  if (opened) {
    // 開いたタブが読み終わるまで URL を生かしておく
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "opened";
  }

  // ポップアップも塞がれている = 埋め込み表示。打つ手がないので案内に切り替える。
  URL.revokeObjectURL(url);
  return "blocked";
}

/** ファイル名に使えない文字を落とす。 */
export function safeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80) || "dance"
  );
}
