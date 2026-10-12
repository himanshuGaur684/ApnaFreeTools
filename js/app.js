(function () {
  'use strict';

  const {
    $, SAMPLE, toast, load, downloadBlob, safeName, baseName, renderMarkdown, htmlBlob, textBlob,
    copyText, debounce, onFileDrop, bindDropzone, withBusy, initTabs, section,
  } = Aft;

  initTabs();

  /* ---------- Markdown → DOCX / PDF / HTML ---------- */

  section('fromMd', () => {
    const mdInput = $('#mdInput');
    const mdPreview = $('#mdPreview');
    const outName = $('#outName');
    let outNameEdited = false;

    function updateMdPreview() {
      const text = mdInput.value;
      renderMarkdown(mdPreview, text);
      const words = (text.trim().match(/\S+/g) || []).length;
      $('#mdStats').textContent = words ? words.toLocaleString() + (words === 1 ? ' word' : ' words') : '';
    }

    function setMarkdown(text, name) {
      mdInput.value = text;
      if (name && !outNameEdited) outName.value = name;
      updateMdPreview();
    }

    function loadMarkdownFile(file) {
      if (!/\.(md|markdown|txt)$/i.test(file.name) && !/^text\//.test(file.type)) {
        toast('Please choose a .md, .markdown or .txt file.', true);
        return;
      }
      file.text().then((text) => {
        outNameEdited = false;
        setMarkdown(text, safeName(baseName(file.name), 'document'));
        toast('Loaded ' + file.name);
      }).catch(() => toast('Could not read that file.', true));
    }

    mdInput.addEventListener('input', debounce(updateMdPreview, 120));
    outName.addEventListener('input', () => { outNameEdited = true; });
    $('#mdUploadBtn').addEventListener('click', () => $('#mdFile').click());
    $('#mdFile').addEventListener('change', (e) => {
      if (e.target.files[0]) loadMarkdownFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#mdSampleBtn').addEventListener('click', () => setMarkdown(SAMPLE));
    $('#mdClearBtn').addEventListener('click', () => { setMarkdown(''); mdInput.focus(); });
    onFileDrop($('#mdPane'), loadMarkdownFile);

    // `convert` turns the Markdown into a Blob of the target format.
    function exportMarkdown(button, extension, convert) {
      if (!mdInput.value.trim()) {
        toast('Add some Markdown first.', true);
        mdInput.focus();
        return;
      }
      withBusy(button, 'Converting…', async () => {
        try {
          const blob = await convert(mdInput.value);
          const filename = safeName(outName.value, 'document') + extension;
          downloadBlob(blob, filename);
          toast('Downloaded ' + filename);
        } catch (err) {
          console.error(err);
          toast('Conversion failed. Please check your Markdown and your connection, then try again.', true);
        }
      });
    }

    $('#downloadDocxBtn').addEventListener('click', function () {
      exportMarkdown(this, '.docx', (md) => MdToDocx.convert(md));
    });

    $('#downloadPdfBtn').addEventListener('click', function () {
      exportMarkdown(this, '.pdf', async (md) => {
        await load('pdfmake');
        return MdToPdf.convert(md);
      });
    });

    $('#downloadHtmlBtn').addEventListener('click', function () {
      exportMarkdown(this, '.html', (md) => htmlBlob(HtmlDoc.fromMarkdown(md), safeName(outName.value, 'Document')));
    });

    setMarkdown(SAMPLE);
  });

  /* ---------- DOCX / PDF / HTML → Markdown ---------- */

  section('toMd', () => {
    const fileDrop = $('#fileDrop');
    const srcFile = $('#srcFile');
    const srcFileInfo = $('#srcFileInfo');
    const mdOutput = $('#mdOutput');
    const mdOutputPreview = $('#mdOutputPreview');
    const downloadMdBtn = $('#downloadMdBtn');
    const copyMdBtn = $('#copyMdBtn');
    const embedImages = $('#embedImages');
    const htmlInput = $('#htmlInput');
    const pasteHtmlBtn = $('#pasteHtmlBtn');
    let currentFile = null; // { name, kind: 'docx' | 'pdf' | 'html', buffer }

    function refreshOutputState() {
      const hasOutput = !!mdOutput.value.trim();
      downloadMdBtn.disabled = !hasOutput;
      copyMdBtn.disabled = !hasOutput;
      if (!mdOutputPreview.hidden) renderMarkdown(mdOutputPreview, mdOutput.value);
    }

    async function toMarkdown(file) {
      // The libraries may detach the buffer, so hand them a copy.
      const buffer = file.buffer.slice(0);
      if (file.kind === 'pdf') {
        await load('pdfjs');
        return PdfToMd.convert(buffer);
      }
      if (file.kind === 'html') {
        return { markdown: DocxToMd.htmlToMarkdown(new TextDecoder().decode(buffer)) };
      }
      return DocxToMd.convert(buffer, { keepImages: embedImages.checked });
    }

    async function convertCurrentFile() {
      if (!currentFile) return;
      const file = currentFile;
      srcFileInfo.hidden = false;
      srcFileInfo.textContent = 'Converting ' + file.name + '…';
      try {
        const result = await toMarkdown(file);
        if (file !== currentFile) return; // a newer file was chosen meanwhile
        mdOutput.value = result.markdown;
        srcFileInfo.textContent = '✓ ' + file.name;
        refreshOutputState();
        if (result.markdown) toast('Converted ' + file.name);
        else if (file.kind === 'pdf') toast('No text found. This PDF may be a scan, which cannot be converted.', true);
        else toast('That document has no text to convert.', true);
      } catch (err) {
        console.error(err);
        if (file !== currentFile) return;
        srcFileInfo.textContent = '✕ ' + file.name;
        mdOutput.value = '';
        refreshOutputState();
        if (err && err.name === 'PasswordException') toast('That PDF is password-protected. Remove the password and try again.', true);
        else toast('Could not read that file. Make sure it is a valid .' + file.kind + ' file.', true);
      }
    }

    async function loadSourceFile(file) {
      if (/\.doc$/i.test(file.name)) {
        toast('Old .doc files are not supported. Save it as .docx first.', true);
        return;
      }
      const match = file.name.match(/\.(docx|pdf|html?)$/i);
      if (!match) {
        toast('Please choose a .docx, .pdf or .html file.', true);
        return;
      }
      const kind = match[1].toLowerCase().replace(/^html?$/, 'html');
      currentFile = { name: file.name, kind: kind, buffer: await file.arrayBuffer() };
      $('#mdName').value = safeName(baseName(file.name), 'document');
      await convertCurrentFile();
    }

    bindDropzone(fileDrop, srcFile, loadSourceFile);

    // "Paste HTML" swaps the dropzone for a text box that converts as you type.
    pasteHtmlBtn.addEventListener('click', () => {
      const pasting = htmlInput.hidden;
      htmlInput.hidden = !pasting;
      fileDrop.hidden = pasting;
      pasteHtmlBtn.textContent = pasting ? 'Upload file' : 'Paste HTML';
      pasteHtmlBtn.setAttribute('aria-pressed', String(pasting));
      if (pasting) htmlInput.focus();
    });
    htmlInput.addEventListener('input', debounce(() => {
      currentFile = null;
      srcFileInfo.hidden = true;
      mdOutput.value = DocxToMd.htmlToMarkdown(htmlInput.value);
      refreshOutputState();
    }, 150));
    embedImages.addEventListener('change', () => {
      if (currentFile && currentFile.kind === 'docx') convertCurrentFile();
    });
    mdOutput.addEventListener('input', refreshOutputState);

    document.querySelectorAll('.mini-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const showPreview = tab.dataset.view === 'preview';
        document.querySelectorAll('.mini-tab').forEach((t) => {
          t.classList.toggle('is-active', t === tab);
          t.setAttribute('aria-selected', String(t === tab));
        });
        mdOutput.hidden = showPreview;
        mdOutputPreview.hidden = !showPreview;
        if (showPreview) renderMarkdown(mdOutputPreview, mdOutput.value);
      });
    });

    copyMdBtn.addEventListener('click', () => copyText(mdOutput.value, 'Markdown copied to clipboard'));

    downloadMdBtn.addEventListener('click', () => {
      const filename = safeName($('#mdName').value, 'document') + '.md';
      downloadBlob(textBlob(mdOutput.value), filename);
      toast('Downloaded ' + filename);
    });
  });

  /* ---------- DOCX → PDF / HTML ---------- */

  section('fromDocx', () => {
    const docxFileInfo = $('#docxFileInfo');
    const docxPreview = $('#docxPreview');
    const docxOutName = $('#docxOutName');
    const docxToPdfBtn = $('#docxToPdfBtn');
    const docxToHtmlBtn = $('#docxToHtmlBtn');
    let currentDocx = null; // { name, html } — html is sanitized, with images embedded

    async function loadDocxFile(file) {
      if (/\.doc$/i.test(file.name)) {
        toast('Old .doc files are not supported. Save it as .docx first.', true);
        return;
      }
      if (!/\.docx$/i.test(file.name)) {
        toast('Please choose a .docx file.', true);
        return;
      }
      docxFileInfo.hidden = false;
      docxFileInfo.textContent = 'Reading ' + file.name + '…';
      let html = '';
      try {
        const result = await DocxToMd.toHtml(await file.arrayBuffer(), { keepImages: true });
        html = DOMPurify.sanitize(result.html);
      } catch (err) {
        console.error(err);
        toast('Could not read that file. Make sure it is a valid .docx file.', true);
      }
      currentDocx = html.trim() ? { name: file.name, html: html } : null;
      docxFileInfo.textContent = (currentDocx ? '✓ ' : '✕ ') + file.name;
      docxPreview.innerHTML = currentDocx ? html : '<p class="empty">Nothing to preview.</p>';
      docxToPdfBtn.disabled = docxToHtmlBtn.disabled = !currentDocx;
      if (currentDocx) {
        docxOutName.value = safeName(baseName(file.name), 'document');
        toast('Loaded ' + file.name);
      }
    }

    function exportDocx(button, extension, convert) {
      if (!currentDocx) return;
      const doc = currentDocx;
      withBusy(button, 'Converting…', async () => {
        try {
          const blob = await convert(doc);
          const filename = safeName(docxOutName.value, 'document') + extension;
          downloadBlob(blob, filename);
          toast('Downloaded ' + filename);
        } catch (err) {
          console.error(err);
          toast('Conversion failed. Please check your connection and try again.', true);
        }
      });
    }

    bindDropzone($('#docxDrop'), $('#docxFile'), loadDocxFile);

    docxToHtmlBtn.addEventListener('click', function () {
      exportDocx(this, '.html', (doc) => htmlBlob(doc.html, safeName(baseName(doc.name), 'Document')));
    });

    // The PDF is laid out from the document's structure, so it goes through Markdown.
    docxToPdfBtn.addEventListener('click', function () {
      exportDocx(this, '.pdf', async (doc) => {
        await load('pdfmake');
        return MdToPdf.convert(DocxToMd.htmlToMarkdown(doc.html));
      });
    });
  });
})();
