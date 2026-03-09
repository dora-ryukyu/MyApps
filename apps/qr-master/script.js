(function() {
    'use strict';

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            tabBtns.forEach((button) => button.classList.toggle('active', button === btn));
            tabContents.forEach((content) => content.classList.toggle('active', content.id === `tab-${target}`));
            if (target !== 'scan') {
                stopScanner();
            }
        });
    });

    const qrInput = document.getElementById('qr-input');
    const qrResult = document.getElementById('qr-result');
    const btnDownload = document.getElementById('btn-download');
    let qrcode = null;

    function generateQR() {
        const value = qrInput.value.trim() || ' ';
        if (!qrcode) {
            qrcode = new QRCode(qrResult, {
                text: value,
                width: 256,
                height: 256,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H,
            });
            return;
        }

        qrcode.clear();
        qrcode.makeCode(value);
    }

    qrInput.addEventListener('input', generateQR);

    btnDownload.addEventListener('click', () => {
        const canvas = qrResult.querySelector('canvas');
        const image = qrResult.querySelector('img');
        const href = canvas ? canvas.toDataURL('image/png') : image?.src;
        if (!href) {
            return;
        }

        const link = document.createElement('a');
        link.href = href;
        link.download = 'qrcode.png';
        link.click();
    });

    generateQR();

    const video = document.getElementById('scan-video');
    const canvas = document.getElementById('scan-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scanPlaceholder = document.getElementById('scan-placeholder');
    const scanOverlay = document.getElementById('scan-overlay');
    const btnStartCamera = document.getElementById('btn-start-camera');
    const btnOpenFile = document.getElementById('btn-open-file');
    const inputFile = document.getElementById('input-file');
    const scanResult = document.getElementById('scan-result');
    const btnCopy = document.getElementById('btn-copy');

    let scanning = false;
    let stream = null;

    const startCameraLabel = btnStartCamera.innerHTML;
    const stopCameraLabel = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M9 9h6v6H9z"/></svg>
        カメラ停止
    `;

    async function startCamera() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            video.srcObject = stream;
            video.setAttribute('playsinline', 'true');
            await video.play();
            scanning = true;
            scanPlaceholder.style.display = 'none';
            scanOverlay.style.display = 'flex';
            btnStartCamera.innerHTML = stopCameraLabel;
            requestAnimationFrame(tick);
        } catch (error) {
            console.error(error);
            alert('カメラの起動に失敗しました。権限設定を確認してください。');
        }
    }

    function stopScanner() {
        scanning = false;
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            stream = null;
        }
        btnStartCamera.innerHTML = startCameraLabel;
        scanPlaceholder.style.display = 'flex';
        scanOverlay.style.display = 'none';
    }

    function tick() {
        if (!scanning) {
            return;
        }

        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.height = video.videoHeight;
            canvas.width = video.videoWidth;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert',
            });
            if (code) {
                scanResult.value = code.data;
                if ('vibrate' in navigator) navigator.vibrate(120);
                stopScanner();
                return;
            }
        }

        requestAnimationFrame(tick);
    }

    async function readImageFile(file) {
        const fileUrl = URL.createObjectURL(file);
        const image = new Image();

        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = fileUrl;
        });

        canvas.width = image.width;
        canvas.height = image.height;
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        URL.revokeObjectURL(fileUrl);

        if (!code) {
            scanResult.value = '';
            alert('QRコードが見つかりませんでした。');
            return;
        }

        scanResult.value = code.data;
    }

    btnStartCamera.addEventListener('click', () => {
        if (scanning) {
            stopScanner();
            return;
        }
        startCamera();
    });

    btnOpenFile.addEventListener('click', () => inputFile.click());
    scanPlaceholder.addEventListener('click', () => inputFile.click());

    scanPlaceholder.addEventListener('dragover', (event) => {
        event.preventDefault();
        scanPlaceholder.classList.add('dragover');
    });

    scanPlaceholder.addEventListener('dragleave', () => {
        scanPlaceholder.classList.remove('dragover');
    });

    scanPlaceholder.addEventListener('drop', (event) => {
        event.preventDefault();
        scanPlaceholder.classList.remove('dragover');
        const [file] = event.dataTransfer.files;
        if (file) {
            readImageFile(file).catch((error) => {
                console.error(error);
                alert('画像の読み取りに失敗しました。');
            });
        }
    });

    inputFile.addEventListener('change', (event) => {
        const [file] = event.target.files;
        if (!file) {
            return;
        }
        readImageFile(file).catch((error) => {
            console.error(error);
            alert('画像の読み取りに失敗しました。');
        });
        inputFile.value = '';
    });

    btnCopy.addEventListener('click', async () => {
        if (!scanResult.value) {
            return;
        }

        try {
            await navigator.clipboard.writeText(scanResult.value);
            const original = btnCopy.innerHTML;
            btnCopy.textContent = 'コピー完了！';
            setTimeout(() => {
                btnCopy.innerHTML = original;
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    });
})();
