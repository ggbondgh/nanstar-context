import {
  DAILY_EVENT_CONFIDENCE,
  DAILY_EVENT_TYPES,
  DAILY_LOG_STATES,
  PROCESSING_MODES,
  WORK_DRAFT_STATUSES,
  WORK_ENTITY_TYPES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  WORK_MILESTONE_STATUSES,
  WORK_MODULE_STATUSES,
  WORK_PROPOSAL_ACTIONS,
  WORK_PROPOSAL_STATUSES,
  WORK_PROJECT_STATUSES,
  cleanId,
  cleanString,
  ensureSet,
  estimateTokens,
  newId,
  now,
  parseArray,
  parseJson,
  summarize
} from "./_shared.js";

const ENTITY_CONFIG = {
  project: {
    table: "work_projects",
    idPrefix: "workproj",
    label: "项目",
    columns: [
      "id", "name", "customer_name", "description", "status", "stage", "goal", "current_summary",
      "next_action", "target_date", "processing_mode", "tags_json", "sort_order",
      "created_at", "updated_at", "archived_at"
    ],
    row: rowProject
  },
  module: {
    table: "work_modules",
    idPrefix: "workmod",
    label: "模块",
    columns: [
      "id", "project_id", "name", "description", "stage", "status", "current_summary",
      "next_action", "target_date", "sort_order", "created_at", "updated_at", "archived_at"
    ],
    row: rowModule
  },
  item: {
    table: "work_items",
    idPrefix: "workitem",
    label: "任务",
    columns: [
      "id", "project_id", "module_id", "item_type", "title", "description", "status", "priority",
      "external_reference", "owner", "current_result", "next_action", "due_date", "discovered_at",
      "resolved_at", "sort_order", "created_at", "updated_at", "archived_at"
    ],
    row: rowItem
  },
  milestone: {
    table: "work_milestones",
    idPrefix: "workmile",
    label: "里程碑",
    columns: [
      "id", "project_id", "title", "description", "target_date", "status", "acceptance_criteria",
      "current_result", "next_action", "created_at", "updated_at"
    ],
    row: rowMilestone
  },
  daily_log: {
    table: "daily_work_logs",
    idPrefix: "worklog",
    label: "日报",
    columns: [
      "id", "work_date", "raw_text", "cleaned_text", "selected_project_ids_json", "processing_mode",
      "requested_model_id", "state", "error_code", "error_message", "created_at", "updated_at"
    ],
    row: rowDailyLog
  }
};

export function rowProject(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseArray(row.tags_json),
    archived_at: row.archived_at || null
  };
}

export function rowModule(row) {
  if (!row) return null;
  return {
    ...row,
    archived_at: row.archived_at || null
  };
}

export function rowItem(row) {
  if (!row) return null;
  return {
    ...row,
    archived_at: row.archived_at || null
  };
}

export function rowMilestone(row) {
  if (!row) return null;
  return { ...row };
}

export function rowDailyLog(row) {
  if (!row) return null;
  return {
    ...row,
    selected_project_ids: parseArray(row.selected_project_ids_json),
    requested_model_id: row.requested_model_id || null
  };
}

export function rowDailyEvent(row) {
  if (!row) return null;
  return { ...row };
}

export function rowWorkProposal(row) {
  if (!row) return null;
  return {
    ...row,
    old_value: parseJson(row.old_value, row.old_value ?? ""),
    proposed_value: parseJson(row.proposed_value, row.proposed_value ?? "")
  };
}

export function rowWorkDraft(row) {
  if (!row) return null;
  return {
    ...row,
    project_scope: parseArray(row.project_scope_json)
  };
}

export function rowWorkVersion(row) {
  if (!row) return null;
  return {
    ...row,
    snapshot: parseJson(row.snapshot_json, {})
  };
}

export function entityConfig(entityType) {
  return ENTITY_CONFIG[cleanString(entityType, 20)] || null;
}

export function entityLabel(entityType) {
  return entityConfig(entityType)?.label || entityType || "";
}

export function parseWorkTargetIds(row = {}) {
  const projectId = cleanId(row.project_id) || null;
  const moduleId = cleanId(row.module_id) || null;
  const workItemId = cleanId(row.work_item_id) || null;
  return { projectId, moduleId, workItemId };
}

