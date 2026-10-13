/**
 * pipeline.mjs — 重複ファイル / 類似画像ファインダーの純ロジック
 *
 * DOM にも File API にも依存しない計算だけをまとめる:
 *   - 先頭 / 末尾チャンクの範囲決定と候補キー
 *   - ハッシュ (SHA-256 hex) と候補 / 完全重複グループの生成
 *   - 縮小グレースケールの知覚ハッシュ (dHash) と類似クラスタリング
 *   - 非破壊整理のための移動計画 (同名衝突の回避)
 *   - レポートの集計・JSON シリアライズ / 復元・CSV 出力
 *
 * node --test からそのまま検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

/** チャンク (先頭 / 末尾) として読むバイト数 */
export const CHUNK_SIZE = 64 * 1024;

/** SubtleCrypto で使うハッシュアルゴリズム */
export const HASH_ALGORITHM = 'SHA-256';

/** SHA-256 の hex 表記の長さ */
export const HASH_HEX_LENGTH = 64;

/** dHash のビット数 (8 行 × 8 比較) */
export const DHASH_BITS = 64;

/** dHash の hex 表記の長さ */
export const DHASH_HEX_LENGTH = DHASH_BITS / 4;

/** 類似判定の既定しきい値 (ハミング距離 / 64bit) */
export const DEFAULT_SIMILAR_THRESHOLD = 10;

/** 類似クラスタリングで一度に扱う最大件数 (O(n^2) を抑える) */
export const MAX_SIMILAR_ITEMS = 2000;

/** レポート形式のバージョン */
export const REPORT_VERSION = 1;

/** レポートの識別子 */
export const REPORT_APP = 'duplicate-finder';

/** 画像として扱う拡張子 */
export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp',
  'avif', 'tif', 'tiff', 'heic', 'heif', 'svg', 'ico',
]);

/* ==========================================================
   ファイル判定・整形
   ========================================================== */

/** 拡張子 (小文字、ドットなし) を取り出す */
export function extensionOf(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return '';
  return value.slice(dot + 1).toLowerCase();
}

/** ファイル名が画像拡張子かどうか */
export function isImageName(name) {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/**
 * File ライクなオブジェクトが画像かどうか。
 * type が image/* なら拡張子に関係なく画像として扱う。
 */
export function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  return isImageName(file.name);
}

