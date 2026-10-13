/**
 * script.js — ToDo スタジオの UI
 *
 * 純ロジックは pipeline.mjs に置き、ここでは DOM / localStorage / fetch を扱う。
 * ICS の解釈は ical.js (MPL-2.0, jsdelivr から版固定で動的 import) を第一候補にし、
 * 読み込めない場合は pipeline.mjs の内蔵パーサに退避する。
 */

import {
  STATE_KEY,
  SUMMARY_HANDOFF_KEY,
  ICAL_MODULE_URL,
  ICS_MIME,
  PRIORITY_LEVELS,
  REPEAT_OPTIONS,
  createState,
  deserializeState,
  serializeState,
  stateByteSize,
  addTask,
  updateTask,
  removeTask,
  toggleTaskDone,
  findTask,
  selectTasks,
  countByBucket,
  groupForKanban,
  collectTags,
  collectProjects,
  dueStatus,
  formatDueLabel,
  priorityLabel,
  repeatLabel,
  normalizeTags,
  buildTodaySummary,
  tasksToIcs,
  parseIcs,
  jcalToTasks,
  mergeImportedTasks,
  buildIcsFileName,
  isSupportedIcsFile,
  formatBytes,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  newTaskBtn: $('new-task-btn'),
  copyTodayBtn: $('copy-today-btn'),
  copyStatus: $('copy-status'),
  taskForm: $('task-form'),
  formTitle: $('form-title'),
  formEl: $('task-form-el'),
  fTitle: $('f-title'),
  fNotes: $('f-notes'),
  fDue: $('f-due'),
  fTime: $('f-time'),
  fPriority: $('f-priority'),
  fTags: $('f-tags'),
  fProject: $('f-project'),
  fRepeat: $('f-repeat'),
  fCancel: $('f-cancel'),
  projectOptions: $('project-options'),
  viewNav: $('view-nav'),
  countToday: $('count-today'),
  countWeek: $('count-week'),
  countOverdue: $('count-overdue'),
  countAll: $('count-all'),
  countDone: $('count-done'),
  search: $('search-input'),
  tagFilter: $('tag-filter'),
  projectFilter: $('project-filter'),
  sortSelect: $('sort-select'),
  showDone: $('show-done'),
  importFile: $('import-file'),
  importText: $('import-text'),
  importTextBtn: $('import-text-btn'),
  importUrl: $('import-url'),
  importUrlBtn: $('import-url-btn'),
  importStatus: $('import-status'),
  exportBtn: $('export-btn'),
  listTitle: $('list-title'),
  listMeta: $('list-meta'),
  toggleKanbanBtn: $('toggle-kanban-btn'),
  taskList: $('task-list'),
  kanban: $('kanban'),
  taskEmpty: $('task-empty'),
};

const ICON_EDIT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_TRASH =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const VIEW_LABELS = { today: '今日', week: '今週', overdue: '期限切れ', all: 'すべて', done: '完了' };

let state = createState();
let editingId = null;
let kanbanView = false;
let currentView = 'today';

/* ==========================================================
   初期化
   ========================================================== */

function loadState() {
  try {
    const text = localStorage.getItem(STATE_KEY);
    return text ? deserializeState(text) : createState();
  } catch {
    return createState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, serializeState(state));
  } catch (e) {
    setImportStatus(`保存に失敗しました: ${e.message}`);
  }
}

function setImportStatus(text) {
  if (els.importStatus) els.importStatus.textContent = text;
}

function setCopyStatus(text) {
  if (els.copyStatus) els.copyStatus.textContent = text;
}

/* ==========================================================
   ユーティリティ
   ========================================================== */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localDateKey(due) {
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function localTimeValue(due) {
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ==========================================================
   選択コントロールの描画
   ========================================================== */

function fillSelect(select, options, value) {
  select.innerHTML = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (String(opt.value) === String(value)) o.selected = true;
    select.appendChild(o);
  }
}

function renderOptions() {
  fillSelect(
    els.fPriority,
    PRIORITY_LEVELS.map((p) => ({ value: p.value, label: p.label })),
    els.fPriority.value || 0,
  );
  fillSelect(
    els.fRepeat,
    REPEAT_OPTIONS.map((r) => ({ value: r.id, label: r.label })),
    els.fRepeat.value || 'none',
  );

  const tags = collectTags(state.tasks);
  fillSelect(els.tagFilter, [{ value: '', label: 'すべてのタグ' }, ...tags.map((t) => ({ value: t, label: t }))], els.tagFilter.value);
  const projects = collectProjects(state.tasks);
  fillSelect(
    els.projectFilter,
    [{ value: '', label: 'すべてのプロジェクト' }, ...projects.map((p) => ({ value: p, label: p }))],
    els.projectFilter.value,
  );

  els.projectOptions.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p;
    els.projectOptions.appendChild(o);
  }
}

