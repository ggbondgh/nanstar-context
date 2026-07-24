import {
  cleanId,
  cleanOptionalString,
  cleanString,
  cleanStringList,
  ensureSet,
  intInRange,
  json,
  methodNotAllowed,
  newId,
  noContent,
  now,
  parseArray,
  readJson,
  toBoolInt
} from "./_shared.js";

const ORGANIZATION_TYPES = new Set(["customer", "internal", "partner", "other"]);
const ORGANIZATION_STATUSES = new Set(["active", "inactive", "unknown"]);
const PERSON_STATUSES = new Set(["active", "inactive", "unknown"]);
const PROCESSING_MODES = new Set(["external_ai", "platform_rules", "manual_only"]);
const ROLE_TYPES = new Set(["customer", "fae", "ae", "rd", "pm", "tester", "other"]);
const EXPERTISE_LEVELS = new Set(["unknown", "familiar", "strong", "specialist"]);
const SOURCE_TYPES = new Set(["manual", "meeting", "project", "imported", "suggested"]);
const RELATION_TYPES = new Set(["customer_contact", "fae", "ae", "rd", "project_owner", "tester", "supporter", "other"]);
const WORK_ITEM_RELATION_TYPES = new Set(["owner", "assignee", "requester", "reviewer", "mentioned", "supporter", "waiting_on"]);
const INTERACTION_TYPES = new Set(["meeting", "issue", "support", "decision", "other"]);
const ATTENDANCE_STATUSES = new Set(["unknown", "present", "absent", "partial"]);
const IDENTIFICATION_METHODS = new Set(["manual", "name_match", "voice_match", "suggested"]);
const MEETING_TYPES = new Set(["customer", "internal", "project", "support", "other"]);
const TOPIC_TYPES = new Set(["project_progress", "issue", "decision", "requirement", "resource", "schedule", "other"]);
const REVIEW_STATUSES = new Set(["pending", "confirmed", "rejected", "suggested", "edited"]);

