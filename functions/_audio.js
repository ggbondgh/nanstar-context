import {
  cleanId,
  cleanOptionalString,
  cleanString,
  cleanStringList,
  ensureSet,
  intInRange,
  inferTitle,
  json,
  methodNotAllowed,
  newId,
  noContent,
  now,
  parseArray,
  parseJson,
  readJson,
  summarize,
  toBoolInt
} from "./_shared.js";

const RECORDING_STATUSES = new Set(["uploaded", "queued", "validating", "transcribing", "diarizing", "aligning", "review", "analyzing", "proposal_ready", "completed", "failed", "cancelled", "expired", "archived"]);
const PROCESSING_MODES = new Set(["external_ai", "platform_rules", "manual_only"]);
const SOURCE_TYPES = new Set(["upload", "meeting", "import", "manual"]);
const MEETING_TYPES = new Set(["customer", "internal", "project", "support", "other"]);
const PARTICIPANT_STATUSES = new Set(["unknown", "partial", "confirmed"]);
const ATTENDANCE_STATUSES = new Set(["unknown", "present", "absent", "partial"]);
const IDENTIFICATION_METHODS = new Set(["manual", "name_match", "voice_match", "suggested"]);
const TOPIC_TYPES = new Set(["project_progress", "issue", "decision", "requirement", "resource", "schedule", "other"]);
const REVIEW_STATUSES = new Set(["pending", "confirmed", "rejected", "suggested", "edited"]);
const INTERACTION_TYPES = new Set(["meeting", "issue", "support", "decision", "other"]);

function fail(message, status = 400, code = "AUDIO_REQUEST_FAILED") {
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

function safeFileName(value, fallback = "audio") {
  return cleanString(value, 120).replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/[. ]+$/g, "") || fallback;
}

function safeProjectIds(value) {
  return [...new Set(parseArray(value).map((entry) => cleanId(entry)).filter(Boolean))];
}

function speakerFallback(index) {
  const code = 65 + (index % 26);
  const suffix = index >= 26 ? ` ${Math.floor(index / 26) + 1}` : "";
  return `Speaker ${String.fromCharCode(code)}${suffix}`;
}

function parseTimecode(value) {
  const input = cleanString(value, 20);
  if (!input) return null;
  const match = input.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "").padEnd(3, "0") || 0);
  return ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000 + millis;
}

function parseTranscriptText(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const segments = [];
  let current = null;
  let speakerIndex = 0;

  const pushCurrent = () => {
    if (!current || !cleanString(current.text, 20000)) return;
    segments.push({
      ...current,
      text: cleanString(current.text, 20000)
    });
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      if (current) current.text = `${current.text}\n`;
      continue;
    }
    const match = line.match(/^(?:\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]\s*)?([^:：]{1,32})[:：]\s*(.+)$/);
    if (match) {
      pushCurrent();
      current = {
        start_ms: parseTimecode(match[1]),
        end_ms: null,
        speaker_label: cleanString(match[2], 40) || speakerFallback(speakerIndex++),
        person_id: null,
        text: match[3],
        asr_confidence: null,
        language: "",
        is_overlap: 0,
        review_status: "pending"
      };
      continue;
    }
    if (!current) {
      current = {
        start_ms: null,
        end_ms: null,
        speaker_label: speakerFallback(speakerIndex++),
        person_id: null,
        text: line,
        asr_confidence: null,
        language: "",
        is_overlap: 0,
        review_status: "pending"
      };
      continue;
    }
    current.text = `${current.text}\n${line}`;
  }
  pushCurrent();
  return segments.map((segment, index) => ({
    ...segment,
    segment_index: index + 1
  }));
}

function rowAudioRecording(row) {
  if (!row) return null;
  return {
    ...row,
    size_bytes: Number(row.size_bytes || 0),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined || row.duration_ms === "" ? null : Number(row.duration_ms),
    project_id: row.project_id || null,
    requested_model_id: row.requested_model_id || null,
    archived_at: row.archived_at || null,
    file_url: row.id ? `/api/work/audio/${row.id}/file` : ""
  };
}

function rowTranscriptSegment(row) {
  if (!row) return null;
  return {
    ...row,
    start_ms: row.start_ms === null || row.start_ms === undefined || row.start_ms === "" ? null : Number(row.start_ms),
    end_ms: row.end_ms === null || row.end_ms === undefined || row.end_ms === "" ? null : Number(row.end_ms),
    asr_confidence: row.asr_confidence === null || row.asr_confidence === undefined || row.asr_confidence === "" ? null : Number(row.asr_confidence),
    is_overlap: Boolean(Number(row.is_overlap)),
    person_id: row.person_id || null,
    review_status: row.review_status || "pending"
  };
}

function rowMeeting(row) {
  if (!row) return null;
  return {
    ...row,
    selected_project_ids: parseArray(row.selected_project_ids_json),
    selected_project_ids_json: row.selected_project_ids_json || "[]",
    recording_id: row.recording_id || null
  };
}

function rowMeetingParticipant(row) {
  if (!row) return null;
  return {
    ...row,
    person_id: row.person_id || null,
    confidence: row.confidence === null || row.confidence === undefined || row.confidence === "" ? null : Number(row.confidence),
    confirmed_at: row.confirmed_at || null
  };
}

function rowMeetingTopic(row) {
  if (!row) return null;
  return {
    ...row,
    start_ms: row.start_ms === null || row.start_ms === undefined || row.start_ms === "" ? null : Number(row.start_ms),
    end_ms: row.end_ms === null || row.end_ms === undefined || row.end_ms === "" ? null : Number(row.end_ms),
    confidence: row.confidence === null || row.confidence === undefined || row.confidence === "" ? null : Number(row.confidence)
  };
}

function rowInteraction(row) {
  if (!row) return null;
  return {
    ...row,
    occurred_at: Number(row.occurred_at || 0)
  };
}

function normalizeRecordingPayload(body, current = null) {
  return {
    title: body.title === undefined ? current?.title || "" : cleanOptionalString(body.title, 160) || "",
    file_name: body.file_name === undefined ? current?.file_name || "" : cleanOptionalString(body.file_name, 160) || "",
    mime_type: body.mime_type === undefined ? current?.mime_type || "" : cleanOptionalString(body.mime_type, 120) || "",
    size_bytes: body.size_bytes === undefined ? current?.size_bytes || 0 : Math.max(0, Math.round(safeNumber(body.size_bytes, current?.size_bytes || 0))),
    duration_ms: body.duration_ms === undefined ? current?.duration_ms ?? null : safeNumber(body.duration_ms, current?.duration_ms ?? null),
    description: body.description === undefined ? current?.description || "" : cleanOptionalString(body.description, 2000) || "",
    project_id: body.project_id === undefined ? current?.project_id || null : cleanId(body.project_id) || null,
    source_type: body.source_type === undefined ? current?.source_type || "upload" : ensureSet(body.source_type, SOURCE_TYPES, current?.source_type || "upload"),
    processing_mode: body.processing_mode === undefined ? current?.processing_mode || "manual_only" : ensureSet(body.processing_mode, PROCESSING_MODES, current?.processing_mode || "manual_only"),
    requested_model_id: body.requested_model_id === undefined ? current?.requested_model_id || null : cleanId(body.requested_model_id) || null,
    status: body.status === undefined ? current?.status || "uploaded" : ensureSet(body.status, RECORDING_STATUSES, current?.status || "uploaded"),
    language: body.language === undefined ? current?.language || "" : cleanOptionalString(body.language, 40) || "",
    transcript_summary: body.transcript_summary === undefined ? current?.transcript_summary || "" : cleanOptionalString(body.transcript_summary, 4000) || "",
    error_code: body.error_code === undefined ? current?.error_code || "" : cleanOptionalString(body.error_code, 80) || "",
    error_message: body.error_message === undefined ? current?.error_message || "" : cleanOptionalString(body.error_message, 500) || ""
  };
}