export function workEntityIds(row = {}) {
  return {
    project_id: cleanId(row.project_id) || null,
    module_id: cleanId(row.module_id) || null,
    work_item_id: cleanId(row.work_item_id) || null
  };
}

export function workStatusSets() {
  return {
    project: WORK_PROJECT_STATUSES,
    module: WORK_MODULE_STATUSES,
    item: WORK_ITEM_STATUSES,
    milestone: WORK_MILESTONE_STATUSES,
    log: DAILY_LOG_STATES,
    event: DAILY_EVENT_TYPES,
    confidence: DAILY_EVENT_CONFIDENCE,
    proposalAction: WORK_PROPOSAL_ACTIONS,
    proposalStatus: WORK_PROPOSAL_STATUSES,
    draftStatus: WORK_DRAFT_STATUSES,
    itemType: WORK_ITEM_TYPES,
    priority: WORK_ITEM_PRIORITIES,
    processingMode: PROCESSING_MODES,
    entityType: WORK_ENTITY_TYPES
  };
}

export async function mustExistWorkEntity(db, entityType, id) {
  const config = entityConfig(entityType);
  if (!config) return null;
  const clean = cleanId(id);
  if (!clean) return null;
  const row = await db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).bind(clean).first();
  return row ? config.row(row) : null;
}

export async function listWorkProjects(db) {
  const result = await db.prepare(`
    SELECT p.*,
           COUNT(DISTINCT m.id) AS module_count,
           COUNT(DISTINCT i.id) AS item_count,
           COUNT(DISTINCT CASE WHEN i.status NOT IN ('done', 'archived') AND i.archived_at IS NULL THEN i.id END) AS open_item_count,
           COUNT(DISTINCT CASE WHEN i.status = 'blocked' AND i.archived_at IS NULL THEN i.id END) AS blocked_item_count,
           COUNT(DISTINCT CASE WHEN ml.status IN ('planned', 'in_progress', 'at_risk') THEN ml.id END) AS milestone_count,
           MAX(COALESCE(i.updated_at, m.updated_at, ml.updated_at, p.updated_at)) AS recent_update_at
      FROM work_projects p
      LEFT JOIN work_modules m ON m.project_id = p.id AND m.archived_at IS NULL
      LEFT JOIN work_items i ON i.project_id = p.id AND i.archived_at IS NULL
      LEFT JOIN work_milestones ml ON ml.project_id = p.id
     WHERE p.archived_at IS NULL
     GROUP BY p.id
     ORDER BY p.sort_order, p.updated_at DESC
  `).all();
  return (result.results || []).map(rowProject);
}

export async function listWorkModules(db, projectId = "") {
  const cleanProjectId = cleanId(projectId);
  const params = [];
  const where = ["m.archived_at IS NULL"];
  if (cleanProjectId) {
    where.push("m.project_id = ?");
    params.push(cleanProjectId);
  }
  const result = await db.prepare(`
    SELECT m.*, p.name AS project_name, p.customer_name,
           COUNT(DISTINCT i.id) AS item_count,
           COUNT(DISTINCT CASE WHEN i.status NOT IN ('done', 'archived') AND i.archived_at IS NULL THEN i.id END) AS open_item_count,
           COUNT(DISTINCT CASE WHEN i.status = 'blocked' AND i.archived_at IS NULL THEN i.id END) AS blocked_item_count,
           MAX(COALESCE(i.updated_at, m.updated_at)) AS recent_item_update_at
      FROM work_modules m
      JOIN work_projects p ON p.id = m.project_id
      LEFT JOIN work_items i ON i.module_id = m.id AND i.archived_at IS NULL
     WHERE ${where.join(" AND ")}
     GROUP BY m.id
     ORDER BY p.sort_order, m.sort_order, m.updated_at DESC
  `).bind(...params).all();
  return (result.results || []).map(rowModule);
}