/* ==========================================================
   集計の表示
   ========================================================== */

function renderCounts() {
  const now = Date.now();
  const opts = { now };
  els.countToday.textContent = String(selectTasks(state.tasks, { ...opts, view: 'today' }).length);
  els.countWeek.textContent = String(selectTasks(state.tasks, { ...opts, view: 'week' }).length);
  const counts = countByBucket(state.tasks, now);
  els.countOverdue.textContent = String(counts.overdue);
  els.countAll.textContent = String(selectTasks(state.tasks, { ...opts, view: 'all' }).length);
  els.countDone.textContent = String(counts.done);
}

/* ==========================================================
   タスクの描画
   ========================================================== */

function taskMetaHtml(task, now) {
  const status = dueStatus(task.due, now);
  const parts = [];
  if (task.due) {
    const highlight = status === 'overdue' || status === 'today' || status === 'tomorrow' ? ' due-hot' : '';
    parts.push(`<span class="due due-${status}${highlight}">${escapeHtml(formatDueLabel(task.due, task.dueHasTime, now))}</span>`);
  } else {
    parts.push('<span class="due due-none">期限なし</span>');
  }
  if (task.priority > 0) {
    parts.push(`<span class="chip prio prio-${task.priority}">優先度 ${escapeHtml(priorityLabel(task.priority))}</span>`);
  }
  if (task.repeat !== 'none') {
    parts.push(`<span class="chip repeat">${escapeHtml(repeatLabel(task.repeat))}</span>`);
  }
  if (task.project) parts.push(`<span class="chip project">${escapeHtml(task.project)}</span>`);
  for (const tag of task.tags || []) parts.push(`<span class="chip tag">${escapeHtml(tag)}</span>`);
  if (task.source === 'event') parts.push('<span class="chip source">ICS から取り込み</span>');
  return parts.join('');
}

function taskItem(task) {
  const now = Date.now();
  const li = document.createElement('li');
  li.className = `task-item is-${dueStatus(task.due, now)}${task.done ? ' is-done' : ''}`;
  li.dataset.id = task.id;
  li.innerHTML =
    `<label class="task-check"><input type="checkbox" data-action="toggle"${task.done ? ' checked' : ''} aria-label="完了" /></label>` +
    '<div class="task-body">' +
    `<div class="task-title">${escapeHtml(task.title || '(無題)')}</div>` +
    (task.notes ? `<div class="task-notes">${escapeHtml(task.notes)}</div>` : '') +
    `<div class="task-meta">${taskMetaHtml(task, now)}</div>` +
    '</div>' +
    '<div class="task-actions">' +
    `<button class="btn-icon" type="button" data-action="edit" title="編集" aria-label="編集">${ICON_EDIT}</button>` +
    `<button class="btn-icon danger" type="button" data-action="delete" title="削除" aria-label="削除">${ICON_TRASH}</button>` +
    '</div>';
  return li;
}

function filteredTasks() {
  return selectTasks(state.tasks, {
    view: currentView,
    tag: els.tagFilter.value,
    project: els.projectFilter.value,
    query: els.search.value,
    includeDone: currentView === 'done' ? false : els.showDone.checked,
    now: Date.now(),
  });
}

function renderList() {
  const tasks = filteredTasks();
  const sorted = els.sortSelect.value === 'due' && currentView !== 'done'
    ? tasks
    : sortBySelection(tasks);

  els.listTitle.textContent = VIEW_LABELS[currentView] || 'タスク';
  const sizeText = formatBytes(stateByteSize(state));
  els.listMeta.textContent = `${sorted.length} 件 — 保存 ${sizeText}`;

  if (kanbanView) {
    els.taskList.hidden = true;
    els.taskEmpty.hidden = true;
    els.kanban.hidden = false;
    renderKanban(sorted);
  } else {
    els.kanban.hidden = true;
    els.taskList.hidden = false;
    els.taskList.innerHTML = '';
    if (!sorted.length) {
      els.taskEmpty.hidden = false;
    } else {
      els.taskEmpty.hidden = true;
      for (const t of sorted) els.taskList.appendChild(taskItem(t));
    }
  }
}

