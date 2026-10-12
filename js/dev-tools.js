(function () {
  'use strict';

  const { $, el, toast, load, copyText, downloadBlob, textBlob, canvasBlob, formatSize, bindFiles, initTabs, debounce, section, preset } = Aft;

  initTabs();

  /* ---------- helpers ---------- */

  const encoder = new TextEncoder();

  function live(panelId, run) {
    const panel = $(panelId);
    panel.addEventListener('input', run);
    panel.addEventListener('change', run);
    run();
  }

  function chips(id) {
    const group = $(id);
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      group.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return () => group.querySelector('.chip.is-active').dataset.value;
  }

  function status(id, message, isError) {
    const node = $(id);
    node.textContent = message;
    node.classList.toggle('is-error', !!isError);
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomBytes(count) {
    return crypto.getRandomValues(new Uint8Array(count));
  }

  // Unbiased random integer in [0, max).
  function randomInt(max) {
    const limit = Math.floor(4294967296 / max) * max;
    const buffer = new Uint32Array(1);
    do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
    return buffer[0] % max;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(binary);
  }

  // Accepts standard and URL-safe Base64, with or without padding.
  function base64ToBytes(text) {
    let clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (clean.length % 4) clean += '=';
    const binary = atob(clean);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }

  // Any button with data-copy="#id" copies that element's value or text.
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-copy]');
    if (!button) return;
    const target = $(button.dataset.copy);
    const text = 'value' in target ? target.value : target.textContent;
    if (text.trim()) copyText(text);
    else toast('Nothing to copy yet.', true);
  });

  /* ---------- helpers used by more than one tool ---------- */

  // Browsers word JSON errors differently and often leave out the position, so this small
  // scanner finds the offset of the first character that breaks the JSON grammar.
  function jsonErrorIndex(s) {
    let i = 0;
    const skip = () => { while (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t') i++; };
    function string() {
      i++;
      for (;;) {
        const c = s[i];
        if (c === undefined || c < ' ') throw i;
        if (c === '"') { i++; return; }
        if (c !== '\\') { i++; continue; }
        if (/["\\/bfnrt]/.test(s[i + 1] || '')) i += 2;
        else if (s[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) i += 6;
        else throw i;
      }
    }
    function value() {
      skip();
      const c = s[i];
      if (c === '"') { string(); return; }
      if (c === '{' || c === '[') {
        const close = c === '{' ? '}' : ']';
        i++;
        skip();
        if (s[i] === close) { i++; return; }
        for (;;) {
          if (c === '{') {
            skip();
            if (s[i] !== '"') throw i;
            string();
            skip();
            if (s[i] !== ':') throw i;
            i++;
          }
          value();
          skip();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === close) { i++; return; }
          throw i;
        }
      }
      const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 400));
      if (!literal) throw i;
      i += literal[0].length;
    }
    try {
      value();
      skip();
      if (i < s.length) throw i;
      return -1;
    } catch (err) {
      if (typeof err === 'number') return err;
      throw err;
    }
  }
  function jsonErrorText(err, source) {
    const index = jsonErrorIndex(source);
    if (index < 0) return 'Invalid JSON: ' + String(err.message || err);
    const before = source.slice(0, index);
    const found = index >= source.length ? 'the text ends too early' : 'unexpected ' + JSON.stringify(source[index]);
    return 'Invalid JSON at line ' + before.split('\n').length + ', column ' + (index - before.lastIndexOf('\n')) + ': ' + found + '.';
  }
  function relativeTime(seconds) {
    const diff = seconds * 1000 - Date.now();
    const units = [['year', 31536000000], ['month', 2592000000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]];
    for (const [name, ms] of units) {
      const n = Math.floor(Math.abs(diff) / ms);
      if (n >= 1) return diff < 0 ? n + ' ' + name + (n === 1 ? '' : 's') + ' ago' : 'in ' + n + ' ' + name + (n === 1 ? '' : 's');
    }
    return diff < 0 ? 'just now' : 'in under a minute';
  }
  function zoneText(date, timeZone) {
    return date.toLocaleString('en-IN', {
      timeZone: timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  /* ---------- JSON formatter ---------- */

  section('json', () => {
    function sortKeys(value) {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => { out[key] = sortKeys(value[key]); return out; }, {});
      }
      return value;
    }

    function runJson(minify) {
      const source = $('#jsonInput').value;
      if (!source.trim()) {
        $('#jsonOutput').value = '';
        status('#jsonStatus', 'Paste JSON on the left to format it.');
        return;
      }
      try {
        let data = JSON.parse(source);
        if ($('#jsonSort').checked) data = sortKeys(data);
        const indent = $('#jsonIndent').value === 'tab' ? '\t' : Number($('#jsonIndent').value);
        $('#jsonOutput').value = minify ? JSON.stringify(data) : JSON.stringify(data, null, indent);
        const kind = Array.isArray(data) ? 'array of ' + data.length : data && typeof data === 'object' ? 'object with ' + Object.keys(data).length + ' keys' : typeof data;
        status('#jsonStatus', 'Valid JSON — ' + kind + ', ' + formatSize(encoder.encode($('#jsonOutput').value).length) + '.');
      } catch (err) {
        $('#jsonOutput').value = '';
        status('#jsonStatus', jsonErrorText(err, source), true);
      }
    }

    let jsonMinified = false;
    $('#jsonFormat').addEventListener('click', () => { jsonMinified = false; runJson(false); });
    $('#jsonMinify').addEventListener('click', () => { jsonMinified = true; runJson(true); });
    $('#jsonSample').addEventListener('click', () => {
      $('#jsonInput').value = '{"name":"ApnaFreeTools","free":true,"tools":["converter","pdf","images"],"stats":{"pages":7,"signup":null}}';
      jsonMinified = false;
      runJson(false);
    });
    $('#jsonDownload').addEventListener('click', () => {
      if (!$('#jsonOutput').value) { toast('Nothing to download yet.', true); return; }
      downloadBlob(textBlob($('#jsonOutput').value, 'application/json'), 'data.json');
    });
    live('#panel-json', () => runJson(jsonMinified));
  });

  /* ---------- Base64 ---------- */

  section('base64', () => {
    const b64Mode = chips('#b64Mode');

    live('#panel-base64', () => {
      const encoding = b64Mode() === 'encode';
      const source = $('#b64Input').value;
      $('#b64UrlSafeRow').hidden = !encoding;
      $('#b64FileRow').hidden = !encoding;
      $('#b64InputLabel').textContent = encoding ? 'Text to encode' : 'Base64 to decode';
      if (!source) { $('#b64Output').value = ''; status('#b64Status', ''); return; }
      try {
        if (encoding) {
          let out = bytesToBase64(encoder.encode(source));
          if ($('#b64UrlSafe').checked) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          $('#b64Output').value = out;
          status('#b64Status', out.length.toLocaleString() + ' characters.');
        } else {
          const bytes = base64ToBytes(source);
          $('#b64Output').value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          status('#b64Status', formatSize(bytes.length) + ' of text decoded.');
        }
      } catch (err) {
        $('#b64Output').value = '';
        status('#b64Status', encoding ? 'Could not encode that text.' : 'This is not valid Base64 text (it may be binary data such as an image).', true);
      }
    });

    bindFiles(null, $('#b64File'), async (files) => {
      const file = files[0];
      if (file.size > 20 * 1048576) { toast('Please choose a file under 20 MB.', true); return; }
      $('#b64Input').value = '';
      $('#b64Output').value = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      status('#b64Status', file.name + ' (' + formatSize(file.size) + ') encoded as Base64.');
    });
    $('#b64FileBtn').addEventListener('click', () => $('#b64File').click());
  });

  /* ---------- URL encode / decode ---------- */

  section('url', () => {
    const urlMode = chips('#urlMode');

    live('#panel-url', () => {
      const encoding = urlMode() === 'encode';
      const source = $('#urlInput').value;
      $('#urlFullLabel').textContent = encoding ? 'Whole URL (keep : / ? & = as they are)' : 'Treat + as a space';
      let output = '';
      try {
        if (encoding) output = $('#urlFull').checked ? encodeURI(source) : encodeURIComponent(source);
        else output = decodeURIComponent($('#urlFull').checked ? source.replace(/\+/g, ' ') : source);
        status('#urlStatus', '');
      } catch (err) {
        status('#urlStatus', 'This text has a broken % sequence and cannot be decoded.', true);
      }
      $('#urlOutput').value = output;

      // Break a full URL into its query parameters.
      let params = [];
      try {
        const candidate = encoding ? source : output;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate.trim())) params = Array.from(new URL(candidate.trim()).searchParams.entries());
      } catch (err) { /* not a URL */ }
      $('#urlParamsWrap').hidden = params.length === 0;
      $('#urlParams').replaceChildren(...params.map(([key, value]) => el('tr', {}, [el('td', { textContent: key }), el('td', { textContent: value })])));
    });
  });

  /* ---------- JWT decoder ---------- */

  section('jwt', () => {
    const TIME_CLAIMS = { exp: 'Expires', iat: 'Issued', nbf: 'Not valid before', auth_time: 'Signed in' };


    live('#panel-jwt', () => {
      const token = $('#jwtInput').value.trim().replace(/^Bearer\s+/i, '');
      const show = (ok) => { $('#jwtResult').hidden = !ok; };
      if (!token) { show(false); status('#jwtStatus', 'Paste a token to see what is inside it.'); return; }
      const parts = token.split('.');
      try {
        if (parts.length !== 3) throw new Error('A JWT has three parts separated by dots; this has ' + parts.length + '.');
        const decode = (part) => JSON.parse(new TextDecoder().decode(base64ToBytes(part)));
        const header = decode(parts[0]);
        const payload = decode(parts[1]);
        $('#jwtHeader').value = JSON.stringify(header, null, 2);
        $('#jwtPayload').value = JSON.stringify(payload, null, 2);
        $('#jwtSignature').textContent = parts[2] || '(none)';

        const rows = Object.keys(TIME_CLAIMS).filter((claim) => typeof payload[claim] === 'number').map((claim) => el('tr', {}, [
          el('td', { textContent: TIME_CLAIMS[claim] + ' (' + claim + ')' }),
          el('td', { textContent: new Date(payload[claim] * 1000).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' }) + ' — ' + relativeTime(payload[claim]) }),
        ]));
        $('#jwtClaims').replaceChildren(...rows);
        $('#jwtClaimsWrap').hidden = rows.length === 0;

        const expired = typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
        status('#jwtStatus', 'Decoded' + (header.alg ? ' — algorithm ' + header.alg : '') + (expired ? '. This token has expired.' : '.'), expired);
        show(true);
      } catch (err) {
        show(false);
        status('#jwtStatus', /three parts/.test(err.message) ? err.message : 'This does not look like a valid JWT.', true);
      }
    });
  });

  /* ---------- UUID generator ---------- */

  section('uuid', () => {
    function uuidFromBytes(bytes) {
      const h = hex(bytes);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }

    function uuidV4() {
      const bytes = randomBytes(16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return uuidFromBytes(bytes);
    }

    // Version 7: a millisecond timestamp followed by random bits, so IDs sort by creation time.
    function uuidV7() {
      const bytes = randomBytes(16);
      let time = Date.now();
      for (let i = 5; i >= 0; i--) { bytes[i] = time % 256; time = Math.floor(time / 256); }
      bytes[6] = (bytes[6] & 0x0f) | 0x70;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return uuidFromBytes(bytes);
    }

    const uuidVersion = chips('#uuidVersion');
    function makeUuids() {
      const count = Math.max(1, Math.min(500, Math.round(Number($('#uuidCount').value) || 1)));
      const list = [];
      for (let i = 0; i < count; i++) {
        let id = uuidVersion() === '7' ? uuidV7() : uuidV4();
        if (!$('#uuidHyphens').checked) id = id.replace(/-/g, '');
        if ($('#uuidUpper').checked) id = id.toUpperCase();
        list.push(id);
      }
      $('#uuidOutput').value = list.join('\n');
    }
    $('#uuidGenerate').addEventListener('click', makeUuids);
    live('#panel-uuid', makeUuids);
  });

  /* ---------- Hash generator ---------- */

  section('hash', () => {
    function md5(bytes) {
      const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
      const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
      const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
      padded.set(bytes);
      padded[bytes.length] = 0x80;
      const view = new DataView(padded.buffer);
      view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
      view.setUint32(padded.length - 4, Math.floor(bytes.length / 536870912), true);

      let a0 = 0x67452301;
      let b0 = 0xefcdab89;
      let c0 = 0x98badcfe;
      let d0 = 0x10325476;
      for (let offset = 0; offset < padded.length; offset += 64) {
        let A = a0;
        let B = b0;
        let C = c0;
        let D = d0;
        for (let i = 0; i < 64; i++) {
          const round = i >> 4;
          let F;
          let g;
          if (round === 0) { F = (B & C) | (~B & D); g = i; }
          else if (round === 1) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (round === 2) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
          F = (F + A + K[i] + view.getUint32(offset + g * 4, true)) >>> 0;
          A = D;
          D = C;
          C = B;
          const shift = S[round * 4 + (i % 4)];
          B = (B + ((F << shift) | (F >>> (32 - shift)))) >>> 0;
        }
        a0 = (a0 + A) >>> 0;
        b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0;
        d0 = (d0 + D) >>> 0;
      }
      const out = new DataView(new ArrayBuffer(16));
      [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
      return hex(new Uint8Array(out.buffer));
    }

    const HASHES = [['MD5', '#hashMd5'], ['SHA-1', '#hashSha1'], ['SHA-256', '#hashSha256'], ['SHA-512', '#hashSha512']];
    let hashRun = 0;

    async function showHashes(bytes) {
      const run = ++hashRun;
      const upper = $('#hashUpper').checked;
      for (const [name, id] of HASHES) {
        const value = name === 'MD5' ? md5(bytes) : hex(new Uint8Array(await crypto.subtle.digest(name, bytes)));
        if (run !== hashRun) return; // a newer input arrived
        $(id).textContent = upper ? value.toUpperCase() : value;
      }
    }

    let hashFileBytes = null;
    function runHash() {
      const bytes = hashFileBytes || encoder.encode($('#hashInput').value);
      showHashes(bytes).catch((err) => {
        console.error(err);
        toast('Hashing needs a secure (https) page in this browser.', true);
      });
    }
    $('#hashInput').addEventListener('input', () => { hashFileBytes = null; status('#hashStatus', ''); });
    bindFiles(null, $('#hashFile'), async (files) => {
      const file = files[0];
      if (file.size > 200 * 1048576) { toast('Please choose a file under 200 MB.', true); return; }
      hashFileBytes = new Uint8Array(await file.arrayBuffer());
      $('#hashInput').value = '';
      status('#hashStatus', 'Showing hashes of ' + file.name + ' (' + formatSize(file.size) + ').');
      runHash();
    });
    $('#hashFileBtn').addEventListener('click', () => $('#hashFile').click());
    live('#panel-hash', runHash);
  });

  /* ---------- Password generator ---------- */

  section('password', () => {
    const SETS = {
      '#pwUpper': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '#pwLower': 'abcdefghijklmnopqrstuvwxyz',
      '#pwDigits': '0123456789',
      '#pwSymbols': '!@#$%^&*()-_=+[]{};:,.?/',
    };
    const AMBIGUOUS = /[O0oIl1|]/g;

    function makePassword() {
      const length = Number($('#pwLength').value);
      $('#pwLengthValue').textContent = length;
      const sets = Object.keys(SETS).filter((id) => $(id).checked)
        .map((id) => ($('#pwNoAmbiguous').checked ? SETS[id].replace(AMBIGUOUS, '') : SETS[id]));
      if (!sets.length) {
        $('#pwOutput').textContent = '';
        status('#pwStrength', 'Tick at least one kind of character.', true);
        $('#pwMeter').firstElementChild.style.width = '0';
        return;
      }
      const all = sets.join('');
      let password;
      // Redraw until every ticked kind of character appears at least once.
      do {
        password = Array.from({ length: length }, () => all[randomInt(all.length)]).join('');
      } while (length >= sets.length && !sets.every((set) => Array.from(password).some((ch) => set.includes(ch))));

      const bits = Math.round(length * Math.log2(all.length));
      const label = bits < 45 ? 'Weak' : bits < 70 ? 'Fair' : bits < 100 ? 'Strong' : 'Very strong';
      $('#pwOutput').textContent = password;
      status('#pwStrength', label + ' — about ' + bits + ' bits of randomness.', bits < 45);
      $('#pwMeter').firstElementChild.style.width = Math.min(100, (bits / 128) * 100) + '%';
    }
    $('#pwGenerate').addEventListener('click', makePassword);
    live('#panel-password', makePassword);
  });

  /* ---------- QR code generator ---------- */

  section('qr', () => {
    const qrType = chips('#qrType');
    const qrCanvas = $('#qrCanvas');
    let qrModules = null; // { count, isDark(row, col) }

    function qrText() {
      const type = qrType();
      if (type === 'upi') {
        const id = $('#qrUpiId').value.trim();
        if (!id) return '';
        const params = new URLSearchParams({ pa: id });
        if ($('#qrUpiName').value.trim()) params.set('pn', $('#qrUpiName').value.trim());
        if (Number($('#qrUpiAmount').value) > 0) params.set('am', Number($('#qrUpiAmount').value).toFixed(2));
        if ($('#qrUpiNote').value.trim()) params.set('tn', $('#qrUpiNote').value.trim());
        params.set('cu', 'INR');
        return 'upi://pay?' + params.toString().replace(/\+/g, '%20').replace(/%40/g, '@'); // UPI IDs keep a literal @
      }
      if (type === 'wifi') {
        const name = $('#qrWifiName').value;
        if (!name) return '';
        const escape = (value) => value.replace(/([\\;,":])/g, '\\$1');
        const security = $('#qrWifiSecurity').value;
        return 'WIFI:T:' + security + ';S:' + escape(name) + ';' + (security === 'nopass' ? '' : 'P:' + escape($('#qrWifiPassword').value) + ';') + ';';
      }
      return $('#qrTextInput').value;
    }

    function drawQr() {
      const size = Number($('#qrSize').value);
      const margin = 4; // quiet zone, in modules
      const cell = size / (qrModules.count + margin * 2);
      qrCanvas.width = qrCanvas.height = size;
      const context = qrCanvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, size, size);
      context.fillStyle = '#000';
      for (let r = 0; r < qrModules.count; r++) {
        for (let c = 0; c < qrModules.count; c++) {
          if (!qrModules.isDark(r, c)) continue;
          const x = Math.round((c + margin) * cell);
          const y = Math.round((r + margin) * cell);
          context.fillRect(x, y, Math.round((c + margin + 1) * cell) - x, Math.round((r + margin + 1) * cell) - y);
        }
      }
    }

    function qrSvg() {
      const margin = 4;
      const total = qrModules.count + margin * 2;
      let path = '';
      for (let r = 0; r < qrModules.count; r++) {
        for (let c = 0; c < qrModules.count; c++) {
          if (qrModules.isDark(r, c)) path += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
        }
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
        '<rect width="100%" height="100%" fill="#fff"/><path d="' + path + '"/></svg>\n';
    }

    let qrRun = 0;
    async function makeQr() {
      const type = qrType();
      $('#qrTextFields').hidden = type !== 'text';
      $('#qrUpiFields').hidden = type !== 'upi';
      $('#qrWifiFields').hidden = type !== 'wifi';
      const text = qrText();
      const run = ++qrRun;
      const ready = (ok) => {
        $('#qrEmpty').hidden = ok;
        qrCanvas.hidden = !ok;
        $('#qrPng').disabled = $('#qrSvg').disabled = !ok;
      };
      if (!text) { qrModules = null; ready(false); status('#qrStatus', ''); return; }
      try {
        await load('qrcode');
        if (run !== qrRun) return;
        window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
        const qr = window.qrcode(0, $('#qrLevel').value);
        qr.addData(text);
        qr.make();
        qrModules = { count: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) };
        drawQr();
        ready(true);
        status('#qrStatus', type === 'text' ? '' : text);
      } catch (err) {
        console.error(err);
        qrModules = null;
        ready(false);
        status('#qrStatus', 'That is too much text for one QR code. Shorten it or lower the error correction.', true);
      }
    }

    $('#qrPng').addEventListener('click', async () => {
      if (qrModules) downloadBlob(await canvasBlob(qrCanvas, 'image/png'), 'qr-code.png');
    });
    $('#qrSvg').addEventListener('click', () => {
      if (qrModules) downloadBlob(textBlob(qrSvg(), 'image/svg+xml'), 'qr-code.svg');
    });
    if (preset('qrType')) $('#qrType').querySelector('[data-value="' + preset('qrType') + '"]').click();
    live('#panel-qr', makeQr);
  });

  /* ---------- JSON ↔ CSV and JSON ↔ YAML ---------- */

  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delimiter) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== '');
  }

  // Picks whichever of , ; tab | appears most in the first line.
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0];
    return [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  }

  // { a: { b: 1 } } → { "a.b": 1 }; arrays are kept as JSON text in one cell.
  function flatten(value, prefix, out) {
    Object.keys(value).forEach((key) => {
      const item = value[key];
      const name = prefix ? prefix + '.' + key : key;
      if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, name, out);
      else out[name] = Array.isArray(item) ? JSON.stringify(item) : item;
    });
    return out;
  }

  function jsonToCsv(source) {
    const data = JSON.parse(source);
    const list = Array.isArray(data) ? data : [data];
    const escape = (value) => {
      if (value == null) return '';
      const text = String(value);
      return /[",\r\n]|^\s|\s$/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    if (list.length && list.every(Array.isArray)) return list.map((row) => row.map(escape).join(',')).join('\n') + '\n';
    const rows = list.map((item) => (item && typeof item === 'object' ? flatten(item, '', {}) : { value: item }));
    const headers = [];
    rows.forEach((row) => Object.keys(row).forEach((key) => { if (!headers.includes(key)) headers.push(key); }));
    return [headers.map(escape).join(',')].concat(rows.map((row) => headers.map((h) => escape(row[h])).join(','))).join('\n') + '\n';
  }

  function csvToJson(source, typed) {
    const rows = parseCsv(source, detectDelimiter(source));
    if (!rows.length) throw new Error('There is no CSV data to convert.');
    const headers = rows[0].map((name, i) => name.trim() || 'column_' + (i + 1));
    // Numbers with leading zeros (PIN codes, phone numbers) stay as text.
    const convert = (value) => {
      if (!typed) return value;
      if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
      if (value === 'true' || value === 'false') return value === 'true';
      return value;
    };
    return JSON.stringify(rows.slice(1).map((row) => headers.reduce((item, name, i) => {
      item[name] = convert(row[i] == null ? '' : row[i]);
      return item;
    }, {})), null, 2) + '\n';
  }

  // Two-way converter panel: direction chips, input, output, status, sample and download.
  function converterPanel(prefix, sides, convert) {
    if (!$('#panel-' + prefix)) return; // this converter is not on the page
    const q = (name) => $('#' + prefix + name);
    const direction = chips('#' + prefix + 'Direction');
    let run = 0;

    async function update() {
      const forward = direction() === 'forward';
      const from = forward ? sides[0] : sides[1];
      const to = forward ? sides[1] : sides[0];
      q('InputLabel').textContent = from.label;
      q('OutputLabel').textContent = to.label;
      const options = q('Options');
      if (options) options.hidden = forward;
      const source = q('Input').value;
      const current = ++run;
      if (!source.trim()) { q('Output').value = ''; status('#' + prefix + 'Status', ''); return; }
      try {
        const output = await convert(source, forward);
        if (current !== run) return;
        q('Output').value = output;
        status('#' + prefix + 'Status', 'Converted to ' + to.label + ' — ' + formatSize(encoder.encode(output).length) + '.');
      } catch (err) {
        if (current !== run) return;
        q('Output').value = '';
        const jsonSide = from.label === 'JSON';
        status('#' + prefix + 'Status', jsonSide && err instanceof SyntaxError ? jsonErrorText(err, source) : 'Could not convert: ' + String(err.message || err).split('\n')[0], true);
      }
    }

    q('Sample').addEventListener('click', () => {
      q('Input').value = direction() === 'forward' ? sides[0].sample : sides[1].sample;
      update();
    });
    q('Swap').addEventListener('click', () => {
      if (!q('Output').value) { toast('Convert something first.', true); return; }
      q('Input').value = q('Output').value;
      $('#' + prefix + 'Direction').querySelector('.chip:not(.is-active)').click();
    });
    q('Download').addEventListener('click', () => {
      if (!q('Output').value) { toast('Nothing to download yet.', true); return; }
      const to = direction() === 'forward' ? sides[1] : sides[0];
      downloadBlob(textBlob(q('Output').value, to.mime), 'data' + to.ext);
    });
    live('#panel-' + prefix, update);
  }

  const SAMPLE_JSON = '[\n  { "name": "Asha", "city": "Pune", "pin": "411001", "active": true },\n  { "name": "Ravi", "city": "New Delhi", "pin": "110001", "active": false }\n]';
  const JSON_SIDE = { label: 'JSON', ext: '.json', mime: 'application/json', sample: SAMPLE_JSON };

  converterPanel('csv', [JSON_SIDE, { label: 'CSV', ext: '.csv', mime: 'text/csv', sample: 'name,city,pin,active\nAsha,Pune,411001,true\nRavi,"New Delhi",110001,false\n' }],
    (source, forward) => (forward ? jsonToCsv(source) : csvToJson(source, $('#csvTyped').checked)));

  converterPanel('yaml', [JSON_SIDE, { label: 'YAML', ext: '.yaml', mime: 'text/yaml', sample: 'site: ApnaFreeTools\nfree: true\ntools:\n  - name: converter\n    formats: [md, docx, pdf]\n  - name: calculators\n' }],
    async (source, forward) => {
      const data = forward ? JSON.parse(source) : null;
      await load('jsyaml');
      if (forward) return window.jsyaml.dump(data, { indent: 2, lineWidth: -1 });
      return JSON.stringify(window.jsyaml.load(source), null, 2) + '\n';
    });

  /* ---------- Text compare ---------- */

  section('diff', () => {
    const DIFF_CELL_LIMIT = 6000000; // rows × columns of the comparison table

    // Longest-common-subsequence diff. Returns [type, indexInA, indexInB] steps
    // where type is 0 (same), -1 (only in a) or 1 (only in b).
    function diffSequences(a, b) {
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start++;
      let endA = a.length;
      let endB = b.length;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

      const steps = [];
      for (let i = 0; i < start; i++) steps.push([0, i, i]);
      const n = endA - start;
      const m = endB - start;
      if (n * m > DIFF_CELL_LIMIT) {
        // Too large to align in detail: show the middle as removed then added.
        for (let i = 0; i < n; i++) steps.push([-1, start + i, -1]);
        for (let j = 0; j < m; j++) steps.push([1, -1, start + j]);
      } else if (n || m) {
        const width = m + 1;
        const table = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--) {
          for (let j = m - 1; j >= 0; j--) {
            table[i * width + j] = a[start + i] === b[start + j]
              ? table[(i + 1) * width + j + 1] + 1
              : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
          }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
          if (a[start + i] === b[start + j]) steps.push([0, start + i++, start + j++]);
          else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) steps.push([-1, start + i++, -1]);
          else steps.push([1, -1, start + j++]);
        }
        while (i < n) steps.push([-1, start + i++, -1]);
        while (j < m) steps.push([1, -1, start + j++]);
      }
      for (let i = endA, j = endB; i < a.length; i++, j++) steps.push([0, i, j]);
      return steps;
    }

    // Cell content for a changed line, with the words that differ wrapped in <b>.
    function inlineDiff(oldLine, newLine) {
      const split = (line) => line.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
      const a = split(oldLine);
      const b = split(newLine);
      const steps = a.length * b.length <= 250000 ? diffSequences(a, b) : null;
      const build = (tokens, side) => {
        if (!steps) return [document.createTextNode(tokens.join(''))];
        const nodes = [];
        steps.forEach(([type, i, j]) => {
          if (type === 0) nodes.push(document.createTextNode(side < 0 ? a[i] : b[j]));
          else if (type === side) nodes.push(el('b', { textContent: side < 0 ? a[i] : b[j] }));
        });
        return nodes;
      };
      return { old: build(a, -1), fresh: build(b, 1) };
    }

    const diffView = chips('#diffView');
    if (window.matchMedia('(max-width: 820px)').matches) $('#diffView').querySelector('[data-value="unified"]').click();

    function runDiff() {
      const lines = (id) => ($(id).value === '' ? [] : $(id).value.replace(/\r\n?/g, '\n').split('\n'));
      const oldLines = lines('#diffOld');
      const newLines = lines('#diffNew');
      const key = (line) => {
        let k = line;
        if ($('#diffSpace').checked) k = k.replace(/\s+/g, ' ').trim();
        if ($('#diffCase').checked) k = k.toLowerCase();
        return k;
      };
      const steps = diffSequences(oldLines.map(key), newLines.map(key));

      // Pair each run of removed lines with the added lines that follow it: those are "changed" lines.
      const rows = [];
      let i = 0;
      while (i < steps.length) {
        if (steps[i][0] === 0) { rows.push({ type: 'same', a: steps[i][1], b: steps[i][2] }); i++; continue; }
        const removed = [];
        const added = [];
        while (i < steps.length && steps[i][0] !== 0) { (steps[i][0] < 0 ? removed : added).push(steps[i]); i++; }
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
          if (removed[k] && added[k]) rows.push({ type: 'change', a: removed[k][1], b: added[k][2] });
          else if (removed[k]) rows.push({ type: 'del', a: removed[k][1] });
          else rows.push({ type: 'add', b: added[k][2] });
        }
      }

      const count = (type) => rows.filter((row) => row.type === type).length;
      const empty = !oldLines.length && !newLines.length;
      const identical = !empty && rows.every((row) => row.type === 'same');
      $('#diffWrap').hidden = empty || identical;
      status('#diffStatus', empty ? 'Paste text in both boxes to compare them.'
        : identical ? 'The two texts are identical.'
          : count('change') + ' changed, ' + count('add') + ' added, ' + count('del') + ' removed' + ' (lines).', false);
      if (empty || identical) { $('#diffTable').replaceChildren(); return; }

      const sideBySide = diffView() === 'side';
      const num = (n) => el('td', { className: 'diff-n', textContent: n == null ? '' : String(n + 1) });
      const cell = (className, content) => {
        const td = el('td', { className: className });
        td.append(...(typeof content === 'string' ? [content] : content));
        return td;
      };
      const body = [];
      rows.forEach((row) => {
        const oldText = row.a == null ? '' : oldLines[row.a];
        const newText = row.b == null ? '' : newLines[row.b];
        if (row.type === 'same') {
          body.push(sideBySide
            ? el('tr', {}, [num(row.a), cell('', oldText), num(row.b), cell('', newText)])
            : el('tr', {}, [num(row.a), num(row.b), cell('diff-sign', ' '), cell('', newText)]));
          return;
        }
        const parts = row.type === 'change' ? inlineDiff(oldText, newText) : { old: oldText, fresh: newText };
        if (sideBySide) {
          body.push(el('tr', {}, [
            num(row.a), cell(row.a == null ? 'diff-none' : 'diff-del', parts.old),
            num(row.b), cell(row.b == null ? 'diff-none' : 'diff-add', parts.fresh),
          ]));
        } else {
          if (row.a != null) body.push(el('tr', {}, [num(row.a), num(null), cell('diff-sign diff-del', '−'), cell('diff-del', parts.old)]));
          if (row.b != null) body.push(el('tr', {}, [num(null), num(row.b), cell('diff-sign diff-add', '+'), cell('diff-add', parts.fresh)]));
        }
      });
      $('#diffTable').className = 'diff-table ' + (sideBySide ? 'diff-side' : 'diff-unified');
      $('#diffTable').replaceChildren(el('tbody', {}, body));
    }

    $('#diffSample').addEventListener('click', () => {
      $('#diffOld').value = 'Order summary\nItem: Blue cotton shirt\nQuantity: 2\nPrice: Rs 899\nDelivery in 5 days\nThank you for shopping with us';
      $('#diffNew').value = 'Order summary\nItem: Blue linen shirt\nQuantity: 2\nPrice: Rs 949\nGift wrap: Yes\nThank you for shopping with us';
      runDiff();
    });
    $('#diffSwap').addEventListener('click', () => {
      [$('#diffOld').value, $('#diffNew').value] = [$('#diffNew').value, $('#diffOld').value];
      runDiff();
    });
    live('#panel-diff', debounce(runDiff, 200));
    runDiff();
  });

  /* ---------- Regex tester ---------- */

  section('regex', () => {
    // The pattern runs in a worker so a slow ("catastrophic") pattern can be stopped instead of freezing the page.
    const REGEX_WORKER = URL.createObjectURL(new Blob([`
      onmessage = (e) => {
        const { pattern, flags, text, replace, useReplace } = e.data;
        try {
          const re = new RegExp(pattern, flags);
          const matches = [];
          let total = 0;
          const add = (m) => {
            total++;
            if (matches.length < 2000) matches.push({ index: m.index, text: m[0], groups: m.slice(1), named: m.groups || null });
          };
          if (re.global) {
            let m;
            while ((m = re.exec(text)) !== null) {
              add(m);
              if (m[0] === '') re.lastIndex++;
            }
          } else {
            const m = re.exec(text);
            if (m) add(m);
          }
          postMessage({ ok: true, matches, total, replaced: useReplace ? text.replace(new RegExp(pattern, flags), replace) : null });
        } catch (err) {
          postMessage({ ok: false, error: err.message });
        }
      };
    `], { type: 'text/javascript' }));
    let regexWorker = null;
    let regexTimer = null;

    function runRegex() {
      if (regexWorker) regexWorker.terminate();
      clearTimeout(regexTimer);
      const pattern = $('#rxPattern').value;
      const text = $('#rxText').value;
      const flags = ['g', 'i', 'm', 's', 'u'].filter((flag) => $('#rxFlag' + flag.toUpperCase()).checked).join('');
      const useReplace = $('#rxReplace').value !== '';
      $('#rxReplaceWrap').hidden = !useReplace;
      $('#rxFlagsText').textContent = '/' + flags;
      if (!pattern) {
        $('#rxOutput').textContent = text;
        $('#rxMatches').replaceChildren();
        status('#rxStatus', 'Type a pattern to see matches.');
        return;
      }

      regexWorker = new Worker(REGEX_WORKER);
      regexTimer = setTimeout(() => {
        regexWorker.terminate();
        status('#rxStatus', 'This pattern takes too long on this text and was stopped. Look for nested repeats such as (a+)+.', true);
      }, 1500);
      regexWorker.onmessage = (e) => {
        clearTimeout(regexTimer);
        const result = e.data;
        if (!result.ok) {
          $('#rxOutput').textContent = text;
          $('#rxMatches').replaceChildren();
          status('#rxStatus', 'Invalid pattern: ' + result.error, true);
          return;
        }
        // Highlighted copy of the text.
        const nodes = [];
        let at = 0;
        result.matches.forEach((match) => {
          if (!match.text || match.index < at) return;
          nodes.push(document.createTextNode(text.slice(at, match.index)), el('mark', { textContent: match.text }));
          at = match.index + match.text.length;
        });
        nodes.push(document.createTextNode(text.slice(at)));
        $('#rxOutput').replaceChildren(...nodes);

        $('#rxMatches').replaceChildren(...result.matches.slice(0, 200).map((match, n) => {
          const groups = match.groups.map((g, i) => '$' + (i + 1) + ' = ' + (g == null ? '(none)' : JSON.stringify(g)));
          const named = match.named ? Object.keys(match.named).map((name) => name + ' = ' + JSON.stringify(match.named[name])) : [];
          return el('tr', {}, [
            el('td', { textContent: String(n + 1) }),
            el('td', { textContent: String(match.index) }),
            el('td', { textContent: match.text === '' ? '(empty)' : match.text }),
            el('td', { textContent: groups.concat(named).join('   ') || '—' }),
          ]);
        }));
        $('#rxMatchesWrap').hidden = result.total === 0;
        $('#rxReplaced').value = result.replaced == null ? '' : result.replaced;
        status('#rxStatus', result.total === 0 ? 'No matches.'
          : result.total.toLocaleString() + (result.total === 1 ? ' match' : ' matches') +
            (result.total > 200 ? ' (first 200 listed)' : '') + (flags.includes('g') ? '.' : '. Tick “g” to find every match.'));
      };
      regexWorker.postMessage({ pattern: pattern, flags: flags, text: text, replace: $('#rxReplace').value, useReplace: useReplace });
    }
    live('#panel-regex', debounce(runRegex, 150));
    runRegex();
  });

  /* ---------- Timestamp converter ---------- */

  section('timestamp', () => {
    // Seconds, milliseconds, microseconds and nanoseconds are told apart by how big the number is.
    function readTimestamp(text) {
      const clean = text.trim();
      if (/^-?\d+(\.\d+)?$/.test(clean)) {
        const n = Number(clean);
        const size = Math.abs(n);
        if (size >= 1e17) return { ms: n / 1e6, unit: 'nanoseconds' };
        if (size >= 1e14) return { ms: n / 1e3, unit: 'microseconds' };
        if (size >= 1e11) return { ms: n, unit: 'milliseconds' };
        return { ms: n * 1000, unit: 'seconds' };
      }
      const parsed = Date.parse(clean);
      return isNaN(parsed) ? null : { ms: parsed, unit: 'date text' };
    }

    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    $('#tsLocalLabel').textContent = 'Your time zone (' + localZone + ')';

    function runTimestamp() {
      const read = readTimestamp($('#tsInput').value);
      const date = read ? new Date(read.ms) : null;
      const valid = date && !isNaN(date);
      $('#tsResult').hidden = !valid;
      if (!valid) {
        status('#tsStatus', $('#tsInput').value.trim() ? 'This is not a timestamp or a date I can read.' : 'Enter a Unix timestamp or a date.', !!$('#tsInput').value.trim());
      } else {
        status('#tsStatus', 'Read as ' + read.unit + '.');
        $('#tsIst').textContent = zoneText(date, 'Asia/Kolkata');
        $('#tsUtc').textContent = zoneText(date, 'UTC');
        $('#tsLocal').textContent = zoneText(date);
        $('#tsIso').textContent = date.toISOString();
        $('#tsRelative').textContent = relativeTime(read.ms / 1000);
        $('#tsSeconds').textContent = String(Math.floor(read.ms / 1000));
        $('#tsMillis').textContent = String(Math.round(read.ms));
      }

      // Date and time → timestamp, read in the chosen zone.
      const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec($('#tsDate').value);
      let ms = NaN;
      if (parts) {
        const [y, mo, d, h, mi, sec] = parts.slice(1).map((value) => Number(value || 0));
        const zone = $('#tsZone').value;
        if (zone === 'local') ms = new Date(y, mo - 1, d, h, mi, sec).getTime();
        else ms = Date.UTC(y, mo - 1, d, h, mi, sec) - (zone === 'ist' ? 19800000 : 0);
      }
      $('#tsOutSeconds').textContent = isNaN(ms) ? '—' : String(ms / 1000);
      $('#tsOutMillis').textContent = isNaN(ms) ? '—' : String(ms);
    }

    function setNow() {
      const now = new Date();
      $('#tsInput').value = String(Math.floor(now.getTime() / 1000));
      const ist = new Date(now.getTime() + 19800000); // IST is UTC+5:30
      $('#tsDate').value = ist.getUTCFullYear() + '-' + pad2(ist.getUTCMonth() + 1) + '-' + pad2(ist.getUTCDate()) + 'T' +
        pad2(ist.getUTCHours()) + ':' + pad2(ist.getUTCMinutes()) + ':' + pad2(ist.getUTCSeconds());
      $('#tsZone').value = 'ist';
      runTimestamp();
    }
    $('#tsNow').addEventListener('click', setNow);
    const tick = () => { $('#tsLive').textContent = String(Math.floor(Date.now() / 1000)); };
    setInterval(tick, 1000);
    tick();
    live('#panel-timestamp', runTimestamp);
    setNow();
  });

  /* ---------- shared wording helpers ---------- */

  function joinList(items) {
    return items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /* ---------- Case converter and word counter ---------- */

  section('case', () => {
    const WORD = /\p{L}[\p{L}\p{M}\p{N}'’]*/gu; // \p{M} keeps Indian-script vowel signs inside the word

    // Words of an identifier or phrase: splits on punctuation, spaces and camelCase humps.
    function nameParts(line) {
      return line.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).map((w) => w.toLowerCase());
    }
    const perLine = (text, fn) => text.split('\n').map((line) => (line.trim() ? fn(nameParts(line)) : '')).join('\n');

    const CASES = {
      upper: (t) => t.toUpperCase(),
      lower: (t) => t.toLowerCase(),
      title: (t) => t.toLowerCase().replace(WORD, capital),
      sentence: (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (m, lead, letter) => lead + letter.toUpperCase()),
      camel: (t) => perLine(t, (parts) => parts.map((w, i) => (i ? capital(w) : w)).join('')),
      pascal: (t) => perLine(t, (parts) => parts.map(capital).join('')),
      snake: (t) => perLine(t, (parts) => parts.join('_')),
      kebab: (t) => perLine(t, (parts) => parts.join('-')),
      constant: (t) => perLine(t, (parts) => parts.join('_').toUpperCase()),
    };
    const caseMode = chips('#csModes');

    live('#panel-case', () => {
      const text = $('#csInput').value;
      const words = (text.match(/\S+/g) || []).length;
      $('#csWords').textContent = words.toLocaleString('en-IN');
      $('#csChars').textContent = Array.from(text).length.toLocaleString('en-IN');
      $('#csCharsNoSpace').textContent = Array.from(text.replace(/\s/g, '')).length.toLocaleString('en-IN');
      $('#csSentences').textContent = (text.match(/[^.!?।\n]+[.!?।]+|[^.!?।\n]+$/gm) || []).filter((part) => part.trim()).length.toLocaleString('en-IN');
      $('#csParagraphs').textContent = text.split(/\n\s*\n/).filter((part) => part.trim()).length.toLocaleString('en-IN');
      $('#csLines').textContent = (text ? text.split('\n').length : 0).toLocaleString('en-IN');
      const minutes = words / 200;
      $('#csRead').textContent = !words ? '—' : minutes < 1 ? 'under a minute' : Math.round(minutes) + ' min';
      $('#csOutput').value = CASES[caseMode()](text);
    });
  });

  /* ---------- Colour converter and contrast checker ---------- */

  section('colour', () => {
    function rgbToHsl([r, g, b]) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (!d) return [0, 0, Math.round(l * 100)];
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = Math.round(h * 60);
      return [(h + 360) % 360, Math.round(s * 100), Math.round(l * 100)];
    }

    function hslToRgb(h, s, l) {
      s = clamp(s, 0, 100) / 100;
      l = clamp(l, 0, 100) / 100;
      const k = (n) => (n + (((h % 360) + 360) % 360) / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
      return [f(0), f(8), f(4)];
    }

    const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

    // Accepts #rgb, #rrggbb, rgb(), hsl() or three plain numbers.
    function parseColour(text) {
      const t = text.trim().toLowerCase();
      let m = /^#?([0-9a-f]{3,8})$/.exec(t);
      if (m && [3, 4, 6, 8].includes(m[1].length)) {
        const h = m[1].length <= 4 ? Array.from(m[1], (c) => c + c).join('') : m[1];
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      }
      m = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(t);
      if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
      m = /^(?:rgba?\()?\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(t);
      if (m && m.slice(1, 4).every((v) => Number(v) <= 255)) return m.slice(1, 4).map((v) => Math.round(Number(v)));
      return null;
    }

    // WCAG relative luminance and contrast ratio.
    function luminance(rgb) {
      const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrastRatio(a, b) {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }

    let colour = [47, 125, 79];
    function showColour(skip) {
      const hsl = rgbToHsl(colour);
      const hex = toHex(colour);
      if (skip !== '#clHex') $('#clHex').value = hex;
      if (skip !== '#clRgb') $('#clRgb').value = 'rgb(' + colour.join(', ') + ')';
      if (skip !== '#clHsl') $('#clHsl').value = 'hsl(' + hsl[0] + ', ' + hsl[1] + '%, ' + hsl[2] + '%)';
      $('#clPicker').value = hex;
      $('#clSwatch').style.background = hex;
      $('#clSwatch').style.color = contrastRatio(colour, [255, 255, 255]) >= contrastRatio(colour, [0, 0, 0]) ? '#fff' : '#000';
      $('#clSwatch').textContent = hex.toUpperCase();
      $('#clShades').replaceChildren(...[95, 85, 72, 60, 48, 38, 28, 18, 10].map((lightness) => {
        const shade = toHex(hslToRgb(hsl[0], hsl[1], lightness));
        const button = el('button', { type: 'button', className: 'shade', title: shade });
        button.style.background = shade;
        button.dataset.hex = shade;
        button.setAttribute('aria-label', 'Use ' + shade);
        return button;
      }));
      status('#clStatus', '');
    }
    ['#clHex', '#clRgb', '#clHsl'].forEach((id) => $(id).addEventListener('input', () => {
      const parsed = parseColour($(id).value);
      if (parsed) { colour = parsed; showColour(id); }
      else status('#clStatus', 'Not a colour I can read. Try #2f7d4f, rgb(47, 125, 79) or hsl(145, 45%, 34%).', true);
    }));
    $('#clPicker').addEventListener('input', () => { colour = parseColour($('#clPicker').value); showColour(); });
    $('#clShades').addEventListener('click', (e) => {
      const shade = e.target.closest('.shade');
      if (shade) { colour = parseColour(shade.dataset.hex); showColour(); }
    });
    showColour();

    function runContrast() {
      const fg = parseColour($('#ctFg').value);
      const bg = parseColour($('#ctBg').value);
      $('#ctResult').hidden = !(fg && bg);
      if (!(fg && bg)) { status('#ctStatus', 'Enter two colours, for example #232a20 and #f8f5ec.', true); return; }
      status('#ctStatus', '');
      $('#ctFgPick').value = toHex(fg);
      $('#ctBgPick').value = toHex(bg);
      const ratio = contrastRatio(fg, bg);
      $('#ctRatio').textContent = (Math.floor(ratio * 100) / 100).toFixed(2) + ' : 1';
      [['#ctAA', 4.5], ['#ctAALarge', 3], ['#ctAAA', 7], ['#ctAAALarge', 4.5]].forEach(([id, need]) => {
        $(id).textContent = ratio >= need ? 'Pass' : 'Fail';
        $(id).className = 'badge-result ' + (ratio >= need ? 'is-pass' : 'is-fail');
      });
      $('#ctPreview').style.color = toHex(fg);
      $('#ctPreview').style.background = toHex(bg);
    }
    $('#ctFgPick').addEventListener('input', () => { $('#ctFg').value = $('#ctFgPick').value; runContrast(); });
    $('#ctBgPick').addEventListener('input', () => { $('#ctBg').value = $('#ctBgPick').value; runContrast(); });
    $('#ctFg').addEventListener('input', runContrast);
    $('#ctBg').addEventListener('input', runContrast);
    $('#ctSwap').addEventListener('click', () => { [$('#ctFg').value, $('#ctBg').value] = [$('#ctBg').value, $('#ctFg').value]; runContrast(); });
    $('#ctUseText').addEventListener('click', () => { $('#ctFg').value = toHex(colour); runContrast(); });
    $('#ctUseBg').addEventListener('click', () => { $('#ctBg').value = toHex(colour); runContrast(); });
    runContrast();
  });

  /* ---------- Cron expression explainer ---------- */

  section('cron', () => {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const CRON_FIELDS = [
      { name: 'Minute', min: 0, max: 59 },
      { name: 'Hour', min: 0, max: 23 },
      { name: 'Day of month', min: 1, max: 31 },
      { name: 'Month', min: 1, max: 12, names: MONTHS, offset: 1 },
      { name: 'Day of week', min: 0, max: 7, names: DAYS, offset: 0 },
    ];
    const CRON_MACROS = {
      '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
      '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
    };

    function parseCronField(text, field) {
      const weekday = field.name === 'Day of week';
      const top = weekday ? 6 : field.max;
      const number = (token) => {
        if (/^\d+$/.test(token)) return Number(token);
        const index = field.names ? field.names.findIndex((name) => name.slice(0, 3).toLowerCase() === token.toLowerCase()) : -1;
        if (index < 0) throw new Error(field.name + ': “' + token + '” is not valid.');
        return index + field.offset;
      };
      const values = new Set();
      text.split(',').forEach((part) => {
        const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
        if (!m || m[2] === '0') throw new Error(field.name + ': “' + part + '” is not valid.');
        const step = m[2] ? Number(m[2]) : 1;
        let low = field.min;
        let high = top;
        if (m[1] !== '*') {
          const ends = m[1].split('-').map(number);
          low = ends[0];
          high = ends.length > 1 ? ends[1] : m[2] ? top : ends[0];
        }
        if (low < field.min || high > field.max || low > high) {
          throw new Error(field.name + ' must be between ' + field.min + ' and ' + field.max + '.');
        }
        for (let v = low; v <= high; v += step) values.add(weekday && v === 7 ? 0 : v);
      });
      const stepAll = /^\*\/(\d+)$/.exec(text);
      return { raw: text, any: text === '*', step: stepAll ? Number(stepAll[1]) : 0, values: Array.from(values).sort((a, b) => a - b) };
    }

    const clock = (hour, minute) => ((hour % 12) || 12) + ':' + pad2(minute) + ' ' + (hour < 12 ? 'am' : 'pm');
    const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    const isRun = (values) => values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1] + 1);
    const listOrRange = (values, format) => (isRun(values) ? format(values[0]) + ' to ' + format(values[values.length - 1]) : joinList(values.map(format)));

    function describeCronTime(minute, hour) {
      if (minute.any && hour.any) return 'Every minute';
      if (minute.step && hour.any) return 'Every ' + minute.step + ' minutes';
      const one = minute.values.length === 1;
      if (one && hour.any) return minute.values[0] === 0 ? 'Every hour, on the hour' : 'At ' + minute.values[0] + ' minutes past every hour';
      if (one && hour.step) return 'Every ' + hour.step + ' hours' + (minute.values[0] ? ', at ' + minute.values[0] + ' minutes past the hour' : ', on the hour');
      const last = hour.values[hour.values.length - 1];
      const window = hour.any ? '' : isRun(hour.values) || hour.values.length === 1
        ? ', between ' + clock(hour.values[0], 0) + ' and ' + clock(last, 59)
        : ', during the hours starting ' + joinList(hour.values.map((h) => clock(h, 0)));
      if (minute.any) return 'Every minute' + window;
      if (minute.step) return 'Every ' + minute.step + ' minutes' + window;
      if (!hour.any && minute.values.length * hour.values.length <= 6) {
        const times = [];
        hour.values.forEach((h) => minute.values.forEach((m) => times.push(clock(h, m))));
        return 'At ' + joinList(times);
      }
      return 'At minute ' + joinList(minute.values.map(String)) + ' past ' + (hour.any ? 'every hour' : 'the hours ' + listOrRange(hour.values, (h) => clock(h, 0)));
    }

    function describeCron(fields) {
      const [minute, hour, dom, month, dow] = fields;
      const dayOfMonth = dom.any ? '' : dom.step ? 'every ' + dom.step + ' days of the month' : 'on the ' + listOrRange(dom.values, ordinal) + ' of the month';
      const dayOfWeek = dow.any ? '' : dow.values.join() === '0,6' ? 'on weekends' : 'on ' + listOrRange(dow.values, (d) => DAYS[d]);
      const days = dayOfMonth && dayOfWeek ? dayOfMonth + ' or ' + dayOfWeek : dayOfMonth || dayOfWeek || 'every day';
      const months = month.any ? '' : (isRun(month.values) ? ', from ' : ', in ') + listOrRange(month.values, (m) => MONTHS[m - 1]);
      return describeCronTime(minute, hour) + ', ' + days + months + '.';
    }

    // Next run times, found a day at a time. Cron runs on a day if EITHER day field matches when both are set.
    function nextCronRuns(fields, count) {
      const [minute, hour, dom, month, dow] = fields;
      const now = new Date();
      const runs = [];
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      for (let i = 0; i < 366 * 5 && runs.length < count; i++, day.setDate(day.getDate() + 1)) {
        if (!month.values.includes(day.getMonth() + 1)) continue;
        const domOk = dom.values.includes(day.getDate());
        const dowOk = dow.values.includes(day.getDay());
        if (!(dom.any || dow.any ? domOk && dowOk : domOk || dowOk)) continue;
        for (const h of hour.values) {
          for (const m of minute.values) {
            const run = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
            if (run > now && runs.length < count) runs.push(run);
          }
        }
      }
      return runs;
    }

    function runCron() {
      const raw = $('#cnInput').value.trim().replace(/\s+/g, ' ');
      const expression = CRON_MACROS[raw.toLowerCase()] || raw;
      const parts = expression ? expression.split(' ') : [];
      try {
        if (!raw) throw new Error('Enter a cron expression such as 0 9 * * 1-5.');
        if (parts.length !== 5) throw new Error('A cron expression has 5 parts (minute, hour, day of month, month, day of week); this has ' + parts.length + '.');
        const fields = parts.map((part, i) => parseCronField(part, CRON_FIELDS[i]));
        $('#cnText').textContent = describeCron(fields);
        $('#cnFields').replaceChildren(...fields.map((field, i) => el('tr', {}, [
          el('td', { textContent: CRON_FIELDS[i].name }),
          el('td', { textContent: field.raw }),
          el('td', { textContent: field.any ? 'every value' : field.values.length > 12 ? field.values.length + ' values' : field.values.join(', ') }),
        ])));
        const runs = nextCronRuns(fields, 5);
        $('#cnNext').replaceChildren(...(runs.length ? runs : [null]).map((run) => el('li', {
          textContent: run ? zoneText(run) + ' — ' + relativeTime(run.getTime() / 1000) : 'This schedule never runs (for example 30 February).',
        })));
        $('#cnResult').hidden = false;
        status('#cnStatus', '');
      } catch (err) {
        $('#cnResult').hidden = true;
        status('#cnStatus', err.message, true);
      }
    }
    $('#cnPresets').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $('#cnInput').value = chip.dataset.cron;
      runCron();
    });
    live('#panel-cron', runCron);
  });

  /* ---------- Lorem ipsum and sample data ---------- */

  section('fake', () => {
    const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' +
      'enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit ' +
      'voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum').split(' ');
    const LOREM_START = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit';

    function loremSentence() {
      const length = 8 + Math.floor(Math.random() * 9);
      const words = Array.from({ length: length }, () => pick(LOREM));
      if (length > 11) words[4 + Math.floor(Math.random() * 4)] += ',';
      return capital(words.join(' ')) + '.';
    }
    const loremType = chips('#lrType');

    function runLorem() {
      const type = loremType();
      const count = clamp(Math.round(Number($('#lrCount').value) || 1), 1, type === 'words' ? 2000 : type === 'sentences' ? 200 : 50);
      const start = $('#lrStart').checked;
      let text;
      if (type === 'words') {
        const words = Array.from({ length: count }, () => pick(LOREM));
        if (start) LOREM_START.replace(/,/g, '').toLowerCase().split(' ').slice(0, count).forEach((w, i) => { words[i] = w; });
        text = capital(words.join(' ')) + '.';
      } else {
        const paragraph = (sentences, first) => Array.from({ length: sentences }, (_, i) => (first && i === 0 ? LOREM_START + '.' : loremSentence())).join(' ');
        text = type === 'sentences'
          ? paragraph(count, start)
          : Array.from({ length: count }, (_, i) => paragraph(4 + Math.floor(Math.random() * 4), start && i === 0)).join('\n\n');
      }
      $('#lrOutput').value = text;
    }
    $('#lrGenerate').addEventListener('click', runLorem);
    live('#lrBox', runLorem);

    const FIRST_NAMES = ['Aarav', 'Aditya', 'Arjun', 'Rohan', 'Karan', 'Rahul', 'Vikram', 'Sanjay', 'Imran', 'Joseph', 'Harpreet', 'Nikhil', 'Suresh', 'Deepak', 'Ishaan',
      'Ananya', 'Diya', 'Priya', 'Kavya', 'Meera', 'Sneha', 'Pooja', 'Neha', 'Fatima', 'Simran', 'Lakshmi', 'Riya', 'Anjali', 'Divya', 'Mary'];
    const LAST_NAMES = ['Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Reddy', 'Nair', 'Iyer', 'Khan', 'Das', 'Joshi', 'Mehta', 'Chopra', 'Bose',
      'Pillai', 'Yadav', 'Mishra', 'Kulkarni', 'Fernandes', 'Gill', 'Banerjee', 'Shah', 'Rao'];
    const CITIES = [['Mumbai', 'Maharashtra', '400'], ['Delhi', 'Delhi', '110'], ['Bengaluru', 'Karnataka', '560'], ['Chennai', 'Tamil Nadu', '600'],
      ['Kolkata', 'West Bengal', '700'], ['Hyderabad', 'Telangana', '500'], ['Pune', 'Maharashtra', '411'], ['Ahmedabad', 'Gujarat', '380'],
      ['Jaipur', 'Rajasthan', '302'], ['Lucknow', 'Uttar Pradesh', '226'], ['Kochi', 'Kerala', '682'], ['Bhopal', 'Madhya Pradesh', '462'],
      ['Patna', 'Bihar', '800'], ['Guwahati', 'Assam', '781'], ['Indore', 'Madhya Pradesh', '452'], ['Nagpur', 'Maharashtra', '440']];
    const FAKE_FIELDS = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['state', 'State'], ['pin', 'PIN code']];
    const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
    const fakeFormat = chips('#fkFormat');
    let fakeRows = [];

    function fakePerson() {
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const [city, state, prefix] = pick(CITIES);
      const mobile = pick(['6', '7', '8', '9']) + digits(9);
      return {
        name: first + ' ' + last,
        email: (first + '.' + last).toLowerCase() + (10 + Math.floor(Math.random() * 90)) + '@example.com', // example.com never reaches a real inbox
        phone: '+91 ' + mobile.slice(0, 5) + ' ' + mobile.slice(5),
        city: city,
        state: state,
        pin: prefix + '0' + pad2(1 + Math.floor(Math.random() * 40)),
      };
    }

    function showFake() {
      const fields = FAKE_FIELDS.filter(([key]) => $('#fk_' + key).checked);
      const format = fakeFormat();
      const rows = fakeRows.map((row) => fields.reduce((out, [key]) => { out[key] = row[key]; return out; }, {}));
      const table = format === 'table';
      $('#fkTableWrap').hidden = !table;
      $('#fkOutput').hidden = table;
      if (!fields.length) { $('#fkOutput').value = ''; $('#fkTable').replaceChildren(); status('#fkStatus', 'Tick at least one field.', true); return; }
      status('#fkStatus', '');
      const csv = [fields.map(([, label]) => label).join(',')].concat(rows.map((row) => fields.map(([key]) => row[key]).join(','))).join('\n') + '\n';
      $('#fkOutput').value = format === 'json' ? JSON.stringify(rows, null, 2) : csv;
      $('#fkTable').replaceChildren(
        el('thead', {}, [el('tr', {}, fields.map(([, label]) => el('th', { textContent: label })))]),
        el('tbody', {}, rows.map((row) => el('tr', {}, fields.map(([key]) => el('td', { textContent: row[key] }))))));
    }
    function makeFake() {
      const count = clamp(Math.round(Number($('#fkCount').value) || 1), 1, 500);
      fakeRows = Array.from({ length: count }, fakePerson);
      showFake();
    }
    $('#fkGenerate').addEventListener('click', makeFake);
    $('#fkCount').addEventListener('input', makeFake);
    $('#fkDownload').addEventListener('click', () => {
      if (!$('#fkOutput').value) { toast('Nothing to download yet.', true); return; }
      const json = fakeFormat() === 'json';
      downloadBlob(textBlob($('#fkOutput').value, json ? 'application/json' : 'text/csv'), 'sample-data' + (json ? '.json' : '.csv'));
    });
    $('#fkBox').addEventListener('change', showFake);
    makeFake();
  });
})();
