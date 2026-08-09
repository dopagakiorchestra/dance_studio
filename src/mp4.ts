/**
 * MP4 コンテナの中身を覗く。
 *
 * MediaRecorder に形式を頼んでも、そのとおりの中身が入っているとは限らない。
 * 拡張子が .mp4 でも H.264 ではなく VP9 が入っていることがあり、そうなると
 * 多くのツールがファイルを開けない。推測で「H.264です」と表示しないために、
 * 出来上がった実物のボックス構造を読んで確かめる。
 */

/**
 * MP4 の stsd（サンプル記述）から、最初のサンプルエントリの FourCC を取り出す。
 *
 * moov → trak → mdia → minf → stbl → stsd の順にコンテナを降りていく。
 * 見つからなければ null。
 */
export function readMp4SampleEntry(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

  // 中を辿る必要があるコンテナボックス
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

  const scan = (start: number, end: number): string | null => {
    let off = start;
    while (off + 8 <= end) {
      const size = view.getUint32(off);
      const type = fourcc(off + 4);
      const boxEnd = size === 0 ? end : off + size;
      if (size < 8 || boxEnd > end) return null;

      if (type === "stsd") {
        // version/flags(4) + entry_count(4) を飛ばすとサンプルエントリ
        const entry = off + 16;
        if (entry + 8 <= boxEnd) return fourcc(entry + 4);
        return null;
      }
      if (containers.has(type)) {
        const hit = scan(off + 8, boxEnd);
        if (hit) return hit;
      }
      off = boxEnd;
    }
    return null;
  };

  return scan(0, bytes.byteLength);
}
