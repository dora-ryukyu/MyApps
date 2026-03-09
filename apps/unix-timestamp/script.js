(function() {
    'use strict';

    const currentTs = document.getElementById('current-ts');
    const currentDate = document.getElementById('current-date');
    const currentUtc = document.getElementById('current-utc');
    const inputTs = document.getElementById('input-ts');
    const inputUnit = document.getElementById('input-unit');
    const resLocal = document.getElementById('res-local');
    const resUtc = document.getElementById('res-utc');
    const resRel = document.getElementById('res-rel');
    const inputDate = document.getElementById('input-date');
    const resTsS = document.getElementById('res-ts-s');
    const resTsMs = document.getElementById('res-ts-ms');

    const localFormatter = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    const utcFormatter = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short',
    });

    const relativeFormatter = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });
    const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
    const doneIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

    function formatLocal(date) {
        return localFormatter.format(date);
    }

    function formatUtc(date) {
        return utcFormatter.format(date);
    }

    function formatRelative(timestampMs) {
        const diffSeconds = Math.round((timestampMs - Date.now()) / 1000);
        const absSeconds = Math.abs(diffSeconds);

        if (absSeconds < 60) return relativeFormatter.format(diffSeconds, 'second');
        if (absSeconds < 3600) return relativeFormatter.format(Math.round(diffSeconds / 60), 'minute');
        if (absSeconds < 86400) return relativeFormatter.format(Math.round(diffSeconds / 3600), 'hour');
        return relativeFormatter.format(Math.round(diffSeconds / 86400), 'day');
    }

    function setPlaceholderResults() {
        resLocal.textContent = '----/--/-- --:--:--';
        resUtc.textContent = '----/--/-- --:--:--';
        resRel.textContent = '--';
    }

    function updateCurrent() {
        const now = new Date();
        currentTs.textContent = Math.floor(now.getTime() / 1000).toString();
        currentDate.textContent = formatLocal(now);
        currentUtc.textContent = `UTC: ${formatUtc(now)}`;
    }

    function updateTsToDate() {
        const rawValue = inputTs.value.trim();
        if (!rawValue) {
            setPlaceholderResults();
            return;
        }

        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) {
            setPlaceholderResults();
            return;
        }

        const timestampMs = inputUnit.value === 's' ? parsed * 1000 : parsed;
        const date = new Date(timestampMs);
        if (Number.isNaN(date.getTime())) {
            setPlaceholderResults();
            return;
        }

        resLocal.textContent = formatLocal(date);
        resUtc.textContent = formatUtc(date);
        resRel.textContent = formatRelative(timestampMs);
    }

    function updateDateToTs() {
        if (!inputDate.value) {
            resTsS.textContent = '0';
            resTsMs.textContent = '0';
            return;
        }

        const date = new Date(inputDate.value);
        if (Number.isNaN(date.getTime())) {
            resTsS.textContent = '0';
            resTsMs.textContent = '0';
            return;
        }

        resTsS.textContent = Math.floor(date.getTime() / 1000).toString();
        resTsMs.textContent = date.getTime().toString();
    }

    async function copyTarget(button) {
        const element = document.getElementById(button.dataset.target || '');
        const value = element?.textContent?.trim();
        if (!value || value === '--' || value.startsWith('----')) {
            return;
        }

        try {
            await navigator.clipboard.writeText(value);
            button.innerHTML = doneIcon;
            button.disabled = true;
            window.setTimeout(() => {
                button.innerHTML = copyIcon;
                button.disabled = false;
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    }

    function toDatetimeLocalValue(date) {
        const offset = date.getTimezoneOffset();
        const local = new Date(date.getTime() - offset * 60_000);
        return local.toISOString().slice(0, 19);
    }

    inputTs.addEventListener('input', updateTsToDate);
    inputUnit.addEventListener('change', updateTsToDate);
    inputDate.addEventListener('input', updateDateToTs);

    document.querySelectorAll('.btn-copy').forEach((button) => {
        button.addEventListener('click', () => copyTarget(button));
    });

    const now = new Date();
    inputTs.value = Math.floor(now.getTime() / 1000).toString();
    inputDate.value = toDatetimeLocalValue(now);

    updateCurrent();
    updateTsToDate();
    updateDateToTs();
    window.setInterval(updateCurrent, 1000);
})();
