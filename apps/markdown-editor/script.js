const input = document.getElementById('markdown-input');
const output = document.getElementById('markdown-output');
const charCount = document.getElementById('char-count');
const wordCount = document.getElementById('word-count');
const btnCopy = document.getElementById('btn-copy');
const btnClear = document.getElementById('btn-clear');

const allowedTags = new Set([
    'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HR', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
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

        for (const attr of [...node.attributes]) {
            node.removeAttribute(attr.name);
        }

        if (node.tagName === 'A') {
            const safeHref = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
            node.setAttribute('href', safeHref);
            node.setAttribute('rel', 'noopener noreferrer');
            node.setAttribute('target', '_blank');
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

    charCount.textContent = `${rawValue.length} 文字`;
    wordCount.textContent = `${rawValue.trim() ? rawValue.trim().split(/\s+/).length : 0} 単語`;

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

const savedDraft = localStorage.getItem('myapps-markdown-draft');
if (savedDraft) {
    input.value = savedDraft;
} else {
    input.value = `# Markdown Editor
リアルタイムプレビュー機能付きの Markdown エディタです。

## 特徴
- **リアルタイム**に変換
- HTML は安全な形に制限
- 完全ローカル動作

\`\`\`javascript
console.log("Hello, MyApps!");
\`\`\`
`;
}

update();