function fail(message, status = 400, code = "PEOPLE_REQUEST_FAILED") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function safeDate(value) {
  const output = cleanString(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(output) ? output : "";
}

function safeNumber(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confidenceValue(value, fallback = 0.6) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function likeValue(value) {
  return `%${cleanString(value, 160).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function rowOrganization(row) {
  if (!row) return null;
  return {
    ...row,
    people_count: Number(row.people_count || 0),
    child_count: Number(row.child_count || 0)
  };
}

function rowPerson(row) {
  if (!row) return null;
  return {
    ...row,
    aliases: parseArray(row.aliases_json),
    role_count: Number(row.role_count || 0),
    expertise_count: Number(row.expertise_count || 0),
    project_count: Number(row.project_count || 0),
    item_count: Number(row.item_count || 0),
    interaction_count: Number(row.interaction_count || 0)
  };
}

function rowPersonRole(row) {
  if (!row) return null;
  return { ...row, is_primary: Boolean(Number(row.is_primary)), confidence: Number(row.confidence ?? 0) };
}

function rowPersonExpertise(row) {
  if (!row) return null;
  return { ...row, confidence: Number(row.confidence ?? 0) };
}

function rowProjectPerson(row) {
  if (!row) return null;
  return { ...row, confidence: Number(row.confidence ?? 0) };
}

function rowWorkItemPerson(row) {
  if (!row) return null;
  return { ...row };
}

function rowInteraction(row) {
  if (!row) return null;
  return { ...row };
}

function rowMeetingParticipant(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence ?? 0),
    confirmed_at: row.confirmed_at || null
  };
}

function rowMeetingTopic(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence ?? 0)
  };
}

function rowSuggestion(row) {
  if (!row) return null;
  return {
    ...row,
    segment_count: Number(row.segment_count || 0),
    last_seen_at: Number(row.last_seen_at || 0)
  };
}

async function insertRow(db, table, payload, prefix) {
  const id = newId(prefix);
  const timestamp = now();
  const data = { id, ...payload, created_at: timestamp, updated_at: timestamp };
  const columns = Object.keys(data);
  await db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => data[column])).run();
  return id;
}

async function updateRow(db, table, id, payload) {
  const clean = cleanId(id);
  if (!clean) fail("资源不存在", 404, "NOT_FOUND");
  const current = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(clean).first();
  if (!current) fail("资源不存在", 404, "NOT_FOUND");
  const columns = Object.keys(payload);
  await db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .bind(...columns.map((column) => payload[column]), clean).run();
  return current;
}

async function archiveRow(db, table, id, extra = {}) {
  const clean = cleanId(id);
  if (!clean) fail("资源不存在", 404, "NOT_FOUND");
  const current = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(clean).first();
  if (!current) fail("资源不存在", 404, "NOT_FOUND");
  const payload = { ...extra, archived_at: now(), updated_at: now() };
  const columns = Object.keys(payload);
  await db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
    .bind(...columns.map((column) => payload[column]), clean).run();
  return current;
}

function normalizeOrganizationPayload(body, current = null) {
  return {
    name: body.name === undefined ? current?.name || "" : cleanString(body.name, 120),
    short_name: body.short_name === undefined ? current?.short_name || "" : cleanOptionalString(body.short_name, 80) || "",
    organization_type: body.organization_type === undefined ? current?.organization_type || "other" : ensureSet(body.organization_type, ORGANIZATION_TYPES, current?.organization_type || "other"),
    parent_id: body.parent_id === undefined ? current?.parent_id || null : cleanId(body.parent_id) || null,
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 1000) || "",
    status: body.status === undefined ? current?.status || "active" : ensureSet(body.status, ORGANIZATION_STATUSES, current?.status || "active")
  };
}

function normalizePersonPayload(body, current = null) {
  const aliasesSource = body.aliases_json !== undefined ? body.aliases_json : body.aliases !== undefined ? body.aliases : current?.aliases_json || [];
  return {
    display_name: body.display_name === undefined ? current?.display_name || "" : cleanString(body.display_name, 120),
    aliases_json: JSON.stringify(cleanStringList(aliasesSource, 80, 20)),
    organization_id: body.organization_id === undefined ? current?.organization_id || null : cleanId(body.organization_id) || null,
    department: body.department === undefined ? current?.department || "" : cleanOptionalString(body.department, 120) || "",
    notes: body.notes === undefined ? current?.notes || "" : cleanOptionalString(body.notes, 2000) || "",
    status: body.status === undefined ? current?.status || "active" : ensureSet(body.status, PERSON_STATUSES, current?.status || "active"),
    processing_mode: body.processing_mode === undefined ? current?.processing_mode || "manual_only" : ensureSet(body.processing_mode, PROCESSING_MODES, current?.processing_mode || "manual_only"),
    sensitivity: body.sensitivity === undefined ? current?.sensitivity || "normal" : cleanOptionalString(body.sensitivity, 40) || "normal"
  };
}

function normalizePersonRolePayload(body, current = null, personId = "") {
  return {
    person_id: body.person_id === undefined ? current?.person_id || cleanId(personId) || "" : cleanId(body.person_id) || "",
    organization_id: body.organization_id === undefined ? current?.organization_id || null : cleanId(body.organization_id) || null,
    role_type: body.role_type === undefined ? current?.role_type || "other" : ensureSet(body.role_type, ROLE_TYPES, current?.role_type || "other"),
    role_name: body.role_name === undefined ? current?.role_name || "" : cleanOptionalString(body.role_name, 120) || "",
    scope_description: body.scope_description === undefined ? current?.scope_description || "" : cleanOptionalString(body.scope_description, 1000) || "",
    valid_from: body.valid_from === undefined ? current?.valid_from || null : safeDate(body.valid_from) || null,
    valid_to: body.valid_to === undefined ? current?.valid_to || null : safeDate(body.valid_to) || null,
    is_primary: body.is_primary === undefined ? current?.is_primary || 0 : toBoolInt(body.is_primary),
    source_type: body.source_type === undefined ? current?.source_type || "manual" : ensureSet(body.source_type, SOURCE_TYPES, current?.source_type || "manual"),
    confidence: body.confidence === undefined ? confidenceValue(current?.confidence ?? 0.6) : confidenceValue(body.confidence, confidenceValue(current?.confidence ?? 0.6))
  };
}

function normalizePersonExpertisePayload(body, current = null, personId = "") {
  return {
    person_id: body.person_id === undefined ? current?.person_id || cleanId(personId) || "" : cleanId(body.person_id) || "",
    expertise_name: body.expertise_name === undefined ? current?.expertise_name || "" : cleanString(body.expertise_name, 120),
    expertise_category: body.expertise_category === undefined ? current?.expertise_category || "" : cleanOptionalString(body.expertise_category, 120) || "",
    level: body.level === undefined ? current?.level || "unknown" : ensureSet(body.level, EXPERTISE_LEVELS, current?.level || "unknown"),
    scope_description: body.scope_description === undefined ? current?.scope_description || "" : cleanOptionalString(body.scope_description, 1000) || "",
    source_type: body.source_type === undefined ? current?.source_type || "manual" : ensureSet(body.source_type, new Set(["manual", "project", "meeting", "suggestion"]), current?.source_type || "manual"),
    source_id: body.source_id === undefined ? current?.source_id || "" : cleanOptionalString(body.source_id, 120) || "",
    confidence: body.confidence === undefined ? confidenceValue(current?.confidence ?? 0.6) : confidenceValue(body.confidence, confidenceValue(current?.confidence ?? 0.6)),
    review_status: body.review_status === undefined ? current?.review_status || "pending" : ensureSet(body.review_status, REVIEW_STATUSES, current?.review_status || "pending")
  };
}

function normalizeProjectPersonPayload(body, current = null, projectId = "") {
  return {
    project_id: body.project_id === undefined ? current?.project_id || cleanId(projectId) || "" : cleanId(body.project_id) || "",
    person_id: body.person_id === undefined ? current?.person_id || "" : cleanId(body.person_id) || "",
    relationship_type: body.relationship_type === undefined ? current?.relationship_type || "other" : ensureSet(body.relationship_type, RELATION_TYPES, current?.relationship_type || "other"),
    responsibility: body.responsibility === undefined ? current?.responsibility || "" : cleanOptionalString(body.responsibility, 1000) || "",
    module_id: body.module_id === undefined ? current?.module_id || null : cleanId(body.module_id) || null,
    valid_from: body.valid_from === undefined ? current?.valid_from || null : safeDate(body.valid_from) || null,
    valid_to: body.valid_to === undefined ? current?.valid_to || null : safeDate(body.valid_to) || null,
    status: body.status === undefined ? current?.status || "active" : ensureSet(body.status, new Set(["active", "inactive", "proposed", "archived"]), current?.status || "active"),
    source_type: body.source_type === undefined ? current?.source_type || "manual" : ensureSet(body.source_type, SOURCE_TYPES, current?.source_type || "manual"),
    confidence: body.confidence === undefined ? confidenceValue(current?.confidence ?? 0.6) : confidenceValue(body.confidence, confidenceValue(current?.confidence ?? 0.6))
  };
}

function normalizeWorkItemPersonPayload(body, current = null, workItemId = "") {
  return {
    work_item_id: body.work_item_id === undefined ? current?.work_item_id || cleanId(workItemId) || "" : cleanId(body.work_item_id) || "",
    person_id: body.person_id === undefined ? current?.person_id || "" : cleanId(body.person_id) || "",
    relation_type: body.relation_type === undefined ? current?.relation_type || "mentioned" : ensureSet(body.relation_type, WORK_ITEM_RELATION_TYPES, current?.relation_type || "mentioned")
  };
}

async function listOrganizations(db) {
  const result = await db.prepare(`
    SELECT o.*,
           COUNT(DISTINCT p.id) AS people_count,
           COUNT(DISTINCT c.id) AS child_count
      FROM organizations o
      LEFT JOIN people p ON p.organization_id = o.id AND p.archived_at IS NULL
      LEFT JOIN organizations c ON c.parent_id = o.id AND c.archived_at IS NULL
     WHERE o.archived_at IS NULL
     GROUP BY o.id
     ORDER BY CASE o.status WHEN 'active' THEN 0 WHEN 'unknown' THEN 1 WHEN 'inactive' THEN 2 ELSE 3 END,
              o.name
  `).all();
  return (result.results || []).map(rowOrganization);
}

async function listPeople(db, filters = {}) {
  const where = ["p.archived_at IS NULL"];
  const params = [];
  const query = cleanString(filters.q, 160);
  const organizationId = cleanId(filters.organization_id);
  const status = ensureSet(filters.status, PERSON_STATUSES, "");
  const roleType = ensureSet(filters.role_type, ROLE_TYPES, "");
  const expertise = cleanString(filters.expertise, 120);
  if (organizationId) { where.push("p.organization_id = ?"); params.push(organizationId); }
  if (status) { where.push("p.status = ?"); params.push(status); }
  if (query) {
    const pattern = likeValue(query);
    where.push("(p.display_name LIKE ? ESCAPE '\\' OR p.aliases_json LIKE ? ESCAPE '\\' OR p.notes LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR o.short_name LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (roleType) {
    where.push(`EXISTS (
      SELECT 1 FROM person_roles r
       WHERE r.person_id = p.id AND r.archived_at IS NULL AND r.role_type = ?
    )`);
    params.push(roleType);
  }
  if (expertise) {
    const pattern = likeValue(expertise);
    where.push(`EXISTS (
      SELECT 1 FROM person_expertise e
       WHERE e.person_id = p.id AND e.archived_at IS NULL
         AND (e.expertise_name LIKE ? ESCAPE '\\' OR e.expertise_category LIKE ? ESCAPE '\\')
    )`);
    params.push(pattern, pattern);
  }
  const result = await db.prepare(`
    SELECT p.*, o.name AS organization_name, o.short_name AS organization_short_name,
           (SELECT COUNT(*) FROM person_roles r WHERE r.person_id = p.id AND r.archived_at IS NULL) AS role_count,
           (SELECT COUNT(*) FROM person_expertise e WHERE e.person_id = p.id AND e.archived_at IS NULL) AS expertise_count,
           (SELECT COUNT(*) FROM project_people pr WHERE pr.person_id = p.id AND pr.archived_at IS NULL) AS project_count,
           (SELECT COUNT(*) FROM work_item_people wi WHERE wi.person_id = p.id AND wi.archived_at IS NULL) AS item_count,
           (SELECT COUNT(*) FROM person_interactions i WHERE i.person_id = p.id AND i.archived_at IS NULL) AS interaction_count
      FROM people p
      LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE ${where.join(" AND ")}
     ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'unknown' THEN 1 WHEN 'inactive' THEN 2 ELSE 3 END,
              p.display_name
     LIMIT 300
  `).bind(...params).all();
  return (result.results || []).map(rowPerson);
}

async function suggestionRows(db) {
  const result = await db.prepare(`
    SELECT COALESCE(s.speaker_label, '') AS speaker_label,
           s.recording_id,
           r.title AS recording_title,
           r.file_name AS file_name,
           r.project_id,
           p.name AS project_name,
           COUNT(*) AS segment_count,
           MAX(s.created_at) AS last_seen_at,
           GROUP_CONCAT(SUBSTR(REPLACE(REPLACE(s.text, char(10), ' '), char(13), ' '), 1, 120), ' ') AS excerpt
      FROM audio_transcript_segments s
      JOIN audio_recordings r ON r.id = s.recording_id
      LEFT JOIN work_projects p ON p.id = r.project_id
     WHERE s.archived_at IS NULL AND s.person_id IS NULL AND COALESCE(s.speaker_label, '') <> ''
     GROUP BY COALESCE(s.speaker_label, '')
     ORDER BY last_seen_at DESC
     LIMIT 12
  `).all();
  return (result.results || []).map(rowSuggestion);
}

async function organizationDetail(db, id) {
  const clean = cleanId(id);
  const organization = await db.prepare("SELECT * FROM organizations WHERE id = ? AND archived_at IS NULL").bind(clean).first();
  if (!organization) fail("组织不存在", 404, "NOT_FOUND");
  const [children, people] = await Promise.all([
    db.prepare("SELECT * FROM organizations WHERE parent_id = ? AND archived_at IS NULL ORDER BY name").bind(clean).all(),
    db.prepare(`
      SELECT p.*, o.name AS organization_name, o.short_name AS organization_short_name,
             (SELECT COUNT(*) FROM person_roles r WHERE r.person_id = p.id AND r.archived_at IS NULL) AS role_count,
             (SELECT COUNT(*) FROM person_expertise e WHERE e.person_id = p.id AND e.archived_at IS NULL) AS expertise_count,
             (SELECT COUNT(*) FROM project_people pr WHERE pr.person_id = p.id AND pr.archived_at IS NULL) AS project_count,
             (SELECT COUNT(*) FROM work_item_people wi WHERE wi.person_id = p.id AND wi.archived_at IS NULL) AS item_count,
             (SELECT COUNT(*) FROM person_interactions i WHERE i.person_id = p.id AND i.archived_at IS NULL) AS interaction_count
        FROM people p
        LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.organization_id = ? AND p.archived_at IS NULL
       ORDER BY p.display_name
    `).bind(clean).all()
  ]);
  return {
    ...rowOrganization({ ...organization, people_count: 0, child_count: 0 }),
    children: (children.results || []).map(rowOrganization),
    people: (people.results || []).map(rowPerson)
  };
}

async function personDetail(db, id) {
  const clean = cleanId(id);
  const person = await db.prepare(`
    SELECT p.*, o.name AS organization_name, o.short_name AS organization_short_name,
           (SELECT COUNT(*) FROM person_roles r WHERE r.person_id = p.id AND r.archived_at IS NULL) AS role_count,
           (SELECT COUNT(*) FROM person_expertise e WHERE e.person_id = p.id AND e.archived_at IS NULL) AS expertise_count,
           (SELECT COUNT(*) FROM project_people pr WHERE pr.person_id = p.id AND pr.archived_at IS NULL) AS project_count,
           (SELECT COUNT(*) FROM work_item_people wi WHERE wi.person_id = p.id AND wi.archived_at IS NULL) AS item_count,
           (SELECT COUNT(*) FROM person_interactions i WHERE i.person_id = p.id AND i.archived_at IS NULL) AS interaction_count
      FROM people p
      LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = ? AND p.archived_at IS NULL
  `).bind(clean).first();
  if (!person) fail("人员不存在", 404, "NOT_FOUND");
  const [roles, expertise, projectPeople, workItemPeople, interactions] = await Promise.all([
    db.prepare(`
      SELECT r.*, o.name AS organization_name
        FROM person_roles r
        LEFT JOIN organizations o ON o.id = r.organization_id
       WHERE r.person_id = ? AND r.archived_at IS NULL
       ORDER BY r.is_primary DESC, r.valid_from DESC, r.created_at DESC
    `).bind(clean).all(),
    db.prepare("SELECT * FROM person_expertise WHERE person_id = ? AND archived_at IS NULL ORDER BY review_status, updated_at DESC").bind(clean).all(),
    db.prepare(`
      SELECT pr.*, p.name AS project_name, p.customer_name, m.name AS module_name
        FROM project_people pr
        LEFT JOIN work_projects p ON p.id = pr.project_id
        LEFT JOIN work_modules m ON m.id = pr.module_id
       WHERE pr.person_id = ? AND pr.archived_at IS NULL
       ORDER BY pr.updated_at DESC
    `).bind(clean).all(),
    db.prepare(`
      SELECT wi.*, w.title AS work_item_title, w.project_id, w.module_id, w.status AS work_item_status,
             p.name AS project_name, m.name AS module_name
        FROM work_item_people wi
        LEFT JOIN work_items w ON w.id = wi.work_item_id
        LEFT JOIN work_projects p ON p.id = w.project_id
        LEFT JOIN work_modules m ON m.id = w.module_id
       WHERE wi.person_id = ? AND wi.archived_at IS NULL
       ORDER BY wi.updated_at DESC
    `).bind(clean).all(),
    db.prepare(`
      SELECT i.*, p.name AS project_name, m.title AS meeting_title
        FROM person_interactions i
        LEFT JOIN work_projects p ON p.id = i.project_id
        LEFT JOIN meetings m ON m.id = i.meeting_id
       WHERE i.person_id = ? AND i.archived_at IS NULL
       ORDER BY i.occurred_at DESC, i.created_at DESC
       LIMIT 60
    `).bind(clean).all()
  ]);
  return {
    ...rowPerson(person),
    roles: (roles.results || []).map(rowPersonRole),
    expertise: (expertise.results || []).map(rowPersonExpertise),
    project_people: (projectPeople.results || []).map(rowProjectPerson),
    work_item_people: (workItemPeople.results || []).map(rowWorkItemPerson),
    interactions: (interactions.results || []).map(rowInteraction)
  };
}

async function listProjectPeople(db, projectId) {
  const clean = cleanId(projectId);
  if (!clean) return [];
  const result = await db.prepare(`
    SELECT pr.*, p.display_name, p.status AS person_status, p.organization_id,
           o.name AS organization_name, o.short_name AS organization_short_name
      FROM project_people pr
      JOIN people p ON p.id = pr.person_id
      LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE pr.project_id = ? AND pr.archived_at IS NULL AND p.archived_at IS NULL
     ORDER BY pr.status, pr.relationship_type, p.display_name
  `).bind(clean).all();
  return (result.results || []).map(rowProjectPerson);
}

async function listWorkItemPeople(db, workItemId) {
  const clean = cleanId(workItemId);
  if (!clean) return [];
  const result = await db.prepare(`
    SELECT wi.*, p.display_name, p.status AS person_status, p.organization_id,
           o.name AS organization_name, o.short_name AS organization_short_name
      FROM work_item_people wi
      JOIN people p ON p.id = wi.person_id
      LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE wi.work_item_id = ? AND wi.archived_at IS NULL AND p.archived_at IS NULL
     ORDER BY wi.relation_type, p.display_name
  `).bind(clean).all();
  return (result.results || []).map(rowWorkItemPerson);
}

async function organizationsApi(db, request, segments) {
  if (segments.length === 1 && request.method === "GET") {
    return json({ organizations: await listOrganizations(db) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeOrganizationPayload(body, null);
    if (!payload.name) fail("组织名称不能为空", 400, "FIELD_REQUIRED");
    if (payload.parent_id) {
      const parent = await db.prepare("SELECT id FROM organizations WHERE id = ? AND archived_at IS NULL").bind(payload.parent_id).first();
      if (!parent) fail("父组织不存在", 400, "PARENT_NOT_FOUND");
    }
    const id = await insertRow(db, "organizations", payload, "org");
    return json({ organization: rowOrganization(await db.prepare("SELECT * FROM organizations WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 2) {
    const current = await db.prepare("SELECT * FROM organizations WHERE id = ?").bind(cleanId(segments[1])).first();
    if (!current) fail("组织不存在", 404, "NOT_FOUND");
    if (request.method === "GET") return json({ organization: await organizationDetail(db, current.id) });
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizeOrganizationPayload(body, current);
      if (!payload.name) fail("组织名称不能为空", 400, "FIELD_REQUIRED");
      if (payload.parent_id === current.id) fail("组织不能以自己作为父级", 400, "INVALID_PARENT");
      if (payload.parent_id) {
        const parent = await db.prepare("SELECT id FROM organizations WHERE id = ? AND archived_at IS NULL").bind(payload.parent_id).first();
        if (!parent) fail("父组织不存在", 400, "PARENT_NOT_FOUND");
      }
      await db.prepare(`
        UPDATE organizations SET name = ?, short_name = ?, organization_type = ?, parent_id = ?, description = ?, status = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.name,
        payload.short_name,
        payload.organization_type,
        payload.parent_id,
        payload.description,
        payload.status,
        now(),
        current.id
      ).run();
      return json({ organization: await organizationDetail(db, current.id) });
    }
    if (request.method === "DELETE") {
      const refs = await db.prepare(`
        SELECT COUNT(*) AS count FROM people WHERE organization_id = ? AND archived_at IS NULL
      `).bind(current.id).first();
      if (Number(refs?.count)) fail("组织下还有人员，不能删除", 409, "ORGANIZATION_NOT_EMPTY");
      await db.prepare("UPDATE organizations SET archived_at = ?, status = 'inactive', updated_at = ? WHERE id = ?")
        .bind(now(), now(), current.id).run();
      return noContent();
    }
  }
  return methodNotAllowed();
}

