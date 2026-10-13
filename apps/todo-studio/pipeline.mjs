/**
 * ToDo Studio — 純ロジック
 *
 * ブラウザでも Node でも動く依存ゼロのモジュール。
 * ここには DOM / localStorage / network を一切書かない（`node --test` で検証する）。
 *
 *  - タスクのデータモデル（タイトル・メモ・期限・優先度・タグ・プロジェクト）
 *  - 期限の判定・相対表示・集計（今日 / 今週 / 期限切れ / タグ別 / プロジェクト別 / カンバン）
 *  - 繰り返し（daily / weekly / monthly）と優先度（iCalendar PRIORITY 準拠）
 *  - VTODO / VEVENT を含む ICS のパースと生成（RFC 5545 サブセット）
 *  - 状態のシリアライズ / デシリアライズ
 *
 * ICS の解釈は 2 経路ある:
 *  - 内蔵パーサ (parseIcs): 依存ゼロ。オフラインでも動く。テスト対象。
 *  - ical.js (MPL-2.0) の jCal を変換 (jcalToTasks): ブラウザで第三者の ICS を
 *    厳密に読むための経路。script.js が動的 import し、失敗時は内蔵パーサに退避する。
 *
 * 参考: RFC 5545 (iCalendar), ical.js (MPL-2.0)
 */

/* ==========================================================
   定数
   ========================================================== */

export const APP_ID = 'todo-studio';
export const STATE_KEY = 'myapps:todo-studio:state:v1';
export const STATE_VERSION = 1;

/** 今日のタスクの 1 行サマリを Discord 等へ渡すときの受け渡しキー */
export const SUMMARY_HANDOFF_KEY = 'myapps:todo-summary';

/** ical.js はバージョン固定で読む（改変しない・MPL-2.0） */
export const LIBRARY_CDN_HOST = 'cdn.jsdelivr.net';
export const ICAL_MODULE_URL = 'https://cdn.jsdelivr.net/npm/ical.js@2.2.1/dist/ical.min.js';

export const ICS_MIME = 'text/calendar';
export const ICS_EXT = '.ics';
export const ICS_FILE_EXTENSIONS = ['.ics', '.ical', '.ifb'];

export const MAX_TASKS = 5000;
export const MAX_STATE_BYTES = 2000000;

export const VIEWS = [
  { id: 'today', label: '今日' },
  { id: 'week', label: '今週' },
  { id: 'overdue', label: '期限切れ' },
  { id: 'all', label: 'すべて' },
  { id: 'done', label: '完了' },
];

export const KANBAN_COLUMNS = [
  { id: 'now', title: '期限間近', hint: '期限切れ・今日・明日' },
  { id: 'later', title: 'これから', hint: '明後日以降・期限なし' },
  { id: 'done', title: '完了', hint: '完了したタスク' },
];

/** iCalendar の PRIORITY (1 = 最高 … 9 = 最低, 0 = 未設定) に合わせる */
export const PRIORITY_LEVELS = [
  { value: 0, id: 'none', label: 'なし' },
  { value: 1, id: 'highest', label: '最高' },
  { value: 3, id: 'high', label: '高' },
  { value: 5, id: 'medium', label: '中' },
  { value: 7, id: 'low', label: '低' },
  { value: 9, id: 'lowest', label: '最低' },
];

export const REPEAT_OPTIONS = [
  { id: 'none', label: '繰り返しなし', rrule: null },
  { id: 'daily', label: '毎日', rrule: 'FREQ=DAILY' },
  { id: 'weekly', label: '毎週', rrule: 'FREQ=WEEKLY' },
  { id: 'monthly', label: '毎月', rrule: 'FREQ=MONTHLY' },
];

const DAY_MS = 86400000;

