#!/usr/bin/env python3
"""Builds the ApnaFreeTools site into dist/.

Each tool gets its own folder (so its address is /emi-calculator/ and so on) with its own
title, description, how-to text, FAQ and structured data. The tool markup itself comes from
the files in templates/, and the wording for every page lives in site_content.py.

Run:  python3 build.py        (then publish the dist/ folder)
"""
import datetime
import html
import json
import os
import re
import shutil

from site_content import CATEGORIES, TOOLS, STATIC_PAGES

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, 'dist')
SITE = 'https://apnafreetools.com'
BRAND = 'ApnaFreeTools'
VERSION = '34'  # bump when css/js change so browsers fetch the new files
TODAY = datetime.date.today().isoformat()

ICON_LOCK = ('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" '
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/>'
             '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>')


def esc(text):
    return html.escape(text, quote=True)


def url(slug):
    return '/' if slug == '' else '/' + slug + '/'


def read_template(name):
    with open(os.path.join(ROOT, 'templates', name), encoding='utf-8') as f:
        return f.read()


def balanced_div(source, start):
    """Returns the full <div>...</div> block that opens at index `start`."""
    depth = 0
    for match in re.finditer(r'<div\b|</div>', source[start:]):
        depth += 1 if match.group(0) != '</div>' else -1
        if depth == 0:
            return source[start:start + match.end()]
    raise ValueError('unbalanced <div>')


def panel_markup(template, panel_id):
    start = template.index('<div class="panel" id="panel-%s"' % panel_id)
    block = balanced_div(template, start)
    opening, rest = block.split('>', 1)
    return opening.replace(' hidden', '') + '>' + rest


def single_tool_markup(template):
    return balanced_div(template, template.index('<div class="tool'))


def template_scripts(template):
    tags = re.findall(r'<script defer src="[^"]+"></script>', template)
    out = []
    for tag in tags:
        tag = re.sub(r'src="js/([^"?]+)(\?v=\d+)?"', lambda m: 'src="/js/%s?v=%s"' % (m.group(1), VERSION), tag)
        out.append('  ' + tag)
    return '\n'.join(out)


# ---------- shared page chrome ----------

def head(title, description, slug, json_ld):
    canonical = SITE + url(slug)
    blocks = '\n'.join('  <script type="application/ld+json">%s</script>' % json.dumps(item, ensure_ascii=False)
                       for item in json_ld)
    return '''<!doctype html>
<html lang="en-IN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="{canonical}">
  <meta property="og:site_name" content="{brand}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{canonical}">
  <meta name="twitter:card" content="summary">
  <meta name="theme-color" content="#2f7d4f">
  <link rel="icon" href="/assets/favicon.svg?v={v}" type="image/svg+xml">
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="/css/styles.css?v={v}">
{blocks}
</head>
<body{{body_attrs}}>
'''.format(title=esc(title), description=esc(description), canonical=canonical, brand=BRAND, v=VERSION, blocks=blocks)


def header(active_category):
    links = []
    for key, cat in CATEGORIES.items():
        current = ' aria-current="page"' if key == active_category else ''
        links.append('        <a href="%s"%s>%s</a>' % (url(cat['slug']), current, esc(cat['nav'])))
    return '''  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="{brand} home">
        <img src="/assets/favicon.svg?v={v}" alt="" width="32" height="32">
        <span>Apna<strong>FreeTools</strong></span>
      </a>
      <nav class="site-nav" aria-label="Tool categories">
{links}
      </nav>
    </div>
  </header>
'''.format(brand=BRAND, v=VERSION, links='\n'.join(links))


def footer():
    cats = '\n'.join('        <a href="%s">%s</a>' % (url(cat['slug']), esc(cat['name'])) for cat in CATEGORIES.values())
    return '''  <footer class="site-footer">
    <div class="container footer-inner">
      <span>© <span id="year"></span> {brand} · Free tools that respect your privacy.</span>
      <nav class="footer-nav" aria-label="Footer">
{cats}
        <a href="/about/">About</a>
        <a href="/privacy/">Privacy</a>
      </nav>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
'''.format(brand=BRAND, cats=cats)


