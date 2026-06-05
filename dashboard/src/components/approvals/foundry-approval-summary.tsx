'use client';

// Foundry approval kind-discriminated summary block. Renders a compact one-liner
// for cards or a fuller key/value grid for detail dialogs, when an approval
// carries Foundry-shaped metadata. Returns null for non-Foundry approvals so
// callers can render it unconditionally.

interface FoundryApprovalSummaryProps {
  metadata: Record<string, unknown> | undefined;
  variant: 'compact' | 'detail';
}

interface DomainBuyMeta {
  kind: 'domain:buy';
  fqdn?: string;
  registrar?: string;
  price_usd?: number | string;
  tenant_id?: string;
  foundry_approval_id?: string;
}

interface ZohoDowngradeMeta {
  kind: 'zoho:setup-admin:downgrade';
  tenant_id?: string;
  zoho_org?: string;
  from_role?: string;
  to_role?: string;
  foundry_approval_id?: string;
}

function readKind(meta: Record<string, unknown>): string | undefined {
  const k = meta.kind;
  return typeof k === 'string' ? k : undefined;
}

function formatPrice(value: unknown): string | undefined {
  if (typeof value === 'number') return `$${value.toFixed(2)}`;
  if (typeof value === 'string' && value.length > 0) return value.startsWith('$') ? value : `$${value}`;
  return undefined;
}

export function FoundryApprovalSummary({ metadata, variant }: FoundryApprovalSummaryProps) {
  if (!metadata) return null;
  const kind = readKind(metadata);
  if (!kind) return null;

  if (kind === 'domain:buy') {
    const m = metadata as unknown as DomainBuyMeta;
    const fqdn = m.fqdn ?? '—';
    const registrar = m.registrar ?? 'cloudflare';
    const price = formatPrice(m.price_usd);
    if (variant === 'compact') {
      return (
        <p className="text-xs font-mono text-foreground/80">
          🌐 {fqdn}{price ? ` · ${price}` : ''} · {registrar}
        </p>
      );
    }
    return (
      <div className="grid grid-cols-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">Kind</span>
        <span className="font-mono">domain:buy</span>
        <span className="text-muted-foreground">Domain</span>
        <span className="font-mono">{fqdn}</span>
        <span className="text-muted-foreground">Registrar</span>
        <span>{registrar}</span>
        {price && (
          <>
            <span className="text-muted-foreground">Price</span>
            <span>{price}</span>
          </>
        )}
        {m.tenant_id && (
          <>
            <span className="text-muted-foreground">Tenant</span>
            <span className="font-mono">{m.tenant_id}</span>
          </>
        )}
        {m.foundry_approval_id && (
          <>
            <span className="text-muted-foreground">Foundry ID</span>
            <span className="font-mono text-xs">{m.foundry_approval_id}</span>
          </>
        )}
      </div>
    );
  }

  if (kind === 'zoho:setup-admin:downgrade') {
    const m = metadata as unknown as ZohoDowngradeMeta;
    const tenant = m.tenant_id ?? '—';
    const zohoOrg = m.zoho_org ?? '—';
    const fromRole = m.from_role ?? 'super-admin';
    const toRole = m.to_role ?? 'orchestrator';
    if (variant === 'compact') {
      return (
        <p className="text-xs font-mono text-foreground/80">
          🔻 {tenant} · zoho:{fromRole} → {toRole}
        </p>
      );
    }
    return (
      <div className="grid grid-cols-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">Kind</span>
        <span className="font-mono">zoho:setup-admin:downgrade</span>
        <span className="text-muted-foreground">Tenant</span>
        <span className="font-mono">{tenant}</span>
        <span className="text-muted-foreground">Zoho org</span>
        <span className="font-mono">{zohoOrg}</span>
        <span className="text-muted-foreground">Role transition</span>
        <span>
          {fromRole} → {toRole}
        </span>
        {m.foundry_approval_id && (
          <>
            <span className="text-muted-foreground">Foundry ID</span>
            <span className="font-mono text-xs">{m.foundry_approval_id}</span>
          </>
        )}
      </div>
    );
  }

  // Unknown Foundry kind — surface kind + all primitive metadata fields so
  // operators are never blind to a new kind that ships before the UI catches up.
  if (variant === 'compact') {
    return (
      <p className="text-xs font-mono text-foreground/60">
        Foundry · {kind}
      </p>
    );
  }
  const rows: Array<[string, string]> = [['Kind', kind]];
  for (const [k, v] of Object.entries(metadata)) {
    if (k === 'kind') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      rows.push([k, String(v)]);
    }
  }
  return (
    <div className="grid grid-cols-2 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-mono">{v}</span>
        </div>
      ))}
    </div>
  );
}
