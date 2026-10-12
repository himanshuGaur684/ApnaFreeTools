// PDF → Markdown. A PDF only stores positioned text, so structure is rebuilt with heuristics:
// font size → headings, font name → bold/italic/code, leading markers → lists, wide gaps → table columns.
(function (global) {
  'use strict';

  const WORKER_SRC = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const BULLET = /^[•●◦▪■‣·○∙➢➤\-–*]\s+/;
  const NUMBER = /^(\d{1,3})[.)]\s+/;

  function escapeMd(text) {
    return text.replace(/([\\`*<])/g, '\\$1');
  }

  function mode(counts) {
    let best = null;
    counts.forEach((n, key) => {
      if (best === null || n > counts.get(best)) best = key;
    });
    return best;
  }

  async function readFontNames(page, ids) {
    const names = new Map();
    try { await page.getOperatorList(); } catch (e) { /* names stay empty */ }
    ids.forEach((id) => {
      let name = '';
      try {
        const font = page.commonObjs.get(id);
        name = (font && font.name) || '';
      } catch (e) { /* font not resolved */ }
      names.set(id, name);
    });
    return names;
  }

  // Link annotations are rectangles over the page; text inside one becomes a Markdown link.
  async function readLinks(page) {
    try {
      const annotations = await page.getAnnotations();
      return annotations.filter((a) => a.subtype === 'Link' && a.url && a.rect);
    } catch (e) {
      return [];
    }
  }

  function linkAt(links, x, y) {
    const hit = links.find((a) => x >= a.rect[0] - 1 && x <= a.rect[2] + 1 && y >= a.rect[1] - 2 && y <= a.rect[3] + 2);
    return hit ? hit.url : '';
  }

  async function readLines(pdf) {
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const fontNames = await readFontNames(page, new Set(content.items.map((it) => it.fontName)));
      const links = await readLinks(page);
      let line = null;

      for (const it of content.items) {
        // Whitespace-only items are just spacing; gaps are measured from positions instead.
        if (!it.str || !it.str.trim()) continue;
        const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        const x = it.transform[4];
        const y = it.transform[5];
        if (!line || Math.abs(y - line.y) > size * 0.5) {
          line = { page: p, y: y, items: [] };
          lines.push(line);
        }
        line.items.push({
          x: x,
          endX: x + it.width,
          seg: { text: it.str, font: fontNames.get(it.fontName) || '', size: size, link: linkAt(links, x + 1, y + size * 0.3) },
        });
      }
    }

    // Items on a line are not always stored left to right (list numbers come after their text).
    lines.forEach((ln) => {
      ln.items.sort((a, b) => a.x - b.x);
      ln.x = ln.items[0].x;
      ln.cells = [[]];
      let endX = ln.x;
      ln.items.forEach((item) => {
        const cell = ln.cells[ln.cells.length - 1];
        const last = cell[cell.length - 1];
        const gap = item.x - endX;
        if (last && gap > item.seg.size * 2.2) ln.cells.push([]);
        else if (last && gap > item.seg.size * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(item.seg.text)) last.text += ' ';
        ln.cells[ln.cells.length - 1].push(item.seg);
        endX = Math.max(endX, item.endX);
      });
      delete ln.items;
    });

    return lines;
  }

  // Works out the body text size and font, then tags every segment and line.
  function classify(lines) {
    const sizes = new Map();
    const fonts = new Map();
    const eachSeg = (fn) => lines.forEach((ln) => ln.cells.forEach((cell) => cell.forEach((s) => fn(s, ln))));

    eachSeg((s) => {
      const n = s.text.trim().length;
      const size = Math.round(s.size * 2) / 2;
      sizes.set(size, (sizes.get(size) || 0) + n);
      fonts.set(s.font, (fonts.get(s.font) || 0) + n);
    });
    const bodySize = mode(sizes) || 11;
    const bodyFont = mode(fonts) || '';

    eachSeg((s) => {
      // "Medium" is bold in some fonts and body text in others, so the body font is never bold.
      s.bold = s.font !== bodyFont && /bold|black|heavy|semibold|demi|medium/i.test(s.font);
      s.italic = /italic|oblique/i.test(s.font);
      s.mono = /courier|mono|consolas|menlo/i.test(s.font);
    });

    const headingSizes = new Set();
    lines.forEach((ln) => {
      const segs = ln.cells.reduce((all, cell) => all.concat(cell), []);
      const lineSizes = new Map();
      segs.forEach((s) => lineSizes.set(s.size, (lineSizes.get(s.size) || 0) + s.text.length));
      ln.segs = segs;
      ln.size = mode(lineSizes);
      ln.plain = segs.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();
      ln.mono = segs.every((s) => s.mono || !s.text.trim());
      ln.isHeading = ln.size > bodySize * 1.15 && ln.plain.length < 150 && ln.cells.length === 1;
      if (ln.isHeading) headingSizes.add(Math.round(ln.size * 2) / 2);
    });

    const ranked = [...headingSizes].sort((a, b) => b - a);
    lines.forEach((ln) => {
      if (ln.isHeading) ln.level = Math.min(ranked.indexOf(Math.round(ln.size * 2) / 2) + 1, 6);
    });
  }

  function renderSegs(segs, plainOnly) {
    const merged = [];
    segs.forEach((s) => {
      const last = merged[merged.length - 1];
      const link = plainOnly ? '' : s.link || '';
      if (last && last.bold === s.bold && last.italic === s.italic && last.mono === s.mono && last.link === link) last.text += s.text;
      else merged.push({ text: s.text, bold: s.bold, italic: s.italic, mono: s.mono, link: link });
    });

    let out = '';
    merged.forEach((s) => {
      const core = s.text.trim();
      if (!core) { out += s.text; return; }
      let text = s.mono && !plainOnly ? '`' + core + '`' : escapeMd(core);
      if (!plainOnly) {
        const mark = (s.bold ? '**' : '') + (s.italic ? '*' : '');
        text = mark + text + mark;
        if (s.link) text = '[' + text + '](' + s.link + ')';
      }
      out += s.text.match(/^\s*/)[0] + text + s.text.match(/\s*$/)[0];
    });
    return out.replace(/\s+/g, ' ').trim();
  }

  function dropPrefix(segs, count) {
    const out = segs.map((s) => Object.assign({}, s));
    if (out.length) out[0].text = out[0].text.replace(/^\s+/, '');
    for (const s of out) {
      if (count <= 0) break;
      const take = Math.min(count, s.text.length);
      s.text = s.text.slice(take);
      count -= take;
    }
    return out.filter((s) => s.text);
  }

  function buildBlocks(lines) {
    const blocks = [];
    let cur = null;
    let prev = null;
    const push = (block) => { blocks.push(block); cur = block; };

    for (const ln of lines) {
      const samePage = prev && prev.page === ln.page;
      const gap = samePage ? prev.y - ln.y : Infinity;
      const tight = gap > 0 && gap < Math.max(prev ? prev.size : 0, ln.size) * 1.75;
      const bullet = ln.plain.match(BULLET);
      const number = ln.plain.match(NUMBER);

      if (ln.isHeading) {
        if (cur && cur.type === 'heading' && cur.level === ln.level && tight) cur.segs.push({ text: ' ' }, ...ln.segs);
        else push({ type: 'heading', level: ln.level, segs: ln.segs.slice() });
      } else if (ln.mono) {
        if (cur && cur.type === 'code' && gap > 0 && gap < ln.size * 3) cur.lines.push(ln);
        else push({ type: 'code', lines: [ln] });
      } else if (ln.cells.length > 1) {
        if (cur && cur.type === 'table' && cur.cols === ln.cells.length && gap > 0 && gap < ln.size * 4) cur.rows.push(ln.cells);
        else push({ type: 'table', cols: ln.cells.length, rows: [ln.cells] });
      } else if (bullet || number) {
        const marker = (bullet || number)[0];
        push({
          type: 'li', x: ln.x, ordered: !bullet, num: number && !bullet ? number[1] : null,
          segs: dropPrefix(ln.segs, marker.length),
        });
      } else if (cur && cur.type === 'li' && tight && ln.x > cur.x + 2) {
        cur.segs.push({ text: ' ' }, ...ln.segs);
      } else if (cur && cur.type === 'p' && tight) {
        cur.segs.push({ text: ' ' }, ...ln.segs);
      } else if (cur && cur.type === 'p' && prev && !samePage && !/[.!?:]$/.test(prev.plain) && /^[a-z]/.test(ln.plain)) {
        cur.segs.push({ text: ' ' }, ...ln.segs); // paragraph running over a page break
      } else {
        push({ type: 'p', segs: ln.segs.slice() });
      }
      prev = ln;
    }
    return blocks;
  }

  function renderList(run) {
    const xs = [];
    run.forEach((item) => {
      if (!xs.some((x) => Math.abs(x - item.x) <= 3)) xs.push(item.x);
    });
    xs.sort((a, b) => a - b);
    const pad = run.some((item) => item.ordered) ? '   ' : '  ';
    return run.map((item) => {
      const level = xs.findIndex((x) => Math.abs(x - item.x) <= 3);
      return pad.repeat(level) + (item.ordered ? item.num + '. ' : '- ') + renderSegs(item.segs);
    }).join('\n');
  }

  function renderCode(block) {
    const left = Math.min.apply(null, block.lines.map((ln) => ln.x));
    const body = block.lines.map((ln) => {
      const indent = Math.max(0, Math.round((ln.x - left) / (ln.size * 0.6)));
      return ' '.repeat(indent) + ln.cells.map((cell) => cell.map((s) => s.text).join('')).join('  ').replace(/\s+$/, '');
    }).join('\n');
    return '```\n' + body + '\n```';
  }

  function renderTable(block) {
    const cell = (segs) => renderSegs(segs).replace(/\|/g, '\\|');
    if (block.rows.length < 2) return block.rows.map((row) => row.map(cell).join(' ')).join('\n');
    const headerBold = block.rows[0].every((segs) => segs.every((s) => s.bold || !s.text.trim()));
    const row = (cells, plain) => '| ' + cells.map((segs) => (plain ? renderSegs(segs, true).replace(/\|/g, '\\|') : cell(segs))).join(' | ') + ' |';
    return [row(block.rows[0], headerBold), '| ' + new Array(block.cols).fill('---').join(' | ') + ' |']
      .concat(block.rows.slice(1).map((r) => row(r, false)))
      .join('\n');
  }

  function render(blocks) {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'li') {
        // A run ends when a top-level item switches between bulleted and numbered.
        const run = [];
        while (i < blocks.length && blocks[i].type === 'li') {
          const top = run.length && blocks[i].x <= Math.min.apply(null, run.map((item) => item.x)) + 3;
          if (top && blocks[i].ordered !== run[0].ordered) break;
          run.push(blocks[i++]);
        }
        i--;
        out.push(renderList(run));
      } else if (b.type === 'heading') {
        out.push('#'.repeat(b.level) + ' ' + renderSegs(b.segs, true));
      } else if (b.type === 'code') {
        out.push(renderCode(b));
      } else if (b.type === 'table') {
        out.push(renderTable(b));
      } else {
        out.push(renderSegs(b.segs).replace(/^(#{1,6}|\+|>)(\s)/, '\\$1$2'));
      }
    }
    return out.filter(Boolean).join('\n\n');
  }

  async function convert(arrayBuffer) {
    global.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    const pdf = await global.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    try {
      const lines = await readLines(pdf);
      classify(lines);
      const markdown = render(buildBlocks(lines)).trim();
      return { markdown: markdown ? markdown + '\n' : '', pages: pdf.numPages };
    } finally {
      pdf.destroy();
    }
  }

  global.PdfToMd = { convert: convert };
})(window);
