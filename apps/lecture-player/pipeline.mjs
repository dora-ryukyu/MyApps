/**
 * pipeline.mjs — 講義プレイヤーの純ロジック
 *
 * DOM に依存しない計算だけをまとめる:
 *   - 時刻の変換・整形 (SRT / VTT / UI 表示 / チャプター)
 *   - 字幕 (SRT / VTT) のパースと VTT への変換
 *   - 現在時刻に対応する字幕の検索
 *   - A-B ループの正規化
 *   - タイムスタンプ付きマーカーの追加・整列・シリアライズ
 *   - マーカーから Markdown ノート / チャプターを組み立てる
 *   - プレイリストの振り分け・字幕の自動照合・ファイル名の整形
 *
 * node --test からそのまま検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

export const SUBTITLE_EXTENSIONS = ['.vtt', '.srt'];

export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.ogg', '.mkv'];

export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.oga', '.flac', '.opus'];

export const RATE_MIN = 0.5;
export const RATE_MAX = 3;
export const RATE_STEP = 0.25;

/** ショートカットやプリセットで使う標準の倍速候補 */
export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 前後シークの幅 (秒) */
export const SEEK_STEP = 5;
export const SEEK_STEP_LARGE = 10;

/** A-B ループの最短区間 (秒) */
export const MIN_LOOP_SECONDS = 0.2;

export const NOTES_MIME = 'text/markdown';
export const MARKERS_MIME = 'application/json';

const DEFAULT_BASE_NAME = 'lecture';

/* ==========================================================
   数値・時刻
   ========================================================== */

export function clamp(value, min, max) {
  const v = Number.isFinite(value) ? value : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return v;
  return Math.min(Math.max(v, min), max);
}

export function clampTime(t, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const value = Number.isFinite(t) && t > 0 ? t : 0;
  return Math.min(value, d);
}

export function clampRate(rate) {
  const value = Number.isFinite(rate) ? rate : 1;
  return clamp(value, RATE_MIN, RATE_MAX);
}

function pad(value, length) {
  return String(value).padStart(length, '0');
}

function fractional(str) {
  if (!str) return 0;
  return Number(String(str).padEnd(3, '0')) / 1000;
}

/**
 * "00:01:23,456" / "01:23.456" / "83.456" などを秒に変換する。
 * 解釈できない場合は null。
 */
export function parseTimestamp(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m) {
    return (
      Number(m[1]) * 3600 +
      Number(m[2]) * 60 +
      Number(m[3]) +
      fractional(m[4])
    );
  }
  m = /^(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (m) {
    return Number(m[1]) * 60 + Number(m[2]) + fractional(m[3]);
  }
  m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]);
  return null;
}

/** SRT のタイムスタンプ "HH:MM:SS,mmm" */
export function toSrtTimestamp(seconds) {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const milli = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

/** WebVTT のタイムスタンプ "HH:MM:SS.mmm" */
export function toVttTimestamp(seconds) {
  return toSrtTimestamp(seconds).replace(',', '.');
}

/** UI 表示用 "M:SS" / "H:MM:SS" */
export function formatClock(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(value);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  return `${m}:${pad(s, 2)}`;
}

/** チャプター用 "MM:SS" / "H:MM:SS" (YouTube 向けにゼロ埋め) */
export function formatChapterTime(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(value);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  return `${pad(m, 2)}:${pad(s, 2)}`;
}

/** "1x" / "1.25x" / "1.5x" のような表記 */
export function formatRate(rate) {
  const value = clampRate(rate);
  return `${Number(value.toFixed(2))}x`;
}

export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function computeProgress(time, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (d === 0) return 0;
  return clamp(Number.isFinite(time) ? time : 0, 0, d) / d;
}

export function seekBy(time, delta, duration) {
  const base = Number.isFinite(time) ? time : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  return clampTime(base + step, duration);
}

/** 倍速をプリセット上で 1 段進める / 戻す */
export function nextRate(current, direction, presets = RATE_PRESETS) {
  const cur = clampRate(current);
  const list = [...new Set(presets.filter(Number.isFinite))].sort((a, b) => a - b);
  if (list.length === 0) return cur;
  if (direction > 0) {
    return list.find((rate) => rate > cur + 1e-9) ?? list[list.length - 1];
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] < cur - 1e-9) return list[i];
  }
  return list[0];
}

/* ==========================================================
   ファイル名
   ========================================================== */