/** バイト数を読みやすい表記にする */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[index]}`;
}

/** 長いパスを末尾優先で短縮する */
export function shortenPath(path, maxLength = 64) {
  const value = String(path ?? '');
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, maxLength - 1);
  return `…${value.slice(value.length - keep)}`;
}

/** ファイル名を「本体」と「拡張子 (ドット込み)」に分ける */
export function splitFileName(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return { base: value, ext: '' };
  return { base: value.slice(0, dot), ext: value.slice(dot) };
}

/**
 * 同名衝突を避けた名前を返す (foo.txt → foo (1).txt)。
 * taken は使用済み名の Set / 配列。大文字小文字は区別しない。
 */
export function uniqueName(name, taken = []) {
  const baseName = String(name ?? '');
  const has = (candidate) => {
    const lower = candidate.toLowerCase();
    if (taken instanceof Set) {
      for (const item of taken) {
        if (String(item).toLowerCase() === lower) return true;
      }
      return false;
    }
    return Array.from(taken || []).some((item) => String(item).toLowerCase() === lower);
  };

  if (!has(baseName)) return baseName;
  const { base, ext } = splitFileName(baseName);
  let index = 1;
  let candidate = `${base} (${index})${ext}`;
  while (has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  return candidate;
}

/* ==========================================================
   バイト列 / ハッシュ
   ========================================================== */

function toUint8(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input == null) return new Uint8Array(0);
  throw new TypeError('hexEncode/sha256Hex: ArrayBuffer / TypedArray / number[] を渡してください');
}

/** バイト列を小文字 hex にする */
export function hexEncode(input) {
  const bytes = toUint8(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** hex 文字列をバイト配列 (number[]) に戻す */
export function hexToBytes(hex) {
  const value = String(hex ?? '');
  if (value.length % 2 !== 0) throw new Error('hexToBytes: hex の長さが奇数です');
  const out = new Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** SubtleCrypto で SHA-256 の hex を返す (ブラウザ / Node 共通) */
export async function sha256Hex(input) {
  const bytes = toUint8(input);
  const digest = await globalThis.crypto.subtle.digest(HASH_ALGORITHM, bytes);
  return hexEncode(digest);
}

/**
 * 先頭 / 末尾チャンクとして読む範囲を返す。
 * size が 0 のときは空配列、chunkSize 以下なら全体 1 チャンク。
 */
export function chunkRanges(size, chunkSize = CHUNK_SIZE) {
  const total = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
  const chunk = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : CHUNK_SIZE;
  if (total === 0) return [];
  if (total <= chunk) return [{ offset: 0, length: total }];
  return [
    { offset: 0, length: chunk },
    { offset: total - chunk, length: chunk },
  ];
}

/**
 * サイズと先頭 / 末尾チャンクのハッシュから候補キーを作る。
 * サイズが同じでチャンクも一致するものだけを完全ハッシュの計算対象にする。
 */
export function candidateKey(size, headHash, tailHash) {
  const total = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
  return `${total}:${headHash || ''}:${tailHash || ''}`;
}

/* ==========================================================
   グループ化
   ========================================================== */

function normalizeGroupIds(group) {
  return [...group].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * 候補 (サイズ + 先頭/末尾チャンク) が一致するグループを返す。
 * 2 件以上のみを対象にする。
 */
export function groupCandidates(entries) {
  const buckets = new Map();
  for (const entry of entries || []) {
    const key = candidateKey(entry.size, entry.headHash, entry.tailHash);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const groups = [];
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    groups.push({ key, files: normalizeGroupIds(items) });
  }
  groups.sort((a, b) => String(a.files[0].id).localeCompare(String(b.files[0].id)));
  return groups;
}

/**
 * 完全ハッシュ (SHA-256) が一致するグループを返す。
 * 2 件以上のみを対象にする。
 */
export function groupExact(entries) {
  const buckets = new Map();
  for (const entry of entries || []) {
    const key = `${entry.size}:${entry.fullHash}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const groups = [];
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    groups.push({ key, files: normalizeGroupIds(items) });
  }
  groups.sort((a, b) => String(a.files[0].id).localeCompare(String(b.files[0].id)));
  return groups;
}

/* ==========================================================
   画像: グレースケール / dHash / 類似
   ========================================================== */

/** RGBA バイト列を輝度 (0-255) の配列にする */
export function grayFromRGBA(rgba, width, height) {
  const count = Math.max(0, Math.floor(width) * Math.floor(height));
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const r = rgba[i * 4] || 0;
    const g = rgba[i * 4 + 1] || 0;
    const b = rgba[i * 4 + 2] || 0;
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}

/**
 * グレースケール画像を outW × outH に再サンプルする (領域平均)。
 * 縮小時の情報落ちを抑えるため、出力 1 ピクセルごとに
 * 対応する入力矩形の平均を取る。
 */
export function resampleGray(gray, width, height, outW, outH) {
  const srcW = Math.max(1, Math.floor(width));
  const srcH = Math.max(1, Math.floor(height));
  const dstW = Math.max(1, Math.floor(outW));
  const dstH = Math.max(1, Math.floor(outH));
  const out = new Uint8Array(dstW * dstH);
  for (let oy = 0; oy < dstH; oy += 1) {
    const y0 = Math.floor((oy * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * srcH) / dstH));
    for (let ox = 0; ox < dstW; ox += 1) {
      const x0 = Math.floor((ox * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * srcW) / dstW));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < srcH; y += 1) {
        for (let x = x0; x < x1 && x < srcW; x += 1) {
          sum += gray[y * srcW + x] || 0;
          count += 1;
        }
      }
      out[oy * dstW + ox] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

/**
 * Difference Hash (dHash)。
 * 9 × 8 に縮小し、各行の隣接ピクセルを比較して 64bit の hex を返す。
 * 同じ画像なら距離 0、明るさが全体にずれても値は保たれる。
 */
