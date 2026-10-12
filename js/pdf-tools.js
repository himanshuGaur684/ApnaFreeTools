(function () {
  'use strict';

  const {
    $, toast, load, downloadBlob, safeName, baseName, withBusy,
    formatSize, el, canvasBlob, zipBlob, bindFiles, setProgress, initTabs,
    section, preset,
  } = Aft;

  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const MAX_CANVAS_PIXELS = 16000000; // stays under the canvas limit of mobile browsers
  const PDF_TYPE = 'application/pdf';

  /* ---------- helpers ---------- */

  function isPdf(file) {
    return file.type === PDF_TYPE || /\.pdf$/i.test(file.name);
  }

  async function readBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  // pdf.js takes ownership of the buffer it is given, so it always gets a copy.
  async function openPdf(bytes) {
    await load('pdfjs');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  }

  function pdfError(err, name) {
    console.error(err);
    if (err && err.name === 'PasswordException') toast(name + ' is password-protected. Remove the password and try again.', true);
    else toast('Could not read ' + name + '. Make sure it is a valid PDF.', true);
  }

  // The "print" intent renders without waiting for animation frames, so work continues in a background tab.
  async function renderPage(page, scale, extraRotation) {
    const rotation = (page.rotate + (extraRotation || 0)) % 360;
    let viewport = page.getViewport({ scale: scale, rotation: rotation });
    const pixels = viewport.width * viewport.height;
    if (pixels > MAX_CANVAS_PIXELS) {
      viewport = page.getViewport({ scale: scale * Math.sqrt(MAX_CANVAS_PIXELS / pixels), rotation: rotation });
    }
    const canvas = el('canvas', { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: viewport, intent: 'print' }).promise;
    return canvas;
  }

  // Lets more files be dropped onto an area that is already showing cards.
  function dropFiles(zone, handler) {
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    zone.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e) || !e.dataTransfer.files.length) return;
      e.preventDefault();
      handler(Array.from(e.dataTransfer.files));
    });
  }

  /* ---------- sortable grid of page / image cards ---------- */

  function createGrid(root, options) {
    let items = [];
    let nextId = 1;
    let dragId = null;

    function card(item, index) {
      const button = (label, act, title) => {
        const b = el('button', { type: 'button', className: 'tg-mini', textContent: label, title: title });
        b.dataset.act = act;
        b.setAttribute('aria-label', title);
        return b;
      };
      item.thumb.style.transform = item.rotation ? 'rotate(' + item.rotation + 'deg)' : '';
      const node = el('div', { className: 'pg-card' + (item.selected ? ' is-selected' : ''), draggable: true }, [
        el('div', { className: 'pg-thumb', title: options.selectable ? 'Click to select' : '' }, [item.thumb]),
        el('div', { className: 'pg-meta' }, [
          el('span', { className: 'pg-num', textContent: String(index + 1) }),
          el('span', { className: 'pg-label', textContent: item.label, title: item.label }),
        ]),
        el('div', { className: 'pg-actions' }, [
          button('◀', 'left', 'Move earlier'),
          button('▶', 'right', 'Move later'),
          button('↻', 'rotate', 'Rotate 90°'),
          button('×', 'delete', 'Remove'),
        ]),
      ]);
      node.dataset.id = item.id;
      return node;
    }

    function render() {
      root.replaceChildren(...items.map(card));
      options.onChange(items);
    }

    function move(id, toIndex) {
      const from = items.findIndex((item) => item.id === id);
      if (from < 0) return;
      const [item] = items.splice(from, 1);
      items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, item);
      render();
    }

    root.addEventListener('click', (e) => {
      const node = e.target.closest('.pg-card');
      if (!node) return;
      const id = Number(node.dataset.id);
      const index = items.findIndex((item) => item.id === id);
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'left') move(id, index - 1);
        else if (act.dataset.act === 'right') move(id, index + 1);
        else if (act.dataset.act === 'delete') { items.splice(index, 1); render(); }
        else { items[index].rotation = (items[index].rotation + 90) % 360; render(); }
      } else if (options.selectable) {
        items[index].selected = !items[index].selected;
        render();
      }
    });

    root.addEventListener('dragstart', (e) => {
      const node = e.target.closest('.pg-card');
      if (!node) return;
      dragId = Number(node.dataset.id);
      node.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragId));
    });
    root.addEventListener('dragend', () => { dragId = null; render(); });
    root.addEventListener('dragover', (e) => { if (dragId != null) e.preventDefault(); });
    root.addEventListener('drop', (e) => {
      const node = e.target.closest('.pg-card');
      if (dragId == null || !node) return;
      e.preventDefault();
      e.stopPropagation();
      const targetId = Number(node.dataset.id);
      if (targetId === dragId) return;
      const box = node.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      const dragged = dragId;
      const rest = items.filter((item) => item.id !== dragged);
      move(dragged, rest.findIndex((item) => item.id === targetId) + (after ? 1 : 0));
    });

    return {
      get items() { return items; },
      add(newItems) {
        newItems.forEach((item) => {
          item.id = nextId++;
          item.rotation = 0;
          item.selected = false;
          items.push(item);
        });
        render();
      },
      // `fn` may change the items in place or return a replacement list.
      update(fn) {
        const replaced = fn(items);
        if (Array.isArray(replaced)) items = replaced;
        render();
      },
      clear() { items = []; render(); },
    };
  }

  initTabs();

  /* ---------- Organize: merge, split, reorder, rotate ---------- */

  section('organize', () => {
    const sources = new Map(); // id → { name, bytes }
    let nextSource = 1;
    const orgEmpty = $('#orgEmpty');
    const orgWork = $('#orgWork');
    const orgCount = $('#orgCount');
    const orgName = $('#orgName');

    const orgGrid = createGrid($('#orgGrid'), {
      selectable: true,
      onChange(items) {
        const selected = items.filter((item) => item.selected).length;
        orgEmpty.hidden = items.length > 0;
        orgWork.hidden = items.length === 0;
        orgCount.textContent = items.length + (items.length === 1 ? ' page' : ' pages') + (selected ? ' · ' + selected + ' selected' : '');
        $('#orgDownload').disabled = $('#orgSplit').disabled = items.length === 0;
        $('#orgExtract').disabled = selected === 0;
        $('#orgRotate').textContent = selected ? 'Rotate selected' : 'Rotate all';
        $('#orgDelete').disabled = selected === 0;
      },
    });

    async function addPdfs(files) {
      for (const file of files) {
        if (!isPdf(file)) { toast(file.name + ' is not a PDF.', true); continue; }
        let doc;
        let bytes;
        try {
          bytes = await readBytes(file);
          doc = await openPdf(bytes);
        } catch (err) {
          pdfError(err, file.name);
          continue;
        }
        const src = nextSource++;
        sources.set(src, { name: file.name, bytes: bytes });
        if (orgGrid.items.length === 0) orgName.value = safeName(baseName(file.name), 'document');

        const items = [];
        for (let i = 0; i < doc.numPages; i++) {
          items.push({ src: src, pageIndex: i, label: file.name + ' · p' + (i + 1), thumb: el('div', { className: 'pg-holder' }) });
        }
        orgGrid.add(items);

        // Thumbnails are drawn one by one so the grid appears immediately.
        for (const item of items) {
          try {
            const page = await doc.getPage(item.pageIndex + 1);
            const width = page.getViewport({ scale: 1, rotation: page.rotate }).width;
            item.thumb.replaceChildren(await renderPage(page, 220 / width));
          } catch (err) { console.error(err); }
        }
        doc.destroy();
      }
    }

    // Pages from the same file are copied together so shared fonts and images are stored once.
    async function buildPdf(list) {
      await load('pdflib');
      const { PDFDocument, degrees } = window.PDFLib;
      const out = await PDFDocument.create();
      const copies = new Map();
      for (const src of new Set(list.map((item) => item.src))) {
        const indexes = [...new Set(list.filter((item) => item.src === src).map((item) => item.pageIndex))];
        const doc = await PDFDocument.load(sources.get(src).bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(doc, indexes);
        indexes.forEach((pageIndex, i) => copies.set(src + ':' + pageIndex, pages[i]));
      }
      list.forEach((item) => {
        const page = copies.get(item.src + ':' + item.pageIndex);
        if (item.rotation) page.setRotation(degrees((page.getRotation().angle + item.rotation) % 360));
        out.addPage(page);
      });
      return new Blob([await out.save()], { type: PDF_TYPE });
    }

    // "1-3, 5, 8-" → positions in the current page order.
    function parseRange(text, count) {
      const picked = new Set();
      for (const part of text.split(',')) {
        const match = part.trim().match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
        if (!match || (!match[1] && !match[3])) return null;
        const from = match[1] ? Number(match[1]) : 1;
        const to = match[2] ? (match[3] ? Number(match[3]) : count) : from;
        if (from < 1 || to < from) return null;
        for (let n = from; n <= Math.min(to, count); n++) picked.add(n - 1);
      }
      return picked;
    }

    function orgExport(button, task) {
      withBusy(button, 'Working…', async () => {
        try {
          await task();
        } catch (err) {
          console.error(err);
          toast('Something went wrong while building the PDF. Please try again.', true);
        }
      });
    }

    bindFiles($('#orgDrop'), $('#orgFile'), addPdfs);
    bindFiles(null, $('#orgFileMore'), addPdfs);
    dropFiles(orgWork, addPdfs);
    $('#orgAdd').addEventListener('click', () => $('#orgFileMore').click());

    $('#orgRangeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = parseRange($('#orgRange').value, orgGrid.items.length);
      if (!picked) { toast('Use page numbers like 1-3, 5, 8-', true); return; }
      orgGrid.update((items) => { items.forEach((item, i) => { item.selected = picked.has(i); }); });
    });
    $('#orgRotate').addEventListener('click', () => {
      orgGrid.update((items) => {
        const any = items.some((item) => item.selected);
        items.forEach((item) => { if (!any || item.selected) item.rotation = (item.rotation + 90) % 360; });
      });
    });
    $('#orgDelete').addEventListener('click', () => {
      orgGrid.update((items) => items.filter((item) => !item.selected));
    });
    $('#orgClear').addEventListener('click', () => { orgGrid.clear(); sources.clear(); $('#orgRange').value = ''; });

    $('#orgDownload').addEventListener('click', function () {
      orgExport(this, async () => {
        const name = safeName(orgName.value, 'document') + '.pdf';
        downloadBlob(await buildPdf(orgGrid.items), name);
        toast('Downloaded ' + name);
      });
    });
    $('#orgExtract').addEventListener('click', function () {
      orgExport(this, async () => {
        const name = safeName(orgName.value, 'document') + '-selected.pdf';
        downloadBlob(await buildPdf(orgGrid.items.filter((item) => item.selected)), name);
        toast('Downloaded ' + name);
      });
    });
    $('#orgSplit').addEventListener('click', function () {
      orgExport(this, async () => {
        const base = safeName(orgName.value, 'document');
        const digits = String(orgGrid.items.length).length;
        const files = [];
        for (let i = 0; i < orgGrid.items.length; i++) {
          files.push({ name: base + '-page-' + String(i + 1).padStart(digits, '0') + '.pdf', blob: await buildPdf([orgGrid.items[i]]) });
        }
        if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
        else downloadBlob(await zipBlob(files), base + '-pages.zip');
        toast('Split into ' + files.length + (files.length === 1 ? ' file' : ' files'));
      });
    });
  });

  /* ---------- Compress ---------- */

  section('compress', () => {
    // Quality steps from best to smallest: [dots per inch, JPEG quality].
    const LADDER = [[150, 0.8], [150, 0.65], [120, 0.6], [100, 0.55], [100, 0.4], [80, 0.4], [72, 0.3], [60, 0.28], [50, 0.22], [40, 0.2], [30, 0.15]];
    const LEVELS = { light: [150, 0.8], medium: [110, 0.6], strong: [80, 0.45] };
    const cmpProgress = $('#cmpProgress');
    const cmpResult = $('#cmpResult');
    const cmpTarget = $('#cmpTarget');
    let cmpFile = null; // { name, bytes, pages }
    let cmpOutput = null;

    async function rasterize(doc, dpi, quality, onPage) {
      await load('pdflib');
      const out = await window.PDFLib.PDFDocument.create();
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const canvas = await renderPage(page, dpi / 72);
        const jpeg = await out.embedJpg(await (await canvasBlob(canvas, 'image/jpeg', quality)).arrayBuffer());
        const size = page.getViewport({ scale: 1, rotation: page.rotate });
        out.addPage([size.width, size.height]).drawImage(jpeg, { x: 0, y: 0, width: size.width, height: size.height });
        canvas.width = canvas.height = 0; // release memory early
        onPage();
      }
      return new Blob([await out.save()], { type: PDF_TYPE });
    }

    // Finds the best quality step whose result fits the target, building as few versions as possible.
    async function compressToTarget(doc, targetBytes, onPage) {
      const built = new Map();
      const build = async (i) => {
        if (!built.has(i)) built.set(i, await rasterize(doc, LADDER[i][0], LADDER[i][1], onPage));
        return built.get(i);
      };
      let low = 0;
      let high = LADDER.length - 1;
      let best = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const blob = await build(mid);
        if (blob.size <= targetBytes) { best = blob; high = mid - 1; }
        else low = mid + 1;
      }
      return best ? { blob: best, reached: true } : { blob: await build(LADDER.length - 1), reached: false };
    }

    function showCmpFile() {
      $('#cmpDrop').hidden = !!cmpFile;
      $('#cmpFileCard').hidden = !cmpFile;
      $('#cmpRun').disabled = !cmpFile;
      cmpResult.hidden = true;
      cmpOutput = null;
      if (!cmpFile) return;
      $('#cmpFileName').textContent = cmpFile.name;
      $('#cmpFileMeta').textContent = cmpFile.pages + (cmpFile.pages === 1 ? ' page · ' : ' pages · ') + formatSize(cmpFile.bytes.length);
    }

    async function loadCmpFile(files) {
      const file = files[0];
      if (!isPdf(file)) { toast('Please choose a PDF file.', true); return; }
      try {
        const bytes = await readBytes(file);
        const doc = await openPdf(bytes);
        cmpFile = { name: file.name, bytes: bytes, pages: doc.numPages };
        doc.destroy();
        showCmpFile();
      } catch (err) {
        pdfError(err, file.name);
      }
    }

    function selectedTarget() {
      const chip = document.querySelector('#cmpChips .chip.is-active');
      const kb = chip && chip.dataset.kb ? Number(chip.dataset.kb) : Number(cmpTarget.value);
      return kb > 0 ? kb * 1024 : 0;
    }

    bindFiles($('#cmpDrop'), $('#cmpFile'), loadCmpFile);
    $('#cmpChange').addEventListener('click', () => { cmpFile = null; showCmpFile(); });
    $('#cmpChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#cmpChips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      cmpTarget.hidden = !!chip.dataset.kb;
      if (!chip.dataset.kb) cmpTarget.focus();
      $('#cmpModeTarget').checked = true;
    });

    // A page such as "Compress PDF to 100 KB" starts with that target selected.
    const presetChip = preset('targetKb') && document.querySelector('#cmpChips .chip[data-kb="' + preset('targetKb') + '"]');
    if (presetChip) presetChip.click();

    $('#cmpRun').addEventListener('click', function () {
      if (!cmpFile) return;
      const mode = document.querySelector('input[name="cmpMode"]:checked').value;
      const target = mode === 'target' ? selectedTarget() : 0;
      if (mode === 'target' && !target) { toast('Enter a target size in KB.', true); cmpTarget.focus(); return; }
      const file = cmpFile;

      withBusy(this, 'Compressing…', async () => {
        cmpResult.hidden = true;
        let doc;
        try {
          doc = await openPdf(file.bytes);
          // A target needs up to four passes (binary search over the quality steps).
          const totalPages = file.pages * (target ? Math.ceil(Math.log2(LADDER.length + 1)) : 1);
          let done = 0;
          const onPage = () => setProgress(cmpProgress, Math.min(1, ++done / totalPages));
          setProgress(cmpProgress, 0);

          let blob;
          let reached = true;
          if (target) ({ blob, reached } = await compressToTarget(doc, target, onPage));
          else blob = await rasterize(doc, LEVELS[mode][0], LEVELS[mode][1], onPage);

          const original = file.bytes.length;
          const smaller = blob.size < original;
          cmpOutput = smaller ? { blob: blob, name: safeName(baseName(file.name), 'document') + '-compressed.pdf' } : null;
          $('#cmpSizes').textContent = formatSize(original) + ' → ' + formatSize(smaller ? blob.size : original);
          $('#cmpSaved').textContent = !smaller
            ? 'This PDF is already smaller than the compressed version, so the original is the best option.'
            : !reached
              ? Math.round((1 - blob.size / original) * 100) + '% smaller. ' + formatSize(target) + ' could not be reached — this is the smallest readable version.'
              : Math.round((1 - blob.size / original) * 100) + '% smaller' + (target ? ', under your ' + formatSize(target) + ' target.' : '.');
          $('#cmpDownload').hidden = !smaller;
          cmpResult.hidden = false;
          cmpResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // it sits above the button on phones
        } catch (err) {
          console.error(err);
          toast('Compression failed. Please try again with a different setting.', true);
        } finally {
          setProgress(cmpProgress, null);
          if (doc) doc.destroy();
        }
      });
    });
    $('#cmpDownload').addEventListener('click', () => {
      if (!cmpOutput) return;
      downloadBlob(cmpOutput.blob, cmpOutput.name);
      toast('Downloaded ' + cmpOutput.name);
    });
  });

  /* ---------- Images → PDF ---------- */

  section('images-to-pdf', () => {
    const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
    const imgEmpty = $('#imgEmpty');
    const imgWork = $('#imgWork');

    const imgGrid = createGrid($('#imgGrid'), {
      selectable: false,
      onChange(items) {
        imgEmpty.hidden = items.length > 0;
        imgWork.hidden = items.length === 0;
        $('#imgCount').textContent = items.length + (items.length === 1 ? ' image' : ' images');
        $('#imgCreate').disabled = items.length === 0;
      },
    });

    // Reads the EXIF orientation tag; 1 (or no tag) means the pixels are already upright.
    async function jpegOrientation(file) {
      const view = new DataView(await file.slice(0, 131072).arrayBuffer());
      if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00) return 1;
        if (marker === 0xffe1 && offset + 18 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
          const tiff = offset + 10;
          const little = view.getUint16(tiff) === 0x4949;
          const dir = tiff + view.getUint32(tiff + 4, little);
          if (dir + 2 > view.byteLength) return 1;
          const entries = view.getUint16(dir, little);
          for (let i = 0; i < entries; i++) {
            const entry = dir + 2 + i * 12;
            if (entry + 12 > view.byteLength) return 1;
            if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
          }
          return 1;
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return 1;
    }

    function drawRotated(bitmap, rotation) {
      const swap = rotation === 90 || rotation === 270;
      const canvas = el('canvas', { width: swap ? bitmap.height : bitmap.width, height: swap ? bitmap.width : bitmap.height });
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((rotation * Math.PI) / 180);
      context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      return canvas;
    }

    // PNG and upright JPEG files are embedded untouched; everything else is redrawn as JPEG.
    async function imageForPdf(item) {
      const bitmap = await createImageBitmap(item.file);
      const direct = !item.rotation && (item.file.type === 'image/png' || (item.file.type === 'image/jpeg' && (await jpegOrientation(item.file)) <= 1));
      if (direct) {
        return { bytes: await item.file.arrayBuffer(), png: item.file.type === 'image/png', width: bitmap.width, height: bitmap.height };
      }
      const canvas = drawRotated(bitmap, item.rotation);
      const blob = await canvasBlob(canvas, 'image/jpeg', 0.92);
      return { bytes: await blob.arrayBuffer(), png: false, width: canvas.width, height: canvas.height };
    }

    async function addImages(files) {
      const items = [];
      for (const file of files) {
        if (!/^image\//.test(file.type)) { toast(file.name + ' is not an image.', true); continue; }
        try {
          await createImageBitmap(file); // confirms the browser can decode it
          const thumb = el('img', { alt: '', src: URL.createObjectURL(file), draggable: false });
          items.push({ file: file, label: file.name, thumb: thumb });
        } catch (err) {
          toast('This browser cannot open ' + file.name + '.', true);
        }
      }
      if (!items.length) return;
      if (imgGrid.items.length === 0) $('#imgName').value = safeName(baseName(items[0].file.name), 'images');
      imgGrid.add(items);
    }

    async function imagesToPdf(items) {
      await load('pdflib');
      const out = await window.PDFLib.PDFDocument.create();
      const sizeKey = $('#imgSize').value;
      const orientation = $('#imgOrient').value;
      const margin = Number($('#imgMargin').value);

      for (const item of items) {
        const image = await imageForPdf(item);
        const embedded = image.png ? await out.embedPng(image.bytes) : await out.embedJpg(image.bytes);
        let pageWidth;
        let pageHeight;
        if (sizeKey === 'fit') {
          pageWidth = image.width * 0.75 + margin * 2; // 96 px per inch → 72 pt per inch
          pageHeight = image.height * 0.75 + margin * 2;
        } else {
          const [short, long] = PAGE_SIZES[sizeKey];
          const landscape = orientation === 'landscape' || (orientation === 'auto' && image.width > image.height);
          pageWidth = landscape ? long : short;
          pageHeight = landscape ? short : long;
        }
        const scale = Math.min((pageWidth - margin * 2) / image.width, (pageHeight - margin * 2) / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        out.addPage([pageWidth, pageHeight]).drawImage(embedded, {
          x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width: width, height: height,
        });
      }
      return new Blob([await out.save()], { type: PDF_TYPE });
    }

    bindFiles($('#imgDrop'), $('#imgFile'), addImages);
    bindFiles(null, $('#imgFileMore'), addImages);
    dropFiles(imgWork, addImages);
    $('#imgAdd').addEventListener('click', () => $('#imgFileMore').click());
    $('#imgClear').addEventListener('click', () => imgGrid.clear());
    $('#imgSize').addEventListener('change', () => { $('#imgOrient').disabled = $('#imgSize').value === 'fit'; });
    $('#imgCreate').addEventListener('click', function () {
      withBusy(this, 'Creating…', async () => {
        try {
          const name = safeName($('#imgName').value, 'images') + '.pdf';
          downloadBlob(await imagesToPdf(imgGrid.items), name);
          toast('Downloaded ' + name);
        } catch (err) {
          console.error(err);
          toast('Could not create the PDF. One of the images may be damaged.', true);
        }
      });
    });
  });

  /* ---------- PDF → Images ---------- */

  section('pdf-to-images', () => {
    const p2iProgress = $('#p2iProgress');
    const p2iResults = $('#p2iResults');
    let p2iFile = null; // { name, bytes, pages }
    let p2iImages = []; // { name, blob }

    function showP2iFile() {
      $('#p2iDrop').hidden = !!p2iFile;
      $('#p2iFileCard').hidden = !p2iFile;
      $('#p2iRun').disabled = !p2iFile;
      $('#p2iZip').hidden = true;
      p2iResults.replaceChildren();
      p2iImages = [];
      if (!p2iFile) return;
      $('#p2iFileName').textContent = p2iFile.name;
      $('#p2iFileMeta').textContent = p2iFile.pages + (p2iFile.pages === 1 ? ' page · ' : ' pages · ') + formatSize(p2iFile.bytes.length);
    }

    async function loadP2iFile(files) {
      const file = files[0];
      if (!isPdf(file)) { toast('Please choose a PDF file.', true); return; }
      try {
        const bytes = await readBytes(file);
        const doc = await openPdf(bytes);
        p2iFile = { name: file.name, bytes: bytes, pages: doc.numPages };
        doc.destroy();
        showP2iFile();
      } catch (err) {
        pdfError(err, file.name);
      }
    }

    bindFiles($('#p2iDrop'), $('#p2iFile'), loadP2iFile);
    $('#p2iChange').addEventListener('click', () => { p2iFile = null; showP2iFile(); });

    $('#p2iRun').addEventListener('click', function () {
      if (!p2iFile) return;
      const file = p2iFile;
      const png = $('#p2iFormat').value === 'png';
      const dpi = Number($('#p2iDpi').value);
      const base = safeName(baseName(file.name), 'document');

      withBusy(this, 'Converting…', async () => {
        let doc;
        p2iResults.replaceChildren();
        p2iImages = [];
        $('#p2iZip').hidden = true;
        try {
          doc = await openPdf(file.bytes);
          const digits = String(doc.numPages).length;
          setProgress(p2iProgress, 0);
          for (let n = 1; n <= doc.numPages; n++) {
            const canvas = await renderPage(await doc.getPage(n), dpi / 72);
            const blob = await canvasBlob(canvas, png ? 'image/png' : 'image/jpeg', 0.9);
            const image = { name: base + '-page-' + String(n).padStart(digits, '0') + (png ? '.png' : '.jpg'), blob: blob };
            p2iImages.push(image);

            const save = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: 'Download' });
            save.addEventListener('click', () => downloadBlob(image.blob, image.name));
            p2iResults.appendChild(el('div', { className: 'pg-card pg-static' }, [
              el('div', { className: 'pg-thumb' }, [el('img', { alt: 'Page ' + n, src: URL.createObjectURL(blob) })]),
              el('div', { className: 'pg-meta' }, [
                el('span', { className: 'pg-num', textContent: String(n) }),
                el('span', { className: 'pg-label', textContent: canvas.width + ' × ' + canvas.height + ' · ' + formatSize(blob.size) }),
              ]),
              save,
            ]));
            canvas.width = canvas.height = 0;
            setProgress(p2iProgress, n / doc.numPages);
          }
          $('#p2iZip').hidden = false;
          $('#p2iZip').querySelector('span').textContent = p2iImages.length === 1 ? 'Download image' : 'Download all (ZIP)';
          toast('Converted ' + p2iImages.length + (p2iImages.length === 1 ? ' page' : ' pages'));
        } catch (err) {
          console.error(err);
          toast('Conversion failed. Try a lower quality setting.', true);
        } finally {
          setProgress(p2iProgress, null);
          if (doc) doc.destroy();
        }
      });
    });

    $('#p2iZip').addEventListener('click', function () {
      if (!p2iImages.length) return;
      if (p2iImages.length === 1) { downloadBlob(p2iImages[0].blob, p2iImages[0].name); return; }
      withBusy(this, 'Zipping…', async () => {
        try {
          const name = safeName(baseName(p2iFile.name), 'document') + '-images.zip';
          downloadBlob(await zipBlob(p2iImages), name);
          toast('Downloaded ' + name);
        } catch (err) {
          console.error(err);
          toast('Could not create the ZIP file.', true);
        }
      });
    });
  });
})();
