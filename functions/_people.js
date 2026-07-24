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

function importList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[,，、;；|]/).map((item) => item.trim()).filter(Boolean);
}

function importFieldKey(value) {
  const key = cleanString(value, 80).toLowerCase().replace(/[\s_-]/g, "");
  return ({
    name: "display_name",
    displayname: "display_name",
    姓名: "display_name",
    人员: "display_name",
    人员姓名: "display_name",
    alias: "aliases",
    aliases: "aliases",
    别名: "aliases",
    昵称: "aliases",
    organization: "organization_name",
    organizationname: "organization_name",
    company: "organization_name",
    组织: "organization_name",
    组织名称: "organization_name",
    公司: "organization_name",
    department: "department",
    部门: "department",
    role: "roles",
    roles: "roles",
    角色: "roles",
    职责: "roles",
    expertise: "expertise",
    skills: "expertise",
    专长: "expertise",
    技能: "expertise",
    notes: "notes",
    note: "notes",
    备注: "notes",
    说明: "notes",
    status: "status",
    状态: "status",
    processingmode: "processing_mode",
    处理模式: "processing_mode",
    type: "organization_type",
    organizationtype: "organization_type",
    组织类型: "organization_type",
    description: "description",
    描述: "description",
    父组织: "parent_name",
    parent: "parent_name",
    parentname: "parent_name"
  }[key] || "");
}

function importFieldsFromLine(line) {
  const normalized = String(line || "").replace(/，(?=(?:姓名|人员|组织|公司|部门|角色|专长|技能|备注|别名|name|organization|department|role|expertise|skills|notes|alias)\s*[:：])/gi, ";");
  const fields = {};
  for (const part of normalized.split(/[|;；]/)) {
    const match = part.trim().match(/^([^:：]+)\s*[:：]\s*(.*)$/);
    if (!match) continue;
    const key = importFieldKey(match[1]);
    if (key) fields[key] = match[2].trim();
  }
  return fields;
}

