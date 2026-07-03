-- Trim the default dashboard: keep Started Issue Distribution only.
-- The wip_aging_metrics / issue_flow_metrics views stay available for ad-hoc panels.
DELETE FROM "dashboard_panels" WHERE "id" IN ('dashpanel_wip_aging', 'dashpanel_flow_wait_ranking');

-- Field labels drive the per-bar tooltip header in the renderer.
UPDATE "dashboard_panels"
SET "visual_config" = '{"stackOrder": ["1d", "2d", "3d", "4d", "5d", "6d", "7d", "7d+", "open"], "y2Unit": "days", "fieldLabels": {"issue_count": "数量", "weighted_count": "加权"}}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
