'use client';

import { useEffect, useState, useCallback } from 'react';
import { IconX, IconFileText, IconLoader2, IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { renderMarkdown } from '@/lib/render-markdown';

interface KbDocViewerProps {
  filePath: string;
  org: string;
  onClose: () => void;
}

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : p;
}

export function KbDocViewer({ filePath, org, onClose }: KbDocViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [ext, setExt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
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
  }, [filePath, org]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isMarkdown = ext === 'md' || ext === 'markdown' || ext === 'txt';

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

          {!loading && !error && content !== null && (
            <div className="p-5">
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
