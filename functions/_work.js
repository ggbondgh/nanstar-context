import {
  cleanId,
  cleanOptionalString,
  cleanString,
  ensureSet,
  intInRange,
  json,
  methodNotAllowed,
  newId,
  noContent,
  normalizeTags,
  now,
  parseArray,
  parseJson,
  readJson,
  toBoolInt
} from "./_shared.js";
import {
  DAILY_LOG_STATES,
  PROCESSING_MODES,
  WORK_DRAFT_STATUSES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  WORK_MILESTONE_STATUSES,
  WORK_MODULE_STATUSES,
  WORK_PROPOSAL_ACTIONS,
  WORK_PROPOSAL_STATUSES,
  WORK_PROJECT_STATUSES
} from "./_shared.js";
import {
  createDailyProgressScopeSummary,
  entityConfig,
  listDailyLogs,
  listWorkItems,
  listWorkMilestones,
  listWorkModules,
  listWorkProposals,
  listWorkProjects,
  listWorkVersions,
  loadDailyProgressContext,
  moduleProgressRows,
  normalizeDailyProgressResult,
  openItemRows,
  projectOverviewRows,
  restoreWorkVersion,
  rowDailyEvent,
  rowDailyLog,
  rowItem,
  rowMilestone,
  rowModule,
  rowProject,
  rowWorkDraft,
  rowWorkProposal,
  rowWorkVersion,
  saveWorkVersion,
  workJson,
  workMarkdown,
  workTsv,
  workTxt
} from "./_work_shared.js";
import { generateDailyProgress } from "./_ai.js";
import {
  listProjectPeople,
  listWorkItemPeople,
  projectPeopleApi,
  workItemPeopleApi
} from "./_people.js";
import {
  audioApi,
  meetingTopicsApi,
  meetingsApi,
  speakerApi,
  transcriptSegmentsApi
} from "./_audio.js";

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function todayDateString(timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function fail(message, status = 400, code = "WORK_REQUEST_FAILED") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function required(value, label, maxLength = 10000) {
  const output = cleanString(value, maxLength);
  if (!output) fail(`${label} 不能为空`, 400, "FIELD_REQUIRED");
  return output;
}

function likeValue(value) {
  return `%${cleanString(value, 160).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function safeDate(value) {
  const output = cleanString(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(output) ? output : "";
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function workTable(entityType) {
  return entityConfig(entityType)?.table || "";
}

function rawEntityRow(row) {
  return row ? { ...row } : null;
}

async function rawEntity(db, entityType, id) {
  const table = workTable(entityType);
  const clean = cleanId(id);
  if (!table || !clean) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(clean).first();
}

function normalizeProjectPayload(body, current = null) {
  const tagsSource = body.tags_json !== undefined ? body.tags_json : body.tags !== undefined ? body.tags : current?.tags_json || [];
  return {
    name: body.name === undefined ? current?.name || "" : required(body.name, "项目名称", 120),
    customer_name: body.customer_name === undefined ? current?.customer_name || "" : cleanOptionalString(body.customer_name, 120) || "",
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 1000) || "",
    status: body.status === undefined ? current?.status || "active" : ensureSet(body.status, WORK_PROJECT_STATUSES, current?.status || "active"),
    stage: body.stage === undefined ? current?.stage || "planning" : cleanOptionalString(body.stage, 60) || "planning",
    goal: body.goal === undefined ? current?.goal || "" : cleanOptionalString(body.goal, 1000) || "",
    current_summary: body.current_summary === undefined ? current?.current_summary || "" : cleanOptionalString(body.current_summary, 1000) || "",
    next_action: body.next_action === undefined ? current?.next_action || "" : cleanOptionalString(body.next_action, 1000) || "",
    target_date: body.target_date === undefined ? current?.target_date || null : safeDate(body.target_date) || null,
    processing_mode: body.processing_mode === undefined ? current?.processing_mode || "platform_rules" : ensureSet(body.processing_mode, PROCESSING_MODES, current?.processing_mode || "platform_rules"),
    tags_json: JSON.stringify(normalizeTags(tagsSource)),
    sort_order: intInRange(body.sort_order, current?.sort_order ?? 100, 0, 100000),
    archived_at: body.archived_at === undefined ? current?.archived_at || null : safeDate(body.archived_at) ? Number(new Date(body.archived_at)) : null
  };
}

function normalizeModulePayload(body, current = null) {
  return {
    project_id: body.project_id === undefined ? current?.project_id || "" : cleanId(body.project_id) || "",
    name: body.name === undefined ? current?.name || "" : required(body.name, "模块名称", 120),
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 1000) || "",
    stage: body.stage === undefined ? current?.stage || "planning" : cleanOptionalString(body.stage, 60) || "planning",
    status: body.status === undefined ? current?.status || "not_started" : ensureSet(body.status, WORK_MODULE_STATUSES, current?.status || "not_started"),
    current_summary: body.current_summary === undefined ? current?.current_summary || "" : cleanOptionalString(body.current_summary, 1000) || "",
    next_action: body.next_action === undefined ? current?.next_action || "" : cleanOptionalString(body.next_action, 1000) || "",
    target_date: body.target_date === undefined ? current?.target_date || null : safeDate(body.target_date) || null,
    sort_order: intInRange(body.sort_order, current?.sort_order ?? 100, 0, 100000),
    archived_at: body.archived_at === undefined ? current?.archived_at || null : safeDate(body.archived_at) ? Number(new Date(body.archived_at)) : null
  };
}

function normalizeItemPayload(body, current = null) {
  return {
    project_id: body.project_id === undefined ? current?.project_id || "" : cleanId(body.project_id) || "",
    module_id: body.module_id === undefined ? current?.module_id || null : cleanId(body.module_id) || null,
    item_type: body.item_type === undefined ? current?.item_type || "task" : ensureSet(body.item_type, WORK_ITEM_TYPES, current?.item_type || "task"),
    title: body.title === undefined ? current?.title || "" : required(body.title, "任务标题", 160),
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 2000) || "",
    status: body.status === undefined ? current?.status || "not_started" : ensureSet(body.status, WORK_ITEM_STATUSES, current?.status || "not_started"),
    priority: body.priority === undefined ? current?.priority || "normal" : ensureSet(body.priority, WORK_ITEM_PRIORITIES, current?.priority || "normal"),
    external_reference: body.external_reference === undefined ? current?.external_reference || "" : cleanOptionalString(body.external_reference, 120) || "",
    owner: body.owner === undefined ? current?.owner || "" : cleanOptionalString(body.owner, 80) || "",
    current_result: body.current_result === undefined ? current?.current_result || "" : cleanOptionalString(body.current_result, 1000) || "",
    next_action: body.next_action === undefined ? current?.next_action || "" : cleanOptionalString(body.next_action, 1000) || "",
    due_date: body.due_date === undefined ? current?.due_date || null : safeDate(body.due_date) || null,
    discovered_at: body.discovered_at === undefined ? current?.discovered_at || null : safeDate(body.discovered_at) || null,
    resolved_at: body.resolved_at === undefined ? current?.resolved_at || null : safeDate(body.resolved_at) || null,
    sort_order: intInRange(body.sort_order, current?.sort_order ?? 100, 0, 100000),
    archived_at: body.archived_at === undefined ? current?.archived_at || null : safeDate(body.archived_at) ? Number(new Date(body.archived_at)) : null
  };
}

function normalizeMilestonePayload(body, current = null) {
  return {
    project_id: body.project_id === undefined ? current?.project_id || "" : cleanId(body.project_id) || "",
    title: body.title === undefined ? current?.title || "" : required(body.title, "里程碑标题", 160),
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 2000) || "",
    target_date: body.target_date === undefined ? current?.target_date || null : safeDate(body.target_date) || null,
    status: body.status === undefined ? current?.status || "planned" : ensureSet(body.status, WORK_MILESTONE_STATUSES, current?.status || "planned"),
    acceptance_criteria: body.acceptance_criteria === undefined ? current?.acceptance_criteria || "" : cleanOptionalString(body.acceptance_criteria, 2000) || "",
    current_result: body.current_result === undefined ? current?.current_result || "" : cleanOptionalString(body.current_result, 1000) || "",
    next_action: body.next_action === undefined ? current?.next_action || "" : cleanOptionalString(body.next_action, 1000) || ""
  };
}

function normalizeLogPayload(body, current = null) {
  const selected = [...new Set(parseArray(body.selected_project_ids_json ?? body.selected_project_ids).map((entry) => cleanId(entry)).filter(Boolean))];
  return {
    work_date: body.work_date === undefined ? current?.work_date || "" : safeDate(body.work_date) || "",
    raw_text: body.raw_text === undefined ? current?.raw_text || "" : required(body.raw_text, "日报原文", 120000),
    cleaned_text: body.cleaned_text === undefined ? current?.cleaned_text || "" : cleanOptionalString(body.cleaned_text, 120000) || "",
    selected_project_ids_json: JSON.stringify(selected),
    processing_mode: body.processing_mode === undefined ? current?.processing_mode || "external_ai" : ensureSet(body.processing_mode, PROCESSING_MODES, current?.processing_mode || "external_ai"),
    requested_model_id: body.requested_model_id === undefined ? current?.requested_model_id || null : cleanId(body.requested_model_id) || null,
    state: body.state === undefined ? current?.state || "draft" : ensureSet(body.state, DAILY_LOG_STATES, current?.state || "draft"),
    error_code: body.error_code === undefined ? current?.error_code || "" : cleanOptionalString(body.error_code, 80) || "",
    error_message: body.error_message === undefined ? current?.error_message || "" : cleanOptionalString(body.error_message, 500) || ""
  };
}

function stringifyValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

async function insertEntity(db, entityType, payload) {
  const config = entityConfig(entityType);
  if (!config) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
  const id = newId(config.idPrefix);
  const timestamp = now();
  const data = { id, ...payload, created_at: timestamp, updated_at: timestamp };
  const columns = Object.keys(data);
  const statement = db.prepare(`INSERT INTO ${config.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => data[column]));
  await statement.run();
  const created = await rawEntity(db, entityType, id);
  return { id, created };
}

