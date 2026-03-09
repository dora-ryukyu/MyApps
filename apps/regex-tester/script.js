document.addEventListener('DOMContentLoaded', () => {
    const regexPattern = document.getElementById('regex-pattern');
    const regexFlags = document.getElementById('regex-flags');
    const regexError = document.getElementById('regex-error');
    const testString = document.getElementById('test-string');
    const resultDisplay = document.getElementById('result-display');
    const matchCount = document.getElementById('match-count');

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, function(m) { return map[m]; });
    }

    function update() {
        const pattern = regexPattern.value;
        const flags = regexFlags.value;
        const text = testString.value;

        // Clear previous error
        regexError.textContent = '';
        
        if (!pattern) {
            resultDisplay.innerHTML = escapeHtml(text);
            matchCount.textContent = '0 matches';
            return;
        }

        try {
            // Validate regex
            new RegExp(pattern, flags);
            
            // Logic to find matches and highlight
            const matches = [];
            
            // We need to loop. If 'g' is missing, we only highlight the first one.
            // If 'g' is present, we loop.
            const isGlobal = flags.includes('g');
            const re = new RegExp(pattern, flags);
            
            if (isGlobal) {
                let match;
                // Prevent infinite loop if match is zero-width
                // e.g. /a*/ matches empty string at every position
                // RegExp.exec handles this by bumping lastIndex if match is empty, usually?
                // Actually JS exec() manual loop needs care for zero-width assertions.
                
                while ((match = re.exec(text)) !== null) {
                    matches.push({
                        start: match.index,
                        end: match.index + match[0].length,
                        text: match[0]
                    });
                    
                    if (match.index === re.lastIndex) {
                        re.lastIndex++;
                    }
                }
            } else {
                const match = re.exec(text);
                if (match) {
                    matches.push({
                        start: match.index,
                        end: match.index + match[0].length,
                        text: match[0]
                    });
                }
            }

            // Update match count
            const count = matches.length;
            matchCount.textContent = `${count} match${count !== 1 ? 'es' : ''}`;

            // Build HTML
            let html = '';
            let cursor = 0;

            matches.forEach(m => {
                // Text before match
                if (m.start > cursor) {
                    html += escapeHtml(text.substring(cursor, m.start));
                }
                
                // Matched text
                // Check if match overlaps with previous? (Not possible with standard JS regex except zero-width)
                // If zero-width match (e.g. ^ or $), highlight a thin bar or character?
                if (m.start === m.end) {
                    // Zero-width match
                    html += `<span class="highlight" style="padding: 0 1px; margin: 0 -1px; border-left: 2px solid red;"></span>`;
                } else {
                    html += `<span class="highlight">${escapeHtml(m.text)}</span>`;
                }
                
                cursor = m.end;
            });

            // Remaining text
            if (cursor < text.length) {
                html += escapeHtml(text.substring(cursor));
            }

            resultDisplay.innerHTML = html;

        } catch (e) {
            regexError.textContent = e.message;
            // On error, show plain text
            resultDisplay.innerHTML = escapeHtml(text);
            matchCount.textContent = 'Error';
        }
    }

    // Attach listeners
    regexPattern.addEventListener('input', update);
    regexFlags.addEventListener('input', update);
    testString.addEventListener('input', update);

    // Initial run
    update();
});
