import test from 'node:test';
import assert from 'node:assert/strict';

import {
  // 定数
  STATE_KEY,
  LIBRARY_CDN_HOST,
  ICAL_MODULE_URL,
  PRIORITY_LEVELS,
  REPEAT_OPTIONS,
  // 日付
  startOfDay,
  dayDiff,
  dueToDate,
  dateToDateKey,
  normalizeDue,
  dueStatus,
  isOverdue,
  isDueToday,
  isDueSoon,
  isDueHighlight,
  formatRelativeDue,
  formatDueLabel,
  formatDate,
  formatDateTime,
  // 優先度
  normalizePriority,
  priorityLabel,
  priorityRank,
  // 繰り返し
  repeatLabel,
  repeatToRRule,
  rruleToRepeat,
  nextDue,
  // モデル
  createTask,
  normalizeTask,
  normalizeTags,
  // 選択・集計
  sortTasks,
  selectTasks,
  countByBucket,
  groupForKanban,
  groupByTag,
  groupByProject,
  collectTags,
  collectProjects,
  buildTodaySummary,
  // 状態
  createState,
  findTask,
  addTask,
  updateTask,
  removeTask,
  toggleTaskDone,
  clearCompleted,
  normalizeState,
  serializeState,
  deserializeState,
  stateByteSize,
  // ICS
  icsEscape,
  icsUnescape,
  splitIcsValues,
  foldIcsLine,
  unfoldIcsLines,
  parseIcsProperty,
  parseIcsComponents,
  parseIcsDateProp,
  componentToRaw,
  parseIcs,
  jcalToTasks,
  formatIcsDue,
  serializeVtodo,
  tasksToIcs,
  mergeImportedTasks,
  isSupportedIcsFile,
  isSupportedTaskFile,
  buildIcsFileName,
  formatBytes,
  makeUid,
} from '../pipeline.mjs';

/* 基準時刻: 2026-10-13 (火) 12:00 ローカル */
const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();

/* ==========================================================
   定数
   ========================================================== */