async function updateEntity(db, entityType, id, payload) {
  const config = entityConfig(entityType);
  if (!config) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
  const clean = cleanId(id);
  if (!clean) fail("资源不存在", 404, "NOT_FOUND");
  const current = await rawEntity(db, entityType, clean);
  if (!current) fail("资源不存在", 404, "NOT_FOUND");
  const columns = Object.keys(payload);
  await db.prepare(`UPDATE ${config.table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .bind(...columns.map((column) => payload[column]), clean).run();
  return { current, next: await rawEntity(db, entityType, clean) };
}

async function archiveEntity(db, entityType, id, extra = {}) {
  const config = entityConfig(entityType);
  if (!config) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
  const clean = cleanId(id);
  const current = await rawEntity(db, entityType, clean);
  if (!current) fail("资源不存在", 404, "NOT_FOUND");
  const payload = { ...extra, updated_at: now() };
  await db.prepare(`UPDATE ${config.table} SET ${Object.keys(payload).map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .bind(...Object.values(payload), clean).run();
  return { current, next: await rawEntity(db, entityType, clean) };
}

async function projectDetail(db, id) {
  const project = await rawEntity(db, "project", id);
  if (!project) fail("项目不存在", 404, "NOT_FOUND");
  const [modules, items, milestones, versions, projectPeople] = await Promise.all([
    db.prepare("SELECT * FROM work_modules WHERE project_id = ? ORDER BY sort_order, updated_at DESC").bind(project.id).all(),
    db.prepare("SELECT * FROM work_items WHERE project_id = ? AND archived_at IS NULL ORDER BY CASE WHEN status IN ('blocked', 'waiting_customer', 'waiting_internal') THEN 0 ELSE 1 END, updated_at DESC").bind(project.id).all(),
    db.prepare("SELECT * FROM work_milestones WHERE project_id = ? ORDER BY COALESCE(target_date, '9999-12-31'), updated_at DESC").bind(project.id).all(),
    db.prepare("SELECT * FROM work_state_versions WHERE entity_type = 'project' AND entity_id = ? ORDER BY version_no DESC").bind(project.id).all(),
    listProjectPeople(db, project.id)
  ]);
  return {
    ...rowProject(project),
    modules: (modules.results || []).map(rowModule),
    items: (items.results || []).map(rowItem),
    milestones: (milestones.results || []).map(rowMilestone),
    versions: (versions.results || []).map(rowWorkVersion),
    project_people: projectPeople
  };
}

async function moduleDetail(db, id) {
  const module = await rawEntity(db, "module", id);
  if (!module) fail("模块不存在", 404, "NOT_FOUND");
  const [versions, items] = await Promise.all([
    db.prepare("SELECT * FROM work_state_versions WHERE entity_type = 'module' AND entity_id = ? ORDER BY version_no DESC").bind(module.id).all(),
    db.prepare("SELECT * FROM work_items WHERE module_id = ? AND archived_at IS NULL ORDER BY CASE WHEN status IN ('blocked', 'waiting_customer', 'waiting_internal') THEN 0 ELSE 1 END, updated_at DESC").bind(module.id).all()
  ]);
  return {
    ...rowModule(module),
    items: (items.results || []).map(rowItem),
    versions: (versions.results || []).map(rowWorkVersion)
  };
}

async function itemDetail(db, id) {
  const item = await rawEntity(db, "item", id);
  if (!item) fail("任务不存在", 404, "NOT_FOUND");
  const [versions, workItemPeople] = await Promise.all([
    db.prepare("SELECT * FROM work_state_versions WHERE entity_type = 'item' AND entity_id = ? ORDER BY version_no DESC").bind(item.id).all(),
    listWorkItemPeople(db, item.id)
  ]);
  return { ...rowItem(item), versions: (versions.results || []).map(rowWorkVersion), work_item_people: workItemPeople };
}

async function milestoneDetail(db, id) {
  const milestone = await rawEntity(db, "milestone", id);
  if (!milestone) fail("里程碑不存在", 404, "NOT_FOUND");
  const versions = await db.prepare("SELECT * FROM work_state_versions WHERE entity_type = 'milestone' AND entity_id = ? ORDER BY version_no DESC").bind(milestone.id).all();
  return { ...rowMilestone(milestone), versions: (versions.results || []).map(rowWorkVersion) };
}

async function dailyLogDetail(db, id) {
  const log = await rawEntity(db, "daily_log", id);
  if (!log) fail("日报不存在", 404, "NOT_FOUND");
  const [events, proposals, drafts] = await Promise.all([
    db.prepare(`
      SELECT e.*, p.name AS project_name, m.name AS module_name, i.title AS item_title
        FROM daily_work_events e
        LEFT JOIN work_projects p ON p.id = e.project_id
        LEFT JOIN work_modules m ON m.id = e.module_id
        LEFT JOIN work_items i ON i.id = e.work_item_id
       WHERE e.daily_log_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
    `).bind(log.id).all(),
    db.prepare(`
      SELECT p.*, prj.name AS project_name, mod.name AS module_name, itm.title AS item_title
        FROM work_update_proposals p
        LEFT JOIN work_projects prj ON prj.id = p.project_id
        LEFT JOIN work_modules mod ON mod.id = p.module_id
        LEFT JOIN work_items itm ON itm.id = p.work_item_id
       WHERE p.daily_log_id = ?
       ORDER BY p.created_at DESC
    `).bind(log.id).all(),
    db.prepare("SELECT * FROM daily_progress_drafts WHERE daily_log_id = ? ORDER BY updated_at DESC LIMIT 1").bind(log.id).all()
  ]);
  return {
    ...rowDailyLog(log),
    events: (events.results || []).map(rowDailyEvent),
    proposals: (proposals.results || []).map(rowWorkProposal),
    draft: rowWorkDraft(drafts.results?.[0] || null)
  };
}

async function syncDailyLogState(db, logId) {
  const log = await rawEntity(db, "daily_log", logId);
  if (!log) return;
  const result = await db.prepare("SELECT status FROM work_update_proposals WHERE daily_log_id = ?").bind(log.id).all();
  const statuses = (result.results || []).map((row) => row.status);
  if (!statuses.length) return;
  const hasPending = statuses.some((status) => ["pending", "edited"].includes(status));
  const hasAccepted = statuses.some((status) => status === "accepted");
  const hasRejected = statuses.some((status) => status === "rejected");
  const state = hasPending ? "review" : hasAccepted && hasRejected ? "partial" : hasAccepted ? "approved" : "rejected";
  await db.prepare("UPDATE daily_work_logs SET state = ?, updated_at = ? WHERE id = ?").bind(state, now(), log.id).run();
}

async function applyWorkProposal(db, proposalId) {
  const proposal = await db.prepare("SELECT * FROM work_update_proposals WHERE id = ?").bind(cleanId(proposalId)).first();
  if (!proposal) fail("提案不存在", 404, "NOT_FOUND");
  if (!["pending", "edited"].includes(proposal.status)) fail("提案已处理", 409, "PROPOSAL_ALREADY_REVIEWED");

  const action = ensureSet(proposal.action, WORK_PROPOSAL_ACTIONS, "update");
  const projectId = cleanId(proposal.project_id) || null;
  const moduleId = cleanId(proposal.module_id) || null;
  const itemId = cleanId(proposal.work_item_id) || null;
  const value = parseJson(proposal.proposed_value, proposal.proposed_value || {});
  const currentValue = parseJson(proposal.old_value, proposal.old_value || "");
  const timestamp = now();
  const statements = [];
  let touchedEntity = null;
  let touchedId = null;

  async function acceptEntity(entityType, id, payload) {
    const config = entityConfig(entityType);
    if (!config) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
    const current = await rawEntity(db, entityType, id);
    if (!current) fail("目标不存在", 404, "NOT_FOUND");
    statements.push(await saveWorkVersion(db, entityType, current.id, current, proposal.reason || "接受工作提案", proposal.source_event_id || null, proposal.id));
    const columns = Object.keys(payload);
    statements.push(db.prepare(`UPDATE ${config.table} SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...columns.map((column) => payload[column]), timestamp, current.id));
    touchedEntity = entityType;
    touchedId = current.id;
  }

  if (action === "create") {
    const entityType = cleanString(value.entity_type || proposal.field_name || "item", 20);
    if (!["project", "module", "item", "milestone"].includes(entityType)) fail("创建类型无效", 400, "INVALID_ENTITY_TYPE");
    if (entityType === "project") {
      const payload = normalizeProjectPayload(value, null);
      const created = await insertEntity(db, "project", payload);
      statements.push(await saveWorkVersion(db, "project", created.id, created.created, proposal.reason || "创建项目", proposal.source_event_id || null, proposal.id));
      touchedEntity = "project";
      touchedId = created.id;
    } else if (entityType === "module") {
      if (!projectId) fail("创建模块需要项目 ID", 409, "PROJECT_REQUIRED");
      const payload = normalizeModulePayload({ ...value, project_id: projectId }, null);
      const created = await insertEntity(db, "module", payload);
      statements.push(await saveWorkVersion(db, "module", created.id, created.created, proposal.reason || "创建模块", proposal.source_event_id || null, proposal.id));
      touchedEntity = "module";
      touchedId = created.id;
    } else if (entityType === "item") {
      if (!projectId) fail("创建任务需要项目 ID", 409, "PROJECT_REQUIRED");
      const payload = normalizeItemPayload({ ...value, project_id: projectId, module_id: moduleId }, null);
      const created = await insertEntity(db, "item", payload);
      statements.push(await saveWorkVersion(db, "item", created.id, created.created, proposal.reason || "创建任务", proposal.source_event_id || null, proposal.id));
      touchedEntity = "item";
      touchedId = created.id;
    } else {
      if (!projectId) fail("创建里程碑需要项目 ID", 409, "PROJECT_REQUIRED");
      const payload = normalizeMilestonePayload({ ...value, project_id: projectId }, null);
      const created = await insertEntity(db, "milestone", payload);
      statements.push(await saveWorkVersion(db, "milestone", created.id, created.created, proposal.reason || "创建里程碑", proposal.source_event_id || null, proposal.id));
      touchedEntity = "milestone";
      touchedId = created.id;
    }
  } else if (action === "archive") {
    if (itemId) {
      const payload = { status: "archived", archived_at: timestamp, updated_at: timestamp };
      const current = await rawEntity(db, "item", itemId);
      statements.push(await saveWorkVersion(db, "item", current.id, current, proposal.reason || "归档任务", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare("UPDATE work_items SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?").bind("archived", timestamp, timestamp, current.id));
      touchedEntity = "item"; touchedId = current.id;
    } else if (moduleId) {
      const current = await rawEntity(db, "module", moduleId);
      statements.push(await saveWorkVersion(db, "module", current.id, current, proposal.reason || "归档模块", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare("UPDATE work_modules SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?").bind("archived", timestamp, timestamp, current.id));
      statements.push(db.prepare("UPDATE work_items SET status = 'archived', archived_at = ?, updated_at = ? WHERE module_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id));
      touchedEntity = "module"; touchedId = current.id;
    } else if (projectId) {
      const current = await rawEntity(db, "project", projectId);
      statements.push(await saveWorkVersion(db, "project", current.id, current, proposal.reason || "归档项目", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare("UPDATE work_projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?").bind("archived", timestamp, timestamp, current.id));
      statements.push(db.prepare("UPDATE work_modules SET status = 'archived', archived_at = ?, updated_at = ? WHERE project_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id));
      statements.push(db.prepare("UPDATE work_items SET status = 'archived', archived_at = ?, updated_at = ? WHERE project_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id));
      touchedEntity = "project"; touchedId = current.id;
    } else {
      fail("归档提案缺少目标", 409, "TARGET_REQUIRED");
    }
  } else {
    if (itemId) {
      const current = await rawEntity(db, "item", itemId);
      if (!current) fail("任务不存在", 404, "NOT_FOUND");
      const payload = {};
      if (action === "status_change" || proposal.field_name === "status") {
        payload.status = ensureSet(value, WORK_ITEM_STATUSES, current.status);
        if (payload.status === "done") payload.resolved_at = timestamp;
      } else if (proposal.field_name === "module_id") {
        payload.module_id = cleanId(value) || null;
      } else if (proposal.field_name === "project_id") {
        payload.project_id = cleanId(value) || current.project_id;
      } else {
        payload[proposal.field_name || "next_action"] = stringifyValue(value);
      }
      statements.push(await saveWorkVersion(db, "item", current.id, current, proposal.reason || "更新任务", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare(`UPDATE work_items SET ${Object.keys(payload).map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...Object.values(payload), timestamp, current.id));
      touchedEntity = "item"; touchedId = current.id;
    } else if (moduleId) {
      const current = await rawEntity(db, "module", moduleId);
      if (!current) fail("模块不存在", 404, "NOT_FOUND");
      const payload = {};
      if (action === "status_change" || proposal.field_name === "status") {
        payload.status = ensureSet(value, WORK_MODULE_STATUSES, current.status);
      } else {
        payload[proposal.field_name || "next_action"] = stringifyValue(value);
      }
      statements.push(await saveWorkVersion(db, "module", current.id, current, proposal.reason || "更新模块", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare(`UPDATE work_modules SET ${Object.keys(payload).map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...Object.values(payload), timestamp, current.id));
      touchedEntity = "module"; touchedId = current.id;
    } else if (projectId) {
      const current = await rawEntity(db, "project", projectId);
      if (!current) fail("项目不存在", 404, "NOT_FOUND");
      const payload = {};
      if (action === "status_change" || proposal.field_name === "status") {
        payload.status = ensureSet(value, WORK_PROJECT_STATUSES, current.status);
      } else if (proposal.field_name === "tags_json" || proposal.field_name === "tags") {
        payload.tags_json = JSON.stringify(normalizeTags(value));
      } else {
        payload[proposal.field_name || "next_action"] = stringifyValue(value);
      }
      statements.push(await saveWorkVersion(db, "project", current.id, current, proposal.reason || "更新项目", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare(`UPDATE work_projects SET ${Object.keys(payload).map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...Object.values(payload), timestamp, current.id));
      touchedEntity = "project"; touchedId = current.id;
    } else if (proposal.field_name === "acceptance_criteria" || proposal.field_name === "target_date" || proposal.field_name === "current_result" || proposal.field_name === "next_action") {
      const current = await rawEntity(db, "milestone", proposal.project_id);
      if (!current) fail("里程碑不存在", 404, "NOT_FOUND");
      const payload = { [proposal.field_name]: stringifyValue(value) };
      statements.push(await saveWorkVersion(db, "milestone", current.id, current, proposal.reason || "更新里程碑", proposal.source_event_id || null, proposal.id));
      statements.push(db.prepare(`UPDATE work_milestones SET ${proposal.field_name} = ?, updated_at = ? WHERE id = ?`).bind(payload[proposal.field_name], timestamp, current.id));
      touchedEntity = "milestone"; touchedId = current.id;
    } else {
      fail("提案缺少可处理目标", 409, "TARGET_REQUIRED");
    }
  }

  statements.push(
    db.prepare("UPDATE work_update_proposals SET status = 'accepted', reviewed_at = ? WHERE id = ?")
      .bind(timestamp, proposal.id)
  );
  if (proposal.source_event_id) {
    statements.push(db.prepare("UPDATE daily_work_events SET review_status = 'accepted' WHERE id = ?").bind(proposal.source_event_id));
  }
  await db.batch(statements);
  await syncDailyLogState(db, proposal.daily_log_id);
  return { touchedEntity, touchedId, proposal_id: proposal.id };
}

async function rejectWorkProposal(db, proposalId) {
  const proposal = await db.prepare("SELECT * FROM work_update_proposals WHERE id = ?").bind(cleanId(proposalId)).first();
  if (!proposal) fail("提案不存在", 404, "NOT_FOUND");
  const timestamp = now();
  await db.batch([
    db.prepare("UPDATE work_update_proposals SET status = 'rejected', reviewed_at = ? WHERE id = ?").bind(timestamp, proposal.id),
    proposal.source_event_id ? db.prepare("UPDATE daily_work_events SET review_status = 'rejected' WHERE id = ?").bind(proposal.source_event_id) : db.prepare("SELECT 1").bind()
  ]);
  await syncDailyLogState(db, proposal.daily_log_id);
  return { proposal_id: proposal.id };
}

async function proposalDetail(db, id) {
  const proposal = await db.prepare(`
    SELECT p.*, l.work_date, l.raw_text, l.cleaned_text, l.processing_mode AS log_processing_mode,
           l.state AS log_state, prj.name AS project_name, mod.name AS module_name, itm.title AS item_title,
           ev.content AS source_event_content, ev.event_type AS source_event_type, ev.confidence AS source_event_confidence
      FROM work_update_proposals p
      JOIN daily_work_logs l ON l.id = p.daily_log_id
      LEFT JOIN work_projects prj ON prj.id = p.project_id
      LEFT JOIN work_modules mod ON mod.id = p.module_id
      LEFT JOIN work_items itm ON itm.id = p.work_item_id
      LEFT JOIN daily_work_events ev ON ev.id = p.source_event_id
     WHERE p.id = ?
  `).bind(cleanId(id)).first();
  if (!proposal) fail("提案不存在", 404, "NOT_FOUND");
  return rowWorkProposal(proposal);
}

async function workApiRoot(db) {
  const [projects, modules, items, milestones, logs, proposals, overview, progress, openItems] = await Promise.all([
    projectOverviewRows(db),
    moduleProgressRows(db),
    openItemRows(db),
    listWorkMilestones(db),
    listDailyLogs(db, 20),
    listWorkProposals(db, ""),
    projectOverviewRows(db),
    moduleProgressRows(db),
    openItemRows(db)
  ]);
  return json({
    projects,
    modules,
    items,
    milestones,
    daily_logs: logs,
    proposals,
    views: {
      project_overview: overview,
      module_progress: progress,
      open_items: openItems
    }
  });
}

async function workProjectsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    const status = cleanString(url.searchParams.get("status"), 40);
    const query = cleanString(url.searchParams.get("q"), 160);
    let rows = await projectOverviewRows(db);
    if (status) rows = rows.filter((project) => project.status === status);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((project) => [project.name, project.customer_name, project.description, project.goal, project.current_summary, project.next_action].some((field) => String(field || "").toLowerCase().includes(q)));
    }
    return json({ projects: rows });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeProjectPayload(body, null);
    if (!payload.name) fail("项目名称不能为空", 400, "FIELD_REQUIRED");
    const created = await insertEntity(db, "project", payload);
    await db.batch([await saveWorkVersion(db, "project", created.id, created.created, "initial version")]);
    return json({ project: rowProject(created.created) }, 201);
  }
  if (segments.length === 2 && request.method === "GET") return json({ project: await projectDetail(db, segments[1]) });
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await rawEntity(db, "project", segments[1]);
    if (!current) fail("项目不存在", 404, "NOT_FOUND");
    const body = await readJson(request);
    const payload = normalizeProjectPayload(body, current);
    await db.batch([await saveWorkVersion(db, "project", current.id, current, body.change_reason || "手动编辑")]);
    await db.prepare(`
      UPDATE work_projects SET name = ?, customer_name = ?, description = ?, status = ?, stage = ?, goal = ?,
                               current_summary = ?, next_action = ?, target_date = ?, processing_mode = ?,
                               tags_json = ?, sort_order = ?, archived_at = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.name, payload.customer_name, payload.description, payload.status, payload.stage, payload.goal,
      payload.current_summary, payload.next_action, payload.target_date, payload.processing_mode, payload.tags_json,
      payload.sort_order, payload.archived_at, now(), current.id
    ).run();
    return json({ project: await projectDetail(db, current.id) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    const current = await rawEntity(db, "project", segments[1]);
    if (!current) fail("项目不存在", 404, "NOT_FOUND");
    const timestamp = now();
    await db.batch([
      await saveWorkVersion(db, "project", current.id, current, "归档项目"),
      db.prepare("UPDATE work_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, current.id),
      db.prepare("UPDATE work_modules SET status = 'archived', archived_at = ?, updated_at = ? WHERE project_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id),
      db.prepare("UPDATE work_items SET status = 'archived', archived_at = ?, updated_at = ? WHERE project_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id)
    ]);
    return noContent();
  }
  if (segments.length === 3 && segments[2] === "modules" && request.method === "GET") {
    const result = await db.prepare("SELECT m.*, p.name AS project_name FROM work_modules m JOIN work_projects p ON p.id = m.project_id WHERE m.project_id = ? ORDER BY m.sort_order, m.updated_at DESC").bind(cleanId(segments[1])).all();
    return json({ modules: (result.results || []).map(rowModule) });
  }
  if (segments.length >= 3 && segments[2] === "people") return projectPeopleApi(db, request, segments, url);
  if (segments.length === 3 && segments[2] === "modules" && request.method === "POST") {
    const project = await rawEntity(db, "project", segments[1]);
    if (!project) fail("项目不存在", 404, "NOT_FOUND");
    const body = await readJson(request);
    const payload = normalizeModulePayload({ ...body, project_id: project.id }, null);
    if (!payload.name) fail("模块名称不能为空", 400, "FIELD_REQUIRED");
    const created = await insertEntity(db, "module", payload);
    await db.batch([await saveWorkVersion(db, "module", created.id, created.created, "initial version")]);
    return json({ module: rowModule(created.created) }, 201);
  }
  return methodNotAllowed();
}

async function workModulesApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await rawEntity(db, "module", segments[1]);
  if (!current) fail("模块不存在", 404, "NOT_FOUND");
  if (request.method === "GET") return json({ module: await moduleDetail(db, current.id) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeModulePayload(body, current);
    if (!payload.project_id) fail("模块必须归属一个项目", 400, "PROJECT_REQUIRED");
    await db.batch([await saveWorkVersion(db, "module", current.id, current, body.change_reason || "手动编辑")]);
    await db.prepare(`
      UPDATE work_modules SET project_id = ?, name = ?, description = ?, stage = ?, status = ?, current_summary = ?,
                              next_action = ?, target_date = ?, sort_order = ?, archived_at = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.project_id, payload.name, payload.description, payload.stage, payload.status, payload.current_summary,
      payload.next_action, payload.target_date, payload.sort_order, payload.archived_at, now(), current.id
    ).run();
    return json({ module: await moduleDetail(db, current.id) });
  }
  if (request.method === "DELETE") {
    const timestamp = now();
    await db.batch([
      await saveWorkVersion(db, "module", current.id, current, "归档模块"),
      db.prepare("UPDATE work_modules SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, current.id),
      db.prepare("UPDATE work_items SET status = 'archived', archived_at = ?, updated_at = ? WHERE module_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, current.id)
    ]);
    return noContent();
  }
  return methodNotAllowed();
}

async function workItemsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({ items: await listWorkItems(db, {
      project_id: cleanId(url.searchParams.get("project_id")),
      module_id: cleanId(url.searchParams.get("module_id")),
      status: cleanString(url.searchParams.get("status"), 40),
      item_type: cleanString(url.searchParams.get("item_type"), 40),
      q: cleanString(url.searchParams.get("q"), 160)
    }) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeItemPayload(body, null);
    if (!payload.project_id) fail("任务必须归属一个项目", 400, "PROJECT_REQUIRED");
    if (payload.module_id) {
      const module = await rawEntity(db, "module", payload.module_id);
      if (!module || module.project_id !== payload.project_id) fail("任务模块与项目不匹配", 400, "MODULE_PROJECT_MISMATCH");
    }
    if (!payload.title) fail("任务标题不能为空", 400, "FIELD_REQUIRED");
    const created = await insertEntity(db, "item", payload);
    await db.batch([await saveWorkVersion(db, "item", created.id, created.created, "initial version")]);
    return json({ item: rowItem(created.created) }, 201);
  }
  if (segments.length >= 3 && segments[2] === "people") return workItemPeopleApi(db, request, segments);
  if (segments.length !== 2) return methodNotAllowed();
  const current = await rawEntity(db, "item", segments[1]);
  if (!current) fail("任务不存在", 404, "NOT_FOUND");
  if (request.method === "GET") return json({ item: await itemDetail(db, current.id) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeItemPayload(body, current);
    if (!payload.project_id) fail("任务必须归属一个项目", 400, "PROJECT_REQUIRED");
    if (payload.module_id) {
      const module = await rawEntity(db, "module", payload.module_id);
      if (!module || module.project_id !== payload.project_id) fail("任务模块与项目不匹配", 400, "MODULE_PROJECT_MISMATCH");
    }
    await db.batch([await saveWorkVersion(db, "item", current.id, current, body.change_reason || "手动编辑")]);
    await db.prepare(`
      UPDATE work_items SET project_id = ?, module_id = ?, item_type = ?, title = ?, description = ?, status = ?,
                            priority = ?, external_reference = ?, owner = ?, current_result = ?, next_action = ?,
                            due_date = ?, discovered_at = ?, resolved_at = ?, sort_order = ?, archived_at = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.project_id, payload.module_id, payload.item_type, payload.title, payload.description, payload.status,
      payload.priority, payload.external_reference, payload.owner, payload.current_result, payload.next_action,
      payload.due_date, payload.discovered_at, payload.resolved_at, payload.sort_order, payload.archived_at, now(), current.id
    ).run();
    return json({ item: await itemDetail(db, current.id) });
  }
  if (request.method === "DELETE") {
    const timestamp = now();
    await db.batch([
      await saveWorkVersion(db, "item", current.id, current, "归档任务"),
      db.prepare("UPDATE work_items SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, current.id)
    ]);
    return noContent();
  }
  return methodNotAllowed();
}

async function workMilestonesApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({ milestones: await listWorkMilestones(db, cleanId(url.searchParams.get("project_id"))) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeMilestonePayload(body, null);
    if (!payload.project_id) fail("里程碑必须归属一个项目", 400, "PROJECT_REQUIRED");
    if (!payload.title) fail("里程碑标题不能为空", 400, "FIELD_REQUIRED");
    const created = await insertEntity(db, "milestone", payload);
    await db.batch([await saveWorkVersion(db, "milestone", created.id, created.created, "initial version")]);
    return json({ milestone: rowMilestone(created.created) }, 201);
  }
  if (segments.length !== 2) return methodNotAllowed();
  const current = await rawEntity(db, "milestone", segments[1]);
  if (!current) fail("里程碑不存在", 404, "NOT_FOUND");
  if (request.method === "GET") return json({ milestone: await milestoneDetail(db, current.id) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeMilestonePayload(body, current);
    if (!payload.project_id) fail("里程碑必须归属一个项目", 400, "PROJECT_REQUIRED");
    await db.batch([await saveWorkVersion(db, "milestone", current.id, current, body.change_reason || "手动编辑")]);
    await db.prepare(`
      UPDATE work_milestones SET project_id = ?, title = ?, description = ?, target_date = ?, status = ?,
                                 acceptance_criteria = ?, current_result = ?, next_action = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.project_id, payload.title, payload.description, payload.target_date, payload.status,
      payload.acceptance_criteria, payload.current_result, payload.next_action, now(), current.id
    ).run();
    return json({ milestone: await milestoneDetail(db, current.id) });
  }
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM work_milestones WHERE id = ?").bind(current.id).run();
    return noContent();
  }
  return methodNotAllowed();
}

async function workDailyLogsApi(env, db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({ daily_logs: await listDailyLogs(db, intInRange(url.searchParams.get("limit"), 20, 1, 200), safeDate(url.searchParams.get("date"))) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeLogPayload(body, null);
    if (!payload.work_date) payload.work_date = todayDateString();
    if (!payload.raw_text) fail("日报内容不能为空", 400, "FIELD_REQUIRED");
    const id = newId("worklog");
    const timestamp = now();
    await db.prepare(`
      INSERT INTO daily_work_logs (
        id, work_date, raw_text, cleaned_text, selected_project_ids_json, processing_mode,
        requested_model_id, state, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, payload.work_date, payload.raw_text, payload.cleaned_text, payload.selected_project_ids_json,
      payload.processing_mode, payload.requested_model_id, payload.state, payload.error_code, payload.error_message,
      timestamp, timestamp
    ).run();
    if (body.generate !== false) {
      const generated = await generateDailyProgress(env, db, id);
      return json({ log: await dailyLogDetail(db, id), generation: generated }, 201);
    }
    return json({ log: await dailyLogDetail(db, id) }, 201);
  }
  if (segments.length !== 2) return methodNotAllowed();
  const current = await rawEntity(db, "daily_log", segments[1]);
  if (!current) fail("日报不存在", 404, "NOT_FOUND");
  if (request.method === "GET") return json({ log: await dailyLogDetail(db, current.id) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeLogPayload(body, current);
    await db.prepare(`
      UPDATE daily_work_logs SET work_date = ?, raw_text = ?, cleaned_text = ?, selected_project_ids_json = ?,
                                 processing_mode = ?, requested_model_id = ?, state = ?, error_code = ?,
                                 error_message = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.work_date, payload.raw_text, payload.cleaned_text, payload.selected_project_ids_json,
      payload.processing_mode, payload.requested_model_id, payload.state, payload.error_code,
      payload.error_message, now(), current.id
    ).run();
    const draftFields = [body.draft_progress_text, body.draft_detail_text, body.draft_next_action_text, body.draft_status];
    if (draftFields.some((value) => value !== undefined)) {
      const existing = await db.prepare("SELECT * FROM daily_progress_drafts WHERE daily_log_id = ? ORDER BY updated_at DESC LIMIT 1").bind(current.id).first();
      const draftStatus = body.draft_status === undefined ? existing?.status || "draft" : ensureSet(body.draft_status, WORK_DRAFT_STATUSES, existing?.status || "draft");
      if (existing) {
        await db.prepare(`
          UPDATE daily_progress_drafts SET progress_text = ?, detail_text = ?, next_action_text = ?, status = ?, updated_at = ?
           WHERE id = ?
        `).bind(
          cleanOptionalString(body.draft_progress_text, 20000) ?? existing.progress_text,
          cleanOptionalString(body.draft_detail_text, 20000) ?? existing.detail_text,
          cleanOptionalString(body.draft_next_action_text, 12000) ?? existing.next_action_text,
          draftStatus,
          now(),
          existing.id
        ).run();
      } else {
        await db.prepare(`
          INSERT INTO daily_progress_drafts (
            id, daily_log_id, work_date, project_scope_json, progress_text, detail_text, next_action_text,
            status, provider_id, model_id, created_at, updated_at
          ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).bind(
          newId("workdraft"),
          current.id,
          payload.work_date,
          cleanOptionalString(body.draft_progress_text, 20000) || "",
          cleanOptionalString(body.draft_detail_text, 20000) || "",
          cleanOptionalString(body.draft_next_action_text, 12000) || "",
          draftStatus,
          now(),
          now()
        ).run();
      }
    }
    return json({ log: await dailyLogDetail(db, current.id) });
  }
  if (request.method === "DELETE") {
    await deleteDailyLogs(db, [current.id]);
    return noContent();
  }
  return methodNotAllowed();
}

async function deleteDailyLogs(db, ids) {
  const logIds = [...new Set(ids.map((id) => cleanId(id)).filter(Boolean))].slice(0, 500);
  if (!logIds.length) fail("请选择要删除的日报", 400, "DAILY_LOG_DELETE_EMPTY");
  const where = placeholders(logIds);
  const existing = await db.prepare(`SELECT COUNT(*) AS count FROM daily_work_logs WHERE id IN (${where})`).bind(...logIds).first();
  await db.batch([
    db.prepare(`DELETE FROM work_update_proposals WHERE daily_log_id IN (${where})`).bind(...logIds),
    db.prepare(`DELETE FROM daily_work_events WHERE daily_log_id IN (${where})`).bind(...logIds),
    db.prepare(`DELETE FROM daily_progress_drafts WHERE daily_log_id IN (${where})`).bind(...logIds),
    db.prepare(`DELETE FROM ai_runs WHERE daily_log_id IN (${where})`).bind(...logIds),
    db.prepare(`DELETE FROM daily_work_logs WHERE id IN (${where})`).bind(...logIds)
  ]);
  return Number(existing?.count || 0);
}

async function workDailyLogsBulkDeleteApi(db, request) {
  if (request.method !== "POST") return methodNotAllowed();
  const body = await readJson(request);
  const ids = parseArray(body.ids || body.log_ids || body.daily_log_ids);
  const deleted = await deleteDailyLogs(db, ids);
  return json({ deleted });
}

async function workDailyLogActionApi(env, db, request, segments) {
  const current = await rawEntity(db, "daily_log", segments[1]);
  if (!current) fail("日报不存在", 404, "NOT_FOUND");
  if (segments.length === 3 && ["generate", "retry"].includes(segments[2]) && request.method === "POST") {
    const body = await readJson(request);
    if (body.processing_mode !== undefined || body.requested_model_id !== undefined) {
      const payload = normalizeLogPayload(body, current);
      await db.prepare("UPDATE daily_work_logs SET processing_mode = ?, requested_model_id = ?, updated_at = ? WHERE id = ?")
        .bind(payload.processing_mode, payload.requested_model_id, now(), current.id).run();
    }
    const generation = await generateDailyProgress(env, db, current.id);
    return json({ log: await dailyLogDetail(db, current.id), generation });
  }
  return methodNotAllowed();
}

async function workProposalsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({ proposals: await listWorkProposals(db, cleanString(url.searchParams.get("status"), 40)) });
  }
  if (segments.length === 2 && request.method === "GET") return json({ proposal: await proposalDetail(db, segments[1]) });
  if (segments.length === 3 && segments[2] === "reject" && request.method === "POST") {
    return json(await rejectWorkProposal(db, segments[1]));
  }
  if (segments.length === 3 && segments[2] === "apply" && request.method === "POST") {
    const body = await readJson(request);
    const ids = [...new Set(parseArray(body.operation_ids).map((entry) => cleanId(entry)).filter(Boolean))];
    const proposal = await db.prepare("SELECT * FROM work_update_proposals WHERE id = ?").bind(cleanId(segments[1])).first();
    if (!proposal) fail("提案不存在", 404, "NOT_FOUND");
    const candidates = ids.length
      ? ids
      : (await db.prepare("SELECT id FROM work_update_proposals WHERE daily_log_id = ? AND status IN ('pending', 'edited')").bind(proposal.daily_log_id).all()).results.map((row) => row.id);
    if (!candidates.length) fail("没有可接受的操作", 400, "NO_OPERATIONS_SELECTED");
    const applied = [];
    for (const id of candidates) {
      applied.push(await applyWorkProposal(db, id));
    }
    return json({ ok: true, applied, proposal: await dailyLogDetail(db, proposal.daily_log_id) });
  }
  if (segments.length === 3 && segments[2] === "operations" && request.method === "PATCH") return methodNotAllowed();
  if (segments.length === 4 && segments[2] === "operations" && request.method === "PATCH") {
    const proposal = await db.prepare("SELECT * FROM work_update_proposals WHERE id = ?").bind(cleanId(segments[3])).first();
    if (!proposal) fail("提案不存在", 404, "NOT_FOUND");
    const body = await readJson(request);
    const status = body.status === undefined ? proposal.status : ensureSet(body.status, WORK_PROPOSAL_STATUSES, proposal.status);
    const action = body.action === undefined ? proposal.action : ensureSet(body.action, WORK_PROPOSAL_ACTIONS, proposal.action);
    await db.prepare(`
      UPDATE work_update_proposals SET action = ?, field_name = ?, old_value = ?, proposed_value = ?, reason = ?, status = ?,
                                       reviewed_at = ?, project_id = ?, module_id = ?, work_item_id = ?
       WHERE id = ?
    `).bind(
      action,
      cleanOptionalString(body.field_name, 80) ?? proposal.field_name,
      stringifyValue(body.old_value === undefined ? parseJson(proposal.old_value, proposal.old_value) : body.old_value),
      stringifyValue(body.proposed_value === undefined ? parseJson(proposal.proposed_value, proposal.proposed_value) : body.proposed_value),
      cleanOptionalString(body.reason, 500) ?? proposal.reason,
      status,
      status === "accepted" || status === "rejected" ? now() : proposal.reviewed_at,
      body.project_id === undefined ? proposal.project_id : cleanId(body.project_id) || null,
      body.module_id === undefined ? proposal.module_id : cleanId(body.module_id) || null,
      body.work_item_id === undefined ? proposal.work_item_id : cleanId(body.work_item_id) || null,
      proposal.id
    ).run();
    await syncDailyLogState(db, proposal.daily_log_id);
    return json({ proposal: await proposalDetail(db, proposal.id) });
  }
  if (segments.length === 3 && segments[2] === "reject" && request.method === "POST") {
    return json(await rejectWorkProposal(db, segments[1]));
  }
  return methodNotAllowed();
}

async function workEntitiesApi(db, request, segments) {
  if (segments.length !== 4 || request.method !== "GET") return methodNotAllowed();
  const entityType = cleanString(segments[2], 20);
  const entityId = cleanId(segments[3]);
  if (segments[1] !== "entities") return methodNotAllowed();
  if (request.method !== "GET") return methodNotAllowed();
  if (segments[4]) return methodNotAllowed();
  if (entityType === "project") return json({ history: await listWorkVersions(db, "project", entityId) });
  if (entityType === "module") return json({ history: await listWorkVersions(db, "module", entityId) });
  if (entityType === "item") return json({ history: await listWorkVersions(db, "item", entityId) });
  if (entityType === "milestone") return json({ history: await listWorkVersions(db, "milestone", entityId) });
  fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
}

async function workHistoryApi(db, request, segments) {
  const entityType = cleanString(segments[2], 20);
  const entityId = cleanId(segments[3]);
  const versionId = cleanId(segments[5]);
  if (segments.length !== 6 || !["project", "module", "item", "milestone"].includes(entityType) || request.method !== "POST") return methodNotAllowed();
  const restore = await restoreWorkVersion(db, entityType, entityId, versionId);
  if (!restore) fail("历史版本不存在", 404, "NOT_FOUND");
  const config = entityConfig(entityType);
  const columns = Object.keys(restore.restore).filter((column) => column !== "id");
  await db.batch([
    await saveWorkVersion(db, entityType, entityId, restore.current, "恢复历史版本"),
    db.prepare(`UPDATE ${config.table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      .bind(...columns.map((column) => restore.restore[column]), entityId)
  ]);
  return json({ ok: true });
}

async function workViewsApi(db, request, segments) {
  if (request.method !== "GET") return methodNotAllowed();
  if (segments.length !== 2) return methodNotAllowed();
  if (segments[1] === "project-overview") return json({ projects: await projectOverviewRows(db) });
  if (segments[1] === "module-progress") return json({ modules: await moduleProgressRows(db) });
  if (segments[1] === "open-items") return json({ items: await openItemRows(db) });
  return methodNotAllowed();
}

async function workExportApi(db, request, segments) {
  if (request.method !== "POST" || segments.length !== 2) return methodNotAllowed();
  const payload = {
    projects: await projectOverviewRows(db),
    modules: await moduleProgressRows(db),
    items: await openItemRows(db),
    milestones: await listWorkMilestones(db),
    daily_logs: await listDailyLogs(db, 60),
    proposals: await listWorkProposals(db, ""),
    events: (await db.prepare("SELECT * FROM daily_work_events ORDER BY created_at DESC LIMIT 2000").all()).results || [],
    drafts: (await db.prepare("SELECT * FROM daily_progress_drafts ORDER BY updated_at DESC LIMIT 500").all()).results || [],
    versions: (await db.prepare("SELECT * FROM work_state_versions ORDER BY created_at DESC LIMIT 2000").all()).results || []
  };
  const format = cleanString(segments[1], 20);
  if (format === "markdown") return json({ markdown: workMarkdown(payload) });
  if (format === "txt") return json({ txt: workTxt(payload) });
  if (format === "tsv") return json({ tsv: workTsv(payload) });
  if (format === "json") return json(workJson(payload));
  return methodNotAllowed();
}

export async function workApi(env, db, request, segments, url) {
  if (segments.length === 1) {
    if (request.method === "GET") return workApiRoot(db);
    return methodNotAllowed();
  }
  if (segments[1] === "projects") return workProjectsApi(db, request, segments.slice(1), url);
  if (segments[1] === "modules") return workModulesApi(db, request, segments.slice(1));
  if (segments[1] === "items") return workItemsApi(db, request, segments.slice(1), url);
  if (segments[1] === "milestones") return workMilestonesApi(db, request, segments.slice(1), url);
  if (segments[1] === "audio") return audioApi(env, db, request, segments.slice(1), url);
  if (segments[1] === "meetings") return meetingsApi(db, request, segments.slice(1), url);
  if (segments[1] === "transcript-segments") return transcriptSegmentsApi(db, request, segments.slice(1));
  if (segments[1] === "topics") return meetingTopicsApi(db, request, segments.slice(1));
  if (segments[1] === "speakers") return speakerApi(db, request, segments.slice(1));
  if (segments[1] === "daily-logs") {
    if (segments.length === 3 && segments[2] === "delete") return workDailyLogsBulkDeleteApi(db, request);
    if (segments.length === 2 || segments.length === 3) return workDailyLogsApi(env, db, request, segments.slice(1), url);
    if (segments.length === 4 && ["generate", "retry"].includes(segments[3])) return workDailyLogActionApi(env, db, request, segments.slice(1));
    return methodNotAllowed();
  }
  if (segments[1] === "proposals") return workProposalsApi(db, request, segments.slice(1), url);
  if (segments[1] === "entities") {
    if (segments.length === 5 && segments[4] === "history" && request.method === "GET") {
      const entityType = cleanString(segments[2], 20);
      const entityId = cleanId(segments[3]);
      if (!["project", "module", "item", "milestone"].includes(entityType)) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
      return json({ history: await listWorkVersions(db, entityType, entityId) });
    }
    if (segments.length === 6 && segments[4] === "restore" && request.method === "POST") {
      const entityType = cleanString(segments[2], 20);
      const entityId = cleanId(segments[3]);
      const versionId = cleanId(segments[5]);
      if (!["project", "module", "item", "milestone"].includes(entityType)) fail("未知实体类型", 400, "INVALID_ENTITY_TYPE");
      const restore = await restoreWorkVersion(db, entityType, entityId, versionId);
      if (!restore) fail("历史版本不存在", 404, "NOT_FOUND");
      const config = entityConfig(entityType);
      const columns = Object.keys(restore.restore).filter((column) => column !== "id");
      await db.batch([
        await saveWorkVersion(db, entityType, entityId, restore.current, "恢复历史版本"),
        db.prepare(`UPDATE ${config.table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
          .bind(...columns.map((column) => restore.restore[column]), entityId)
      ]);
      return json({ ok: true });
    }
  }
  if (segments[1] === "views") return workViewsApi(db, request, segments.slice(1));
  if (segments[1] === "export") return workExportApi(db, request, segments.slice(1));
  return methodNotAllowed();
}
