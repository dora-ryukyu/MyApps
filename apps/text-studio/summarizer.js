/**
 * summarizer.js — Text Studio の「要約」タブ
 *
 * Chrome 138 stable のデスクトップ Chrome に内蔵された Summarizer API を使う。
 * モデルはブラウザが管理するため、アプリ側のダウンロードは無い。
 *
 * 対応外ブラウザでは何もしない (タブは hidden のまま)。
 * 判定と文言の組み立ては shared/builtin-ai.mjs の純関数に任せ、
 * ここでは DOM の配線と API 呼び出しだけを行う。
 *
 * 出典: https://developer.chrome.com/docs/ai/summarizer-api
 */

import {
  AVAILABILITY,
  normalizeAvailability,
  isSummarizerAllowed,
  summarizerButtonLabel,
  buildSummarizerOptions,
} from '../../shared/builtin-ai.mjs';

const $ = (id) => document.getElementById(id);

const tabBtn = $('tab-summarizer-btn');
const input = $('summarizer-input');
const output = $('summarizer-output');
const runBtn = $('summarizer-run');
const clearBtn = $('summarizer-clear');
const copyBtn = $('summarizer-copy');
const statusEl = $('summarizer-status');
const typeSelect = $('summarizer-type');
const lengthSelect = $('summarizer-length');

const summarizerApi = typeof globalThis.Summarizer !== 'undefined' ? globalThis.Summarizer : null;

let summarizer = null;
let summarizerKey = '';
let availability = AVAILABILITY.UNKNOWN;
let running = false;

function setStatus(text) {
  statusEl.textContent = text || '';
}

/** 対応ブラウザのときだけタブを出す。対応外なら UI を一切変えない。 */
async function init() {
  if (!summarizerApi || typeof summarizerApi.availability !== 'function') return;
  try {
    availability = normalizeAvailability(await summarizerApi.availability());
  } catch (error) {
    console.warn('Summarizer.availability failed:', error);
    return;
  }
  if (!isSummarizerAllowed(availability)) return;

  tabBtn.hidden = false;
  runBtn.textContent = summarizerButtonLabel(availability);
  if (availability === AVAILABILITY.DOWNLOADABLE) {
    setStatus('初回のみ Chrome が要約モデルを取得します');
  }
}

function optionsKey() {
  return `${typeSelect.value}|${lengthSelect.value}`;
}

/** 現在のオプションに合う Summarizer を返す。設定が変わったら作り直す。 */
async function ensureSummarizer() {
  const key = optionsKey();
  if (summarizer && summarizerKey === key) return summarizer;
  if (summarizer) {
    try {
      summarizer.destroy();
    } catch (error) {
      console.warn('Summarizer.destroy failed:', error);
    }
    summarizer = null;
  }
  summarizer = await summarizerApi.create(
    buildSummarizerOptions({
      type: typeSelect.value,
      format: 'plain-text',
      length: lengthSelect.value,
    }),
  );
  summarizerKey = key;
  return summarizer;
}

async function runSummarize() {
  const text = input.value.trim();
  if (!text) {
    setStatus('テキストを入力してください');
    return;
  }
  if (running) return;

  running = true;
  runBtn.disabled = true;
  setStatus('要約しています…');
  try {
    const instance = await ensureSummarizer();
    const result = await instance.summarize(text);
    output.value = result;
    setStatus('完了');
  } catch (error) {
    console.error('summarize failed:', error);
    setStatus(`要約に失敗しました: ${error?.message || error}`);
  } finally {
    running = false;
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', runSummarize);

clearBtn.addEventListener('click', () => {
  input.value = '';
  output.value = '';
  setStatus('');
  input.focus();
});

copyBtn.addEventListener('click', async () => {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 1500);
  } catch (error) {
    console.warn('Copy failed:', error);
  }
});

init();