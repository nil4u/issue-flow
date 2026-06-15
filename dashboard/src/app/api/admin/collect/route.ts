import { NextResponse } from 'next/server';
import { collectGitLabProject } from '@/lib/collect.ts';
import { openDashboardDb } from '@/lib/db.ts';
import { GitLabClient } from '@/lib/gitlab.ts';
import { readConfiguredProjects, recordProjectCollectionError } from '@/lib/projects.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const db = openDashboardDb();
  const results: Array<{ project_id: string; status: 'success' | 'error'; issue_count?: number; error?: string }> = [];
  try {
    const projects = readConfiguredProjects(db);
    for (const project of projects) {
      try {
        const result = await collectGitLabProject(db, {
          projectId: project.id,
          projectName: project.name,
          projectPath: project.pathWithNamespace,
          client: new GitLabClient({
            baseUrl: project.baseUrl,
            token: project.token!,
            projectId: project.id,
            projectPath: project.pathWithNamespace
          })
        });
        results.push({ project_id: project.id, status: 'success', issue_count: result.issueCount });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordProjectCollectionError(db, project.id, message);
        results.push({ project_id: project.id, status: 'error', error: message });
      }
    }
    return NextResponse.json({
      status: results.some((result) => result.status === 'error') ? 'partial_error' : 'success',
      results
    });
  } finally {
    db.close();
  }
}