/* ==========================================================
   小物ユーティリティ
   ========================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isIsoString(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(new Date(value).getTime());
}

let uidCounter = 0;

/** 内部 ID / ICS UID の生成 */
export function makeUid() {
  uidCounter += 1;
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `t${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/* ==========================================================
   日付
   ========================================================== */

export function startOfDay(value) {
  const d = toDate(value);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

/** b から a までの暦日数（a が未来なら正） */
export function dayDiff(a, b) {
  const da = startOfDay(a);
  const db = startOfDay(b);
  if (!da || !db) return NaN;
  return Math.round((da.getTime() - db.getTime()) / DAY_MS);
}

/**
 * 期限文字列をローカルの Date に変換する。
 *  - 'YYYY-MM-DD' (終日) はローカル 0 時
 *  - ISO 文字列 (時刻あり) は Date に委ねる
 */
export function dueToDate(due) {
  if (!due) return null;
  const s = String(due);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Date → 'YYYY-MM-DD' (ローカル) */
export function dateToDateKey(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dueDateKey(due) {
  return dateToDateKey(dueToDate(due));
}

/**
 * 期限の正規化。返り値の due は
 *  - 終日: 'YYYY-MM-DD'
 *  - 時刻あり: ISO 8601 (UTC, 例 2026-10-20T00:00:00.000Z)
 */
export function normalizeDue(due, dueHasTime) {
  if (due === null || due === undefined || due === '') return { due: null, dueHasTime: false };
  const s = String(due).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { due: s, dueHasTime: false };
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      const local = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      return { due: local.toISOString(), dueHasTime: true };
    }
    return { due: null, dueHasTime: false };
  }
  return { due: dt.toISOString(), dueHasTime: dueHasTime !== false };
}

/**
 * 期限の状態。
 * 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none'
 */
export function dueStatus(due, now = Date.now()) {
  const dt = dueToDate(due);
  if (!dt) return 'none';
  const diff = dayDiff(dt, now);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}

export function isOverdue(due, now = Date.now()) {
  return dueStatus(due, now) === 'overdue';
}

export function isDueToday(due, now = Date.now()) {
  return dueStatus(due, now) === 'today';
}

/** 期限が now から days 日以内（期限切れは含まない） */
export function isDueSoon(due, now = Date.now(), days = 2) {
  const dt = dueToDate(due);
  if (!dt) return false;
  const diff = dayDiff(dt, now);
  return diff >= 0 && diff <= days;
}

/** 期限間近 (今日・明日) のハイライト判定 */
export function isDueHighlight(due, now = Date.now()) {
  const s = dueStatus(due, now);
  return s === 'today' || s === 'tomorrow';
}

export function formatRelativeDue(due, now = Date.now()) {
  const dt = dueToDate(due);
  if (!dt) return '期限なし';
  const diff = dayDiff(dt, now);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  if (diff < 0) return `${-diff}日前`;
  if (diff <= 6) return `${diff}日後`;
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

export function formatDueLabel(due, dueHasTime, now = Date.now()) {
  if (!due) return '期限なし';
  const rel = formatRelativeDue(due, now);
  if (!dueHasTime) return rel;
  const dt = dueToDate(due);
  if (!dt) return rel;
  return `${rel} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

export function formatDate(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ==========================================================
   優先度
   ========================================================== */

export function normalizePriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > 9) return 9;
  return i;
}

export function priorityLabel(value) {
  const v = normalizePriority(value);
  if (v === 0) return PRIORITY_LEVELS[0].label;
  const level = PRIORITY_LEVELS.find((p) => p.value === v);
  if (level) return level.label;
  if (v <= 2) return '最高';
  if (v <= 4) return '高';
  if (v <= 6) return '中';
  if (v <= 8) return '低';
  return '最低';
}

/** 0 (最高) 〜 4 (最低), 未設定は 5 (最後に並ぶ) */
export function priorityRank(value) {
  const v = normalizePriority(value);
  if (v === 0) return 5;
  if (v <= 2) return 0;
  if (v <= 4) return 1;
  if (v <= 6) return 2;
  if (v <= 8) return 3;
  return 4;
}

/* ==========================================================
   繰り返し
   ========================================================== */

export function repeatLabel(id) {
  const opt = REPEAT_OPTIONS.find((o) => o.id === id);
  return opt ? opt.label : REPEAT_OPTIONS[0].label;
}

export function repeatToRRule(id) {
  const opt = REPEAT_OPTIONS.find((o) => o.id === id);
  return opt && opt.rrule ? opt.rrule : null;
}

export function rruleToRepeat(rrule) {
  if (!rrule) return 'none';
  let freq = '';
  if (typeof rrule === 'object' && rrule && rrule.freq) {
    freq = String(rrule.freq).toUpperCase();
  } else {
    const m = /FREQ=([A-Z]+)/i.exec(String(rrule));
    if (m) freq = m[1].toUpperCase();
  }
  if (freq === 'DAILY') return 'daily';
  if (freq === 'WEEKLY') return 'weekly';
  if (freq === 'MONTHLY') return 'monthly';
  return 'none';
}

