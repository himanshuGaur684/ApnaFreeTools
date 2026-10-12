// DOCX → HTML → Markdown. mammoth turns the document into HTML, turndown turns HTML into Markdown.
(function (global) {
  'use strict';

  // GFM tables need a header row and single-line cells; mammoth emits neither.
  function normalizeTables(root) {
    root.querySelectorAll('table').forEach((tbl) => {
      tbl.querySelectorAll('td, th').forEach((cell) => {
        const paragraphs = Array.from(cell.children).filter((el) => el.tagName === 'P');
        paragraphs.forEach((p, i) => {
          if (i > 0) cell.insertBefore(root.ownerDocument.createElement('br'), p);
          while (p.firstChild) cell.insertBefore(p.firstChild, p);
          p.remove();
        });
      });

      // Rebuild as exactly one header row followed by body rows.
      const doc = root.ownerDocument;
      const rows = Array.from(tbl.querySelectorAll('tr')).filter((tr) => tr.closest('table') === tbl);
      if (!rows.length) return;
      const thead = doc.createElement('thead');
      const tbody = doc.createElement('tbody');
      rows.forEach((tr, i) => {
        const tag = i === 0 ? 'TH' : 'TD';
        Array.from(tr.children).forEach((cell) => {
          let target = cell;
          if (cell.tagName !== tag) {
            target = doc.createElement(tag);
            while (cell.firstChild) target.appendChild(cell.firstChild);
            tr.replaceChild(target, cell);
          }
          // A header that is bold all the way through doesn't need ** markers.
          if (i === 0 && target.children.length === 1 && target.firstElementChild.tagName === 'STRONG' &&
              target.textContent === target.firstElementChild.textContent) {
            const strong = target.firstElementChild;
            while (strong.firstChild) target.insertBefore(strong.firstChild, strong);
            strong.remove();
          }
        });
        (i === 0 ? thead : tbody).appendChild(tr);
      });
      tbl.textContent = '';
      tbl.appendChild(thead);
      tbl.appendChild(tbody);
    });
  }

  // Styles written by our own Markdown → DOCX export, plus Word's built-in quote styles.
  const STYLE_MAP = [
    "p[style-name='Code'] => pre:separator('\\n')",
    "r[style-name='Inline Code'] => code",
    "p[style-name='Quote'] => blockquote > p:fresh",
    "p[style-name='Intense Quote'] => blockquote > p:fresh",
  ];

  function createTurndown() {
    const service = new global.TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
    });
    service.use(global.turndownPluginGfm.gfm);
    service.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => '~~' + content + '~~',
    });
    service.addRule('listItem', {
      filter: 'li',
      replacement: (content, node, options) => {
        const parent = node.parentNode;
        let marker = options.bulletListMarker + ' ';
        if (parent.nodeName === 'OL') {
          const start = parseInt(parent.getAttribute('start'), 10) || 1;
          marker = (start + Array.prototype.indexOf.call(parent.children, node)) + '. ';
        }
        const indent = ' '.repeat(marker.length);
        const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + indent);
        return marker + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
      },
    });
    service.addRule('tableCellBreak', {
      filter: (node) => node.nodeName === 'BR' && !!node.closest('td, th'),
      replacement: () => '<br>',
    });
    return service;
  }

  // DOCX → HTML. Images are embedded as base64 data URIs when keepImages is set, otherwise dropped.
  async function toHtml(arrayBuffer, options) {
    const keepImages = !!(options && options.keepImages);
    const mammothOptions = { styleMap: STYLE_MAP };
    if (!keepImages) {
      mammothOptions.convertImage = global.mammoth.images.imgElement(() => Promise.resolve({ src: '' }));
    }

    const result = await global.mammoth.convertToHtml({ arrayBuffer: arrayBuffer }, mammothOptions);
    let html = result.value;
    if (!keepImages) {
      const dom = new DOMParser().parseFromString(html, 'text/html');
      dom.body.querySelectorAll('img').forEach((img) => img.remove());
      html = dom.body.innerHTML;
    }
    return { html: html, warnings: result.messages || [] };
  }

  // HTML → Markdown. Accepts a fragment or a whole page.
  function htmlToMarkdown(html) {
    const dom = new DOMParser().parseFromString(html || '', 'text/html');
    dom.body.querySelectorAll('script, style, noscript, template, iframe, link, meta, title').forEach((el) => el.remove());
    normalizeTables(dom.body);
    // turndown only fences <pre><code>.
    dom.body.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('code')) return;
      const codeEl = dom.createElement('code');
      codeEl.textContent = pre.textContent;
      pre.textContent = '';
      pre.appendChild(codeEl);
    });

    const markdown = createTurndown()
      .turndown(dom.body)
      .replace(/^(\s*(?:-|\d+\.) )☑ /gm, '$1[x] ')
      .replace(/^(\s*(?:-|\d+\.) )☐ /gm, '$1[ ] ')
      .replace(/^(\s*(?:-|\d+\.) \[[ x]\]) +/gm, '$1 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return markdown ? markdown + '\n' : '';
  }

  async function convert(arrayBuffer, options) {
    const result = await toHtml(arrayBuffer, options);
    return { markdown: htmlToMarkdown(result.html), warnings: result.warnings };
  }

  global.DocxToMd = { convert: convert, toHtml: toHtml, htmlToMarkdown: htmlToMarkdown };
})(window);