async function peopleApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({
      people: await listPeople(db, {
        q: url.searchParams.get("q"),
        organization_id: url.searchParams.get("organization_id"),
        status: url.searchParams.get("status"),
        role_type: url.searchParams.get("role_type"),
        expertise: url.searchParams.get("expertise")
      }),
      organizations: await listOrganizations(db),
      suggestions: await suggestionRows(db)
    });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizePersonPayload(body, null);
    if (!payload.display_name) fail("人员名称不能为空", 400, "FIELD_REQUIRED");
    if (payload.organization_id) {
      const organization = await db.prepare("SELECT id FROM organizations WHERE id = ? AND archived_at IS NULL").bind(payload.organization_id).first();
      if (!organization) fail("组织不存在", 400, "ORGANIZATION_NOT_FOUND");
    }
    const id = await insertRow(db, "people", payload, "person");
    return json({ person: rowPerson(await db.prepare(`
      SELECT p.*, o.name AS organization_name, o.short_name AS organization_short_name,
             0 AS role_count, 0 AS expertise_count, 0 AS project_count, 0 AS item_count, 0 AS interaction_count
        FROM people p LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = ?
    `).bind(id).first()) }, 201);
  }
  if (segments.length === 2) {
    const current = await db.prepare("SELECT * FROM people WHERE id = ?").bind(cleanId(segments[1])).first();
    if (!current) fail("人员不存在", 404, "NOT_FOUND");
    if (request.method === "GET") return json({ person: await personDetail(db, current.id) });
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizePersonPayload(body, current);
      if (!payload.display_name) fail("人员名称不能为空", 400, "FIELD_REQUIRED");
      if (payload.organization_id) {
        const organization = await db.prepare("SELECT id FROM organizations WHERE id = ? AND archived_at IS NULL").bind(payload.organization_id).first();
        if (!organization) fail("组织不存在", 400, "ORGANIZATION_NOT_FOUND");
      }
      await db.prepare(`
        UPDATE people SET display_name = ?, aliases_json = ?, organization_id = ?, department = ?, notes = ?,
                          status = ?, processing_mode = ?, sensitivity = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.display_name,
        payload.aliases_json,
        payload.organization_id,
        payload.department,
        payload.notes,
        payload.status,
        payload.processing_mode,
        payload.sensitivity,
        now(),
        current.id
      ).run();
      return json({ person: await personDetail(db, current.id) });
    }
    if (request.method === "DELETE") {
      await db.prepare("UPDATE people SET archived_at = ?, status = 'inactive', updated_at = ? WHERE id = ?")
        .bind(now(), now(), current.id).run();
      return noContent();
    }
  }
  if (segments.length === 3 && segments[2] === "roles") {
    const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(cleanId(segments[1])).first();
    if (!person) fail("人员不存在", 404, "NOT_FOUND");
    if (request.method === "GET") {
      const rows = await db.prepare(`
        SELECT r.*, o.name AS organization_name
          FROM person_roles r
          LEFT JOIN organizations o ON o.id = r.organization_id
         WHERE r.person_id = ? AND r.archived_at IS NULL
         ORDER BY r.is_primary DESC, r.valid_from DESC, r.created_at DESC
      `).bind(person.id).all();
      return json({ roles: (rows.results || []).map(rowPersonRole) });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const payload = normalizePersonRolePayload(body, null, person.id);
      if (!payload.person_id) fail("人员不存在", 404, "NOT_FOUND");
      if (!payload.role_type) fail("角色类型不能为空", 400, "FIELD_REQUIRED");
      if (payload.organization_id) {
        const organization = await db.prepare("SELECT id FROM organizations WHERE id = ? AND archived_at IS NULL").bind(payload.organization_id).first();
        if (!organization) fail("组织不存在", 400, "ORGANIZATION_NOT_FOUND");
      }
      const id = await insertRow(db, "person_roles", payload, "prole");
      return json({ role: rowPersonRole(await db.prepare("SELECT * FROM person_roles WHERE id = ?").bind(id).first()) }, 201);
    }
  }
  if (segments.length === 4 && segments[2] === "roles") {
    const current = await db.prepare("SELECT * FROM person_roles WHERE id = ?").bind(cleanId(segments[3])).first();
    if (!current) fail("角色不存在", 404, "NOT_FOUND");
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizePersonRolePayload(body, current, current.person_id);
      await db.prepare(`
        UPDATE person_roles SET person_id = ?, organization_id = ?, role_type = ?, role_name = ?, scope_description = ?,
                                valid_from = ?, valid_to = ?, is_primary = ?, source_type = ?, confidence = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.person_id,
        payload.organization_id,
        payload.role_type,
        payload.role_name,
        payload.scope_description,
        payload.valid_from,
        payload.valid_to,
        payload.is_primary,
        payload.source_type,
        payload.confidence,
        now(),
        current.id
      ).run();
      return json({ role: rowPersonRole(await db.prepare("SELECT * FROM person_roles WHERE id = ?").bind(current.id).first()) });
    }
    if (request.method === "DELETE") {
      await archiveRow(db, "person_roles", current.id);
      return noContent();
    }
  }
  if (segments.length === 3 && segments[2] === "expertise") {
    const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(cleanId(segments[1])).first();
    if (!person) fail("人员不存在", 404, "NOT_FOUND");
    if (request.method === "GET") {
      const rows = await db.prepare("SELECT * FROM person_expertise WHERE person_id = ? AND archived_at IS NULL ORDER BY review_status, updated_at DESC").bind(person.id).all();
      return json({ expertise: (rows.results || []).map(rowPersonExpertise) });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const payload = normalizePersonExpertisePayload(body, null, person.id);
      if (!payload.person_id) fail("人员不存在", 404, "NOT_FOUND");
      if (!payload.expertise_name) fail("专长名称不能为空", 400, "FIELD_REQUIRED");
      const id = await insertRow(db, "person_expertise", payload, "pexp");
      return json({ expertise: rowPersonExpertise(await db.prepare("SELECT * FROM person_expertise WHERE id = ?").bind(id).first()) }, 201);
    }
  }
  if (segments.length === 4 && segments[2] === "expertise") {
    const current = await db.prepare("SELECT * FROM person_expertise WHERE id = ?").bind(cleanId(segments[3])).first();
    if (!current) fail("专长不存在", 404, "NOT_FOUND");
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizePersonExpertisePayload(body, current, current.person_id);
      await db.prepare(`
        UPDATE person_expertise SET person_id = ?, expertise_name = ?, expertise_category = ?, level = ?, scope_description = ?,
                                    source_type = ?, source_id = ?, confidence = ?, review_status = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.person_id,
        payload.expertise_name,
        payload.expertise_category,
        payload.level,
        payload.scope_description,
        payload.source_type,
        payload.source_id,
        payload.confidence,
        payload.review_status,
        now(),
        current.id
      ).run();
      return json({ expertise: rowPersonExpertise(await db.prepare("SELECT * FROM person_expertise WHERE id = ?").bind(current.id).first()) });
    }
    if (request.method === "DELETE") {
      await archiveRow(db, "person_expertise", current.id);
      return noContent();
    }
  }
  if (segments.length === 3 && segments[2] === "interactions" && request.method === "GET") {
    const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(cleanId(segments[1])).first();
    if (!person) fail("人员不存在", 404, "NOT_FOUND");
    const rows = await db.prepare(`
      SELECT i.*, p.name AS project_name, m.title AS meeting_title
        FROM person_interactions i
        LEFT JOIN work_projects p ON p.id = i.project_id
        LEFT JOIN meetings m ON m.id = i.meeting_id
       WHERE i.person_id = ? AND i.archived_at IS NULL
       ORDER BY i.occurred_at DESC, i.created_at DESC
    `).bind(person.id).all();
    return json({ interactions: (rows.results || []).map(rowInteraction) });
  }
  return methodNotAllowed();
}

async function personRolesApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await db.prepare("SELECT * FROM person_roles WHERE id = ?").bind(cleanId(segments[1])).first();
  if (!current) fail("角色不存在", 404, "NOT_FOUND");
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizePersonRolePayload(body, current, current.person_id);
    await db.prepare(`
      UPDATE person_roles SET person_id = ?, organization_id = ?, role_type = ?, role_name = ?, scope_description = ?,
                              valid_from = ?, valid_to = ?, is_primary = ?, source_type = ?, confidence = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.person_id,
      payload.organization_id,
      payload.role_type,
      payload.role_name,
      payload.scope_description,
      payload.valid_from,
      payload.valid_to,
      payload.is_primary,
      payload.source_type,
      payload.confidence,
      now(),
      current.id
    ).run();
    return json({ role: rowPersonRole(await db.prepare("SELECT * FROM person_roles WHERE id = ?").bind(current.id).first()) });
  }
  if (request.method === "DELETE") {
    await archiveRow(db, "person_roles", current.id);
    return noContent();
  }
  return methodNotAllowed();
}

