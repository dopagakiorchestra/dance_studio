/**
 * claude.ai の Artifact ランタイムがページに注入する API の型。
 *
 * 埋め込み表示のときだけ存在する。埋め込みの中では通常のダウンロードが
 * ブラウザに塞がれるので、ファイルを渡す唯一の経路がこれになる。
 *
 * 保存できる拡張子には制限があり、音声では mp4 / webm のみ許可されている
 * （mp3 や wav は不可）。
 */

interface ClaudeDownloadsError {
  code:
    | "rejected_extension"
    | "extension_not_enabled"
    | "too_large"
    | "declined"
    | "rate_limited"
    | "bad_request"
    | "unavailable"
    | "not_granted"
    | "capability_disabled"
    | "capability_removed"
    | "transform_error";
  message: string;
}

interface ClaudeDownloads {
  /**
   * ファイルを閲覧者に提示する。確認ダイアログが出て、承諾されたときだけ保存される。
   * 必ずユーザー操作の中から呼ぶこと。
   */
  save(request: {
    filename: string;
    data: string | Blob | ArrayBuffer | ArrayBufferView;
  }): Promise<{ status: "saved" }>;
}

interface ClaudeRuntime {
  downloads?: ClaudeDownloads;
}

interface Window {
  claude?: ClaudeRuntime;
}