function normalizeMeetingPayload(body, current = null, recordingId = "") {
  return {
    recording_id: body.recording_id === undefined ? current?.recording_id || cleanId(recordingId) || null : cleanId(body.recording_id) || null,
    title: body.title === undefined ? current?.title || "" : cleanOptionalString(body.title, 160) || "",
    meeting_date: body.meeting_date === undefined ? current?.meeting_date || null : safeDate(body.meeting_date) || null,
    meeting_type: body.meeting_type === undefined ? current?.meeting_type || "other" : ensureSet(body.meeting_type, MEETING_TYPES, current?.meeting_type || "other"),
    selected_project_ids_json: JSON.stringify(safeProjectIds(body.selected_project_ids_json ?? body.selected_project_ids ?? (current?.selected_project_ids_json || []))),
    participant_status: body.participant_status === undefined ? current?.participant_status || "unknown" : ensureSet(body.participant_status, PARTICIPANT_STATUSES, current?.participant_status || "unknown"),
    summary: body.summary === undefined ? current?.summary || "" : cleanOptionalString(body.summary, 4000) || "",
    status: body.status === undefined ? current?.status || "draft" : ensureSet(body.status, new Set(["draft", "review", "approved", "archived"]), current?.status || "draft")
  };
}

function normalizeParticipantPayload(body, current = null, meetingId = "") {
  return {
    meeting_id: body.meeting_id === undefined ? current?.meeting_id || cleanId(meetingId) || "" : cleanId(body.meeting_id) || "",
    person_id: body.person_id === undefined ? current?.person_id || null : cleanId(body.person_id) || null,
    speaker_label: body.speaker_label === undefined ? current?.speaker_label || "" : cleanOptionalString(body.speaker_label, 40) || "",
    attendance_status: body.attendance_status === undefined ? current?.attendance_status || "unknown" : ensureSet(body.attendance_status, ATTENDANCE_STATUSES, current?.attendance_status || "unknown"),
    identification_method: body.identification_method === undefined ? current?.identification_method || "suggested" : ensureSet(body.identification_method, IDENTIFICATION_METHODS, current?.identification_method || "suggested"),
    confidence: body.confidence === undefined ? confidenceValue(current?.confidence ?? 0.5, 0.5) : confidenceValue(body.confidence, confidenceValue(current?.confidence ?? 0.5, 0.5)),
    confirmed_at: body.confirmed_at === undefined ? current?.confirmed_at || null : body.confirmed_at ? Number(body.confirmed_at) || now() : null
  };
}

function normalizeTopicPayload(body, current = null, meetingId = "") {
  return {
    meeting_id: body.meeting_id === undefined ? current?.meeting_id || cleanId(meetingId) || "" : cleanId(body.meeting_id) || "",
    title: body.title === undefined ? current?.title || "" : cleanOptionalString(body.title, 160) || "",
    summary: body.summary === undefined ? current?.summary || "" : cleanOptionalString(body.summary, 4000) || "",
    start_ms: body.start_ms === undefined ? current?.start_ms ?? null : safeNumber(body.start_ms, current?.start_ms ?? null),
    end_ms: body.end_ms === undefined ? current?.end_ms ?? null : safeNumber(body.end_ms, current?.end_ms ?? null),
    project_id: body.project_id === undefined ? current?.project_id || null : cleanId(body.project_id) || null,
    module_id: body.module_id === undefined ? current?.module_id || null : cleanId(body.module_id) || null,
    topic_type: body.topic_type === undefined ? current?.topic_type || "other" : ensureSet(body.topic_type, TOPIC_TYPES, current?.topic_type || "other"),
    confidence: body.confidence === undefined ? confidenceValue(current?.confidence ?? 0.5, 0.5) : confidenceValue(body.confidence, confidenceValue(current?.confidence ?? 0.5, 0.5)),
    review_status: body.review_status === undefined ? current?.review_status || "pending" : ensureSet(body.review_status, REVIEW_STATUSES, current?.review_status || "pending"),
    sort_order: intInRange(body.sort_order, current?.sort_order ?? 100, 0, 100000)
  };
}

