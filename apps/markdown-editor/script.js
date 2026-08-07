const input = document.getElementById('markdown-input');
const output = document.getElementById('markdown-output');
const charCount = document.getElementById('char-count');
const wordCount = document.getElementById('word-count');
const lineCount = document.getElementById('line-count');
const readTime = document.getElementById('read-time');
const btnCopy = document.getElementById('btn-copy');
const btnClear = document.getElementById('btn-clear');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnModalClose = document.getElementById('btn-modal-close');
const previewModal = document.getElementById('preview-modal');
const previewModalBody = document.getElementById('preview-modal-body');

const allowedTags = new Set([
    'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HR', 'IMG', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
]);

function fallbackRender(rawValue) {
    const escaped = rawValue
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return escaped.replace(/\n/g, '<br>');
}

function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const toProcess = [];
    while (walker.nextNode()) {
        toProcess.push(walker.currentNode);
    }

    for (const node of toProcess) {
        if (!allowedTags.has(node.tagName)) {
            node.replaceWith(document.createTextNode(node.textContent || ''));
            continue;
        }

        const href = node.tagName === 'A' ? (node.getAttribute('href') || '') : '';
        const src = node.tagName === 'IMG' ? (node.getAttribute('src') || '') : '';
        const alt = node.tagName === 'IMG' ? (node.getAttribute('alt') || '') : '';
        const title = node.tagName === 'IMG' ? (node.getAttribute('title') || '') : '';

        for (const attr of [...node.attributes]) {
            node.removeAttribute(attr.name);
        }

        if (node.tagName === 'A') {
            const safeHref = /^(https?:|mailto:|#|data:|blob:|\.\.\/|\.\/|\/)/i.test(href) ? href : '#';
            node.setAttribute('href', safeHref);
            node.setAttribute('rel', 'noopener noreferrer');
            node.setAttribute('target', '_blank');
        } else if (node.tagName === 'IMG') {
            const safeSrc = /^(https?:|data:|blob:|\.\.\/|\.\/|\/)/i.test(src) ? src : '';
            if (safeSrc) node.setAttribute('src', safeSrc);
            if (alt) node.setAttribute('alt', alt);
            if (title) node.setAttribute('title', title);
        }
    }

    return template.innerHTML;
}

function renderPreview(rawValue) {
    if (typeof marked === 'undefined') {
        output.innerHTML = fallbackRender(rawValue);
        return;
    }

    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false,
    });

    try {
        const parsed = marked.parse(rawValue);
        output.innerHTML = sanitizeHtml(parsed);
    } catch (error) {
        console.error(error);
        output.innerHTML = fallbackRender(rawValue);
    }
}

function persistDraft(rawValue) {
    try {
        localStorage.setItem('myapps-markdown-draft', rawValue);
    } catch (error) {
        console.warn('Failed to save markdown draft.', error);
    }
}

function update() {
    const rawValue = input.value;
    renderPreview(rawValue);
    if (previewModalBody) previewModalBody.innerHTML = output.innerHTML;

    const chars = rawValue.length;
    const words = rawValue.trim() ? rawValue.trim().split(/\s+/).length : 0;
    const lines = rawValue === '' ? 0 : rawValue.split('\n').length;
    const time = Math.max(1, Math.ceil(chars / 500)); // Approx 500 chars/min reading speed

    if (charCount) charCount.textContent = chars;
    if (wordCount) wordCount.textContent = words;
    if (lineCount) lineCount.textContent = lines;
    if (readTime) readTime.textContent = time;

    persistDraft(rawValue);
}

input.addEventListener('input', update);

btnCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(input.value);
        const originalText = btnCopy.textContent;
        btnCopy.textContent = 'コピー完了！';
        setTimeout(() => btnCopy.textContent = originalText, 1400);
    } catch (error) {
        console.error(error);
    }
});

btnClear.addEventListener('click', () => {
    if (!confirm('エディタの内容をすべてクリアしますか？')) {
        return;
    }
    input.value = '';
    update();
});

function openPreviewModal() {
    if (!previewModal) return;
    previewModal.hidden = false;
    document.body.classList.add('modal-open');
    btnModalClose?.focus();
}

function closePreviewModal() {
    if (!previewModal) return;
    previewModal.hidden = true;
    document.body.classList.remove('modal-open');
    btnFullscreen?.focus();
}

btnFullscreen?.addEventListener('click', openPreviewModal);
btnModalClose?.addEventListener('click', closePreviewModal);

previewModal?.addEventListener('click', (event) => {
    if (event.target === previewModal) closePreviewModal();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && previewModal && !previewModal.hidden) {
        closePreviewModal();
    }
});

const savedDraft = localStorage.getItem('myapps-markdown-draft');
if (savedDraft) {
    input.value = savedDraft;
} else {
    input.value = `# Markdown Editor
リアルタイムプレビュー機能付きの Markdown エディタです。

## 基本的な書式
**太字**、*斜体*、~~打ち消し線~~、\`インラインコード\` が使えます。

> これは引用ブロックです。
> 複数行にわたる引用もサポートしています。

### リスト
- 箇条書きリスト
  - ネストされたリスト
  - さらにネスト
- アイテム2

1. 番号付きリスト
2. アイテム2
   1. ネストされた番号付きリスト

### 表のサポート
| 機能 | サポート | 備考 |
| --- | :---: | --- |
| 表 (Table) | ✅ | GitHub Flavored Markdown 互換 |
| 箇条書き | ✅ | ネストにも対応 |
| シンタックスハイライト | ✅ | 自動エスケープ処理付き |

### コードブロック
\`\`\`javascript
// コードブロックのシンタックスハイライト（CSS調整が必要な場合があります）
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}
greet("MyApps");
\`\`\`

### リンクと画像
[MyAppsのホームへ戻る](../../index.html)

![サンプルの画像](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZTRlNGU3Ii8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmaWxsPSIjNTI1MjViIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+U2FtcGxlIEltYWdlPC90ZXh0Pjwvc3ZnPg== "サンプル画像")

---

*Markdownの主要な記法は一通りサポートしています。*
`;
}

update();
