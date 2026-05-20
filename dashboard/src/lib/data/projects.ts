import fs from 'fs';
import path from 'path';
import { getFrameworkRoot, getOrgs } from '@/lib/config';

export interface ActiveProject {
  project: string;
  org: string;
  currentPhase: string;
  currentStage: string;
  absolutePath: string;
}

function parseFrontMatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function getActiveProjects(org?: string): ActiveProject[] {
  const frameworkRoot = getFrameworkRoot();
  const orgsToSearch = org ? [org] : getOrgs();
  const projects: ActiveProject[] = [];

  for (const orgName of orgsToSearch) {
    const projectsDir = path.join(frameworkRoot, 'orgs', orgName, 'projects');
    if (!fs.existsSync(projectsDir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(projectsDir, entry.name, 'docs', 'project-state.md');
      if (!fs.existsSync(stateFile)) continue;
      try {
        const content = fs.readFileSync(stateFile, 'utf-8');
        const fm = parseFrontMatter(content);
        if (!fm || fm.status !== 'ACTIVE') continue;
        projects.push({
          project: fm.project || entry.name,
          org: orgName,
          currentPhase: fm.current_phase || '',
          currentStage: fm.current_stage || '',
          absolutePath: stateFile,
        });
      } catch {
        continue;
      }
    }
  }
  return projects;
}
