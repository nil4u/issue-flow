-- 暂时移除 repo overview 的 Task Execution Trend 面板.
DELETE FROM "dashboard_panels"
WHERE "id" = 'dashpanel_task_execution_trend';
