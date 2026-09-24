// Turns a docs/*.md file into one self-contained .html (images embedded) you can double-click.
// Handles what the plugin docs use: headings, paragraphs, fenced code, lists, tables, images, links, bold, inline code.
// Usage: node scripts/md-to-html.js docs/BUILD-A-PLUGIN.md
const fs = require('fs');
const path = require('path');

const src = path.resolve(process.argv[2] || 'docs/BUILD-A-PLUGIN.md');
const dir = path.dirname(src);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

function embed(href) {
  if (/^(https?:|#|data:)/.test(href)) return href;
  const f = path.join(dir, href.replace(/#.*$/, ''));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return href;
  const ext = path.extname(f).toLowerCase();
  if (!MIME[ext]) return href.endsWith('.md') ? href.replace(/\.md/, '.html') : href;
  return `data:${MIME[ext]};base64,${fs.readFileSync(f).toString('base64')}`;
}

function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => `<img alt="${alt}" src="${embed(href)}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href.replace(/\.md(#|$)/, '.html$1')}">${text}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
const out = [];
for (let i = 0; i < lines.length;) {
  const l = lines[i];
  if (/^```/.test(l)) {
    const buf = [];
    for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
    i++;
    out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
  } else if (/^#{1,6} /.test(l)) {
    const n = l.match(/^#+/)[0].length;
    const text = l.replace(/^#+ /, '');
    const id = text.toLowerCase().replace(/[`]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    out.push(`<h${n} id="${id}">${inline(text)}</h${n}>`);
    i++;
  } else if (/^\|/.test(l) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] || '')) {
    const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    const head = cells(l);
    i += 2;
    const rows = [];
    for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
    out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  } else if (/^\s*[-*] /.test(l) || /^\d+\. /.test(l)) {
    const ordered = /^\d+\. /.test(l);
    const items = [];
    for (; i < lines.length && (/^\s*[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
      if (/^\s{2,}\S/.test(lines[i]) && !/^\s*[-*] /.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
      else items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ''));
    }
    out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
  } else if (l.trim() === '') {
    i++;
  } else {
    const buf = [];
    for (; i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,6} |\|)/.test(lines[i]) && !/^\s*[-*] /.test(lines[i]) && !/^\d+\. /.test(lines[i]); i++) buf.push(lines[i]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
}

const title = (lines.find((l) => /^# /.test(l)) || '# Document').slice(2);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body { max-width: 900px; margin: 40px auto; padding: 0 24px; font: 16px/1.6 "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #1f2328; background: #fff; }
  h1, h2 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; } h1 { font-size: 2em; } h2 { margin-top: 1.8em; }
  code { background: #eff1f3; padding: .15em .4em; border-radius: 6px; font: 0.88em ui-monospace, Consolas, monospace; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; overflow: auto; line-height: 1.45; }
  pre code { background: none; padding: 0; font-size: 13.5px; }
  img { max-width: 100%; height: auto; border-radius: 10px; margin: 8px 0; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; vertical-align: top; } th { background: #f6f8fa; }
  a { color: #0969da; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } h1, h2, th, td, pre { border-color: #30363d; } code { background: #2a313c; } pre, th { background: #161b22; } a { color: #58a6ff; } }
</style></head><body>${out.join('\n')}</body></html>`;

const dest = src.replace(/\.md$/, '.html');
fs.writeFileSync(dest, html);
console.log('wrote', dest, `${Math.round(html.length / 1024)} KB`);
