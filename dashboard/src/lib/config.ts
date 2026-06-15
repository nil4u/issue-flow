import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppConfig = {
  gitlab: {
    baseUrl: string;
  };
  collection: {
    lookbackDays: number;
    keepRawRuns: number;
  };
};

export type DashboardProjectConfig = {
  id: string;
  name: string;
  provider: 'gitlab';
  baseUrl: string;
  pathWithNamespace: string;
  token?: string;
};

let appConfigCache: AppConfig | null = null;

function readNestedYamlValue(raw: string, section: string, key: string) {
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sectionMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (sectionMatch) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (!inSection) continue;
    const keyMatch = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`).exec(line);
    if (keyMatch) {
      return keyMatch[1].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return null;
}

function numberOrDefault(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadAppConfig(): AppConfig {
  if (appConfigCache) return appConfigCache;
  const raw = readAppConfigText();
  const baseUrl = readNestedYamlValue(raw, 'gitlab', 'base_url')?.replace(/\/+$/, '') || 'https://git.lianjia.com';
  appConfigCache = {
    gitlab: { baseUrl },
    collection: {
      lookbackDays: numberOrDefault(readNestedYamlValue(raw, 'collection', 'lookback_days'), 120),
      keepRawRuns: numberOrDefault(readNestedYamlValue(raw, 'collection', 'keep_raw_runs'), 3)
    }
  };
  return appConfigCache;
}

export function resetAppConfigCache() {
  appConfigCache = null;
}

export function readProjectsFromEnv(): DashboardProjectConfig[] {
  const raw = process.env.DASHBOARD_PROJECTS_JSON;
  if (!raw) {
    return [];
  }
  const appConfig = loadAppConfig();
  const parsed = JSON.parse(raw) as Array<Omit<DashboardProjectConfig, 'id' | 'baseUrl'> & {
    id: string | number;
    baseUrl?: string;
  }>;
  return parsed.map((project) => ({
    ...project,
    id: String(project.id),
    baseUrl: (project.baseUrl || appConfig.gitlab.baseUrl).replace(/\/+$/, '')
  }));
}

export function readAppConfigText() {
  const configPath = join(process.cwd(), 'config', 'app.yml');
  return existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
}