function normalizeSegmentPayload(body, current = null, recordingId = "", fallbackIndex = null) {
  return {
    recording_id: body.recording_id === undefined ? current?.recording_id || cleanId(recordingId) || "" : cleanId(body.recording_id) || "",
    segment_index: body.segment_index === undefined ? current?.segment_index ?? fallbackIndex ?? 1 : intInRange(body.segment_index, current?.segment_index ?? fallbackIndex ?? 1, 1, 100000),
    start_ms: body.start_ms === undefined ? current?.start_ms ?? null : safeNumber(body.start_ms, current?.start_ms ?? null),
    end_ms: body.end_ms === undefined ? current?.end_ms ?? null : safeNumber(body.end_ms, current?.end_ms ?? null),
    speaker_label: body.speaker_label === undefined ? current?.speaker_label || "" : cleanOptionalString(body.speaker_label, 40) || "",
    person_id: body.person_id === undefined ? current?.person_id || null : cleanId(body.person_id) || null,
    text: body.text === undefined ? current?.text || "" : cleanOptionalString(body.text, 20000) || "",
    asr_confidence: body.asr_confidence === undefined ? current?.asr_confidence ?? null : confidenceValue(body.asr_confidence, current?.asr_confidence ?? null),
    language: body.language === undefined ? current?.language || "" : cleanOptionalString(body.language, 40) || "",
    is_overlap: body.is_overlap === undefined ? current?.is_overlap || 0 : toBoolInt(body.is_overlap),
    review_status: body.review_status === undefined ? current?.review_status || "pending" : ensureSet(body.review_status, REVIEW_STATUSES, current?.review_status || "pending")
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
  if (!columns.length) return current;
  await db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...columns.map((column) => payload[column]), now(), clean).run();
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

async function requireRecording(db, id) {
  const recording = await db.prepare("SELECT * FROM audio_recordings WHERE id = ? AND archived_at IS NULL").bind(cleanId(id)).first();
  if (!recording) fail("音频不存在", 404, "NOT_FOUND");
  return recording;
}

async function requireMeeting(db, id) {
  const meeting = await db.prepare("SELECT * FROM meetings WHERE id = ? AND archived_at IS NULL").bind(cleanId(id)).first();
  if (!meeting) fail("会议不存在", 404, "NOT_FOUND");
  return meeting;
}

async function requireSegment(db, id) {
  const segment = await db.prepare("SELECT * FROM audio_transcript_segments WHERE id = ? AND archived_at IS NULL").bind(cleanId(id)).first();
  if (!segment) fail("片段不存在", 404, "NOT_FOUND");
  return segment;
}

async function requireTopic(db, id) {
  const topic = await db.prepare("SELECT * FROM meeting_topics WHERE id = ? AND archived_at IS NULL").bind(cleanId(id)).first();
  if (!topic) fail("主题不存在", 404, "NOT_FOUND");
  return topic;
}

async function requireParticipant(db, id) {
  const participant = await db.prepare("SELECT * FROM meeting_participants WHERE id = ? AND archived_at IS NULL").bind(cleanId(id)).first();
  if (!participant) fail("参与人不存在", 404, "NOT_FOUND");
  return participant;
}

async function listAudioRecordings(db, filters = {}) {
  const where = ["r.archived_at IS NULL"];
  const params = [];
  const query = cleanString(filters.q, 160);
  const status = ensureSet(filters.status, RECORDING_STATUSES, "");
  const projectId = cleanId(filters.project_id);
  const sourceType = ensureSet(filters.source_type, SOURCE_TYPES, "");
  if (projectId) {
    where.push("r.project_id = ?");
    params.push(projectId);
  }
  if (status) {
    where.push("r.status = ?");
    params.push(status);
  }
  if (sourceType) {
    where.push("r.source_type = ?");
    params.push(sourceType);
  }
  if (query) {
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    where.push(`(r.title LIKE ? ESCAPE '\\' OR r.file_name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.transcript_summary LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  const result = await db.prepare(`
    SELECT r.*,
           p.name AS project_name,
           m.id AS meeting_id,
           m.title AS meeting_title,
           m.meeting_date,
           COUNT(DISTINCT s.id) AS segment_count,
           COUNT(DISTINCT mp.id) AS participant_count,
           COUNT(DISTINCT t.id) AS topic_count
      FROM audio_recordings r
      LEFT JOIN work_projects p ON p.id = r.project_id
      LEFT JOIN meetings m ON m.recording_id = r.id AND m.archived_at IS NULL
      LEFT JOIN audio_transcript_segments s ON s.recording_id = r.id AND s.archived_at IS NULL
      LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.archived_at IS NULL
      LEFT JOIN meeting_topics t ON t.meeting_id = m.id AND t.archived_at IS NULL
     WHERE ${where.join(" AND ")}
     GROUP BY r.id
     ORDER BY r.updated_at DESC
     LIMIT 300
  `).bind(...params).all();
  return (result.results || []).map(rowAudioRecording);
}

async function listMeetings(db, filters = {}) {
  const where = ["m.archived_at IS NULL"];
  const params = [];
  const query = cleanString(filters.q, 160);
  const meetingType = ensureSet(filters.meeting_type, MEETING_TYPES, "");
  const status = ensureSet(filters.status, new Set(["draft", "review", "approved", "archived"]), "");
  const projectId = cleanId(filters.project_id);
  if (meetingType) {
    where.push("m.meeting_type = ?");
    params.push(meetingType);
  }
  if (status) {
    where.push("m.status = ?");
    params.push(status);
  }
  if (projectId) {
    where.push(`(m.selected_project_ids_json LIKE ? ESCAPE '\\' OR r.project_id = ?)`);
    params.push(`%${projectId}%`, projectId);
  }
  if (query) {
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    where.push(`(m.title LIKE ? ESCAPE '\\' OR m.summary LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR r.file_name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern);
  }
  const result = await db.prepare(`
    SELECT m.*,
           r.title AS recording_title,
           r.file_name AS recording_file_name,
           r.status AS recording_status,
           r.project_id AS recording_project_id,
           COUNT(DISTINCT mp.id) AS participant_count,
           COUNT(DISTINCT t.id) AS topic_count,
           COUNT(DISTINCT i.id) AS interaction_count
      FROM meetings m
      LEFT JOIN audio_recordings r ON r.id = m.recording_id AND r.archived_at IS NULL
      LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.archived_at IS NULL
      LEFT JOIN meeting_topics t ON t.meeting_id = m.id AND t.archived_at IS NULL
      LEFT JOIN person_interactions i ON i.meeting_id = m.id AND i.archived_at IS NULL
     WHERE ${where.join(" AND ")}
     GROUP BY m.id
     ORDER BY COALESCE(m.meeting_date, '9999-12-31') DESC, m.updated_at DESC
     LIMIT 300
  `).bind(...params).all();
  return (result.results || []).map(rowMeeting);
}

async function meetingDetail(db, id) {
  const clean = cleanId(id);
  const meeting = await db.prepare(`
    SELECT m.*,
           r.id AS recording_id,
           r.title AS recording_title,
           r.file_name AS recording_file_name,
           r.mime_type AS recording_mime_type,
           r.size_bytes AS recording_size_bytes,
           r.duration_ms AS recording_duration_ms,
           r.project_id AS recording_project_id,
           r.status AS recording_status,
           r.processing_mode AS recording_processing_mode,
           r.requested_model_id AS recording_requested_model_id,
           r.language AS recording_language,
           r.transcript_summary AS recording_transcript_summary,
           p.name AS project_name
      FROM meetings m
      LEFT JOIN audio_recordings r ON r.id = m.recording_id
      LEFT JOIN work_projects p ON p.id = r.project_id
     WHERE m.id = ? AND m.archived_at IS NULL
  `).bind(clean).first();
  if (!meeting) fail("会议不存在", 404, "NOT_FOUND");
  const [participants, topics, interactions, segments] = await Promise.all([
    db.prepare(`
      SELECT mp.*, p.display_name AS person_name, p.status AS person_status,
             p.organization_id, o.name AS organization_name, o.short_name AS organization_short_name
        FROM meeting_participants mp
        LEFT JOIN people p ON p.id = mp.person_id
        LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE mp.meeting_id = ? AND mp.archived_at IS NULL
       ORDER BY mp.attendance_status, mp.confidence DESC, mp.created_at
    `).bind(clean).all(),
    db.prepare(`
      SELECT mt.*, p.name AS project_name, m2.name AS module_name
        FROM meeting_topics mt
        LEFT JOIN work_projects p ON p.id = mt.project_id
        LEFT JOIN work_modules m2 ON m2.id = mt.module_id
       WHERE mt.meeting_id = ? AND mt.archived_at IS NULL
       ORDER BY mt.sort_order, COALESCE(mt.start_ms, 9223372036854775807), mt.created_at
    `).bind(clean).all(),
    db.prepare(`
      SELECT i.*, p.display_name AS person_name, pr.name AS project_name, m2.title AS meeting_title
        FROM person_interactions i
        LEFT JOIN people p ON p.id = i.person_id
        LEFT JOIN work_projects pr ON pr.id = i.project_id
        LEFT JOIN meetings m2 ON m2.id = i.meeting_id
       WHERE i.meeting_id = ? AND i.archived_at IS NULL
       ORDER BY i.occurred_at DESC, i.created_at DESC
    `).bind(clean).all(),
    meeting.recording_id ? db.prepare(`
      SELECT s.*, p.display_name AS person_name
        FROM audio_transcript_segments s
        LEFT JOIN people p ON p.id = s.person_id
       WHERE s.recording_id = ? AND s.archived_at IS NULL
       ORDER BY s.segment_index, COALESCE(s.start_ms, 9223372036854775807), s.created_at
    `).bind(meeting.recording_id).all() : Promise.resolve({ results: [] })
  ]);
  return {
    ...rowMeeting(meeting),
    recording: meeting.recording_id ? rowAudioRecording({
      id: meeting.recording_id,
      title: meeting.recording_title,
      file_name: meeting.recording_file_name,
      mime_type: meeting.recording_mime_type,
      size_bytes: meeting.recording_size_bytes,
      duration_ms: meeting.recording_duration_ms,
      status: meeting.recording_status,
      processing_mode: meeting.recording_processing_mode,
      requested_model_id: meeting.recording_requested_model_id,
      language: meeting.recording_language,
      transcript_summary: meeting.recording_transcript_summary,
      project_id: meeting.recording_project_id,
      project_name: meeting.project_name
    }) : null,
    participants: (participants.results || []).map(rowMeetingParticipant),
    topics: (topics.results || []).map(rowMeetingTopic),
    interactions: (interactions.results || []).map(rowInteraction),
    segments: (segments.results || []).map(rowTranscriptSegment)
  };
}

async function recordingDetail(db, id) {
  const recording = await requireRecording(db, id);
  const [meeting, segments, participants, topics, interactions] = await Promise.all([
    db.prepare(`
      SELECT m.*
        FROM meetings m
       WHERE m.recording_id = ? AND m.archived_at IS NULL
    `).bind(recording.id).first(),
    db.prepare(`
      SELECT s.*, p.display_name AS person_name
        FROM audio_transcript_segments s
        LEFT JOIN people p ON p.id = s.person_id
       WHERE s.recording_id = ? AND s.archived_at IS NULL
       ORDER BY s.segment_index, COALESCE(s.start_ms, 9223372036854775807), s.created_at
    `).bind(recording.id).all(),
    db.prepare(`
      SELECT mp.*, p.display_name AS person_name, p.status AS person_status,
             p.organization_id, o.name AS organization_name, o.short_name AS organization_short_name
        FROM meetings m
        JOIN meeting_participants mp ON mp.meeting_id = m.id
        LEFT JOIN people p ON p.id = mp.person_id
        LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE m.recording_id = ? AND mp.archived_at IS NULL
       ORDER BY mp.attendance_status, mp.confidence DESC, mp.created_at
    `).bind(recording.id).all(),
    db.prepare(`
      SELECT mt.*, p.name AS project_name, m2.name AS module_name
        FROM meetings m
        JOIN meeting_topics mt ON mt.meeting_id = m.id
        LEFT JOIN work_projects p ON p.id = mt.project_id
        LEFT JOIN work_modules m2 ON m2.id = mt.module_id
       WHERE m.recording_id = ? AND mt.archived_at IS NULL
       ORDER BY mt.sort_order, COALESCE(mt.start_ms, 9223372036854775807), mt.created_at
    `).bind(recording.id).all(),
    db.prepare(`
      SELECT i.*, p.display_name AS person_name, pr.name AS project_name, m2.title AS meeting_title
        FROM person_interactions i
        LEFT JOIN people p ON p.id = i.person_id
        LEFT JOIN work_projects pr ON pr.id = i.project_id
        LEFT JOIN meetings m2 ON m2.id = i.meeting_id
       WHERE i.meeting_id = (SELECT id FROM meetings WHERE recording_id = ? AND archived_at IS NULL LIMIT 1)
         AND i.archived_at IS NULL
       ORDER BY i.occurred_at DESC, i.created_at DESC
    `).bind(recording.id).all()
  ]);
  return {
    ...rowAudioRecording(recording),
    meeting: rowMeeting(meeting),
    segments: (segments.results || []).map(rowTranscriptSegment),
    participants: (participants.results || []).map(rowMeetingParticipant),
    topics: (topics.results || []).map(rowMeetingTopic),
    interactions: (interactions.results || []).map(rowInteraction)
  };
}

function transcriptTextFromSegments(segments = []) {
  return segments.map((segment) => {
    const label = cleanString(segment.speaker_label, 40) || speakerFallback(Number(segment.segment_index || 1) - 1);
    const stamp = Number.isFinite(Number(segment.start_ms)) ? `[${Math.floor(Number(segment.start_ms) / 60000)}:${String(Math.floor((Number(segment.start_ms) % 60000) / 1000)).padStart(2, "0")}] ` : "";
    return `${stamp}${label}: ${cleanString(segment.text, 20000)}`;
  }).join("\n");
}

async function streamRecordingFile(env, recording, request) {
  if (!env.WORK_AUDIO_FILES) fail("未配置音频存储", 503, "MISSING_AUDIO_BUCKET");
  const object = await env.WORK_AUDIO_FILES.get(recording.storage_key, request.headers.get("range") ? { range: request.headers } : undefined);
  if (!object || !object.body) fail("音频文件不存在", 404, "NOT_FOUND");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-disposition", `inline; filename="${recording.file_name || "audio"}"`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, no-store");
  if (!headers.get("content-type")) headers.set("content-type", recording.mime_type || "application/octet-stream");
  return new Response(object.body, { status: 200, headers });
}

async function createRecordingFromUpload(env, db, request) {
  if (!env.WORK_AUDIO_FILES) fail("未配置音频存储", 503, "MISSING_AUDIO_BUCKET");
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) fail("请选择音频文件", 400, "FIELD_REQUIRED");
  if (!file.size) fail("音频文件不能为空", 400, "FIELD_REQUIRED");
  const projectId = cleanId(form.get("project_id"));
  if (projectId) {
    const project = await db.prepare("SELECT id FROM work_projects WHERE id = ? AND archived_at IS NULL").bind(projectId).first();
    if (!project) fail("项目不存在", 400, "PROJECT_NOT_FOUND");
  }
  const requestedModelId = cleanId(form.get("requested_model_id"));
  if (requestedModelId) {
    const model = await db.prepare("SELECT id FROM ai_models WHERE id = ?").bind(requestedModelId).first();
    if (!model) fail("模型不存在", 400, "MODEL_NOT_FOUND");
  }
  const recordingId = newId("audio");
  const fileName = safeFileName(form.get("file_name") || file.name, "audio");
  const storageKey = `recordings/${recordingId}/${fileName}`;
  const mimeType = cleanString(file.type || form.get("mime_type") || "application/octet-stream", 120);
  await env.WORK_AUDIO_FILES.put(storageKey, file, {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `attachment; filename="${fileName}"`
    },
    customMetadata: {
      recording_id: recordingId,
      file_name: fileName,
      mime_type: mimeType
    }
  });
  const payload = normalizeRecordingPayload({
    title: form.get("title"),
    file_name: fileName,
    mime_type: mimeType,
    size_bytes: file.size,
    duration_ms: form.get("duration_ms"),
    description: form.get("description"),
    project_id: projectId,
    source_type: form.get("source_type"),
    processing_mode: form.get("processing_mode"),
    requested_model_id: requestedModelId,
    status: form.get("status") || "uploaded",
    language: form.get("language"),
    transcript_summary: form.get("transcript_summary"),
    error_code: "",
    error_message: ""
  });
  await db.prepare(`
    INSERT INTO audio_recordings (
      id, title, file_name, storage_key, mime_type, size_bytes, duration_ms, description, project_id,
      source_type, processing_mode, requested_model_id, status, language, transcript_summary, error_code,
      error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    recordingId,
    payload.title || inferTitle(fileName, "音频记录"),
    payload.file_name,
    storageKey,
    payload.mime_type,
    payload.size_bytes,
    payload.duration_ms,
    payload.description,
    payload.project_id,
    payload.source_type,
    payload.processing_mode,
    payload.requested_model_id,
    payload.status,
    payload.language,
    payload.transcript_summary,
    payload.error_code,
    payload.error_message,
    now(),
    now()
  ).run();
  return recordingDetail(db, recordingId);
}

async function replaceRecordingSegments(db, recordingId, segments = []) {
  const clean = cleanId(recordingId);
  const current = await db.prepare("SELECT * FROM audio_recordings WHERE id = ? AND archived_at IS NULL").bind(clean).first();
  if (!current) fail("音频不存在", 404, "NOT_FOUND");
  const existing = await db.prepare("SELECT id FROM audio_transcript_segments WHERE recording_id = ? AND archived_at IS NULL").bind(clean).all();
  const timestamp = now();
  const statements = (existing.results || []).map((row) => db.prepare("UPDATE audio_transcript_segments SET archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, row.id));
  const rows = segments.filter((segment) => cleanString(segment.text, 20000)).map((segment, index) => {
    const normalized = normalizeSegmentPayload(segment, null, clean, index + 1);
    return db.prepare(`
      INSERT INTO audio_transcript_segments (
        id, recording_id, segment_index, start_ms, end_ms, speaker_label, person_id, text, asr_confidence,
        language, is_overlap, review_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("seg"),
      clean,
      index + 1,
      normalized.start_ms,
      normalized.end_ms,
      normalized.speaker_label || speakerFallback(index),
      normalized.person_id,
      normalized.text,
      normalized.asr_confidence,
      normalized.language,
      normalized.is_overlap,
      normalized.review_status,
      timestamp,
      timestamp
    );
  });
  if (statements.length || rows.length) await db.batch([...statements, ...rows]);
}

