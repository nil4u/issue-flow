-- 扩展 repo overview 时间范围选项到 52 周.
UPDATE "dashboard_variables"
SET "default_value" = '{"value": 8, "options": [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52]}'
WHERE "id" = 'dashvar_overview_weeks';
