/**
 * 音源ファイルの再生。
 *
 * プレビューを実際の曲に合わせて見るためだけのもので、書き出す動画には
 * 入らない。動画を無音にしている理由は video.ts の先頭に書いてある。
 *
 * Web Audio ではなく HTMLAudioElement を使っている。長い曲でも読み込みを
 * 待たずに鳴らせて、シークもブラウザ任せにできるため。プレビューの同期は
 * requestAnimationFrame の粒度で足りるので、currentTime で十分。
 */

export interface AudioTrackInfo {
  name: string;
  /** 秒。メタデータが読めるまでは 0。 */
  duration: number;
}

export class AudioTrack {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;

  /** 曲の1拍目が音源の何秒目にあるか。ずれているときはここで合わせる。 */
  offset = 0;

  onEnded?: () => void;

  /** ファイルを読み込む。前に読んでいたものは破棄する。 */
  async load(file: File): Promise<AudioTrackInfo> {
    this.dispose();

    const url = URL.createObjectURL(file);
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = "metadata";

    this.url = url;
    this.el = el;
    el.addEventListener("ended", () => this.onEnded?.());

    const duration = await new Promise<number>((resolve) => {
      const done = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
      if (el.readyState >= 1) {
        done();
        return;
      }
      el.addEventListener("loadedmetadata", done, { once: true });
      // 壊れたファイルでも UI を止めない
      el.addEventListener("error", () => resolve(0), { once: true });
    });

    return { name: file.name, duration };
  }

  get loaded(): boolean {
    return this.el !== null;
  }

  get playing(): boolean {
    return this.el !== null && !this.el.paused;
  }

  /** くり返し再生するか。振り付けを何度も見たいので既定は true。 */
  set loop(value: boolean) {
    if (this.el) this.el.loop = value;
  }

  /**
   * 再生する。
   * ブラウザの自動再生制限があるので、必ずユーザー操作の中から呼ぶこと。
   */
  async play(): Promise<void> {
    if (!this.el) throw new Error("音源が読み込まれていません。");
    await this.el.play();
  }

  pause(): void {
    this.el?.pause();
  }

  /** 止めて先頭に戻す。 */
  stop(): void {
    if (!this.el) return;
    this.el.pause();
    this.el.currentTime = 0;
  }

  seek(seconds: number): void {
    if (!this.el) return;
    this.el.currentTime = Math.max(0, seconds);
  }

  /**
   * 1拍目を 0 とした再生位置（秒）。止まっていれば null。
   *
   * offset より手前を再生している間は負になるので、呼び出し側で拍に
   * 変換したあと剰余を取ること。
   */
  position(): number | null {
    if (!this.el || this.el.paused) return null;
    return this.el.currentTime - this.offset;
  }

  dispose(): void {
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
      this.el = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}

/**
 * 再生位置（秒）をループ内の拍位置に直す。
 *
 * 音源の長さと振り付けのループ長は一致しないので、剰余で巻き戻す。
 * 曲の頭より手前（offset 調整で負になる）でも 0..beatsPerLoop に収める。
 */
export function beatPosition(
  seconds: number,
  secondsPerBeat: number,
  beatsPerLoop: number,
): number {
  if (secondsPerBeat <= 0 || beatsPerLoop <= 0) return 0;
  const beats = seconds / secondsPerBeat;
  return ((beats % beatsPerLoop) + beatsPerLoop) % beatsPerLoop;
}
