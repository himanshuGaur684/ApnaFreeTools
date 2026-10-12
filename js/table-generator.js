(function () {
  'use strict';

  const { $, toast, downloadBlob, safeName, renderMarkdown, textBlob, copyText, debounce, store } = Aft;

  const STORE_KEY = 'aft-table';
  const ALIGNS = ['left', 'center', 'right'];
  const SAMPLE = {
    header: ['Name', 'Role', 'City'],
    align: ['left', 'left', 'left'],
    rows: [['Asha', 'Designer', 'Pune'], ['Ravi', 'Developer', 'Delhi'], ['Meera', 'Writer', 'Kochi']],
  };

  const grid = $('#tgGrid');
  const output = $('#tgOutput');
  const outputPreview = $('#tgPreview');
  const pretty = $('#tgPretty');
  let state = load() || clone(SAMPLE);

  function clone(table) {
    return JSON.parse(JSON.stringify(table));
  }

  function load() {
    try {
      const table = JSON.parse(store.get(STORE_KEY));
      return table && Array.isArray(table.header) && Array.isArray(table.rows) && Array.isArray(table.align) ? table : null;
    } catch (e) {
      return null;
    }
  }

  const persist = debounce(() => store.set(STORE_KEY, JSON.stringify(state)), 300);

  function blankRow() {
    return new Array(state.header.length).fill('');
  }

  /* ---------- Markdown output ---------- */

  function escapeCell(text) {
    return String(text).trim().replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }

  function pad(text, width, align) {
    const space = width - text.length;
    if (space <= 0) return text;
    if (align === 'right') return ' '.repeat(space) + text;
    if (align === 'center') return ' '.repeat(Math.floor(space / 2)) + text + ' '.repeat(Math.ceil(space / 2));
    return text + ' '.repeat(space);
  }

  function divider(width, align) {
    if (align === 'center') return ':' + '-'.repeat(Math.max(width - 2, 1)) + ':';
    if (align === 'right') return '-'.repeat(Math.max(width - 1, 2)) + ':';
    return '-'.repeat(Math.max(width, 3));
  }

  function toMarkdown() {
    const header = state.header.map(escapeCell);
    const rows = state.rows.map((row) => row.map(escapeCell));
    const widths = header.map((cell, c) => {
      if (!pretty.checked) return 3;
      return Math.max(3, cell.length, ...rows.map((row) => row[c].length));
    });
    const line = (cells) => '| ' + cells.map((cell, c) => (pretty.checked ? pad(cell, widths[c], state.align[c]) : cell)).join(' | ') + ' |';
    return [line(header), '| ' + widths.map((w, c) => divider(w, state.align[c])).join(' | ') + ' |']
      .concat(rows.map(line))
      .join('\n') + '\n';
  }

  function refreshOutput() {
    output.value = toMarkdown();
    if (!outputPreview.hidden) renderMarkdown(outputPreview, output.value);
    $('#tgSize').textContent = state.header.length + ' × ' + state.rows.length;
    persist();
  }

  /* ---------- grid ---------- */

  function el(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((child) => node.appendChild(child));
    return node;
  }

  function cellInput(r, c, value) {
    const field = el('input', {
      type: 'text', value: value, className: 'tg-cell', autocomplete: 'off',
      placeholder: r < 0 ? 'Header' : '',
    });
    field.dataset.r = r;
    field.dataset.c = c;
    field.setAttribute('aria-label', r < 0 ? 'Header, column ' + (c + 1) : 'Row ' + (r + 1) + ', column ' + (c + 1));
    return field;
  }

  function miniButton(label, act, index, title) {
    const button = el('button', { type: 'button', className: 'tg-mini', textContent: label, title: title });
    button.dataset.act = act;
    button.dataset.i = index;
    button.setAttribute('aria-label', title);
    return button;
  }

  function renderGrid() {
    const controls = el('tr', {}, state.header.map((_, c) => el('th', {}, [
      el('div', { className: 'tg-colctl' }, [
        miniButton(state.align[c][0].toUpperCase() + state.align[c].slice(1), 'align', c, 'Alignment of column ' + (c + 1)),
        miniButton('×', 'delcol', c, 'Delete column ' + (c + 1)),
      ]),
    ])).concat(el('th')));

    const headerRow = el('tr', {}, state.header.map((value, c) => el('th', {}, [cellInput(-1, c, value)])).concat(el('th')));
    const body = state.rows.map((row, r) => el('tr', {}, row.map((value, c) => el('td', {}, [cellInput(r, c, value)]))
      .concat(el('td', {}, [miniButton('×', 'delrow', r, 'Delete row ' + (r + 1))]))));

    grid.replaceChildren(el('thead', {}, [controls, headerRow]), el('tbody', {}, body));
    refreshOutput();
  }

  function focusCell(r, c) {
    const field = grid.querySelector('.tg-cell[data-r="' + r + '"][data-c="' + c + '"]');
    if (field) field.focus();
  }

  function addRow() {
    state.rows.push(blankRow());
  }

  function addColumn() {
    state.header.push('');
    state.align.push('left');
    state.rows.forEach((row) => row.push(''));
  }

  /* ---------- import (TSV from spreadsheets, CSV, or an existing Markdown table) ---------- */

  function parseCsvLine(line) {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cell); cell = ''; }
      else cell += ch;
    }
    cells.push(cell);
    return cells;
  }

  function parseMarkdownRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }

  function parseText(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
    if (!lines.length) return null;
    const isDivider = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');

    if (lines.length > 1 && lines[0].includes('|') && isDivider(lines[1])) {
      const align = parseMarkdownRow(lines[1]).map((cell) => (/^:-+:$/.test(cell) ? 'center' : /-:$/.test(cell) ? 'right' : 'left'));
      return { rows: [lines[0]].concat(lines.slice(2)).map(parseMarkdownRow), align: align };
    }
    if (text.includes('\t')) return { rows: lines.map((line) => line.split('\t')) };
    if (text.includes(',')) return { rows: lines.map(parseCsvLine) };
    return { rows: lines.map((line) => [line]) };
  }

  function replaceTable(parsed) {
    const cols = Math.max(...parsed.rows.map((row) => row.length));
    const fill = (row) => row.concat(new Array(cols - row.length).fill('')).map((cell) => cell.trim());
    state = {
      header: fill(parsed.rows[0]),
      align: new Array(cols).fill('left').map((a, c) => (parsed.align && parsed.align[c]) || a),
      rows: parsed.rows.slice(1).map(fill),
    };
    if (!state.rows.length) addRow();
    renderGrid();
  }

  // Pastes a block of cells into the grid starting at one cell, growing the table if needed.
  function pasteAt(r, c, parsed) {
    parsed.rows.forEach((cells, dr) => {
      const row = r + dr;
      while (row >= state.rows.length) addRow();
      cells.forEach((value, dc) => {
        while (c + dc >= state.header.length) addColumn();
        if (row < 0) state.header[c + dc] = value.trim();
        else state.rows[row][c + dc] = value.trim();
      });
    });
    renderGrid();
    focusCell(r, c);
  }

  /* ---------- events ---------- */

  grid.addEventListener('input', (e) => {
    const field = e.target.closest('.tg-cell');
    if (!field) return;
    const r = Number(field.dataset.r);
    const c = Number(field.dataset.c);
    if (r < 0) state.header[c] = field.value;
    else state.rows[r][c] = field.value;
    refreshOutput();
  });

  grid.addEventListener('click', (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const i = Number(button.dataset.i);
    if (button.dataset.act === 'align') {
      state.align[i] = ALIGNS[(ALIGNS.indexOf(state.align[i]) + 1) % ALIGNS.length];
    } else if (button.dataset.act === 'delrow') {
      if (state.rows.length === 1) { toast('A table needs at least one row.', true); return; }
      state.rows.splice(i, 1);
    } else if (button.dataset.act === 'delcol') {
      if (state.header.length === 1) { toast('A table needs at least one column.', true); return; }
      state.header.splice(i, 1);
      state.align.splice(i, 1);
      state.rows.forEach((row) => row.splice(i, 1));
    }
    renderGrid();
  });

  grid.addEventListener('keydown', (e) => {
    const field = e.target.closest('.tg-cell');
    if (!field || e.key !== 'Enter') return;
    e.preventDefault();
    const r = Number(field.dataset.r) + 1;
    if (r >= state.rows.length) {
      addRow();
      renderGrid();
    }
    focusCell(r, Number(field.dataset.c));
  });

  grid.addEventListener('paste', (e) => {
    const field = e.target.closest('.tg-cell');
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!field || !text || !/[\t\n]/.test(text.trim())) return; // plain single-cell paste
    const parsed = parseText(text);
    if (!parsed) return;
    e.preventDefault();
    pasteAt(Number(field.dataset.r), Number(field.dataset.c), parsed);
  });

  $('#tgAddRow').addEventListener('click', () => {
    addRow();
    renderGrid();
    focusCell(state.rows.length - 1, 0);
  });
  $('#tgAddCol').addEventListener('click', () => {
    addColumn();
    renderGrid();
    focusCell(-1, state.header.length - 1);
  });
  $('#tgSample').addEventListener('click', () => { state = clone(SAMPLE); renderGrid(); });
  $('#tgClear').addEventListener('click', () => {
    state = { header: ['', '', ''], align: ['left', 'left', 'left'], rows: [['', '', ''], ['', '', '']] };
    renderGrid();
    focusCell(-1, 0);
  });
  pretty.addEventListener('change', refreshOutput);

  const importPanel = $('#tgImportPanel');
  const importText = $('#tgImportText');
  $('#tgImport').addEventListener('click', () => {
    importPanel.hidden = !importPanel.hidden;
    if (!importPanel.hidden) importText.focus();
  });
  $('#tgImportCancel').addEventListener('click', () => { importPanel.hidden = true; });
  $('#tgImportApply').addEventListener('click', () => {
    const parsed = parseText(importText.value);
    if (!parsed) { toast('Paste some table data first.', true); return; }
    replaceTable(parsed);
    importPanel.hidden = true;
    importText.value = '';
    toast('Table filled: ' + state.header.length + ' columns, ' + state.rows.length + ' rows');
  });

  document.querySelectorAll('.mini-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const showPreview = tab.dataset.view === 'preview';
      document.querySelectorAll('.mini-tab').forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      output.hidden = showPreview;
      outputPreview.hidden = !showPreview;
      if (showPreview) renderMarkdown(outputPreview, output.value);
    });
  });

  $('#tgCopy').addEventListener('click', () => copyText(output.value, 'Table copied to clipboard'));
  $('#tgDownload').addEventListener('click', () => {
    const filename = safeName($('#tgName').value, 'table') + '.md';
    downloadBlob(textBlob(output.value), filename);
    toast('Downloaded ' + filename);
  });

  renderGrid();
})();
