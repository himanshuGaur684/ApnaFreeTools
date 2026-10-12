// Helpers shared by every tool page.
window.Aft = (function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // Large libraries are only fetched the first time a page needs them.
  const LIBS = {
    docx: ['https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js'],
    pdfmake: [
      'https://cdn.jsdelivr.net/npm/pdfmake@0.2.10/build/pdfmake.min.js',
      'https://cdn.jsdelivr.net/npm/pdfmake@0.2.10/build/vfs_fonts.js',
    ],
    pdfjs: ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'],
    pdflib: ['https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'],
    jszip: ['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'],
    qrcode: ['https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'],
    jsyaml: ['https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js'],
  };

  const SAMPLE = [
    '# Project Proposal',
    '',
    'A short introduction with **bold**, *italic*, ~~strikethrough~~ and `inline code`.',
    'Visit [ApnaFreeTools](https://apnafreetools.com) for more free tools.',
    '',
    '## Goals',
    '',
    '- Convert Markdown to Word or PDF in one click',
    '- Keep formatting intact',
    '  - Headings and lists',
    '  - Tables and code',
    '- Stay private',
    '',
    '## Timeline',
    '',
    '1. Draft the document',
    '2. Review with the team',
    '3. Publish',
    '',
    '| Phase | Owner | Status |',
    '| :---- | :---: | -----: |',
    '| Design | Asha | Done |',
    '| Build | Ravi | In progress |',
    '',
    '> Good tools get out of your way.',
    '',
    '```js',
    'function greet(name) {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
    '',
    '- [x] Write the draft',
    '- [ ] Send for review',
    '',
  ].join('\n');

  let toastTimer;
  function toast(message, isError) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), isError ? 5000 : 2600);
  }

  const scriptLoads = new Map();
  function loadScript(src) {
    if (!scriptLoads.has(src)) {
      scriptLoads.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scriptLoads.delete(src);
          el.remove();
          reject(new Error('Could not load ' + src));
        };
        document.head.appendChild(el);
      }));
    }
    return scriptLoads.get(src);
  }

  async function load(lib) {
    if (lib === 'docx' && window.docx) return;
    for (const url of LIBS[lib]) await loadScript(url);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeName(value, fallback) {
    const name = String(value || '')
      .replace(/\.(docx|pdf|html?|md|markdown|txt)$/i, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return name || fallback;
  }

  function baseName(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  function renderMarkdown(target, markdown) {
    if (!markdown.trim()) {
      target.innerHTML = '<p class="empty">Nothing to preview yet.</p>';
      return;
    }
    target.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }));
    target.querySelectorAll('a').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  function htmlBlob(bodyHtml, fallbackTitle) {
    return new Blob([HtmlDoc.build(bodyHtml, fallbackTitle)], { type: 'text/html;charset=utf-8' });
  }

  function textBlob(text, type) {
    return new Blob([text], { type: (type || 'text/markdown') + ';charset=utf-8' });
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message || 'Copied to clipboard');
      return true;
    } catch (e) {
      toast('Could not copy. Select the text and press Ctrl/Cmd + C.', true);
      return false;
    }
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function onFileDrop(el, handler) {
    let depth = 0;
    el.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; el.classList.add('is-dragover'); });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('is-dragover'); } });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      el.classList.remove('is-dragover');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) handler(file);
    });
  }

  // Wires a dropzone and its hidden file input to one handler.
  function bindDropzone(zone, input, handler) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) handler(e.target.files[0]);
      e.target.value = '';
    });
    onFileDrop(zone, handler);
  }

  async function withBusy(button, label, task) {
    const span = button.querySelector('span');
    const original = span.innerHTML;
    button.disabled = true;
    span.textContent = label;
    try {
      await task();
    } finally {
      span.innerHTML = original;
      button.disabled = false;
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1) + ' MB';
  }

  function el(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((child) => node.appendChild(child));
    return node;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality);
    });
  }

  // `files` is a list of { name, blob }.
  async function zipBlob(files) {
    await load('jszip');
    const zip = new window.JSZip();
    files.forEach((file) => zip.file(file.name, file.blob));
    return zip.generateAsync({ type: 'blob' });
  }

  // Dropzone / file input that accepts several files at once. `zone` may be null for a bare input.
  function bindFiles(zone, input, handler) {
    const pick = (list) => { if (list && list.length) handler(Array.from(list)); };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', () => { pick(input.files); input.value = ''; });
    if (!zone) return;
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    let depth = 0;
    zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('is-dragover'); });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-dragover'); } });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragover');
      pick(e.dataTransfer && e.dataTransfer.files);
    });
  }

  // `bar` is a .progress element; pass null to hide it.
  function setProgress(bar, fraction) {
    bar.hidden = fraction == null;
    bar.firstElementChild.style.width = Math.round((fraction || 0) * 100) + '%';
  }

  // Tabbed tool pages: role="tab" buttons with data-mode switch #panel-<mode>, and the tab is kept in the URL hash.
  function initTabs() {
    const segs = Array.from(document.querySelectorAll('[role="tab"][data-mode]'));
    function setMode(mode, updateHash) {
      if (!segs.some((seg) => seg.dataset.mode === mode)) return;
      segs.forEach((seg) => {
        const active = seg.dataset.mode === mode;
        seg.classList.toggle('is-active', active);
        seg.setAttribute('aria-selected', String(active));
        seg.tabIndex = active ? 0 : -1;
        $('#panel-' + seg.dataset.mode).hidden = !active;
        // When the tabs scroll sideways (phones), bring the active one into view.
        const row = seg.parentNode;
        if (active && row.scrollWidth > row.clientWidth) {
          row.scrollLeft += seg.getBoundingClientRect().left - row.getBoundingClientRect().left - 12;
        }
      });
      if (updateHash) history.replaceState(null, '', '#' + mode);
    }
    segs.forEach((seg, i) => {
      seg.addEventListener('click', () => setMode(seg.dataset.mode, true));
      seg.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = segs[(i + (e.key === 'ArrowRight' ? 1 : segs.length - 1)) % segs.length];
        next.focus();
        setMode(next.dataset.mode, true);
      });
    });
    const openHash = () => setMode(location.hash.slice(1), false);
    window.addEventListener('hashchange', openHash);
    openHash();
  }

  // Each tool lives on its own page, so a tool's code only runs when its panel is on the page.
  function section(panelId, init) {
    if (document.getElementById('panel-' + panelId)) init();
  }

  // Page-level defaults set by the page itself, e.g. <body data-target-kb="100">.
  function preset(name) {
    return document.body.dataset[name] || '';
  }

  // localStorage can be unavailable (private windows, blocked site data), so every call is guarded.
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    },
  };

  // On phones the menus scroll sideways; make sure the current page's link is in view in each.
  document.querySelectorAll('.site-nav a[aria-current="page"], .calc-nav a[aria-current="page"], .segmented a[aria-current="page"]').forEach((link) => {
    const row = link.parentNode;
    if (row.scrollWidth > row.clientWidth) row.scrollLeft += link.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
  });

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  return {
    $: $, SAMPLE: SAMPLE, toast: toast, load: load, downloadBlob: downloadBlob, safeName: safeName,
    baseName: baseName, renderMarkdown: renderMarkdown, htmlBlob: htmlBlob, textBlob: textBlob,
    copyText: copyText, debounce: debounce, onFileDrop: onFileDrop, bindDropzone: bindDropzone,
    withBusy: withBusy, store: store, formatSize: formatSize, el: el, canvasBlob: canvasBlob,
    zipBlob: zipBlob, bindFiles: bindFiles, setProgress: setProgress, initTabs: initTabs,
    section: section, preset: preset,
  };
})();
