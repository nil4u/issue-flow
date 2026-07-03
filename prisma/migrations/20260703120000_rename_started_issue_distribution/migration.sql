UPDATE "dashboard_panels"
SET "title" = 'Issue 完成时间分布',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
