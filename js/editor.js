(function () {
  'use strict';

  const {
    $, SAMPLE, toast, load, downloadBlob, safeName, baseName, renderMarkdown, htmlBlob, textBlob,
    copyText, debounce, onFileDrop, withBusy, store,
  } = Aft;

  const STORE_KEY = 'aft-editor-doc';
  const input = $('#edInput');
  const preview = $('#edPreview');
  const panes = $('#edPanes');
  const nameField = $('#edName');
  const status = $('#edStatus');
  let nameEdited = false;

  /* ---------- text editing ---------- */

  // execCommand keeps the browser's undo history; setRangeText is the fallback.
  function replaceRange(start, end, text, selStart, selEnd) {
    input.focus();
    input.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch (e) { /* fall through */ }
    if (!done) {
      input.setRangeText(text, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.setSelectionRange(selStart, selEnd);
  }

  function wrap(before, after, placeholder) {
    const start = input.selectionStart;
    const selected = input.value.slice(start, input.selectionEnd) || placeholder;
    const from = start + before.length;
    replaceRange(start, input.selectionEnd, before + selected + after, from, from + selected.length);
  }

  // Rewrites every line touched by the selection.
  function eachLine(fn) {
    const value = input.value;
    const start = value.lastIndexOf('\n', input.selectionStart - 1) + 1;
    let end = value.indexOf('\n', input.selectionEnd);
    if (end === -1) end = value.length;
    const text = value.slice(start, end).split('\n').map(fn).join('\n');
    replaceRange(start, end, text, start, start + text.length);
  }

  // Inserts text as its own paragraph, adding blank lines around it where needed.
  function block(text, selectFrom, selectLength) {
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') || !after ? '\n' : '\n\n';
    const from = start + lead.length + (selectFrom || 0);
    replaceRange(start, end, lead + text + trail, from, from + (selectLength == null ? text.length : selectLength));
  }

  function heading(level) {
    eachLine((line) => '#'.repeat(level) + ' ' + line.replace(/^#{1,6}\s+/, ''));
  }

  const COMMANDS = {
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('*', '*', 'italic text'),
    strike: () => wrap('~~', '~~', 'text'),
    code: () => wrap('`', '`', 'code'),
    link: () => wrap('[', '](https://)', 'link text'),
    image: () => wrap('![', '](https://)', 'alt text'),
    h1: () => heading(1),
    h2: () => heading(2),
    h3: () => heading(3),
    quote: () => eachLine((line) => '> ' + line),
    ul: () => eachLine((line) => '- ' + line),
    ol: () => eachLine((line, i) => (i + 1) + '. ' + line),
    task: () => eachLine((line) => '- [ ] ' + line),
    codeblock: () => {
      const selected = input.value.slice(input.selectionStart, input.selectionEnd) || 'code';
      block('```\n' + selected + '\n```', 4, selected.length);
    },
    table: () => block('| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |', 2, 8),
    hr: () => block('---', 3, 0),
  };

  $('#edToolbar').addEventListener('click', (e) => {
    const button = e.target.closest('[data-cmd]');
    if (button) COMMANDS[button.dataset.cmd]();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      replaceRange(input.selectionStart, input.selectionEnd, '  ', input.selectionStart + 2, input.selectionStart + 2);
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const command = { b: 'bold', i: 'italic', k: 'link' }[e.key.toLowerCase()];
    if (command) {
      e.preventDefault();
      COMMANDS[command]();
    }
  });

  /* ---------- preview, stats, autosave ---------- */

  function update() {
    const text = input.value;
    renderMarkdown(preview, text);
    const words = (text.trim().match(/\S+/g) || []).length;
    $('#edStats').textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words') +
      ' · ' + text.length.toLocaleString() + ' characters';
  }

  const save = debounce(() => {
    status.textContent = store.set(STORE_KEY, input.value) ? 'Saved in this browser' : '';
  }, 400);
  const scheduleUpdate = debounce(update, 120);

  input.addEventListener('input', () => {
    scheduleUpdate();
    save();
  });

  // The preview follows the editor's scroll position proportionally.
  input.addEventListener('scroll', () => {
    const range = input.scrollHeight - input.clientHeight;
    if (range > 0) preview.scrollTop = (input.scrollTop / range) * (preview.scrollHeight - preview.clientHeight);
  });

  /* ---------- view switch ---------- */

  const viewButtons = Array.from(document.querySelectorAll('[data-view]'));
  function setView(view) {
    panes.dataset.view = view;
    viewButtons.forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    });
    if (view !== 'edit') update();
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  /* ---------- files ---------- */

  function setDocument(text) {
    replaceRange(0, input.value.length, text, 0, 0);
    input.scrollTop = 0;
  }

  function openFile(file) {
    if (!/\.(md|markdown|txt)$/i.test(file.name) && !/^text\//.test(file.type)) {
      toast('Please choose a .md, .markdown or .txt file.', true);
      return;
    }
    file.text().then((text) => {
      setDocument(text);
      nameField.value = safeName(baseName(file.name), 'document');
      nameEdited = true;
      toast('Opened ' + file.name);
    }).catch(() => toast('Could not read that file.', true));
  }

  $('#edOpenBtn').addEventListener('click', () => $('#edFile').click());
  $('#edFile').addEventListener('change', (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#edClearBtn').addEventListener('click', () => {
    if (!input.value) return;
    setDocument('');
    toast('Cleared. Press Ctrl/Cmd + Z to undo.');
  });
  $('#edCopyBtn').addEventListener('click', () => copyText(input.value, 'Markdown copied to clipboard'));
  onFileDrop($('#edPaneEdit'), openFile);
  nameField.addEventListener('input', () => { nameEdited = true; });

  // Until the user names the file, it is named after the document's first heading.
  function filename(extension) {
    const title = (input.value.match(/^#{1,6}\s+(.+)$/m) || [])[1];
    const name = nameEdited ? nameField.value : title || nameField.value;
    return safeName(name, 'document') + extension;
  }

  function bindExport(buttonId, extension, convert) {
    $(buttonId).addEventListener('click', function () {
      if (!input.value.trim()) {
        toast('Write some Markdown first.', true);
        input.focus();
        return;
      }
      withBusy(this, 'Working…', async () => {
        try {
          const name = filename(extension);
          downloadBlob(await convert(input.value), name);
          toast('Downloaded ' + name);
        } catch (err) {
          console.error(err);
          toast('Export failed. Please check your connection and try again.', true);
        }
      });
    });
  }

  bindExport('#edMdBtn', '.md', (md) => textBlob(md));
  bindExport('#edDocxBtn', '.docx', async (md) => {
    await load('docx');
    return MdToDocx.convert(md);
  });
  bindExport('#edPdfBtn', '.pdf', async (md) => {
    await load('pdfmake');
    return MdToPdf.convert(md);
  });
  bindExport('#edHtmlBtn', '.html', (md) => htmlBlob(HtmlDoc.fromMarkdown(md), 'Document'));

  /* ---------- init ---------- */

  const saved = store.get(STORE_KEY);
  input.value = saved == null ? SAMPLE : saved;
  if (window.matchMedia('(max-width: 820px)').matches) setView('edit');
  update();
})();
