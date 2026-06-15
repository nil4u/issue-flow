import { NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';
import { listProjectConfigs, upsertProjectConfig } from '@/lib/projects.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const db = openDashboardDb();
  try {
    return NextResponse.json({ projects: listProjectConfigs(db) });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const db = openDashboardDb();
  try {
    upsertProjectConfig(db, {
      id: body.id,
      name: body.name,
      pathWithNamespace: body.pathWithNamespace ?? body.path_with_namespace,
      token: body.token,
      active: body.active
    });
    return NextResponse.json({ ok: true, projects: listProjectConfigs(db) });
  } finally {
    db.close();
  }
}
