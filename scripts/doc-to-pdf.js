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

const explicitOutput = !!process.argv[3];
let outputPath = explicitOutput
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
const inputDir = path.dirname(resolvedInput);

// Post-process parsed HTML: replace local <img src="..."> with base64 data URIs
// so Playwright's setContent() (which has no baseURL) can render them.
function inlineLocalImages(html) {
  return html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/gi, (match, pre, src, post) => {
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
      return match; // already inline or remote — leave as-is
    }
    try {
      const abs = path.isAbsolute(src) ? src : path.resolve(inputDir, src);
      if (!fs.existsSync(abs)) return match;
      const ext = path.extname(abs).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      const mime = mimeMap[ext] || 'image/jpeg';
      const b64 = fs.readFileSync(abs).toString('base64');
      return `<img${pre}src="data:${mime};base64,${b64}"${post}>`;
    } catch { return match; }
  });
}

const htmlBody = inlineLocalImages(marked.parse(body));

// Project-code prefix from frontmatter — prepend "<code>-" to the auto-computed output
// filename when `project_code:` is set, the user did NOT pass an explicit output path, and
// the basename does not already start with the prefix (idempotent). See
// orgs/silvermere-tech/docs/wow-project-codes.md for the approved codes.
if (meta.project_code && !explicitOutput) {
  const code = meta.project_code.replace(/^['"]|['"]$/g, '');
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  const prefix = `${code}-`;
  if (code && !base.startsWith(prefix)) {
    outputPath = path.join(dir, prefix + base);
  }
}

// Build a subtitle block from front matter fields (Date, Author, Purpose)
const metaLines = ['Date', 'Author', 'Purpose', 'Status']
  .filter(k => meta[k] || meta[k.toLowerCase()])
  .map(k => {
    const v = meta[k] || meta[k.toLowerCase()];
    return `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val">${v}</span></div>`;
  })
  .join('');
const metaBlock = metaLines ? `<div class="meta-block">${metaLines}</div>` : '';

// brand_mode: "silvermere" = Silvermere Advisory logo (group brand) + gold rule;
// default (or omitted / "soft") = no wordmark.
// Steven framing (2026-05-29): Silvermere Advisory is the PARENT brand; Silvermere Technology
// is the operating arm. Every Silvermere PDF, regardless of which arm authored it, carries
// the Advisory logo as the group brand anchor. Per-arm differentiation (if ever needed) lives
// in the document body or meta block, not the brand header.
// Defaulting to "soft" (no branding) so this script is org-agnostic out of the box. Authors who want
// the Silvermere group brand explicitly add `brand_mode: silvermere` to their PDF frontmatter.
// Backward-compat: the legacy "default" value is treated as "silvermere" so existing docs that relied
// on the implicit-Silvermere behaviour keep rendering with the brand header.
const brandModeRaw = (meta.brand_mode || meta.brandMode || 'soft').toLowerCase();
const brandMode = brandModeRaw === 'default' ? 'silvermere' : brandModeRaw;
// Inline the Silvermere Advisory logo as base64 so the rendered PDF is self-contained
// (no external image requests during render). Prefer the transparent-background PNG; fall
// back to the source JPG, then a text wordmark if neither file exists.
const SILVERMERE_LOGO_DIR = path.join(__dirname, '..', 'orgs', 'silvermere-tech', 'brand');
const SILVERMERE_LOGO_CANDIDATES = [
  { file: 'silvermere-advisory-logo.png', mime: 'image/png' },
  { file: 'silvermere-advisory-logo.jpg', mime: 'image/jpeg' },
];
let brandLogoSrc = '';
for (const { file, mime } of SILVERMERE_LOGO_CANDIDATES) {
  const p = path.join(SILVERMERE_LOGO_DIR, file);
  try {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      brandLogoSrc = `data:${mime};base64,${buf.toString('base64')}`;
      break;
    }
  } catch { /* try next */ }
}

// PYLOT brand-mode logo (same brand/ directory). SVG preferred for crispness; PNG fallback.
// Text fallback (PYLOT · بيلوت) renders if neither file exists.
const PYLOT_LOGO_CANDIDATES = [
  { file: 'pylot-logo.svg', mime: 'image/svg+xml' },
  { file: 'pylot-logo.png', mime: 'image/png' },
  { file: 'pylot-logo.jpg', mime: 'image/jpeg' },
];
let pylotLogoSrc = '';
for (const { file, mime } of PYLOT_LOGO_CANDIDATES) {
  const p = path.join(SILVERMERE_LOGO_DIR, file);
  try {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      pylotLogoSrc = `data:${mime};base64,${buf.toString('base64')}`;
      break;
    }
  } catch { /* try next */ }
}

