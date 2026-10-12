// Markdown → PDF. Parses Markdown with marked and lays out a real (selectable-text) PDF with pdfmake.
(function (global) {
  'use strict';

  const CONTENT_WIDTH = 515; // A4 width in points minus the side margins
  const IMAGE_TYPES = ['image/png', 'image/jpeg'];
  const RULE = '#c7cbd6';

  const ROBOTO = {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf',
  };
  // pdfmake's browser build has no monospace font, so one is fetched when the document has code.
  const MONO_BASE = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSansMono';
  const MONO = {
    normal: MONO_BASE + '.ttf',
    bold: MONO_BASE + '-Bold.ttf',
    italics: MONO_BASE + '-Oblique.ttf',
    bolditalics: MONO_BASE + '-BoldOblique.ttf',
  };

  const none = () => 0;
  const CODE_LAYOUT = {
    hLineWidth: none, vLineWidth: none, fillColor: () => '#f6f8fa',
    paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8,
  };
  const QUOTE_LAYOUT = {
    hLineWidth: none, vLineWidth: (i) => (i === 0 ? 2.5 : 0), vLineColor: () => RULE,
    paddingLeft: () => 12, paddingRight: none, paddingTop: () => 2, paddingBottom: none,
  };
  const TABLE_LAYOUT = {
    hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => RULE, vLineColor: () => RULE,
    paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 5, paddingBottom: () => 5,
  };

  function decode(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function stripTags(html) {
    return decode(String(html || '').replace(/<[^>]*>/g, ''));
  }

  function toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function loadImage(href) {
    const res = await fetch(href);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!IMAGE_TYPES.includes(blob.type)) throw new Error('Unsupported image type');
    const bitmap = await createImageBitmap(blob);
    return {
      dataUrl: await toDataUrl(blob),
      width: Math.min(bitmap.width * 0.75, CONTENT_WIDTH - 60), // px → pt, leaving room for nesting
    };
  }

  // Images that can't be fetched (CORS, 404, SVG…) fall back to their alt text.
  async function loadImages(tokens) {
    const hrefs = new Set();
    global.marked.walkTokens(tokens, (t) => {
      if (t.type === 'image' && t.href) hrefs.add(t.href);
    });
    const images = new Map();
    await Promise.all([...hrefs].map(async (href) => {
      try {
        images.set(href, await loadImage(href));
      } catch (e) { /* fall back to alt text */ }
    }));
    return images;
  }

  function build(tokens, images) {
    // pdfmake images are block-level, so inline images are queued in `pending`
    // and placed after the paragraph they appear in.
    function inlines(tokens, st, pending) {
      const out = [];
      const frag = (text, extra) => Object.assign({ text: text }, st, extra);
      const nest = (t, extra) => out.push(...inlines(t.tokens, Object.assign({}, st, extra), pending));

      for (const t of tokens || []) {
        switch (t.type) {
          case 'strong': nest(t, { bold: true }); break;
          case 'em': nest(t, { italics: true }); break;
          case 'del': nest(t, { decoration: 'lineThrough' }); break;
          case 'link': nest(t, { link: t.href, color: '#0563c1', decoration: 'underline' }); break;
          case 'codespan':
            out.push(frag(decode(t.text), { font: 'Mono', fontSize: 9.5, background: '#f1f3f5' }));
            break;
          case 'br':
            out.push(frag('\n'));
            break;
          case 'image': {
            const img = images.get(t.href);
            if (img && pending) pending.push(img);
            else out.push(frag(decode(t.text) || t.href));
            break;
          }
          case 'html':
            if (/^<br\s*\/?>/i.test(t.raw)) out.push(frag('\n'));
            else if (stripTags(t.raw)) out.push(frag(stripTags(t.raw)));
            break;
          case 'text':
            if (t.tokens && t.tokens.length) nest(t, {});
            else out.push(frag(decode(t.text).replace(/\n/g, ' ')));
            break;
          default:
            if (t.text) out.push(frag(decode(t.text)));
        }
      }
      return out;
    }

    function textBlock(tokens, props) {
      const pending = [];
      const text = inlines(tokens, {}, pending);
      const out = [];
      if (text.length) out.push(Object.assign({ text: text }, props));
      pending.forEach((img) => out.push({ image: img.dataUrl, width: img.width, margin: [0, 2, 0, 8] }));
      return out;
    }

    function list(token, nested) {
      const items = token.items.map((item) => {
        const stack = [];
        let first = true;
        for (const child of item.tokens) {
          if (child.type === 'list') {
            stack.push(list(child, true));
          } else if (child.type === 'text' || child.type === 'paragraph') {
            const parts = textBlock(child.tokens || [child], { margin: [0, 0, 0, 3] });
            if (first && item.task) {
              const box = { text: item.checked ? '[x] ' : '[ ] ' };
              if (parts[0] && parts[0].text) parts[0].text.unshift(box);
              else parts.unshift({ text: [box] });
            }
            stack.push(...parts);
            first = false;
          } else if (child.type !== 'space') {
            stack.push(...blocks([child]));
          }
        }
        if (!stack.length) return { text: '' };
        return stack.length === 1 ? stack[0] : { stack: stack };
      });

      const margin = nested ? [0, 0, 0, 0] : [0, 0, 0, 8];
      if (token.ordered) return { ol: items, start: token.start || 1, margin: margin };
      // Bullets are real text (not drawn shapes) so they survive copy/paste and PDF → Markdown.
      return {
        margin: margin,
        stack: items.map((item) => ({
          columns: [{ width: 13, text: '•' }, { width: '*', stack: [item] }],
          columnGap: 0,
        })),
      };
    }

    function table(token) {
      const cols = token.header.length || 1;
      const cell = (c, i, isHeader) => ({
        text: c ? inlines(c.tokens, isHeader ? { bold: true } : {}, null) : '',
        alignment: token.align[i] || 'left',
        fillColor: isHeader ? '#f1f3f5' : undefined,
      });
      const row = (cells, isHeader) => {
        const out = [];
        for (let i = 0; i < cols; i++) out.push(cell(cells[i], i, isHeader));
        return out;
      };
      return {
        table: {
          headerRows: 1,
          widths: new Array(cols).fill('*'),
          body: [row(token.header, true)].concat(token.rows.map((r) => row(r, false))),
        },
        layout: TABLE_LAYOUT,
        margin: [0, 2, 0, 12],
      };
    }

    function blocks(tokens) {
      const out = [];
      for (const t of tokens || []) {
        switch (t.type) {
          case 'heading':
            out.push(...textBlock(t.tokens, { style: 'h' + t.depth }));
            break;
          case 'paragraph':
          case 'text':
            out.push(...textBlock(t.tokens || [t], { margin: [0, 0, 0, 8] }));
            break;
          case 'list':
            out.push(list(t, false));
            break;
          case 'code':
            out.push({
              table: {
                widths: ['*'],
                body: [[{
                  text: t.text.replace(/\t/g, '    ') || ' ',
                  font: 'Mono', fontSize: 8.5, lineHeight: 1.25, preserveLeadingSpaces: true,
                }]],
              },
              layout: CODE_LAYOUT,
              margin: [0, 2, 0, 12],
            });
            break;
          case 'blockquote':
            out.push({
              table: { widths: ['*'], body: [[{ stack: blocks(t.tokens), color: '#5d6474', italics: true }]] },
              layout: QUOTE_LAYOUT,
              margin: [0, 2, 0, 8],
            });
            break;
          case 'table':
            out.push(table(t));
            break;
          case 'hr':
            out.push({
              canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.7, lineColor: RULE }],
              margin: [0, 6, 0, 12],
            });
            break;
          case 'html': {
            const text = stripTags(t.raw).trim();
            if (text) out.push({ text: text, margin: [0, 0, 0, 8] });
            break;
          }
          default:
            break; // 'space', 'def'
        }
      }
      return out;
    }

    return blocks(tokens);
  }

  async function convert(markdown) {
    const tokens = global.marked.lexer(markdown || '', { gfm: true });
    const images = await loadImages(tokens);
    const firstHeading = tokens.find((t) => t.type === 'heading');
    const heading = (fontSize, top) => ({ fontSize: fontSize, bold: true, lineHeight: 1.2, margin: [0, top, 0, 7] });

    const definition = {
      pageSize: 'A4',
      pageMargins: [40, 48, 40, 48],
      info: { title: firstHeading ? stripTags(firstHeading.text) : 'Document', creator: 'ApnaFreeTools' },
      content: build(tokens, images),
      defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3, color: '#171a23' },
      styles: {
        h1: heading(22, 8), h2: heading(18, 10), h3: heading(15, 8),
        h4: heading(13, 6), h5: heading(12, 6), h6: heading(11, 6),
      },
    };

    let usesCode = false;
    global.marked.walkTokens(tokens, (t) => {
      if (t.type === 'code' || t.type === 'codespan') usesCode = true;
    });
    const fonts = usesCode ? { Roboto: ROBOTO, Mono: MONO } : { Roboto: ROBOTO };

    // pdfmake reports async failures (e.g. a font that won't download) only as an
    // unhandled rejection, so listen for one while the PDF is being generated.
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        global.removeEventListener('unhandledrejection', onRejection);
        fn(value);
      };
      const onRejection = (event) => {
        event.preventDefault();
        done(reject, event.reason);
      };
      global.addEventListener('unhandledrejection', onRejection);
      try {
        global.pdfMake.createPdf(definition, null, fonts).getBlob((blob) => done(resolve, blob));
      } catch (err) {
        done(reject, err);
      }
    });
  }

  global.MdToPdf = { convert: convert };
})(window);
