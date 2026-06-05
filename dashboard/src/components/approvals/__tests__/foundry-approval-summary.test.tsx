// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  FoundryApprovalSummary,
  formatPrice,
  readKind,
} from '../foundry-approval-summary';

afterEach(cleanup);

describe('readKind helper', () => {
  it('returns the kind string when present', () => {
    expect(readKind({ kind: 'domain:buy' })).toBe('domain:buy');
  });
  it('returns undefined when kind is missing', () => {
    expect(readKind({})).toBeUndefined();
  });
  it('returns undefined when kind is non-string', () => {
    expect(readKind({ kind: 42 })).toBeUndefined();
    expect(readKind({ kind: null })).toBeUndefined();
    expect(readKind({ kind: { nested: true } })).toBeUndefined();
  });
});

describe('formatPrice helper', () => {
  it('formats a number to 2dp with leading $', () => {
    expect(formatPrice(10)).toBe('$10.00');
    expect(formatPrice(10.5)).toBe('$10.50');
    expect(formatPrice(99.999)).toBe('$100.00'); // rounds up cleanly
  });
  it('passes through a string starting with $', () => {
    expect(formatPrice('$15.00')).toBe('$15.00');
  });
  it('prepends $ to a non-$-prefixed string', () => {
    expect(formatPrice('15.00')).toBe('$15.00');
    expect(formatPrice('USD 15')).toBe('$USD 15');
  });
  it('returns undefined for empty/missing/non-numeric-non-string values', () => {
    expect(formatPrice('')).toBeUndefined();
    expect(formatPrice(undefined)).toBeUndefined();
    expect(formatPrice(null)).toBeUndefined();
    expect(formatPrice({ price: 10 })).toBeUndefined();
  });
});

describe('FoundryApprovalSummary — null short-circuits', () => {
  it('renders nothing when metadata is undefined', () => {
    const { container } = render(<FoundryApprovalSummary metadata={undefined} variant="compact" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders nothing when metadata has no kind', () => {
    const { container } = render(<FoundryApprovalSummary metadata={{ foo: 'bar' }} variant="compact" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders nothing when kind is non-string', () => {
    const { container } = render(<FoundryApprovalSummary metadata={{ kind: 42 }} variant="detail" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FoundryApprovalSummary — domain:buy', () => {
  const meta = {
    kind: 'domain:buy',
    fqdn: 'acme-trading.ae',
    registrar: 'cloudflare',
    price_usd: 12.5,
    tenant_id: 'silvermere-tech',
    foundry_approval_id: 'app_abc123',
  };

  it('compact: shows globe emoji, fqdn, price, registrar', () => {
    const { container } = render(<FoundryApprovalSummary metadata={meta} variant="compact" />);
    expect(container.textContent).toBe('🌐 acme-trading.ae · $12.50 · cloudflare');
  });

  it('detail: shows Kind, Domain, Registrar, Price, Tenant, Foundry ID rows', () => {
    render(<FoundryApprovalSummary metadata={meta} variant="detail" />);
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.getByText('domain:buy')).toBeInTheDocument();
    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.getByText('acme-trading.ae')).toBeInTheDocument();
    expect(screen.getByText('Registrar')).toBeInTheDocument();
    expect(screen.getByText('cloudflare')).toBeInTheDocument();
    expect(screen.getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText('silvermere-tech')).toBeInTheDocument();
    expect(screen.getByText('Foundry ID')).toBeInTheDocument();
    expect(screen.getByText('app_abc123')).toBeInTheDocument();
  });

  it('detail: defaults registrar to cloudflare when absent', () => {
    render(<FoundryApprovalSummary metadata={{ kind: 'domain:buy', fqdn: 'x.com' }} variant="detail" />);
    expect(screen.getByText('cloudflare')).toBeInTheDocument();
  });

  it('detail: omits Price row when price_usd is missing', () => {
    render(<FoundryApprovalSummary metadata={{ kind: 'domain:buy', fqdn: 'x.com' }} variant="detail" />);
    expect(screen.queryByText('Price')).not.toBeInTheDocument();
  });

  it('detail: omits Foundry ID row when foundry_approval_id is missing', () => {
    render(<FoundryApprovalSummary metadata={{ kind: 'domain:buy', fqdn: 'x.com' }} variant="detail" />);
    expect(screen.queryByText('Foundry ID')).not.toBeInTheDocument();
  });
});

describe('FoundryApprovalSummary — zoho:setup-admin:downgrade', () => {
  const meta = {
    kind: 'zoho:setup-admin:downgrade',
    tenant_id: 'family',
    zoho_org: 'barker-hodges-family',
    from_role: 'super-admin',
    to_role: 'orchestrator',
    foundry_approval_id: 'app_xyz789',
  };

  it('compact: shows downgrade emoji, tenant, and role transition', () => {
    const { container } = render(<FoundryApprovalSummary metadata={meta} variant="compact" />);
    expect(container.textContent).toBe('🔻 family · zoho:super-admin → orchestrator');
  });

  it('detail: shows Kind, Tenant, Zoho org, Role transition, Foundry ID', () => {
    render(<FoundryApprovalSummary metadata={meta} variant="detail" />);
    expect(screen.getByText('zoho:setup-admin:downgrade')).toBeInTheDocument();
    expect(screen.getByText('family')).toBeInTheDocument();
    expect(screen.getByText('barker-hodges-family')).toBeInTheDocument();
    expect(screen.getByText('super-admin → orchestrator')).toBeInTheDocument();
    expect(screen.getByText('app_xyz789')).toBeInTheDocument();
  });

  it('detail: applies default from_role / to_role when absent', () => {
    render(<FoundryApprovalSummary metadata={{ kind: 'zoho:setup-admin:downgrade' }} variant="detail" />);
    expect(screen.getByText('super-admin → orchestrator')).toBeInTheDocument();
  });
});

describe('FoundryApprovalSummary — unknown kind', () => {
  it('compact: shows "Foundry · <kind>" so unknown kinds are never silent', () => {
    const { container } = render(<FoundryApprovalSummary metadata={{ kind: 'aws:iam:role:grant' }} variant="compact" />);
    expect(container.textContent).toBe('Foundry · aws:iam:role:grant');
  });

  it('detail: renders all primitive metadata fields as k/v rows', () => {
    render(
      <FoundryApprovalSummary
        metadata={{
          kind: 'aws:iam:role:grant',
          role_arn: 'arn:aws:iam::123456789012:role/lambda-executor',
          duration_hours: 1,
          read_only: true,
        }}
        variant="detail"
      />,
    );
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.getByText('aws:iam:role:grant')).toBeInTheDocument();
    expect(screen.getByText('role_arn')).toBeInTheDocument();
    expect(screen.getByText('arn:aws:iam::123456789012:role/lambda-executor')).toBeInTheDocument();
    expect(screen.getByText('duration_hours')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('read_only')).toBeInTheDocument();
    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('detail: filters out non-primitive metadata fields (objects, arrays)', () => {
    render(
      <FoundryApprovalSummary
        metadata={{
          kind: 'aws:iam:role:grant',
          role_arn: 'arn:aws:iam::123456789012:role/x',
          tags: ['urgent'],
          policy: { allow: ['s3:Get'] },
        }}
        variant="detail"
      />,
    );
    expect(screen.getByText('role_arn')).toBeInTheDocument();
    // Arrays + nested objects must NOT render as String([object Object])
    expect(screen.queryByText('tags')).not.toBeInTheDocument();
    expect(screen.queryByText('policy')).not.toBeInTheDocument();
  });
});
