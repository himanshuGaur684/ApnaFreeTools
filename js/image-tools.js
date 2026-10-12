(function () {
  'use strict';

  const {
    $, toast, downloadBlob, safeName, baseName, withBusy,
    formatSize, el, canvasBlob, zipBlob, bindFiles, setProgress, initTabs,
    section, preset,
  } = Aft;

  const MAX_PIXELS = 16000000; // stays under the canvas limit of mobile browsers
  const FORMATS = {
    jpg: { mime: 'image/jpeg', ext: '.jpg' },
    png: { mime: 'image/png', ext: '.png' },
    webp: { mime: 'image/webp', ext: '.webp' },
  };

  initTabs();

  /* ---------- image engine ---------- */

  function formatOf(file) {
    if (file.type === 'image/png') return 'png';
    if (file.type === 'image/webp') return 'webp';
    return 'jpg';
  }

  // Decodes a file into a canvas (the browser applies the photo's EXIF rotation).
  async function loadCanvas(file) {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = el('canvas', { width: Math.max(1, Math.round(bitmap.width * k)), height: Math.max(1, Math.round(bitmap.height * k)) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return canvas;
  }

  // Resamples (optionally from a crop rectangle). Large reductions are done in halving steps,
  // which keeps small outputs such as form photos sharp.
  function scaled(source, width, height, crop) {
    const c = crop || { x: 0, y: 0, w: source.width, h: source.height };
    let current = source;
    let from = c;
    while (from.w / 2 > width && from.h / 2 > height) {
      const half = el('canvas', { width: Math.ceil(from.w / 2), height: Math.ceil(from.h / 2) });
      const context = half.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(current, from.x, from.y, from.w, from.h, 0, 0, half.width, half.height);
      current = half;
      from = { x: 0, y: 0, w: half.width, h: half.height };
    }
    const out = el('canvas', { width: width, height: height });
    const context = out.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(current, from.x, from.y, from.w, from.h, 0, 0, width, height);
    return out;
  }

  // JPEG has no transparency, so transparent areas are filled with white.
  function flatten(canvas) {
    const out = el('canvas', { width: canvas.width, height: canvas.height });
    const context = out.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, out.width, out.height);
    context.drawImage(canvas, 0, 0);
    return out;
  }

  function rotate90(canvas) {
    const out = el('canvas', { width: canvas.height, height: canvas.width });
    const context = out.getContext('2d');
    context.translate(out.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(canvas, 0, 0);
    return out;
  }

  async function encode(canvas, format, quality) {
    const blob = await canvasBlob(canvas, FORMATS[format].mime, quality);
    if (blob.type !== FORMATS[format].mime) throw new Error('unsupported-format');
    return blob;
  }

  // Finds the best quality that fits maxBytes. When allowShrink is set the image is also made
  // smaller in pixels rather than dropping to very low quality; otherwise the pixel size is kept.
  async function fitToSize(canvas, format, maxBytes, allowShrink) {
    let work = canvas;
    let last = null;
    for (let round = 0; round < 10; round++) {
      if (format === 'png') {
        last = await encode(work, format);
        if (last.size <= maxBytes) return { blob: last, canvas: work, reached: true };
      } else {
        let low = allowShrink ? 0.4 : 0.05;
        let high = 0.95;
        const top = await encode(work, format, high);
        if (top.size <= maxBytes) return { blob: top, canvas: work, reached: true };
        last = await encode(work, format, low);
        if (last.size <= maxBytes) {
          let best = last;
          for (let i = 0; i < 7; i++) {
            const mid = (low + high) / 2;
            const blob = await encode(work, format, mid);
            if (blob.size <= maxBytes) { best = blob; low = mid; } else high = mid;
          }
          return { blob: best, canvas: work, reached: true };
        }
      }
      if (!allowShrink) break;
      const k = Math.max(0.5, Math.min(0.9, Math.sqrt(maxBytes / last.size)));
      if (work.width * k < 16 || work.height * k < 16) break;
      work = scaled(work, Math.round(work.width * k), Math.round(work.height * k));
    }
    return { blob: last, canvas: work, reached: false };
  }

  // Writes the DPI into the JPEG header and, when a form demands a minimum file size,
  // pads the file with a comment block (which does not change the picture).
  async function finishJpeg(blob, dpi, minBytes) {
    const head = new Uint8Array(await blob.slice(0, 20).arrayBuffer());
    const hasJfif = head.length === 20 && head[2] === 0xff && head[3] === 0xe0 &&
      head[6] === 0x4a && head[7] === 0x46 && head[8] === 0x49 && head[9] === 0x46;
    const insertAt = hasJfif ? Math.max(20, 4 + ((head[4] << 8) | head[5])) : 2;
    if (hasJfif && dpi) {
      head[13] = 1; // density unit: dots per inch
      head[14] = head[16] = dpi >> 8;
      head[15] = head[17] = dpi & 255;
    }
    const parts = hasJfif ? [head, blob.slice(20, insertAt)] : [blob.slice(0, 2)];
    let need = (minBytes || 0) - blob.size;
    while (need > 0) {
      const body = Math.min(65533, Math.max(need - 4, 1));
      const segment = new Uint8Array(body + 4).fill(0x20);
      segment.set([0xff, 0xfe, (body + 2) >> 8, (body + 2) & 255]);
      parts.push(segment);
      need -= body + 4;
    }
    parts.push(blob.slice(insertAt));
    return new Blob(parts, { type: 'image/jpeg' });
  }

  function encodeError(err, format) {
    console.error(err);
    if (err && err.message === 'unsupported-format') toast('This browser cannot save ' + format.toUpperCase() + ' images. Choose another format.', true);
    else toast('Something went wrong with that image. Please try another file.', true);
  }

  /* ---------- batch tools (Compress & Resize, Convert) ---------- */

  async function processImage(file, options) {
    const source = await loadCanvas(file);
    const format = options.format === 'keep' ? formatOf(file) : options.format;
    let k = 1;
    if (options.resize === 'fit') {
      k = Math.min(options.width ? options.width / source.width : Infinity, options.height ? options.height / source.height : Infinity);
      if (!isFinite(k) || k > 1) k = 1; // never enlarge
    } else if (options.resize === 'percent') {
      k = options.percent / 100;
    }
    let canvas = k === 1 ? source : scaled(source, Math.max(1, Math.round(source.width * k)), Math.max(1, Math.round(source.height * k)));
    if (format === 'jpg') canvas = flatten(canvas);

    let result;
    if (options.targetBytes) result = await fitToSize(canvas, format, options.targetBytes, true);
    else result = { blob: await encode(canvas, format, options.quality), canvas: canvas, reached: true };
    return {
      name: safeName(baseName(file.name), 'image') + (options.suffix || '') + FORMATS[format].ext,
      blob: result.blob, width: result.canvas.width, height: result.canvas.height,
      original: file.size, reached: result.reached,
    };
  }

  function resultCard(result) {
    const save = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: 'Download' });
    save.addEventListener('click', () => downloadBlob(result.blob, result.name));
    const change = result.blob.size < result.original
      ? ' (' + Math.round((1 - result.blob.size / result.original) * 100) + '% smaller)'
      : '';
    return el('div', { className: 'pg-card pg-static' }, [
      el('div', { className: 'pg-thumb' }, [el('img', { alt: '', src: URL.createObjectURL(result.blob) })]),
      el('div', { className: 'pg-meta' }, [el('span', { className: 'pg-label pg-name', textContent: result.name, title: result.name })]),
      el('div', { className: 'pg-meta pg-sub' }, [el('span', { className: 'pg-label', textContent: formatSize(result.original) + ' → ' + formatSize(result.blob.size) + change })]),
      el('div', { className: 'pg-meta pg-sub' }, [el('span', { className: 'pg-label', textContent: result.width + ' × ' + result.height + ' px' + (result.reached ? '' : ' · target not reached') })]),
      save,
    ]);
  }

  // One batch tool: a dropzone, a file summary, a run button and a results grid.
  function batchTool(prefix, readOptions, zipSuffix) {
    const q = (name) => $('#' + prefix + name);
    let files = [];
    let results = [];

    function show() {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      q('Drop').hidden = files.length > 0;
      q('FileCard').hidden = files.length === 0;
      q('Run').disabled = files.length === 0;
      q('FileName').textContent = files.length === 1 ? files[0].name : files.length + ' images';
      q('FileMeta').textContent = formatSize(total) + (files.length === 1 ? '' : ' in total');
    }

    function reset() {
      results = [];
      q('Results').replaceChildren();
      q('Zip').hidden = true;
    }

    bindFiles(q('Drop'), q('File'), (picked) => {
      const images = picked.filter((file) => /^image\//.test(file.type));
      if (images.length < picked.length) toast('Only image files can be added.', true);
      if (!images.length) return;
      files = images;
      reset();
      show();
    });
    q('Change').addEventListener('click', () => { files = []; reset(); show(); });

    q('Run').addEventListener('click', function () {
      const options = readOptions();
      if (!options) return;
      const batch = files;
      withBusy(this, 'Working…', async () => {
        reset();
        setProgress(q('Progress'), 0);
        let missed = 0;
        try {
          for (let i = 0; i < batch.length; i++) {
            try {
              const result = await processImage(batch[i], options);
              results.push(result);
              if (!result.reached) missed++;
              q('Results').appendChild(resultCard(result));
            } catch (err) {
              if (err && err.message === 'unsupported-format') throw err;
              console.error(err);
              toast('Could not open ' + batch[i].name + '.', true);
            }
            setProgress(q('Progress'), (i + 1) / batch.length);
          }
          if (results.length) {
            q('Zip').hidden = false;
            q('Zip').querySelector('span').textContent = results.length === 1 ? 'Download image' : 'Download all (ZIP)';
            q('Results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            if (missed) toast(missed + (missed === 1 ? ' image' : ' images') + ' could not reach the target size.', true);
            else toast('Done: ' + results.length + (results.length === 1 ? ' image' : ' images'));
          }
        } catch (err) {
          encodeError(err, options.format);
        } finally {
          setProgress(q('Progress'), null);
        }
      });
    });

    q('Zip').addEventListener('click', function () {
      if (!results.length) return;
      if (results.length === 1) { downloadBlob(results[0].blob, results[0].name); return; }
      withBusy(this, 'Zipping…', async () => {
        try {
          // Two inputs can produce the same output name, so repeats get a number.
          const seen = new Map();
          const entries = results.map((result) => {
            const n = seen.get(result.name) || 0;
            seen.set(result.name, n + 1);
            return { name: n ? result.name.replace(/(\.[^.]+)$/, '-' + (n + 1) + '$1') : result.name, blob: result.blob };
          });
          downloadBlob(await zipBlob(entries), zipSuffix + '.zip');
          toast('Downloaded ' + zipSuffix + '.zip');
        } catch (err) {
          console.error(err);
          toast('Could not create the ZIP file.', true);
        }
      });
    });

    show();
  }

  // Chips where one is active; the "Custom" chip (no data-kb) reveals a number field.
  function sizeChips(chipsId, fieldId) {
    const chips = $(chipsId);
    const field = $(fieldId);
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      field.hidden = chip.dataset.kb !== undefined;
      if (!field.hidden) field.focus();
      chips.dispatchEvent(new Event('change'));
    });
    return () => {
      const chip = chips.querySelector('.chip.is-active');
      const kb = chip.dataset.kb !== undefined ? Number(chip.dataset.kb) : Number(field.value);
      return { custom: chip.dataset.kb === undefined, bytes: kb > 0 ? kb * 1024 : 0 };
    };
  }

  function bindRange(inputId, outputId) {
    const sync = () => { $(outputId).textContent = $(inputId).value + '%'; };
    $(inputId).addEventListener('input', sync);
    sync();
  }

  /* ---------- Compress & Resize ---------- */

  section('compress', () => {
    const icTarget = sizeChips('#icChips', '#icTarget');
    const syncIc = () => {
      $('#icQualityRow').hidden = icTarget().bytes > 0 || icTarget().custom || $('#icFormat').value === 'png';
      $('#icFitRow').hidden = $('#icResize').value !== 'fit';
      $('#icPercentRow').hidden = $('#icResize').value !== 'percent';
    };
    ['#icChips', '#icResize', '#icFormat'].forEach((id) => $(id).addEventListener('change', syncIc));
    bindRange('#icQuality', '#icQualityValue');
    // A page such as "Resize image to 20 KB" starts with that size selected.
    const presetChip = preset('targetKb') && document.querySelector('#icChips .chip[data-kb="' + preset('targetKb') + '"]');
    if (presetChip) presetChip.click();
    syncIc();

    batchTool('ic', () => {
      const target = icTarget();
      const options = {
        format: $('#icFormat').value,
        resize: $('#icResize').value,
        width: Number($('#icW').value) || 0,
        height: Number($('#icH').value) || 0,
        percent: Number($('#icPct').value) || 0,
        targetBytes: target.bytes,
        quality: Number($('#icQuality').value) / 100,
      };
      if (target.custom && !target.bytes) { toast('Enter a target size in KB.', true); $('#icTarget').focus(); return null; }
      if (options.resize === 'fit' && !options.width && !options.height) { toast('Enter a width or a height.', true); $('#icW').focus(); return null; }
      if (options.resize === 'percent' && (options.percent < 1 || options.percent > 400)) { toast('Enter a percentage between 1 and 400.', true); $('#icPct').focus(); return null; }
      return options;
    }, 'compressed-images');
  });

  /* ---------- Convert ---------- */

  section('convert', () => {
    const syncCv = () => { $('#cvQualityRow').hidden = $('#cvFormat').value === 'png'; };
    $('#cvFormat').addEventListener('change', syncCv);
    bindRange('#cvQuality', '#cvQualityValue');
    if (preset('format')) $('#cvFormat').value = preset('format');
    syncCv();

    batchTool('cv', () => ({
      format: $('#cvFormat').value,
      resize: 'none',
      quality: Number($('#cvQuality').value) / 100,
    }), 'converted-images');
  });

  /* ---------- crop box ---------- */

  function createCropper(stage, onChange) {
    let source = null;
    let aspect = null;
    let rect = null; // in source pixels
    const wrap = el('div', { className: 'crop-wrap' });
    const box = el('div', { className: 'crop-box' });
    // The dimmed area outside the box is a separate clipped layer, so the handles can overhang the image edge.
    const hole = el('i');
    const shade = el('div', { className: 'crop-shade' }, [hole]);
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((handle) => {
      const dot = el('span', { className: 'crop-h' });
      dot.dataset.h = handle;
      box.appendChild(dot);
    });

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    function layout() {
      [box, hole].forEach((node) => {
        node.style.left = (rect.x / source.width) * 100 + '%';
        node.style.top = (rect.y / source.height) * 100 + '%';
        node.style.width = (rect.w / source.width) * 100 + '%';
        node.style.height = (rect.h / source.height) * 100 + '%';
      });
      onChange();
    }

    function fit() {
      const W = source.width;
      const H = source.height;
      if (aspect) {
        const w = Math.min(W, H * aspect);
        rect = { x: (W - w) / 2, y: (H - w / aspect) / 2, w: w, h: w / aspect };
      } else {
        rect = { x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 };
      }
      layout();
    }

    function drag(handle, start, dx, dy) {
      const W = source.width;
      const H = source.height;
      const min = Math.min(24, W, H);
      if (handle === 'move') {
        return { x: clamp(start.x + dx, 0, W - start.w), y: clamp(start.y + dy, 0, H - start.h), w: start.w, h: start.h };
      }
      const west = handle.includes('w');
      const east = handle.includes('e');
      const north = handle.includes('n');
      const south = handle.includes('s');
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (west) left = clamp(left + dx, 0, right - min);
      if (east) right = clamp(right + dx, left + min, W);
      if (north) top = clamp(top + dy, 0, bottom - min);
      if (south) bottom = clamp(bottom + dy, top + min, H);

      if (aspect) {
        // The dragged side sets one dimension; the other follows the ratio, anchored opposite the handle.
        let w = right - left;
        let h = bottom - top;
        if (handle === 'n' || handle === 's') w = h * aspect; else h = w / aspect;
        const ax = west ? right : east ? left : (left + right) / 2;
        const ay = north ? bottom : south ? top : (top + bottom) / 2;
        const maxW = west ? ax : east ? W - ax : 2 * Math.min(ax, W - ax);
        const maxH = north ? ay : south ? H - ay : 2 * Math.min(ay, H - ay);
        const k = Math.min(1, maxW / w, maxH / h);
        w *= k;
        h *= k;
        left = west ? ax - w : east ? ax : ax - w / 2;
        top = north ? ay - h : south ? ay : ay - h / 2;
        right = left + w;
        bottom = top + h;
      }
      return { x: left, y: top, w: right - left, h: bottom - top };
    }

    box.addEventListener('pointerdown', (e) => {
      if (!source) return;
      e.preventDefault();
      const handle = e.target.dataset.h || 'move';
      const start = Object.assign({}, rect);
      const k = source.width / wrap.getBoundingClientRect().width;
      const move = (ev) => {
        rect = drag(handle, start, (ev.clientX - e.clientX) * k, (ev.clientY - e.clientY) * k);
        layout();
      };
      const end = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', end);
        box.removeEventListener('pointercancel', end);
      };
      box.setPointerCapture(e.pointerId);
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
    });

    const api = {
      get source() { return source; },
      // Whole source pixels, kept inside the image.
      get rect() {
        if (!source) return null;
        const x = clamp(Math.round(rect.x), 0, source.width - 1);
        const y = clamp(Math.round(rect.y), 0, source.height - 1);
        return { x: x, y: y, w: clamp(Math.round(rect.w), 1, source.width - x), h: clamp(Math.round(rect.h), 1, source.height - y) };
      },
      setSource(canvas) {
        source = canvas;
        wrap.replaceChildren(canvas, shade, box);
        stage.replaceChildren(wrap);
        fit();
      },
      setAspect(ratio) {
        aspect = ratio > 0 ? ratio : null;
        if (source) fit();
      },
      rotate() {
        if (source) api.setSource(rotate90(source));
      },
      clear() {
        source = null;
        stage.replaceChildren();
        onChange();
      },
    };
    return api;
  }

  // Shared "pick one image, show it in a cropper" wiring for the Crop and Form photo tabs.
  function cropSource(prefix, cropper, onLoad) {
    const q = (name) => $('#' + prefix + name);
    let name = '';
    const show = () => {
      q('Drop').hidden = !!cropper.source;
      q('Editor').hidden = !cropper.source;
    };
    bindFiles(q('Drop'), q('File'), async (files) => {
      const file = files[0];
      if (!/^image\//.test(file.type)) { toast('Please choose an image file.', true); return; }
      try {
        cropper.setSource(await loadCanvas(file));
        name = safeName(baseName(file.name), 'image');
        show();
        if (onLoad) onLoad();
      } catch (err) {
        console.error(err);
        toast('This browser cannot open ' + file.name + '.', true);
      }
    });
    q('Rotate').addEventListener('click', () => cropper.rotate());
    q('Change').addEventListener('click', () => { cropper.clear(); show(); });
    show();
    return () => name;
  }

  /* ---------- Crop ---------- */

  section('crop', () => {
    const crCropper = createCropper($('#crStage'), () => {
      const rect = crCropper.rect;
      $('#crDownload').disabled = !rect;
      $('#crInfo').textContent = rect ? rect.w + ' × ' + rect.h + ' px' : '';
    });
    const crName = cropSource('cr', crCropper);

    $('#crRatios').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $('#crRatios').querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      crCropper.setAspect(Number(chip.dataset.ratio));
    });

    $('#crDownload').addEventListener('click', function () {
      const rect = crCropper.rect;
      if (!rect) return;
      const format = $('#crFormat').value;
      withBusy(this, 'Cropping…', async () => {
        try {
          let canvas = scaled(crCropper.source, rect.w, rect.h, rect);
          if (format === 'jpg') canvas = flatten(canvas);
          const name = crName() + '-cropped' + FORMATS[format].ext;
          downloadBlob(await encode(canvas, format, 0.92), name);
          toast('Downloaded ' + name);
        } catch (err) {
          encodeError(err, format);
        }
      });
    });
  });

  /* ---------- Form photo & signature ---------- */

  section('form-photo', () => {
    // Common sizes; every value stays editable because forms differ.
    const PRESETS = {
      'passport-35x45': { w: 35, h: 45, unit: 'mm', dpi: 300, min: '', max: '' },
      'passport-2x2': { w: 2, h: 2, unit: 'in', dpi: 300, min: '', max: '' },
      'photo-25x35': { w: 25, h: 35, unit: 'mm', dpi: 300, min: '', max: '' },
      'stamp-20x25': { w: 20, h: 25, unit: 'mm', dpi: 300, min: '', max: '' },
      'exam-photo': { w: 200, h: 230, unit: 'px', dpi: 200, min: 20, max: 50 },
      'exam-signature': { w: 140, h: 60, unit: 'px', dpi: 200, min: 10, max: 20 },
      'signature-wide': { w: 300, h: 100, unit: 'px', dpi: 200, min: '', max: 30 },
    };
    const UNIT_PER_INCH = { mm: 25.4, cm: 2.54, in: 1 };
    const phFields = ['#phW', '#phH', '#phUnit', '#phDpi', '#phMin', '#phMax'];
    let phOutput = null;

    function phSize() {
      const unit = $('#phUnit').value;
      const dpi = Number($('#phDpi').value) || 0;
      const toPx = (value) => (unit === 'px' ? Math.round(value) : Math.round((value / UNIT_PER_INCH[unit]) * dpi));
      const size = { w: toPx(Number($('#phW').value) || 0), h: toPx(Number($('#phH').value) || 0), dpi: dpi };
      return size.w >= 10 && size.h >= 10 && size.w <= 6000 && size.h <= 6000 ? size : null;
    }

    const phCropper = createCropper($('#phStage'), () => syncPh(false));
    const phName = cropSource('ph', phCropper, () => syncPh(true));

    function syncPh(resetCrop) {
      const size = phSize();
      $('#phInfo').textContent = size ? 'Output: ' + size.w + ' × ' + size.h + ' px' : 'Enter a valid width and height.';
      $('#phCreate').disabled = !size || !phCropper.source;
      if (resetCrop && size) phCropper.setAspect(size.w / size.h);
    }

    function applyPreset() {
      const preset = PRESETS[$('#phPreset').value];
      if (preset) {
        $('#phW').value = preset.w;
        $('#phH').value = preset.h;
        $('#phUnit').value = preset.unit;
        $('#phDpi').value = preset.dpi;
        $('#phMin').value = preset.min;
        $('#phMax').value = preset.max;
      }
      $('#phResult').hidden = true;
      syncPh(true);
    }

    $('#phPreset').addEventListener('change', applyPreset);
    phFields.forEach((id) => $(id).addEventListener('input', () => {
      $('#phPreset').value = 'custom';
      $('#phResult').hidden = true;
      syncPh(id === '#phW' || id === '#phH' || id === '#phUnit' || id === '#phDpi');
    }));
    if (preset('photo')) $('#phPreset').value = preset('photo');
    applyPreset();

    $('#phCreate').addEventListener('click', function () {
      const size = phSize();
      const rect = phCropper.rect;
      if (!size || !rect) return;
      const minBytes = (Number($('#phMin').value) || 0) * 1024;
      const maxBytes = (Number($('#phMax').value) || 0) * 1024;
      if (minBytes && maxBytes && minBytes > maxBytes) { toast('The minimum size is larger than the maximum size.', true); return; }

      withBusy(this, 'Creating…', async () => {
        try {
          const canvas = flatten(scaled(phCropper.source, size.w, size.h, rect));
          let reached = true;
          let blob;
          if (maxBytes) ({ blob, reached } = await fitToSize(canvas, 'jpg', maxBytes, false));
          else blob = await encode(canvas, 'jpg', 0.92);
          const padded = minBytes > blob.size;
          blob = await finishJpeg(blob, size.dpi, minBytes);

          phOutput = { blob: blob, name: phName() + '-' + size.w + 'x' + size.h + '.jpg' };
          $('#phPreview').src = URL.createObjectURL(blob);
          $('#phSizes').textContent = size.w + ' × ' + size.h + ' px · ' + formatSize(blob.size);
          $('#phNote').textContent = !reached
            ? 'This is the smallest file possible at this pixel size, but it is still over ' + formatSize(maxBytes) + '. Try a smaller width and height.'
            : 'JPG' + (size.dpi ? ', ' + size.dpi + ' DPI' : '') + (maxBytes ? ', under ' + formatSize(maxBytes) : '') +
              (padded ? '. Padded to reach the ' + formatSize(minBytes) + ' minimum; the picture is unchanged.' : '.');
          $('#phResult').hidden = false;
          $('#phResult').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (err) {
          encodeError(err, 'jpg');
        }
      });
    });

    $('#phDownload').addEventListener('click', () => {
      if (!phOutput) return;
      downloadBlob(phOutput.blob, phOutput.name);
      toast('Downloaded ' + phOutput.name);
    });
  });
})();
