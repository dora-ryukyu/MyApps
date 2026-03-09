document.addEventListener('DOMContentLoaded', () => {
    const inputJson = document.getElementById('input-json');
    const outputJson = document.getElementById('output-json');
    const btnFormat = document.getElementById('btn-format');
    const btnMinify = document.getElementById('btn-minify');
    const btnCopy = document.getElementById('btn-copy');
    const btnClear = document.getElementById('btn-clear');
    const statusText = document.getElementById('status');

    function setStatus(message, kind = '') {
        statusText.textContent = message;
        statusText.className = kind ? `status-text ${kind}` : 'status-text';
    }

    function parseWithDetails(raw) {
        try {
            return { value: JSON.parse(raw), error: null };
        } catch (error) {
            const positionMatch = /position\s+(\d+)/i.exec(error.message);
            if (!positionMatch) {
                return { value: null, error: error.message };
            }

            const position = Number(positionMatch[1]);
            const snippet = raw.slice(0, position);
            const line = snippet.split('\n').length;
            const column = position - snippet.lastIndexOf('\n');
            return { value: null, error: `Error: line ${line}, column ${column}` };
        }
    }

    function validateOnly() {
        const raw = inputJson.value.trim();
        if (!raw) {
            setStatus('Ready');
            return null;
        }

        const parsed = parseWithDetails(raw);
        if (parsed.error) {
            setStatus(parsed.error, 'status-error');
            return null;
        }

        setStatus('Valid JSON', 'status-success');
        return parsed.value;
    }

    function formatJSON(indent) {
        const raw = inputJson.value.trim();
        if (!raw) {
            outputJson.value = '';
            setStatus('Empty input');
            return;
        }

        const parsed = parseWithDetails(raw);
        if (parsed.error) {
            outputJson.value = '';
            setStatus(parsed.error, 'status-error');
            return;
        }

        outputJson.value = JSON.stringify(parsed.value, null, indent);
        setStatus('Valid JSON', 'status-success');
    }

    btnFormat.addEventListener('click', () => formatJSON(2));
    btnMinify.addEventListener('click', () => formatJSON(0));

    btnCopy.addEventListener('click', async () => {
        if (!outputJson.value) {
            return;
        }

        try {
            await navigator.clipboard.writeText(outputJson.value);
            const originalText = btnCopy.textContent;
            btnCopy.textContent = 'Copied!';
            setTimeout(() => {
                btnCopy.textContent = originalText;
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    });

    btnClear.addEventListener('click', () => {
        inputJson.value = '';
        outputJson.value = '';
        setStatus('Ready');
        inputJson.focus();
    });

    inputJson.addEventListener('input', validateOnly);
});