/** 次の期限を返す。繰り返しなしならそのまま */
export function nextDue(due, dueHasTime, repeat) {
  const dt = dueToDate(due);
  if (!dt || !repeat || repeat === 'none') return { due: due || null, dueHasTime: !!dueHasTime };
  if (repeat === 'daily') {
    dt.setDate(dt.getDate() + 1);
  } else if (repeat === 'weekly') {
    dt.setDate(dt.getDate() + 7);
  } else if (repeat === 'monthly') {
    const day = dt.getDate();
    dt.setDate(1);
    dt.setMonth(dt.getMonth() + 1);
    const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(day, lastDay));
  } else {
    return { due: due || null, dueHasTime: !!dueHasTime };
  }
  return {
    due: dueHasTime ? dt.toISOString() : dateToDateKey(dt),
    dueHasTime: !!dueHasTime,
  };
}

/* ==========================================================
   タスクのデータモデル
   ========================================================== */

export function normalizeTags(tags) {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function createTask(overrides = {}, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const id = overrides.id ? String(overrides.id) : makeUid();
  const uid = overrides.uid ? String(overrides.uid) : `${id}@myapps.local`;
  const due = normalizeDue(overrides.due, overrides.dueHasTime);
  return {
    id,
    uid,
    title: String(overrides.title ?? ''),
    notes: String(overrides.notes ?? ''),
    due: due.due,
    dueHasTime: due.dueHasTime,
    priority: normalizePriority(overrides.priority),
    tags: normalizeTags(overrides.tags),
    project: overrides.project ? String(overrides.project) : '',
    done: !!overrides.done,
    completedAt: isIsoString(overrides.completedAt) ? overrides.completedAt : null,
    lastCompletedAt: isIsoString(overrides.lastCompletedAt) ? overrides.lastCompletedAt : null,
    repeat: REPEAT_OPTIONS.some((o) => o.id === overrides.repeat) ? overrides.repeat : 'none',
    source: overrides.source === 'event' ? 'event' : 'todo',
    createdAt: isIsoString(overrides.createdAt) ? overrides.createdAt : iso,
    updatedAt: isIsoString(overrides.updatedAt) ? overrides.updatedAt : iso,
  };
}

export function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return createTask();
  const task = createTask(raw, Date.now());
  if (raw.id) task.id = String(raw.id);
  if (raw.uid) task.uid = String(raw.uid);
  return task;
}

export function applyTaskPatch(task, patch = {}, now = Date.now()) {
  const merged = { ...task, ...patch };
  return normalizeTask({ ...merged, id: task.id, uid: task.uid, createdAt: task.createdAt });
}

/* ==========================================================
   並び替え / 選択 / 集計
   ========================================================== */

export function sortTasks(tasks, mode = 'due', now = Date.now()) {
  const list = [...tasks];
  const dueTime = (t) => {
    const d = dueToDate(t.due);
    return d ? d.getTime() : Number.POSITIVE_INFINITY;
  };
  const byDue = (a, b) =>
    dueTime(a) - dueTime(b) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.title.localeCompare(b.title, 'ja');

  if (mode === 'priority') {
    list.sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        dueTime(a) - dueTime(b) ||
        a.title.localeCompare(b.title, 'ja'),
    );
  } else if (mode === 'title') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  } else if (mode === 'created') {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } else if (mode === 'updated') {
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } else if (mode === 'completed') {
    list.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  } else {
    list.sort(byDue);
  }
  return list;
}

