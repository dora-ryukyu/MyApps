const dropZone = document.getElementById('drop-zone');
const dropText = document.getElementById('drop-text');
const fileInput = document.getElementById('file-input');
const sourceImg = document.getElementById('source-img');
const paletteGrid = document.getElementById('palette-grid');
const resultArea = document.getElementById('result-area');

const colorThief = window.ColorThief ? new ColorThief() : null;

function rgbToHex([r, g, b]) {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function setIdleText(text = '画像をドロップしてパレットを抽出') {
    dropText.textContent = text;
}

function uniqueColors(colors) {
    return colors.filter((color, index, array) => {
        const hex = rgbToHex(color);
        return array.findIndex((item) => rgbToHex(item) === hex) === index;
    });
}

function renderPalette(colors) {
    paletteGrid.innerHTML = colors.map((rgb) => {
        const hex = rgbToHex(rgb);
        return `
            <div class="color-swatch" data-hex="${hex}">
                <div class="color-box" style="background:${hex}" role="button" tabindex="0" aria-label="${hex} をコピー"></div>
                <div class="color-hex">${hex}<br>${rgb.join(', ')}</div>
            </div>
        `;
    }).join('');
}

function extractPalette() {
    if (!colorThief) {
        alert('Palette 抽出ライブラリの読み込みに失敗しました。');
        return;
    }

    const dominant = colorThief.getColor(sourceImg);
    const palette = colorThief.getPalette(sourceImg, 8);
    const colors = uniqueColors([dominant, ...palette]);
    renderPalette(colors);
    resultArea.style.display = 'grid';
    setIdleText();
}

function processFile(file) {
    if (!file.type.startsWith('image/')) {
        alert('画像ファイルを選択してください。');
        return;
    }

    setIdleText('抽出中...');
    const reader = new FileReader();
    reader.onload = (event) => {
        sourceImg.onload = () => extractPalette();
        sourceImg.src = event.target.result;
    };
    reader.onerror = () => {
        setIdleText();
        alert('画像の読み込みに失敗しました。');
    };
    reader.readAsDataURL(file);
}

async function copyHex(target) {
    const swatch = target.closest('.color-swatch');
    const hex = swatch?.dataset.hex;
    const label = swatch?.querySelector('.color-hex');
    if (!hex || !label) {
        return;
    }

    try {
        await navigator.clipboard.writeText(hex);
        const original = label.innerHTML;
        label.textContent = `${hex} copied`;
        setTimeout(() => {
            label.innerHTML = original;
        }, 1200);
    } catch (error) {
        console.error(error);
    }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropText.textContent = '放して抽出';
});
dropZone.addEventListener('dragleave', () => setIdleText());
dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    setIdleText();
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

paletteGrid.addEventListener('click', (event) => {
    if (event.target.closest('.color-box')) {
        copyHex(event.target);
    }
});

paletteGrid.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('color-box')) {
        event.preventDefault();
        copyHex(event.target);
    }
});
