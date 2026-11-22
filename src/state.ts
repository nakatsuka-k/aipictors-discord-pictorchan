// 状態の JSON は R2（pictorchan-state）に置き、起動時にまとめて読み込んでメモリで使う。
// 書き込みは呼ばれた時点の内容を R2 に送る（まとめ書きは util.debounced で行う）
const files = new Map<string, unknown>();
const writes = new Map<string, Promise<void>>();
let bucket: R2Bucket | null = null;

const keyOf = (filePath: string) => filePath.split("/").pop()!;

/** R2 の JSON をすべて読み込む。失敗したまま空で動くと記憶を上書きしてしまうので、読めなければ例外 */
export async function loadState(state: R2Bucket, options: { readOnly?: boolean } = {}) {
  // readOnly: 試験用（読むだけで書き戻さない）
  bucket = options.readOnly ? null : state;
  const listed = await state.list();
  for (const object of listed.objects) {
    if (!object.key.endsWith(".json")) continue;
    const body = await state.get(object.key);
    if (!body) throw new Error(`state ${object.key} missing`);
    files.set(object.key, JSON.parse(await body.text()));
  }
  console.log(`[STATE] loaded ${files.size} files`);
}

export function readJson<T>(filePath: string, fallback: T): T {
  return files.has(keyOf(filePath)) ? (files.get(keyOf(filePath)) as T) : fallback;
}

export function writeJsonAtomic(filePath: string, data: unknown) {
  const key = keyOf(filePath);
  files.set(key, data);
  if (!bucket) return;
  const body = JSON.stringify(data);
  // 同じファイルへの書き込みは順番に（古い内容があとから届かないように）
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => bucket!.put(key, body))
    .then(() => undefined)
    .catch((error) => console.error(`[STATE] write error ${key}`, error));
  writes.set(key, next);
}

/** 送信中の書き込みが終わるまで待つ */
export async function settleWrites() {
  await Promise.all(Array.from(writes.values()));
}
