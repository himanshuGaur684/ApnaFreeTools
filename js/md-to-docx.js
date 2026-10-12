// Markdown → DOCX. Parses Markdown with marked and builds a real Word document with docx.
(function (global) {
  'use strict';

  const MONO = 'Consolas';
  const PAGE_WIDTH = 9026; // A4 text width in twips with 1" margins
  const MAX_IMAGE_WIDTH = 600; // px
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/bmp'];

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

  async function loadImage(href) {
    const res = await fetch(href);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!IMAGE_TYPES.includes(blob.type)) throw new Error('Unsupported image type');
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width);
    return {
      data: await blob.arrayBuffer(),
      width: Math.round(bitmap.width * scale),
      height: Math.round(bitmap.height * scale),
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
    const {
      Paragraph, TextRun, ImageRun, ExternalHyperlink, HeadingLevel, AlignmentType,
      Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
    } = global.docx;

    const HEADINGS = [
      HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
    ];
    let listInstance = 0;

    function textRun(text, st, extra) {
      return new TextRun(Object.assign({
        text: text,
        bold: st.bold,
        italics: st.italics,
        strike: st.strike,
        color: st.link ? '0563C1' : st.color,
        underline: st.link ? {} : undefined,
      }, extra));
    }

    function runs(tokens, st) {
      st = st || {};
      const out = [];
      for (const t of tokens || []) {
        switch (t.type) {
          case 'strong':
            out.push(...runs(t.tokens, Object.assign({}, st, { bold: true })));
            break;
          case 'em':
            out.push(...runs(t.tokens, Object.assign({}, st, { italics: true })));
            break;
          case 'del':
            out.push(...runs(t.tokens, Object.assign({}, st, { strike: true })));
            break;
          case 'codespan':
            out.push(textRun(decode(t.text), st, { style: 'InlineCode' }));
            break;
          case 'br':
            out.push(new TextRun({ break: 1 }));
            break;
          case 'link':
            out.push(new ExternalHyperlink({
              link: t.href,
              children: runs(t.tokens, Object.assign({}, st, { link: true })),
            }));
            break;
          case 'image': {
            const img = images.get(t.href);
            if (img) {
              out.push(new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } }));
            } else {
              out.push(textRun(decode(t.text) || t.href, st));
            }
            break;
          }
          case 'html':
            if (/^<br\s*\/?>/i.test(t.raw)) out.push(new TextRun({ break: 1 }));
            else if (stripTags(t.raw)) out.push(textRun(stripTags(t.raw), st));
            break;
          case 'text':
            if (t.tokens && t.tokens.length) out.push(...runs(t.tokens, st));
            else out.push(textRun(decode(t.text).replace(/\n/g, ' '), st));
            break;
          default:
            if (t.text) out.push(textRun(decode(t.text), st));
        }
      }
      return out;
    }

    // ctx.quote is the block quote nesting depth.
    function paraProps(ctx) {
      if (!ctx.quote) return {};
      return ctx.quote > 1 ? { style: 'Quote', indent: { left: 360 * ctx.quote } } : { style: 'Quote' };
    }

    function list(token, level, ctx) {
      const out = [];
      const instance = token.ordered ? listInstance++ : null;
      const marker = token.ordered
        ? { numbering: { reference: 'ordered', level: level, instance: instance } }
        : { bullet: { level: level } };

      for (const item of token.items) {
        let first = true;
        const prefix = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
        for (const child of item.tokens) {
          if (child.type === 'list') {
            out.push(...list(child, Math.min(level + 1, 8), ctx));
          } else if (child.type === 'text' || child.type === 'paragraph') {
            const children = runs(child.tokens || [child]);
            if (first && prefix) children.unshift(new TextRun({ text: prefix }));
            out.push(new Paragraph(Object.assign(
              { children: children, spacing: { after: 60 } },
              first ? marker : { indent: { left: 720 * (level + 1) } }
            )));
            first = false;
          } else if (child.type !== 'space') {
            out.push(...blocks([child], ctx));
          }
        }
        if (first) out.push(new Paragraph(Object.assign({ children: [new TextRun(prefix)] }, marker)));
      }
      return out;
    }

    function table(token) {
      const cols = token.header.length || 1;
      const colWidth = Math.floor(PAGE_WIDTH / cols);
      const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

      const row = (cells, isHeader) => new TableRow({
        tableHeader: isHeader || undefined,
        children: cells.map((cell, i) => new TableCell({
          width: { size: colWidth, type: WidthType.DXA },
          margins: { top: 80, bottom: 80, left: 110, right: 110 },
          shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F1F3F5', color: 'auto' } : undefined,
          children: [new Paragraph({
            alignment: ALIGN[token.align[i]],
            spacing: { after: 0 },
            children: runs(cell.tokens, { bold: isHeader }),
          })],
        })),
      });

      return [
        new Table({
          width: { size: colWidth * cols, type: WidthType.DXA },
          columnWidths: new Array(cols).fill(colWidth),
          rows: [row(token.header, true)].concat(token.rows.map((r) => row(r, false))),
        }),
        new Paragraph({ children: [], spacing: { after: 120 } }),
      ];
    }

    function code(token) {
      const lines = token.text.replace(/\t/g, '    ').split('\n');
      return lines.map((line, i) => new Paragraph({
        style: 'Code',
        spacing: { before: 0, after: i === lines.length - 1 ? 200 : 0, line: 260 },
        children: [new TextRun({ text: line })],
      }));
    }

    function blocks(tokens, ctx) {
      const out = [];
      for (const t of tokens || []) {
        switch (t.type) {
          case 'heading':
            out.push(new Paragraph(Object.assign({
              heading: HEADINGS[t.depth - 1],
              children: runs(t.tokens),
            }, paraProps(ctx))));
            break;
          case 'paragraph':
          case 'text':
            out.push(new Paragraph(Object.assign({
              children: runs(t.tokens || [t]),
            }, paraProps(ctx))));
            break;
          case 'list':
            out.push(...list(t, 0, ctx));
            out.push(new Paragraph({ children: [], spacing: { after: 60 } }));
            break;
          case 'code':
            out.push(...code(t));
            break;
          case 'blockquote':
            out.push(...blocks(t.tokens, { quote: (ctx.quote || 0) + 1 }));
            break;
          case 'table':
            out.push(...table(t));
            break;
          case 'hr':
            out.push(new Paragraph({
              children: [],
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C7CBD6', space: 1 } },
            }));
            break;
          case 'html': {
            const text = stripTags(t.raw).trim();
            if (text) out.push(new Paragraph({ children: [new TextRun(text)] }));
            break;
          }
          default:
            break; // 'space', 'def'
        }
      }
      return out;
    }

    return blocks(tokens, {});
  }

  function documentOptions(children, title) {
    const { AlignmentType, LevelFormat, BorderStyle, ShadingType } = global.docx;
    const heading = (size, before) => ({
      run: { size: size, bold: true, color: '171A23' },
      paragraph: { spacing: { before: before, after: 120 } },
    });

    return {
      creator: 'ApnaFreeTools',
      title: title || 'Document',
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 22 },
            paragraph: { spacing: { after: 160, line: 276 } },
          },
          heading1: heading(36, 360),
          heading2: heading(30, 320),
          heading3: heading(26, 280),
          heading4: heading(24, 240),
          heading5: heading(22, 200),
          heading6: heading(22, 200),
        },
        // These names are what docx-to-md.js maps back to Markdown.
        paragraphStyles: [
          {
            id: 'Code', name: 'Code', basedOn: 'Normal', quickFormat: true,
            run: { font: MONO, size: 19 },
            paragraph: { shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } },
          },
          {
            id: 'Quote', name: 'Quote', basedOn: 'Normal', quickFormat: true,
            run: { italics: true, color: '5D6474' },
            paragraph: {
              indent: { left: 360 },
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'C7CBD6', space: 10 } },
            },
          },
        ],
        characterStyles: [
          {
            id: 'InlineCode', name: 'Inline Code', basedOn: 'DefaultParagraphFont',
            run: { font: MONO, shading: { type: ShadingType.CLEAR, fill: 'F1F3F5', color: 'auto' } },
          },
        ],
      },
      numbering: {
        config: [{
          reference: 'ordered',
          levels: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((level) => ({
            level: level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: '%' + (level + 1) + '.',
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        }],
      },
      sections: [{ children: children }],
    };
  }

  async function convert(markdown) {
    const tokens = global.marked.lexer(markdown || '', { gfm: true });
    const images = await loadImages(tokens);
    const children = build(tokens, images);
    const firstHeading = tokens.find((t) => t.type === 'heading');
    const doc = new global.docx.Document(documentOptions(
      children.length ? children : [new global.docx.Paragraph('')],
      firstHeading ? stripTags(firstHeading.text) : ''
    ));
    return global.docx.Packer.toBlob(doc);
  }

  global.MdToDocx = { convert: convert };
})(window);