export async function listWorkItems(db, filters = {}) {
  const where = ["i.archived_at IS NULL"];
  const params = [];
  const projectId = cleanId(filters.project_id);
  const moduleId = cleanId(filters.module_id);
  const status = cleanString(filters.status, 40);
  const itemType = cleanString(filters.item_type, 40);
  const query = cleanString(filters.q, 160);
  if (projectId) { where.push("i.project_id = ?"); params.push(projectId); }
  if (moduleId) { where.push("i.module_id = ?"); params.push(moduleId); }
  if (status) { where.push("i.status = ?"); params.push(status); }
  if (itemType) { where.push("i.item_type = ?"); params.push(itemType); }
  if (query) {
    const like = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.current_result LIKE ? ESCAPE '\\' OR i.next_action LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const result = await db.prepare(`
    SELECT i.*, p.name AS project_name, p.customer_name, m.name AS module_name
      FROM work_items i
      JOIN work_projects p ON p.id = i.project_id
      LEFT JOIN work_modules m ON m.id = i.module_id
     WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN i.status IN ('blocked', 'waiting_customer', 'waiting_internal') THEN 0 ELSE 1 END,
              CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              COALESCE(i.due_date, '9999-12-31'),
              i.updated_at DESC
     LIMIT 300
  `).bind(...params).all();
  return (result.results || []).map(rowItem);
}

export async function listWorkMilestones(db, projectId = "") {
  const params = [];
  const where = [];
  const cleanProjectId = cleanId(projectId);
  if (cleanProjectId) {
    where.push("project_id = ?");
    params.push(cleanProjectId);
  }
  const result = await db.prepare(`
    SELECT *
      FROM work_milestones
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY COALESCE(target_date, '9999-12-31'), updated_at DESC
  `).bind(...params).all();
  return (result.results || []).map(rowMilestone);
}

export async function listDailyLogs(db, limit = 20, workDate = "") {
  const params = [];
  const where = ["l.state != 'archived'"];
  const cleanDate = cleanString(workDate, 20);
  if (cleanDate) {
    where.push("l.work_date = ?");
    params.push(cleanDate);
  }
  const result = await db.prepare(`
    SELECT l.*,
           COALESCE(d.status, '') AS draft_status,
           COALESCE(d.progress_text, '') AS progress_text,
           COALESCE(d.detail_text, '') AS detail_text,
           COALESCE(d.next_action_text, '') AS next_action_text,
           COALESCE(d.id, '') AS draft_id,
           COUNT(DISTINCT p.id) AS proposal_count,
           COUNT(DISTINCT e.id) AS event_count
      FROM daily_work_logs l
      LEFT JOIN daily_progress_drafts d ON d.daily_log_id = l.id AND d.status != 'archived'
      LEFT JOIN work_update_proposals p ON p.daily_log_id = l.id
      LEFT JOIN daily_work_events e ON e.daily_log_id = l.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     GROUP BY l.id
     ORDER BY l.work_date DESC, l.updated_at DESC
     LIMIT ${Math.max(1, Math.min(Number(limit) || 20, 200))}
  `).bind(...params).all();
  return (result.results || []).map(rowDailyLog);
}

export async function listWorkProposals(db, status = "") {
  const cleanStatus = cleanString(status, 40);
  const where = cleanStatus ? "WHERE p.status = ?" : "";
  const params = cleanStatus ? [cleanStatus] : [];
  const result = await db.prepare(`
    SELECT p.*,
           l.work_date,
           l.state AS log_state,
           prj.name AS project_name,
           mod.name AS module_name,
           itm.title AS item_title,
           ev.content AS source_event_content
      FROM work_update_proposals p
      JOIN daily_work_logs l ON l.id = p.daily_log_id
      LEFT JOIN work_projects prj ON prj.id = p.project_id
      LEFT JOIN work_modules mod ON mod.id = p.module_id
      LEFT JOIN work_items itm ON itm.id = p.work_item_id
      LEFT JOIN daily_work_events ev ON ev.id = p.source_event_id
      ${where}
     ORDER BY p.created_at DESC
     LIMIT 250
  `).bind(...params).all();
  return (result.results || []).map(rowWorkProposal);
}

export async function projectOverviewRows(db) {
  const projects = await listWorkProjects(db);
  return projects.map((project) => ({
    ...project,
    progress_rate: project.item_count ? Math.round(((project.item_count - project.open_item_count) / project.item_count) * 100) : 0
  }));
}

export async function moduleProgressRows(db) {
  const modules = await listWorkModules(db);
  return modules.map((module) => ({
    ...module,
    progress_rate: module.item_count ? Math.round(((module.item_count - module.open_item_count) / module.item_count) * 100) : 0
  }));
}

export async function openItemRows(db) {
  const items = await listWorkItems(db, {});
  return items.filter((item) => !["done", "archived"].includes(item.status));
}

export async function loadDailyProgressContext(db, dailyLog) {
  const selectedIds = parseArray(dailyLog?.selected_project_ids_json || dailyLog?.selected_project_ids || []);
  const cleanSelected = [...new Set(selectedIds.map((id) => cleanId(id)).filter(Boolean))].slice(0, 8);
  const selectedProjects = cleanSelected.length
    ? await db.prepare(`
        SELECT p.*
          FROM work_projects p
         WHERE p.id IN (${cleanSelected.map(() => "?").join(", ")})
           AND p.archived_at IS NULL
         ORDER BY p.sort_order, p.updated_at DESC
      `).bind(...cleanSelected).all()
    : await db.prepare(`
        SELECT p.*
          FROM work_projects p
         WHERE p.archived_at IS NULL
         ORDER BY p.sort_order, p.updated_at DESC
         LIMIT 3
      `).all();
  const projects = (selectedProjects.results || []).map(rowProject);
  const projectIds = projects.map((project) => project.id);
  const modules = projectIds.length
    ? (await db.prepare(`
        SELECT * FROM work_modules
         WHERE archived_at IS NULL AND project_id IN (${projectIds.map(() => "?").join(", ")})
         ORDER BY project_id, sort_order, updated_at DESC
      `).bind(...projectIds).all()).results || []
    : [];
  const items = projectIds.length
    ? (await db.prepare(`
        SELECT * FROM work_items
         WHERE archived_at IS NULL AND project_id IN (${projectIds.map(() => "?").join(", ")})
         ORDER BY CASE WHEN status IN ('blocked', 'waiting_customer', 'waiting_internal') THEN 0 ELSE 1 END,
                  CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                  updated_at DESC
         LIMIT 120
      `).bind(...projectIds).all()).results || []
    : [];
  const milestones = projectIds.length
    ? (await db.prepare(`
        SELECT * FROM work_milestones
         WHERE project_id IN (${projectIds.map(() => "?").join(", ")})
         ORDER BY COALESCE(target_date, '9999-12-31'), updated_at DESC
      `).bind(...projectIds).all()).results || []
    : [];
  const recentEvents = projectIds.length
    ? (await db.prepare(`
        SELECT e.*, l.work_date
          FROM daily_work_events e
          JOIN daily_work_logs l ON l.id = e.daily_log_id
         WHERE e.project_id IN (${projectIds.map(() => "?").join(", ")})
         ORDER BY e.occurred_at DESC
         LIMIT 24
      `).bind(...projectIds).all()).results || []
    : [];
  const recentLogs = projectIds.length
    ? (await db.prepare(`
        SELECT l.id, l.work_date, l.state, l.cleaned_text, l.updated_at
          FROM daily_work_logs l
         WHERE EXISTS (
           SELECT 1 FROM daily_work_events e
            WHERE e.daily_log_id = l.id AND e.project_id IN (${projectIds.map(() => "?").join(", ")})
         )
         ORDER BY l.work_date DESC, l.updated_at DESC
         LIMIT 8
      `).bind(...projectIds).all()).results || []
    : [];

  return {
    selected_projects: projects,
    modules: modules.map(rowModule),
    items: items.map(rowItem),
    milestones: milestones.map(rowMilestone),
    recent_events: recentEvents.map(rowDailyEvent),
    recent_logs: recentLogs.map(rowDailyLog)
  };
}

function escapeTsv(value) {
  return String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function workMarkdown(data = {}) {
  const lines = ["# NanStar Context 工作输出", ""];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const modules = Array.isArray(data.modules) ? data.modules : [];
  const items = Array.isArray(data.items) ? data.items : [];
  const milestones = Array.isArray(data.milestones) ? data.milestones : [];

  lines.push("## 项目总览", "");
  if (!projects.length) {
    lines.push("暂无项目。", "");
  } else {
    for (const project of projects) {
      lines.push(`- ${project.name} | ${project.customer_name || "未填写客户"} | ${project.status} | ${project.stage}`, `  - 摘要：${project.current_summary || "暂无"}`, `  - 下一步：${project.next_action || "暂无"}`);
    }
    lines.push("");
  }

  lines.push("## 模块进度", "");
  if (!modules.length) {
    lines.push("暂无模块。", "");
  } else {
    for (const module of modules) {
      lines.push(`- ${module.name} | ${module.status} | ${module.stage}`, `  - 项目：${module.project_name || module.project_id}`, `  - 下一步：${module.next_action || "暂无"}`);
    }
    lines.push("");
  }

  lines.push("## 任务与问题", "");
  if (!items.length) {
    lines.push("暂无任务。", "");
  } else {
    for (const item of items) {
      lines.push(`- ${item.title} | ${item.item_type} | ${item.status} | ${item.priority}`, `  - 项目：${item.project_name || item.project_id}`, `  - 模块：${item.module_name || "未分配"}`, `  - 下一步：${item.next_action || "暂无"}`);
    }
    lines.push("");
  }

  lines.push("## 里程碑", "");
  if (!milestones.length) {
    lines.push("暂无里程碑。", "");
  } else {
    for (const milestone of milestones) {
      lines.push(`- ${milestone.title} | ${milestone.status} | ${milestone.target_date || "未定"}`, `  - 验收：${milestone.acceptance_criteria || "暂无"}`, `  - 当前结果：${milestone.current_result || "暂无"}`, `  - 下一步：${milestone.next_action || "暂无"}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function workTxt(data = {}) {
  return workMarkdown(data)
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*-\s*/gm, "• ")
    .trim();
}

export function workTsvRows(data = {}) {
  const rows = [["类型", "名称", "状态", "阶段", "项目", "模块", "优先级", "下一步", "更新时间"]];
  for (const project of data.projects || []) {
    rows.push([
      "项目",
      escapeTsv(project.name),
      escapeTsv(project.status),
      escapeTsv(project.stage),
      escapeTsv(project.customer_name),
      "",
      "",
      escapeTsv(project.next_action),
      escapeTsv(project.updated_at)
    ]);
  }
  for (const module of data.modules || []) {
    rows.push([
      "模块",
      escapeTsv(module.name),
      escapeTsv(module.status),
      escapeTsv(module.stage),
      escapeTsv(module.project_name),
      "",
      "",
      escapeTsv(module.next_action),
      escapeTsv(module.updated_at)
    ]);
  }
  for (const item of data.items || []) {
    rows.push([
      "任务",
      escapeTsv(item.title),
      escapeTsv(item.status),
      escapeTsv(item.item_type),
      escapeTsv(item.project_name),
      escapeTsv(item.module_name),
      escapeTsv(item.priority),
      escapeTsv(item.next_action),
      escapeTsv(item.updated_at)
    ]);
  }
  return rows;
}

export function workTsv(data = {}) {
  return workTsvRows(data).map((row) => row.join("\t")).join("\n");
}

export function workJson(data = {}) {
  return {
    exported_at: new Date().toISOString(),
    projects: data.projects || [],
    modules: data.modules || [],
    items: data.items || [],
    milestones: data.milestones || [],
    daily_logs: data.daily_logs || [],
    events: data.events || [],
    proposals: data.proposals || [],
    drafts: data.drafts || [],
    versions: data.versions || []
  };
}

export async function nextWorkVersionNo(db, entityType, entityId) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
      FROM work_state_versions
     WHERE entity_type = ? AND entity_id = ?
  `).bind(entityType, entityId).first();
  return Number(row?.version_no || 1);
}

export async function saveWorkVersion(db, entityType, entityId, snapshot, changeReason = "", sourceEventId = null, proposalId = null) {
  const versionNo = await nextWorkVersionNo(db, entityType, entityId);
  return db.prepare(`
    INSERT INTO work_state_versions (
      id, entity_type, entity_id, version_no, snapshot_json, change_reason, source_event_id, proposal_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("workver"),
    entityType,
    entityId,
    versionNo,
    JSON.stringify(snapshot ?? {}),
    cleanString(changeReason, 500),
    sourceEventId || null,
    proposalId || null,
    now()
  );
}

export async function listWorkVersions(db, entityType, entityId) {
  const config = entityConfig(entityType);
  if (!config) return [];
  const result = await db.prepare(`
    SELECT *
      FROM work_state_versions
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY version_no DESC
  `).bind(entityType, cleanId(entityId)).all();
  return (result.results || []).map(rowWorkVersion);
}

export async function restoreWorkVersion(db, entityType, entityId, versionId) {
  const config = entityConfig(entityType);
  if (!config) return null;
  const current = await db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).bind(cleanId(entityId)).first();
  if (!current) return null;
  const version = await db.prepare(`
    SELECT *
      FROM work_state_versions
     WHERE id = ? AND entity_type = ? AND entity_id = ?
  `).bind(cleanId(versionId), entityType, cleanId(entityId)).first();
  if (!version) return null;
  const snapshot = parseJson(version.snapshot_json, {});
  const restore = {};
  for (const column of config.columns) {
    if (column === "id" || column === "created_at") continue;
    restore[column] = snapshot[column] ?? current[column] ?? null;
  }
  restore.updated_at = now();
  return { current, version: rowWorkVersion(version), restore };
}

export function workProjectScopeText(projects = [], modules = [], items = [], milestones = []) {
  const parts = [];
  for (const project of projects) {
    parts.push([
      `项目 ${project.name}`,
      `状态: ${project.status}`,
      `阶段: ${project.stage}`,
      `摘要: ${project.current_summary || "暂无"}`,
      `下一步: ${project.next_action || "暂无"}`
    ].join("\n"));
  }
  if (modules.length) {
    parts.push("模块上下文:\n" + modules.map((module) => `- ${module.name} (${module.status}) ${module.current_summary || module.next_action || ""}`).join("\n"));
  }
  if (items.length) {
    parts.push("任务上下文:\n" + items.slice(0, 20).map((item) => `- ${item.title} [${item.status}/${item.priority}] ${item.next_action || item.current_result || ""}`).join("\n"));
  }
  if (milestones.length) {
    parts.push("里程碑:\n" + milestones.map((milestone) => `- ${milestone.title} (${milestone.status}) ${milestone.next_action || ""}`).join("\n"));
  }
  return parts.join("\n\n");
}

export function buildDailyProgressPromptData(log, scope) {
  const projects = Array.isArray(scope?.selected_projects) ? scope.selected_projects : [];
  const modules = Array.isArray(scope?.modules) ? scope.modules : [];
  const items = Array.isArray(scope?.items) ? scope.items : [];
  const milestones = Array.isArray(scope?.milestones) ? scope.milestones : [];
  const recentEvents = Array.isArray(scope?.recent_events) ? scope.recent_events : [];
  const recentLogs = Array.isArray(scope?.recent_logs) ? scope.recent_logs : [];
  const projectScopeText = workProjectScopeText(projects, modules, items, milestones);
  const recentEventText = recentEvents.slice(0, 20).map((event) => {
    const pieces = [`event_id=${event.id}`];
    if (event.project_id) pieces.push(`project_id=${event.project_id}`);
    if (event.module_id) pieces.push(`module_id=${event.module_id}`);
    if (event.work_item_id) pieces.push(`work_item_id=${event.work_item_id}`);
    pieces.push(`type=${event.event_type}`);
    pieces.push(`content=${cleanString(event.content, 500)}`);
    return pieces.join(" | ");
  }).join("\n");
  const recentLogText = recentLogs.slice(0, 8).map((entry) => `- ${entry.work_date} / ${entry.state} / ${cleanString(entry.cleaned_text || "", 240)}`).join("\n");
  const selectedIds = projects.map((item) => item.id);

  const system = `你是 NanStar Context 的工作日报整理器。
只根据用户输入与已选择的项目上下文工作，不要编造不存在的项目、模块、任务、里程碑或结论。
你必须返回可解析的 JSON 对象，不要输出 Markdown 代码围栏，不要输出额外说明。`;
  const user = [
    `日报日期：${cleanString(log?.work_date || "", 20)}`,
    `选中的项目 ID：${selectedIds.join(", ") || "无"}`,
    `原始输入：${cleanString(log?.raw_text || "", 120000)}`,
    "",
    "项目上下文：",
    projectScopeText || "无",
    "",
    "最近少量事件：",
    recentEventText || "无",
    "",
    "最近少量日报：",
    recentLogText || "无",
    "",
    "返回 JSON 结构如下：",
    JSON.stringify({
      cleaned_text: "整理后的输入",
      progress_text: "可直接复制到日报的简洁内容",
      detail_text: "更详细的工作记录，可为空字符串",
      next_action_text: "下一步行动，可为空字符串",
      events: [
        {
          project_id: "现有项目 ID 或 null",
          module_id: "现有模块 ID 或 null",
          work_item_id: "现有任务 ID 或 null",
          event_type: "progress",
          content: "事件内容",
          occurred_at: 0,
          confidence: "high"
        }
      ],
      updates: [
        {
          project_id: "现有项目 ID 或 null",
          module_id: "现有模块 ID 或 null",
          work_item_id: "现有任务 ID 或 null",
          action: "update",
          field_name: "status",
          old_value: "",
          proposed_value: "",
          reason: "",
          source_event_index: 0
        }
      ],
      questions: [],
      warnings: []
    }, null, 2),
    "",
    "要求：",
    "- progress_text 必须能直接复制到日报。",
    "- updates 只能引用真实存在的项目/模块/任务 ID。",
    "- 如果无法确定具体 ID，就把对应字段留空，并把疑问放进 questions。",
    "- 不要把未确认的推测写成已完成事实。",
    "- 如果用户只给了原始口述，先整理，再给出最保守的更新建议。"
  ].join("\n");
  return { system, user, projects, modules, items, milestones, recentEvents, recentLogs };
}

export function buildManualDailyProgress(log, scope = {}) {
  const projects = Array.isArray(scope?.selected_projects) ? scope.selected_projects : [];
  const projectNames = projects.map((item) => item.name).join("、");
  const cleaned = cleanString(log?.raw_text || "", 120000);
  const progress = cleaned
    ? `今日进展：${cleaned.slice(0, 220)}${cleaned.length > 220 ? "..." : ""}${projectNames ? `\n\n关联项目：${projectNames}` : ""}`
    : "今日进展：暂无输入";
  const detail = projectNames ? `关联项目：${projectNames}` : "";
  const nextAction = projects.length ? `下一步：继续推进 ${projects[0].name}` : "下一步：补充项目选择";
  return {
    cleaned_text: cleaned,
    progress_text: progress,
    detail_text: detail,
    next_action_text: nextAction,
    events: [],
    updates: [],
    questions: [],
    warnings: [log?.processing_mode === "manual_only" ? "未调用外部 AI，内容由平台本地整理。" : "已使用平台本地规则整理。"]
  };
}

export async function normalizeDailyProgressResult(db, log, raw) {
  const cleanedText = cleanString(raw?.cleaned_text || log?.raw_text || "", 120000);
  const progressText = cleanString(raw?.progress_text || "", 20000);
  const detailText = cleanString(raw?.detail_text || "", 20000);
  const nextActionText = cleanString(raw?.next_action_text || "", 12000);
  const questions = Array.isArray(raw?.questions) ? raw.questions.map((item) => cleanString(item, 500)).filter(Boolean).slice(0, 20) : [];
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.map((item) => cleanString(item, 500)).filter(Boolean).slice(0, 20) : [];
  const scopeProjectIds = new Set(parseArray(log?.selected_project_ids_json || log?.selected_project_ids || []).map((item) => cleanId(item)).filter(Boolean));

  function normalizeIds(entry) {
    const projectId = cleanId(entry?.project_id) || null;
    const moduleId = cleanId(entry?.module_id) || null;
    const workItemId = cleanId(entry?.work_item_id) || null;
    return { projectId, moduleId, workItemId };
  }

  async function validateProject(id) {
    if (!id) return null;
    const row = await db.prepare("SELECT id FROM work_projects WHERE id = ? AND archived_at IS NULL").bind(id).first();
    return row?.id || null;
  }

  async function validateModule(id) {
    if (!id) return null;
    const row = await db.prepare("SELECT id FROM work_modules WHERE id = ? AND archived_at IS NULL").bind(id).first();
    return row?.id || null;
  }

  async function validateItem(id) {
    if (!id) return null;
    const row = await db.prepare("SELECT id FROM work_items WHERE id = ? AND archived_at IS NULL").bind(id).first();
    return row?.id || null;
  }

  const events = [];
  for (const [index, event] of (Array.isArray(raw?.events) ? raw.events : []).entries()) {
    const ids = normalizeIds(event);
    const confidence = ensureSet(event?.confidence, DAILY_EVENT_CONFIDENCE, "medium");
    const eventType = ensureSet(event?.event_type, DAILY_EVENT_TYPES, "progress");
    const content = cleanString(event?.content, 2000);
    if (!content) continue;
    const projectId = await validateProject(ids.projectId);
    const moduleId = await validateModule(ids.moduleId);
    const workItemId = await validateItem(ids.workItemId);
    if (!projectId && scopeProjectIds.size && ids.projectId && !scopeProjectIds.has(ids.projectId)) continue;
    events.push({
      project_id: projectId,
      module_id: moduleId,
      work_item_id: workItemId,
      event_type: eventType,
      content,
      occurred_at: Number(event?.occurred_at) || now(),
      confidence,
      source_index: index
    });
  }

  const updates = [];
  for (const [index, update] of (Array.isArray(raw?.updates) ? raw.updates : []).entries()) {
    const ids = normalizeIds(update);
    const projectId = await validateProject(ids.projectId);
    const moduleId = await validateModule(ids.moduleId);
    const workItemId = await validateItem(ids.workItemId);
    const action = ensureSet(update?.action, WORK_PROPOSAL_ACTIONS, "update");
    const fieldName = cleanString(update?.field_name, 80);
    const reason = cleanString(update?.reason, 500);
    const sourceEventIndex = Number.isInteger(Number(update?.source_event_index)) ? Number(update.source_event_index) : null;
    const proposedValue = update?.proposed_value === undefined ? "" : update.proposed_value;
    const oldValue = update?.old_value === undefined ? "" : update.old_value;
    const isCreate = action === "create";
    const safeFieldName = isCreate ? cleanString(fieldName || "entity_type", 80) : fieldName;
    if (!safeFieldName && !isCreate) continue;
    updates.push({
      project_id: projectId,
      module_id: moduleId,
      work_item_id: workItemId,
      action,
      field_name: safeFieldName,
      old_value: JSON.stringify(oldValue),
      proposed_value: JSON.stringify(proposedValue),
      reason,
      source_event_index: sourceEventIndex,
      source_event_id: events[sourceEventIndex]?.id || null,
      status: "pending",
      source_index: index
    });
  }

  return {
    cleaned_text: cleanedText,
    progress_text: progressText || cleanedText || "",
    detail_text: detailText,
    next_action_text: nextActionText,
    events,
    updates,
    questions,
    warnings
  };
}

export async function createDailyProgressScopeSummary(db, log) {
  const scope = await loadDailyProgressContext(db, log);
  return {
    project_scope_json: JSON.stringify((scope.selected_projects || []).map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      stage: project.stage,
      customer_name: project.customer_name,
      current_summary: project.current_summary,
      next_action: project.next_action
    }))),
    projects: scope.selected_projects || [],
    modules: scope.modules || [],
    items: scope.items || [],
    milestones: scope.milestones || [],
    recent_events: scope.recent_events || [],
    recent_logs: scope.recent_logs || []
  };
}

export function summarizeWorkSnapshot(row) {
  if (!row) return "";
  const pieces = [];
  if (row.name) pieces.push(row.name);
  if (row.title) pieces.push(row.title);
  if (row.status) pieces.push(row.status);
  if (row.stage) pieces.push(row.stage);
  return summarize(pieces.join(" · "), 180);
}

export function workLogSearchFilter(query) {
  const text = cleanString(query, 160).toLowerCase();
  if (!text) return null;
  const like = `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return like;
}

export { estimateTokens, newId, now, cleanString, cleanId };
