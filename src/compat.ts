/**
 * ブラウザ差異の吸収。
 *
 * iOS Safari はファイル保存に癖があるので、判定ロジックはここにまとめて
 * テストできる形にしてある。
 */

/** userAgent 判定に必要な最小限の情報。テストから差し替えられるようにしている。 */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  platform?: string;
}

/**
 * iPhone / iPad かどうか。
 *
 * iPadOS 13 以降は userAgent で "Macintosh" を名乗るため、
 * タッチポイント数も併せて見ないと Mac と区別できない。
 */
export function isIosLike(nav: NavigatorLike): boolean {
  const ua = nav.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS: Mac を名乗るがマルチタッチを持つ
  return /Macintosh|Mac OS X/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** この端末が iPhone / iPad か。 */
export function isIosDevice(): boolean {
  return typeof navigator !== "undefined" && isIosLike(navigator);
}

export type SaveStrategy = "share" | "download";

/**
 * ファイルの保存方法を選ぶ。
 *
 * iOS Safari では blob URL に対する `<a download>` が無視されるので、
 * 共有シート（Web Share API）に file を渡すのが唯一の確実な保存経路になる。
 * それ以外の環境では、ユーザーの期待どおり黙ってダウンロードさせる。
 */
export function pickSaveStrategy(env: { ios: boolean; canShareFiles: boolean }): SaveStrategy {
  if (env.ios && env.canShareFiles) return "share";
  return "download";
}

/**
 * 保存に「もう一度タップ」が必要な環境か。
 *
 * iOS では保存経路が「共有シート」か「別タブで開く」しかなく、どちらも
 * ユーザー操作の直後（transient activation 有効中）でないと実行できない。
 * 録画の数十秒でその権利は切れてしまうので、書き出しが終わったあとに
 * 改めてタップしてもらう必要がある。
 *
 * 共有 API の有無では判断しない。共有が使えない iOS でも、黙って無視される
 * ダウンロードを自動実行してしまうと「押しても何も起きない」ことになるため。
 */
export function needsManualSaveTap(env: { ios: boolean }): boolean {
  return env.ios;
}

/** ユーザーが共有シートを閉じただけ（失敗ではない）かどうか。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort|cancel/i.test(err.message));
}

/**
 * 他ページに埋め込まれて動いているか。
 *
 * iframe の中では Permissions Policy により共有シート（web-share）が使えず、
 * iOS では保存経路が塞がれてしまう。その場合は「別タブで開く」よう促す。
 */
export function isEmbedded(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // クロスオリジンで window.top を触れない = 埋め込まれている
    return true;
  }
}