def crumbs(trail):
    """trail: list of (label, slug or None for the current page)."""
    parts = ['<a href="/">Home</a>']
    for label, slug in trail:
        parts.append('<a href="%s">%s</a>' % (url(slug), esc(label)) if slug is not None else '<span aria-current="page">%s</span>' % esc(label))
    return '    <nav class="container crumbs" aria-label="Breadcrumb">%s</nav>\n' % ' <span aria-hidden="true">›</span> '.join(parts)


def breadcrumb_ld(trail, slug):
    items = [{'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'}]
    for i, (label, link) in enumerate(trail, start=2):
        items.append({'@type': 'ListItem', 'position': i, 'name': label, 'item': SITE + url(link if link is not None else slug)})
    return {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': items}


def faq_ld(faqs):
    strip = lambda text: re.sub(r'<[^>]+>', '', text)
    return {'@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': [
        {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': strip(a)}} for q, a in faqs]}


def faq_section(faqs):
    items = '\n'.join('        <details><summary>%s</summary><p>%s</p></details>' % (esc(q), a) for q, a in faqs)
    return '''    <section class="container section" id="faq">
      <h2>Frequently asked questions</h2>
      <div class="faq">
{items}
      </div>
    </section>
'''.format(items=items)


def tool_cards(tools, heading=None):
    cards = '\n'.join(
        '        <a class="tool-card" href="%s" data-search="%s"><strong>%s</strong><span>%s</span></a>'
        % (url(t['slug']), esc((t['name'] + ' ' + t['card']).lower()), esc(t['name']), esc(t['card'])) for t in tools)
    title = '      <h2>%s</h2>\n' % esc(heading) if heading else ''
    return '%s      <div class="tool-cards">\n%s\n      </div>\n' % (title, cards)


def write(slug, content):
    folder = os.path.join(DIST, slug)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(content)


# ---------- tool pages ----------

def tool_nav(tool, category, siblings):
    """Links between the tools of a category, shown where the tabs used to be."""
    active = tool.get('parent', tool['slug'])
    if category['layout'] == 'sidebar':
        out, group = [], None
        for t in siblings:
            if 'parent' in t:
                continue
            if t.get('group') != group:
                group = t.get('group')
                out.append('          <span class="calc-group">%s</span>' % esc(group))
            cls, cur = (' is-active', ' aria-current="page"') if t['slug'] == active else ('', '')
            out.append('          <a class="calc-tab%s" href="%s"%s>%s</a>' % (cls, url(t['slug']), cur, esc(t['nav'])))
        return '        <nav class="calc-nav" aria-label="%s">\n%s\n        </nav>\n' % (esc(category['name']), '\n'.join(out))
    tabs = [t for t in siblings if 'tab' in t]
    out = []
    for t in tabs:
        cls, cur = (' is-active', ' aria-current="page"') if t['slug'] == active else ('', '')
        label, small = t['tab']
        out.append('            <a class="seg%s" href="%s"%s>%s <small>%s</small></a>' % (cls, url(t['slug']), cur, esc(label), esc(small)))
    return ('        <div class="tool-top">\n          <nav class="segmented seg-%d" aria-label="%s">\n%s\n          </nav>\n        </div>\n'
            % (len(tabs), esc(category['name']), '\n'.join(out)))


def tool_page(tool, category, siblings, template):
    faqs = tool['faqs'] + [category['privacy_faq']]
    trail = [(category['name'], category['slug']), (tool['name'], None)]
    json_ld = [
        {'@context': 'https://schema.org', '@type': 'WebApplication', 'name': tool['h1'], 'url': SITE + url(tool['slug']),
         'description': tool['desc'], 'applicationCategory': 'UtilitiesApplication', 'operatingSystem': 'Any',
         'isAccessibleForFree': True, 'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'INR'},
         'publisher': {'@type': 'Organization', 'name': BRAND, 'url': SITE + '/'}},
        breadcrumb_ld(trail, tool['slug']),
        faq_ld(faqs),
    ]
    attrs = ''.join(' data-%s="%s"' % (k, esc(str(v))) for k, v in tool.get('preset', {}).items())
    page = head(tool['title'], tool['desc'], tool['slug'], json_ld).replace('{body_attrs}', attrs)
    page += header(tool['category'])
    page += '\n  <main>\n' + crumbs(trail)
    badge = ('        <span class="badge">\n          %s\n          %s\n        </span>\n' % (ICON_LOCK, esc(category['badge']))) if category.get('badge') else ''
    page += '''    <section class="hero hero-sm">
      <div class="container">
{badge}        <h1>{h1}</h1>
        <p class="lead">{lead}</p>
      </div>
    </section>

    <section class="container" id="tool" aria-label="{h1}">
'''.format(badge=badge, h1=esc(tool['h1']), lead=esc(tool['lead']))

    if category['layout'] == 'single':
        page += '      ' + single_tool_markup(template) + '\n'
    elif category['layout'] == 'sidebar':
        page += '      <div class="tool calc-tool">\n' + tool_nav(tool, category, siblings)
        page += '        <div class="calc-body">\n          ' + panel_markup(template, tool['panel']) + '\n        </div>\n      </div>\n'
    else:
        page += '      <div class="tool">\n' + tool_nav(tool, category, siblings)
        page += '        ' + panel_markup(template, tool['panel']) + '\n      </div>\n'
    page += '    </section>\n\n'

    steps = '\n'.join('          <li>%s</li>' % step for step in tool['steps'])
    paragraphs = '\n'.join('        <p>%s</p>' % p for p in tool['more'])
    page += '''    <section class="container section">
      <div class="article">
        <h2>{heading}: how it works</h2>
        <ol>
{steps}
        </ol>
{paragraphs}
      </div>
    </section>

'''.format(heading=esc(tool['h1']), steps=steps, paragraphs=paragraphs)
    page += faq_section(faqs) + '\n'
    others = [t for t in siblings if t['slug'] != tool['slug']]
    page += '    <section class="container section">\n' + tool_cards(others, 'More ' + category['name'].lower()) + '    </section>\n'
    page += '  </main>\n\n' + footer() + '\n' + template_scripts(template) + '\n</body>\n</html>\n'
    write(tool['slug'], page)


# ---------- hubs, home and static pages ----------

def hub_page(key, category, tools):
    trail = [(category['name'], None)]
    json_ld = [
        {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': category['h1'], 'url': SITE + url(category['slug']),
         'description': category['desc'],
         'mainEntity': {'@type': 'ItemList', 'itemListElement': [
             {'@type': 'ListItem', 'position': i, 'name': t['name'], 'url': SITE + url(t['slug'])} for i, t in enumerate(tools, start=1)]}},
        breadcrumb_ld(trail, category['slug']),
    ]
    page = head(category['title'], category['desc'], category['slug'], json_ld).replace('{body_attrs}', '')
    page += header(key) + '\n  <main>\n' + crumbs(trail)
    page += '''    <section class="hero hero-sm">
      <div class="container">
        <h1>{h1}</h1>
        <p class="lead">{lead}</p>
      </div>
    </section>

    <section class="container">
{cards}    </section>

    <section class="container section">
      <div class="article">
{about}
      </div>
    </section>
  </main>

'''.format(h1=esc(category['h1']), lead=esc(category['lead']), cards=tool_cards(tools),
           about='\n'.join('        <p>%s</p>' % p for p in category['about']))
    page += footer() + '\n  <script defer src="/js/common.js?v=%s"></script>\n</body>\n</html>\n' % VERSION
    write(category['slug'], page)


def home_page():
    title = 'ApnaFreeTools – Free Online PDF, Image & Document Tools'
    desc = ('Free online tools for India: compress and merge PDFs, resize photos to 20 KB, convert documents, '
            'calculate GST, EMI and tax, and more. No sign-up, files stay on your device.')
    json_ld = [
        {'@context': 'https://schema.org', '@type': 'WebSite', 'name': BRAND, 'url': SITE + '/'},
        {'@context': 'https://schema.org', '@type': 'Organization', 'name': BRAND, 'url': SITE + '/', 'logo': SITE + '/assets/favicon.svg'},
    ]
    page = head(title, desc, '', json_ld).replace('{body_attrs}', '') + header(None)
    sections = ''
    for key, category in CATEGORIES.items():
        tools = [t for t in TOOLS if t['category'] == key]
        sections += ('    <section class="container section home-group">\n      <h2><a href="%s">%s</a></h2>\n%s    </section>\n\n'
                     % (url(category['slug']), esc(category['name']), tool_cards(tools)))
    page += '''
  <main>
    <section class="hero">
      <div class="container">
        <span class="badge">
          {lock}
          Private by design — your files stay on your device
        </span>
        <h1>Free online tools, <span class="swap">no sign-up</span></h1>
        <p class="lead">{count} free tools for PDFs, photos, documents, calculations and code. Everything runs in your browser.</p>
        <label class="home-search">
          <span class="sr-only">Search tools</span>
          <input type="search" id="toolSearch" placeholder="Search tools, e.g. compress PDF, EMI, QR code" autocomplete="off">
        </label>
        <p class="empty" id="toolSearchEmpty" hidden>No tool matches that search.</p>
      </div>
    </section>

{sections}  </main>

'''.format(lock=ICON_LOCK, count=len(TOOLS), sections=sections)
    page += footer() + '\n  <script defer src="/js/common.js?v=%s"></script>\n  <script defer src="/js/home.js?v=%s"></script>\n</body>\n</html>\n' % (VERSION, VERSION)
    with open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(page)


def static_page(page_data):
    trail = [(page_data['name'], None)]
    page = head(page_data['title'], page_data['desc'], page_data['slug'], [breadcrumb_ld(trail, page_data['slug'])]).replace('{body_attrs}', '')
    page += header(None) + '\n  <main>\n' + crumbs(trail)
    page += '''    <section class="hero hero-sm">
      <div class="container">
        <h1>{h1}</h1>
      </div>
    </section>
    <section class="container">
      <div class="article">
{body}
      </div>
    </section>
  </main>

'''.format(h1=esc(page_data['name']), body='\n'.join('        ' + block for block in page_data['body']))
    page += footer() + '\n  <script defer src="/js/common.js?v=%s"></script>\n</body>\n</html>\n' % VERSION
    write(page_data['slug'], page)


def check(tools):
    """Catches the mistakes that are easy to make in site_content.py."""
    slugs = [t['slug'] for t in tools] + [c['slug'] for c in CATEGORIES.values()] + [p['slug'] for p in STATIC_PAGES]
    assert len(slugs) == len(set(slugs)), 'duplicate slug'
    for item in tools + list(CATEGORIES.values()):
        if len(item['title']) > 62:
            print('  note: long title (%d): %s' % (len(item['title']), item['title']))
        if len(item['desc']) > 160:
            print('  note: long description (%d): %s' % (len(item['desc']), item['slug']))


def main():
    check(TOOLS)
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    for folder in ('css', 'js', 'assets'):
        shutil.copytree(os.path.join(ROOT, folder), os.path.join(DIST, folder))

    templates = {}
    pages = ['']
    for key, category in CATEGORIES.items():
        tools = [t for t in TOOLS if t['category'] == key]
        hub_page(key, category, tools)
        pages.append(category['slug'])
        for tool in tools:
            name = tool.get('template', category.get('template'))
            if name not in templates:
                templates[name] = read_template(name)
            layout = dict(category, layout=tool.get('layout', category['layout']))
            tool_page(tool, layout, tools, templates[name])
            pages.append(tool['slug'])
    home_page()
    for page_data in STATIC_PAGES:
        static_page(page_data)
        pages.append(page_data['slug'])

    with open(os.path.join(DIST, 'sitemap.xml'), 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for slug in pages:
            f.write('  <url><loc>%s%s</loc><lastmod>%s</lastmod></url>\n' % (SITE, url(slug), TODAY))
        f.write('</urlset>\n')
    with open(os.path.join(DIST, 'robots.txt'), 'w', encoding='utf-8') as f:
        f.write('User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' % SITE)
    print('Built %d pages into dist/' % len(pages))


if __name__ == '__main__':
    main()
