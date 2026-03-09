const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const resultArea = document.getElementById('result-area');
const previewImg = document.getElementById('preview-img');
const fileName = document.getElementById('file-name');
const fileSize = document.getElementById('file-size');
const cRaw = document.getElementById('c-raw');
const cCss = document.getElementById('c-css');
const cHtml = document.getElementById('c-html');
const dropText = document.getElementById('drop-text');

function escapeAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function setBusy(isBusy, label = '画像をドラッグ＆ドロップ、またはクリックして選択') {
    dropText.textContent = label;
    dropZone.style.opacity = isBusy ? '0.6' : '1';
    dropZone.style.pointerEvents = isBusy ? 'none' : 'auto';
}

function resetDragState() {
    dropZone.classList.remove('dragover');
    if (dropZone.style.pointerEvents !== 'none') {
        dropText.textContent = '画像をドラッグ＆ドロップ、またはクリックして選択';
    }
}

function handleError(message) {
    setBusy(false);
    alert(message);
}

function processFile(file) {
    if (!file.type.startsWith('image/')) {
        handleError('画像ファイルを選択してください。');
        return;
    }

    setBusy(true, '処理中...');
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);

    const reader = new FileReader();
    reader.onload = (event) => {
        const dataUri = event.target.result;
        previewImg.src = dataUri;
        previewImg.alt = file.name;

        cRaw.value = dataUri;
        cCss.value = `background-image: url("${dataUri}");`;
        cHtml.value = `<img src="${dataUri}" alt="${escapeAttribute(file.name)}">`;

        resultArea.style.display = 'grid';
        setBusy(false);
    };
    reader.onerror = () => handleError('画像の読み込みに失敗しました。');
    reader.readAsDataURL(file);
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
    dropText.textContent = '放して読み込む';
});
dropZone.addEventListener('dragleave', resetDragState);
dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    resetDragState();
    const [file] = event.dataTransfer.files;
    if (file) {
        processFile(file);
    }
});

fileInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) {
        processFile(file);
    }
    fileInput.value = '';
});

document.querySelectorAll('.btn-copy').forEach((button) => {
    button.addEventListener('click', async () => {
        const textarea = document.getElementById(button.dataset.target || '');
        if (!textarea?.value) {
            return;
        }

        try {
            await navigator.clipboard.writeText(textarea.value);
            const originalText = button.textContent;
            button.textContent = 'Copied!';
            button.classList.add('copied');
            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('copied');
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    });
});
