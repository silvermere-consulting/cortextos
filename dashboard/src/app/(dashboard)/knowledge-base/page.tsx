import { getOrgs, getFrameworkRoot, getAgentsForOrg } from '@/lib/config';
import { KnowledgeBaseClient } from '@/components/knowledge-base/kb-client';
import fs from 'fs';
import path from 'path';

function getKnowledgeContent(org: string): string {
  const frameworkRoot = getFrameworkRoot();
  const kbPath = path.join(frameworkRoot, 'orgs', org, 'knowledge.md');
  try {
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch {
    // graceful fallback
  }
  return '';
}

export const dynamic = 'force-dynamic';

export default function KnowledgeBasePage({
  searchParams,
}: {
  searchParams: { org?: string; doc?: string };
}) {
  const orgs = getOrgs();

  // Use org from URL param (set by topbar org selector) if valid.
  // Fall back to the first org that has active agents, then to orgs[0].
  // Skip 'all' — KB viewer always needs a specific org.
  let org = (searchParams.org && searchParams.org !== 'all' && orgs.includes(searchParams.org))
    ? searchParams.org
    : orgs.find(o => getAgentsForOrg(o).length > 0) ?? orgs[0] ?? '';

  const agentCount = org ? getAgentsForOrg(org).length : 0;
  const content = org ? getKnowledgeContent(org) : '';
  const kbPath = org
    ? path.join(getFrameworkRoot(), 'orgs', org, 'knowledge.md')
    : '';

  // ?doc=<url-encoded-path> opens the doc viewer immediately on load.
  const initialDoc = searchParams.doc || '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge Base</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Search, browse, and manage your organization's shared knowledge. Powered by multimodal RAG.
        </p>
      </div>

      <KnowledgeBaseClient
        org={org}
        markdownContent={content}
        filePath={kbPath}
        agentCount={agentCount}
        initialDoc={initialDoc}
      />
    </div>
  );
}
