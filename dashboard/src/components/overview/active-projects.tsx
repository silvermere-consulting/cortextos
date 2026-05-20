import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconFolderOpen } from '@tabler/icons-react';
import type { ActiveProject } from '@/lib/data/projects';

interface ActiveProjectsProps {
  projects: ActiveProject[];
}

export function ActiveProjects({ projects }: ActiveProjectsProps) {
  if (projects.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Active Projects
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No active projects.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Active Projects
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {projects.map((p) => {
          const href = `/knowledge-base?org=${encodeURIComponent(p.org)}&doc=${encodeURIComponent(p.absolutePath)}`;
          return (
            <Link
              key={p.absolutePath}
              href={href}
              className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2.5 hover:bg-muted/40 transition-colors group"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <IconFolderOpen size={14} className="text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.project}</p>
                  <p className="text-[11px] text-muted-foreground">{p.org}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                {p.currentPhase && (
                  <Badge variant="secondary" className="text-[10px]">{p.currentPhase}</Badge>
                )}
                {p.currentStage && p.currentStage !== 'N/A' && (
                  <Badge variant="outline" className="text-[10px]">{p.currentStage}</Badge>
                )}
                <span className="text-[10px] text-primary/70 group-hover:text-primary transition-colors">→</span>
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
