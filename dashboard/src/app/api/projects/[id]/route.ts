import { NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';
import { deleteProjectConfig, listProjectConfigs, setProjectActive, upsertProjectConfig } from '@/lib/projects.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  const db = openDashboardDb();
  try {
    if ('active' in body && Object.keys(body).length === 1) {
      setProjectActive(db, id, Boolean(body.active));
    } else {
      upsertProjectConfig(db, {
        id,
        name: body.name,
        pathWithNamespace: body.pathWithNamespace ?? body.path_with_namespace,
        token: body.token,
        active: body.active
      });
    }
    return NextResponse.json({ ok: true, projects: listProjectConfigs(db) });
  } finally {
    db.close();
  }
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const db = openDashboardDb();
  try {
    deleteProjectConfig(db, id);
    return NextResponse.json({ ok: true, projects: listProjectConfigs(db) });
  } finally {
    db.close();
  }
}