test('定数', () => {
  assert.equal(STATE_KEY, 'myapps:todo-studio:state:v1');
  assert.equal(LIBRARY_CDN_HOST, 'cdn.jsdelivr.net');
  assert.match(ICAL_MODULE_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/ical\.js@\d+\.\d+\.\d+\/dist\//);
  assert.ok(PRIORITY_LEVELS.length >= 5);
  assert.deepEqual(REPEAT_OPTIONS.map((o) => o.id), ['none', 'daily', 'weekly', 'monthly']);
});

/* ==========================================================
   日付
   ========================================================== */

test('dayDiff は暦日で数える', () => {
  assert.equal(dayDiff(new Date(2026, 9, 13, 23, 0), new Date(2026, 9, 13, 1, 0)), 0);
  assert.equal(dayDiff(new Date(2026, 9, 14), new Date(2026, 9, 13)), 1);
  assert.equal(dayDiff(new Date(2026, 9, 11), new Date(2026, 9, 13)), -2);
});

test('startOfDay は 0 時になる', () => {
  const d = startOfDay(new Date(2026, 9, 13, 15, 30));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('normalizeDue: 終日と時刻あり', () => {
  assert.deepEqual(normalizeDue('2026-10-20'), { due: '2026-10-20', dueHasTime: false });
  const dt = normalizeDue('2026-10-20T09:00:00.000Z', true);
  assert.equal(dt.dueHasTime, true);
  assert.ok(dt.due.endsWith('Z'));
  assert.deepEqual(normalizeDue(''), { due: null, dueHasTime: false });
  assert.deepEqual(normalizeDue('not a date'), { due: null, dueHasTime: false });
});

test('dueToDate / dateToDateKey', () => {
  const d = dueToDate('2026-10-20');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 20);
  assert.equal(dateToDateKey(d), '2026-10-20');
});

test('dueStatus は overdue/today/tomorrow/week/later/none', () => {
  assert.equal(dueStatus(null, NOW), 'none');
  assert.equal(dueStatus('2026-10-12', NOW), 'overdue');
  assert.equal(dueStatus('2026-10-13', NOW), 'today');
  assert.equal(dueStatus('2026-10-14', NOW), 'tomorrow');
  assert.equal(dueStatus('2026-10-19', NOW), 'week');
  assert.equal(dueStatus('2026-10-30', NOW), 'later');
});

test('isOverdue / isDueToday / isDueSoon / isDueHighlight', () => {
  assert.equal(isOverdue('2026-10-12', NOW), true);
  assert.equal(isDueToday('2026-10-13', NOW), true);
  assert.equal(isDueSoon('2026-10-14', NOW), true);
  assert.equal(isDueSoon('2026-10-16', NOW), false);
  assert.equal(isDueHighlight('2026-10-14', NOW), true);
  assert.equal(isDueHighlight('2026-10-20', NOW), false);
});

test('formatRelativeDue', () => {
  assert.equal(formatRelativeDue(null, NOW), '期限なし');
  assert.equal(formatRelativeDue('2026-10-13', NOW), '今日');
  assert.equal(formatRelativeDue('2026-10-14', NOW), '明日');
  assert.equal(formatRelativeDue('2026-10-12', NOW), '昨日');
  assert.equal(formatRelativeDue('2026-10-10', NOW), '3日前');
  assert.equal(formatRelativeDue('2026-10-16', NOW), '3日後');
  assert.equal(formatRelativeDue('2026-10-25', NOW), '10/25');
});

test('formatDueLabel / formatDate / formatDateTime', () => {
  assert.equal(formatDueLabel(null, false, NOW), '期限なし');
  assert.equal(formatDueLabel('2026-10-13', false, NOW), '今日');
  assert.match(formatDueLabel(new Date(2026, 9, 13, 9, 30).toISOString(), true, NOW), /^今日 09:30$/);
  assert.equal(formatDate(new Date(2026, 9, 13)), '2026/10/13');
  assert.equal(formatDateTime(new Date(2026, 9, 13, 7, 5)), '2026/10/13 07:05');
});

/* ==========================================================
   優先度
   ========================================================== */

test('normalizePriority / priorityLabel / priorityRank', () => {
  assert.equal(normalizePriority('3'), 3);
  assert.equal(normalizePriority(42), 9);
  assert.equal(normalizePriority(-2), 0);
  assert.equal(normalizePriority(undefined), 0);
  assert.equal(priorityLabel(0), 'なし');
  assert.equal(priorityLabel(1), '最高');
  assert.equal(priorityLabel(9), '最低');
  assert.equal(priorityRank(1), 0);
  assert.equal(priorityRank(0), 5);
});

/* ==========================================================
   繰り返し
   ========================================================== */

test('repeatLabel / repeatToRRule / rruleToRepeat', () => {
  assert.equal(repeatLabel('weekly'), '毎週');
  assert.equal(repeatToRRule('daily'), 'FREQ=DAILY');
  assert.equal(repeatToRRule('none'), null);
  assert.equal(rruleToRepeat('FREQ=MONTHLY;INTERVAL=1'), 'monthly');
  assert.equal(rruleToRepeat({ freq: 'WEEKLY' }), 'weekly');
  assert.equal(rruleToRepeat('FREQ=YEARLY'), 'none');
  assert.equal(rruleToRepeat(''), 'none');
});

test('nextDue は繰り返しを進める（月末クランプ付き）', () => {
  assert.deepEqual(nextDue('2026-01-31', false, 'monthly'), { due: '2026-02-28', dueHasTime: false });
  assert.deepEqual(nextDue('2026-10-13', false, 'daily'), { due: '2026-10-14', dueHasTime: false });
  assert.deepEqual(nextDue('2026-10-13', false, 'weekly'), { due: '2026-10-20', dueHasTime: false });
  assert.deepEqual(nextDue('2026-10-13', false, 'none'), { due: '2026-10-13', dueHasTime: false });
  const dt = nextDue('2026-10-20T00:00:00.000Z', true, 'daily');
  assert.equal(dt.due, '2026-10-21T00:00:00.000Z');
  assert.equal(dt.dueHasTime, true);
});

/* ==========================================================
   モデル
   ========================================================== */

test('normalizeTags は重複と空を除く', () => {
  assert.deepEqual(normalizeTags(['a', 'a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(normalizeTags('x, y ,x'), ['x', 'y']);
  assert.deepEqual(normalizeTags(null), []);
});

test('createTask は既定値と UID を持つ', () => {
  const t = createTask({ title: 'レポート' }, NOW);
  assert.equal(t.title, 'レポート');
  assert.ok(t.id);
  assert.match(t.uid, /@myapps\.local$/);
  assert.equal(t.priority, 0);
  assert.equal(t.done, false);
  assert.equal(t.repeat, 'none');
  assert.equal(t.due, null);
  assert.equal(t.createdAt, new Date(NOW).toISOString());
});

test('normalizeTask は不正値を補正する', () => {
  const t = normalizeTask({ title: 'x', priority: 99, repeat: 'yearly', tags: 'a,b', due: '2026-10-13' });
  assert.equal(t.priority, 9);
  assert.equal(t.repeat, 'none');
  assert.deepEqual(t.tags, ['a', 'b']);
  assert.equal(t.due, '2026-10-13');
  assert.ok(makeUid() !== makeUid());
});

/* ==========================================================
   選択・集計
   ========================================================== */

function sampleTasks() {
  return [
    createTask({ title: '期限切れ課題', due: '2026-10-10', priority: 1, tags: ['学務'], project: '大学' }, NOW),
    createTask({ title: '今日の課題', due: '2026-10-13', priority: 5, tags: ['学務'], project: '大学' }, NOW),
    createTask({ title: '今週の課題', due: '2026-10-17' }, NOW),
    createTask({ title: '来月の課題', due: '2026-11-01' }, NOW),
    createTask({ title: '期限なし' }, NOW),
    createTask({ title: '完了済み', due: '2026-10-11', done: true, completedAt: new Date(NOW).toISOString() }, NOW),
  ];
}

test('selectTasks のビュー', () => {
  const tasks = sampleTasks();
  const today = selectTasks(tasks, { view: 'today', now: NOW }).map((t) => t.title);
  assert.deepEqual(today, ['期限切れ課題', '今日の課題']);
  const overdue = selectTasks(tasks, { view: 'overdue', now: NOW }).map((t) => t.title);
  assert.deepEqual(overdue, ['期限切れ課題']);
  const week = selectTasks(tasks, { view: 'week', now: NOW }).map((t) => t.title);
  assert.deepEqual(week, ['期限切れ課題', '今日の課題', '今週の課題']);
  const all = selectTasks(tasks, { view: 'all', now: NOW }).map((t) => t.title);
  assert.equal(all.includes('完了済み'), false);
  assert.equal(all.length, 5);
  const done = selectTasks(tasks, { view: 'done', now: NOW }).map((t) => t.title);
  assert.deepEqual(done, ['完了済み']);
});

test('selectTasks のタグ / プロジェクト / 検索', () => {
  const tasks = sampleTasks();
  const byTag = selectTasks(tasks, { view: 'all', tag: '学務', now: NOW }).map((t) => t.title);
  assert.deepEqual(byTag, ['期限切れ課題', '今日の課題']);
  const byProject = selectTasks(tasks, { view: 'all', project: '大学', now: NOW }).map((t) => t.title);
  assert.deepEqual(byProject, ['期限切れ課題', '今日の課題']);
  const search = selectTasks(tasks, { view: 'all', query: '来月', now: NOW }).map((t) => t.title);
  assert.deepEqual(search, ['来月の課題']);
});

test('sortTasks は期限→優先度→タイトル', () => {
  const tasks = sampleTasks().filter((t) => !t.done);
  const sorted = sortTasks(tasks, 'due', NOW).map((t) => t.title);
  assert.equal(sorted[0], '期限切れ課題');
  assert.equal(sorted[sorted.length - 1], '期限なし');
});

test('countByBucket', () => {
  const c = countByBucket(sampleTasks(), NOW);
  assert.equal(c.overdue, 1);
  assert.equal(c.today, 1);
  assert.equal(c.week, 1);
  assert.equal(c.later, 1);
  assert.equal(c.none, 1);
  assert.equal(c.done, 1);
});

test('groupForKanban は 3 列に分ける', () => {
  const cols = groupForKanban(sampleTasks(), NOW);
  assert.deepEqual(cols.map((c) => c.id), ['now', 'later', 'done']);
  const now = cols.find((c) => c.id === 'now').tasks.map((t) => t.title);
  assert.deepEqual(now, ['期限切れ課題', '今日の課題']);
  assert.deepEqual(cols.find((c) => c.id === 'done').tasks.map((t) => t.title), ['完了済み']);
  assert.equal(cols.find((c) => c.id === 'later').tasks.length, 3);
});

test('groupByTag / groupByProject / collect', () => {
  const tasks = sampleTasks();
  const tags = groupByTag(tasks).map((g) => g.key);
  assert.ok(tags.includes('学務'));
  assert.ok(tags.includes('(タグなし)'));
  const projects = groupByProject(tasks).map((g) => g.key);
  assert.ok(projects.includes('大学'));
  assert.deepEqual(collectTags(tasks), ['学務']);
  assert.deepEqual(collectProjects(tasks), ['大学']);
});

test('buildTodaySummary は 1 行にまとめる', () => {
  const text = buildTodaySummary(sampleTasks(), NOW);
  assert.match(text, /^\[ToDo\] 今日 1件 \/ 期限切れ 1件: 期限切れ課題 \/ 今日の課題$/);
  const empty = buildTodaySummary([createTask({ title: 'x' }, NOW)], NOW);
  assert.equal(empty, '[ToDo] 今日 0件');
});

/* ==========================================================
   状態
   ========================================================== */

test('状態の操作', () => {
  let state = createState();
  assert.deepEqual(state.tasks, []);
  state = addTask(state, { title: 'A', due: '2026-10-13' }, NOW);
  state = addTask(state, { title: 'B' }, NOW);
  assert.equal(state.tasks.length, 2);
  const idA = state.tasks[0].id;
  assert.ok(findTask(state, idA));
  state = updateTask(state, idA, { title: 'A2', priority: 3 }, NOW);
  assert.equal(findTask(state, idA).title, 'A2');
  assert.equal(findTask(state, idA).priority, 3);
  state = toggleTaskDone(state, idA, NOW);
  assert.equal(findTask(state, idA).done, true);
  assert.ok(findTask(state, idA).completedAt);
  state = clearCompleted(state);
  assert.equal(state.tasks.length, 1);
  state = removeTask(state, state.tasks[0].id);
  assert.equal(state.tasks.length, 0);
});

test('繰り返しタスクの完了は次回へ進む', () => {
  let state = createState();
  state = addTask(state, { title: '日課', due: '2026-10-13', repeat: 'daily' }, NOW);
  const id = state.tasks[0].id;
  state = toggleTaskDone(state, id, NOW);
  const t = findTask(state, id);
  assert.equal(t.done, false);
  assert.equal(t.due, '2026-10-14');
  assert.ok(t.lastCompletedAt);
});

test('serialize / deserialize / normalizeState / byteSize', () => {
  let state = createState();
  state = addTask(state, { title: 'A', due: '2026-10-13', tags: ['x'] }, NOW);
  const text = serializeState(state);
  const back = deserializeState(text);
  assert.equal(back.tasks.length, 1);
  assert.equal(back.tasks[0].title, 'A');
  assert.equal(stateByteSize(state) > 0, true);
  assert.deepEqual(deserializeState('not json').tasks, []);
  assert.deepEqual(normalizeState(null).tasks, []);
  assert.equal(normalizeState({ tasks: [null, 'x', { title: 'ok' }] }).tasks.length, 3);
});

/* ==========================================================
   ICS ヘルパー
   ========================================================== */

test('icsEscape / icsUnescape', () => {
  const raw = 'a;b,c\\d\ne';
  const esc = icsEscape(raw);
  assert.equal(esc, 'a\\;b\\,c\\\\d\\ne');
  assert.equal(icsUnescape(esc), raw);
});

test('splitIcsValues は未エスケープのカンマで分割', () => {
  assert.deepEqual(splitIcsValues('study,cs,math'), ['study', 'cs', 'math']);
  assert.deepEqual(splitIcsValues('a\\,b,c'), ['a\\,b', 'c']);
});

test('foldIcsLine / unfoldIcsLines', () => {
  const long = 'SUMMARY:' + 'あ'.repeat(80);
  const folded = foldIcsLine(long);
  assert.ok(folded.includes('\r\n '));
  const unfolded = unfoldIcsLines(`BEGIN:VTODO\r\n${folded}\r\nEND:VTODO`);
  assert.equal(unfolded[1], long);
});

test('parseIcsProperty はパラメータ付きプロパティを読む', () => {
  const p = parseIcsProperty('DUE;VALUE=DATE:20261020');
  assert.equal(p.name, 'DUE');
  assert.equal(p.params.VALUE, 'DATE');
  assert.equal(p.value, '20261020');
  const q = parseIcsProperty('SUMMARY;LANGUAGE="ja":こんにちは');
  assert.equal(q.params.LANGUAGE, 'ja');
  assert.equal(q.value, 'こんにちは');
});

test('parseIcsComponents は入れ子を読む', () => {
  const root = parseIcsComponents(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', 'UID:a', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'));
  assert.equal(root.children[0].name, 'VCALENDAR');
  assert.equal(root.children[0].children[0].name, 'VTODO');
});

test('parseIcsDateProp: DATE と DATE-TIME(Z)', () => {
  assert.deepEqual(parseIcsDateProp({ params: { VALUE: 'DATE' }, value: '20261020' }), {
    value: '2026-10-20',
    hasTime: false,
  });
  assert.deepEqual(parseIcsDateProp({ params: {}, value: '20261020T090000Z' }), {
    value: '2026-10-20T09:00:00.000Z',
    hasTime: true,
  });
  const floating = parseIcsDateProp({ params: {}, value: '20261020T090000' });
  assert.equal(floating.hasTime, true);
  assert.equal(new Date(floating.value).getHours(), 9);
});

/* ==========================================================
   ICS パース（内蔵）
   ========================================================== */

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Moodle//Test//JA',
  'X-WR-CALNAME:課題',
  'BEGIN:VTODO',
  'UID:todo-1',
  'SUMMARY:レポート提出 \\; 第1回',
  'DESCRIPTION:3000字以上\\n参考文献を付ける',
  'DUE;VALUE=DATE:20261020',
  'PRIORITY:1',
  'STATUS:NEEDS-ACTION',
  'CATEGORIES:学務,課題',
  'RRULE:FREQ=WEEKLY',
  'END:VTODO',
  'BEGIN:VTODO',
  'UID:todo-2',
  'SUMMARY:終わった課題',
  'DUE:20261011T090000Z',
  'STATUS:COMPLETED',
  'COMPLETED:20261011T100000Z',
  'END:VTODO',
  'BEGIN:VEVENT',
  'UID:event-1',
  'SUMMARY:締切: 小テスト',
  'DTSTART:20261025T235900Z',
  'DTEND:20261025T235900Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseIcs は VTODO と VEVENT を読む', () => {
  const { name, tasks } = parseIcs(SAMPLE_ICS, NOW);
  assert.equal(name, '課題');
  assert.equal(tasks.length, 3);

  const t1 = tasks[0];
  assert.equal(t1.uid, 'todo-1');
  assert.equal(t1.title, 'レポート提出 ; 第1回');
  assert.equal(t1.notes, '3000字以上\n参考文献を付ける');
  assert.equal(t1.due, '2026-10-20');
  assert.equal(t1.dueHasTime, false);
  assert.equal(t1.priority, 1);
  assert.deepEqual(t1.tags, ['学務', '課題']);
  assert.equal(t1.repeat, 'weekly');
  assert.equal(t1.done, false);
  assert.equal(t1.source, 'todo');

  const t2 = tasks[1];
  assert.equal(t2.done, true);
  assert.equal(t2.due, '2026-10-11T09:00:00.000Z');
  assert.equal(t2.completedAt, '2026-10-11T10:00:00.000Z');

  const t3 = tasks[2];
  assert.equal(t3.source, 'event');
  assert.equal(t3.title, '締切: 小テスト');
  assert.equal(t3.due, '2026-10-25T23:59:00.000Z');
});

test('parseIcs は空文字で空を返す', () => {
  assert.deepEqual(parseIcs('', NOW), { name: '', tasks: [] });
});

/* ==========================================================
   ICS 生成 / 往復
   ========================================================== */

test('formatIcsDue', () => {
  assert.deepEqual(formatIcsDue('2026-10-20', false), { value: '20261020', param: ';VALUE=DATE' });
  assert.deepEqual(formatIcsDue('2026-10-20T09:00:00.000Z', true), { value: '20261020T090000Z', param: '' });
  assert.equal(formatIcsDue(null, false), null);
});

test('tasksToIcs → parseIcs で往復できる', () => {
  const task = createTask(
    {
      title: '英語の宿題',
      notes: 'p.42',
      due: '2026-10-20',
      priority: 3,
      tags: ['学務', '英語'],
      project: '大学',
      repeat: 'weekly',
    },
    NOW,
  );
  const ics = tasksToIcs([task], { now: NOW });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VTODO/);
  assert.match(ics, /PRODID:-\/\/MyApps\/\/todo-studio/);
  assert.match(ics, /DUE;VALUE=DATE:20261020/);
  assert.match(ics, /PRIORITY:3/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);

  const { tasks } = parseIcs(ics, NOW);
  assert.equal(tasks.length, 1);
  const round = tasks[0];
  assert.equal(round.uid, task.uid);
  assert.equal(round.title, '英語の宿題');
  assert.equal(round.notes, 'p.42');
  assert.equal(round.due, '2026-10-20');
  assert.equal(round.priority, 3);
  assert.deepEqual(round.tags, ['学務', '英語']);
  assert.equal(round.project, '大学');
  assert.equal(round.repeat, 'weekly');
});

test('tasksToIcs は完了を除外できる', () => {
  const open = createTask({ title: 'a' }, NOW);
  const done = createTask({ title: 'b', done: true, completedAt: new Date(NOW).toISOString() }, NOW);
  const ics = tasksToIcs([open, done], { now: NOW, includeCompleted: false });
  assert.equal((ics.match(/BEGIN:VTODO/g) || []).length, 1);
});

test('serializeVtodo は STATUS / COMPLETED を書く', () => {
  const t = createTask({ title: 'x', done: true, completedAt: '2026-10-11T10:00:00.000Z' }, NOW);
  const lines = serializeVtodo(t, NOW);
  assert.ok(lines.includes('STATUS:COMPLETED'));
  assert.ok(lines.some((l) => l.startsWith('COMPLETED:')));
});

/* ==========================================================
   ical.js の jCal 変換
   ========================================================== */

test('jcalToTasks は ical.js の jCal を変換する', () => {
  const jcal = [
    'vcalendar',
    [['version', {}, 'text', '2.0'], ['x-wr-calname', {}, 'text', 'Moodle']],
    [
      [
        'vtodo',
        [
          ['uid', {}, 'text', 'x2'],
          ['summary', {}, 'text', 'Report ; draft'],
          ['description', {}, 'text', 'Line1\nLine2'],
          ['due', {}, 'date-time', '2026-10-20T09:00:00Z'],
          ['priority', {}, 'integer', 5],
          ['status', {}, 'text', 'NEEDS-ACTION'],
          ['categories', {}, 'text', 'study', 'cs'],
          ['rrule', {}, 'recur', { freq: 'WEEKLY' }],
          ['x-myapps-project', {}, 'text', '大学'],
        ],
        [],
      ],
      ['vevent', [['uid', {}, 'text', 'e1'], ['summary', {}, 'text', 'Assignment'], ['dtstart', {}, 'date-time', '2026-10-25T23:59:00Z']], []],
    ],
  ];
  const { name, tasks } = jcalToTasks(jcal, NOW);
  assert.equal(name, 'Moodle');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, 'Report ; draft');
  assert.equal(tasks[0].notes, 'Line1\nLine2');
  assert.equal(tasks[0].due, '2026-10-20T09:00:00.000Z');
  assert.equal(tasks[0].priority, 5);
  assert.deepEqual(tasks[0].tags, ['study', 'cs']);
  assert.equal(tasks[0].repeat, 'weekly');
  assert.equal(tasks[0].project, '大学');
  assert.equal(tasks[1].source, 'event');
});

test('jcalToTasks は VCALENDAR 以外で空を返す', () => {
  assert.deepEqual(jcalToTasks(null, NOW), { name: '', tasks: [] });
  assert.deepEqual(jcalToTasks(['vcard', [], []], NOW), { name: '', tasks: [] });
});

/* ==========================================================
   取り込みマージ
   ========================================================== */

test('mergeImportedTasks は UID で重複を防ぐ', () => {
  let state = createState();
  state = addTask(state, { title: '既存', uid: 'u1' }, NOW);
  const imported = [createTask({ title: '更新後', uid: 'u1', due: '2026-10-20' }, NOW), createTask({ title: '新規', uid: 'u2' }, NOW)];
  const { state: next, added, updated } = mergeImportedTasks(state, imported, NOW);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(next.tasks.length, 2);
  const u1 = next.tasks.find((t) => t.uid === 'u1');
  assert.equal(u1.title, '更新後');
  assert.equal(u1.due, '2026-10-20');
  assert.equal(next.tasks.find((t) => t.uid === 'u2').title, '新規');
});

/* ==========================================================
   ファイル名 / サイズ
   ========================================================== */

test('isSupportedIcsFile / isSupportedTaskFile / buildIcsFileName / formatBytes', () => {
  assert.equal(isSupportedIcsFile('a.ics'), true);
  assert.equal(isSupportedIcsFile({ name: 'B.ICS' }), true);
  assert.equal(isSupportedIcsFile('a.txt'), false);
  assert.equal(isSupportedTaskFile('state.json'), true);
  assert.equal(buildIcsFileName(new Date(2026, 9, 13)), 'todo-20261013.ics');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
});

test('componentToRaw は優先度と RRULE を読む', () => {
  const root = parseIcsComponents(SAMPLE_ICS);
  const cal = root.children[0];
  const raw = componentToRaw(cal.children[0]);
  assert.equal(raw.kind, 'todo');
  assert.equal(raw.priority, 1);
  assert.equal(raw.rrule, 'FREQ=WEEKLY');
});
