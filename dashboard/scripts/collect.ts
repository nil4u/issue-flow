import { openDashboardDb } from '../src/lib/db.ts';
import { collectGitLabProject } from '../src/lib/collect.ts';
import { GitLabClient } from '../src/lib/gitlab.ts';
import { readProjectsFromEnv } from '../src/lib/config.ts';
import { readConfiguredProjects, recordProjectCollectionError } from '../src/lib/projects.ts';

const db = openDashboardDb();
try {
  const envProjects = readProjectsFromEnv();
  const projects = envProjects.length > 0 ? envProjects : readConfiguredProjects(db);
  if (projects.length === 0) {
    console.log('No projects configured. Add projects in /settings or set DASHBOARD_PROJECTS_JSON.');
    process.exit(0);
  }

  for (const project of projects) {
    if (!project.token) {
      throw new Error(`Missing token for project ${project.id}`);
    }
    try {
      const result = await collectGitLabProject(db, {
        projectId: project.id,
        projectName: project.name,
        projectPath: project.pathWithNamespace,
        client: new GitLabClient({
          baseUrl: project.baseUrl,
          token: project.token,
          projectId: project.id,
          projectPath: project.pathWithNamespace
        })
      });
      console.log(`collected ${result.issueCount} issues for ${project.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordProjectCollectionError(db, project.id, message);
      throw err;
    }
  }
} finally {
  db.close();
}