// ClearSpeak brand-mode logo (same brand/ directory). Red wordmark for face-to-face
// sharing with Robyn. Banked 2026-06-08 — writer was using brand_mode: silvermere
// for ClearSpeak docs because there was no clearspeak mode.
const CLEARSPEAK_LOGO_CANDIDATES = [
  { file: 'clearspeak-logo.png', mime: 'image/png' },
  { file: 'clearspeak-logo.svg', mime: 'image/svg+xml' },
  { file: 'clearspeak-logo.jpg', mime: 'image/jpeg' },
];
let clearspeakLogoSrc = '';
for (const { file, mime } of CLEARSPEAK_LOGO_CANDIDATES) {
  const p = path.join(SILVERMERE_LOGO_DIR, file);
  try {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      clearspeakLogoSrc = `data:${mime};base64,${buf.toString('base64')}`;
      break;
    }
  } catch { /* try next */ }
}

// ClearSpeak FOOTER logo (black horizontal) — paired with the red-stacked
// header logo per Steve brand assets v1.0 (2026-06-08). Rendered as a CSS
// page-margin footer so it appears on every page of the PDF.
const CLEARSPEAK_FOOTER_LOGO_CANDIDATES = [
  { file: 'clearspeak-logo-footer.png', mime: 'image/png' },
  { file: 'clearspeak-logo-footer.svg', mime: 'image/svg+xml' },
  { file: 'clearspeak-logo-footer.jpg', mime: 'image/jpeg' },
];
let clearspeakFooterLogoSrc = '';
for (const { file, mime } of CLEARSPEAK_FOOTER_LOGO_CANDIDATES) {
  const p = path.join(SILVERMERE_LOGO_DIR, file);
  try {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      clearspeakFooterLogoSrc = `data:${mime};base64,${buf.toString('base64')}`;
      break;
    }
  } catch { /* try next */ }
}

const brandHeader = brandMode === 'silvermere'
  ? `<div class="brand-header">
    ${brandLogoSrc
      ? `<img class="brand-logo" src="${brandLogoSrc}" alt="Silvermere Advisory" />`
      : `<span class="brand-name">Silvermere Advisory</span>`}
    <span class="brand-rule-dot"></span>
  </div>`
  : brandMode === 'pylot'
  ? `<div class="brand-header brand-header--pylot">
    ${pylotLogoSrc
      ? `<img class="brand-logo brand-logo--pylot" src="${pylotLogoSrc}" alt="PYLOT" />`
      : `<span class="brand-name brand-name--pylot">PYLOT &middot; بيلوت</span>`}
    <span class="brand-rule-dot"></span>
  </div>`
  : brandMode === 'clearspeak'
  ? `<div class="brand-header brand-header--clearspeak">
    ${clearspeakLogoSrc
      ? `<img class="brand-logo brand-logo--clearspeak" src="${clearspeakLogoSrc}" alt="ClearSpeak" />`
      : `<span class="brand-name brand-name--clearspeak">ClearSpeak</span>`}
    <span class="brand-rule-dot brand-rule-dot--clearspeak"></span>
  </div>`
  : '';

