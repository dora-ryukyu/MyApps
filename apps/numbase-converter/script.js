const vBin = document.getElementById('v-bin');
const vOct = document.getElementById('v-oct');
const vDec = document.getElementById('v-dec');
const vHex = document.getElementById('v-hex');
const vAscii = document.getElementById('v-ascii');

function clearTargets(source) {
    if (source !== 'bin') vBin.value = '';
    if (source !== 'oct') vOct.value = '';
    if (source !== 'dec') vDec.value = '';
    if (source !== 'hex') vHex.value = '';
    if (source !== 'ascii') vAscii.value = '';
}

function parseBigInt(raw, radix) {
    const value = raw.trim();
    if (!value) {
        return null;
    }

    const isNegative = value.startsWith('-');
    const digits = isNegative ? value.slice(1) : value;
    const patterns = {
        2: /^[01]+$/,
        8: /^[0-7]+$/,
        10: /^\d+$/,
        16: /^[0-9a-f]+$/i,
    };

    if (!patterns[radix].test(digits)) {
        throw new Error('invalid');
    }

    let result = 0n;
    const base = BigInt(radix);
    for (const char of digits.toLowerCase()) {
        const code = char >= 'a' ? char.charCodeAt(0) - 87 : char.charCodeAt(0) - 48;
        result = result * base + BigInt(code);
    }
    return isNegative ? -result : result;
}

function update(source) {
    try {
        let value;
        switch (source) {
            case 'bin':
                value = parseBigInt(vBin.value, 2);
                break;
            case 'oct':
                value = parseBigInt(vOct.value, 8);
                break;
            case 'dec':
                value = parseBigInt(vDec.value, 10);
                break;
            case 'hex':
                value = parseBigInt(vHex.value, 16);
                break;
            case 'ascii': {
                const char = Array.from(vAscii.value)[0];
                value = char ? BigInt(char.codePointAt(0)) : null;
                break;
            }
            default:
                value = null;
        }

        if (value === null) {
            clearTargets(source);
            return;
        }

        if (source !== 'bin') vBin.value = value.toString(2);
        if (source !== 'oct') vOct.value = value.toString(8);
        if (source !== 'dec') vDec.value = value.toString(10);
        if (source !== 'hex') vHex.value = value.toString(16).toUpperCase();

        if (source !== 'ascii') {
            const numericValue = Number(value);
            vAscii.value = Number.isSafeInteger(numericValue) && numericValue >= 0 && numericValue <= 0x10FFFF
                ? String.fromCodePoint(numericValue)
                : '';
        }
    } catch (error) {
        clearTargets(source);
    }
}

vBin.addEventListener('input', () => update('bin'));
vOct.addEventListener('input', () => update('oct'));
vDec.addEventListener('input', () => update('dec'));
vHex.addEventListener('input', () => update('hex'));
vAscii.addEventListener('input', () => update('ascii'));
