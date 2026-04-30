import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers";

// 環境設定
env.allowLocalModels = false;

const UI = {
  consentState: document.getElementById("consent-state"),
  loadingState: document.getElementById("loading-state"),
  consentBtn: document.getElementById("consent-btn"),
  statusText: document.getElementById("status-text"),
  progressBar: document.getElementById("progress-bar"),
  appMain: document.getElementById("app-main"),
  loadingScreen: document.getElementById("loading-screen"),

  inputText: document.getElementById("input-text"),
  dtypeSelect: document.getElementById("dtype-select"),
  processBtn: document.getElementById("process-btn"),

  tabBtns: document.querySelectorAll(".tab-btn"),
  resultContents: document.querySelectorAll(".result-content"),
  outputRendered: document.getElementById("output-rendered"),
  outputJson: document.getElementById("output-json"),
};

let classifier = null;

// ロードプロセスの管理
async function initializeModel() {
  UI.consentState.style.display = "none";
  UI.loadingState.style.display = "block";
  UI.statusText.textContent = "モデルをダウンロード・初期化中...";

  try {
    const dtype = UI.dtypeSelect.value;
    // モデルのロード
    classifier = await pipeline(
      "token-classification",
      "openai/privacy-filter",
      {
        device: "webgpu",
        dtype: dtype,
        progress_callback: (x) => {
          if (x.status === "initiate") {
            UI.statusText.textContent = `ロード中: ${x.file}`;
          } else if (x.status === "progress" && x.progress) {
            UI.progressBar.style.width = x.progress + "%";
            UI.statusText.textContent = `ダウンロード中... ${Math.round(x.progress)}%`;
          } else if (x.status === "done") {
            UI.statusText.textContent = `完了: ${x.file}`;
          } else if (x.status === "ready") {
            UI.statusText.textContent = `モデルを展開・準備中...（これには数分かかる場合があります）`;
          }
        },
      }
    );

    // ローディング完了
    UI.loadingScreen.classList.add("fade-out");
    setTimeout(() => {
      UI.loadingScreen.style.display = "none";
      UI.appMain.style.opacity = "1";
      UI.appMain.style.pointerEvents = "auto";
      UI.processBtn.disabled = false;
    }, 300); // css transition duration
  } catch (error) {
    console.error(error);
    UI.statusText.textContent = "エラーが発生しました: " + error.message;
    UI.progressBar.style.backgroundColor = "red";
  }
}

// 処理
async function processText() {
  if (!classifier) return;

  const text = UI.inputText.value;
  if (!text.trim()) return;

  UI.processBtn.disabled = true;
  UI.processBtn.textContent = "処理中...";
  UI.outputRendered.innerHTML = "処理中...";
  UI.outputJson.textContent = "[]";

  try {
    // 実行
    const output = await classifier(text, { aggregation_strategy: "simple" });
    
    // JSONの表示
    UI.outputJson.textContent = JSON.stringify(output, null, 2);

    // インラインでマスキング表示
    let renderedHTML = escapeHTML(text);

    if (output && output.length > 0) {
      // 簡易的な置換ロジック (Transformer.jsのtoken-classificationのwordを利用)
      output.forEach(entity => {
        let entityWord = entity.word;
        if (!entityWord) return;
        
        // 最初の空白などをトリムして置換しやすくする
        let cleanWord = entityWord.replace(/^[\sĠ]+/, "");
        if (!cleanWord) cleanWord = entityWord; // 全部空白だった場合などのフォールバック
        
        const entityGroup = entity.entity_group || "unknown";
        
        // エスケープ後のテキストに対して置換を行う
        const escapedCleanWord = escapeHTML(cleanWord);
        
        // <span class="pii-span"... 内に既に置換されたものとパタンが被らないように、
        // 理想的には元のテキストで位置を特定すべきだが、簡易的に最初のマッチを置換
        const replacement = `<span class="pii-span" data-type="${entityGroup}" title="${entityGroup}">${escapedCleanWord}</span>`;
        renderedHTML = renderedHTML.replace(escapedCleanWord, replacement);
      });
    }

    UI.outputRendered.innerHTML = renderedHTML;
  } catch (error) {
    console.error(error);
    UI.outputRendered.textContent = "エラーが発生しました: " + error.message;
  } finally {
    UI.processBtn.disabled = false;
    UI.processBtn.textContent = "フィルター実行";
  }
}

// ユーティリティ
function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// イベントリスナー
UI.consentBtn.addEventListener("click", initializeModel);
UI.processBtn.addEventListener("click", processText);

UI.tabBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.getAttribute("data-tab");
    
    UI.tabBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const targetId = `result-${tabId}`;
    UI.resultContents.forEach(content => {
      if (content.id === targetId) {
        content.classList.add("active");
      } else {
        content.classList.remove("active");
      }
    });
  });
});
