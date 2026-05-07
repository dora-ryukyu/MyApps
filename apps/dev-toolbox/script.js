(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // --- Tabs ---
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            $(btn.dataset.target).classList.add('active');
        });
    });

    const checkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const checkIconSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

    // --- UUID ---
    const MAX_COUNT = 200;
    const countInput = $('uuid-count');
    const genBtn = $('uuid-gen-btn');
    const copyBtn = $('uuid-copy-btn');
    const uuidList = $('uuid-list');
    const outputRaw = $('uuid-output-raw');

    function generateUUID() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
        return [
            hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''),
            hex.slice(8, 10).join(''), hex.slice(10, 16).join('')
        ].join('-');
    }

    async function copyText(value, button, small = false) {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            if (!button) return;
            const original = button.innerHTML;
            button.innerHTML = small ? checkIconSmall : checkIcon;
            button.disabled = true;
            setTimeout(() => { button.innerHTML = original; button.disabled = false; }, 1400);
        } catch (error) { console.error(error); }
    }

    function renderUUIDs() {
        const parsed = Number.parseInt(countInput.value, 10);
        const count = Number.isFinite(parsed) ? Math.min(MAX_COUNT, Math.max(1, parsed)) : 1;
        countInput.value = String(count);
        const uuids = Array.from({ length: count }, generateUUID);
        outputRaw.value = uuids.join('\n');
        uuidList.innerHTML = uuids.map((uuid) => `
            <div class="uuid-item">
                <span class="uuid-val">${uuid}</span>
                <button class="btn-icon-only copy-single" type="button" data-uuid="${uuid}" title="コピー">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
                </button>
            </div>
        `).join('');
    }

    genBtn.addEventListener('click', renderUUIDs);
    countInput.addEventListener('change', renderUUIDs);
    copyBtn.addEventListener('click', () => copyText(outputRaw.value, copyBtn));
    uuidList.addEventListener('click', (event) => {
        const button = event.target.closest('.copy-single');
        if (button) copyText(button.dataset.uuid || '', button, true);
    });
    renderUUIDs();

    // --- Unix Timestamp ---
    const localFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const utcFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
    const relativeFormatter = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });

    function formatRelative(timestampMs) {
        const diffSeconds = Math.round((timestampMs - Date.now()) / 1000);
        const abs = Math.abs(diffSeconds);
        if (abs < 60) return relativeFormatter.format(diffSeconds, 'second');
        if (abs < 3600) return relativeFormatter.format(Math.round(diffSeconds / 60), 'minute');
        if (abs < 86400) return relativeFormatter.format(Math.round(diffSeconds / 3600), 'hour');
        return relativeFormatter.format(Math.round(diffSeconds / 86400), 'day');
    }

    function updateCurrent() {
        const now = new Date();
        $('unix-current-ts').textContent = Math.floor(now.getTime() / 1000).toString();
        $('unix-current-date').textContent = localFormatter.format(now);
        $('unix-current-utc').textContent = `UTC: ${utcFormatter.format(now)}`;
    }

    function updateTsToDate() {
        const raw = $('unix-input-ts').value.trim();
        const parsed = Number(raw);
        if (!raw || !Number.isFinite(parsed)) {
            $('unix-res-local').textContent = '----/--/-- --:--:--';
            $('unix-res-utc').textContent = '----/--/-- --:--:--';
            $('unix-res-rel').textContent = '--';
            return;
        }
        const timestampMs = $('unix-input-unit').value === 's' ? parsed * 1000 : parsed;
        const date = new Date(timestampMs);
        if (Number.isNaN(date.getTime())) return;
        $('unix-res-local').textContent = localFormatter.format(date);
        $('unix-res-utc').textContent = utcFormatter.format(date);
        $('unix-res-rel').textContent = formatRelative(timestampMs);
    }

    function updateDateToTs() {
        const dateStr = $('unix-input-date').value;
        if (!dateStr) {
            $('unix-res-ts-s').textContent = '0';
            $('unix-res-ts-ms').textContent = '0';
            return;
        }
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return;
        $('unix-res-ts-s').textContent = Math.floor(date.getTime() / 1000).toString();
        $('unix-res-ts-ms').textContent = date.getTime().toString();
    }

    $('unix-input-ts').addEventListener('input', updateTsToDate);
    $('unix-input-unit').addEventListener('change', updateTsToDate);
    $('unix-input-date').addEventListener('input', updateDateToTs);
    document.querySelectorAll('.btn-copy').forEach(btn => {
        btn.addEventListener('click', () => {
            const el = $(btn.dataset.target);
            if (el) copyText(el.textContent, btn, true);
        });
    });

    const nowUnix = new Date();
    $('unix-input-ts').value = Math.floor(nowUnix.getTime() / 1000).toString();
    const offset = nowUnix.getTimezoneOffset();
    $('unix-input-date').value = new Date(nowUnix.getTime() - offset * 60_000).toISOString().slice(0, 19);
    updateCurrent(); updateTsToDate(); updateDateToTs();
    setInterval(updateCurrent, 1000);

    // --- NumBase Converter ---
    const vBin = $('num-v-bin'), vOct = $('num-v-oct'), vDec = $('num-v-dec'), vHex = $('num-v-hex'), vAscii = $('num-v-ascii');
    function clearTargets(src) {
        if (src !== 'bin') vBin.value = '';
        if (src !== 'oct') vOct.value = '';
        if (src !== 'dec') vDec.value = '';
        if (src !== 'hex') vHex.value = '';
        if (src !== 'ascii') vAscii.value = '';
    }
    function parseBigInt(raw, radix) {
        const value = raw.trim();
        if (!value) return null;
        const isNeg = value.startsWith('-');
        const digits = isNeg ? value.slice(1) : value;
        const patterns = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^\d+$/, 16: /^[0-9a-f]+$/i };
        if (!patterns[radix].test(digits)) throw new Error('invalid');
        let result = 0n;
        const base = BigInt(radix);
        for (const char of digits.toLowerCase()) {
            const code = char >= 'a' ? char.charCodeAt(0) - 87 : char.charCodeAt(0) - 48;
            result = result * base + BigInt(code);
        }
        return isNeg ? -result : result;
    }
    function updateNum(src) {
        try {
            let value;
            if (src === 'bin') value = parseBigInt(vBin.value, 2);
            else if (src === 'oct') value = parseBigInt(vOct.value, 8);
            else if (src === 'dec') value = parseBigInt(vDec.value, 10);
            else if (src === 'hex') value = parseBigInt(vHex.value, 16);
            else if (src === 'ascii') {
                const char = Array.from(vAscii.value)[0];
                value = char ? BigInt(char.codePointAt(0)) : null;
            }
            if (value === null) { clearTargets(src); return; }
            if (src !== 'bin') vBin.value = value.toString(2);
            if (src !== 'oct') vOct.value = value.toString(8);
            if (src !== 'dec') vDec.value = value.toString(10);
            if (src !== 'hex') vHex.value = value.toString(16).toUpperCase();
            if (src !== 'ascii') {
                const nv = Number(value);
                vAscii.value = (Number.isSafeInteger(nv) && nv >= 0 && nv <= 0x10FFFF) ? String.fromCodePoint(nv) : '';
            }
        } catch (e) { clearTargets(src); }
    }
    vBin.addEventListener('input', () => updateNum('bin'));
    vOct.addEventListener('input', () => updateNum('oct'));
    vDec.addEventListener('input', () => updateNum('dec'));
    vHex.addEventListener('input', () => updateNum('hex'));
    vAscii.addEventListener('input', () => updateNum('ascii'));
})();