function sortBySelection(tasks) {
  const mode = els.sortSelect.value;
  if (mode === 'due' || mode === 'priority' || mode === 'title' || mode === 'created') {
    // selectTasks は期限順なので、他の並びはここで並べ替える
    const list = [...tasks];
    if (mode === 'priority') {
      list.sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.title.localeCompare(b.title, 'ja'));
    } else if (mode === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    } else if (mode === 'created') {
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }
    return list;
  }
  return tasks;
}

function renderKanban(tasks) {
  const columns = groupForKanban(tasks, Date.now());
  els.kanban.innerHTML = '';
  for (const col of columns) {
    const section = document.createElement('section');
    section.className = 'kanban-col';
    section.innerHTML =
      `<header class="kanban-head"><h3>${escapeHtml(col.title)}</h3><span class="count">${col.tasks.length}</span></header>` +
      `<p class="kanban-hint">${escapeHtml(col.hint)}</p>`;
    const ul = document.createElement('ul');
    ul.className = 'task-list kanban-list';
    for (const t of col.tasks) ul.appendChild(taskItem(t));
    section.appendChild(ul);
    els.kanban.appendChild(section);
  }
}

function render() {
  renderOptions();
  renderCounts();
  renderList();
}

/* ==========================================================
   フォーム
   ========================================================== */

function openForm(task) {
  editingId = task ? task.id : null;
  els.formTitle.textContent = task ? 'タスクを編集' : '新しいタスク';
  els.fTitle.value = task ? task.title : '';
  els.fNotes.value = task ? task.notes : '';
  els.fDue.value = task && task.due ? (task.dueHasTime ? localDateKey(task.due) : task.due) : '';
  els.fTime.value = task && task.dueHasTime ? localTimeValue(task.due) : '';
  els.fPriority.value = String(task ? task.priority : 0);
  els.fTags.value = task ? (task.tags || []).join(', ') : '';
  els.fProject.value = task ? task.project : '';
  els.fRepeat.value = task ? task.repeat : 'none';
  els.taskForm.hidden = false;
  els.fTitle.focus();
}

function closeForm() {
  editingId = null;
  els.taskForm.hidden = true;
}

function handleSubmit(event) {
  event.preventDefault();
  const title = els.fTitle.value.trim();
  if (!title) return;

  const dateVal = els.fDue.value;
  const timeVal = els.fTime.value;
  let due = null;
  let dueHasTime = false;
  if (dateVal && timeVal) {
    const d = new Date(`${dateVal}T${timeVal}`);
    if (!Number.isNaN(d.getTime())) {
      due = d.toISOString();
      dueHasTime = true;
    }
  } else if (dateVal) {
    due = dateVal;
    dueHasTime = false;
  }

  const patch = {
    title,
    notes: els.fNotes.value.trim(),
    due,
    dueHasTime,
    priority: Number(els.fPriority.value),
    tags: normalizeTags(els.fTags.value),
    project: els.fProject.value.trim(),
    repeat: els.fRepeat.value,
  };

  if (editingId) {
    state = updateTask(state, editingId, patch, Date.now());
  } else {
    state = addTask(state, patch, Date.now());
  }
  saveState();
  closeForm();
  render();
}

/* ==========================================================
   タスク操作
   ========================================================== */

function handleTaskAction(id, action, element) {
  const task = findTask(state, id);
  if (!task) return;
  if (action === 'toggle') {
    state = toggleTaskDone(state, id, Date.now());
    saveState();
    render();
  } else if (action === 'edit') {
    openForm(task);
  } else if (action === 'delete') {
    if (element && element.dataset && element.dataset.confirm !== '1') {
      element.dataset.confirm = '1';
      element.classList.add('is-confirm');
      element.title = 'もう一度押すと削除';
      return;
    }
    state = removeTask(state, id);
    saveState();
    render();
  }
}

function bindTaskEvents(container) {
  container.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    const li = event.target.closest('.task-item');
    if (!li) return;
    if (btn) {
      event.preventDefault();
      handleTaskAction(li.dataset.id, btn.dataset.action, btn);
    }
  });
  container.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-action="toggle"]');
    if (!input) return;
    const li = event.target.closest('.task-item');
    if (li) handleTaskAction(li.dataset.id, 'toggle');
  });
}

/* ==========================================================
   ICS
   ========================================================== */

let icalModule;

async function loadIcal() {
  if (icalModule !== undefined) return icalModule;
  try {
    const mod = await import(ICAL_MODULE_URL);
    icalModule = mod.default || mod;
  } catch {
    icalModule = null;
  }
  return icalModule;
}