export function dHash(gray, width, height) {
  const W = 9;
  const H = 8;
  const small = resampleGray(gray, width, height, W, H);
  let hex = '';
  let acc = 0;
  let bits = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W - 1; x += 1) {
      const left = small[y * W + x];
      const right = small[y * W + x + 1];
      const bit = left > right ? 1 : 0;
      acc = (acc << 1) | bit;
      bits += 1;
      if (bits === 4) {
        hex += acc.toString(16);
        acc = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/** 2 つの hex ハッシュのハミング距離 (bit) */
export function hammingDistance(hashA, hashB) {
  const a = String(hashA ?? '').toLowerCase();
  const b = String(hashB ?? '').toLowerCase();
  if (a.length !== b.length) {
    throw new Error('hammingDistance: ハッシュ長が一致しません');
  }
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let z = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf;
    while (z) {
      distance += z & 1;
      z >>= 1;
    }
  }
  return distance;
}

/** 0-100 の類似度 (%)。距離 0 で 100 */
export function similarityPercent(hashA, hashB) {
  const bits = String(hashA ?? '').length * 4;
  if (bits === 0) return 0;
  const distance = hammingDistance(hashA, hashB);
  return Math.round((1 - distance / bits) * 100);
}

/** ハミング距離がしきい値以下なら類似とみなす */
export function isSimilar(hashA, hashB, threshold = DEFAULT_SIMILAR_THRESHOLD) {
  return hammingDistance(hashA, hashB) <= threshold;
}

/**
 * dHash が近い画像を連結成分 (Union-Find) でクラスタリングする。
 * items: [{ id, dhash, ... }] / threshold: 最大ハミング距離。
 * 2 件以上のクラスタのみを、決定的な順序で返す。
 */
export function clusterBySimilarity(items, options = {}) {
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_SIMILAR_THRESHOLD;
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : MAX_SIMILAR_ITEMS;
  const list = (items || []).slice(0, Math.max(0, maxItems));
  const n = list.length;
  if (n < 2) return [];

  const parent = new Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (hammingDistance(list[i].dhash, list[j].dhash) <= threshold) {
        union(i, j);
      }
    }
  }

  const buckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(list[i]);
  }

  const groups = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    groups.push(normalizeGroupIds(members));
  }
  groups.sort((a, b) => String(a[0].id).localeCompare(String(b[0].id)));
  return groups;
}

/* ==========================================================
   集計・非破壊整理の計画
   ========================================================== */

/** グループの代表 (残す) ファイル: サイズ最大、同点は id 順 */
export function defaultKeepId(group) {
  const files = group?.files || [];
  if (!files.length) return null;
  let best = files[0];
  for (const file of files) {
    if (file.size > best.size) best = file;
    else if (file.size === best.size && String(file.id) < String(best.id)) best = file;
  }
  return best.id;
}

/**
 * グループの集計。keepIds を渡すと「残す 1 件」のサイズをその選択で計算する。
 * reclaimableBytes は移動して空けられる見込みの合計。
 */
export function summarizeGroups(groups, options = {}) {
  const keepIds = options.keepIds instanceof Map ? options.keepIds : new Map();
  let groupCount = 0;
  let fileCount = 0;
  let duplicateCount = 0;
  let totalBytes = 0;
  let reclaimableBytes = 0;

  for (const group of groups || []) {
    groupCount += 1;
    const files = group.files || [];
    let sum = 0;
    for (const file of files) {
      fileCount += 1;
      sum += Number(file.size) || 0;
    }
    const keepId = keepIds.has(group.id) ? keepIds.get(group.id) : defaultKeepId(group);
    const kept = files.find((file) => file.id === keepId);
    const keptSize = kept ? Number(kept.size) || 0 : 0;
    totalBytes += sum;
    duplicateCount += Math.max(0, files.length - 1);
    reclaimableBytes += Math.max(0, sum - keptSize);
  }

  return { groupCount, fileCount, duplicateCount, totalBytes, reclaimableBytes };
}

/**
 * 非破壊整理の移動計画を作る。
 * 各グループで残す 1 件以外を、同名衝突を避けた名前に割り当てる。
 * 返り値は { moves, taken } で、moves[].to は退避先フォルダ内の相対名。
 */
export function planMoves(groups, options = {}) {
  const keepIds = options.keepIds instanceof Map ? options.keepIds : new Map();
  const taken = new Set();
  const moves = [];
  for (const group of groups || []) {
    const files = group.files || [];
    const keepId = keepIds.has(group.id) ? keepIds.get(group.id) : defaultKeepId(group);
    for (const file of files) {
      if (file.id === keepId) continue;
      const name = uniqueName(file.name, taken);
      taken.add(name);
      moves.push({
        groupId: group.id,
        fileId: file.id,
        from: file.path,
        name,
        to: name,
      });
    }
  }
  return { moves, taken };
}