// orientation: "landscape" flips the PDF page to A4 landscape with tighter margins.
// Default (or omitted) = portrait, unchanged from prior behaviour.
const isLandscape = (meta.orientation || meta.layout || 'portrait').toLowerCase() === 'landscape';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${meta.project || path.basename(resolvedInput, path.extname(resolvedInput))}</title>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;900&display=swap" rel="stylesheet">
<style>
  /* Silvermere brand palette (from silvermereadvisory.com)
     Primary Navy:  #0B234A  — headings, brand header, strong accents
     Accent Gold:   #D4AF37  — rules, thead, blockquote, gold highlights
     Warm Stone:    #B4AD9A  — secondary text, muted labels
     Background:    #FBF9F8  — warm white
     Body text:     #242424  — near-black
     Font:          Roboto (weights 300 + 900) / system sans-serif fallback
  */

  /* Base */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-weight: 300;
    font-size: 10.5pt;
    line-height: 1.65;
    color: #242424;
    background: #FBF9F8;
    padding: 0;
    margin: 0;
  }

  /* Page layout */
  .page {
    max-width: ${isLandscape ? '1040px' : '680px'};
    margin: 0 auto;
    padding: ${isLandscape ? '20px 24px 28px' : '48px 32px 64px'};
  }

  /* Silvermere brand header (logo + gold rule) */
  .brand-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 2px solid #D4AF37;
    padding-bottom: 10px;
    margin-bottom: 28px;
  }
  .brand-logo {
    height: 42px;
    width: auto;
    display: block;
  }
  .brand-name {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 7pt;
    font-weight: 900;
    color: #0B234A;
    letter-spacing: 0.22em;
    text-transform: uppercase;
  }
  .brand-rule-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #D4AF37;
  }

  /* PYLOT brand variant (overrides the Silvermere defaults above) */
  .brand-header--pylot {
    border-bottom: 3px solid #111;
  }
  .brand-logo--pylot {
    /* v3 logo (Steve 2026-06-08): 1774x887 landscape mark — bumped from 48px */
    /* to 96px for stronger header presence on investor briefs. 96px tall x */
    /* ~192px wide reads prominent without dominating body content. */
    height: 96px;
    width: auto;
  }
  .brand-name--pylot {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 18pt;
    font-weight: 900;
    color: #111;
    letter-spacing: 0.12em;
    text-transform: none;
  }

  /* ClearSpeak GCC brand variant (overrides the Silvermere defaults above) */
  /* Brand assets v1.0 (Steve 2026-06-08): red-stacked square logo top-left, */
  /* black-horizontal logo in page footer. Signal-red rule + warm ink palette */
  /* matches the ClearSpeak Studio UI. */
  .brand-header--clearspeak {
    border-bottom: 2px solid #B92438;
    padding: 6px 0;
  }
  .brand-logo--clearspeak {
    /* Stacked square logo — slightly taller than the landscape pylot variant */
    /* so the GCC sub-mark stays legible at print resolution. */
    height: 56px;
    width: auto;
  }
  .brand-name--clearspeak {
    font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 14pt;
    font-weight: 800;
    color: #1A1A1A;
    letter-spacing: 0.06em;
    text-transform: none;
  }
  .brand-rule-dot--clearspeak {
    background: #B92438;
  }

  /* Front matter meta block */
  .meta-block {
    border-top: 1px solid #D4AF37;
    border-bottom: 1px solid rgba(180,173,154,0.4);
    background: rgba(180,173,154,0.08);
    padding: 10px 12px;
    margin-bottom: 28px;
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 8.5pt;
    border-radius: 2px;
  }
  .meta-row {
    display: flex;
    gap: 12px;
    padding: 2px 0;
  }
  .meta-key {
    font-weight: 900;
    color: #B4AD9A;
    min-width: 72px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 7pt;
  }
  .meta-val {
    color: #242424;
    font-weight: 300;
  }

  /* Headings */
  h1 {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 20pt;
    font-weight: 900;
    line-height: 1.2;
    margin-bottom: 6px;
    color: #0B234A;
    letter-spacing: -0.01em;
  }
  h2 {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 13pt;
    font-weight: 900;
    margin-top: 28px;
    margin-bottom: 8px;
    color: #0B234A;
    border-bottom: 1.5px solid #D4AF37;
    padding-bottom: 4px;
  }
  h3 {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5pt;
    font-weight: 900;
    margin-top: 20px;
    margin-bottom: 5px;
    color: #0B234A;
  }
  h4, h5, h6 {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
    font-weight: 900;
    margin-top: 14px;
    margin-bottom: 4px;
    color: #D4AF37;
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
    font-family: 'JetBrains Mono', 'Menlo', 'Consolas', monospace;
    font-size: 8.5pt;
    background: rgba(180,173,154,0.12);
    border: 1px solid rgba(180,173,154,0.4);
    border-radius: 3px;
    padding: 1px 4px;
  }

  /* Block code */
  pre {
    background: rgba(180,173,154,0.12);
    border: 1px solid rgba(180,173,154,0.4);
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
    border-left: 3px solid #D4AF37;
    margin: 12px 0;
    padding: 4px 12px;
    color: #B4AD9A;
    font-style: italic;
    background: rgba(212,175,55,0.04);
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 9.5pt;
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    page-break-inside: avoid;
  }
  thead {
    background: #0B234A;
  }
  th {
    font-weight: 900;
    text-align: left;
    padding: 6px 10px;
    border: 1px solid #0B234A;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #D4AF37;
  }
  td {
    padding: 6px 10px;
    border: 1px solid rgba(180,173,154,0.35);
    vertical-align: top;
    font-weight: 300;
  }
  tr:nth-child(even) td {
    background: rgba(180,173,154,0.07);
  }

  /* Horizontal rule */
  hr {
    border: none;
    border-top: 1px solid rgba(180,173,154,0.4);
    margin: 20px 0;
  }

  /* Strong / em */
  strong { font-weight: 900; }
  em { font-style: italic; }

  /* Checkboxes in task lists */
  input[type="checkbox"] {
    margin-right: 6px;
  }

  /* Links — navy in print */
  a { color: #0B234A; text-decoration: none; }

  /* Page breaks */
  h2 { page-break-after: avoid; }
  h3 { page-break-after: avoid; }
  table { page-break-inside: avoid; }

  @page {
    size: A4${isLandscape ? ' landscape' : ''};
    margin: ${isLandscape ? '10mm' : '18mm 16mm 22mm'};
  }
</style>
</head>
<body>
<div class="page">
  ${brandHeader}
  ${metaBlock}
  ${htmlBody}
</div>
</body>
</html>`;

// Per-page footer template — currently only for clearspeak brand mode.
// Playwright requires self-contained HTML with explicit font sizing in
// header/footer templates (zero is the default and would render blank).
const footerTemplate = brandMode === 'clearspeak' && clearspeakFooterLogoSrc
  ? `<div style="width:100%; padding:0 14mm; display:flex; justify-content:center; align-items:center; font-size:0;">
       <img src="${clearspeakFooterLogoSrc}" style="height:32px; width:auto; display:block;" alt="ClearSpeak GCC" />
     </div>`
  : '';
const useFooter = footerTemplate !== '';
// Bump bottom margin when footer is active so content doesn't collide with it.
const portraitBottomMargin = useFooter ? '32mm' : '22mm';
const landscapeBottomMargin = useFooter ? '24mm' : '10mm';

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
    landscape: isLandscape,
    printBackground: true,
    margin: isLandscape
      ? { top: '10mm', right: '10mm', bottom: landscapeBottomMargin, left: '10mm' }
      : { top: '18mm', right: '16mm', bottom: portraitBottomMargin, left: '16mm' },
    displayHeaderFooter: useFooter,
    // Empty header so the default "Page X of Y" / URL doesn't appear when
    // displayHeaderFooter is on.
    headerTemplate: '<div></div>',
    footerTemplate: footerTemplate || '<div></div>',
  });
  await browser.close();
  console.log(`PDF written to: ${outputPath}`);
})().catch(err => {
  console.error('PDF generation failed:', err.message);
  process.exit(1);
});
