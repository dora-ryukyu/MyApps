  const digits = {
    0: [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
    1: [[0,0,1,0,0], [0,1,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,1,1,1,0]],
    2: [[1,1,1,1,1], [0,0,0,0,1], [1,1,1,1,1], [1,0,0,0,0], [1,1,1,1,1]],
    3: [[1,1,1,1,1], [0,0,0,0,1], [0,1,1,1,1], [0,0,0,0,1], [1,1,1,1,1]],
    4: [[1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1]],
    5: [[1,1,1,1,1], [1,0,0,0,0], [1,1,1,1,1], [0,0,0,0,1], [1,1,1,1,1]],
    6: [[1,1,1,1,1], [1,0,0,0,0], [1,1,1,1,1], [1,0,0,0,1], [1,1,1,1,1]],
    7: [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
    8: [[1,1,1,1,1], [1,0,0,0,1], [1,1,1,1,1], [1,0,0,0,1], [1,1,1,1,1]],
    9: [[1,1,1,1,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [1,1,1,1,1]]
  };

  const recipes = {
    single: {
      classes: [
        { id: 0, eq: "P(1,4) + P(2,0) - P(2,1) - P(2,2) - P(2,3) + P(3,0)" },
        { id: 1, eq: "- P(0,4) + P(1,1) + P(1,2) + P(2,2) - P(2,3) - P(2,4) - P(4,0) + 1" },
        { id: 2, eq: "- P(0,1) - P(1,0) + P(1,4) + P(3,0) - P(3,4) + P(4,1) - P(4,3) + P(4,4)" },
        { id: 3, eq: "- P(1,0) + P(1,4) - P(2,0) - P(3,0) + P(4,0)" },
        { id: 4, eq: "- P(0,1) - P(0,2) - P(0,3) + P(1,0) + P(2,4) - P(4,1) - P(4,2) - P(4,3) + P(4,4) + 1" },
        { id: 5, eq: "P(1,0) - P(1,4) - P(3,0)" },
        { id: 6, eq: "- P(1,4) + P(3,0)" },
        { id: 7, eq: "P(1,4) - P(2,0) - P(2,2) - P(2,3) + P(2,4) + P(3,4) - P(4,0) - P(4,1) - P(4,3) + 1" },
        { id: 8, eq: "- P(0,0) + P(1,0) + P(1,4) + P(3,0) - 1" },
        { id: 9, eq: "P(1,0) + P(1,4) - P(3,0) - 1" }
      ]
    },
    two: {
      nodes: [
        { id: 'B', eq: "- P(1,0) + P(1,4) + P(2,2) - P(2,4) + P(3,0) + P(4,3)" },
        { id: 'C', eq: "P(1,1) + P(3,2) - P(4,0) + P(4,3)" },
        { id: 'D', eq: "P(0,4) + P(1,4) - P(2,0) - P(3,0) + P(3,4) - P(4,1) + 1" },
        { id: 'F', eq: "P(1,0) + P(3,0) + P(3,4)" },
        { id: 'G', eq: "- P(0,2) + P(0,4) + P(2,0) + P(2,1) + P(2,3) - P(3,4)" },
        { id: 'H', eq: "- P(0,2) + P(1,0)" }
      ],
      classes: [
        { id: 0, eq: "- ノード D + ノード F - ノード G + 1" },
        { id: 1, eq: "ノード B + ノード C - ノード D - ノード F - ノード G" },
        { id: 2, eq: "ノード B - ノード D - ノード F + ノード G - 1" },
        { id: 3, eq: "ノード B + ノード D - ノード F - ノード G" },
        { id: 4, eq: "- ノード B + ノード G + ノード H - 1" },
        { id: 5, eq: "- ノード B - ノード D + ノード G + 1" },
        { id: 6, eq: "- ノード D + ノード F" },
        { id: 7, eq: "- ノード B + ノード D - ノード F - ノード G + 1" },
        { id: 8, eq: "ノード B - ノード D + ノード F - 1" },
        { id: 9, eq: "- ノード H + 1" }
      ]
    }
  };

  let grid = Array(5).fill().map(() => Array(5).fill(0));
  let currentMode = 'single';
  let autoCalc = true;

  function initGrid() {
    const container = document.getElementById('pixel-grid');
    container.innerHTML = '';
    for(let r=0; r<5; r++) {
      for(let c=0; c<5; c++) {
        const el = document.createElement('div');
        el.className = 'pixel';
        el.innerHTML = `<span class="pixel-label">${r},${c}</span>`;
        el.onclick = () => {
          grid[r][c] = 1 - grid[r][c];
          el.classList.toggle('active', grid[r][c] === 1);
          renderEquations();
        };
        container.appendChild(el);
      }
    }
  }

  window.clearGrid = function() {
    grid = Array(5).fill().map(() => Array(5).fill(0));
    const cells = document.getElementById('pixel-grid').children;
    for(let i=0; i<25; i++) cells[i].classList.remove('active');
    renderEquations();
  };

  window.drawExample = function(d) {
    const pattern = digits[d];
    for(let r=0; r<5; r++) {
      for(let c=0; c<5; c++) {
        grid[r][c] = pattern[r][c];
        const idx = r * 5 + c;
        const el = document.getElementById('pixel-grid').children[idx];
        el.classList.toggle('active', grid[r][c] === 1);
      }
    }
    renderEquations();
  };

  function setupControls() {
    const c = document.getElementById('example-btns');
    [0, 2, 4, 8].forEach(d => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.innerText = `Draw ${d}`;
      btn.onclick = () => drawExample(d);
      c.appendChild(btn);
    });

    const toggle = document.getElementById('auto-calc-toggle');
    toggle.onchange = (e) => {
      autoCalc = e.target.checked;
      renderEquations();
    };
  }

  window.setMode = function(mode) {
    currentMode = mode;
    document.getElementById('tab-single').classList.toggle('active', mode === 'single');
    document.getElementById('tab-two').classList.toggle('active', mode === 'two');
    renderEquations();
  };

  function parseEq(str) {
    let s = str.trim();
    if (!s.startsWith('+') && !s.startsWith('-')) s = '+ ' + s;
    const regex = /([+-])\s*(P\(\d,\d\)|N\([A-Z]\)|ノード\s*[A-Z]|\d+)/g;
    let match;
    const terms = [];
    while ((match = regex.exec(s)) !== null) {
      let sign = match[1];
      let val = match[2];
      let type = 'const';
      let content = val;
      if (val.startsWith('P')) {
        type = 'pixel';
      } else if (val.startsWith('N') || val.startsWith('ノード')) {
        type = 'node';
        content = val.replace('ノード', '').replace(/[\(\) ]/g, ''); 
      }
      terms.push({ sign, type, content });
    }
    return terms;
  }

  function renderEquations() {
    const container = document.getElementById('equation-container');
    container.innerHTML = '';
    
    const nodeVals = {};
    if (currentMode === 'two') {
      const title = document.createElement('div');
      title.className = 'section-title';
      title.innerHTML = '<span>1</span> 隠れ層（特徴抽出ノード）の計算';
      container.appendChild(title);
      
      recipes.two.nodes.forEach(node => {
        const terms = parseEq(node.eq);
        let sum = 0;
        const termsHtml = terms.map(t => {
          let active = false;
          if (t.type === 'pixel') {
            const match = t.content.match(/\d/g);
            const r = parseInt(match[0]), c = parseInt(match[1]);
            if (grid[r][c] === 1) {
              active = true;
              sum += (t.sign === '+' ? 1 : -1);
            }
          } else if (t.type === 'const') {
            active = true; 
            sum += (t.sign === '+' ? parseInt(t.content) : -parseInt(t.content));
          }
          return `<div class="term ${active ? 'active-pixel' : ''}">
            <span class="term-sign">${t.sign}</span> <span>${t.content}</span>
          </div>`;
        }).join('');
        
        const reluVal = Math.max(0, sum);
        if (autoCalc) nodeVals[node.id] = reluVal;
        
        const resultHtml = autoCalc 
          ? `<div style="font-size:0.75rem; color:var(--text-muted); line-height:1.2; text-align:right; margin-right:10px;">ReLU<br>Max(0, x)</div>${reluVal}`
          : `<input type="text" class="eq-result-input" placeholder="?">`;
          
        const activeNodeCls = (autoCalc && reluVal > 0) ? 'winner-score' : '';

        const html = `
          <div class="equation-row glass" id="node-${node.id}">
            <div class="eq-label" style="color:var(--accent);">ノード ${node.id}</div>
            <div class="eq-terms">${termsHtml}</div>
            <div class="eq-result ${activeNodeCls}">${resultHtml}</div>
          </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
      });
      
      const title2 = document.createElement('div');
      title2.className = 'section-title';
      title2.innerHTML = '<span>2</span> 最終出力層の計算';
      container.appendChild(title2);
    }
    
    const classList = recipes[currentMode].classes;
    let maxScore = -Infinity;
    let maxId = -1;
    
    const classRows = [];
    classList.forEach(cls => {
      const terms = parseEq(cls.eq);
      let sum = 0;
      const termsHtml = terms.map(t => {
        let active = false;
        if (t.type === 'pixel') {
          const match = t.content.match(/\d/g);
          const r = parseInt(match[0]), c = parseInt(match[1]);
          if (grid[r][c] === 1) {
            active = true;
            sum += (t.sign === '+' ? 1 : -1);
          }
        } else if (t.type === 'node') {
          if (autoCalc) {
            const v = nodeVals[t.content] || 0;
            if (v > 0) {
              active = true;
              sum += (t.sign === '+' ? v : -v);
            }
          }
        } else if (t.type === 'const') {
          active = true;
          sum += (t.sign === '+' ? parseInt(t.content) : -parseInt(t.content));
        }
        
        const displayContent = t.type === 'node' ? `ノード ${t.content}` : t.content;
        return `<div class="term ${active ? (t.type==='node' ? 'active-node' : 'active-pixel') : ''}">
          <span class="term-sign">${t.sign}</span> <span>${displayContent}</span>
        </div>`;
      }).join('');
      
      if (sum > maxScore) {
        maxScore = sum;
        maxId = cls.id;
      }
      
      const resultHtml = autoCalc ? `${sum}` : `<input type="text" class="eq-result-input" placeholder="?">`;
      
      classRows.push({
        id: cls.id,
        sum: sum,
        html: `
          <div class="equation-row glass" id="class-${cls.id}">
            <div class="eq-label">クラス ${cls.id}</div>
            <div class="eq-terms">${termsHtml}</div>
            <div class="eq-result result-class-${cls.id}">${resultHtml}</div>
          </div>
        `
      });
    });
    
    classRows.forEach(r => {
      container.insertAdjacentHTML('beforeend', r.html);
      if (autoCalc && r.id === maxId) {
        document.getElementById(`class-${r.id}`).classList.add('is-winner');
        document.querySelector(`.result-class-${r.id}`).classList.add('winner-score');
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initGrid();
    setupControls();
    renderEquations();
  });