async function replaceMeetingParticipants(db, meetingId, participants = [], options = {}) {
  const clean = cleanId(meetingId);
  const current = await db.prepare("SELECT * FROM meetings WHERE id = ? AND archived_at IS NULL").bind(clean).first();
  if (!current) fail("会议不存在", 404, "NOT_FOUND");
  const existing = await db.prepare("SELECT id FROM meeting_participants WHERE meeting_id = ? AND archived_at IS NULL").bind(clean).all();
  const timestamp = now();
  const statements = (existing.results || []).map((row) => db.prepare("UPDATE meeting_participants SET archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, row.id));
  const rows = participants.map((participant) => {
    const normalized = normalizeParticipantPayload(participant, null, clean);
    return db.prepare(`
      INSERT INTO meeting_participants (
        id, meeting_id, person_id, speaker_label, attendance_status, identification_method, confidence, confirmed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("mpar"),
      clean,
      normalized.person_id,
      normalized.speaker_label,
      normalized.attendance_status,
      normalized.identification_method,
      normalized.confidence,
      normalized.confirmed_at || null,
      timestamp,
      timestamp
    );
  });
  if (statements.length || rows.length) await db.batch([...statements, ...rows]);
  if (options.participant_status) {
    await db.prepare("UPDATE meetings SET participant_status = ?, updated_at = ? WHERE id = ?")
      .bind(options.participant_status, timestamp, clean).run();
  }
}

async function replaceMeetingTopics(db, meetingId, topics = []) {
  const clean = cleanId(meetingId);
  const current = await db.prepare("SELECT * FROM meetings WHERE id = ? AND archived_at IS NULL").bind(clean).first();
  if (!current) fail("会议不存在", 404, "NOT_FOUND");
  const existing = await db.prepare("SELECT id FROM meeting_topics WHERE meeting_id = ? AND archived_at IS NULL").bind(clean).all();
  const timestamp = now();
  const statements = (existing.results || []).map((row) => db.prepare("UPDATE meeting_topics SET archived_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, row.id));
  const rows = topics.map((topic, index) => {
    const normalized = normalizeTopicPayload(topic, null, clean);
    if (!normalized.title) normalized.title = inferTitle(normalized.summary || topic.title || "会议主题", "会议主题");
    return db.prepare(`
      INSERT INTO meeting_topics (
        id, meeting_id, title, summary, start_ms, end_ms, project_id, module_id, topic_type, confidence,
        review_status, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("mtop"),
      clean,
      normalized.title,
      normalized.summary,
      normalized.start_ms,
      normalized.end_ms,
      normalized.project_id,
      normalized.module_id,
      normalized.topic_type,
      normalized.confidence,
      normalized.review_status,
      normalized.sort_order ?? (index + 1) * 10,
      timestamp,
      timestamp
    );
  });
  if (statements.length || rows.length) await db.batch([...statements, ...rows]);
}

async function syncMeetingInteractions(db, meetingId, topics = []) {
  const clean = cleanId(meetingId);
  const meeting = await db.prepare("SELECT * FROM meetings WHERE id = ? AND archived_at IS NULL").bind(clean).first();
  if (!meeting) return;
  const participants = await db.prepare(`
    SELECT mp.*, p.display_name
      FROM meeting_participants mp
      LEFT JOIN people p ON p.id = mp.person_id
     WHERE mp.meeting_id = ? AND mp.archived_at IS NULL AND mp.person_id IS NOT NULL
     ORDER BY mp.confidence DESC, mp.created_at
  `).bind(clean).all();
  const confirmedPeople = (participants.results || []).map((row) => row.person_id).filter(Boolean);
  const timestamp = now();
  await db.prepare("UPDATE person_interactions SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL")
    .bind(timestamp, timestamp, clean).run();
  if (!confirmedPeople.length) return;
  const summary = cleanString(meeting.summary || topics.map((topic) => topic.summary || topic.title).filter(Boolean).join(" "), 1000) || `会议记录：${cleanString(meeting.title || "未命名会议", 120)}`;
  const statements = confirmedPeople.slice(0, 12).map((personId) => db.prepare(`
    INSERT INTO person_interactions (
      id, person_id, project_id, meeting_id, interaction_type, summary, occurred_at, source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("minter"),
    personId,
    null,
    clean,
    "meeting",
    summary,
    meeting.meeting_date ? Number(new Date(`${meeting.meeting_date}T12:00:00Z`)) : timestamp,
    clean,
    timestamp,
    timestamp
  ));
  if (statements.length) await db.batch(statements);
}

function derivedFacts(meeting) {
  const topics = meeting?.topics || [];
  return topics.map((topic) => ({
    title: topic.title,
    content: topic.summary || topic.title,
    topic_type: topic.topic_type,
    project_id: topic.project_id || null,
    module_id: topic.module_id || null,
    start_ms: topic.start_ms || null,
    end_ms: topic.end_ms || null,
    review_status: topic.review_status || "pending"
  }));
}

function derivedActions(meeting) {
  const topics = meeting?.topics || [];
  return topics
    .filter((topic) => ["issue", "schedule", "requirement", "resource"].includes(topic.topic_type) || /待办|需要|尽快|跟进|安排|处理/.test(`${topic.title} ${topic.summary}`))
    .map((topic) => ({
      title: topic.title,
      content: topic.summary || topic.title,
      project_id: topic.project_id || null,
      module_id: topic.module_id || null,
      topic_type: topic.topic_type,
      start_ms: topic.start_ms || null,
      end_ms: topic.end_ms || null
    }));
}

function derivedProposals(meeting) {
  const facts = derivedFacts(meeting);
  return facts.map((fact) => ({
    action: fact.topic_type === "decision" ? "status_change" : "update",
    field_name: fact.topic_type,
    proposed_value: fact.content,
    reason: `来源：${meeting?.title || "会议"}`,
    project_id: fact.project_id,
    module_id: fact.module_id,
    evidence: { start_ms: fact.start_ms, end_ms: fact.end_ms }
  }));
}

async function recordingTranscriptApi(db, request, segments, url) {
  const recording = await requireRecording(db, segments[1]);
  if (segments.length === 3 && request.method === "GET") {
    const detail = await recordingDetail(db, recording.id);
    return json({
      transcript_segments: detail.segments || [],
      transcript_text: transcriptTextFromSegments(detail.segments || []),
      recording: detail
    });
  }
  if (segments.length === 4 && segments[3] === "segments" && request.method === "POST") {
    const body = await readJson(request);
    const current = await db.prepare("SELECT COALESCE(MAX(segment_index), 0) AS max_index FROM audio_transcript_segments WHERE recording_id = ? AND archived_at IS NULL")
      .bind(recording.id).first();
    const payload = normalizeSegmentPayload(body, null, recording.id, Number(current?.max_index || 0) + 1);
    if (!payload.text) fail("转写内容不能为空", 400, "FIELD_REQUIRED");
    const id = await insertRow(db, "audio_transcript_segments", payload, "seg");
    return json({ transcript_segment: rowTranscriptSegment(await db.prepare("SELECT * FROM audio_transcript_segments WHERE id = ?").bind(id).first()) }, 201);
  }
  return methodNotAllowed();
}

async function processRecording(db, recording, body = {}, options = {}) {
  const current = recording || await requireRecording(db, body.recording_id);
  const meetingProvided = body.meeting && typeof body.meeting === "object" ? body.meeting : {};
  const transcriptText = cleanString(body.transcript_text, 120000);
  const segmentInput = Array.isArray(body.segments) ? body.segments : [];
  const parsedSegments = segmentInput.length ? segmentInput : transcriptText ? parseTranscriptText(transcriptText) : [];
  const segments = parsedSegments.map((segment, index) => normalizeSegmentPayload(segment, null, current.id, index + 1));
  const selectedProjectIds = safeProjectIds(body.selected_project_ids ?? body.selected_project_ids_json ?? meetingProvided.selected_project_ids ?? meetingProvided.selected_project_ids_json ?? []);
  const meetingCurrent = current.id
    ? await db.prepare("SELECT * FROM meetings WHERE recording_id = ? AND archived_at IS NULL").bind(current.id).first()
    : null;
  const meetingPayload = normalizeMeetingPayload({
    recording_id: current.id,
    title: meetingProvided.title || body.meeting_title || current.title || inferTitle(transcriptText || current.file_name, "会议记录"),
    meeting_date: meetingProvided.meeting_date || body.meeting_date || null,
    meeting_type: meetingProvided.meeting_type || body.meeting_type || "other",
    selected_project_ids_json: selectedProjectIds,
    participant_status: meetingProvided.participant_status || body.participant_status || (body.confirm_participants ? "confirmed" : "unknown"),
    summary: meetingProvided.summary || body.summary || summarize(transcriptText || segments.map((segment) => segment.text).join("\n"), 1200),
    status: meetingProvided.status || body.meeting_status || "review"
  }, meetingCurrent, current.id);
  if (meetingCurrent) {
    await db.prepare(`
      UPDATE meetings SET recording_id = ?, title = ?, meeting_date = ?, meeting_type = ?, selected_project_ids_json = ?,
                          participant_status = ?, summary = ?, status = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      current.id,
      meetingPayload.title,
      meetingPayload.meeting_date,
      meetingPayload.meeting_type,
      meetingPayload.selected_project_ids_json,
      meetingPayload.participant_status,
      meetingPayload.summary,
      meetingPayload.status,
      now(),
      meetingCurrent.id
    ).run();
  } else {
    const meetingId = newId("meet");
    const timestamp = now();
    await db.prepare(`
      INSERT INTO meetings (
        id, recording_id, title, meeting_date, meeting_type, selected_project_ids_json, participant_status, summary, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      meetingId,
      current.id,
      meetingPayload.title,
      meetingPayload.meeting_date,
      meetingPayload.meeting_type,
      meetingPayload.selected_project_ids_json,
      meetingPayload.participant_status,
      meetingPayload.summary,
      meetingPayload.status,
      timestamp,
      timestamp
    ).run();
  }
  const meeting = await db.prepare("SELECT * FROM meetings WHERE recording_id = ? AND archived_at IS NULL").bind(current.id).first();
  if (segments.length) await replaceRecordingSegments(db, current.id, segments);
  if (Array.isArray(body.participants)) {
    await replaceMeetingParticipants(db, meeting.id, body.participants, { participant_status: body.confirm_participants ? "confirmed" : meetingPayload.participant_status });
  } else {
    const derivedParticipants = (segments.length ? [...new Set(segments.map((segment) => cleanString(segment.speaker_label, 40)).filter(Boolean))] : [])
      .map((speakerLabel) => ({
        speaker_label: speakerLabel,
        attendance_status: "unknown",
        identification_method: "suggested",
        confidence: 0.5,
        person_id: null,
        confirmed_at: null
      }));
    if (derivedParticipants.length && !meetingProvided.participants && !body.participants) {
      await replaceMeetingParticipants(db, meeting.id, derivedParticipants, { participant_status: meetingPayload.participant_status });
    }
  }
  const topics = Array.isArray(body.topics) ? body.topics : [];
  const derivedTopics = topics.length ? topics : [
    {
      title: inferTitle(meetingPayload.summary || transcriptText || current.title || current.file_name, "会议摘要"),
      summary: meetingPayload.summary || summarize(transcriptText || current.transcript_summary || current.file_name, 1200),
      project_id: selectedProjectIds[0] || current.project_id || null,
      module_id: null,
      topic_type: selectedProjectIds.length ? "project_progress" : "other",
      confidence: 0.6,
      review_status: "pending",
      start_ms: null,
      end_ms: null,
      sort_order: 10
    }
  ];
  await replaceMeetingTopics(db, meeting.id, derivedTopics);
  const refreshedTopics = await db.prepare("SELECT * FROM meeting_topics WHERE meeting_id = ? AND archived_at IS NULL ORDER BY sort_order, created_at").bind(meeting.id).all();
  await syncMeetingInteractions(db, meeting.id, (refreshedTopics.results || []).map(rowMeetingTopic));
  const recordingUpdate = normalizeRecordingPayload({
    title: body.title || current.title,
    description: body.description === undefined ? current.description : body.description,
    project_id: body.project_id === undefined ? current.project_id : body.project_id,
    source_type: body.source_type === undefined ? current.source_type : body.source_type,
    processing_mode: body.processing_mode === undefined ? current.processing_mode : body.processing_mode,
    requested_model_id: body.requested_model_id === undefined ? current.requested_model_id : body.requested_model_id,
    status: body.status === undefined ? (options.retry ? "review" : "review") : body.status,
    language: body.language === undefined ? current.language : body.language,
    transcript_summary: meetingPayload.summary || current.transcript_summary,
    error_code: "",
    error_message: ""
  }, current);
  await db.prepare(`
    UPDATE audio_recordings SET title = ?, description = ?, project_id = ?, source_type = ?, processing_mode = ?,
                               requested_model_id = ?, status = ?, language = ?, transcript_summary = ?,
                               error_code = ?, error_message = ?, updated_at = ?
     WHERE id = ?
  `).bind(
    recordingUpdate.title || current.title,
    recordingUpdate.description,
    recordingUpdate.project_id,
    recordingUpdate.source_type,
    recordingUpdate.processing_mode,
    recordingUpdate.requested_model_id,
    recordingUpdate.status,
    recordingUpdate.language,
    recordingUpdate.transcript_summary,
    recordingUpdate.error_code,
    recordingUpdate.error_message,
    now(),
    current.id
  ).run();
  if (body.keep_audio === false) {
    await db.prepare("UPDATE audio_recordings SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), current.id).run();
  }
  return recordingDetail(db, current.id);
}

async function createRecordingMeeting(db, request, segments, url) {
  const recording = await requireRecording(db, segments[1]);
  if (segments.length === 3 && segments[2] === "analyze" && request.method === "POST") {
    const body = await readJson(request);
    return json({ recording: await processRecording(db, recording, body) });
  }
  if (segments.length === 3 && ["process", "retry"].includes(segments[2]) && request.method === "POST") {
    const body = await readJson(request);
    return json({ recording: await processRecording(db, recording, body, { retry: segments[2] === "retry" }) });
  }
  if (segments.length === 3 && segments[2] === "cancel" && request.method === "POST") {
    await db.prepare("UPDATE audio_recordings SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(now(), recording.id).run();
    return json({ recording: await recordingDetail(db, recording.id) });
  }
  return methodNotAllowed();
}

async function audioApi(env, db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({
      recordings: await listAudioRecordings(db, {
        q: url.searchParams.get("q"),
        status: url.searchParams.get("status"),
        project_id: url.searchParams.get("project_id"),
        source_type: url.searchParams.get("source_type")
      })
    });
  }
  if (segments.length === 2 && segments[1] === "upload" && request.method === "POST") {
    return json({ recording: await createRecordingFromUpload(env, db, request) }, 201);
  }
  if (segments.length === 2 && request.method === "GET") {
    return json({ recording: await recordingDetail(db, segments[1]) });
  }
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await requireRecording(db, segments[1]);
    const body = await readJson(request);
    const payload = normalizeRecordingPayload(body, current);
    if (payload.project_id) {
      const project = await db.prepare("SELECT id FROM work_projects WHERE id = ? AND archived_at IS NULL").bind(payload.project_id).first();
      if (!project) fail("项目不存在", 400, "PROJECT_NOT_FOUND");
    }
    if (payload.requested_model_id) {
      const model = await db.prepare("SELECT id FROM ai_models WHERE id = ?").bind(payload.requested_model_id).first();
      if (!model) fail("模型不存在", 400, "MODEL_NOT_FOUND");
    }
    await db.prepare(`
      UPDATE audio_recordings SET title = ?, file_name = ?, mime_type = ?, size_bytes = ?, duration_ms = ?, description = ?,
                                 project_id = ?, source_type = ?, processing_mode = ?, requested_model_id = ?,
                                 status = ?, language = ?, transcript_summary = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.title,
      payload.file_name,
      payload.mime_type,
      payload.size_bytes,
      payload.duration_ms,
      payload.description,
      payload.project_id,
      payload.source_type,
      payload.processing_mode,
      payload.requested_model_id,
      payload.status,
      payload.language,
      payload.transcript_summary,
      payload.error_code,
      payload.error_message,
      now(),
      current.id
    ).run();
    return json({ recording: await recordingDetail(db, current.id) });
  }
  if (segments.length === 3 && segments[2] === "file" && request.method === "GET") {
    const recording = await requireRecording(db, segments[1]);
    return streamRecordingFile(env, recording, request);
  }
  if (segments.length === 3 && segments[2] === "transcript" && request.method === "GET") {
    const detail = await recordingDetail(db, segments[1]);
    return json({
      transcript_segments: detail.segments || [],
      transcript_text: transcriptTextFromSegments(detail.segments || []),
      recording: detail
    });
  }
  if (segments.length === 4 && segments[2] === "transcript" && segments[3] === "segments" && request.method === "POST") {
    const recording = await requireRecording(db, segments[1]);
    const body = await readJson(request);
    const current = await db.prepare("SELECT COALESCE(MAX(segment_index), 0) AS max_index FROM audio_transcript_segments WHERE recording_id = ? AND archived_at IS NULL")
      .bind(recording.id).first();
    const payload = normalizeSegmentPayload(body, null, recording.id, Number(current?.max_index || 0) + 1);
    if (!payload.text) fail("转写内容不能为空", 400, "FIELD_REQUIRED");
    const id = await insertRow(db, "audio_transcript_segments", payload, "seg");
    return json({ transcript_segment: rowTranscriptSegment(await db.prepare("SELECT * FROM audio_transcript_segments WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 3 && ["process", "retry", "cancel", "analyze"].includes(segments[2])) {
    return createRecordingMeeting(db, request, segments);
  }
  if (segments.length === 2 && request.method === "DELETE") {
    const recording = await requireRecording(db, segments[1]);
    const timestamp = now();
    const meeting = await db.prepare("SELECT * FROM meetings WHERE recording_id = ? AND archived_at IS NULL").bind(recording.id).first();
    await db.batch([
      db.prepare("UPDATE audio_recordings SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?").bind(timestamp, timestamp, recording.id),
      db.prepare("UPDATE audio_transcript_segments SET archived_at = ?, updated_at = ? WHERE recording_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, recording.id),
      meeting ? db.prepare("UPDATE meetings SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?").bind(timestamp, timestamp, meeting.id) : db.prepare("SELECT 1"),
      meeting ? db.prepare("UPDATE meeting_participants SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id) : db.prepare("SELECT 1"),
      meeting ? db.prepare("UPDATE meeting_topics SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id) : db.prepare("SELECT 1"),
      meeting ? db.prepare("UPDATE person_interactions SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id) : db.prepare("SELECT 1")
    ].filter(Boolean));
    if (env.WORK_AUDIO_FILES) {
      await env.WORK_AUDIO_FILES.delete(recording.storage_key);
    }
    return noContent();
  }
  return methodNotAllowed();
}

async function meetingsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    return json({
      meetings: await listMeetings(db, {
        q: url.searchParams.get("q"),
        meeting_type: url.searchParams.get("meeting_type"),
        status: url.searchParams.get("status"),
        project_id: url.searchParams.get("project_id")
      })
    });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const payload = normalizeMeetingPayload(body, null, body.recording_id || "");
    if (!payload.title) payload.title = inferTitle(payload.summary || "", "会议");
    const recordingId = cleanId(payload.recording_id);
    if (recordingId) {
      const recording = await db.prepare("SELECT id FROM audio_recordings WHERE id = ? AND archived_at IS NULL").bind(recordingId).first();
      if (!recording) fail("音频不存在", 400, "RECORDING_NOT_FOUND");
      const exists = await db.prepare("SELECT id FROM meetings WHERE recording_id = ? AND archived_at IS NULL").bind(recordingId).first();
      if (exists) fail("该音频已绑定会议", 409, "MEETING_ALREADY_EXISTS");
    }
    const id = newId("meet");
    const timestamp = now();
    await db.prepare(`
      INSERT INTO meetings (
        id, recording_id, title, meeting_date, meeting_type, selected_project_ids_json, participant_status, summary, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      payload.recording_id || null,
      payload.title,
      payload.meeting_date,
      payload.meeting_type,
      payload.selected_project_ids_json,
      payload.participant_status,
      payload.summary,
      payload.status,
      timestamp,
      timestamp
    ).run();
    return json({ meeting: rowMeeting(await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 2) {
    const meeting = await requireMeeting(db, segments[1]);
    if (request.method === "GET") return json({ meeting: await meetingDetail(db, meeting.id) });
    if (request.method === "PATCH") {
      const body = await readJson(request);
      const payload = normalizeMeetingPayload(body, meeting, meeting.recording_id || "");
      if (payload.recording_id) {
        const recording = await db.prepare("SELECT id FROM audio_recordings WHERE id = ? AND archived_at IS NULL").bind(payload.recording_id).first();
        if (!recording) fail("音频不存在", 400, "RECORDING_NOT_FOUND");
      }
      await db.prepare(`
        UPDATE meetings SET recording_id = ?, title = ?, meeting_date = ?, meeting_type = ?, selected_project_ids_json = ?,
                            participant_status = ?, summary = ?, status = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        payload.recording_id || null,
        payload.title,
        payload.meeting_date,
        payload.meeting_type,
        payload.selected_project_ids_json,
        payload.participant_status,
        payload.summary,
        payload.status,
        now(),
        meeting.id
      ).run();
      return json({ meeting: await meetingDetail(db, meeting.id) });
    }
    if (request.method === "DELETE") {
      const timestamp = now();
      await db.batch([
        db.prepare("UPDATE meetings SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?").bind(timestamp, timestamp, meeting.id),
        db.prepare("UPDATE meeting_participants SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id),
        db.prepare("UPDATE meeting_topics SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id),
        db.prepare("UPDATE person_interactions SET archived_at = ?, updated_at = ? WHERE meeting_id = ? AND archived_at IS NULL").bind(timestamp, timestamp, meeting.id)
      ]);
      return noContent();
    }
  }
  if (segments.length === 3 && segments[2] === "participants" && request.method === "GET") {
    const meeting = await requireMeeting(db, segments[1]);
    const rows = await db.prepare(`
      SELECT mp.*, p.display_name AS person_name, p.status AS person_status, p.organization_id,
             o.name AS organization_name, o.short_name AS organization_short_name
        FROM meeting_participants mp
        LEFT JOIN people p ON p.id = mp.person_id
        LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE mp.meeting_id = ? AND mp.archived_at IS NULL
       ORDER BY mp.attendance_status, mp.confidence DESC, mp.created_at
    `).bind(meeting.id).all();
    return json({ participants: (rows.results || []).map(rowMeetingParticipant) });
  }
  if (segments.length === 3 && segments[2] === "participants" && request.method === "POST") {
    const meeting = await requireMeeting(db, segments[1]);
    const body = await readJson(request);
    const payload = normalizeParticipantPayload(body, null, meeting.id);
    if (payload.person_id) {
      const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(payload.person_id).first();
      if (!person) fail("人员不存在", 400, "PERSON_NOT_FOUND");
    }
    const id = await insertRow(db, "meeting_participants", payload, "mpar");
    return json({ participant: rowMeetingParticipant(await db.prepare("SELECT * FROM meeting_participants WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 3 && segments[2] === "topics" && request.method === "GET") {
    const meeting = await requireMeeting(db, segments[1]);
    const rows = await db.prepare(`
      SELECT mt.*, p.name AS project_name, m2.name AS module_name
        FROM meeting_topics mt
        LEFT JOIN work_projects p ON p.id = mt.project_id
        LEFT JOIN work_modules m2 ON m2.id = mt.module_id
       WHERE mt.meeting_id = ? AND mt.archived_at IS NULL
       ORDER BY mt.sort_order, COALESCE(mt.start_ms, 9223372036854775807), mt.created_at
    `).bind(meeting.id).all();
    return json({ topics: (rows.results || []).map(rowMeetingTopic) });
  }
  if (segments.length === 3 && segments[2] === "topics" && request.method === "POST") {
    const meeting = await requireMeeting(db, segments[1]);
    const body = await readJson(request);
    const payload = normalizeTopicPayload(body, null, meeting.id);
    if (!payload.title) fail("主题名称不能为空", 400, "FIELD_REQUIRED");
    const id = await insertRow(db, "meeting_topics", payload, "mtop");
    return json({ topic: rowMeetingTopic(await db.prepare("SELECT * FROM meeting_topics WHERE id = ?").bind(id).first()) }, 201);
  }
  if (segments.length === 3 && segments[2] === "facts" && request.method === "GET") {
    const meeting = await meetingDetail(db, segments[1]);
    return json({ facts: derivedFacts(meeting) });
  }
  if (segments.length === 3 && segments[2] === "actions" && request.method === "GET") {
    const meeting = await meetingDetail(db, segments[1]);
    return json({ actions: derivedActions(meeting) });
  }
  if (segments.length === 3 && segments[2] === "proposals" && request.method === "GET") {
    const meeting = await meetingDetail(db, segments[1]);
    return json({ proposals: derivedProposals(meeting) });
  }
  if (segments.length === 3 && segments[2] === "confirm-participants" && request.method === "POST") {
    const meeting = await requireMeeting(db, segments[1]);
    const body = await readJson(request);
    const participantIds = new Set(parseArray(body.participant_ids).map((entry) => cleanId(entry)).filter(Boolean));
    const rows = await db.prepare("SELECT * FROM meeting_participants WHERE meeting_id = ? AND archived_at IS NULL").bind(meeting.id).all();
    const timestamp = now();
    const statements = [];
    for (const row of rows.results || []) {
      const confirmed = participantIds.size ? participantIds.has(row.id) : Boolean(row.person_id);
      statements.push(db.prepare(`
        UPDATE meeting_participants SET attendance_status = ?, identification_method = ?, confidence = ?, confirmed_at = ?, updated_at = ?
         WHERE id = ?
      `).bind(
        confirmed ? "present" : row.attendance_status,
        row.identification_method || "manual",
        row.confidence ?? 0.6,
        confirmed ? timestamp : row.confirmed_at,
        timestamp,
        row.id
      ));
    }
    statements.push(db.prepare("UPDATE meetings SET participant_status = 'confirmed', updated_at = ? WHERE id = ?").bind(timestamp, meeting.id));
    if (statements.length) await db.batch(statements);
    return json({ meeting: await meetingDetail(db, meeting.id) });
  }
  if (segments.length === 3 && segments[2] === "analyze" && request.method === "POST") {
    const body = await readJson(request);
    const meeting = await requireMeeting(db, segments[1]);
    const detail = await meetingDetail(db, meeting.id);
    const transcriptText = transcriptTextFromSegments(detail.segments || []);
    const summary = cleanString(body.summary || detail.summary || summarize(transcriptText, 1200), 4000) || inferTitle(transcriptText || detail.title || "会议摘要", "会议摘要");
    const topics = Array.isArray(body.topics) && body.topics.length ? body.topics : (detail.topics || []).length ? detail.topics : [
      {
        title: inferTitle(summary || detail.title || "会议摘要", "会议摘要"),
        summary,
        project_id: detail.selected_project_ids?.[0] || null,
        module_id: null,
        topic_type: detail.selected_project_ids?.length ? "project_progress" : "other",
        confidence: 0.6,
        review_status: "pending",
        sort_order: 10
      }
    ];
    await db.prepare("UPDATE meetings SET summary = ?, status = 'review', updated_at = ? WHERE id = ?").bind(summary, now(), meeting.id).run();
    await replaceMeetingTopics(db, meeting.id, topics);
    if (Array.isArray(body.participants)) {
      await replaceMeetingParticipants(db, meeting.id, body.participants, { participant_status: "partial" });
    }
    const refreshedTopics = await db.prepare("SELECT * FROM meeting_topics WHERE meeting_id = ? AND archived_at IS NULL ORDER BY sort_order, created_at").bind(meeting.id).all();
    await syncMeetingInteractions(db, meeting.id, (refreshedTopics.results || []).map(rowMeetingTopic));
    return json({ meeting: await meetingDetail(db, meeting.id) });
  }
  return methodNotAllowed();
}

async function transcriptSegmentsApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await requireSegment(db, segments[1]);
  if (request.method === "GET") return json({ transcript_segment: rowTranscriptSegment(current) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeSegmentPayload(body, current, current.recording_id, current.segment_index);
    if (payload.person_id) {
      const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(payload.person_id).first();
      if (!person) fail("人员不存在", 400, "PERSON_NOT_FOUND");
    }
    await db.prepare(`
      UPDATE audio_transcript_segments SET recording_id = ?, segment_index = ?, start_ms = ?, end_ms = ?, speaker_label = ?,
                                          person_id = ?, text = ?, asr_confidence = ?, language = ?, is_overlap = ?,
                                          review_status = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.recording_id,
      payload.segment_index,
      payload.start_ms,
      payload.end_ms,
      payload.speaker_label,
      payload.person_id,
      payload.text,
      payload.asr_confidence,
      payload.language,
      payload.is_overlap,
      payload.review_status,
      now(),
      current.id
    ).run();
    return json({ transcript_segment: rowTranscriptSegment(await db.prepare("SELECT * FROM audio_transcript_segments WHERE id = ?").bind(current.id).first()) });
  }
  if (request.method === "DELETE") {
    await archiveRow(db, "audio_transcript_segments", current.id);
    return noContent();
  }
  return methodNotAllowed();
}

async function meetingTopicsApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await requireTopic(db, segments[1]);
  if (request.method === "GET") return json({ topic: rowMeetingTopic(current) });
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeTopicPayload(body, current, current.meeting_id);
    if (payload.project_id) {
      const project = await db.prepare("SELECT id FROM work_projects WHERE id = ? AND archived_at IS NULL").bind(payload.project_id).first();
      if (!project) fail("项目不存在", 400, "PROJECT_NOT_FOUND");
    }
    if (payload.module_id) {
      const module = await db.prepare("SELECT id FROM work_modules WHERE id = ? AND archived_at IS NULL").bind(payload.module_id).first();
      if (!module) fail("模块不存在", 400, "MODULE_NOT_FOUND");
    }
    await db.prepare(`
      UPDATE meeting_topics SET meeting_id = ?, title = ?, summary = ?, start_ms = ?, end_ms = ?, project_id = ?,
                               module_id = ?, topic_type = ?, confidence = ?, review_status = ?, sort_order = ?,
                               updated_at = ?
       WHERE id = ?
    `).bind(
      payload.meeting_id,
      payload.title,
      payload.summary,
      payload.start_ms,
      payload.end_ms,
      payload.project_id,
      payload.module_id,
      payload.topic_type,
      payload.confidence,
      payload.review_status,
      payload.sort_order,
      now(),
      current.id
    ).run();
    return json({ topic: rowMeetingTopic(await db.prepare("SELECT * FROM meeting_topics WHERE id = ?").bind(current.id).first()) });
  }
  if (request.method === "DELETE") {
    await archiveRow(db, "meeting_topics", current.id);
    return noContent();
  }
  return methodNotAllowed();
}

async function speakerApi(db, request, segments) {
  if (segments.length !== 2) return methodNotAllowed();
  const current = await requireParticipant(db, segments[1]);
  if (request.method === "PATCH") {
    const body = await readJson(request);
    const payload = normalizeParticipantPayload(body, current, current.meeting_id);
    if (payload.person_id) {
      const person = await db.prepare("SELECT id FROM people WHERE id = ? AND archived_at IS NULL").bind(payload.person_id).first();
      if (!person) fail("人员不存在", 400, "PERSON_NOT_FOUND");
    }
    await db.prepare(`
      UPDATE meeting_participants SET meeting_id = ?, person_id = ?, speaker_label = ?, attendance_status = ?,
                                      identification_method = ?, confidence = ?, confirmed_at = ?, updated_at = ?
       WHERE id = ?
    `).bind(
      payload.meeting_id,
      payload.person_id,
      payload.speaker_label,
      payload.attendance_status,
      payload.identification_method,
      payload.confidence,
      payload.confirmed_at,
      now(),
      current.id
    ).run();
    return json({ participant: rowMeetingParticipant(await db.prepare("SELECT * FROM meeting_participants WHERE id = ?").bind(current.id).first()) });
  }
  if (request.method === "DELETE") {
    await archiveRow(db, "meeting_participants", current.id);
    return noContent();
  }
  return methodNotAllowed();
}

export {
  audioApi,
  recordingDetail,
  listAudioRecordings,
  listMeetings,
  meetingDetail,
  meetingsApi,
  meetingTopicsApi,
  speakerApi,
  transcriptSegmentsApi
};