function importDelimitedCells(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (const character of String(line || "")) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function normalizeImportedOrganization(value) {
  if (typeof value === "string") return { name: cleanString(value, 120) };
  if (!value || typeof value !== "object") return null;
  const name = cleanString(value.name || value.organization_name || value.organization || value.组织 || value.组织名称, 120);
  if (!name) return null;
  return {
    name,
    short_name: cleanString(value.short_name || value.shortName || value.简称, 80),
    organization_type: ORGANIZATION_TYPES.has(value.organization_type) ? value.organization_type : "other",
    parent_name: cleanString(value.parent_name || value.parent || value.父组织, 120),
    description: cleanString(value.description || value.描述, 1000),
    status: ORGANIZATION_STATUSES.has(value.status) ? value.status : "active"
  };
}

function normalizeImportedPerson(value) {
  if (!value || typeof value !== "object") return null;
  const displayName = cleanString(value.display_name || value.displayName || value.name || value.姓名 || value.人员, 120);
  if (!displayName) return null;
  const roles = importList(value.roles ?? value.role ?? value.角色).map((role) => {
    if (typeof role === "string") return { role_name: cleanString(role, 120) };
    return {
      role_type: cleanString(role?.role_type || role?.type, 40),
      role_name: cleanString(role?.role_name || role?.name || role?.角色, 120),
      scope_description: cleanString(role?.scope_description || role?.scope || role?.说明, 1000)
    };
  }).filter((role) => role.role_name || role.role_type);
  const expertise = importList(value.expertise ?? value.skills ?? value.专长 ?? value.技能).map((item) => {
    if (typeof item === "string") return { expertise_name: cleanString(item, 120) };
    return {
      expertise_name: cleanString(item?.expertise_name || item?.name || item?.专长, 120),
      expertise_category: cleanString(item?.expertise_category || item?.category || item?.分类, 120),
      level: EXPERTISE_LEVELS.has(item?.level) ? item.level : "unknown",
      scope_description: cleanString(item?.scope_description || item?.scope || item?.说明, 1000)
    };
  }).filter((item) => item.expertise_name);
  return {
    display_name: displayName,
    aliases: cleanStringList(importList(value.aliases ?? value.alias ?? value.别名 ?? value.昵称), 80, 20),
    organization_name: cleanString(value.organization_name || value.organizationName || value.organization || value.company || value.组织 || value.公司, 120),
    department: cleanString(value.department || value.部门, 120),
    notes: cleanString(value.notes || value.note || value.备注 || value.说明, 2000),
    status: PERSON_STATUSES.has(value.status) ? value.status : "active",
    processing_mode: PROCESSING_MODES.has(value.processing_mode) ? value.processing_mode : "manual_only",
    sensitivity: cleanString(value.sensitivity, 40) || "normal",
    roles,
    expertise
  };
}

function parsePeopleText(source) {
  const organizations = [];
  const people = [];
  const warnings = [];
  let tableHeaders = null;
  let currentPerson = null;
  let currentOrganization = "";
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");

  const addOrganization = (value) => {
    const organization = normalizeImportedOrganization(value);
    if (organization) {
      organizations.push(organization);
      currentOrganization = organization.name;
    }
  };
  const addPerson = (value) => {
    const person = normalizeImportedPerson(value);
    if (person) {
      if (!person.organization_name && currentOrganization) person.organization_name = currentOrganization;
      people.push(person);
      currentPerson = person;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!line || /^---+$/.test(line)) continue;
    const heading = line.match(/^#{3,}\s+(.+)$/);
    if (heading) {
      const title = heading[1].trim();
      if (!/^(人员|people|组织|organizations?|人员中心)$/i.test(title)) addPerson({ display_name: title, organization_name: currentOrganization });
      continue;
    }
    const delimiter = line.includes("|") ? "|" : line.includes("\t") ? "\t" : line.includes(",") ? "," : "";
    if (delimiter) {
      const cells = importDelimitedCells(line, delimiter).filter(Boolean);
      if (!tableHeaders && cells.some((cell) => importFieldKey(cell) === "display_name")) {
        tableHeaders = cells.map((cell) => importFieldKey(cell));
        continue;
      }
      if (tableHeaders && delimiter === (line.includes("|") ? "|" : line.includes("\t") ? "\t" : "," ) && !cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        const row = {};
        tableHeaders.forEach((key, index) => { if (key && cells[index]) row[key] = cells[index]; });
        if (row.organization_name && !row.display_name) addOrganization(row);
        else if (row.display_name) addPerson(row);
        continue;
      }
    }
    const fields = importFieldsFromLine(line);
    if (fields.organization_name && !fields.display_name && !fields.roles && !fields.expertise && !fields.department && !fields.notes) {
      addOrganization(fields.organization_name);
      continue;
    }
    if (fields.display_name) {
      addPerson(fields);
      continue;
    }
    if (currentPerson && Object.keys(fields).length) {
      const next = normalizeImportedPerson({ ...currentPerson, ...fields });
      if (next) {
        Object.assign(currentPerson, next);
        continue;
      }
    }
    if (/^(组织|organizations?)$/i.test(line)) continue;
    if (/^(人员|people)$/i.test(line)) continue;
    if (line.includes("姓名") || line.includes("人员")) warnings.push(`无法识别：${line.slice(0, 120)}`);
  }
  return { organizations, people, warnings };
}

function normalizePeopleImport(body) {
  const direct = body && typeof body === "object" && (Array.isArray(body.people) || Array.isArray(body.organizations));
  let organizations = direct ? body.organizations || [] : [];
  let people = direct ? body.people || [] : [];
  let warnings = [];
  if (direct && (Array.isArray(body.roles) || Array.isArray(body.expertise))) {
    const rolesByPerson = new Map();
    const expertiseByPerson = new Map();
    for (const role of body.roles || []) {
      const personId = role?.person_id || role?.personId;
      if (personId) rolesByPerson.set(personId, [...(rolesByPerson.get(personId) || []), role]);
    }
    for (const item of body.expertise || []) {
      const personId = item?.person_id || item?.personId;
      if (personId) expertiseByPerson.set(personId, [...(expertiseByPerson.get(personId) || []), item]);
    }
    people = people.map((person) => ({
      ...person,
      roles: person.roles || rolesByPerson.get(person.id) || [],
      expertise: person.expertise || expertiseByPerson.get(person.id) || []
    }));
  }
  if (!direct) {
    const source = cleanString(body?.text, 240000);
    if (!source) fail("导入内容不能为空", 400, "IMPORT_EMPTY");
    try {
      const parsed = JSON.parse(source);
      if (parsed && typeof parsed === "object" && (Array.isArray(parsed.people) || Array.isArray(parsed.organizations))) {
        organizations = parsed.organizations || [];
        people = parsed.people || [];
      } else {
        ({ organizations, people, warnings } = parsePeopleText(source));
      }
    } catch {
      ({ organizations, people, warnings } = parsePeopleText(source));
    }
  }
  const normalizedOrganizations = [];
  const organizationKeys = new Set();
  for (const value of organizations) {
    const organization = normalizeImportedOrganization(value);
    const key = organization?.name.toLowerCase();
    if (organization && !organizationKeys.has(key)) {
      organizationKeys.add(key);
      normalizedOrganizations.push(organization);
    }
  }
  const normalizedPeople = [];
  const personKeys = new Set();
  for (const value of people) {
    const person = normalizeImportedPerson(value);
    const key = person ? `${person.display_name.toLowerCase()}|${person.organization_name.toLowerCase()}` : "";
    if (person && !personKeys.has(key)) {
      personKeys.add(key);
      normalizedPeople.push(person);
    }
  }
  for (const person of normalizedPeople) {
    if (person.organization_name && !organizationKeys.has(person.organization_name.toLowerCase())) {
      organizationKeys.add(person.organization_name.toLowerCase());
      normalizedOrganizations.push({ name: person.organization_name, organization_type: "other", status: "active" });
    }
  }
  if (!normalizedOrganizations.length && !normalizedPeople.length) warnings.push("没有识别到组织或人员。支持“姓名：张三；组织：某公司”以及 Markdown/CSV 表格格式。");
  return {
    organizations: normalizedOrganizations,
    people: normalizedPeople,
    warnings,
    counts: { organizations: normalizedOrganizations.length, people: normalizedPeople.length }
  };
}

function inferRoleType(value) {
  const source = String(value || "").toLowerCase();
  if (source === "pm" || source.includes("项目经理") || source.includes("产品经理")) return "pm";
  if (source === "fae" || source.includes("现场应用")) return "fae";
  if (source === "ae" || source.includes("销售")) return "ae";
  if (source === "rd" || source.includes("研发") || source.includes("开发")) return "rd";
  if (source.includes("测试") || source.includes("qa")) return "tester";
  if (source.includes("客户")) return "customer";
  return "other";
}

async function peopleImportPreview(body) {
  return normalizePeopleImport(body);
}

async function applyPeopleImport(db, body) {
  const payload = normalizePeopleImport(body);
  const organizationIds = new Map();
  const existingOrganizations = await db.prepare("SELECT * FROM organizations WHERE archived_at IS NULL").all();
  for (const row of existingOrganizations.results || []) {
    organizationIds.set(row.name.toLowerCase(), row.id);
    if (row.short_name) organizationIds.set(row.short_name.toLowerCase(), row.id);
  }
  const result = {
    organizations_created: 0,
    organizations_matched: 0,
    people_created: 0,
    people_updated: 0,
    roles_created: 0,
    expertise_created: 0,
    total: 0,
    warnings: payload.warnings || []
  };
  for (const organization of payload.organizations) {
    const key = organization.name.toLowerCase();
    let id = organizationIds.get(key);
    if (id) {
      result.organizations_matched += 1;
    } else {
      id = await insertRow(db, "organizations", {
        name: organization.name,
        short_name: organization.short_name || "",
        organization_type: organization.organization_type,
        parent_id: null,
        description: organization.description || "",
        status: organization.status
      }, "org");
      organizationIds.set(key, id);
      if (organization.short_name) organizationIds.set(organization.short_name.toLowerCase(), id);
      result.organizations_created += 1;
    }
  }
  for (const organization of payload.organizations) {
    if (!organization.parent_name) continue;
    const childId = organizationIds.get(organization.name.toLowerCase());
    const parentId = organizationIds.get(organization.parent_name.toLowerCase());
    if (childId && parentId && childId !== parentId) {
      await db.prepare("UPDATE organizations SET parent_id = ?, updated_at = ? WHERE id = ? AND (parent_id IS NULL OR parent_id = '')")
        .bind(parentId, now(), childId).run();
    }
  }
  for (const imported of payload.people) {
    const organizationId = imported.organization_name ? organizationIds.get(imported.organization_name.toLowerCase()) || null : null;
    let current = await db.prepare(`
      SELECT * FROM people
       WHERE archived_at IS NULL AND lower(display_name) = lower(?)
         AND ((organization_id = ?) OR (organization_id IS NULL AND ? IS NULL))
       LIMIT 1
    `).bind(imported.display_name, organizationId, organizationId).first();
    let personId;
    const aliases = [...new Set([...(current ? parseArray(current.aliases_json) : []), ...imported.aliases])].slice(0, 20);
    if (!current) {
      personId = await insertRow(db, "people", {
        display_name: imported.display_name,
        aliases_json: JSON.stringify(aliases),
        organization_id: organizationId,
        department: imported.department,
        notes: imported.notes,
        status: imported.status,
        processing_mode: imported.processing_mode,
        sensitivity: imported.sensitivity
      }, "person");
      result.people_created += 1;
      current = await db.prepare("SELECT * FROM people WHERE id = ?").bind(personId).first();
    } else {
      personId = current.id;
      const department = current.department || imported.department;
      const notes = current.notes || imported.notes;
      await db.prepare(`
        UPDATE people SET aliases_json = ?, department = ?, notes = ?, updated_at = ?
         WHERE id = ?
      `).bind(JSON.stringify(aliases), department, notes, now(), personId).run();
      result.people_updated += 1;
    }
    for (const role of imported.roles) {
      const roleName = role.role_name || role.role_type;
      const roleType = ROLE_TYPES.has(role.role_type) ? role.role_type : inferRoleType(roleName);
      const duplicate = await db.prepare(`
        SELECT id FROM person_roles
         WHERE person_id = ? AND organization_id IS ? AND role_type = ? AND lower(role_name) = lower(?) AND archived_at IS NULL
         LIMIT 1
      `).bind(personId, organizationId, roleType, roleName).first();
      if (!duplicate) {
        await insertRow(db, "person_roles", {
          person_id: personId,
          organization_id: organizationId,
          role_type: roleType,
          role_name: cleanString(roleName, 120),
          scope_description: role.scope_description || "",
          valid_from: null,
          valid_to: null,
          is_primary: 0,
          source_type: "imported",
          confidence: 0.8
        }, "prole");
        result.roles_created += 1;
      }
    }
    for (const expertise of imported.expertise) {
      const duplicate = await db.prepare(`
        SELECT id FROM person_expertise
         WHERE person_id = ? AND lower(expertise_name) = lower(?) AND archived_at IS NULL
         LIMIT 1
      `).bind(personId, expertise.expertise_name).first();
      if (!duplicate) {
        await insertRow(db, "person_expertise", {
          person_id: personId,
          expertise_name: expertise.expertise_name,
          expertise_category: expertise.expertise_category || "",
          level: expertise.level || "unknown",
          scope_description: expertise.scope_description || "",
          source_type: "manual",
          source_id: "people_import",
          confidence: 0.8,
          review_status: "pending"
        }, "pexp");
        result.expertise_created += 1;
      }
    }
  }
  result.total = result.organizations_created + result.people_created + result.roles_created + result.expertise_created;
  return result;
}

async function peopleExportData(db) {
  const [organizations, people, roles, expertise, projectPeople, workItemPeople, interactions] = await Promise.all([
    db.prepare(`
      SELECT o.*, parent.name AS parent_name
        FROM organizations o
        LEFT JOIN organizations parent ON parent.id = o.parent_id
       WHERE o.archived_at IS NULL
       ORDER BY o.name
    `).all(),
    db.prepare(`
      SELECT p.*, o.name AS organization_name, o.short_name AS organization_short_name
        FROM people p
        LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.archived_at IS NULL
       ORDER BY p.display_name
    `).all(),
    db.prepare(`
      SELECT r.*, p.display_name, o.name AS organization_name
        FROM person_roles r
       JOIN people p ON p.id = r.person_id
        LEFT JOIN organizations o ON o.id = r.organization_id
       WHERE r.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.display_name, r.is_primary DESC, r.role_name
    `).all(),
    db.prepare(`
      SELECT e.*, p.display_name
        FROM person_expertise e
       JOIN people p ON p.id = e.person_id
       WHERE e.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.display_name, e.expertise_name
    `).all(),
    db.prepare(`
      SELECT r.*, p.display_name, project.name AS project_name, module.name AS module_name
        FROM project_people r
        JOIN people p ON p.id = r.person_id
       LEFT JOIN work_projects project ON project.id = r.project_id
       LEFT JOIN work_modules module ON module.id = r.module_id
       WHERE r.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.display_name, project.name
    `).all(),
    db.prepare(`
      SELECT r.*, p.display_name, item.title AS work_item_title, project.name AS project_name
        FROM work_item_people r
        JOIN people p ON p.id = r.person_id
       LEFT JOIN work_items item ON item.id = r.work_item_id
       LEFT JOIN work_projects project ON project.id = item.project_id
       WHERE r.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.display_name, item.title
    `).all(),
    db.prepare(`
      SELECT i.*, p.display_name, project.name AS project_name, meeting.title AS meeting_title
        FROM person_interactions i
        JOIN people p ON p.id = i.person_id
       LEFT JOIN work_projects project ON project.id = i.project_id
       LEFT JOIN meetings meeting ON meeting.id = i.meeting_id
       WHERE i.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.display_name, i.occurred_at DESC
    `).all()
  ]);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    organizations: (organizations.results || []).map((row) => ({ ...row })),
    people: (people.results || []).map((row) => ({ ...row, aliases: parseArray(row.aliases_json), aliases_json: undefined })),
    roles: roles.results || [],
    expertise: expertise.results || [],
    project_people: projectPeople.results || [],
    work_item_people: workItemPeople.results || [],
    interactions: interactions.results || []
  };
}

function markdownValue(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function peopleMarkdown(data) {
  const rolesByPerson = new Map();
  const expertiseByPerson = new Map();
  const projectsByPerson = new Map();
  const itemsByPerson = new Map();
  const interactionsByPerson = new Map();
  for (const role of data.roles) rolesByPerson.set(role.person_id, [...(rolesByPerson.get(role.person_id) || []), role]);
  for (const item of data.expertise) expertiseByPerson.set(item.person_id, [...(expertiseByPerson.get(item.person_id) || []), item]);
  for (const item of data.project_people) projectsByPerson.set(item.person_id, [...(projectsByPerson.get(item.person_id) || []), item]);
  for (const item of data.work_item_people) itemsByPerson.set(item.person_id, [...(itemsByPerson.get(item.person_id) || []), item]);
  for (const item of data.interactions) interactionsByPerson.set(item.person_id, [...(interactionsByPerson.get(item.person_id) || []), item]);
  const lines = ["# NanStar Context 人员信息", "", `导出时间：${data.exported_at}`, "", "## 组织", ""];
  if (!data.organizations.length) lines.push("暂无组织", "");
  for (const organization of data.organizations) {
    lines.push(`### ${markdownValue(organization.name)}`);
    lines.push(`- 简称：${markdownValue(organization.short_name || "无")}`);
    lines.push(`- 类型：${markdownValue(organization.organization_type)}`);
    if (organization.parent_name) lines.push(`- 父组织：${markdownValue(organization.parent_name)}`);
    if (organization.description) lines.push(`- 说明：${markdownValue(organization.description)}`);
    lines.push("");
  }
  lines.push("## 人员", "");
  if (!data.people.length) lines.push("暂无人员", "");
  for (const person of data.people) {
    lines.push(`### ${markdownValue(person.display_name)}`);
    lines.push(`- 组织：${markdownValue(person.organization_name || "未分配")}`);
    lines.push(`- 部门：${markdownValue(person.department || "未填写")}`);
    lines.push(`- 别名：${markdownValue(person.aliases?.join("、") || "无")}`);
    if (person.notes) lines.push(`- 备注：${markdownValue(person.notes)}`);
    const roles = rolesByPerson.get(person.id) || [];
    const expertise = expertiseByPerson.get(person.id) || [];
    lines.push(`- 角色：${markdownValue(roles.map((role) => role.role_name || role.role_type).join("、") || "无")}`);
    lines.push(`- 专长：${markdownValue(expertise.map((item) => item.expertise_name).join("、") || "无")}`);
    const projects = projectsByPerson.get(person.id) || [];
    const items = itemsByPerson.get(person.id) || [];
    const interactions = interactionsByPerson.get(person.id) || [];
    if (projects.length) lines.push(`- 项目关系：${markdownValue(projects.map((item) => `${item.project_name || item.project_id}（${item.relationship_type}）`).join("、"))}`);
    if (items.length) lines.push(`- 任务关系：${markdownValue(items.map((item) => `${item.work_item_title || item.work_item_id}（${item.relation_type}）`).join("、"))}`);
    if (interactions.length) lines.push(`- 互动记录：${markdownValue(interactions.slice(0, 20).map((item) => `${item.interaction_type}：${item.summary || "无摘要"}`).join("；"))}`);
    lines.push("");
  }
  return lines.join("\n");
}

function peopleTxt(data) {
  return peopleMarkdown(data).replace(/^#+\s*/gm, "").replace(/^- /gm, "").replace(/\n{3,}/g, "\n\n");
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
  if (segments.length === 3 && segments[1] === "export" && request.method === "GET") {
    const format = segments[2];
    const data = await peopleExportData(db);
    if (format === "json") {
      return json(data, 200, {
        "content-disposition": `attachment; filename="nanstar-people-${Date.now()}.json"`,
        "content-type": "application/json; charset=utf-8"
      });
    }
    if (format === "markdown" || format === "md") {
      return new Response(peopleMarkdown(data), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="nanstar-people-${Date.now()}.md"`,
          "x-content-type-options": "nosniff"
        }
      });
    }
    if (format === "txt") {
      return new Response(peopleTxt(data), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="nanstar-people-${Date.now()}.txt"`,
          "x-content-type-options": "nosniff"
        }
      });
    }
    return methodNotAllowed();
  }
  if (segments.length === 3 && segments[1] === "import" && request.method === "POST") {
    const body = await readJson(request, 2 * 1024 * 1024);
    if (segments[2] === "preview") return json(await peopleImportPreview(body));
    if (segments[2] === "apply") return json(await applyPeopleImport(db, body));
    return methodNotAllowed();
  }
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