async function personExpertiseApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await db.prepare("SELECT * FROM person_expertise WHERE id = ?").bind(cleanId(segments[1])).first();
  if (!current) fail("专长不存在", 404, "NOT_FOUND");
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizePersonExpertisePayload(body, current, current.person_id);
    await db.prepare(`
      UPDATE person_expertise SET person_id = ?, expertise_name = ?, expertise_category = ?, level = ?, scope_description = ?,
                                  source_type = ?, source_id = ?, confidence = ?, review_status = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.person_id,
      payload.expertise_name,
      payload.expertise_category,
      payload.level,
      payload.scope_description,
      payload.source_type,
      payload.source_id,
      payload.confidence,
      payload.review_status,
      now(),
      current.id
    ).run();
    return json({ expertise: rowPersonExpertise(await db.prepare("SELECT * FROM person_expertise WHERE id = ?").bind(current.id).first()) });
  }
  if (request.method === "DELETE") {
    await archiveRow(db, "person_expertise", current.id);
    return noContent();
  }
  return methodNotAllowed();
}

async function projectPeopleApi(db, request, segments, url) {
  const projectId = cleanId(segments[1]);
  if (!projectId) fail("项目不存在", 404, "NOT_FOUND");
  if (segments.length === 3 && request.method === "GET") {
    return json({ project_people: await listProjectPeople(db, projectId) });
  }
  if (segments.length === 3 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeProjectPersonPayload(body, null, projectId);
    if (!payload.person_id) fail("人员不能为空", 400, "FIELD_REQUIRED");
    const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(payload.person_id).first();
    if (!person) fail("人员不存在", 404, "NOT_FOUND");
    const exists = await db.prepare(`
      SELECT id FROM project_people
       WHERE project_id = ? AND person_id = ? AND relationship_type = ? AND COALESCE(module_id, '') = COALESCE(?, '')
         AND archived_at IS NULL
    `).bind(payload.project_id, payload.person_id, payload.relationship_type, payload.module_id).first();
    if (exists) {
      await db.prepare(`
        UPDATE project_people SET responsibility = ?, valid_from = ?, valid_to = ?, status = ?, source_type = ?, confidence = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.responsibility,
        payload.valid_from,
        payload.valid_to,
        payload.status,
        payload.source_type,
        payload.confidence,
        now(),
        exists.id
      ).run();
      return json({ project_person: rowProjectPerson(await db.prepare("SELECT * FROM project_people WHERE id = ?").bind(exists.id).first()) });
    }
    const id = await insertRow(db, "project_people", payload, "prjperson");
    return json({ project_person: rowProjectPerson(await db.prepare("SELECT * FROM project_people WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 4) {
    const current = await db.prepare("SELECT * FROM project_people WHERE id = ?").bind(cleanId(segments[3])).first();
    if (!current) fail("关系不存在", 404, "NOT_FOUND");
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizeProjectPersonPayload(body, current, projectId);
      await db.prepare(`
        UPDATE project_people SET project_id = ?, person_id = ?, relationship_type = ?, responsibility = ?, module_id = ?,
                                  valid_from = ?, valid_to = ?, status = ?, source_type = ?, confidence = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.project_id,
        payload.person_id,
        payload.relationship_type,
        payload.responsibility,
        payload.module_id,
        payload.valid_from,
        payload.valid_to,
        payload.status,
        payload.source_type,
        payload.confidence,
        now(),
        current.id
      ).run();
      return json({ project_person: rowProjectPerson(await db.prepare("SELECT * FROM project_people WHERE id = ?").bind(current.id).first()) });
    }
    if (request.method === "DELETE") {
      await archiveRow(db, "project_people", current.id);
      return noContent();
    }
  }
  return methodNotAllowed();
}

async function workItemPeopleApi(db, request, segments) {
  const workItemId = cleanId(segments[1]);
  if (!workItemId) fail("任务不存在", 404, "NOT_FOUND");
  if (segments.length === 3 && request.method === "GET") {
    return json({ work_item_people: await listWorkItemPeople(db, workItemId) });
  }
  if (segments.length === 3 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeWorkItemPersonPayload(body, null, workItemId);
    if (!payload.person_id) fail("人员不能为空", 400, "FIELD_REQUIRED");
    const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(payload.person_id).first();
    if (!person) fail("人员不存在", 404, "NOT_FOUND");
    const exists = await db.prepare(`
      SELECT id FROM work_item_people
       WHERE work_item_id = ? AND person_id = ? AND relation_type = ? AND archived_at IS NULL
    `).bind(payload.work_item_id, payload.person_id, payload.relation_type).first();
    if (exists) return json({ work_item_person: rowWorkItemPerson(await db.prepare("SELECT * FROM work_item_people WHERE id = ?").bind(exists.id).first()) });
    const id = await insertRow(db, "work_item_people", payload, "itemperson");
    return json({ work_item_person: rowWorkItemPerson(await db.prepare("SELECT * FROM work_item_people WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 4) {
    const current = await db.prepare("SELECT * FROM work_item_people WHERE id = ?").bind(cleanId(segments[3])).first();
    if (!current) fail("关系不存在", 404, "NOT_FOUND");
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizeWorkItemPersonPayload(body, current, workItemId);
      await db.prepare(`
        UPDATE work_item_people SET work_item_id = ?, person_id = ?, relation_type = ?, updated_at = ?
         WHERE id = ?
      `).bind(payload.work_item_id, payload.person_id, payload.relation_type, now(), current.id).run();
      return json({ work_item_person: rowWorkItemPerson(await db.prepare("SELECT * FROM work_item_people WHERE id = ?").bind(current.id).first()) });
    }
    if (request.method === "DELETE") {
      await archiveRow(db, "work_item_people", current.id);
      return noContent();
    }
  }
  return methodNotAllowed();
}

export {
  listOrganizations,
  listPeople,
  listProjectPeople,
  listWorkItemPeople,
  organizationDetail,
  personDetail,
  organizationsApi,
  peopleApi,
  personRolesApi,
  personExpertiseApi,
  projectPeopleApi,
  workItemPeopleApi
};