export function fileExtension(name) {
  const base = String(name || '');
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function fileBaseName(name) {
  const base = String(name || '');
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const leaf = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

export function isSubtitleFile(name) {
  return SUBTITLE_EXTENSIONS.includes(fileExtension(name));
}

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.includes(fileExtension(name));
}

export function isAudioFile(name) {
  return AUDIO_EXTENSIONS.includes(fileExtension(name));
}

export function isMediaFile(name) {
  return isVideoFile(name) || isAudioFile(name);
}

/** 選択されたファイル名を メディア / 字幕 に振り分ける (順序を保つ) */
export function partitionFiles(names) {
  const media = [];
  const subtitles = [];
  for (const name of names || []) {
    if (isSubtitleFile(name)) subtitles.push(name);
    else if (isMediaFile(name)) media.push(name);
  }
  return { media, subtitles };
}

/** 字幕名がメディア名に対応するか ("lecture.mp4" ↔ "lecture.vtt" / "lecture.ja.vtt") */
export function subtitleMatchesMedia(mediaName, subtitleName) {
  const base = fileBaseName(mediaName);
  const sub = fileBaseName(subtitleName);
  if (!base || !sub) return false;
  return sub === base || sub.startsWith(`${base}.`);
}

/**
 * メディアに対応する字幕を 1 つ選ぶ。
 * 完全一致 → .vtt → それ以外 の優先順。
 */
export function findMatchingSubtitle(mediaName, subtitleNames) {
  const base = fileBaseName(mediaName);
  const matches = (subtitleNames || []).filter((name) => subtitleMatchesMedia(mediaName, name));
  if (matches.length === 0) return null;

  const preferVtt = (names) => names.find((name) => fileExtension(name) === '.vtt') || names[0];

  const exact = matches.filter((name) => fileBaseName(name) === base);
  if (exact.length > 0) return preferVtt(exact);
  return preferVtt(matches);
}

/**
 * 書き出しファイル名。元の名前から拡張子を除いて接尾辞を付ける。
 * 例: buildExportName('lecture.mp4', 'md', 'notes') → 'lecture-notes.md'
 */
export function buildExportName(name, extension = 'md', suffix = 'notes') {
  const base = fileBaseName(name) || DEFAULT_BASE_NAME;
  const safe = base.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+$/, '').trim();
  return `${safe || DEFAULT_BASE_NAME}-${suffix}.${extension}`;
}

/* ==========================================================
   字幕 (SRT / VTT)
   ========================================================== */

export function detectSubtitleFormat(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  if (/^\s*WEBVTT/.test(text)) return 'vtt';
  return 'srt';
}

/**
 * SRT / VTT を共通の cue 配列へ変換する。
 * 戻り値: [{ id, start, end, text, settings }]
 */
export function parseSubtitle(input) {
  const text = String(input || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const cues = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (!block.includes('-->')) continue; // WEBVTT / NOTE / STYLE は読み飛ばす

    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;

    const timingLine = lines[timingIndex].trim();
    const arrow = timingLine.indexOf('-->');
    const start = parseTimestamp(timingLine.slice(0, arrow));
    const rest = timingLine.slice(arrow + 3).trim();
    const endMatch = /^(\S+)/.exec(rest);
    const end = endMatch ? parseTimestamp(endMatch[1]) : null;
    if (start === null || end === null) continue;

    const settings = endMatch ? rest.slice(endMatch[1].length).trim() : '';
    const id = lines.slice(0, timingIndex).join(' ').trim() || String(cues.length + 1);
    const body = lines
      .slice(timingIndex + 1)
      .join('\n')
      .replace(/\s+$/, '');

    cues.push({ id, start, end, text: body, settings });
  }
  return cues;
}

