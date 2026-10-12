// Wraps converted content in a standalone, styled HTML page for download.
(function (global) {
  'use strict';

  const CSS = [
    'body{max-width:760px;margin:40px auto;padding:0 20px;color:#1f2328;background:#fff;',
    'font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}',
    'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em}',
    'h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}',
    'p,ul,ol,blockquote,pre,table{margin:0 0 1em}',
    'a{color:#0563c1}',
    'img{max-width:100%;height:auto}',
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#f3f4f6;padding:.15em .4em;border-radius:4px}',
    'pre{background:#f3f4f6;padding:14px 16px;border-radius:8px;overflow-x:auto}',
    'pre code{background:none;padding:0}',
    'blockquote{padding-left:14px;border-left:3px solid #c7cbd6;color:#5d6474}',
    'table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}',
    'th,td{border:1px solid #d0d7de;padding:7px 12px;text-align:left}',
    'th{background:#f3f4f6}',
    'hr{border:0;border-top:1px solid #d0d7de;margin:2em 0}',
    'li:has(>input[type=checkbox]){list-style:none;margin-left:-1.3em}',
  ].join('\n');

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // `bodyHtml` must already be sanitized.
  function build(bodyHtml, fallbackTitle) {
    const probe = new DOMParser().parseFromString(bodyHtml, 'text/html');
    const heading = probe.body.querySelector('h1, h2');
    const title = (heading && heading.textContent.trim()) || fallbackTitle || 'Document';
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + escapeHtml(title) + '</title>',
      '<style>',
      CSS,
      '</style>',
      '</head>',
      '<body>',
      bodyHtml.trim(),
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  function fromMarkdown(markdown) {
    return global.DOMPurify.sanitize(global.marked.parse(markdown || '', { gfm: true }));
  }

  global.HtmlDoc = { build: build, fromMarkdown: fromMarkdown };
})(window);