async function parseIcsText(text) {
  const ICAL = await loadIcal();
  if (ICAL && typeof ICAL.parse === 'function') {
    try {
      return jcalToTasks(ICAL.parse(text), Date.now());
    } catch {
      // 内蔵パーサに退避
    }
  }
  return parseIcs(text, Date.now());
}

async function importIcsText(text, sourceLabel) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    setImportStatus('ICS が空です。');
    return;
  }
  try {
    const parsed = await parseIcsText(trimmed);
    if (!parsed.tasks.length) {
      setImportStatus('VTODO / VEVENT が見つかりませんでした。');
      return;
    }
    const result = mergeImportedTasks(state, parsed.tasks, Date.now());
    state = result.state;
    saveState();
    render();
    const cal = parsed.name ? ` (${parsed.name})` : '';
    setImportStatus(`${sourceLabel}: ${parsed.tasks.length} 件を読み取り、追加 ${result.added} / 更新 ${result.updated}${cal}`);
  } catch (e) {
    setImportStatus(`取り込みに失敗しました: ${e.message}`);
  }
}

async function importFromUrl() {
  const url = els.importUrl.value.trim();
  if (!url) {
    setImportStatus('URL を入力してください。');
    return;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    setImportStatus('URL の形式が正しくありません。');
    return;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    setImportStatus('http(s) の URL のみ対応します。');
    return;
  }
  setImportStatus('取得中…');
  try {
    const res = await fetch(parsedUrl.href, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await importIcsText(text, 'URL');
  } catch (e) {
    setImportStatus(`取得に失敗しました (CORS の可能性もあります): ${e.message}`);
  }
}

function exportIcs() {
  const ics = tasksToIcs(state.tasks, { name: 'MyApps ToDo', now: Date.now() });
  const blob = new Blob([ics], { type: `${ICS_MIME};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildIcsFileName(Date.now());
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setImportStatus(`${state.tasks.length} 件を ${a.download} として書き出しました。`);
}

/* ==========================================================
   今日をコピー
   ========================================================== */

async function copyToday() {
  const text = buildTodaySummary(state.tasks, Date.now());
  try {
    await navigator.clipboard.writeText(text);
    setCopyStatus(`コピーしました: ${text}`);
  } catch {
    try {
      sessionStorage.setItem(SUMMARY_HANDOFF_KEY, text);
    } catch {
      /* noop */
    }
    setCopyStatus(`コピーできませんでした (手動で選択してください): ${text}`);
  }
}

/* ==========================================================
   イベント登録
   ========================================================== */

function init() {
  state = loadState();

  els.newTaskBtn.addEventListener('click', () => openForm(null));
  els.fCancel.addEventListener('click', closeForm);
  els.formEl.addEventListener('submit', handleSubmit);

  els.viewNav.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-view]');
    if (!btn) return;
    currentView = btn.dataset.view;
    els.viewNav.querySelectorAll('button[data-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
    render();
  });

  els.search.addEventListener('input', render);
  els.tagFilter.addEventListener('change', render);
  els.projectFilter.addEventListener('change', render);
  els.sortSelect.addEventListener('change', render);
  els.showDone.addEventListener('change', render);

  els.toggleKanbanBtn.addEventListener('click', () => {
    kanbanView = !kanbanView;
    els.toggleKanbanBtn.textContent = kanbanView ? 'リスト' : 'カンバン';
    render();
  });

  els.importFile.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!isSupportedIcsFile(file)) {
      setImportStatus('.ics ファイルを選んでください。');
      return;
    }
    try {
      const text = await file.text();
      await importIcsText(text, file.name);
    } catch (e) {
      setImportStatus(`読み込みに失敗しました: ${e.message}`);
    } finally {
      event.target.value = '';
    }
  });
  els.importTextBtn.addEventListener('click', () => importIcsText(els.importText.value, '貼り付け'));
  els.importUrlBtn.addEventListener('click', importFromUrl);
  els.exportBtn.addEventListener('click', exportIcs);
  els.copyTodayBtn.addEventListener('click', copyToday);

  bindTaskEvents(els.taskList);
  bindTaskEvents(els.kanban);

  // 文字サイズ・保存量の目安を表示
  const bytes = stateByteSize(state);
  if (bytes > 0) setImportStatus(`保存済み ${state.tasks.length} 件 (${formatBytes(bytes)})`);

  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