/* ==========================================================
   レポート (JSON / CSV)
   ========================================================== */

/** グループ一覧からレポートオブジェクトを組み立てる */
export function buildReport(groups, options = {}) {
  const keepIds = options.keepIds instanceof Map ? options.keepIds : new Map();
  const normalized = (groups || []).map((group) => {
    const files = (group.files || [])
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      // File / Blob などのシリアライズできない参照を落として、レポートを自己完結にする
      .map((file) => ({
        id: file.id,
        path: file.path,
        name: file.name,
        size: Number(file.size) || 0,
        hash: file.hash || '',
        dhash: file.dhash || '',
        similarity: file.similarity,
      }));
    const keepId = keepIds.has(group.id) ? keepIds.get(group.id) : defaultKeepId(group);
    return {
      id: group.id,
      kind: group.kind || 'exact',
      key: group.key || '',
      distance: group.distance,
      files,
      keepId,
    };
  });
  return {
    app: REPORT_APP,
    version: REPORT_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    root: options.root || '',
    summary: summarizeGroups(normalized, { keepIds }),
    groups: normalized,
  };
}

/** レポートを整形 JSON 文字列にする */
export function groupsToJSON(report) {
  return JSON.stringify(report, null, 2);
}

/** JSON 文字列を検証して復元する (バージョン差異は警告として返す) */
export function groupsFromJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    throw new Error(`レポートの JSON を解析できません: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) {
    throw new Error('レポートの形式が不正です (groups 配列がありません)');
  }
  const warnings = [];
  if (parsed.app && parsed.app !== REPORT_APP) {
    warnings.push(`別アプリのレポートです: ${parsed.app}`);
  }
  if (parsed.version !== REPORT_VERSION) {
    warnings.push(`レポートのバージョンが異なります: ${parsed.version} (対応: ${REPORT_VERSION})`);
  }
  const groups = parsed.groups.map((group, index) => {
    if (!group || !Array.isArray(group.files)) {
      throw new Error(`groups[${index}] に files 配列がありません`);
    }
    return {
      id: group.id ?? `restored-${index}`,
      kind: group.kind || 'exact',
      key: group.key || '',
      distance: group.distance,
      keepId: group.keepId ?? group.files[0]?.id ?? null,
      files: group.files.map((file) => ({
        id: file.id,
        path: file.path,
        name: file.name,
        size: Number(file.size) || 0,
        hash: file.hash || '',
        dhash: file.dhash || '',
        similarity: file.similarity,
      })),
    };
  });
  return {
    app: parsed.app || REPORT_APP,
    version: parsed.version ?? REPORT_VERSION,
    generatedAt: parsed.generatedAt || '',
    root: parsed.root || '',
    summary: parsed.summary || summarizeGroups(groups),
    groups,
    warnings,
  };
}

/** 1 つのフィールドを CSV 用にエスケープする */
export function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** オブジェクト配列を CSV 文字列にする (キーは列指定 or 先頭行から推定) */
export function rowsToCSV(rows, columns) {
  const list = rows || [];
  const cols = columns && columns.length
    ? columns
    : list.length
      ? Object.keys(list[0])
      : [];
  if (!cols.length) return '';
  const lines = [cols.map(escapeCsv).join(',')];
  for (const row of list) {
    lines.push(cols.map((col) => escapeCsv(row[col])).join(','));
  }
  return lines.join('\r\n');
}

/** レポートを行 (1 ファイル 1 行) に変換する */
export function reportToRows(report) {
  const rows = [];
  for (const group of report?.groups || []) {
    for (const file of group.files || []) {
      rows.push({
        kind: group.kind,
        group: group.id,
        status: file.id === group.keepId ? 'keep' : 'move',
        path: file.path,
        name: file.name,
        size: file.size,
        sizeText: formatBytes(file.size),
        hash: file.hash || '',
        dhash: file.dhash || '',
        similarity: file.similarity ?? '',
      });
    }
  }
  return rows;
}
