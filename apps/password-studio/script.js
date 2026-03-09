(function() {
    'use strict';

    const display = document.getElementById('password-display');
    const btnCopy = document.getElementById('btn-copy');
    const btnRegen = document.getElementById('btn-regen');
    const lengthRange = document.getElementById('length-range');
    const lengthNum = document.getElementById('length-num');
    const checkUpper = document.getElementById('check-upper');
    const checkLower = document.getElementById('check-lower');
    const checkNumbers = document.getElementById('check-numbers');
    const checkSymbols = document.getElementById('check-symbols');
    const strengthBar = document.getElementById('strength-bar');
    const strengthText = document.getElementById('strength-text');
    const entropyText = document.getElementById('entropy-text');

    const CHARSETS = {
        upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        lower: 'abcdefghijklmnopqrstuvwxyz',
        numbers: '0123456789',
        symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?'
    };

    function randomIndex(max) {
        const values = new Uint32Array(1);
        crypto.getRandomValues(values);
        return values[0] % max;
    }

    function shuffle(items) {
        for (let index = items.length - 1; index > 0; index -= 1) {
            const nextIndex = randomIndex(index + 1);
            [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
        }
        return items;
    }

    function selectedPools() {
        const pools = [];
        if (checkUpper.checked) pools.push(CHARSETS.upper);
        if (checkLower.checked) pools.push(CHARSETS.lower);
        if (checkNumbers.checked) pools.push(CHARSETS.numbers);
        if (checkSymbols.checked) pools.push(CHARSETS.symbols);
        return pools;
    }

    function syncLengthInputs(poolCount) {
        const minLength = Math.max(4, poolCount || 4);
        const current = Number.parseInt(lengthNum.value, 10) || minLength;
        const safeLength = Math.max(minLength, Math.min(50, current));

        lengthRange.min = String(minLength);
        lengthNum.min = String(minLength);
        lengthRange.value = String(safeLength);
        lengthNum.value = String(safeLength);
        return safeLength;
    }

    function updateStrength(entropy) {
        entropyText.textContent = `${Math.round(entropy)} bits`;

        const score = Math.min(entropy / 100, 1) * 100;
        strengthBar.style.width = `${score}%`;

        if (entropy < 40) {
            strengthBar.style.background = '#ef4444';
            strengthText.textContent = '非常に弱い';
        } else if (entropy < 60) {
            strengthBar.style.background = '#f59e0b';
            strengthText.textContent = '弱い';
        } else if (entropy < 80) {
            strengthBar.style.background = '#fbbf24';
            strengthText.textContent = '普通';
        } else if (entropy < 100) {
            strengthBar.style.background = '#10b981';
            strengthText.textContent = '強い';
        } else {
            strengthBar.style.background = '#059669';
            strengthText.textContent = '非常に強力';
        }
    }

    function generate() {
        const pools = selectedPools();
        const poolCount = pools.length;
        const length = syncLengthInputs(poolCount);

        if (poolCount === 0) {
            display.textContent = '文字種を1つ以上選択してください';
            updateStrength(0);
            btnCopy.disabled = true;
            return;
        }

        const combined = pools.join('');
        const password = [];

        for (const pool of pools) {
            password.push(pool[randomIndex(pool.length)]);
        }

        while (password.length < length) {
            password.push(combined[randomIndex(combined.length)]);
        }

        const finalPassword = shuffle(password).join('');
        display.textContent = finalPassword;
        btnCopy.disabled = false;

        const entropy = length * Math.log2(combined.length);
        updateStrength(entropy);
    }

    [lengthRange, lengthNum, checkUpper, checkLower, checkNumbers, checkSymbols].forEach((element) => {
        element.addEventListener('input', (event) => {
            if (event.target === lengthRange) {
                lengthNum.value = lengthRange.value;
            }
            if (event.target === lengthNum) {
                lengthRange.value = lengthNum.value;
            }
            const label = document.getElementById('length-label');
            if (label) label.textContent = lengthRange.value;
            generate();
        });
    });

    btnRegen.addEventListener('click', generate);

    btnCopy.addEventListener('click', async () => {
        const value = display.textContent;
        if (!value || value.includes('選択してください')) {
            return;
        }

        try {
            await navigator.clipboard.writeText(value);
            const original = btnCopy.textContent;
            btnCopy.textContent = 'コピー完了！';
            window.setTimeout(() => {
                btnCopy.textContent = original;
            }, 1400);
        } catch (error) {
            console.error(error);
        }
    });

    generate();
})();