export function selectTasks(tasks, options = {}) {
  const { view = 'all', tag = '', project = '', query = '', includeDone = false, now = Date.now() } = options;
  const q = String(query || '').trim().toLowerCase();
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (view === 'done') {
      if (!t.done) return false;
    } else if (!includeDone && t.done) {
      return false;
    }
    if (view === 'today') {
      const s = dueStatus(t.due, now);
      if (s !== 'overdue' && s !== 'today') return false;
    } else if (view === 'week') {
      const s = dueStatus(t.due, now);
      if (s !== 'overdue' && s !== 'today' && s !== 'tomorrow' && s !== 'week') return false;
    } else if (view === 'overdue') {
      if (dueStatus(t.due, now) !== 'overdue') return false;
    }
    if (tag && !(t.tags || []).includes(tag)) return false;
    if (project && t.project !== project) return false;
    if (q) {
      const hay = [t.title, t.notes, t.project, ...(t.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return sortTasks(list, view === 'done' ? 'completed' : 'due', now);
}

export function countByBucket(tasks, now = Date.now()) {
  const counts = { overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, none: 0, done: 0 };
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t.done) {
      counts.done += 1;
      continue;
    }
    counts[dueStatus(t.due, now)] += 1;
  }
  return counts;
}

export function groupForKanban(tasks, now = Date.now()) {
  const columns = KANBAN_COLUMNS.map((c) => ({ ...c, tasks: [] }));
  const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t.done) {
      byId.done.tasks.push(t);
      continue;
    }
    const s = dueStatus(t.due, now);
    if (s === 'overdue' || s === 'today' || s === 'tomorrow') byId.now.tasks.push(t);
    else byId.later.tasks.push(t);
  }
  for (const c of columns) c.tasks = sortTasks(c.tasks, 'due', now);
  return columns;
}

export function groupByTag(tasks) {
  const map = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const keys = t.tags && t.tags.length ? t.tags : ['(タグなし)'];
    for (const key of keys) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, tasks: sortTasks(list, 'due') }))
    .sort((a, b) => a.key.localeCompare(b.key, 'ja'));
}

export function groupByProject(tasks) {
  const map = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const key = t.project && t.project.trim() ? t.project : '(プロジェクトなし)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, tasks: sortTasks(list, 'due') }))
    .sort((a, b) => a.key.localeCompare(b.key, 'ja'));
}

