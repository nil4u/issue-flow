-- 在概览图中将文档工作保留为独立 issue 类型。
UPDATE "dashboard_panels"
SET "visual_config" = jsonb_set(
      "visual_config",
      '{stackOrder}',
      '["type::feature", "type::bug", "type::debt", "type::ops", "type::docs", "type::optimization", "未分类"]'::jsonb,
      true
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_type_distribution';
