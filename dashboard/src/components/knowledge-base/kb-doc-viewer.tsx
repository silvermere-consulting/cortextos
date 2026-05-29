'use client';

import { useEffect, useState, useCallback } from 'react';
import { IconX, IconFileText, IconLoader2, IconAlertCircle, IconExternalLink, IconDownload } from '@tabler/icons-react';
import { renderMarkdown } from '@/lib/render-markdown';

const PDF_EXTS = new Set(['pdf']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']);

function getExt(p: string): string {
  return p.split('.').pop()?.toLowerCase() ?? '';
}

interface KbDocViewerProps {
  filePath: string;
  org: string;
  onClose: () => void;
  onOpenDoc?: (path: string) => void;
}

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : p;
}

export function KbDocViewer({ filePath, org, onClose, onOpenDoc }: KbDocViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [ext, setExt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fileExt = getExt(filePath);
  const isBinary = PDF_EXTS.has(fileExt) || IMAGE_EXTS.has(fileExt);
  const downloadUrl = `/api/kb/document/download?${new URLSearchParams({ path: filePath, org })}`;

  const load = useCallback(async () => {
    // Binary files (PDF, images) are served directly — skip the text fetch
    if (isBinary) {
      setFilename(filePath.split('/').pop() ?? filePath);
      setExt(fileExt);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ path: filePath, org });
      const res = await fetch(`/api/kb/document?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to load document (${res.status})`);
        return;
      }
      const data = await res.json();
      setContent(data.content);
      setFilename(data.filename);
      setExt(data.ext);
    } catch {
      setError('Network error — could not load document');
    } finally {
      setLoading(false);
    }
  }, [filePath, org, isBinary, fileExt]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Intercept clicks on KB deep-links inside the rendered doc (DTNAV-2.1).
  // Links matching /knowledge-base?...&doc=<path> are routed through onOpenDoc
  // so the history stack is updated correctly instead of performing a full navigation.
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onOpenDoc) return;
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    try {
      const url = new URL(href, window.location.origin);
      if (url.pathname === '/knowledge-base') {
        const docPath = url.searchParams.get('doc');
        if (docPath) {
          e.preventDefault();
          onOpenDoc(docPath);
        }
      }
    } catch { /* not a valid URL — let the browser handle it */ }
  }, [onOpenDoc]);

  const isMarkdown = ext === 'md' || ext === 'markdown';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-background shadow-2xl border-l">
        {/* Header */}
        <div className="flex items-center gap-3 border-b px-5 py-3.5">
          <IconFileText size={16} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{filename || 'Document'}</p>
            <p className="text-[11px] text-muted-foreground truncate" title={filePath}>
              {shortPath(filePath)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-40 gap-2 text-sm text-muted-foreground">
              <IconLoader2 size={16} className="animate-spin" />
              Loading document…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center gap-2 m-5 text-sm text-destructive rounded-md border border-destructive/30 p-3">
              <IconAlertCircle size={15} />
              {error}
            </div>
          )}

          {!loading && !error && PDF_EXTS.has(fileExt) && (
            <div className="flex flex-col gap-2">
              {/* Mobile Safari + many iOS browsers won't render PDF inline in
                  an iframe. Always show open + download buttons above the
                  iframe so the document is reachable on every device. */}
              <div className="flex flex-wrap gap-2 px-5 pt-4">
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                >
                  <IconExternalLink size={13} /> Open PDF
                </a>
                <a
                  href={downloadUrl}
                  download={filename}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  <IconDownload size={13} /> Download
                </a>
              </div>
              <iframe
                src={downloadUrl}
                className="w-full border-0"
                style={{ minHeight: '70vh' }}
                title={filename}
              />
            </div>
          )}

          {!loading && !error && IMAGE_EXTS.has(fileExt) && (
            <div className="p-5 flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={downloadUrl} alt={filename} className="max-w-full rounded border" />
              <a
                href={downloadUrl}
                download={filename}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <IconDownload size={12} /> Download
              </a>
            </div>
          )}

          {!loading && !error && !isBinary && content !== null && (
            <div className="p-5" onClick={handleContentClick}>
              {isMarkdown ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  {renderMarkdown(content)}
                </div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed text-foreground/80">
                  {content}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-2.5 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {content !== null ? `${content.length.toLocaleString()} chars` : ''}
          </span>
          <button
            onClick={onClose}
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <IconExternalLink size={11} />
            Close (Esc)
          </button>
        </div>
      </div>
    </>
  );
}