export function cuesToVtt(cues) {
  const blocks = (cues || []).map((cue) => {
    const body = String(cue.text || '').replace(/\s+$/, '');
    const settings = cue.settings ? ` ${cue.settings}` : '';
    return `${toVttTimestamp(cue.start)} --> ${toVttTimestamp(cue.end)}${settings}\n${body}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** SRT を WebVTT へ変換する (時刻区切りのカンマをドットへ) */
export function srtToVtt(input) {
  return cuesToVtt(parseSubtitle(input));
}

/**
 * 指定時刻に表示すべき cue の位置を返す (無ければ -1)。
 * cue は start 昇順であることを前提とする。
 */
export function findActiveCueIndex(cues, time) {
  let found = -1;
  const t = Number.isFinite(time) ? time : 0;
  for (let i = 0; i < (cues || []).length; i += 1) {
    const cue = cues[i];
    if (cue.start <= t && t < cue.end) found = i;
    else if (cue.start > t) break;
  }
  return found;
}

export function findActiveCue(cues, time) {
  const index = findActiveCueIndex(cues, time);
  return index < 0 ? null : cues[index];
}

/* ==========================================================
   A-B ループ
   ========================================================== */

/**
 * A-B ループを正規化する。区間が短すぎるなど無効なら null。
 */
export function normalizeLoop(start, end, duration, minGap = MIN_LOOP_SECONDS) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const a = clampTime(start, d);
  const b = clampTime(end, d);
  if (b - a < minGap) return null;
  return { start: a, end: b };
}

/** 現在時刻が B を越えたか (ループ先頭へ戻すべきか) */
export function shouldLoopBack(currentTime, loop) {
  if (!loop || !Number.isFinite(currentTime)) return false;
  return currentTime >= loop.end - 1e-6;
}

/* ==========================================================
   マーカー
   ========================================================== */

function normalizeNote(note) {
  return String(note == null ? '' : note).replace(/\s+$/, '');
}

/** { time, note, id } を検証して正規化する (time が不正なら null) */
export function normalizeMarker(marker) {
  if (!marker || !Number.isFinite(marker.time) || marker.time < 0) return null;
  return {
    id: marker.id == null ? '' : String(marker.id),
    time: marker.time,
    note: normalizeNote(marker.note),
  };
}

export function sortMarkers(markers) {
  return [...(markers || [])]
    .map((marker) => ({ id: marker.id ?? '', time: marker.time, note: marker.note ?? '' }))
    .sort((a, b) => a.time - b.time);
}

/** マーカーを追加した新しい配列を time 昇順で返す */
export function addMarker(markers, marker) {
  const normalized = normalizeMarker(marker);
  if (!normalized) return sortMarkers(markers);
  return sortMarkers([...(markers || []), normalized]);
}

export function removeMarker(markers, id) {
  return (markers || []).filter((marker) => String(marker.id) !== String(id));
}

export function updateMarkerNote(markers, id, note) {
  return sortMarkers(
    (markers || []).map((marker) =>
      String(marker.id) === String(id) ? { ...marker, note: normalizeNote(note) } : marker,
    ),
  );
}

/** 保存用の JSON 文字列 (id は含めず、時刻はミリ秒単位に丸める) */
export function serializeMarkers(markers) {
  const data = sortMarkers(markers).map((marker) => ({
    time: Math.round(marker.time * 1000) / 1000,
    note: marker.note,
  }));
  return JSON.stringify(data, null, 2);
}

export function parseMarkers(json) {
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data.map((item) => normalizeMarker(item)).filter(Boolean);
  } catch {
    return [];
  }
}

/* ==========================================================
   ノート / チャプター
   ========================================================== */

/**
 * マーカーから講義ノートの Markdown を組み立てる。
 * notes-vault (P-20261011-01) へそのまま渡せる形にする。
 */
export function buildNotesMarkdown({ title = '講義ノート', source = '', duration = 0, markers = [] } = {}) {
  const sorted = sortMarkers(markers);
  const lines = [`# ${title}`, ''];
  if (source) lines.push(`- 元ファイル: \`${source}\``);
  lines.push(`- 長さ: ${formatClock(duration)}`);
  lines.push(`- マーカー: ${sorted.length} 件`);
  lines.push('');

  if (sorted.length === 0) {
    lines.push('(マーカーはまだありません)');
  } else {
    lines.push('## マーカー');
    for (const marker of sorted) {
      const note = marker.note.replace(/\n+/g, ' ').trim();
      lines.push(`- **${formatClock(marker.time)}** ${note || '(メモなし)'}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * マーカーからチャプター一覧を作る。先頭が 0 秒でない場合は導入チャプターを足す。
 */
export function buildChapters(markers, { intro = 'はじめに' } = {}) {
  const sorted = sortMarkers(markers);
  const chapters = [];
  if (sorted.length === 0 || sorted[0].time > 0.5) {
    chapters.push({ time: 0, label: sorted.length === 0 ? intro : intro, line: `${formatChapterTime(0)} ${intro}` });
  }
  for (const marker of sorted) {
    const label = marker.note.split('\n')[0].trim() || 'マーカー';
    chapters.push({ time: marker.time, label, line: `${formatChapterTime(marker.time)} ${label}` });
  }
  return chapters;
}

export function buildChaptersText(markers, options) {
  return buildChapters(markers, options)
    .map((chapter) => chapter.line)
    .join('\n');
}