/** 収集したタグ一覧 */
export function collectTags(tasks) {
  const set = new Set();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    for (const tag of t.tags || []) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

export function collectProjects(tasks) {
  const set = new Set();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t.project && t.project.trim()) set.add(t.project.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/**
 * 「今日のタスク」を 1 行にまとめる。
 * Discord に貼る / `/remind` (P-20261009-03) の入力に使う想定。
 */
export function buildTodaySummary(tasks, now = Date.now(), options = {}) {
  const { max = 5, prefix = '[ToDo]', includeOverdue = true } = options;
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => !t.done);
  const overdue = [];
  const today = [];
  for (const t of open) {
    const s = dueStatus(t.due, now);
    if (s === 'overdue') overdue.push(t);
    else if (s === 'today') today.push(t);
  }
  const ordered = includeOverdue ? [...sortTasks(overdue, 'due', now), ...sortTasks(today, 'due', now)] : sortTasks(today, 'due', now);
  const shown = ordered.slice(0, Math.max(0, max));
  const rest = ordered.length - shown.length;
  const parts = [`${prefix} 今日 ${today.length}件`];
  if (overdue.length) parts.push(`期限切れ ${overdue.length}件`);
  let text = parts.join(' / ');
  if (shown.length) text += `: ${shown.map((t) => t.title || '(無題)').join(' / ')}`;
  if (rest > 0) text += ` ほか${rest}件`;
  return text;
}

/* ==========================================================
   状態と操作
   ========================================================== */

export function createState() {
  return { version: STATE_VERSION, tasks: [], updatedAt: new Date().toISOString() };
}

export function findTask(state, id) {
  if (!state || !Array.isArray(state.tasks)) return null;
  return state.tasks.find((t) => t.id === id) || null;
}

export function addTask(state, input = {}, now = Date.now()) {
  const task = createTask(input, now);
  return { ...state, tasks: [...state.tasks, task], updatedAt: new Date(now).toISOString() };
}

export function updateTask(state, id, patch = {}, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const tasks = state.tasks.map((t) =>
    t.id === id ? normalizeTask({ ...t, ...patch, id: t.id, uid: t.uid, updatedAt: iso }) : t,
  );
  return { ...state, tasks, updatedAt: iso };
}

export function removeTask(state, id) {
  return {
    ...state,
    tasks: state.tasks.filter((t) => t.id !== id),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 完了 / 未完了の切替。
 * 繰り返しタスクを完了すると、次回の期限に進めて未完了のまま残す。
 */
export function toggleTaskDone(state, id, now = Date.now()) {
  const task = findTask(state, id);
  if (!task) return state;
  const iso = new Date(now).toISOString();
  if (!task.done && task.repeat !== 'none' && task.due) {
    const next = nextDue(task.due, task.dueHasTime, task.repeat);
    return updateTask(
      state,
      id,
      { done: false, due: next.due, dueHasTime: next.dueHasTime, lastCompletedAt: iso },
      now,
    );
  }
  return updateTask(state, id, { done: !task.done, completedAt: !task.done ? iso : null }, now);
}

export function clearCompleted(state) {
  return {
    ...state,
    tasks: state.tasks.filter((t) => !t.done),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeState(raw) {
  const state = createState();
  if (!raw || typeof raw !== 'object') return state;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt;
  const list = Array.isArray(raw.tasks) ? raw.tasks : [];
  state.tasks = list.slice(0, MAX_TASKS).map(normalizeTask);
  return state;
}

export function serializeState(state) {
  return JSON.stringify({
    version: STATE_VERSION,
    updatedAt: state.updatedAt || new Date().toISOString(),
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
  });
}

export function deserializeState(text) {
  if (!text) return createState();
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return createState();
  }
}

export function stateByteSize(state) {
  return new TextEncoder().encode(serializeState(state)).length;
}

/* ==========================================================
   ICS: 共通ヘルパー
   ========================================================== */

export function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n?|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function icsUnescape(value) {
  const s = String(value ?? '');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n' || n === 'N') {
        out += '\n';
        i += 1;
        continue;
      }
      if (n === ',' || n === ';' || n === '\\') {
        out += n;
        i += 1;
        continue;
      }
      out += n;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** エスケープされていないカンマで分割 */
export function splitIcsValues(value) {
  const s = String(value ?? '');
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.filter((v) => v !== '').length ? out.filter((v) => v !== '') : out;
}

/** 75 オクテット折り返し（近似: 文字数で折る） */
export function foldIcsLine(line) {
  const s = String(line);
  if (s.length <= 73) return s;
  const parts = [s.slice(0, 73)];
  let i = 73;
  while (i < s.length) {
    parts.push(s.slice(i, i + 72));
    i += 72;
  }
  return parts.join('\r\n ');
}

function toIcsStamp(value) {
  const d = toDate(value) || new Date();
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/* ==========================================================
   ICS: 内蔵パーサ
   ========================================================== */

export function unfoldIcsLines(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of normalized.split('\n')) {
    if (line === '') continue;
    if ((line[0] === ' ' || line[0] === '\t') && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

export function splitIcsParams(head) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ';' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const name = (parts.shift() || '').toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).toUpperCase();
    let val = p.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params };
}

export function parseIcsProperty(line) {
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const { name, params } = splitIcsParams(line.slice(0, colon));
  return { name, params, value: line.slice(colon + 1) };
}

export function parseIcsComponents(text) {
  const root = { name: 'ROOT', properties: [], children: [] };
  const stack = [root];
  for (const line of unfoldIcsLines(text)) {
    const prop = parseIcsProperty(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp = { name: prop.value.trim().toUpperCase(), properties: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].properties.push(prop);
    }
  }
  return root;
}

function firstProp(comp, name) {
  return comp.properties.find((p) => p.name === name) || null;
}

function propValue(comp, name) {
  const p = firstProp(comp, name);
  return p ? p.value : null;
}

export function parseIcsDateProp(prop) {
  if (!prop || !prop.value) return { value: null, hasTime: false };
  const isDate = String((prop.params && prop.params.VALUE) || '').toUpperCase() === 'DATE';
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) {
    const dt = new Date(v);
    return Number.isNaN(dt.getTime()) ? { value: null, hasTime: false } : { value: dt.toISOString(), hasTime: true };
  }
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (isDate || hh === undefined) return { value: `${y}-${mo}-${d}`, hasTime: false };
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
    return { value: dt.toISOString(), hasTime: true };
  }
  const dt = new Date(+y, +mo - 1, +d, +hh, +mi, +ss);
  return { value: dt.toISOString(), hasTime: true };
}

export function componentToRaw(comp) {
  const kind = comp.name === 'VEVENT' ? 'event' : 'todo';
  const dueProp =
    firstProp(comp, 'DUE') ||
    (kind === 'event' ? firstProp(comp, 'DTSTART') || firstProp(comp, 'DTEND') : firstProp(comp, 'DTSTART'));
  const due = parseIcsDateProp(dueProp);
  const completed = parseIcsDateProp(firstProp(comp, 'COMPLETED'));
  const status = (propValue(comp, 'STATUS') || '').toUpperCase();
  const categoriesProp = firstProp(comp, 'CATEGORIES');
  return {
    kind,
    uid: propValue(comp, 'UID') || '',
    summary: icsUnescape(propValue(comp, 'SUMMARY') || ''),
    description: icsUnescape(propValue(comp, 'DESCRIPTION') || ''),
    due: due.value,
    dueHasTime: due.hasTime,
    priority: normalizePriority(propValue(comp, 'PRIORITY')),
    done: status === 'COMPLETED',
    completedAt: completed.value,
    categories: categoriesProp ? splitIcsValues(categoriesProp.value).map(icsUnescape) : [],
    rrule: propValue(comp, 'RRULE') || '',
    project: icsUnescape(propValue(comp, 'X-MYAPPS-PROJECT') || ''),
  };
}

export function rawToTask(raw, now = Date.now()) {
  const due = normalizeDue(raw.due, raw.dueHasTime);
  return createTask(
    {
      uid: raw.uid || undefined,
      title: raw.summary || '(無題)',
      notes: raw.description || '',
      due: due.due,
      dueHasTime: due.dueHasTime,
      priority: normalizePriority(raw.priority),
      tags: Array.isArray(raw.categories) ? raw.categories : [],
      project: raw.project || '',
      done: !!raw.done,
      completedAt: raw.completedAt || null,
      repeat: rruleToRepeat(raw.rrule),
      source: raw.kind === 'event' ? 'event' : 'todo',
    },
    now,
  );
}

/** 内蔵パーサ: ICS 文字列 → { name, tasks } */
export function parseIcs(text, now = Date.now()) {
  const root = parseIcsComponents(text);
  const cal = root.children.find((c) => c.name === 'VCALENDAR') || root;
  const tasks = [];
  for (const comp of cal.children) {
    if (comp.name === 'VTODO' || comp.name === 'VEVENT') {
      tasks.push(rawToTask(componentToRaw(comp), now));
    }
  }
  return { name: icsUnescape(propValue(cal, 'X-WR-CALNAME') || ''), tasks };
}

/* ==========================================================
   ICS: ical.js の jCal 変換
   ========================================================== */

function jcalDateProp(prop) {
  if (!prop) return { value: null, hasTime: false };
  const type = String(prop[2] || '');
  let v = prop[3];
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string' || !v) return { value: null, hasTime: false };
  if (type === 'date' || !/[T]/.test(v)) return { value: v.slice(0, 10), hasTime: false };
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? { value: null, hasTime: false } : { value: dt.toISOString(), hasTime: true };
}

export function jcalComponentToRaw(component) {
  const [rawName, props] = component;
  const name = String(rawName).toLowerCase();
  const kind = name === 'vevent' ? 'event' : 'todo';
  const find = (key) => props.find((p) => String(p[0]).toLowerCase() === key) || null;
  const findAll = (key) => props.filter((p) => String(p[0]).toLowerCase() === key);
  const text = (key) => {
    const p = find(key);
    return p && typeof p[3] === 'string' ? p[3] : '';
  };
  const values = (key) => findAll(key).flatMap((p) => p.slice(3)).filter((v) => typeof v === 'string');
  const dueProp =
    find('due') || (kind === 'event' ? find('dtstart') || find('dtend') : find('dtstart'));
  const due = jcalDateProp(dueProp);
  const completed = jcalDateProp(find('completed'));
  const status = String(text('status')).toUpperCase();
  const priorityProp = find('priority');
  const rruleProp = find('rrule');
  return {
    kind,
    uid: text('uid'),
    summary: text('summary'),
    description: text('description'),
    due: due.value,
    dueHasTime: due.hasTime,
    priority: normalizePriority(priorityProp ? priorityProp[3] : 0),
    done: status === 'COMPLETED',
    completedAt: completed.value,
    categories: values('categories'),
    rrule: rruleProp ? rruleProp[3] : '',
    project: text('x-myapps-project'),
  };
}

/** ical.js の jCal → { name, tasks } */
export function jcalToTasks(jcal, now = Date.now()) {
  if (!Array.isArray(jcal) || String(jcal[0]).toLowerCase() !== 'vcalendar') return { name: '', tasks: [] };
  const calProps = Array.isArray(jcal[1]) ? jcal[1] : [];
  const subs = Array.isArray(jcal[2]) ? jcal[2] : [];
  const nameProp = calProps.find((p) => String(p[0]).toLowerCase() === 'x-wr-calname');
  const name = nameProp ? String(nameProp[3]) : '';
  const tasks = [];
  for (const sub of subs) {
    const n = String(sub[0]).toLowerCase();
    if (n === 'vtodo' || n === 'vevent') tasks.push(rawToTask(jcalComponentToRaw(sub), now));
  }
  return { name, tasks };
}

/* ==========================================================
   ICS: 生成
   ========================================================== */

export function formatIcsDue(due, dueHasTime) {
  const dt = dueToDate(due);
  if (!dt) return null;
  if (!dueHasTime) {
    return { value: dateToDateKey(dt).replace(/-/g, ''), param: ';VALUE=DATE' };
  }
  const value =
    `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}` +
    `T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`;
  return { value, param: '' };
}

export function serializeVtodo(task, now = Date.now()) {
  const lines = ['BEGIN:VTODO'];
  lines.push(`UID:${task.uid || task.id || makeUid()}`);
  lines.push(`DTSTAMP:${toIcsStamp(now)}`);
  if (task.createdAt) lines.push(`CREATED:${toIcsStamp(task.createdAt)}`);
  lines.push(`LAST-MODIFIED:${toIcsStamp(task.updatedAt || task.createdAt || now)}`);
  lines.push(`SUMMARY:${icsEscape(task.title || '(無題)')}`);
  if (task.notes) lines.push(`DESCRIPTION:${icsEscape(task.notes)}`);
  const due = formatIcsDue(task.due, task.dueHasTime);
  if (due) lines.push(`DUE${due.param}:${due.value}`);
  if (task.priority > 0) lines.push(`PRIORITY:${task.priority}`);
  lines.push(`STATUS:${task.done ? 'COMPLETED' : 'NEEDS-ACTION'}`);
  if (task.done && task.completedAt) lines.push(`COMPLETED:${toIcsStamp(task.completedAt)}`);
  if (task.tags && task.tags.length) lines.push(`CATEGORIES:${task.tags.map(icsEscape).join(',')}`);
  if (task.project) lines.push(`X-MYAPPS-PROJECT:${icsEscape(task.project)}`);
  const rrule = repeatToRRule(task.repeat);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push('END:VTODO');
  return lines;
}

export function tasksToIcs(tasks, options = {}) {
  const now = options.now ?? Date.now();
  const name = options.name || 'MyApps ToDo';
  const includeCompleted = options.includeCompleted !== false;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyApps//todo-studio//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
  ];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!includeCompleted && task.done) continue;
    lines.push(...serializeVtodo(task, now));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/* ==========================================================
   取り込み
   ========================================================== */

const IMPORTED_FIELDS = [
  'title',
  'notes',
  'due',
  'dueHasTime',
  'priority',
  'tags',
  'project',
  'done',
  'completedAt',
  'repeat',
  'source',
];

/**
 * 外部から取り込んだタスクを状態にマージする。
 * UID が一致するものは更新、なければ追加（重複取り込みを防ぐ）。
 */
export function mergeImportedTasks(state, imported, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const tasks = [...state.tasks];
  let added = 0;
  let updated = 0;
  for (const incoming of Array.isArray(imported) ? imported : []) {
    const task = normalizeTask(incoming);
    const idx = task.uid ? tasks.findIndex((t) => t.uid === task.uid) : -1;
    if (idx >= 0) {
      const patch = { id: tasks[idx].id, uid: tasks[idx].uid, createdAt: tasks[idx].createdAt, updatedAt: iso };
      for (const key of IMPORTED_FIELDS) patch[key] = task[key];
      tasks[idx] = normalizeTask({ ...tasks[idx], ...patch });
      updated += 1;
    } else {
      tasks.push(task);
      added += 1;
    }
  }
  return { state: { ...state, tasks, updatedAt: iso }, added, updated };
}

/* ==========================================================
   ファイル名 / 入力判定
   ========================================================== */

export function isSupportedIcsFile(file) {
  if (!file) return false;
  const name = typeof file === 'string' ? file : file.name;
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return ICS_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function buildIcsFileName(now = Date.now()) {
  const d = toDate(now) || new Date();
  return `todo-${dateToDateKey(d).replace(/-/g, '')}.ics`;
}

export function isSupportedTaskFile(file) {
  if (!file) return false;
  const name = typeof file === 'string' ? file : file.name;
  if (typeof name !== 'string') return false;
  return name.toLowerCase().endsWith('.json');
}
