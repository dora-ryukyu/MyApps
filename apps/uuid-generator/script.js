(function () {
    'use strict';

    const MAX_COUNT = 200;
    const countInput = document.getElementById('count');
    const genBtn = document.getElementById('gen-btn');
    const copyBtn = document.getElementById('copy-btn');
    const uuidList = document.getElementById('uuid-list');
    const outputRaw = document.getElementById('output-raw');

    const copyIcon = copyBtn.innerHTML;
    const checkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

    function clampCount() {
        const parsed = Number.parseInt(countInput.value, 10);
        const safeValue = Number.isFinite(parsed) ? Math.min(MAX_COUNT, Math.max(1, parsed)) : 1;
        countInput.value = String(safeValue);
        return safeValue;
    }

    function randomInt(max) {
        const values = new Uint32Array(1);
        crypto.getRandomValues(values);
        return values[0] % max;
    }

    function generateUUID() {
        if (typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }

        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
        return [
            hex.slice(0, 4).join(''),
            hex.slice(4, 6).join(''),
            hex.slice(6, 8).join(''),
            hex.slice(8, 10).join(''),
            hex.slice(10, 16).join(''),
        ].join('-');
    }

    async function copyText(value, button) {
        if (!value) {
            return;
        }

        try {
            await navigator.clipboard.writeText(value);
            if (!button) {
                return;
            }

            const original = button.innerHTML;
            button.innerHTML = checkIcon;
            button.disabled = true;
            window.setTimeout(() => {
                button.innerHTML = original;
                button.disabled = false;
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    }

    function renderUUIDs() {
        const count = clampCount();
        const uuids = Array.from({ length: count }, generateUUID);

        outputRaw.value = uuids.join('\n');
        uuidList.innerHTML = uuids.map((uuid) => `
            <div class="uuid-item">
                <span class="uuid-val">${uuid}</span>
                <button class="btn-icon-only copy-single" type="button" data-uuid="${uuid}" title="コピー" aria-label="${uuid} をコピー">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
                </button>
            </div>
        `).join('');
    }

    genBtn.addEventListener('click', renderUUIDs);
    countInput.addEventListener('change', renderUUIDs);

    copyBtn.addEventListener('click', () => copyText(outputRaw.value, copyBtn));

    uuidList.addEventListener('click', (event) => {
        const button = event.target.closest('.copy-single');
        if (!button) {
            return;
        }
        copyText(button.dataset.uuid || '', button);
    });

    countInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            renderUUIDs();
        }
    });

    renderUUIDs();
})();
