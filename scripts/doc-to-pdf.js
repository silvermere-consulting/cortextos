#!/usr/bin/env node
/**
 * doc-to-pdf.js — render any project markdown doc to a clean print-ready PDF.
 * Uses Playwright Chromium (already installed) and marked (from dashboard node_modules).
 *
 * Usage:
 *   node scripts/doc-to-pdf.js <input.md> [output.pdf]
 *
 * If output path is omitted, writes <input-basename>.pdf alongside the input file.
 */

const { chromium } = require('playwright');
const { marked } = require('/home/cortext/cortextos/dashboard/node_modules/marked');
const fs = require('fs');
const path = require('path');

function findChrome() {
  // Prefer agent-browser managed install, then system Chrome/Chromium
  const candidates = [
    // agent-browser (version-glob)
    ...(() => {
      try {
        const base = path.join(process.env.HOME || '/root', '.agent-browser', 'browsers');
        if (!fs.existsSync(base)) return [];
        return fs.readdirSync(base)
          .filter(d => d.startsWith('chrome-'))
          .map(d => path.join(base, d, 'chrome'))
          .filter(fs.existsSync);
      } catch { return []; }
    })(),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined; // let Playwright use its own default
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/doc-to-pdf.js <input.md> [output.pdf]');
  process.exit(1);
}

const resolvedInput = path.resolve(inputPath);
if (!fs.existsSync(resolvedInput)) {
  console.error(`File not found: ${resolvedInput}`);
  process.exit(1);
}

const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : resolvedInput.replace(/\.(md|markdown|txt)$/i, '.pdf');

const markdown = fs.readFileSync(resolvedInput, 'utf-8');

// Strip YAML front matter (---\n...\n---) and convert first field values to a subtitle block
function stripFrontMatter(src) {
  const match = src.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) return { meta: {}, body: src };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: src.slice(match[0].length) };
}

const { meta, body } = stripFrontMatter(markdown);
const htmlBody = marked.parse(body);

// Build a subtitle block from front matter fields (Date, Author, Purpose)
const metaLines = ['Date', 'Author', 'Purpose', 'Status']
  .filter(k => meta[k] || meta[k.toLowerCase()])
  .map(k => {
    const v = meta[k] || meta[k.toLowerCase()];
    return `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val">${v}</span></div>`;
  })
  .join('');
const metaBlock = metaLines ? `<div class="meta-block">${metaLines}</div>` : '';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${meta.project || path.basename(resolvedInput, path.extname(resolvedInput))}</title>
<style>
  /* Base */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 10.5pt;
    line-height: 1.65;
    color: #111;
    background: #fff;
    padding: 0;
    margin: 0;
  }

  /* Page layout */
  .page {
    max-width: 680px;
    margin: 0 auto;
    padding: 48px 32px 64px;
  }

  /* Front matter meta block */
  .meta-block {
    border-top: 2px solid #111;
    border-bottom: 1px solid #ddd;
    padding: 10px 0;
    margin-bottom: 28px;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 8.5pt;
  }
  .meta-row {
    display: flex;
    gap: 12px;
    padding: 2px 0;
  }
  .meta-key {
    font-weight: 600;
    color: #555;
    min-width: 72px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 7.5pt;
  }
  .meta-val {
    color: #333;
  }

  /* Headings */
  h1 {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 20pt;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 6px;
    color: #000;
    letter-spacing: -0.02em;
  }
  h2 {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 13pt;
    font-weight: 700;
    margin-top: 28px;
    margin-bottom: 8px;
    color: #000;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 4px;
  }
  h3 {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5pt;
    font-weight: 700;
    margin-top: 20px;
    margin-bottom: 5px;
    color: #222;
  }
  h4, h5, h6 {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
    font-weight: 600;
    margin-top: 14px;
    margin-bottom: 4px;
    color: #333;
  }

  /* Paragraphs */
  p { margin-bottom: 10px; }
  p:last-child { margin-bottom: 0; }

  /* Lists */
  ul, ol {
    margin: 8px 0 10px 20px;
    padding: 0;
  }
  li {
    margin-bottom: 4px;
  }
  li > ul, li > ol {
    margin-top: 4px;
    margin-bottom: 4px;
  }

  /* Inline code */
  code {
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 8.5pt;
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    border-radius: 3px;
    padding: 1px 4px;
  }

  /* Block code */
  pre {
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 10px 12px;
    margin: 10px 0;
    overflow: visible;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre code {
    background: none;
    border: none;
    padding: 0;
    font-size: 8pt;
  }

  /* Blockquote */
  blockquote {
    border-left: 3px solid #bbb;
    margin: 12px 0;
    padding: 4px 12px;
    color: #555;
    font-style: italic;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 9.5pt;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    page-break-inside: avoid;
  }
  thead {
    background: #f0f0f0;
  }
  th {
    font-weight: 600;
    text-align: left;
    padding: 6px 10px;
    border: 1px solid #ccc;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #333;
  }
  td {
    padding: 6px 10px;
    border: 1px solid #ddd;
    vertical-align: top;
  }
  tr:nth-child(even) td {
    background: #fafafa;
  }

  /* Horizontal rule */
  hr {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 20px 0;
  }

  /* Strong / em */
  strong { font-weight: 700; }
  em { font-style: italic; }

  /* Checkboxes in task lists */
  input[type="checkbox"] {
    margin-right: 6px;
  }

  /* Links — no underline in print, just colour */
  a { color: #111; text-decoration: none; }

  /* Page breaks */
  h2 { page-break-after: avoid; }
  h3 { page-break-after: avoid; }
  table { page-break-inside: avoid; }

  /* Footer */
  @page {
    size: A4;
    margin: 18mm 16mm 22mm;
  }
</style>
</head>
<body>
<div class="page">
  ${metaBlock}
  ${htmlBody}
</div>
</body>
</html>`;

(async () => {
  const chromePath = findChrome();
  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '16mm', bottom: '22mm', left: '16mm' },
  });
  await browser.close();
  console.log(`PDF written to: ${outputPath}`);
})().catch(err => {
  console.error('PDF generation failed:', err.message);
  process.exit(1);
});
