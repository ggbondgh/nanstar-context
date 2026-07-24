const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  view: location.hash.slice(1) || "dashboard",
  title: "工作台",
  dashboard: null,
  categories: [],
  documents: [],
  blocks: [],
  selectedDocument: null,
  captures: [],
  proposals: [],
  selectedProposal: null,
  settings: { providers: [], models: [], routes: [], runs: [] },
  settingsTab: "providers",
  contextPreview: null,
  contextSelection: { category_ids: [], document_ids: [], block_ids: [], statuses: ["current"] },
  contextMode: "full"
};

state.workTab = "today";
state.work = {
  projects: [],
  modules: [],
  items: [],
  milestones: [],
  daily_logs: [],
  proposals: [],
  views: {},
  filters: { query: "", status: "", projectId: "", itemType: "", logState: "" },
  selectedProjectId: "",
  selectedProject: null,
  selectedModuleId: "",
  selectedModule: null,
  selectedItemId: "",
  selectedItem: null,
  selectedMilestoneId: "",
  selectedMilestone: null,
  selectedLogId: "",
  selectedLog: null,
  selectedProposal: null
};
state.peopleTab = "people";
state.people = {
  organizations: [],
  people: [],
  suggestions: [],
  filters: { q: "", organizationId: "", status: "", roleType: "", expertise: "" },
  selectedOrganizationId: "",
  selectedOrganization: null,
  selectedPersonId: "",
  selectedPerson: null
};
state.audioTab = "recordings";
state.audio = {
  recordings: [],
  meetings: [],
  filters: { q: "", status: "", projectId: "", sourceType: "", meetingType: "" },
  selectedRecordingId: "",
  selectedRecording: null,
  selectedMeetingId: "",
  selectedMeeting: null
};

const STALE_ANALYZING_MS = 10 * 60 * 1000;

const VIEW_TITLES = { dashboard: "工作台", captures: "收集箱", review: "待审核", library: "知识库", context: "上下文生成", settings: "设置", people: "人员中心", audio: "音频中心" };
VIEW_TITLES.work = "工作";
const PROVIDER_PRESETS = {
  deepseek: { label: "DeepSeek", name: "DeepSeek", base_url: "https://api.deepseek.com" },
  volcengine: { label: "火山方舟", name: "火山方舟", base_url: "https://ark.cn-beijing.volces.com/api/v3" },
  openai_compatible: { label: "OpenAI 兼容", name: "OpenAI 兼容服务", base_url: "https://api.openai.com/v1" },
  cloudflare_ai: { label: "Workers AI", name: "Cloudflare Workers AI", base_url: "" }
};

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function uid(value) { return String(value || "").replace(/[^a-zA-Z0-9_-]/g, ""); }
function providerPreset(type) { return PROVIDER_PRESETS[type] || PROVIDER_PRESETS.openai_compatible; }
function providerTypeOptions(selected = "deepseek") { return Object.entries(PROVIDER_PRESETS).map(([type, preset]) => `<option value="${type}" ${type === selected ? "selected" : ""}>${esc(preset.label)}</option>`).join(""); }
function modelDisplayName(modelId) {
  const aliases = { api: "API", chat: "Chat", claude: "Claude", code: "Code", coder: "Coder", deepseek: "DeepSeek", doubao: "Doubao", ernie: "ERNIE", flash: "Flash", glm: "GLM", gpt: "GPT", instruct: "Instruct", json: "JSON", kimi: "Kimi", llama: "Llama", llm: "LLM", max: "Max", mini: "Mini", mistral: "Mistral", moonshot: "Moonshot", opus: "Opus", pro: "Pro", qwen: "Qwen", reasoning: "Reasoning", reasoner: "Reasoner", sonnet: "Sonnet", thinking: "Thinking", turbo: "Turbo", yi: "Yi" };
  const label = String(modelId || "").replace(/^@/, "").split(/[/:._-]+/).filter(Boolean).map((part) => aliases[part.toLowerCase()] || (/^[a-z]?\d+(\.\d+)?[a-z]?$/i.test(part) || /^[a-z]+\d+[a-z0-9]*$/i.test(part) ? part.toUpperCase() : part.slice(0, 1).toUpperCase() + part.slice(1))).join(" ");
  return label || modelId || "";
}
function fmtTime(value) { if (!value) return "未记录"; const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? "未记录" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function fmtDate(value) { if (!value) return "未设置"; const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? "未设置" : date.toLocaleDateString("zh-CN"); }
function fmtLatency(value) { const ms = Number(value); if (!Number.isFinite(ms) || ms <= 0) return ""; return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }
function fmtElapsedSince(value) { const elapsed = Math.max(0, Date.now() - Number(value || 0)); if (elapsed < 60000) return "刚刚"; const minutes = Math.floor(elapsed / 60000); if (minutes < 60) return `${minutes} 分钟`; return `${Math.floor(minutes / 60)} 小时`; }
function todayDateString(timeZone = "Asia/Shanghai") { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function statusLabel(value) { return ({ current: "当前", historical: "历史", archived: "归档", draft: "草稿", analyzing: "整理中", review: "待审核", approved: "已通过", partial: "部分处理", rejected: "已拒绝", failed: "失败", pending: "待处理", edited: "已编辑", accepted: "已接受", succeeded: "成功", running: "请求中", healthy: "正常", error: "异常" }[value] || value || "未知"); }
function statusBadge(value) { return `<span class="status-badge ${esc(value)}">${esc(statusLabel(value))}</span>`; }
function captureModeLabel(value) { return value === "external_ai" ? "外部 AI" : value === "platform_rules" ? "本地规则" : "手动"; }
function isStaleCapture(item) { return item?.state === "analyzing" && Date.now() - Number(item.updated_at || 0) > STALE_ANALYZING_MS; }
function aiErrorMessage(code, message) {
  if (message) return message;
  return ({ AI_TIMEOUT: "单次模型请求超过设置的总超时", AI_NETWORK_ERROR: "Cloudflare 到服务商没有成功完成请求", AI_OUTPUT_INVALID_JSON: "模型返回内容不是平台要求的结构化 JSON", AI_AUTH_FAILED: "服务商 API Key 无效或无权限", AI_RATE_LIMITED: "服务商限流或额度不足", AI_STALE_ANALYZING: "整理请求长时间没有完成，可能已被运行时中断" }[code] || code || "未记录错误原因");
}
function aiRunName(providerName, modelName) { return [providerName, modelName].filter(Boolean).join(" / "); }
function proposalSourceLabel(proposal) {
  if (proposal?.classification?.source === "web_ai_assist") return "网页 AI 辅助";
  if (proposal?.provider_name) return proposal.provider_name;
  if (proposal?.capture_state === "failed") return "整理失败";
  if (proposal?.classification?.mode === "manual_only") return "完全手动";
  return "平台本地规则";
}
function proposalModelLabel(proposal) {
  if (proposal?.classification?.source === "web_ai_assist") return "网页版 AI";
  return proposal?.model_name || "无外部模型";
}
function latestRunSummary(item) {
  if (item.latest_run_status) {
    const pieces = [`AI ${statusLabel(item.latest_run_status)}`];
    const name = aiRunName(item.latest_run_provider_name, item.latest_run_model_name);
    if (name) pieces.push(name);
    if (item.latest_run_attempt_no) pieces.push(`第 ${item.latest_run_attempt_no} 次`);
    if (item.latest_run_status === "running" && item.latest_run_created_at) pieces.push(`已等待 ${fmtElapsedSince(item.latest_run_created_at)}`);
    if (item.latest_run_latency_ms) pieces.push(`耗时 ${fmtLatency(item.latest_run_latency_ms)}`);
    if (item.latest_run_error_code || item.latest_run_error_message) pieces.push(`原因：${aiErrorMessage(item.latest_run_error_code, item.latest_run_error_message)}`);
    return pieces.join(" · ");
  }
  if (item.state === "analyzing") return isStaleCapture(item) ? "超过 10 分钟没有完成记录，可能已中断，可重试" : "正在等待外部 AI 返回；中转站排队和模型思考都会计入超时";
  if (item.state === "failed" && item.error_message) return `失败原因：${item.error_message}`;
  return "";
}
function icon(name) { return `<i data-lucide="${esc(name)}"></i>`; }
function renderIcons() { if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } }); }
function markdown(value) {
  const source = String(value || "");
  if (!source) return `<p class="helper-text">暂无正文</p>`;
  try { return window.DOMPurify.sanitize(window.marked.parse(source)); } catch { return `<p>${esc(source)}</p>`; }
}

function workStatusLabel(value) {
  return ({
    active: "进行中",
    paused: "暂停",
    completed: "已完成",
    archived: "已归档",
    planning: "规划中",
    development: "开发中",
    integration: "集成中",
    debugging: "联调中",
    testing: "测试中",
    delivery: "交付中",
    not_started: "未开始",
    in_progress: "进行中",
    waiting_customer: "等客户",
    waiting_internal: "等内部",
    verifying: "验证中",
    blocked: "阻塞",
    done: "已完成",
    planned: "已计划",
    at_risk: "有风险",
    cancelled: "已取消",
    draft: "草稿"
  }[value] || statusLabel(value));
}
function workPriorityLabel(value) { return ({ low: "低", normal: "中", high: "高", urgent: "紧急" }[value] || value || "中"); }
function workItemTypeLabel(value) { return ({ task: "任务", issue: "问题", requirement: "需求", milestone: "里程碑", follow_up: "跟进" }[value] || value || "任务"); }
function workModeLabel(value) { return ({ external_ai: "外部 AI", platform_rules: "平台规则", manual_only: "手工" }[value] || value || "平台规则"); }
function workTabLabel(value) { return ({ today: "今日进展", projects: "项目总览", modules: "模块进度", items: "任务与问题", logs: "输出中心" }[value] || value || "工作"); }
function organizationTypeLabel(value) { return ({ customer: "客户", internal: "内部", partner: "伙伴", other: "其他" }[value] || value || "其他"); }
function personStatusLabel(value) { return ({ active: "在职", inactive: "停用", unknown: "未知" }[value] || value || "未知"); }
function roleTypeLabel(value) { return ({ customer: "客户", fae: "FAE", ae: "AE", rd: "RD", pm: "PM", tester: "测试", other: "其他" }[value] || value || "其他"); }
function expertiseLevelLabel(value) { return ({ unknown: "未知", familiar: "熟悉", strong: "熟练", specialist: "专家" }[value] || value || "未知"); }
function relationshipTypeLabel(value) { return ({ customer_contact: "客户联系人", fae: "FAE", ae: "AE", rd: "RD", project_owner: "项目负责人", tester: "测试", supporter: "支持", other: "其他" }[value] || value || "其他"); }
function workItemRelationLabel(value) { return ({ owner: "负责人", assignee: "执行人", requester: "发起人", reviewer: "审核人", mentioned: "提及", supporter: "支持", waiting_on: "等待中" }[value] || value || "提及"); }
function interactionTypeLabel(value) { return ({ meeting: "会议", issue: "问题", support: "支持", decision: "决策", other: "其他" }[value] || value || "其他"); }
function recordingStatusLabel(value) { return ({ uploaded: "已上传", queued: "排队中", validating: "校验中", transcribing: "转写中", diarizing: "分离说话人", aligning: "对齐中", review: "待审核", analyzing: "分析中", proposal_ready: "待提案", completed: "已完成", failed: "失败", cancelled: "已取消", expired: "已过期", archived: "已归档" }[value] || value || "已上传"); }
function meetingTypeLabel(value) { return ({ customer: "客户", internal: "内部", project: "项目", support: "支持", other: "其他" }[value] || value || "其他"); }
function attendanceStatusLabel(value) { return ({ unknown: "未知", present: "到场", absent: "缺席", partial: "部分" }[value] || value || "未知"); }
function identificationMethodLabel(value) { return ({ manual: "手动", name_match: "姓名匹配", voice_match: "声纹匹配", suggested: "建议" }[value] || value || "建议"); }
function topicTypeLabel(value) { return ({ project_progress: "项目进展", issue: "问题", decision: "决策", requirement: "需求", resource: "资源", schedule: "计划", other: "其他" }[value] || value || "其他"); }
function reviewStatusLabel(value) { return ({ pending: "待处理", confirmed: "已确认", rejected: "已拒绝", suggested: "建议", edited: "已编辑" }[value] || value || "待处理"); }

function toast(message, type = "ok") {
  const region = $("#toastRegion");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(type === "error" ? "circle-alert" : "check-circle-2")}<span>${esc(message)}</span>`;
  region.append(node); renderIcons();
  window.setTimeout(() => node.remove(), 3600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`/api/${path}`, { credentials: "include", ...options, headers, body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body) });
  let payload = null;
  if (response.status !== 204) {
    try { payload = await response.json(); } catch { payload = { error: await response.text() }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    error.status = response.status; error.code = payload?.code || "REQUEST_FAILED"; throw error;
  }
  return payload;
}

function handleError(error) {
  if (error?.status === 401) { showLogin(); return; }
  toast(error?.message || "操作失败", "error");
}

function showLogin() {
  $("#appShell").hidden = true; $("#loginScreen").hidden = false; $("#loginToken").focus();
}

function showApp() { $("#loginScreen").hidden = true; $("#appShell").hidden = false; }

function setView(view) {
  state.view = VIEW_TITLES[view] ? view : "dashboard";
  state.title = VIEW_TITLES[state.view];
  if (location.hash !== `#${state.view}`) history.replaceState(null, "", `#${state.view}`);
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("#pageTitle").textContent = state.title;
  $("#sidebar").classList.remove("open");
  render();
  if (state.view === "work") syncWorkViewSelection().catch(handleError);
  if (state.view === "people") syncPeopleViewSelection().catch(handleError);
  if (state.view === "audio") syncAudioViewSelection().catch(handleError);
}

async function loadCategories() { state.categories = (await api("categories")).categories || []; }
async function loadDashboard() { state.dashboard = await api("dashboard"); updateCounts(); }
async function loadDocuments() { state.documents = (await api("documents")).documents || []; }
async function loadBlocks() { state.blocks = (await api("blocks")).blocks || []; }
async function loadCaptures() { state.captures = (await api("captures")).captures || []; updateCounts(); }
async function loadProposals() { state.proposals = (await api("proposals?status=pending")).proposals || []; updateCounts(); }
async function loadSettings() {
  const [providers, models, routes, runs] = await Promise.all([api("settings/ai/providers"), api("settings/ai/models"), api("settings/ai/routes"), api("settings/ai/runs?limit=40")]);
  state.settings = { providers: providers.providers || [], models: models.models || [], routes: routes.routes || [], runs: runs.runs || [], encryption_configured: providers.encryption_configured, workers_ai_bound: providers.workers_ai_bound };
}
async function loadWork() {
  const work = await api("work");
  state.work = {
    ...(state.work || {}),
    projects: work.projects || [],
    modules: work.modules || [],
    items: work.items || [],
    milestones: work.milestones || [],
    daily_logs: work.daily_logs || [],
    proposals: work.proposals || [],
    views: work.views || {}
  };
}
async function loadPeople() {
  const filters = state.people?.filters || {};
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.organizationId) params.set("organization_id", filters.organizationId);
  if (filters.status) params.set("status", filters.status);
  if (filters.roleType) params.set("role_type", filters.roleType);
  if (filters.expertise) params.set("expertise", filters.expertise);
  const result = await api(`people${params.toString() ? `?${params.toString()}` : ""}`);
  state.people = {
    ...(state.people || {}),
    organizations: result.organizations || [],
    people: result.people || [],
    suggestions: result.suggestions || []
  };
}
async function loadAudio() {
  const filters = state.audio?.filters || {};
  const recordingsParams = new URLSearchParams();
  if (filters.q) recordingsParams.set("q", filters.q);
  if (filters.status) recordingsParams.set("status", filters.status);
  if (filters.projectId) recordingsParams.set("project_id", filters.projectId);
  if (filters.sourceType) recordingsParams.set("source_type", filters.sourceType);
  const meetingsParams = new URLSearchParams();
  if (filters.q) meetingsParams.set("q", filters.q);
  if (filters.status) meetingsParams.set("status", filters.status);
  if (filters.projectId) meetingsParams.set("project_id", filters.projectId);
  if (filters.meetingType) meetingsParams.set("meeting_type", filters.meetingType);
  const [recordings, meetings] = await Promise.all([
    api(`work/audio${recordingsParams.toString() ? `?${recordingsParams.toString()}` : ""}`),
    api(`work/meetings${meetingsParams.toString() ? `?${meetingsParams.toString()}` : ""}`)
  ]);
  state.audio = {
    ...(state.audio || {}),
    recordings: recordings.recordings || [],
    meetings: meetings.meetings || []
  };
}
async function loadCore() { await Promise.all([loadCategories(), loadDashboard(), loadDocuments(), loadBlocks(), loadCaptures(), loadProposals(), loadWork(), loadPeople(), loadAudio()]); updateCounts(); }
function updateCounts() {
  const pending = state.proposals.reduce((total, item) => total + Number(item.pending_operations || 0), 0);
  const pendingNode = $("#navPendingCount"); pendingNode.textContent = pending; pendingNode.hidden = pending < 1;
  const captureNode = $("#navReviewCount"); captureNode.textContent = state.captures.filter((item) => item.state === "review").length; captureNode.hidden = captureNode.textContent === "0";
}

function proposalHasPendingWork(proposal) {
  return (proposal?.operations || []).some((operation) => ["pending", "edited"].includes(operation.status));
}

async function refreshReviewState(proposalId = "", nextProposal = null) {
  await Promise.all([loadDashboard(), loadCaptures(), loadProposals(), loadDocuments(), loadBlocks()]);
  const stillListed = proposalId && state.proposals.some((proposal) => proposal.id === proposalId);
  if (nextProposal && stillListed && proposalHasPendingWork(nextProposal)) {
    state.selectedProposal = nextProposal;
  } else if (stillListed) {
    state.selectedProposal = (await api(`proposals/${proposalId}`)).proposal;
  } else {
    state.selectedProposal = null;
  }
  updateCounts();
}

async function refreshKnowledgeState(documentId = "") {
  await Promise.all([loadDashboard(), loadDocuments(), loadBlocks()]);
  if (documentId) {
    state.selectedDocument = state.documents.some((doc) => doc.id === documentId)
      ? (await api(`documents/${documentId}`)).document
      : null;
  }
  updateCounts();
}

function categoryOptions(selected = "", includeAuto = true) {
  const rows = state.categories.filter((item) => !item.deleted_at).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  return `${includeAuto ? `<option value="">自动判断</option>` : ""}${rows.map((row) => `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(row.parent_id ? `　${row.name}` : row.name)}</option>`).join("")}`;
}

function render() {
  const root = $("#viewRoot");
  root.innerHTML = ({ dashboard: renderDashboard, captures: renderCaptures, review: renderReview, library: renderLibrary, work: renderWork, people: renderPeople, audio: renderAudio, context: renderContext, settings: renderSettings }[state.view] || renderDashboard)();
  renderIcons();
  bindView();
}

function renderDashboard() {
  const counts = state.dashboard?.counts || {};
  const recent = state.dashboard?.recent_documents || [];
  const failures = state.dashboard?.recent_failures || [];
  const defaultModel = state.dashboard?.default_model;
  return `<div class="view-head"><div><h1>工作台</h1><p>把今天的想法整理成可维护的长期资料。</p></div><div class="view-actions"><button class="button" data-action="goto" data-view-target="library">${icon("library")}浏览知识库</button><button class="button button-secondary" data-action="goto" data-view-target="review">${icon("clipboard-check")}打开审核</button></div></div>
    <div class="stat-grid"><div class="stat"><span class="stat-label">待审核操作</span><strong class="stat-value accent">${esc(counts.pending_review || 0)}</strong></div><div class="stat"><span class="stat-label">知识块总数</span><strong class="stat-value">${esc(counts.blocks || 0)}</strong></div><div class="stat"><span class="stat-label">当前资料</span><strong class="stat-value green">${esc(counts.current || 0)}</strong></div><div class="stat"><span class="stat-label">历史资料</span><strong class="stat-value amber">${esc(counts.historical || 0)}</strong></div></div>
    <div class="dashboard-grid"><section class="panel pad capture-panel"><div class="panel-title"><div><h2>快速收集</h2><p>原始输入会先保存，再按选定模式生成待审核提案。</p></div>${icon("pen-line")}</div><form id="captureForm"><label class="field"><span class="sr-only">原始输入</span><textarea name="raw_text" required maxlength="120000" placeholder="粘贴一段工作、生活、经历、习惯或计划……"></textarea></label><div class="capture-options"><label class="field"><span>处理模式</span><select name="processing_mode"><option value="external_ai">外部 AI</option><option value="platform_rules">平台本地规则</option><option value="manual_only">完全手动</option></select></label><label class="field"><span>目标分类</span><select name="preferred_category_id">${categoryOptions()}</select></label><label class="field"><span>指定模型</span><select name="requested_model_id" id="captureModelOptions"><option value="">自动选择</option>${state.settings.models.map((model) => `<option value="${esc(model.id)}">${esc(model.display_name || model.model_id)}</option>`).join("")}</select></label></div><div class="capture-submit-row"><span class="helper-text" id="capturePrivacyNote">外部 AI 模式会把本次输入和少量候选资料发送给已配置的服务商。</span><div class="capture-actions"><button class="button" type="button" data-action="web-ai-assist">${icon("copy")}网页 AI 辅助</button><button class="button button-primary" type="submit">${icon("sparkles")}保存并整理</button></div></div></form></section><div class="dashboard-side"><section class="panel pad model-card"><div class="panel-title"><div><h3>当前整理模型</h3><p>来自 AI 路由设置</p></div>${icon("cpu")}</div>${defaultModel ? `<div class="model-state"><span class="status-dot ${defaultModel.health_status === "error" ? "error" : "ok"}"></span><div><strong>${esc(defaultModel.display_name || defaultModel.model_id)}</strong><small>${esc(defaultModel.provider_name || "未命名服务商")}</small></div></div>` : `<div class="empty"><div><strong>尚未配置模型</strong><p>本地规则和完全手动仍可使用。</p></div></div>`}</section><section class="panel"><div class="panel-title" style="padding:18px 18px 12px"><div><h3>最近更新</h3><p>正式知识库中的最新文档</p></div><button class="icon-button" data-action="goto" data-view-target="library" aria-label="查看全部" title="查看全部">${icon("arrow-up-right")}</button></div>${recent.length ? `<div class="list">${recent.map((doc) => `<div class="list-row"><div class="list-main"><strong>${esc(doc.title)}</strong><small>${esc(doc.category_name || "未分类")} · ${fmtTime(doc.updated_at)}</small></div>${statusBadge(doc.status)}</div>`).join("")}</div>` : empty("inbox", "还没有正式文档", "从上面的快速收集开始")}</section></div></div>${failures.length ? `<section class="panel" style="margin-top:18px"><div class="panel-title" style="padding:18px"><div><h3>最近失败</h3><p>原始输入仍然保留，可以在收集箱重试。</p></div></div><div class="list">${failures.map((item) => `<div class="list-row"><div class="list-main"><strong>${esc(item.raw_text)}</strong><small>${esc(item.error_code || "整理失败")} · ${fmtTime(item.updated_at)}</small></div><button class="button button-small" data-action="capture-detail" data-id="${esc(item.id)}">查看</button></div>`).join("")}</div></section>` : ""}`;
}

function empty(iconName, title, copy) { return `<div class="empty">${icon(iconName)}<div><strong>${esc(title)}</strong><p>${esc(copy)}</p></div></div>`; }

function renderCaptures() {
  return `<div class="view-head"><div><h1>收集箱</h1><p>原始输入、整理状态和失败任务。</p></div><div class="view-actions"><button class="button button-primary" data-action="goto" data-view-target="dashboard">${icon("plus")}新建收集</button></div></div><div class="toolbar"><div class="search">${icon("search")}<input id="captureSearch" placeholder="搜索原始输入" /></div><select id="captureStateFilter" aria-label="按状态筛选"><option value="">全部状态</option>${["draft", "analyzing", "review", "approved", "partial", "rejected", "failed"].map((item) => `<option value="${item}">${statusLabel(item)}</option>`).join("")}</select></div><section class="panel"><div id="captureList" class="list">${captureRows(state.captures)}</div></section>`;
}
function captureRows(rows) {
  return rows.length ? rows.map((item) => {
    const runLine = latestRunSummary(item);
    const stale = isStaleCapture(item);
    return `<div class="list-row ${stale ? "stale" : ""}" data-action="capture-detail" data-id="${esc(item.id)}"><div class="list-main"><strong>${esc(item.raw_text || "未命名输入")}</strong><small>${esc(item.category_name || "自动分类")} · ${fmtTime(item.updated_at)} · ${Number(item.proposal_count || 0)} 项提案</small>${runLine ? `<small class="ai-run-line">${esc(runLine)}</small>` : ""}</div><div class="list-meta">${statusBadge(item.state)}${stale ? `<span class="tag warning">可重试</span>` : ""}<span class="tag">${esc(captureModeLabel(item.processing_mode))}</span></div></div>`;
  }).join("") : empty("inbox", "收集箱是空的", "输入一段资料后，它会出现在这里");
}

function renderReview() {
  const proposal = state.selectedProposal;
  return `<div class="view-head"><div><h1>待审核</h1><p>长期资料只会在你确认后发生变化。</p></div><div class="view-actions"><button class="button" data-action="refresh-review">${icon("refresh-cw")}刷新</button>${proposal ? `<button class="button button-primary" data-action="apply-proposal" data-id="${esc(proposal.id)}">${icon("check-check")}接受全部</button><button class="button button-danger" data-action="reject-proposal" data-id="${esc(proposal.id)}">${icon("x")}全部拒绝</button>` : ""}</div></div><div class="review-layout"><section class="review-list">${state.proposals.length ? state.proposals.map((item) => `<div class="list-row ${proposal?.id === item.id ? "active" : ""}" data-action="proposal-detail" data-id="${esc(item.id)}"><div class="list-main"><strong>${esc(item.cleaned_text || item.raw_text || "未命名提案")}</strong><small>${esc(proposalSourceLabel(item))} · ${fmtTime(item.updated_at)}</small></div><div class="list-meta"><span class="tag">${esc(item.pending_operations || 0)} 项</span></div></div>`).join("") : empty("clipboard-check", "没有待审核提案", "新的整理结果会出现在这里")}</section>${proposal ? renderProposalDetail(proposal) : `<section class="panel">${empty("mouse-pointer-2", "选择一条提案", "查看原始输入、建议和冲突")}</section>`}</div>`;
}
function renderProposalDetail(proposal) {
  const pending = (proposal.operations || []).filter((op) => ["pending", "edited"].includes(op.status));
  return `<section class="review-detail"><div class="panel pad"><div class="panel-title"><div><h2>提案审核</h2><p>${esc(proposalSourceLabel(proposal))} · ${esc(proposalModelLabel(proposal))} · ${fmtTime(proposal.created_at)}</p></div>${statusBadge(proposal.status)}</div><div class="proposal-summary" style="margin-top:18px"><div class="info-list"><div class="info-row"><span>输入模式</span><strong>${esc(proposal.capture?.processing_mode === "external_ai" ? "外部 AI" : proposal.capture?.processing_mode === "platform_rules" ? "平台本地规则" : "完全手动")}</strong></div><div class="info-row"><span>输入长度</span><strong>${esc((proposal.capture?.raw_text || "").length)} 字符</strong></div><div class="info-row"><span>调用用量</span><strong>${proposal.output_tokens ? `${esc(proposal.input_tokens || 0)} / ${esc(proposal.output_tokens)} tokens` : "未调用外部模型"}</strong></div></div><div class="info-list"><div class="info-row"><span>提案来源</span><strong>${esc(proposalSourceLabel(proposal))}</strong></div><div class="info-row"><span>提案操作</span><strong>${esc(proposal.operations?.length || 0)} 项</strong></div><div class="info-row"><span>冲突</span><strong>${esc((proposal.conflicts || []).length)} 项</strong></div><div class="info-row"><span>待处理</span><strong>${esc(pending.length)} 项</strong></div></div></div></div><div class="compare-grid"><div class="compare-pane"><div class="compare-label">原始输入</div><div class="compare-content">${esc(proposal.capture?.raw_text || "")}</div></div><div class="compare-pane"><div class="compare-label">整理后的完整表达</div><div class="compare-content">${esc(proposal.cleaned_text || "")}</div></div></div>${(proposal.conflicts || []).length ? `<div class="warning-box">${icon("triangle-alert")}<span>${esc((proposal.conflicts || []).join("；"))}</span></div>` : ""}<div class="operation-stack">${(proposal.operations || []).map(renderOperation).join("")}</div></section>`;
}
function renderOperation(operation) {
  const body = operation.proposed_body_md || "";
  const current = operation.current_body_md || "暂无现有正文";
  const canReview = ["pending", "edited"].includes(operation.status);
  return `<article class="operation-card ${operation.conflict ? "conflict" : ""}"><div class="operation-card-head"><div><h3>${esc(operation.proposed_title || operation.proposed_heading || "未命名操作")}</h3><p>${esc(operation.action)} · ${esc(operation.target_category_name || "待选择分类")} ${operation.target_document_title ? `· ${esc(operation.target_document_title)}` : ""}</p></div>${statusBadge(operation.status)}</div><div class="operation-card-body"><div class="compare-grid"><div class="compare-pane"><div class="compare-label">修改前</div><div class="compare-content">${esc(current)}</div></div><div class="compare-pane"><div class="compare-label">建议内容</div><div class="compare-content">${esc(body || "此操作只改变状态或位置")}</div></div></div><p class="helper-text" style="margin-top:12px">${esc(operation.reason || "未填写原因")}</p>${canReview ? `<div class="operation-actions"><button class="button button-small" data-action="edit-operation" data-id="${esc(operation.id)}">${icon("pencil")}编辑</button><button class="button button-small button-danger" data-action="reject-operation" data-id="${esc(operation.id)}">${icon("x")}拒绝</button><button class="button button-small button-primary" data-action="apply-operation" data-proposal="${esc(operation.proposal_id)}" data-id="${esc(operation.id)}">${icon("check")}接受</button></div>` : ""}</div></article>`;
}

function workProjectMap() {
  return new Map((state.work.projects || []).map((project) => [project.id, project]));
}
function workModuleMap() {
  return new Map((state.work.modules || []).map((module) => [module.id, module]));
}
function workItemMap() {
  return new Map((state.work.items || []).map((item) => [item.id, item]));
}
function workMilestoneMap() {
  return new Map((state.work.milestones || []).map((milestone) => [milestone.id, milestone]));
}
function workLogMap() {
  return new Map((state.work.daily_logs || []).map((log) => [log.id, log]));
}
function workProjectName(id) { return workProjectMap().get(id)?.name || id || "未选项目"; }
function workModuleName(id) { return workModuleMap().get(id)?.name || id || "未选模块"; }
function workItemTitle(id) { return workItemMap().get(id)?.title || id || "未选任务"; }
function workMilestoneTitle(id) { return workMilestoneMap().get(id)?.title || id || "未选里程碑"; }
function workPersonName(id) { return (state.people?.people || []).find((person) => person.id === id)?.display_name || id || "未知人员"; }
function workOrganizationName(id) { return (state.people?.organizations || []).find((organization) => organization.id === id)?.name || id || "未知组织"; }
function workSelectedProjectIds(log) { return Array.isArray(log?.selected_project_ids) ? log.selected_project_ids.filter(Boolean) : []; }
function workSelectedProjectNames(log) { return workSelectedProjectIds(log).map((id) => workProjectName(id)); }
function workFilters() { state.work.filters ||= { query: "", status: "", projectId: "", itemType: "", logState: "" }; return state.work.filters; }
function workContextProjectId() { return state.work.selectedProjectId || workFilters().projectId || ""; }
function peopleFilters() { state.people.filters ||= { q: "", organizationId: "", status: "", roleType: "", expertise: "" }; return state.people.filters; }
function audioFilters() { state.audio.filters ||= { q: "", status: "", projectId: "", sourceType: "", meetingType: "" }; return state.audio.filters; }
function workTextExcerpt(value, length = 120) {
  const textValue = String(value || "").replace(/\s+/g, " ").trim();
  if (!textValue) return "";
  return textValue.length > length ? `${textValue.slice(0, length)}...` : textValue;
}
function workRow(action, id, active, main, meta = "", extra = "") {
  return `<div class="list-row ${active ? "active" : ""} ${extra}" data-action="${action}" data-id="${esc(id)}">${main}<div class="list-meta">${meta}</div></div>`;
}
function workDetailShell(title, subtitle, actions, body) {
  return `<section class="panel work-detail"><div class="panel-title"><div><h2>${esc(title)}</h2><p>${esc(subtitle || "")}</p></div><div class="view-actions">${actions || ""}</div></div>${body}</section>`;
}
function workMiniGrid(items = []) {
  return `<div class="work-mini-grid">${items.map((item) => `<div class="work-mini"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join("")}</div>`;
}
function workProjectScopeChips(log) {
  const ids = workSelectedProjectIds(log);
  return ids.length ? ids.map((id) => `<span class="tag">${esc(workProjectName(id))}</span>`).join("") : `<span class="helper-text">未选择项目</span>`;
}
function workDailyCopyText(log, mode = "concise") {
  const projectNames = workSelectedProjectNames(log);
  const draft = log?.draft || {};
  const progress = workTextExcerpt(draft.progress_text || log?.cleaned_text || log?.raw_text || "", 240);
  const detail = draft.detail_text || "";
  const nextAction = draft.next_action_text || "";
  const events = Array.isArray(log?.events) ? log.events : [];
  const proposals = Array.isArray(log?.proposals) ? log.proposals : [];
  if (mode === "bullet") {
    const eventLines = events.length
      ? events.slice(0, 8).map((event) => {
          const scope = [event.project_name, event.module_name, event.item_title].filter(Boolean).join(" / ");
          return `- ${scope ? `${scope}：` : ""}${event.content}`;
        }).join("\n")
      : progress ? `- ${progress}` : "- 暂无内容";
    return [
      `今日要点：${log?.work_date || ""}`,
      eventLines,
      nextAction ? `\n下一步：${nextAction}` : "",
      projectNames.length ? `\n关联项目：${projectNames.join("、")}` : ""
    ].filter(Boolean).join("\n");
  }
  if (mode === "detail") {
    return [
      `今日进展：${progress || "暂无"}`,
      detail ? `\n详细说明：${detail}` : "",
      nextAction ? `\n下一步：${nextAction}` : "",
      projectNames.length ? `\n关联项目：${projectNames.join("、")}` : "",
      proposals.length ? `\n提案数量：${proposals.length}` : ""
    ].filter(Boolean).join("\n");
  }
  return [
    `今日进展：${progress || "暂无"}`,
    nextAction ? `下一步：${nextAction}` : "",
    projectNames.length ? `关联项目：${projectNames.join("、")}` : ""
  ].filter(Boolean).join("\n");
}
function renderWork() {
  const tab = state.workTab || "today";
  const projects = state.work.projects || [];
  const modules = state.work.modules || [];
  const items = state.work.items || [];
  const logs = state.work.daily_logs || [];
  const openItems = items.filter((item) => !["done", "archived"].includes(item.status));
  const filters = workFilters();
  const tabs = ["today", "projects", "modules", "items", "logs"];
  return `<div class="view-head work-head"><div><h1>${esc(workTabLabel(tab))}</h1><p>项目、模块、任务和日报统一放在同一个页面里，方便随时补录、审核和导出。</p></div><div class="view-actions"><button class="button button-secondary" data-action="work-project-new">${icon("folder-plus")}新建项目</button><button class="button button-primary" data-action="work-log-new">${icon("calendar-plus")}新建日报</button></div></div><div class="stat-grid work-stat-grid"><div class="stat"><span class="stat-label">项目</span><strong class="stat-value accent">${esc(projects.length)}</strong></div><div class="stat"><span class="stat-label">模块</span><strong class="stat-value">${esc(modules.length)}</strong></div><div class="stat"><span class="stat-label">未完成任务</span><strong class="stat-value green">${esc(openItems.length)}</strong></div><div class="stat"><span class="stat-label">日报</span><strong class="stat-value amber">${esc(logs.length)}</strong></div></div><nav class="work-tabs">${tabs.map((item) => `<button class="work-tab ${tab === item ? "active" : ""}" data-action="work-tab" data-tab="${item}">${esc(workTabLabel(item))}${item === "projects" ? `<span>${esc(projects.length)}</span>` : item === "modules" ? `<span>${esc(modules.length)}</span>` : item === "items" ? `<span>${esc(items.length)}</span>` : item === "logs" ? `<span>${esc(logs.length)}</span>` : ""}</button>`).join("")}</nav>${tab === "today" ? renderWorkTodayTab(filters) : tab === "projects" ? renderWorkProjectsTab(filters) : tab === "modules" ? renderWorkModulesTab(filters) : tab === "items" ? renderWorkItemsTab(filters) : renderWorkLogsTab(filters)}</div>`;
}
function renderWorkTodayTab() {
  const latestLog = state.work.selectedLog || state.work.daily_logs?.[0] || null;
  const selectedIds = new Set(workSelectedProjectIds(latestLog));
  const fallbackIds = new Set(state.work.selectedProjectId ? [state.work.selectedProjectId] : (state.work.projects || []).slice(0, 3).map((project) => project.id));
  const projectRows = (state.work.projects || []).filter((project) => !project.archived_at).map((project) => {
    const checked = selectedIds.size ? selectedIds.has(project.id) : fallbackIds.has(project.id);
    return `<label class="check-item"><input type="checkbox" name="selected_project_ids" value="${esc(project.id)}" ${checked ? "checked" : ""} /><span>${esc(project.name)}${project.customer_name ? ` / ${esc(project.customer_name)}` : ""}</span></label>`;
  }).join("") || `<div class="empty compact">${icon("folder-open")}<div><strong>暂无项目</strong><p>先创建一个项目，再开始记录日报。</p></div></div>`;
  const modelOptions = state.settings.models.filter((model) => model.enabled !== false).map((model) => `<option value="${esc(model.id)}" ${model.id === (latestLog?.requested_model_id || "") ? "selected" : ""}>${esc(model.display_name || model.model_id)}</option>`).join("");
  const outputButtons = latestLog ? `<div class="work-output-actions"><button class="button button-small" data-action="work-copy-daily" data-format="concise" data-id="${esc(latestLog.id)}">${icon("copy")}简洁版</button><button class="button button-small" data-action="work-copy-daily" data-format="detail" data-id="${esc(latestLog.id)}">${icon("file-text")}详细版</button><button class="button button-small" data-action="work-copy-daily" data-format="bullet" data-id="${esc(latestLog.id)}">${icon("list")}要点版</button><button class="button button-small" data-action="work-copy-daily" data-format="plain" data-id="${esc(latestLog.id)}">${icon("copy-check")}纯文本</button></div>` : "";
  return `<div class="work-today-grid"><section class="panel pad"><div class="panel-title"><div><h2>今日进展</h2><p>先记录口语化工作内容，再生成日报草稿和项目更新提案。</p></div>${icon("calendar-plus")}</div><form id="workDailyLogForm" class="stack-form work-form"><input type="hidden" name="state" value="draft" /><div class="two-col"><label class="field"><span>日期</span><input name="work_date" type="date" value="${esc(todayDateString())}" /></label><label class="field"><span>处理模式</span><select name="processing_mode"><option value="external_ai">外部 AI</option><option value="platform_rules">平台规则</option><option value="manual_only">手工</option></select></label></div><label class="field"><span>输入内容</span><textarea name="raw_text" placeholder="今天做了什么，遇到什么问题，哪些项目有推进..."></textarea></label><div class="field"><span>选择项目</span><div class="check-list work-project-picks">${projectRows}</div></div><div class="two-col"><label class="field"><span>模型</span><select name="requested_model_id"><option value="">自动选择</option>${modelOptions}</select></label><label class="inline-check"><input type="checkbox" name="generate" checked />保存后立即生成</label></div><div class="capture-submit-row"><span class="helper-text">系统会保留日报草稿、项目事件和待审核提案，不会直接改写当前状态。</span><button class="button button-primary" type="submit">${icon("sparkles")}保存并生成</button></div></form></section><section class="panel pad"><div class="panel-title"><div><h2>最新草稿</h2><p>可以直接复制到日报，也可以继续编辑再生成。</p></div>${icon("clipboard")}</div>${latestLog ? renderWorkLogPreview(latestLog, true) : empty("calendar-range", "还没有日报", "先在左侧提交一段今天的工作内容。")}<div style="margin-top:16px">${outputButtons}</div></section></div><section class="panel" style="margin-top:18px"><div class="panel-title" style="padding:18px 18px 12px"><div><h3>最近日报</h3><p>按日期查看生成记录和当前状态。</p></div><button class="button button-small button-secondary" data-action="work-log-new">${icon("plus")}新建</button></div><div class="list">${renderWorkLogRows((state.work.daily_logs || []).slice(0, 8), latestLog?.id || "")}</div></section>`;
}
function focusWorkDailyLogForm() {
  const form = $("#workDailyLogForm");
  form?.scrollIntoView({ block: "start", behavior: "smooth" });
  form?.querySelector("[name=raw_text]")?.focus({ preventScroll: true });
}
function renderWorkProjectsTab(filters = {}) {
  const rows = (state.work.projects || []).filter((project) => {
    if (filters.status && project.status !== filters.status) return false;
    if (filters.query) {
      const q = filters.query.toLowerCase();
      return [project.name, project.customer_name, project.description, project.goal, project.current_summary, project.next_action].some((field) => String(field || "").toLowerCase().includes(q));
    }
    return true;
  });
  const selected = state.work.selectedProject;
  return `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-work-filter="query" placeholder="搜索项目" value="${esc(filters.query || "")}" /></div><select data-work-filter="status"><option value="">全部状态</option>${["active", "paused", "completed", "archived"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(workStatusLabel(status))}</option>`).join("")}</select></div><div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((project) => renderWorkProjectRow(project, selected?.id === project.id)).join("") : empty("folder-search", "没有项目", "先新建一个项目，再记录模块和任务。")}</div></section>${selected ? renderWorkProjectDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个项目", "查看模块、任务、里程碑和历史版本。")}</section>`}</div>`;
}
function renderWorkModulesTab(filters = {}) {
  const projectId = workContextProjectId();
  const rows = (state.work.modules || []).filter((module) => {
    if (projectId && module.project_id !== projectId) return false;
    if (filters.status && module.status !== filters.status) return false;
    if (filters.query) {
      const q = filters.query.toLowerCase();
      return [module.name, module.description, module.current_summary, module.next_action, module.project_name].some((field) => String(field || "").toLowerCase().includes(q));
    }
    return true;
  });
  const selected = state.work.selectedModule;
  return `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-work-filter="query" placeholder="搜索模块" value="${esc(filters.query || "")}" /></div><select data-work-filter="status"><option value="">全部状态</option>${["not_started", "in_progress", "testing", "verifying", "done", "blocked", "archived"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(workStatusLabel(status))}</option>`).join("")}</select><select data-work-filter="projectId"><option value="">全部项目</option>${(state.work.projects || []).map((project) => `<option value="${esc(project.id)}" ${projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select></div><div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((module) => renderWorkModuleRow(module, selected?.id === module.id)).join("") : empty("layout-list", "没有模块", "先选择一个项目或新建模块。")}</div></section>${selected ? renderWorkModuleDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个模块", "查看进度、任务和历史版本。")}</section>`}</div>`;
}
function renderWorkItemsTab(filters = {}) {
  const projectId = workContextProjectId();
  const rows = (state.work.items || []).filter((item) => {
    if (projectId && item.project_id !== projectId) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.itemType && item.item_type !== filters.itemType) return false;
    if (filters.query) {
      const q = filters.query.toLowerCase();
      return [item.title, item.description, item.current_result, item.next_action, item.project_name, item.module_name, item.owner, item.external_reference].some((field) => String(field || "").toLowerCase().includes(q));
    }
    return true;
  });
  const selected = state.work.selectedItem;
  return `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-work-filter="query" placeholder="搜索任务和问题" value="${esc(filters.query || "")}" /></div><select data-work-filter="status"><option value="">全部状态</option>${["not_started", "in_progress", "waiting_customer", "waiting_internal", "testing", "verifying", "blocked", "done", "archived"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(workStatusLabel(status))}</option>`).join("")}</select><select data-work-filter="itemType"><option value="">全部类型</option>${["task", "issue", "requirement", "milestone", "follow_up"].map((type) => `<option value="${type}" ${filters.itemType === type ? "selected" : ""}>${esc(workItemTypeLabel(type))}</option>`).join("")}</select><select data-work-filter="projectId"><option value="">全部项目</option>${(state.work.projects || []).map((project) => `<option value="${esc(project.id)}" ${projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select></div><div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((item) => renderWorkItemRow(item, selected?.id === item.id)).join("") : empty("list-todo", "没有任务", "从项目里补充任务、问题或需求。")}</div></section>${selected ? renderWorkItemDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个任务", "查看当前结论、下一步和历史版本。")}</section>`}</div>`;
}
function renderWorkLogsTab(filters = {}) {
  const rows = (state.work.daily_logs || []).filter((log) => {
    if (filters.logState && log.state !== filters.logState) return false;
    if (filters.query) {
      const q = filters.query.toLowerCase();
      return [log.work_date, log.raw_text, log.cleaned_text, log.state, log.progress_text, log.detail_text, log.next_action_text].some((field) => String(field || "").toLowerCase().includes(q));
    }
    return true;
  });
  const selected = state.work.selectedLog;
  return `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-work-filter="query" placeholder="搜索日报" value="${esc(filters.query || "")}" /></div><select data-work-filter="logState"><option value="">全部状态</option>${["draft", "analyzing", "review", "approved", "partial", "rejected", "failed"].map((status) => `<option value="${status}" ${filters.logState === status ? "selected" : ""}>${esc(workStatusLabel(status))}</option>`).join("")}</select></div><div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? renderWorkLogRows(rows, selected?.id || "") : empty("scroll-text", "没有日报", "先创建第一条日报记录。")}</div></section>${selected ? renderWorkLogDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一条日报", "查看草稿、事件和提案。")}</section>`}</div>`;
}
function renderWorkProjectRow(project, active = false) {
  const meta = `<span class="tag">${esc(workStatusLabel(project.status))}</span><span class="tag">${esc(project.stage || "未设阶段")}</span><span class="tag">${esc(project.open_item_count || 0)} 待办</span><span class="tag">${esc(project.blocked_item_count || 0)} 阻塞</span>`;
  const main = `<div class="list-main"><strong>${esc(project.name)}</strong><small>${esc(project.customer_name || "未填客户")} · ${workTextExcerpt(project.current_summary || project.goal || project.description || "暂无摘要")}</small><small>${esc(project.next_action || "暂无下一步")}</small></div>`;
  return workRow("work-project-detail", project.id, active, main, meta);
}
function renderWorkModuleRow(module, active = false) {
  const meta = `<span class="tag">${esc(workStatusLabel(module.status))}</span><span class="tag">${esc(module.stage || "未设阶段")}</span><span class="tag">${esc(module.open_item_count || 0)} 待办</span>`;
  const main = `<div class="list-main"><strong>${esc(module.name)}</strong><small>${esc(module.project_name || workProjectName(module.project_id))} · ${workTextExcerpt(module.current_summary || module.description || "暂无摘要")}</small><small>${esc(module.next_action || "暂无下一步")}</small></div>`;
  return workRow("work-module-detail", module.id, active, main, meta);
}
function renderWorkItemRow(item, active = false) {
  const meta = `<span class="tag">${esc(workItemTypeLabel(item.item_type))}</span><span class="tag">${esc(workStatusLabel(item.status))}</span><span class="tag">${esc(workPriorityLabel(item.priority))}</span>${item.due_date ? `<span class="tag">${esc(item.due_date)}</span>` : ""}`;
  const main = `<div class="list-main"><strong>${esc(item.title)}</strong><small>${esc(item.project_name || workProjectName(item.project_id))}${item.module_name ? ` · ${esc(item.module_name)}` : ""}</small><small>${esc(item.next_action || item.current_result || item.description || "暂无下一步")}</small></div>`;
  return workRow("work-item-detail", item.id, active, main, meta);
}
function renderWorkLogRows(rows, activeId = "") {
  return rows.map((log) => {
    const selectedProjects = workSelectedProjectIds(log);
    const meta = `<span class="tag">${esc(workStatusLabel(log.state))}</span><span class="tag">${esc(log.work_date)}</span><span class="tag">${esc(selectedProjects.length)} 项目</span><span class="tag">${esc(log.proposal_count || 0)} 提案</span>`;
    const main = `<div class="list-main"><strong>${esc(log.work_date)}</strong><small>${esc(workTextExcerpt(log.progress_text || log.cleaned_text || log.raw_text || "暂无内容"))}</small><small>${esc(workSelectedProjectNames(log).join(" · ") || "未绑定项目")}</small></div>`;
    return workRow("work-log-detail", log.id, activeId === log.id, main, meta);
  }).join("");
}
function renderWorkProjectDetail(project) {
  const modules = (project.modules || []).slice(0, 8);
  const items = (project.items || []).slice(0, 10);
  const milestones = (project.milestones || []).slice(0, 8);
  const projectPeople = (project.project_people || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="work-project-edit" data-id="${esc(project.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="project-person-new" data-project="${esc(project.id)}">${icon("user-plus")}人员</button><button class="button button-small" data-action="work-module-new" data-project="${esc(project.id)}">${icon("plus")}模块</button><button class="button button-small" data-action="work-item-new" data-project="${esc(project.id)}">${icon("list-plus")}任务</button><button class="button button-small" data-action="work-milestone-new" data-project="${esc(project.id)}">${icon("flag")}里程碑</button><button class="button button-small" data-action="work-history" data-entity="project" data-id="${esc(project.id)}">${icon("history")}历史</button><button class="button button-small button-danger" data-action="work-project-delete" data-id="${esc(project.id)}">${icon("trash-2")}归档</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "客户", value: project.customer_name || "未填写" }, { label: "状态", value: workStatusLabel(project.status) }, { label: "阶段", value: project.stage || "未设" }, { label: "目标日期", value: project.target_date || "未定" }])}<div class="work-section"><h3>目标与摘要</h3><p>${esc(project.goal || "暂无目标")}</p><p>${esc(project.current_summary || "暂无摘要")}</p><p>${esc(project.next_action || "暂无下一步")}</p></div><div class="work-section"><div class="panel-title"><div><h3>项目人员</h3><p>这个项目关联的人和职责。</p></div></div><div class="work-sublist">${projectPeople.length ? projectPeople.map((person) => `<div class="work-subrow" data-action="person-detail" data-id="${esc(person.person_id)}"><strong>${esc(person.display_name || workPersonName(person.person_id))}</strong><small>${esc(person.organization_short_name || person.organization_name || "未填组织")} · ${esc(relationshipTypeLabel(person.relationship_type))}${person.responsibility ? ` · ${esc(person.responsibility)}` : ""}</small></div>`).join("") : `<div class="helper-text">暂无项目人员</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>模块</h3><p>这个项目下的模块与主要推进方向。</p></div></div><div class="work-sublist">${modules.length ? modules.map((module) => `<div class="work-subrow" data-action="work-module-detail" data-id="${esc(module.id)}"><strong>${esc(module.name)}</strong><small>${esc(workStatusLabel(module.status))} · ${esc(module.next_action || "暂无下一步")}</small></div>`).join("") : `<div class="helper-text">暂无模块</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>任务与问题</h3><p>当前最需要处理的事项。</p></div></div><div class="work-sublist">${items.length ? items.map((item) => `<div class="work-subrow" data-action="work-item-detail" data-id="${esc(item.id)}"><strong>${esc(item.title)}</strong><small>${esc(workStatusLabel(item.status))} · ${esc(workPriorityLabel(item.priority))} · ${esc(item.next_action || item.current_result || "暂无下一步")}</small></div>`).join("") : `<div class="helper-text">暂无任务</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>里程碑</h3><p>时间点与交付目标。</p></div></div><div class="work-sublist">${milestones.length ? milestones.map((milestone) => `<div class="work-subrow" data-action="work-milestone-detail" data-id="${esc(milestone.id)}"><strong>${esc(milestone.title)}</strong><small>${esc(workStatusLabel(milestone.status))} · ${esc(milestone.target_date || "未定")}</small></div>`).join("") : `<div class="helper-text">暂无里程碑</div>`}</div></div></div>`;
  return workDetailShell(project.name, `${project.customer_name || "未填写客户"} · ${workStatusLabel(project.status)} · ${project.stage || "未设阶段"}`, actions, body);
}
function renderWorkModuleDetail(module) {
  const items = (module.items || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="work-module-edit" data-id="${esc(module.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="work-item-new" data-project="${esc(module.project_id)}" data-module="${esc(module.id)}">${icon("plus")}任务</button><button class="button button-small" data-action="work-history" data-entity="module" data-id="${esc(module.id)}">${icon("history")}历史</button><button class="button button-small button-danger" data-action="work-module-delete" data-id="${esc(module.id)}">${icon("trash-2")}归档</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "项目", value: module.project_name || workProjectName(module.project_id) }, { label: "状态", value: workStatusLabel(module.status) }, { label: "阶段", value: module.stage || "未设" }, { label: "目标日期", value: module.target_date || "未定" }])}<div class="work-section"><h3>摘要</h3><p>${esc(module.description || "暂无描述")}</p><p>${esc(module.current_summary || "暂无摘要")}</p><p>${esc(module.next_action || "暂无下一步")}</p></div><div class="work-section"><div class="panel-title"><div><h3>任务</h3><p>模块下的相关任务和问题。</p></div></div><div class="work-sublist">${items.length ? items.map((item) => `<div class="work-subrow" data-action="work-item-detail" data-id="${esc(item.id)}"><strong>${esc(item.title)}</strong><small>${esc(workStatusLabel(item.status))} · ${esc(workPriorityLabel(item.priority))}</small></div>`).join("") : `<div class="helper-text">暂无任务</div>`}</div></div></div>`;
  return workDetailShell(module.name, `${module.project_name || workProjectName(module.project_id)} · ${workStatusLabel(module.status)} · ${module.stage || "未设阶段"}`, actions, body);
}
function renderWorkItemDetail(item) {
  const workItemPeople = (item.work_item_people || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="work-item-edit" data-id="${esc(item.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="item-person-new" data-item="${esc(item.id)}">${icon("user-plus")}人员</button><button class="button button-small" data-action="work-history" data-entity="item" data-id="${esc(item.id)}">${icon("history")}历史</button><button class="button button-small button-danger" data-action="work-item-delete" data-id="${esc(item.id)}">${icon("trash-2")}归档</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "项目", value: item.project_name || workProjectName(item.project_id) }, { label: "模块", value: item.module_name || workModuleName(item.module_id) || "未分配" }, { label: "类型", value: workItemTypeLabel(item.item_type) }, { label: "状态", value: workStatusLabel(item.status) }, { label: "优先级", value: workPriorityLabel(item.priority) }, { label: "截止", value: item.due_date || "未定" }])}<div class="work-section"><h3>描述</h3><p>${esc(item.description || "暂无描述")}</p></div><div class="work-section"><h3>当前结果</h3><p>${esc(item.current_result || "暂无")}</p></div><div class="work-section"><h3>下一步</h3><p>${esc(item.next_action || "暂无")}</p></div><div class="work-section"><div class="panel-title"><div><h3>关联人员</h3><p>这个任务或问题相关的人。</p></div></div><div class="work-sublist">${workItemPeople.length ? workItemPeople.map((person) => `<div class="work-subrow" data-action="person-detail" data-id="${esc(person.person_id)}"><strong>${esc(person.display_name || workPersonName(person.person_id))}</strong><small>${esc(person.organization_short_name || person.organization_name || "未填组织")} · ${esc(workItemRelationLabel(person.relation_type))}</small></div>`).join("") : `<div class="helper-text">暂无关联人员</div>`}</div></div></div>`;
  return workDetailShell(item.title, `${item.project_name || workProjectName(item.project_id)} · ${item.module_name || "未分配模块"} · ${workStatusLabel(item.status)}`, actions, body);
}
function renderWorkLogPreview(log, withControls = false) {
  if (!log) return empty("calendar-range", "暂无日报", "先创建一条日报记录。");
  const draft = log.draft || {};
  const summary = [
    { label: "状态", value: workStatusLabel(log.state) },
    { label: "草稿", value: draft.status ? workStatusLabel(draft.status) : "未生成" },
    { label: "项目", value: workSelectedProjectNames(log).join("、") || "未选择" },
    { label: "提案", value: `${log.proposals?.length || log.proposal_count || 0}` }
  ];
  const body = `<div class="panel pad work-panel-body">${workMiniGrid(summary)}<div class="work-section"><h3>原始输入</h3><p>${esc(log.raw_text || "暂无")}</p></div>${draft.progress_text ? `<div class="work-section"><h3>今日进展</h3><p>${esc(draft.progress_text)}</p></div>` : ""}${draft.detail_text ? `<div class="work-section"><h3>详细版</h3><p>${esc(draft.detail_text)}</p></div>` : ""}${draft.next_action_text ? `<div class="work-section"><h3>下一步</h3><p>${esc(draft.next_action_text)}</p></div>` : ""}${withControls ? `<div class="work-section"><h3>项目上下文</h3><div class="work-chip-row">${workProjectScopeChips(log)}</div></div>` : ""}</div>`;
  return body;
}
function renderWorkProposalCard(proposal) {
  const actionLabel = ({ create: "创建", update: "更新", status_change: "改状态", archive: "归档", link: "关联" }[proposal.action] || proposal.action || "更新");
  const target = [proposal.project_name, proposal.module_name, proposal.item_title].filter(Boolean).join(" / ");
  return `<article class="operation-card ${proposal.status === "rejected" ? "conflict" : ""}"><div class="operation-card-head"><div><h3>${esc(actionLabel)} · ${esc(proposal.field_name || "内容")}</h3><p>${esc(target || "未绑定对象")} · ${esc(proposal.reason || "未填写原因")}</p></div>${statusBadge(proposal.status)}</div><div class="operation-card-body"><div class="compare-grid"><div class="compare-pane"><div class="compare-label">原值</div><div class="compare-content">${esc(typeof proposal.old_value === "string" ? proposal.old_value : JSON.stringify(proposal.old_value || "", null, 2))}</div></div><div class="compare-pane"><div class="compare-label">建议值</div><div class="compare-content">${esc(typeof proposal.proposed_value === "string" ? proposal.proposed_value : JSON.stringify(proposal.proposed_value || "", null, 2))}</div></div></div><div class="operation-actions"><button class="button button-small button-primary" data-action="work-proposal-apply" data-id="${esc(proposal.id)}">${icon("check")}接受</button><button class="button button-small" data-action="work-proposal-reject" data-id="${esc(proposal.id)}">${icon("x")}拒绝</button></div></div></article>`;
}
function renderWorkLogDetail(log) {
  const projectNames = workSelectedProjectNames(log).join("、") || "未选择项目";
  const actions = `<button class="button button-small" data-action="work-log-edit" data-id="${esc(log.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="work-log-generate" data-id="${esc(log.id)}">${icon("sparkles")}重新生成</button><button class="button button-small" data-action="work-log-copy" data-id="${esc(log.id)}" data-format="concise">${icon("copy")}复制</button><button class="button button-small" data-action="work-log-export" data-id="${esc(log.id)}">${icon("download")}导出</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "日期", value: log.work_date || "未填" }, { label: "状态", value: workStatusLabel(log.state) }, { label: "处理模式", value: workModeLabel(log.processing_mode) }, { label: "模型", value: log.requested_model_id || "自动" }])}<div class="work-section"><h3>项目范围</h3><div class="work-chip-row">${workProjectScopeChips(log)}</div></div><div class="work-section"><h3>原始输入</h3><p>${esc(log.raw_text || "暂无")}</p></div><div class="work-section"><h3>清理结果</h3><p>${esc(log.cleaned_text || "尚未生成")}</p></div>${log.draft ? `<div class="work-section"><h3>日报草稿</h3><p>${esc(log.draft.progress_text || "暂无")}</p><p>${esc(log.draft.detail_text || "")}</p><p>${esc(log.draft.next_action_text || "")}</p></div>` : ""}<div class="work-section"><div class="panel-title"><div><h3>输出</h3><p>直接复制到日报，或者导出给公司表格使用。</p></div></div><div class="work-output-actions">${["concise", "detail", "bullet", "plain"].map((format) => `<button class="button button-small" data-action="work-copy-daily" data-format="${format}" data-id="${esc(log.id)}">${esc(format === "concise" ? "简洁版" : format === "detail" ? "详细版" : format === "bullet" ? "要点版" : "纯文本")}</button>`).join("")}</div></div><div class="work-section"><div class="panel-title"><div><h3>事件</h3><p>AI 识别出来并等待确认的事实。</p></div></div><div class="work-sublist">${(log.events || []).length ? log.events.map((event) => `<div class="work-subrow"><strong>${esc([event.project_name, event.module_name, event.item_title].filter(Boolean).join(" / ") || event.event_type)}</strong><small>${esc(event.content)} · ${workStatusLabel(event.review_status || "pending")}</small></div>`).join("") : `<div class="helper-text">暂无事件</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>提案</h3><p>可以逐条接受或拒绝。</p></div></div><div class="work-proposal-stack">${(log.proposals || []).length ? log.proposals.map(renderWorkProposalCard).join("") : `<div class="helper-text">暂无提案</div>`}</div></div></div>`;
  return workDetailShell(`日报 ${esc(log.work_date || "")}`, `${projectNames} · ${workStatusLabel(log.state)} · ${log.event_count || 0} 条事件`, actions, body);
}

function peopleOrganizationMap() {
  return new Map((state.people.organizations || []).map((organization) => [organization.id, organization]));
}
function peoplePersonMap() {
  return new Map((state.people.people || []).map((person) => [person.id, person]));
}
function peopleOrganizationName(id) {
  return peopleOrganizationMap().get(id)?.name || id || "未填组织";
}
function peoplePersonName(id) {
  return peoplePersonMap().get(id)?.display_name || workPersonName(id);
}
function renderPeopleRow(person, active = false) {
  const meta = `<span class="tag">${esc(personStatusLabel(person.status))}</span><span class="tag">${esc(person.role_count || 0)} 角色</span><span class="tag">${esc(person.expertise_count || 0)} 专长</span><span class="tag">${esc(person.project_count || 0)} 项目</span>`;
  const main = `<div class="list-main"><strong>${esc(person.display_name)}</strong><small>${esc(person.organization_short_name || person.organization_name || "未填组织")}${person.department ? ` · ${esc(person.department)}` : ""}</small><small>${esc(person.aliases?.join("、") || "无别名")}</small></div>`;
  return workRow("person-detail", person.id, active, main, meta);
}
function renderOrganizationRow(organization, active = false) {
  const meta = `<span class="tag">${esc(organizationTypeLabel(organization.organization_type))}</span><span class="tag">${esc(organization.status || "unknown")}</span><span class="tag">${esc(organization.people_count || 0)} 人</span><span class="tag">${esc(organization.child_count || 0)} 子组织</span>`;
  const main = `<div class="list-main"><strong>${esc(organization.name)}</strong><small>${esc(organization.short_name || "无简称")}${organization.parent_name ? ` · ${esc(organization.parent_name)}` : ""}</small><small>${esc(organization.description || "暂无说明")}</small></div>`;
  return workRow("organization-detail", organization.id, active, main, meta);
}
function renderPeopleSuggestionRow(suggestion) {
  const main = `<div class="list-main"><strong>${esc(suggestion.speaker_label || "未命名说话人")}</strong><small>${esc(suggestion.recording_title || suggestion.file_name || "未知录音")} · ${esc(suggestion.project_name || "未关联项目")}</small><small>${esc(suggestion.excerpt || "暂无摘要")}</small></div>`;
  const meta = `<span class="tag">${esc(suggestion.segment_count || 0)} 片段</span><span class="tag">${fmtTime(suggestion.last_seen_at)}</span>`;
  return workRow("audio-recording-detail", suggestion.recording_id, false, main, meta);
}
function renderPeoplePeopleTab(filters = {}, rows = [], selected = null) {
  const organizations = state.people.organizations || [];
  const filtersBar = `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-people-filter="q" placeholder="搜索人员、别名、组织或备注" value="${esc(filters.q || "")}" /></div><select data-people-filter="organizationId"><option value="">全部组织</option>${organizations.map((organization) => `<option value="${esc(organization.id)}" ${filters.organizationId === organization.id ? "selected" : ""}>${esc(organization.name)}</option>`).join("")}</select><select data-people-filter="status"><option value="">全部状态</option>${["active", "inactive", "unknown"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(personStatusLabel(status))}</option>`).join("")}</select><select data-people-filter="roleType"><option value="">全部角色</option>${["customer", "fae", "ae", "rd", "pm", "tester", "other"].map((role) => `<option value="${role}" ${filters.roleType === role ? "selected" : ""}>${esc(roleTypeLabel(role))}</option>`).join("")}</select><input data-people-filter="expertise" placeholder="按专长筛选" value="${esc(filters.expertise || "")}" /></div>`;
  return `${filtersBar}<div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((person) => renderPeopleRow(person, selected?.id === person.id)).join("") : empty("users", "没有人员", "先新建一个人员档案，或者清空筛选条件。")}</div></section>${selected ? renderPersonDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个人员", "查看角色、专长、项目关系和互动记录。")}</section>`}</div>`;
}
function renderPeopleOrganizationsTab(filters = {}, rows = [], selected = null) {
  const filtersBar = `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-people-filter="q" placeholder="搜索组织" value="${esc(filters.q || "")}" /></div><select data-people-filter="status"><option value="">全部状态</option>${["active", "inactive", "unknown"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(statusLabel(status))}</option>`).join("")}</select></div>`;
  return `${filtersBar}<div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((organization) => renderOrganizationRow(organization, selected?.id === organization.id)).join("") : empty("building-2", "没有组织", "先添加一个客户、内部或伙伴组织。")}</div></section>${selected ? renderOrganizationDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个组织", "查看下属组织和关联人员。")}</section>`}</div>`;
}
function renderPeopleSuggestionsTab(rows = []) {
  return `<div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map(renderPeopleSuggestionRow).join("") : empty("speech", "没有说话人建议", "录音生成转写后，这里会出现未确认的 Speaker 提示。")}</div></section><section class="panel pad">${empty("user-check", "说话人建议", "这些条目来自音频转写中的未识别 Speaker。点击条目会跳到对应录音。")}</section></div>`;
}
function renderPersonDetail(person) {
  const roles = (person.roles || []).slice(0, 12);
  const expertise = (person.expertise || []).slice(0, 12);
  const projectPeople = (person.project_people || []).slice(0, 12);
  const workItemPeople = (person.work_item_people || []).slice(0, 12);
  const interactions = (person.interactions || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="people-person-edit" data-id="${esc(person.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="person-role-new" data-id="${esc(person.id)}">${icon("badge-plus")}角色</button><button class="button button-small" data-action="person-expertise-new" data-id="${esc(person.id)}">${icon("sparkles")}专长</button><button class="button button-small" data-action="project-person-new" data-person="${esc(person.id)}">${icon("folder-plus")}项目</button><button class="button button-small" data-action="item-person-new" data-person="${esc(person.id)}">${icon("list-plus")}任务</button><button class="button button-danger button-small" data-action="people-person-delete" data-id="${esc(person.id)}">${icon("trash-2")}删除</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "组织", value: person.organization_short_name || person.organization_name || "未填" }, { label: "部门", value: person.department || "未填" }, { label: "状态", value: personStatusLabel(person.status) }, { label: "模式", value: workModeLabel(person.processing_mode) }])}<div class="work-section"><h3>别名</h3><p>${esc(person.aliases?.join("、") || "暂无别名")}</p></div><div class="work-section"><h3>备注</h3><p>${esc(person.notes || "暂无备注")}</p></div><div class="work-section"><div class="panel-title"><div><h3>角色</h3><p>人员在不同组织或项目中的职责。</p></div></div><div class="work-sublist">${roles.length ? roles.map((role) => `<div class="work-subrow" data-action="person-role-edit" data-id="${esc(role.id)}"><strong>${esc(role.role_name || roleTypeLabel(role.role_type))}</strong><small>${esc(role.organization_name || "未填组织")} · ${esc(roleTypeLabel(role.role_type))}${role.valid_from || role.valid_to ? ` · ${esc([role.valid_from, role.valid_to].filter(Boolean).join(" → "))}` : ""}</small></div>`).join("") : `<div class="helper-text">暂无角色</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>专长</h3><p>人员长期技能或关注方向。</p></div></div><div class="work-sublist">${expertise.length ? expertise.map((item) => `<div class="work-subrow" data-action="person-expertise-edit" data-id="${esc(item.id)}"><strong>${esc(item.expertise_name)}</strong><small>${esc(item.expertise_category || "未分类")} · ${esc(expertiseLevelLabel(item.level))} · ${esc(reviewStatusLabel(item.review_status))}</small></div>`).join("") : `<div class="helper-text">暂无专长</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>项目关系</h3><p>在不同项目中的角色和责任。</p></div></div><div class="work-sublist">${projectPeople.length ? projectPeople.map((relation) => `<div class="work-subrow" data-action="project-person-edit" data-id="${esc(relation.id)}"><strong>${esc(relation.project_name || workProjectName(relation.project_id))}</strong><small>${esc(relationshipTypeLabel(relation.relationship_type))}${relation.module_name ? ` · ${esc(relation.module_name)}` : ""}${relation.responsibility ? ` · ${esc(relation.responsibility)}` : ""}</small></div>`).join("") : `<div class="helper-text">暂无项目关系</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>任务关系</h3><p>人员和具体任务或问题的关联。</p></div></div><div class="work-sublist">${workItemPeople.length ? workItemPeople.map((relation) => `<div class="work-subrow" data-action="item-person-edit" data-id="${esc(relation.id)}"><strong>${esc(relation.work_item_title || workItemTitle(relation.work_item_id))}</strong><small>${esc(workItemRelationLabel(relation.relation_type))}${relation.project_name ? ` · ${esc(relation.project_name)}` : ""}</small></div>`).join("") : `<div class="helper-text">暂无任务关系</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>最近互动</h3><p>会议、问题和其他历史记录。</p></div></div><div class="work-sublist">${interactions.length ? interactions.map((interaction) => `<div class="work-subrow"><strong>${esc(interactionTypeLabel(interaction.interaction_type))}</strong><small>${esc(interaction.project_name || "无项目")}${interaction.meeting_title ? ` · ${esc(interaction.meeting_title)}` : ""} · ${fmtTime(interaction.occurred_at)}</small><small>${esc(interaction.summary || "暂无摘要")}</small></div>`).join("") : `<div class="helper-text">暂无互动</div>`}</div></div></div>`;
  return workDetailShell(person.display_name, `${person.organization_short_name || person.organization_name || "未填组织"} · ${person.department || "未填部门"} · ${personStatusLabel(person.status)}`, actions, body);
}
function renderOrganizationDetail(organization) {
  const children = (organization.children || []).slice(0, 12);
  const people = (organization.people || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="people-organization-edit" data-id="${esc(organization.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="people-person-new" data-organization="${esc(organization.id)}">${icon("user-plus")}人员</button><button class="button button-small" data-action="people-organization-new" data-parent="${esc(organization.id)}">${icon("building-2")}子组织</button><button class="button button-danger button-small" data-action="people-organization-delete" data-id="${esc(organization.id)}">${icon("trash-2")}删除</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "简称", value: organization.short_name || "未填" }, { label: "类型", value: organizationTypeLabel(organization.organization_type) }, { label: "状态", value: organization.status || "unknown" }, { label: "人员", value: organization.people_count || 0 }])}<div class="work-section"><h3>说明</h3><p>${esc(organization.description || "暂无说明")}</p></div><div class="work-section"><div class="panel-title"><div><h3>子组织</h3><p>下级组织结构。</p></div></div><div class="work-sublist">${children.length ? children.map((child) => `<div class="work-subrow" data-action="organization-detail" data-id="${esc(child.id)}"><strong>${esc(child.name)}</strong><small>${esc(organizationTypeLabel(child.organization_type))} · ${esc(child.status || "unknown")}</small></div>`).join("") : `<div class="helper-text">暂无子组织</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>关联人员</h3><p>属于这个组织的人员。</p></div></div><div class="work-sublist">${people.length ? people.map((person) => `<div class="work-subrow" data-action="person-detail" data-id="${esc(person.id)}"><strong>${esc(person.display_name)}</strong><small>${esc(person.department || "未填部门")} · ${esc(personStatusLabel(person.status))}</small></div>`).join("") : `<div class="helper-text">暂无关联人员</div>`}</div></div></div>`;
  return workDetailShell(organization.name, `${organizationTypeLabel(organization.organization_type)} · ${organization.status || "unknown"} · ${organization.people_count || 0} 人`, actions, body);
}
function renderPeople() {
  const tab = state.peopleTab || "people";
  const organizations = state.people.organizations || [];
  const people = state.people.people || [];
  const suggestions = state.people.suggestions || [];
  const filters = peopleFilters();
  const activePeople = people.filter((person) => person.status === "active");
  const tabs = ["people", "organizations", "suggestions"];
  return `<div class="view-head work-head"><div><h1>人员中心</h1><p>组织、人员、角色、专长和项目关系统一管理。</p></div><div class="view-actions"><button class="button button-secondary" data-action="people-organization-new">${icon("building-2")}新建组织</button><button class="button button-primary" data-action="people-person-new">${icon("user-plus")}新建人员</button></div></div><div class="stat-grid work-stat-grid"><div class="stat"><span class="stat-label">人员</span><strong class="stat-value accent">${esc(people.length)}</strong></div><div class="stat"><span class="stat-label">组织</span><strong class="stat-value">${esc(organizations.length)}</strong></div><div class="stat"><span class="stat-label">在用人员</span><strong class="stat-value green">${esc(activePeople.length)}</strong></div><div class="stat"><span class="stat-label">说话人建议</span><strong class="stat-value amber">${esc(suggestions.length)}</strong></div></div><nav class="work-tabs">${tabs.map((item) => `<button class="work-tab ${tab === item ? "active" : ""}" data-action="people-tab" data-tab="${item}">${esc(item === "people" ? "人员" : item === "organizations" ? "组织" : "建议")}</button>`).join("")}</nav>${tab === "organizations" ? renderPeopleOrganizationsTab(filters, organizations, state.people.selectedOrganization) : tab === "suggestions" ? renderPeopleSuggestionsTab(suggestions) : renderPeoplePeopleTab(filters, people, state.people.selectedPerson)}</div>`;
}
function renderAudioRecordingRow(recording, active = false) {
  const meta = `<span class="tag">${esc(recordingStatusLabel(recording.status))}</span><span class="tag">${esc(recording.project_name || workProjectName(recording.project_id) || "未关联项目")}</span><span class="tag">${esc(recording.segment_count || 0)} 片段</span><span class="tag">${esc(recording.topic_count || 0)} 主题</span>`;
  const main = `<div class="list-main"><strong>${esc(recording.title || recording.file_name)}</strong><small>${esc(recording.file_name)} · ${esc(recording.meeting_title || "未关联会议")}</small><small>${esc(recording.description || "暂无说明")}</small></div>`;
  return workRow("audio-recording-detail", recording.id, active, main, meta);
}
function renderAudioMeetingRow(meeting, active = false) {
  const meta = `<span class="tag">${esc(statusLabel(meeting.status))}</span><span class="tag">${esc(meetingTypeLabel(meeting.meeting_type))}</span><span class="tag">${esc(meeting.participant_count || 0)} 参会人</span><span class="tag">${esc(meeting.topic_count || 0)} 主题</span>`;
  const main = `<div class="list-main"><strong>${esc(meeting.title || "未命名会议")}</strong><small>${esc(meeting.meeting_date || "未定日期")} · ${esc(meeting.recording_title || meeting.recording_file_name || "未绑定录音")}</small><small>${esc(meeting.summary || "暂无摘要")}</small></div>`;
  return workRow("audio-meeting-detail", meeting.id, active, main, meta);
}
function renderTranscriptSegmentRow(segment) {
  const meta = `<span class="tag">${esc(segment.review_status || "pending")}</span><span class="tag">${segment.start_ms !== null && segment.start_ms !== undefined ? fmtLatency(segment.start_ms) : "未定时点"}</span><span class="tag">${esc(segment.person_name || segment.speaker_label || "未识别")}</span>`;
  const main = `<div class="list-main"><strong>${esc(segment.speaker_label || "Speaker")}</strong><small>${esc(segment.text || "暂无文本")}</small><small>${esc([segment.start_ms, segment.end_ms].filter((value) => value !== null && value !== undefined && value !== "").join(" - ") || "未设置时间")}</small></div>`;
  return workRow("transcript-segment-edit", segment.id, false, main, meta);
}
function renderMeetingParticipantRow(participant) {
  const meta = `<span class="tag">${esc(attendanceStatusLabel(participant.attendance_status))}</span><span class="tag">${esc(identificationMethodLabel(participant.identification_method))}</span><span class="tag">${Math.round(Number(participant.confidence ?? 0) * 100)}%</span>`;
  const main = `<div class="list-main"><strong>${esc(participant.person_name || participant.speaker_label || "未识别")}</strong><small>${esc(participant.organization_short_name || participant.organization_name || "未填组织")} · ${esc(participant.speaker_label || "无 Speaker")}</small><small>${esc(participant.confirmed_at ? `已确认 ${fmtTime(participant.confirmed_at)}` : "未确认")}</small></div>`;
  return workRow("audio-speaker-edit", participant.id, false, main, meta);
}
function renderMeetingTopicRow(topic) {
  const meta = `<span class="tag">${esc(topicTypeLabel(topic.topic_type))}</span><span class="tag">${esc(reviewStatusLabel(topic.review_status))}</span><span class="tag">${Math.round(Number(topic.confidence ?? 0) * 100)}%</span>`;
  const main = `<div class="list-main"><strong>${esc(topic.title)}</strong><small>${esc(topic.project_name || workProjectName(topic.project_id) || "未关联项目")}${topic.module_name ? ` · ${esc(topic.module_name)}` : ""}</small><small>${esc(topic.summary || "暂无摘要")}</small></div>`;
  return workRow("audio-topic-edit", topic.id, false, main, meta);
}
function sourceTypeLabel(value) { return ({ upload: "上传", meeting: "会议", import: "导入", manual: "手工" }[value] || value || "上传"); }
function peopleOrganizationOptions(selected = "", includeEmpty = true, emptyLabel = "请选择组织") {
  const rows = (state.people.organizations || []).filter((organization) => !organization.archived_at);
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${rows.map((organization) => `<option value="${esc(organization.id)}" ${organization.id === selected ? "selected" : ""}>${esc(organization.name)}</option>`).join("")}`;
}
function peoplePersonOptions(selected = "", includeEmpty = true, emptyLabel = "请选择人员") {
  const rows = (state.people.people || []).filter((person) => !person.archived_at);
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${rows.map((person) => `<option value="${esc(person.id)}" ${person.id === selected ? "selected" : ""}>${esc(person.display_name)}</option>`).join("")}`;
}
function workItemOptions(projectId = "", selected = "", includeEmpty = true, emptyLabel = "请选择任务") {
  const rows = (state.work.items || []).filter((item) => !item.archived_at && (!projectId || item.project_id === projectId));
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${rows.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? "selected" : ""}>${esc(item.title)}</option>`).join("")}`;
}
function audioRecordingOptions(selected = "", includeEmpty = true, emptyLabel = "请选择录音") {
  const rows = (state.audio.recordings || []).filter((recording) => !recording.archived_at);
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${rows.map((recording) => `<option value="${esc(recording.id)}" ${recording.id === selected ? "selected" : ""}>${esc(recording.title || recording.file_name)}</option>`).join("")}`;
}
function audioMeetingOptions(selected = "", includeEmpty = true, emptyLabel = "请选择会议") {
  const rows = (state.audio.meetings || []).filter((meeting) => !meeting.archived_at);
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${rows.map((meeting) => `<option value="${esc(meeting.id)}" ${meeting.id === selected ? "selected" : ""}>${esc(meeting.title || "未命名会议")}</option>`).join("")}`;
}
function renderAudioRecordingsTab(filters = {}, rows = [], selected = null) {
  const projects = state.work.projects || [];
  const statusOptions = ["uploaded", "queued", "validating", "transcribing", "diarizing", "aligning", "review", "analyzing", "proposal_ready", "completed", "failed", "cancelled", "expired", "archived"];
  const filtersBar = `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-audio-filter="q" placeholder="搜索录音、文件名或说明" value="${esc(filters.q || "")}" /></div><select data-audio-filter="status"><option value="">全部状态</option>${statusOptions.map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(recordingStatusLabel(status))}</option>`).join("")}</select><select data-audio-filter="projectId"><option value="">全部项目</option>${projects.filter((project) => !project.archived_at).map((project) => `<option value="${esc(project.id)}" ${filters.projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select><select data-audio-filter="sourceType"><option value="">全部来源</option>${["upload", "meeting", "import", "manual"].map((value) => `<option value="${value}" ${filters.sourceType === value ? "selected" : ""}>${esc(sourceTypeLabel(value))}</option>`).join("")}</select></div>`;
  return `${filtersBar}<div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((recording) => renderAudioRecordingRow(recording, selected?.id === recording.id)).join("") : empty("music", "没有录音", "先上传一个音频文件，或清空筛选条件。")}</div></section>${selected ? renderRecordingDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个录音", "查看转写片段、说话人和主题。")}</section>`}</div>`;
}
function renderAudioMeetingsTab(filters = {}, rows = [], selected = null) {
  const projects = state.work.projects || [];
  const filtersBar = `<div class="toolbar"><div class="search"><i data-lucide="search"></i><input data-audio-filter="q" placeholder="搜索会议或摘要" value="${esc(filters.q || "")}" /></div><select data-audio-filter="status"><option value="">全部状态</option>${["draft", "review", "approved", "archived"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${esc(statusLabel(status))}</option>`).join("")}</select><select data-audio-filter="projectId"><option value="">全部项目</option>${projects.filter((project) => !project.archived_at).map((project) => `<option value="${esc(project.id)}" ${filters.projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select><select data-audio-filter="meetingType"><option value="">全部类型</option>${["customer", "internal", "project", "support", "other"].map((value) => `<option value="${value}" ${filters.meetingType === value ? "selected" : ""}>${esc(meetingTypeLabel(value))}</option>`).join("")}</select></div>`;
  return `${filtersBar}<div class="split-layout work-split"><section class="panel"><div class="list">${rows.length ? rows.map((meeting) => renderAudioMeetingRow(meeting, selected?.id === meeting.id)).join("") : empty("calendar-range", "没有会议", "先创建会议记录，或把录音转成会议。")}</div></section>${selected ? renderMeetingDetail(selected) : `<section class="panel">${empty("mouse-pointer-2", "选择一个会议", "查看参会人、主题和转写内容。")}</section>`}</div>`;
}
function renderAudio() {
  const tab = state.audioTab || "recordings";
  const recordings = state.audio.recordings || [];
  const meetings = state.audio.meetings || [];
  const filters = audioFilters();
  const tabs = ["recordings", "meetings"];
  const processingCount = recordings.filter((recording) => ["queued", "validating", "transcribing", "diarizing", "aligning", "analyzing"].includes(recording.status)).length;
  const reviewCount = recordings.filter((recording) => ["review", "proposal_ready"].includes(recording.status)).length + meetings.filter((meeting) => meeting.status === "review").length;
  return `<div class="view-head work-head"><div><h1>音频中心</h1><p>录音、会议、转写片段和说话人统一管理。</p></div><div class="view-actions"><button class="button button-secondary" data-action="audio-meeting-new">${icon("calendar-plus")}新建会议</button><button class="button button-primary" data-action="audio-recording-new">${icon("upload")}上传录音</button></div></div><div class="stat-grid work-stat-grid"><div class="stat"><span class="stat-label">录音</span><strong class="stat-value accent">${esc(recordings.length)}</strong></div><div class="stat"><span class="stat-label">会议</span><strong class="stat-value">${esc(meetings.length)}</strong></div><div class="stat"><span class="stat-label">处理中</span><strong class="stat-value green">${esc(processingCount)}</strong></div><div class="stat"><span class="stat-label">待审核</span><strong class="stat-value amber">${esc(reviewCount)}</strong></div></div><nav class="work-tabs">${tabs.map((item) => `<button class="work-tab ${tab === item ? "active" : ""}" data-action="audio-tab" data-tab="${item}">${esc(item === "recordings" ? "录音" : "会议")}</button>`).join("")}</nav>${tab === "meetings" ? renderAudioMeetingsTab(filters, meetings, state.audio.selectedMeeting) : renderAudioRecordingsTab(filters, recordings, state.audio.selectedRecording)}</div>`;
}
function renderRecordingDetail(recording) {
  const segments = (recording.segments || []).slice(0, 24);
  const participants = (recording.participants || []).slice(0, 12);
  const topics = (recording.topics || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="audio-recording-edit" data-id="${esc(recording.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="audio-recording-process" data-id="${esc(recording.id)}">${icon("sparkles")}处理</button><button class="button button-small" data-action="audio-transcript-new" data-recording="${esc(recording.id)}">${icon("message-square-plus")}片段</button>${recording.meeting ? `<button class="button button-small" data-action="audio-speaker-new" data-meeting="${esc(recording.meeting.id)}">${icon("user-plus")}说话人</button><button class="button button-small" data-action="audio-topic-new" data-meeting="${esc(recording.meeting.id)}">${icon("list-plus")}主题</button>` : ""}<button class="button button-small" data-action="audio-recording-retry" data-id="${esc(recording.id)}">${icon("rotate-ccw")}重试</button><button class="button button-small" data-action="audio-recording-cancel" data-id="${esc(recording.id)}">${icon("ban")}取消</button><button class="button button-danger button-small" data-action="audio-recording-delete" data-id="${esc(recording.id)}">${icon("trash-2")}删除</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "项目", value: recording.project_name || workProjectName(recording.project_id) || "未关联" }, { label: "状态", value: recordingStatusLabel(recording.status) }, { label: "处理模式", value: workModeLabel(recording.processing_mode) }, { label: "模型", value: recording.requested_model_id || "自动" }, { label: "时长", value: fmtLatency(recording.duration_ms) || "未填" }, { label: "大小", value: recording.size_bytes ? `${Math.round(recording.size_bytes / 1024)} KB` : "0 KB" }])}<div class="work-section"><audio controls style="width:100%" src="${esc(recording.file_url || "")}"></audio></div><div class="work-section"><h3>说明</h3><p>${esc(recording.description || "暂无说明")}</p></div><div class="work-section"><h3>转写摘要</h3><p>${esc(recording.transcript_summary || "暂无摘要")}</p></div>${recording.meeting ? `<div class="work-section"><div class="panel-title"><div><h3>关联会议</h3><p>这个音频对应的会议记录。</p></div></div><div class="work-sublist"><div class="work-subrow" data-action="audio-meeting-detail" data-id="${esc(recording.meeting.id)}"><strong>${esc(recording.meeting.title || "未命名会议")}</strong><small>${esc(recording.meeting.meeting_date || "未定日期")} · ${esc(statusLabel(recording.meeting.status))}</small></div></div></div>` : ""}<div class="work-section"><div class="panel-title"><div><h3>转写片段</h3><p>每条片段可以单独修改 Speaker 和文本。</p></div></div><div class="work-sublist">${segments.length ? segments.map((segment) => renderTranscriptSegmentRow(segment)).join("") : `<div class="helper-text">暂无片段</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>说话人</h3><p>会议中出现的发言人与身份确认。</p></div></div><div class="work-sublist">${participants.length ? participants.map((participant) => renderMeetingParticipantRow(participant)).join("") : `<div class="helper-text">暂无说话人</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>主题</h3><p>会议拆分后的多个主题。</p></div></div><div class="work-sublist">${topics.length ? topics.map((topic) => renderMeetingTopicRow(topic)).join("") : `<div class="helper-text">暂无主题</div>`}</div></div></div>`;
  return workDetailShell(recording.title || recording.file_name, `${recording.file_name} · ${recordingStatusLabel(recording.status)} · ${fmtTime(recording.updated_at)}`, actions, body);
}
function renderMeetingDetail(meeting) {
  const participants = (meeting.participants || []).slice(0, 12);
  const topics = (meeting.topics || []).slice(0, 12);
  const segments = (meeting.segments || []).slice(0, 20);
  const facts = (meeting.facts || []).slice(0, 12);
  const actionsList = (meeting.actions || []).slice(0, 12);
  const proposals = (meeting.proposals || []).slice(0, 12);
  const actions = `<button class="button button-small" data-action="audio-meeting-edit" data-id="${esc(meeting.id)}">${icon("pencil")}编辑</button>${meeting.recording_id || meeting.recording?.id ? `<button class="button button-small" data-action="audio-transcript-new" data-recording="${esc(meeting.recording_id || meeting.recording?.id || "")}">${icon("message-square-plus")}片段</button>` : ""}<button class="button button-small" data-action="audio-speaker-new" data-meeting="${esc(meeting.id)}">${icon("user-plus")}参会人</button><button class="button button-small" data-action="audio-topic-new" data-meeting="${esc(meeting.id)}">${icon("list-plus")}主题</button><button class="button button-small" data-action="audio-meeting-analyze" data-id="${esc(meeting.id)}">${icon("sparkles")}分析</button><button class="button button-small" data-action="audio-meeting-confirm" data-id="${esc(meeting.id)}">${icon("user-check")}确认参会人</button><button class="button button-danger button-small" data-action="audio-meeting-delete" data-id="${esc(meeting.id)}">${icon("trash-2")}删除</button>`;
  const body = `<div class="panel pad work-panel-body">${workMiniGrid([{ label: "日期", value: meeting.meeting_date || "未定" }, { label: "类型", value: meetingTypeLabel(meeting.meeting_type) }, { label: "状态", value: statusLabel(meeting.status) }, { label: "参会人", value: participants.length }, { label: "主题", value: topics.length }])}<div class="work-section"><h3>摘要</h3><p>${esc(meeting.summary || "暂无摘要")}</p></div>${meeting.recording ? `<div class="work-section"><div class="panel-title"><div><h3>关联音频</h3><p>${esc(meeting.recording.title || meeting.recording.file_name || "未命名音频")}</p></div><div class="view-actions"><button class="button button-small" data-action="audio-recording-detail" data-id="${esc(meeting.recording.id)}">${icon("music")}打开录音</button></div></div></div>` : ""}<div class="work-section"><div class="panel-title"><div><h3>转写片段</h3><p>带时间戳的内容。</p></div></div><div class="work-sublist">${segments.length ? segments.map((segment) => renderTranscriptSegmentRow(segment)).join("") : `<div class="helper-text">暂无片段</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>参会人</h3><p>说话人和人员身份确认。</p></div></div><div class="work-sublist">${participants.length ? participants.map((participant) => renderMeetingParticipantRow(participant)).join("") : `<div class="helper-text">暂无参会人</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>主题</h3><p>会议拆分出的多个主题。</p></div></div><div class="work-sublist">${topics.length ? topics.map((topic) => renderMeetingTopicRow(topic)).join("") : `<div class="helper-text">暂无主题</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>事实</h3><p>从主题里整理出的确认信息。</p></div></div><div class="work-sublist">${facts.length ? facts.map((fact) => `<div class="work-subrow"><strong>${esc(fact.title)}</strong><small>${esc(topicTypeLabel(fact.topic_type))}${fact.project_id ? ` · ${esc(workProjectName(fact.project_id))}` : ""}${fact.start_ms !== null && fact.start_ms !== undefined ? ` · ${fmtLatency(fact.start_ms)}` : ""}</small><small>${esc(fact.content)}</small></div>`).join("") : `<div class="helper-text">暂无事实</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>待办</h3><p>从会议里提取出的行动项。</p></div></div><div class="work-sublist">${actionsList.length ? actionsList.map((action) => `<div class="work-subrow"><strong>${esc(action.title)}</strong><small>${esc(action.project_id ? workProjectName(action.project_id) : "未关联项目")}${action.module_id ? ` · ${esc(workModuleName(action.module_id))}` : ""}${action.start_ms !== null && action.start_ms !== undefined ? ` · ${fmtLatency(action.start_ms)}` : ""}</small><small>${esc(action.content)}</small></div>`).join("") : `<div class="helper-text">暂无待办</div>`}</div></div><div class="work-section"><div class="panel-title"><div><h3>建议提案</h3><p>尚未写入数据库的结构化建议。</p></div></div><div class="work-sublist">${proposals.length ? proposals.map((proposal) => `<div class="work-subrow"><strong>${esc(proposal.field_name || proposal.action)}</strong><small>${esc(proposal.project_id ? workProjectName(proposal.project_id) : "未关联项目")}${proposal.module_id ? ` · ${esc(workModuleName(proposal.module_id))}` : ""}</small><small>${esc(proposal.reason || "")}</small></div>`).join("") : `<div class="helper-text">暂无建议</div>`}</div></div></div>`;
  return workDetailShell(meeting.title || "会议", `${meeting.meeting_date || "未定日期"} · ${meetingTypeLabel(meeting.meeting_type)} · ${statusLabel(meeting.status)}`, actions, body);
}

function workProjectOptions(selected = "", includeEmpty = true, emptyLabel = "请选择项目") {
  return `${includeEmpty ? `<option value="">${esc(emptyLabel)}</option>` : ""}${(state.work.projects || []).map((project) => `<option value="${esc(project.id)}" ${project.id === selected ? "selected" : ""}>${esc(project.name)}</option>`).join("")}`;
}
function workModuleOptions(projectId = "", selected = "", includeEmpty = true) {
  const rows = (state.work.modules || []).filter((module) => !projectId || module.project_id === projectId);
  return `${includeEmpty ? `<option value="">未分配模块</option>` : ""}${rows.map((module) => `<option value="${esc(module.id)}" ${module.id === selected ? "selected" : ""}>${esc(module.name)}</option>`).join("")}`;
}
function setWorkSelection(kind, detail = null) {
  if (kind === "project") {
    state.work.selectedProjectId = detail?.id || "";
    state.work.selectedProject = detail || null;
    if (detail?.id) {
      state.work.selectedModuleId = state.work.selectedModule?.project_id === detail.id ? state.work.selectedModuleId : "";
      state.work.selectedItemId = state.work.selectedItem?.project_id === detail.id ? state.work.selectedItemId : "";
    }
  } else if (kind === "module") {
    state.work.selectedModuleId = detail?.id || "";
    state.work.selectedModule = detail || null;
    if (detail?.project_id) state.work.selectedProjectId = detail.project_id;
  } else if (kind === "item") {
    state.work.selectedItemId = detail?.id || "";
    state.work.selectedItem = detail || null;
    if (detail?.project_id) state.work.selectedProjectId = detail.project_id;
    if (detail?.module_id) state.work.selectedModuleId = detail.module_id;
  } else if (kind === "milestone") {
    state.work.selectedMilestoneId = detail?.id || "";
    state.work.selectedMilestone = detail || null;
    if (detail?.project_id) state.work.selectedProjectId = detail.project_id;
  } else if (kind === "log") {
    state.work.selectedLogId = detail?.id || "";
    state.work.selectedLog = detail || null;
  }
}
async function syncWorkViewSelection() {
  if (state.view !== "work") return;
  const tab = state.workTab || "today";
  if (tab === "projects") {
    const rows = state.work.projects || [];
    const id = rows.some((project) => project.id === state.work.selectedProjectId) ? state.work.selectedProjectId : rows[0]?.id || "";
    state.work.selectedProjectId = id;
    if (!id) {
      state.work.selectedProject = null;
    } else if (!state.work.selectedProject || state.work.selectedProject.id !== id || !Array.isArray(state.work.selectedProject.modules)) {
      state.work.selectedProject = (await api(`work/projects/${id}`)).project;
    }
  } else if (tab === "modules") {
    const projectId = workContextProjectId();
    const rows = (state.work.modules || []).filter((module) => !projectId || module.project_id === projectId);
    const id = rows.some((module) => module.id === state.work.selectedModuleId) ? state.work.selectedModuleId : rows[0]?.id || "";
    state.work.selectedModuleId = id;
    if (!id) {
      state.work.selectedModule = null;
    } else if (!state.work.selectedModule || state.work.selectedModule.id !== id || !Array.isArray(state.work.selectedModule.items)) {
      state.work.selectedModule = (await api(`work/modules/${id}`)).module;
    }
    if (state.work.selectedModule?.project_id) state.work.selectedProjectId = state.work.selectedModule.project_id;
  } else if (tab === "items") {
    const projectId = workContextProjectId();
    const rows = (state.work.items || []).filter((item) => !projectId || item.project_id === projectId);
    const id = rows.some((item) => item.id === state.work.selectedItemId) ? state.work.selectedItemId : rows[0]?.id || "";
    state.work.selectedItemId = id;
    if (!id) {
      state.work.selectedItem = null;
    } else if (!state.work.selectedItem || state.work.selectedItem.id !== id || !Array.isArray(state.work.selectedItem.versions)) {
      state.work.selectedItem = (await api(`work/items/${id}`)).item;
    }
    if (state.work.selectedItem?.project_id) state.work.selectedProjectId = state.work.selectedItem.project_id;
    if (state.work.selectedItem?.module_id) state.work.selectedModuleId = state.work.selectedItem.module_id;
  } else {
    const rows = state.work.daily_logs || [];
    const id = rows.some((log) => log.id === state.work.selectedLogId) ? state.work.selectedLogId : rows[0]?.id || "";
    state.work.selectedLogId = id;
    if (!id) {
      state.work.selectedLog = null;
    } else if (!state.work.selectedLog || state.work.selectedLog.id !== id || !Array.isArray(state.work.selectedLog.events) || !Array.isArray(state.work.selectedLog.proposals)) {
      state.work.selectedLog = (await api(`work/daily-logs/${id}`)).log;
    }
  }
  render();
}
async function refreshWorkState() {
  await loadWork();
  await syncWorkViewSelection();
}
async function refreshPeopleState() {
  await loadPeople();
  await syncPeopleViewSelection();
}
async function refreshAudioState() {
  await loadAudio();
  await syncAudioViewSelection();
}
async function refreshAllState() {
  await loadCore();
  if (state.view === "work") {
    await syncWorkViewSelection();
    return;
  }
  if (state.view === "people") {
    await syncPeopleViewSelection();
    return;
  }
  if (state.view === "audio") {
    await syncAudioViewSelection();
    return;
  }
  render();
}
async function updatePeopleFilter(event) {
  const node = event.currentTarget;
  const filters = peopleFilters();
  filters[node.dataset.peopleFilter] = node.value;
  await refreshPeopleState();
}
async function updateAudioFilter(event) {
  const node = event.currentTarget;
  const filters = audioFilters();
  filters[node.dataset.audioFilter] = node.value;
  await refreshAudioState();
}
async function syncPeopleViewSelection() {
  if (state.view !== "people") return;
  const tab = state.peopleTab || "people";
  if (tab === "organizations") {
    const rows = state.people.organizations || [];
    const id = rows.some((organization) => organization.id === state.people.selectedOrganizationId) ? state.people.selectedOrganizationId : rows[0]?.id || "";
    state.people.selectedOrganizationId = id;
    if (!id) {
      state.people.selectedOrganization = null;
    } else if (!state.people.selectedOrganization || state.people.selectedOrganization.id !== id || !Array.isArray(state.people.selectedOrganization.children) || !Array.isArray(state.people.selectedOrganization.people)) {
      state.people.selectedOrganization = (await api(`organizations/${id}`)).organization;
    }
  } else if (tab === "people") {
    const rows = state.people.people || [];
    const id = rows.some((person) => person.id === state.people.selectedPersonId) ? state.people.selectedPersonId : rows[0]?.id || "";
    state.people.selectedPersonId = id;
    if (!id) {
      state.people.selectedPerson = null;
    } else if (!state.people.selectedPerson || state.people.selectedPerson.id !== id || !Array.isArray(state.people.selectedPerson.roles) || !Array.isArray(state.people.selectedPerson.expertise)) {
      state.people.selectedPerson = (await api(`people/${id}`)).person;
    }
  }
  render();
}
async function syncAudioViewSelection() {
  if (state.view !== "audio") return;
  const tab = state.audioTab || "recordings";
  if (tab === "meetings") {
    const rows = state.audio.meetings || [];
    const id = rows.some((meeting) => meeting.id === state.audio.selectedMeetingId) ? state.audio.selectedMeetingId : rows[0]?.id || "";
    state.audio.selectedMeetingId = id;
    if (!id) {
      state.audio.selectedMeeting = null;
    } else if (!state.audio.selectedMeeting || state.audio.selectedMeeting.id !== id || !Array.isArray(state.audio.selectedMeeting.participants) || !Array.isArray(state.audio.selectedMeeting.topics) || !Array.isArray(state.audio.selectedMeeting.segments)) {
      state.audio.selectedMeeting = (await api(`work/meetings/${id}`)).meeting;
    }
  } else {
    const rows = state.audio.recordings || [];
    const id = rows.some((recording) => recording.id === state.audio.selectedRecordingId) ? state.audio.selectedRecordingId : rows[0]?.id || "";
    state.audio.selectedRecordingId = id;
    if (!id) {
      state.audio.selectedRecording = null;
    } else if (!state.audio.selectedRecording || state.audio.selectedRecording.id !== id || !Array.isArray(state.audio.selectedRecording.segments) || !Array.isArray(state.audio.selectedRecording.participants) || !Array.isArray(state.audio.selectedRecording.topics)) {
      state.audio.selectedRecording = (await api(`work/audio/${id}`)).recording;
    }
  }
  render();
}
async function updateWorkFilter(event) {
  const node = event.currentTarget;
  const filterName = node.dataset.workFilter;
  const filters = workFilters();
  filters[filterName] = node.value;
  if (filterName === "projectId") state.work.selectedProjectId = node.value || "";
  await syncWorkViewSelection();
}
async function openWorkProject(id) {
  setWorkSelection("project", state.work.projects.find((project) => project.id === id) || { id });
  state.workTab = "projects";
  await syncWorkViewSelection();
}
async function openWorkModule(id) {
  const module = state.work.modules.find((item) => item.id === id) || (await api(`work/modules/${id}`)).module;
  setWorkSelection("module", module);
  state.workTab = "modules";
  await syncWorkViewSelection();
}
async function openWorkItem(id) {
  const item = state.work.items.find((row) => row.id === id) || (await api(`work/items/${id}`)).item;
  setWorkSelection("item", item);
  state.workTab = "items";
  await syncWorkViewSelection();
}
async function openWorkLog(id) {
  const log = state.work.daily_logs.find((row) => row.id === id) || (await api(`work/daily-logs/${id}`)).log;
  setWorkSelection("log", log);
  state.workTab = "logs";
  await syncWorkViewSelection();
}
async function openWorkMilestone(id) {
  const milestone = state.work.milestones.find((row) => row.id === id) || (await api(`work/milestones/${id}`)).milestone;
  setWorkSelection("milestone", milestone);
  showModal(modalShell(`里程碑 ${esc(milestone.title)}`, `${workProjectName(milestone.project_id)} · ${workStatusLabel(milestone.status)} · ${milestone.target_date || "未定"}`, `<div class="work-modal-stack">${workMiniGrid([{ label: "项目", value: workProjectName(milestone.project_id) }, { label: "状态", value: workStatusLabel(milestone.status) }, { label: "截止", value: milestone.target_date || "未定" }])}<div class="work-section"><h3>说明</h3><p>${esc(milestone.description || "暂无")}</p></div><div class="work-section"><h3>验收</h3><p>${esc(milestone.acceptance_criteria || "暂无")}</p></div><div class="work-section"><h3>当前结果</h3><p>${esc(milestone.current_result || "暂无")}</p></div><div class="work-section"><h3>下一步</h3><p>${esc(milestone.next_action || "暂无")}</p></div></div>`, `<button class="button" data-close-modal>关闭</button><button class="button button-secondary" data-action="work-milestone-edit" data-id="${esc(milestone.id)}">${icon("pencil")}编辑</button><button class="button button-primary" data-action="work-milestone-history" data-id="${esc(milestone.id)}">${icon("history")}历史</button><button class="button button-danger" data-action="work-milestone-delete" data-id="${esc(milestone.id)}">${icon("trash-2")}归档</button>`), "modal-wide");
}
async function openWorkHistory(entityType, id) {
  const result = await api(`work/entities/${entityType}/${id}/history`);
  const history = result.history || [];
  const title = ({ project: "项目", module: "模块", item: "任务", milestone: "里程碑" }[entityType] || entityType) + " 历史";
  const body = history.length ? history.map((version) => {
    const snapshot = version.snapshot || {};
    const summary = entityType === "project"
      ? [workStatusLabel(snapshot.status), snapshot.stage, workTextExcerpt(snapshot.current_summary || snapshot.goal || snapshot.description || "")].filter(Boolean).join(" · ")
      : entityType === "module"
        ? [workStatusLabel(snapshot.status), snapshot.stage, workTextExcerpt(snapshot.current_summary || snapshot.next_action || snapshot.description || "")].filter(Boolean).join(" · ")
      : entityType === "item"
        ? [workStatusLabel(snapshot.status), workPriorityLabel(snapshot.priority), workTextExcerpt(snapshot.next_action || snapshot.current_result || snapshot.description || "")].filter(Boolean).join(" · ")
        : [workStatusLabel(snapshot.status), snapshot.target_date || "未定", workTextExcerpt(snapshot.current_result || snapshot.next_action || snapshot.description || "")].filter(Boolean).join(" · ");
    return `<article class="operation-card"><div class="operation-card-head"><div><h3>版本 ${esc(version.version_no)}</h3><p>${esc(version.change_reason || "未填写原因")} · ${fmtTime(version.created_at)}</p></div><button class="button button-small button-primary" data-action="work-history-restore" data-entity="${esc(entityType)}" data-entity-id="${esc(id)}" data-version-id="${esc(version.id)}">${icon("rotate-ccw")}恢复</button></div><div class="operation-card-body"><div class="compare-content">${esc(summary || "暂无摘要")}</div></div></article>`;
  }).join("") : empty("history", "没有历史版本", "第一次保存后会出现历史记录。");
  showModal(modalShell(title, "每次修改都会生成一个历史版本，可以随时恢复。", body, `<button class="button" data-close-modal>关闭</button>`), "modal-wide");
}
async function downloadWorkExport(format) {
  const response = await api(`work/export/${format}`, { method: "POST", body: {} });
  const text = format === "markdown" ? response.markdown : format === "txt" ? response.txt : format === "tsv" ? response.tsv : JSON.stringify(response, null, 2);
  const mime = format === "json" ? "application/json" : "text/plain;charset=utf-8";
  saveBlob(new Blob([text], { type: mime }), `nanstar-work-${Date.now()}.${format === "json" ? "json" : format === "tsv" ? "tsv" : format === "txt" ? "txt" : "md"}`);
}
async function copyWorkDailyOutput(id, format = "concise") {
  const log = state.work.selectedLog?.id === id ? state.work.selectedLog : workLogMap().get(id) || (await api(`work/daily-logs/${id}`)).log;
  const text = workDailyCopyText(log, format === "plain" ? "plain" : format);
  await navigator.clipboard.writeText(text);
  toast("日报内容已复制");
}
async function submitWorkDailyLog(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = $("button[type=submit]", form);
  const original = button.innerHTML;
  try {
    button.disabled = true;
    button.innerHTML = `${icon("loader-circle")}生成中`;
    const selectedProjectIds = [...new Set(data.getAll("selected_project_ids").map((value) => String(value).trim()).filter(Boolean))];
    const result = await api("work/daily-logs", {
      method: "POST",
      body: {
        work_date: data.get("work_date"),
        raw_text: data.get("raw_text"),
        processing_mode: data.get("processing_mode"),
        requested_model_id: data.get("requested_model_id"),
        state: data.get("state") || "draft",
        selected_project_ids_json: selectedProjectIds,
        generate: data.get("generate") !== null
      }
    });
    await loadWork();
    state.work.selectedLogId = result.log?.id || "";
    state.work.selectedLog = result.log || null;
    state.workTab = "today";
    render();
    toast("日报已生成");
  } catch (error) {
    await refreshWorkState().catch(() => {});
    throw error;
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function openWorkProjectEditor(id = null) {
  const current = state.work.projects.find((item) => item.id === id) || null;
  showModal(modalShell(current ? "编辑项目" : "新建项目", "项目保存后会同步到项目总览和日报上下文。", `<div class="two-col"><label class="field"><span>项目名称</span><input name="name" required value="${esc(current?.name || "")}" /></label><label class="field"><span>客户名称</span><input name="customer_name" value="${esc(current?.customer_name || "")}" /></label></div><label class="field"><span>项目描述</span><textarea name="description" style="min-height:92px">${esc(current?.description || "")}</textarea></label><div class="two-col"><label class="field"><span>状态</span><select name="status">${["active", "paused", "completed", "archived"].map((value) => `<option value="${value}" ${value === (current?.status || "active") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label><label class="field"><span>阶段</span><select name="stage">${["planning", "development", "integration", "debugging", "testing", "delivery"].map((value) => `<option value="${value}" ${value === (current?.stage || "planning") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label></div><label class="field"><span>目标</span><textarea name="goal" style="min-height:86px">${esc(current?.goal || "")}</textarea></label><div class="two-col"><label class="field"><span>当前摘要</span><textarea name="current_summary" style="min-height:86px">${esc(current?.current_summary || "")}</textarea></label><label class="field"><span>下一步</span><textarea name="next_action" style="min-height:86px">${esc(current?.next_action || "")}</textarea></label></div><div class="two-col"><label class="field"><span>目标日期</span><input name="target_date" type="date" value="${esc(current?.target_date || "")}" /></label><label class="field"><span>处理模式</span><select name="processing_mode"><option value="external_ai" ${current?.processing_mode === "external_ai" ? "selected" : ""}>外部 AI</option><option value="platform_rules" ${(current?.processing_mode || "platform_rules") === "platform_rules" ? "selected" : ""}>平台规则</option><option value="manual_only" ${current?.processing_mode === "manual_only" ? "selected" : ""}>手工</option></select></label></div><div class="two-col"><label class="field"><span>标签</span><input name="tags" value="${esc((current?.tags || []).join(", "))}" placeholder="用逗号分隔" /></label><label class="field"><span>排序</span><input name="sort_order" type="number" min="0" max="100000" value="${esc(current?.sort_order ?? 100)}" /></label></div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-work-project">${icon("save")}保存</button>`), "modal-wide");
  $("[data-modal-action=save-work-project]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        name: $("[name=name]", card).value,
        customer_name: $("[name=customer_name]", card).value,
        description: $("[name=description]", card).value,
        status: $("[name=status]", card).value,
        stage: $("[name=stage]", card).value,
        goal: $("[name=goal]", card).value,
        current_summary: $("[name=current_summary]", card).value,
        next_action: $("[name=next_action]", card).value,
        target_date: $("[name=target_date]", card).value,
        processing_mode: $("[name=processing_mode]", card).value,
        tags: $("[name=tags]", card).value,
        sort_order: $("[name=sort_order]", card).value
      };
      const result = current ? await api(`work/projects/${id}`, { method: "PATCH", body }) : await api("work/projects", { method: "POST", body });
      closeModal();
      await loadWork();
      state.work.selectedProjectId = result.project?.id || current?.id || "";
      state.work.selectedProject = null;
      state.workTab = "projects";
      await syncWorkViewSelection();
      toast(current ? "项目已更新" : "项目已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openWorkModuleEditor(id = null, projectId = "") {
  const current = state.work.modules.find((item) => item.id === id) || null;
  const selectedProjectId = projectId || current?.project_id || state.work.selectedProjectId || (state.work.projects[0]?.id || "");
  showModal(modalShell(current ? "编辑模块" : "新建模块", "模块保存后会进入模块进度页。", `<div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(selectedProjectId)}</select></label><label class="field"><span>模块名称</span><input name="name" required value="${esc(current?.name || "")}" /></label></div><label class="field"><span>描述</span><textarea name="description" style="min-height:86px">${esc(current?.description || "")}</textarea></label><div class="two-col"><label class="field"><span>状态</span><select name="status">${["not_started", "in_progress", "testing", "verifying", "done", "blocked", "archived"].map((value) => `<option value="${value}" ${value === (current?.status || "not_started") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label><label class="field"><span>阶段</span><input name="stage" value="${esc(current?.stage || "planning")}" /></label></div><div class="two-col"><label class="field"><span>当前摘要</span><textarea name="current_summary" style="min-height:86px">${esc(current?.current_summary || "")}</textarea></label><label class="field"><span>下一步</span><textarea name="next_action" style="min-height:86px">${esc(current?.next_action || "")}</textarea></label></div><div class="two-col"><label class="field"><span>目标日期</span><input name="target_date" type="date" value="${esc(current?.target_date || "")}" /></label><label class="field"><span>排序</span><input name="sort_order" type="number" min="0" max="100000" value="${esc(current?.sort_order ?? 100)}" /></label></div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-work-module">${icon("save")}保存</button>`), "modal-wide");
  $("[data-modal-action=save-work-module]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        project_id: $("[name=project_id]", card).value,
        name: $("[name=name]", card).value,
        description: $("[name=description]", card).value,
        status: $("[name=status]", card).value,
        stage: $("[name=stage]", card).value,
        current_summary: $("[name=current_summary]", card).value,
        next_action: $("[name=next_action]", card).value,
        target_date: $("[name=target_date]", card).value,
        sort_order: $("[name=sort_order]", card).value
      };
      const result = current ? await api(`work/modules/${id}`, { method: "PATCH", body }) : await api(`work/projects/${body.project_id}/modules`, { method: "POST", body });
      closeModal();
      await loadWork();
      state.work.selectedProjectId = body.project_id;
      state.work.selectedModuleId = result.module?.id || current?.id || "";
      state.work.selectedModule = null;
      state.workTab = "modules";
      await syncWorkViewSelection();
      toast(current ? "模块已更新" : "模块已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openWorkItemEditor(id = null, projectId = "", moduleId = "") {
  const current = state.work.items.find((item) => item.id === id) || null;
  const selectedProjectId = projectId || current?.project_id || state.work.selectedProjectId || (state.work.projects[0]?.id || "");
  const selectedModuleId = moduleId || current?.module_id || "";
  showModal(modalShell(current ? "编辑任务" : "新建任务", "任务和问题会进入项目总览与日报提案。", `<div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(selectedProjectId)}</select></label><label class="field"><span>模块</span><select name="module_id">${workModuleOptions(selectedProjectId, selectedModuleId)}</select></label></div><div class="two-col"><label class="field"><span>类型</span><select name="item_type">${["task", "issue", "requirement", "milestone", "follow_up"].map((value) => `<option value="${value}" ${value === (current?.item_type || "task") ? "selected" : ""}>${esc(workItemTypeLabel(value))}</option>`).join("")}</select></label><label class="field"><span>优先级</span><select name="priority">${["low", "normal", "high", "urgent"].map((value) => `<option value="${value}" ${value === (current?.priority || "normal") ? "selected" : ""}>${esc(workPriorityLabel(value))}</option>`).join("")}</select></label></div><label class="field"><span>标题</span><input name="title" required value="${esc(current?.title || "")}" /></label><label class="field"><span>描述</span><textarea name="description" style="min-height:86px">${esc(current?.description || "")}</textarea></label><div class="two-col"><label class="field"><span>状态</span><select name="status">${["not_started", "in_progress", "waiting_customer", "waiting_internal", "testing", "verifying", "blocked", "done", "archived"].map((value) => `<option value="${value}" ${value === (current?.status || "not_started") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label><label class="field"><span>负责人</span><input name="owner" value="${esc(current?.owner || "")}" /></label></div><div class="two-col"><label class="field"><span>外部编号</span><input name="external_reference" value="${esc(current?.external_reference || "")}" /></label><label class="field"><span>截止日期</span><input name="due_date" type="date" value="${esc(current?.due_date || "")}" /></label></div><div class="two-col"><label class="field"><span>当前结果</span><textarea name="current_result" style="min-height:86px">${esc(current?.current_result || "")}</textarea></label><label class="field"><span>下一步</span><textarea name="next_action" style="min-height:86px">${esc(current?.next_action || "")}</textarea></label></div><div class="two-col"><label class="field"><span>发现日期</span><input name="discovered_at" type="date" value="${esc(current?.discovered_at || "")}" /></label><label class="field"><span>解决日期</span><input name="resolved_at" type="date" value="${esc(current?.resolved_at || "")}" /></label></div><label class="field"><span>排序</span><input name="sort_order" type="number" min="0" max="100000" value="${esc(current?.sort_order ?? 100)}" /></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-work-item">${icon("save")}保存</button>`), "modal-wide");
  const card = $("#modalCard");
  const projectSelect = $("[name=project_id]", card);
  const moduleSelect = $("[name=module_id]", card);
  function refreshModules() {
    moduleSelect.innerHTML = workModuleOptions(projectSelect.value, moduleSelect.value);
  }
  projectSelect.addEventListener("change", refreshModules);
  refreshModules();
  $("[data-modal-action=save-work-item]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        project_id: $("[name=project_id]", card).value,
        module_id: $("[name=module_id]", card).value,
        item_type: $("[name=item_type]", card).value,
        title: $("[name=title]", card).value,
        description: $("[name=description]", card).value,
        status: $("[name=status]", card).value,
        priority: $("[name=priority]", card).value,
        external_reference: $("[name=external_reference]", card).value,
        owner: $("[name=owner]", card).value,
        current_result: $("[name=current_result]", card).value,
        next_action: $("[name=next_action]", card).value,
        due_date: $("[name=due_date]", card).value,
        discovered_at: $("[name=discovered_at]", card).value,
        resolved_at: $("[name=resolved_at]", card).value,
        sort_order: $("[name=sort_order]", card).value
      };
      const result = current ? await api(`work/items/${id}`, { method: "PATCH", body }) : await api("work/items", { method: "POST", body });
      closeModal();
      await loadWork();
      state.work.selectedProjectId = body.project_id;
      state.work.selectedModuleId = body.module_id || "";
      state.work.selectedItemId = result.item?.id || current?.id || "";
      state.work.selectedItem = null;
      state.workTab = "items";
      await syncWorkViewSelection();
      toast(current ? "任务已更新" : "任务已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openWorkMilestoneEditor(id = null, projectId = "") {
  const current = state.work.milestones.find((item) => item.id === id) || null;
  const selectedProjectId = projectId || current?.project_id || state.work.selectedProjectId || (state.work.projects[0]?.id || "");
  showModal(modalShell(current ? "编辑里程碑" : "新建里程碑", "里程碑只做手动维护，不会自动改日期。", `<div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(selectedProjectId)}</select></label><label class="field"><span>标题</span><input name="title" required value="${esc(current?.title || "")}" /></label></div><label class="field"><span>描述</span><textarea name="description" style="min-height:86px">${esc(current?.description || "")}</textarea></label><div class="two-col"><label class="field"><span>状态</span><select name="status">${["planned", "in_progress", "at_risk", "done", "cancelled"].map((value) => `<option value="${value}" ${value === (current?.status || "planned") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label><label class="field"><span>目标日期</span><input name="target_date" type="date" value="${esc(current?.target_date || "")}" /></label></div><div class="two-col"><label class="field"><span>验收标准</span><textarea name="acceptance_criteria" style="min-height:86px">${esc(current?.acceptance_criteria || "")}</textarea></label><label class="field"><span>当前结果</span><textarea name="current_result" style="min-height:86px">${esc(current?.current_result || "")}</textarea></label></div><label class="field"><span>下一步</span><textarea name="next_action" style="min-height:86px">${esc(current?.next_action || "")}</textarea></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-work-milestone">${icon("save")}保存</button>`), "modal-wide");
  $("[data-modal-action=save-work-milestone]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        project_id: $("[name=project_id]", card).value,
        title: $("[name=title]", card).value,
        description: $("[name=description]", card).value,
        status: $("[name=status]", card).value,
        target_date: $("[name=target_date]", card).value,
        acceptance_criteria: $("[name=acceptance_criteria]", card).value,
        current_result: $("[name=current_result]", card).value,
        next_action: $("[name=next_action]", card).value
      };
      const result = current ? await api(`work/milestones/${id}`, { method: "PATCH", body }) : await api("work/milestones", { method: "POST", body });
      closeModal();
      await loadWork();
      state.work.selectedProjectId = body.project_id;
      state.work.selectedMilestoneId = result.milestone?.id || current?.id || "";
      state.work.selectedMilestone = null;
      state.workTab = "projects";
      await syncWorkViewSelection();
      toast(current ? "里程碑已更新" : "里程碑已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openWorkLogEditor(id) {
  const current = state.work.daily_logs.find((item) => item.id === id) || null;
  if (!current) return;
  const selectedIds = new Set(workSelectedProjectIds(current));
  const projectRows = (state.work.projects || []).filter((project) => !project.archived_at).map((project) => `<label class="check-item"><input type="checkbox" name="selected_project_ids" value="${esc(project.id)}" ${selectedIds.has(project.id) ? "checked" : ""} /><span>${esc(project.name)}</span></label>`).join("");
  showModal(modalShell("编辑日报", "可以修正原始输入、项目范围和草稿内容。", `<div class="two-col"><label class="field"><span>日期</span><input name="work_date" type="date" value="${esc(current.work_date || "")}" /></label><label class="field"><span>状态</span><select name="state">${["draft", "analyzing", "review", "approved", "partial", "rejected", "failed"].map((value) => `<option value="${value}" ${value === (current.state || "draft") ? "selected" : ""}>${esc(workStatusLabel(value))}</option>`).join("")}</select></label></div><label class="field"><span>原始输入</span><textarea name="raw_text" style="min-height:120px">${esc(current.raw_text || "")}</textarea></label><div class="field"><span>选择项目</span><div class="check-list work-project-picks">${projectRows}</div></div><div class="two-col"><label class="field"><span>处理模式</span><select name="processing_mode"><option value="external_ai" ${current.processing_mode === "external_ai" ? "selected" : ""}>外部 AI</option><option value="platform_rules" ${(current.processing_mode || "platform_rules") === "platform_rules" ? "selected" : ""}>平台规则</option><option value="manual_only" ${current.processing_mode === "manual_only" ? "selected" : ""}>手工</option></select></label><label class="field"><span>模型</span><select name="requested_model_id"><option value="">自动选择</option>${state.settings.models.filter((model) => model.enabled !== false).map((model) => `<option value="${esc(model.id)}" ${model.id === (current.requested_model_id || "") ? "selected" : ""}>${esc(model.display_name || model.model_id)}</option>`).join("")}</select></label></div><div class="two-col"><label class="field"><span>草稿-简洁版</span><textarea name="draft_progress_text" style="min-height:90px">${esc(current.draft?.progress_text || "")}</textarea></label><label class="field"><span>草稿-详细版</span><textarea name="draft_detail_text" style="min-height:90px">${esc(current.draft?.detail_text || "")}</textarea></label></div><label class="field"><span>草稿-下一步</span><textarea name="draft_next_action_text" style="min-height:90px">${esc(current.draft?.next_action_text || "")}</textarea></label><label class="inline-check"><input type="checkbox" name="generate" checked />保存后立即重新生成</label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-work-log">${icon("save")}保存</button>`), "modal-wide");
  $("[data-modal-action=save-work-log]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        work_date: $("[name=work_date]", card).value,
        raw_text: $("[name=raw_text]", card).value,
        processing_mode: $("[name=processing_mode]", card).value,
        requested_model_id: $("[name=requested_model_id]", card).value,
        state: $("[name=state]", card).value,
        selected_project_ids_json: $$("[name=selected_project_ids]:checked", card).map((input) => input.value),
        draft_progress_text: $("[name=draft_progress_text]", card).value,
        draft_detail_text: $("[name=draft_detail_text]", card).value,
        draft_next_action_text: $("[name=draft_next_action_text]", card).value,
        draft_status: "edited",
        generate: $("[name=generate]", card).checked
      };
      const result = await api(`work/daily-logs/${id}`, { method: "PATCH", body });
      closeModal();
      await loadWork();
      state.work.selectedLogId = result.log?.id || current.id;
      state.work.selectedLog = result.log || null;
      state.workTab = "logs";
      await syncWorkViewSelection();
      toast("日报已更新");
    } catch (error) {
      handleError(error);
    }
  });
}

function enumOptions(values, selected = "", labeler = (value) => value) {
  return values.map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(labeler(value))}</option>`).join("");
}

function activeModelOptions(selected = "", emptyLabel = "自动选择") {
  return `<option value="">${esc(emptyLabel)}</option>${(state.settings.models || []).filter((model) => model.enabled !== false).map((model) => `<option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.display_name || model.model_id)}</option>`).join("")}`;
}

function modalField(card, name) {
  return $(`[name=${name}]`, card);
}

function modalValue(card, name) {
  return modalField(card, name)?.value || "";
}

function modalChecked(card, name) {
  return Boolean(modalField(card, name)?.checked);
}

function modalNumber(card, name, fallback = null) {
  const value = modalValue(card, name).trim();
  if (value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function splitListText(value) {
  return String(value || "").split(/[\n,，、]+/).map((item) => item.trim()).filter(Boolean);
}

function findInLists(id, lists = []) {
  for (const list of lists) {
    const found = (list || []).find((item) => item?.id === id);
    if (found) return found;
  }
  return null;
}

function selectedProjectCheckboxes(selectedIds = []) {
  const selected = new Set(selectedIds || []);
  return (state.work.projects || []).filter((project) => !project.archived_at).map((project) => `<label class="check-item"><input type="checkbox" name="selected_project_ids" value="${esc(project.id)}" ${selected.has(project.id) ? "checked" : ""} /><span>${esc(project.name)}</span></label>`).join("");
}

async function refreshPeopleSelection({ personId = "", organizationId = "", tab = "" } = {}) {
  await loadPeople();
  if (tab) state.peopleTab = tab;
  if (personId) {
    state.people.selectedPersonId = personId;
    state.people.selectedPerson = null;
  }
  if (organizationId) {
    state.people.selectedOrganizationId = organizationId;
    state.people.selectedOrganization = null;
  }
  if (state.view === "people") await syncPeopleViewSelection();
  else render();
}

async function refreshPeopleAndWorkSelection({ personId = "", projectId = "", workItemId = "" } = {}) {
  await Promise.all([loadPeople(), loadWork()]);
  if (personId) {
    state.people.selectedPersonId = personId;
    state.people.selectedPerson = null;
  }
  if (projectId) {
    state.work.selectedProjectId = projectId;
    state.work.selectedProject = null;
  }
  if (workItemId) {
    state.work.selectedItemId = workItemId;
    state.work.selectedItem = null;
  }
  if (state.view === "people") await syncPeopleViewSelection();
  else if (state.view === "work") await syncWorkViewSelection();
  else render();
}

async function refreshAudioSelection({ recordingId = "", meetingId = "", tab = "" } = {}) {
  await loadAudio();
  if (tab) state.audioTab = tab;
  if (recordingId) {
    state.audio.selectedRecordingId = recordingId;
    state.audio.selectedRecording = null;
  }
  if (meetingId) {
    state.audio.selectedMeetingId = meetingId;
    state.audio.selectedMeeting = null;
  }
  if (state.audio.selectedRecording) state.audio.selectedRecording = null;
  if (state.audio.selectedMeeting) state.audio.selectedMeeting = null;
  if (state.view === "audio") await syncAudioViewSelection();
  else render();
}

function openPeopleOrganizationEditor(id = null, parentId = "") {
  const current = id ? (state.people.selectedOrganization?.id === id ? state.people.selectedOrganization : (state.people.organizations || []).find((item) => item.id === id)) : null;
  showModal(modalShell(current ? "编辑组织" : "新建组织", "组织用于归档客户、内部团队和合作伙伴。", `<div class="two-col"><label class="field"><span>组织名称</span><input name="name" required value="${esc(current?.name || "")}" /></label><label class="field"><span>简称</span><input name="short_name" value="${esc(current?.short_name || "")}" /></label></div><div class="two-col"><label class="field"><span>类型</span><select name="organization_type">${enumOptions(["customer", "internal", "partner", "other"], current?.organization_type || "other", organizationTypeLabel)}</select></label><label class="field"><span>父组织</span><select name="parent_id">${peopleOrganizationOptions(current?.parent_id || parentId || "", true, "无父组织")}</select></label></div><label class="field"><span>状态</span><select name="status">${enumOptions(["active", "inactive", "unknown"], current?.status || "active", statusLabel)}</select></label><label class="field"><span>说明</span><textarea name="description" style="min-height:120px">${esc(current?.description || "")}</textarea></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-organization">${icon("save")}保存</button>`));
  $("[data-modal-action=save-organization]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        name: modalValue(card, "name"),
        short_name: modalValue(card, "short_name"),
        organization_type: modalValue(card, "organization_type"),
        parent_id: modalValue(card, "parent_id"),
        status: modalValue(card, "status"),
        description: modalValue(card, "description")
      };
      const result = current ? await api(`organizations/${id}`, { method: "PATCH", body }) : await api("organizations", { method: "POST", body });
      closeModal();
      await refreshPeopleSelection({ organizationId: result.organization?.id || id, tab: "organizations" });
      toast(current ? "组织已更新" : "组织已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openPeoplePersonEditor(id = null, organizationId = "") {
  const current = id ? (state.people.selectedPerson?.id === id ? state.people.selectedPerson : (state.people.people || []).find((item) => item.id === id)) : null;
  const aliases = current?.aliases?.join("\n") || "";
  showModal(modalShell(current ? "编辑人员" : "新建人员", "这里只保存工作关系所需的信息，不保存私人联系方式。", `<div class="two-col"><label class="field"><span>显示名称</span><input name="display_name" required value="${esc(current?.display_name || "")}" /></label><label class="field"><span>组织</span><select name="organization_id">${peopleOrganizationOptions(current?.organization_id || organizationId || "", true, "未绑定组织")}</select></label></div><div class="two-col"><label class="field"><span>部门</span><input name="department" value="${esc(current?.department || "")}" /></label><label class="field"><span>状态</span><select name="status">${enumOptions(["active", "inactive", "unknown"], current?.status || "active", personStatusLabel)}</select></label></div><div class="two-col"><label class="field"><span>处理模式</span><select name="processing_mode">${enumOptions(["external_ai", "platform_rules", "manual_only"], current?.processing_mode || "manual_only", workModeLabel)}</select></label><label class="field"><span>敏感度</span><input name="sensitivity" value="${esc(current?.sensitivity || "normal")}" /></label></div><label class="field"><span>别名</span><textarea name="aliases" placeholder="每行一个别名，或用逗号分隔" style="min-height:90px">${esc(aliases)}</textarea></label><label class="field"><span>备注</span><textarea name="notes" style="min-height:120px">${esc(current?.notes || "")}</textarea></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-person">${icon("save")}保存</button>`));
  $("[data-modal-action=save-person]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        display_name: modalValue(card, "display_name"),
        aliases: splitListText(modalValue(card, "aliases")),
        organization_id: modalValue(card, "organization_id"),
        department: modalValue(card, "department"),
        notes: modalValue(card, "notes"),
        status: modalValue(card, "status"),
        processing_mode: modalValue(card, "processing_mode"),
        sensitivity: modalValue(card, "sensitivity")
      };
      const result = current ? await api(`people/${id}`, { method: "PATCH", body }) : await api("people", { method: "POST", body });
      closeModal();
      await refreshPeopleSelection({ personId: result.person?.id || id, tab: "people" });
      toast(current ? "人员已更新" : "人员已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

function openPersonRoleEditor(id = null, personId = "") {
  const current = id ? findInLists(id, [state.people.selectedPerson?.roles]) : null;
  const activePersonId = current?.person_id || personId || state.people.selectedPersonId || "";
  if (!current && !activePersonId) return toast("请先选择人员", "error");
  showModal(modalShell(current ? "编辑人员角色" : "新增人员角色", "角色可以绑定组织、时间范围和来源，避免把一个固定 role 写死在人员档案里。", `<div class="two-col"><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(activePersonId, false)}</select></label><label class="field"><span>组织</span><select name="organization_id">${peopleOrganizationOptions(current?.organization_id || "", true, "未绑定组织")}</select></label></div><div class="two-col"><label class="field"><span>角色类型</span><select name="role_type">${enumOptions(["customer", "fae", "ae", "rd", "pm", "tester", "other"], current?.role_type || "other", roleTypeLabel)}</select></label><label class="field"><span>角色名称</span><input name="role_name" value="${esc(current?.role_name || "")}" /></label></div><label class="field"><span>职责范围</span><textarea name="scope_description" style="min-height:100px">${esc(current?.scope_description || "")}</textarea></label><div class="two-col"><label class="field"><span>开始日期</span><input name="valid_from" type="date" value="${esc(current?.valid_from || "")}" /></label><label class="field"><span>结束日期</span><input name="valid_to" type="date" value="${esc(current?.valid_to || "")}" /></label></div><div class="two-col"><label class="field"><span>来源</span><select name="source_type">${enumOptions(["manual", "meeting", "project", "imported"], current?.source_type || "manual", sourceTypeLabel)}</select></label><label class="field"><span>置信度</span><input name="confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.confidence ?? 0.6)}" /></label></div><label class="inline-check"><input name="is_primary" type="checkbox" ${current?.is_primary ? "checked" : ""} />主要角色</label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-person-role">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-person-role">${icon("save")}保存</button>`));
  const card = $("#modalCard");
  $("[data-modal-action=save-person-role]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        person_id: modalValue(card, "person_id"),
        organization_id: modalValue(card, "organization_id"),
        role_type: modalValue(card, "role_type"),
        role_name: modalValue(card, "role_name"),
        scope_description: modalValue(card, "scope_description"),
        valid_from: modalValue(card, "valid_from"),
        valid_to: modalValue(card, "valid_to"),
        is_primary: modalChecked(card, "is_primary"),
        source_type: modalValue(card, "source_type"),
        confidence: modalNumber(card, "confidence", 0.6)
      };
      const result = current ? await api(`person-roles/${id}`, { method: "PATCH", body }) : await api(`people/${body.person_id}/roles`, { method: "POST", body });
      closeModal();
      await refreshPeopleSelection({ personId: result.role?.person_id || body.person_id, tab: "people" });
      toast("角色已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-person-role]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个角色关系？")) return;
    try {
      await api(`person-roles/${id}`, { method: "DELETE" });
      closeModal();
      await refreshPeopleSelection({ personId: current.person_id, tab: "people" });
      toast("角色已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function openPersonExpertiseEditor(id = null, personId = "") {
  const current = id ? findInLists(id, [state.people.selectedPerson?.expertise]) : null;
  const activePersonId = current?.person_id || personId || state.people.selectedPersonId || "";
  if (!current && !activePersonId) return toast("请先选择人员", "error");
  showModal(modalShell(current ? "编辑专长" : "新增专长", "AI 提取出的专长默认应先保持待确认，确认后再作为长期人员能力使用。", `<div class="two-col"><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(activePersonId, false)}</select></label><label class="field"><span>专长名称</span><input name="expertise_name" required value="${esc(current?.expertise_name || "")}" /></label></div><div class="two-col"><label class="field"><span>分类</span><input name="expertise_category" value="${esc(current?.expertise_category || "")}" /></label><label class="field"><span>等级</span><select name="level">${enumOptions(["unknown", "familiar", "strong", "specialist"], current?.level || "unknown", expertiseLevelLabel)}</select></label></div><label class="field"><span>范围说明</span><textarea name="scope_description" style="min-height:100px">${esc(current?.scope_description || "")}</textarea></label><div class="two-col"><label class="field"><span>来源</span><select name="source_type">${enumOptions(["manual", "project", "meeting", "suggestion"], current?.source_type || "manual", sourceTypeLabel)}</select></label><label class="field"><span>来源 ID</span><input name="source_id" value="${esc(current?.source_id || "")}" /></label></div><div class="two-col"><label class="field"><span>置信度</span><input name="confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.confidence ?? 0.6)}" /></label><label class="field"><span>审核状态</span><select name="review_status">${enumOptions(["pending", "confirmed", "rejected", "suggested", "edited"], current?.review_status || "pending", reviewStatusLabel)}</select></label></div>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-person-expertise">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-person-expertise">${icon("save")}保存</button>`));
  const card = $("#modalCard");
  $("[data-modal-action=save-person-expertise]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        person_id: modalValue(card, "person_id"),
        expertise_name: modalValue(card, "expertise_name"),
        expertise_category: modalValue(card, "expertise_category"),
        level: modalValue(card, "level"),
        scope_description: modalValue(card, "scope_description"),
        source_type: modalValue(card, "source_type"),
        source_id: modalValue(card, "source_id"),
        confidence: modalNumber(card, "confidence", 0.6),
        review_status: modalValue(card, "review_status")
      };
      const result = current ? await api(`person-expertise/${id}`, { method: "PATCH", body }) : await api(`people/${body.person_id}/expertise`, { method: "POST", body });
      closeModal();
      await refreshPeopleSelection({ personId: result.expertise?.person_id || body.person_id, tab: "people" });
      toast("专长已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-person-expertise]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个专长记录？")) return;
    try {
      await api(`person-expertise/${id}`, { method: "DELETE" });
      closeModal();
      await refreshPeopleSelection({ personId: current.person_id, tab: "people" });
      toast("专长已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function openProjectPersonEditor(id = null, defaults = {}) {
  const current = id ? findInLists(id, [state.people.selectedPerson?.project_people, state.work.selectedProject?.project_people]) : null;
  const projectId = current?.project_id || defaults.projectId || state.work.selectedProjectId || "";
  const personId = current?.person_id || defaults.personId || state.people.selectedPersonId || "";
  showModal(modalShell(current ? "编辑项目人员关系" : "新增项目人员关系", "同一个人可以在不同项目中承担不同角色，也可以只负责某个模块。", `<div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(projectId, false)}</select></label><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(personId, false)}</select></label></div><div class="two-col"><label class="field"><span>关系类型</span><select name="relationship_type">${enumOptions(["customer_contact", "fae", "ae", "rd", "project_owner", "tester", "supporter", "other"], current?.relationship_type || "other", relationshipTypeLabel)}</select></label><label class="field"><span>负责模块</span><select name="module_id">${workModuleOptions(projectId, current?.module_id || "", true)}</select></label></div><label class="field"><span>责任说明</span><textarea name="responsibility" style="min-height:100px">${esc(current?.responsibility || "")}</textarea></label><div class="two-col"><label class="field"><span>开始日期</span><input name="valid_from" type="date" value="${esc(current?.valid_from || "")}" /></label><label class="field"><span>结束日期</span><input name="valid_to" type="date" value="${esc(current?.valid_to || "")}" /></label></div><div class="two-col"><label class="field"><span>状态</span><select name="status">${enumOptions(["active", "inactive", "proposed", "archived"], current?.status || "active", statusLabel)}</select></label><label class="field"><span>来源</span><select name="source_type">${enumOptions(["manual", "meeting", "project", "imported"], current?.source_type || "manual", sourceTypeLabel)}</select></label></div><label class="field"><span>置信度</span><input name="confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.confidence ?? 0.6)}" /></label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-project-person">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-project-person">${icon("save")}保存</button>`));
  const card = $("#modalCard");
  modalField(card, "project_id")?.addEventListener("change", (event) => {
    const moduleSelect = modalField(card, "module_id");
    if (moduleSelect) moduleSelect.innerHTML = workModuleOptions(event.target.value, "", true);
  });
  $("[data-modal-action=save-project-person]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        project_id: modalValue(card, "project_id"),
        person_id: modalValue(card, "person_id"),
        relationship_type: modalValue(card, "relationship_type"),
        responsibility: modalValue(card, "responsibility"),
        module_id: modalValue(card, "module_id"),
        valid_from: modalValue(card, "valid_from"),
        valid_to: modalValue(card, "valid_to"),
        status: modalValue(card, "status"),
        source_type: modalValue(card, "source_type"),
        confidence: modalNumber(card, "confidence", 0.6)
      };
      if (!body.project_id || !body.person_id) return toast("项目和人员都不能为空", "error");
      const result = current ? await api(`work/projects/${body.project_id}/people/${id}`, { method: "PATCH", body }) : await api(`work/projects/${body.project_id}/people`, { method: "POST", body });
      closeModal();
      await refreshPeopleAndWorkSelection({ personId: result.project_person?.person_id || body.person_id, projectId: result.project_person?.project_id || body.project_id });
      toast("项目人员关系已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-project-person]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个项目人员关系？")) return;
    try {
      await api(`work/projects/${current.project_id}/people/${id}`, { method: "DELETE" });
      closeModal();
      await refreshPeopleAndWorkSelection({ personId: current.person_id, projectId: current.project_id });
      toast("项目人员关系已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function openWorkItemPersonEditor(id = null, defaults = {}) {
  const current = id ? findInLists(id, [state.people.selectedPerson?.work_item_people, state.work.selectedItem?.work_item_people]) : null;
  const workItemId = current?.work_item_id || defaults.workItemId || state.work.selectedItemId || "";
  const personId = current?.person_id || defaults.personId || state.people.selectedPersonId || "";
  showModal(modalShell(current ? "编辑任务人员关系" : "新增任务人员关系", "用于记录具体任务、问题或需求和人员之间的责任关系。", `<div class="two-col"><label class="field"><span>任务</span><select name="work_item_id">${workItemOptions("", workItemId, false)}</select></label><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(personId, false)}</select></label></div><label class="field"><span>关系类型</span><select name="relation_type">${enumOptions(["owner", "assignee", "requester", "reviewer", "mentioned", "supporter", "waiting_on"], current?.relation_type || "mentioned", workItemRelationLabel)}</select></label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-item-person">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-item-person">${icon("save")}保存</button>`));
  const card = $("#modalCard");
  $("[data-modal-action=save-item-person]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        work_item_id: modalValue(card, "work_item_id"),
        person_id: modalValue(card, "person_id"),
        relation_type: modalValue(card, "relation_type")
      };
      if (!body.work_item_id || !body.person_id) return toast("任务和人员都不能为空", "error");
      const result = current ? await api(`work/items/${body.work_item_id}/people/${id}`, { method: "PATCH", body }) : await api(`work/items/${body.work_item_id}/people`, { method: "POST", body });
      closeModal();
      await refreshPeopleAndWorkSelection({ personId: result.work_item_person?.person_id || body.person_id, workItemId: result.work_item_person?.work_item_id || body.work_item_id });
      toast("任务人员关系已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-item-person]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个任务人员关系？")) return;
    try {
      await api(`work/items/${current.work_item_id}/people/${id}`, { method: "DELETE" });
      closeModal();
      await refreshPeopleAndWorkSelection({ personId: current.person_id, workItemId: current.work_item_id });
      toast("任务人员关系已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function openAudioRecordingEditor(id = null) {
  const current = id ? (state.audio.selectedRecording?.id === id ? state.audio.selectedRecording : (state.audio.recordings || []).find((item) => item.id === id)) : null;
  const body = current
    ? `<label class="field"><span>标题</span><input name="title" value="${esc(current.title || "")}" /></label><div class="two-col"><label class="field"><span>文件名</span><input name="file_name" value="${esc(current.file_name || "")}" /></label><label class="field"><span>MIME 类型</span><input name="mime_type" value="${esc(current.mime_type || "")}" /></label></div><div class="two-col"><label class="field"><span>大小 Bytes</span><input name="size_bytes" type="number" min="0" value="${esc(current.size_bytes || 0)}" /></label><label class="field"><span>时长 ms</span><input name="duration_ms" type="number" min="0" value="${esc(current.duration_ms ?? "")}" /></label></div><label class="field"><span>说明</span><textarea name="description" style="min-height:100px">${esc(current.description || "")}</textarea></label><div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(current.project_id || "", true, "未关联项目")}</select></label><label class="field"><span>来源</span><select name="source_type">${enumOptions(["upload", "meeting", "import", "manual"], current.source_type || "upload", sourceTypeLabel)}</select></label></div><div class="two-col"><label class="field"><span>处理模式</span><select name="processing_mode">${enumOptions(["external_ai", "platform_rules", "manual_only"], current.processing_mode || "manual_only", workModeLabel)}</select></label><label class="field"><span>模型</span><select name="requested_model_id">${activeModelOptions(current.requested_model_id || "")}</select></label></div><div class="two-col"><label class="field"><span>状态</span><select name="status">${enumOptions(["uploaded", "queued", "validating", "transcribing", "diarizing", "aligning", "review", "analyzing", "proposal_ready", "completed", "failed", "cancelled", "expired", "archived"], current.status || "uploaded", recordingStatusLabel)}</select></label><label class="field"><span>语言</span><input name="language" value="${esc(current.language || "")}" /></label></div><label class="field"><span>转写摘要</span><textarea name="transcript_summary" style="min-height:120px">${esc(current.transcript_summary || "")}</textarea></label><div class="two-col"><label class="field"><span>错误代码</span><input name="error_code" value="${esc(current.error_code || "")}" /></label><label class="field"><span>错误信息</span><input name="error_message" value="${esc(current.error_message || "")}" /></label></div>`
    : `<form id="audioUploadForm"><label class="field"><span>音频文件</span><input name="file" type="file" accept="audio/*,video/mp4,video/webm" required /></label><div class="two-col"><label class="field"><span>标题</span><input name="title" placeholder="不填则按文件名生成" /></label><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(state.work.selectedProjectId || "", true, "未关联项目")}</select></label></div><label class="field"><span>说明</span><textarea name="description" style="min-height:100px"></textarea></label><div class="two-col"><label class="field"><span>来源</span><select name="source_type">${enumOptions(["upload", "meeting", "import", "manual"], "upload", sourceTypeLabel)}</select></label><label class="field"><span>处理模式</span><select name="processing_mode">${enumOptions(["external_ai", "platform_rules", "manual_only"], "manual_only", workModeLabel)}</select></label></div><div class="two-col"><label class="field"><span>模型</span><select name="requested_model_id">${activeModelOptions("")}</select></label><label class="field"><span>语言</span><input name="language" placeholder="zh-CN" /></label></div><label class="field"><span>时长 ms（可选）</span><input name="duration_ms" type="number" min="0" /></label></form>`;
  showModal(modalShell(current ? "编辑录音" : "上传录音", "录音文件保存到 R2，D1 只保存元数据和处理状态。", body, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-audio-recording">${icon(current ? "save" : "upload")} ${current ? "保存" : "上传"}</button>`), "modal-wide");
  $("[data-modal-action=save-audio-recording]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      let result;
      if (current) {
        const patchBody = {
          title: modalValue(card, "title"),
          file_name: modalValue(card, "file_name"),
          mime_type: modalValue(card, "mime_type"),
          size_bytes: modalNumber(card, "size_bytes", current.size_bytes || 0),
          duration_ms: modalNumber(card, "duration_ms", current.duration_ms ?? null),
          description: modalValue(card, "description"),
          project_id: modalValue(card, "project_id"),
          source_type: modalValue(card, "source_type"),
          processing_mode: modalValue(card, "processing_mode"),
          requested_model_id: modalValue(card, "requested_model_id"),
          status: modalValue(card, "status"),
          language: modalValue(card, "language"),
          transcript_summary: modalValue(card, "transcript_summary"),
          error_code: modalValue(card, "error_code"),
          error_message: modalValue(card, "error_message")
        };
        result = await api(`work/audio/${id}`, { method: "PATCH", body: patchBody });
      } else {
        const form = $("#audioUploadForm");
        if (!form?.reportValidity()) return;
        result = await api("work/audio/upload", { method: "POST", body: new FormData(form) });
      }
      closeModal();
      await refreshAudioSelection({ recordingId: result.recording?.id || id, tab: "recordings" });
      toast(current ? "录音已更新" : "录音已上传");
    } catch (error) {
      handleError(error);
    }
  });
}

function openAudioMeetingEditor(id = null) {
  const current = id ? (state.audio.selectedMeeting?.id === id ? state.audio.selectedMeeting : (state.audio.meetings || []).find((item) => item.id === id)) : null;
  const selectedIds = current?.selected_project_ids || (state.audio.selectedRecording?.project_id ? [state.audio.selectedRecording.project_id] : []);
  showModal(modalShell(current ? "编辑会议" : "新建会议", "会议可以绑定录音和多个项目，后续主题、参会人和提案都挂在这里。", `<div class="two-col"><label class="field"><span>标题</span><input name="title" value="${esc(current?.title || "")}" /></label><label class="field"><span>关联录音</span><select name="recording_id">${audioRecordingOptions(current?.recording_id || state.audio.selectedRecordingId || "", true, "不绑定录音")}</select></label></div><div class="two-col"><label class="field"><span>会议日期</span><input name="meeting_date" type="date" value="${esc(current?.meeting_date || "")}" /></label><label class="field"><span>类型</span><select name="meeting_type">${enumOptions(["customer", "internal", "project", "support", "other"], current?.meeting_type || "other", meetingTypeLabel)}</select></label></div><div class="two-col"><label class="field"><span>参会人状态</span><select name="participant_status">${enumOptions(["unknown", "partial", "confirmed"], current?.participant_status || "unknown", statusLabel)}</select></label><label class="field"><span>会议状态</span><select name="status">${enumOptions(["draft", "review", "approved", "archived"], current?.status || "draft", statusLabel)}</select></label></div><div class="field"><span>关联项目</span><div class="check-list work-project-picks">${selectedProjectCheckboxes(selectedIds)}</div></div><label class="field"><span>摘要</span><textarea name="summary" style="min-height:160px">${esc(current?.summary || "")}</textarea></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-audio-meeting">${icon("save")}保存</button>`), "modal-wide");
  $("[data-modal-action=save-audio-meeting]", $("#modalCard"))?.addEventListener("click", async () => {
    const card = $("#modalCard");
    try {
      const body = {
        recording_id: modalValue(card, "recording_id"),
        title: modalValue(card, "title"),
        meeting_date: modalValue(card, "meeting_date"),
        meeting_type: modalValue(card, "meeting_type"),
        selected_project_ids_json: $$("[name=selected_project_ids]:checked", card).map((input) => input.value),
        participant_status: modalValue(card, "participant_status"),
        summary: modalValue(card, "summary"),
        status: modalValue(card, "status")
      };
      const result = current ? await api(`work/meetings/${id}`, { method: "PATCH", body }) : await api("work/meetings", { method: "POST", body });
      closeModal();
      await refreshAudioSelection({ meetingId: result.meeting?.id || id, tab: "meetings" });
      toast(current ? "会议已更新" : "会议已创建");
    } catch (error) {
      handleError(error);
    }
  });
}

async function openTranscriptSegmentEditor(id = null, recordingId = "") {
  const current = id ? findInLists(id, [state.audio.selectedRecording?.segments, state.audio.selectedMeeting?.segments]) || (await api(`work/transcript-segments/${id}`)).transcript_segment : null;
  const activeRecordingId = current?.recording_id || recordingId || state.audio.selectedRecordingId || state.audio.selectedMeeting?.recording_id || "";
  if (!current && !activeRecordingId) return toast("请先选择录音", "error");
  showModal(modalShell(current ? "编辑转写片段" : "新增转写片段", "片段保存说话人、时间戳、文本和审核状态，作为后续提取的证据来源。", `<div class="two-col"><label class="field"><span>序号</span><input name="segment_index" type="number" min="1" value="${esc(current?.segment_index || 1)}" /></label><label class="field"><span>说话人标签</span><input name="speaker_label" value="${esc(current?.speaker_label || "Speaker A")}" /></label></div><div class="two-col"><label class="field"><span>开始 ms</span><input name="start_ms" type="number" min="0" value="${esc(current?.start_ms ?? "")}" /></label><label class="field"><span>结束 ms</span><input name="end_ms" type="number" min="0" value="${esc(current?.end_ms ?? "")}" /></label></div><div class="two-col"><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(current?.person_id || "", true, "未知人员")}</select></label><label class="field"><span>语言</span><input name="language" value="${esc(current?.language || "")}" /></label></div><label class="field"><span>文本</span><textarea name="text" required style="min-height:180px">${esc(current?.text || "")}</textarea></label><div class="two-col"><label class="field"><span>ASR 置信度</span><input name="asr_confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.asr_confidence ?? "")}" /></label><label class="field"><span>审核状态</span><select name="review_status">${enumOptions(["pending", "confirmed", "rejected", "suggested", "edited"], current?.review_status || "pending", reviewStatusLabel)}</select></label></div><label class="inline-check"><input name="is_overlap" type="checkbox" ${current?.is_overlap ? "checked" : ""} />疑似多人重叠</label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-transcript-segment">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-transcript-segment">${icon("save")}保存</button>`), "modal-wide");
  const card = $("#modalCard");
  $("[data-modal-action=save-transcript-segment]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        recording_id: activeRecordingId,
        segment_index: modalNumber(card, "segment_index", current?.segment_index || 1),
        start_ms: modalNumber(card, "start_ms", null),
        end_ms: modalNumber(card, "end_ms", null),
        speaker_label: modalValue(card, "speaker_label"),
        person_id: modalValue(card, "person_id"),
        text: modalValue(card, "text"),
        asr_confidence: modalNumber(card, "asr_confidence", null),
        language: modalValue(card, "language"),
        is_overlap: modalChecked(card, "is_overlap"),
        review_status: modalValue(card, "review_status")
      };
      const result = current ? await api(`work/transcript-segments/${id}`, { method: "PATCH", body }) : await api(`work/audio/${activeRecordingId}/transcript/segments`, { method: "POST", body });
      closeModal();
      await refreshAudioSelection({ recordingId: result.transcript_segment?.recording_id || activeRecordingId });
      toast("转写片段已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-transcript-segment]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个转写片段？")) return;
    try {
      await api(`work/transcript-segments/${id}`, { method: "DELETE" });
      closeModal();
      await refreshAudioSelection({ recordingId: current.recording_id });
      toast("转写片段已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function openMeetingParticipantEditor(id = null, meetingId = "") {
  const current = id ? findInLists(id, [state.audio.selectedRecording?.participants, state.audio.selectedMeeting?.participants]) : null;
  const activeMeetingId = current?.meeting_id || meetingId || state.audio.selectedMeetingId || state.audio.selectedRecording?.meeting?.id || "";
  if (!current && !activeMeetingId) return toast("请先选择会议", "error");
  showModal(modalShell(current ? "编辑说话人/参会人" : "新增参会人", "Speaker 映射必须由你确认，平台不会把 Speaker A 自动永久识别成某个人。", `<div class="two-col"><label class="field"><span>人员</span><select name="person_id">${peoplePersonOptions(current?.person_id || "", true, "未知人员")}</select></label><label class="field"><span>Speaker 标签</span><input name="speaker_label" value="${esc(current?.speaker_label || "Speaker A")}" /></label></div><div class="two-col"><label class="field"><span>出席状态</span><select name="attendance_status">${enumOptions(["unknown", "present", "absent", "partial"], current?.attendance_status || "unknown", attendanceStatusLabel)}</select></label><label class="field"><span>识别方式</span><select name="identification_method">${enumOptions(["manual", "name_match", "voice_match", "suggested"], current?.identification_method || "manual", identificationMethodLabel)}</select></label></div><label class="field"><span>置信度</span><input name="confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.confidence ?? 0.5)}" /></label><label class="inline-check"><input name="confirmed" type="checkbox" ${current?.confirmed_at ? "checked" : ""} />已人工确认</label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-meeting-participant">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-meeting-participant">${icon("save")}保存</button>`));
  const card = $("#modalCard");
  $("[data-modal-action=save-meeting-participant]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        meeting_id: activeMeetingId,
        person_id: modalValue(card, "person_id"),
        speaker_label: modalValue(card, "speaker_label"),
        attendance_status: modalValue(card, "attendance_status"),
        identification_method: modalValue(card, "identification_method"),
        confidence: modalNumber(card, "confidence", 0.5),
        confirmed_at: modalChecked(card, "confirmed") ? (current?.confirmed_at || Date.now()) : null
      };
      const result = current ? await api(`work/speakers/${id}`, { method: "PATCH", body }) : await api(`work/meetings/${activeMeetingId}/participants`, { method: "POST", body });
      closeModal();
      await refreshAudioSelection({ meetingId: result.participant?.meeting_id || activeMeetingId });
      toast("参会人已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-meeting-participant]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个参会人记录？")) return;
    try {
      await api(`work/speakers/${id}`, { method: "DELETE" });
      closeModal();
      await refreshAudioSelection({ meetingId: current.meeting_id });
      toast("参会人已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

async function openMeetingTopicEditor(id = null, meetingId = "") {
  const current = id ? findInLists(id, [state.audio.selectedRecording?.topics, state.audio.selectedMeeting?.topics]) || (await api(`work/topics/${id}`)).topic : null;
  const activeMeetingId = current?.meeting_id || meetingId || state.audio.selectedMeetingId || state.audio.selectedRecording?.meeting?.id || "";
  if (!current && !activeMeetingId) return toast("请先选择会议", "error");
  showModal(modalShell(current ? "编辑会议主题" : "新增会议主题", "主题应尽量保留项目、模块、时间戳和审核状态，便于回看证据。", `<div class="two-col"><label class="field"><span>标题</span><input name="title" required value="${esc(current?.title || "")}" /></label><label class="field"><span>类型</span><select name="topic_type">${enumOptions(["project_progress", "issue", "decision", "requirement", "resource", "schedule", "other"], current?.topic_type || "other", topicTypeLabel)}</select></label></div><label class="field"><span>摘要</span><textarea name="summary" style="min-height:140px">${esc(current?.summary || "")}</textarea></label><div class="two-col"><label class="field"><span>开始 ms</span><input name="start_ms" type="number" min="0" value="${esc(current?.start_ms ?? "")}" /></label><label class="field"><span>结束 ms</span><input name="end_ms" type="number" min="0" value="${esc(current?.end_ms ?? "")}" /></label></div><div class="two-col"><label class="field"><span>项目</span><select name="project_id">${workProjectOptions(current?.project_id || "", true, "未关联项目")}</select></label><label class="field"><span>模块</span><select name="module_id">${workModuleOptions(current?.project_id || "", current?.module_id || "", true)}</select></label></div><div class="two-col"><label class="field"><span>置信度</span><input name="confidence" type="number" min="0" max="1" step="0.05" value="${esc(current?.confidence ?? 0.5)}" /></label><label class="field"><span>审核状态</span><select name="review_status">${enumOptions(["pending", "confirmed", "rejected", "suggested", "edited"], current?.review_status || "pending", reviewStatusLabel)}</select></label></div><label class="field"><span>排序</span><input name="sort_order" type="number" min="0" value="${esc(current?.sort_order ?? 100)}" /></label>`, `<button class="button" data-close-modal>取消</button>${current ? `<button class="button button-danger" data-modal-action="delete-meeting-topic">${icon("trash-2")}删除</button>` : ""}<button class="button button-primary" data-modal-action="save-meeting-topic">${icon("save")}保存</button>`), "modal-wide");
  const card = $("#modalCard");
  modalField(card, "project_id")?.addEventListener("change", (event) => {
    const moduleSelect = modalField(card, "module_id");
    if (moduleSelect) moduleSelect.innerHTML = workModuleOptions(event.target.value, "", true);
  });
  $("[data-modal-action=save-meeting-topic]", card)?.addEventListener("click", async () => {
    try {
      const body = {
        meeting_id: activeMeetingId,
        title: modalValue(card, "title"),
        summary: modalValue(card, "summary"),
        start_ms: modalNumber(card, "start_ms", null),
        end_ms: modalNumber(card, "end_ms", null),
        project_id: modalValue(card, "project_id"),
        module_id: modalValue(card, "module_id"),
        topic_type: modalValue(card, "topic_type"),
        confidence: modalNumber(card, "confidence", 0.5),
        review_status: modalValue(card, "review_status"),
        sort_order: modalNumber(card, "sort_order", 100)
      };
      const result = current ? await api(`work/topics/${id}`, { method: "PATCH", body }) : await api(`work/meetings/${activeMeetingId}/topics`, { method: "POST", body });
      closeModal();
      await refreshAudioSelection({ meetingId: result.topic?.meeting_id || activeMeetingId });
      toast("会议主题已保存");
    } catch (error) {
      handleError(error);
    }
  });
  $("[data-modal-action=delete-meeting-topic]", card)?.addEventListener("click", async () => {
    if (!window.confirm("删除这个会议主题？")) return;
    try {
      await api(`work/topics/${id}`, { method: "DELETE" });
      closeModal();
      await refreshAudioSelection({ meetingId: current.meeting_id });
      toast("会议主题已删除");
    } catch (error) {
      handleError(error);
    }
  });
}

function renderLibrary() {
  const docs = state.documents.filter((doc) => !state.libraryCategory || state.libraryCategory === "all" || doc.category_id === state.libraryCategory || state.categories.find((cat) => cat.id === doc.category_id)?.parent_id === state.libraryCategory);
  return `<div class="view-head"><div><h1>知识库</h1><p>正式资料、知识块和历史版本。</p></div><div class="view-actions"><button class="button" data-action="export-library">${icon("download")}导出 Markdown</button><button class="button button-primary" data-action="new-document">${icon("plus")}新建文档</button></div></div><div class="split-layout"><aside class="panel tree-panel"><span class="tree-heading">分类</span><button class="tree-item ${!state.libraryCategory || state.libraryCategory === "all" ? "active" : ""}" data-action="category-filter" data-id="all">${icon("layers-3")}全部资料</button>${state.categories.filter((cat) => !cat.deleted_at).map((cat) => `<button class="tree-item ${state.libraryCategory === cat.id ? "active" : ""} ${cat.parent_id ? "child" : ""}" data-action="category-filter" data-id="${esc(cat.id)}">${icon(cat.parent_id ? "corner-down-right" : "folder")}${esc(cat.name)}</button>`).join("")}</aside><section class="document-list">${docs.length ? docs.map(renderDocumentItem).join("") : empty("library", "这个分类还没有文档", "可以从收集箱整理一条资料，或直接新建文档")}</section></div>`;
}
function renderDocumentItem(doc) {
  const expanded = state.selectedDocument?.id === doc.id;
  const detailDoc = expanded ? state.selectedDocument : null;
  return `<div class="document-item ${expanded ? "expanded" : ""}">${renderDocumentCard(doc)}${detailDoc ? renderDocumentDetail(detailDoc, true) : ""}</div>`;
}
function renderDocumentCard(doc) {
  const expanded = state.selectedDocument?.id === doc.id;
  return `<article class="document-card ${expanded ? "selected" : ""}" data-action="document-detail" data-id="${esc(doc.id)}" aria-expanded="${expanded}"><div><h3>${esc(doc.title)}</h3><p>${esc(doc.summary || "暂无摘要")}</p><div class="card-meta"><span class="tag">${esc(doc.category_name || state.categories.find((cat) => cat.id === doc.category_id)?.name || "未分类")}</span><span class="tag">${esc(doc.block_count || 0)} 个知识块</span>${statusBadge(doc.status)}</div></div><div class="card-side"><span>${fmtTime(doc.updated_at)}</span>${icon(expanded ? "chevron-up" : "chevron-down")}</div></article>`;
}
function renderDocumentDetail(doc, inline = false) { return `<article class="detail-panel ${inline ? "inline-detail" : ""}"><div class="detail-head"><div><h2>${esc(doc.title)}</h2><p>${esc(doc.summary || "暂无摘要")} · ${esc(doc.tags?.join("、") || "无标签")}</p></div><div class="detail-actions"><button class="button button-small" data-action="edit-document" data-id="${esc(doc.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="new-block" data-id="${esc(doc.id)}">${icon("plus")}知识块</button><button class="icon-button" data-action="delete-document" data-id="${esc(doc.id)}" aria-label="删除文档" title="删除文档">${icon("trash-2")}</button></div></div><div class="block-stack">${doc.blocks?.length ? doc.blocks.map((block) => `<article class="knowledge-block"><div class="block-top"><div><h3>${esc(block.heading)}</h3><small>${statusLabel(block.status)} · 更新于 ${fmtTime(block.updated_at)}</small></div><div class="detail-actions"><button class="icon-button" data-action="edit-block" data-id="${esc(block.id)}" aria-label="编辑知识块" title="编辑知识块">${icon("pencil")}</button><button class="icon-button" data-action="versions" data-id="${esc(block.id)}" aria-label="查看历史版本" title="查看历史版本">${icon("history")}</button></div></div><div class="markdown-body">${markdown(block.body_md)}</div><p class="source-line">来源：${block.source_capture_id ? esc(block.source_capture_id) : "手动创建"}</p></article>`).join("") : empty("file-text", "文档还没有知识块", "添加一个知识块开始记录")}</div></article>`; }

function contextStatusText() {
  const statuses = state.contextSelection.statuses || ["current"];
  if (statuses.includes("archived") && statuses.length === 1) return "归档资料";
  if (statuses.includes("historical")) return "当前 + 历史";
  return "当前资料";
}

function contextSelectionSummary() {
  const selection = state.contextSelection;
  const parts = [];
  if (selection.category_ids?.length) parts.push(`${selection.category_ids.length} 个分类`);
  if (selection.document_ids?.length) parts.push(`${selection.document_ids.length} 篇文档`);
  if (selection.block_ids?.length) parts.push(`${selection.block_ids.length} 个知识块`);
  return `${parts.length ? `已选 ${parts.join("、")}` : "未限定范围，将使用全部知识块"} · ${contextStatusText()}`;
}

function contextPreviewBody(preview) {
  if (!preview) return empty("scan-text", "还没有预览", "选择资料并生成一次上下文");
  if (!preview.markdown) return empty("search-x", "当前筛选没有命中知识块", `${contextSelectionSummary()}。请确认所选范围下有对应状态的知识块，或切换资料状态后重试。`);
  return `<div class="markdown-body">${markdown(preview.markdown)}</div>`;
}

function syncContextSelectionFromDom() {
  const root = $("#viewRoot");
  if (!root) return;
  state.contextSelection.category_ids = $$("[data-context-category]:checked", root).map((input) => input.dataset.contextCategory);
  state.contextSelection.document_ids = $$("[data-context-document]:checked", root).map((input) => input.dataset.contextDocument);
  state.contextSelection.block_ids = $$("[data-context-block]:checked", root).map((input) => input.dataset.contextBlock);
  const status = $("#contextStatus", root)?.value;
  if (status) state.contextSelection.statuses = status.split(",");
}

function resetContextPreviewUi() {
  state.contextPreview = null;
  $(".context-selection-summary")?.replaceChildren(document.createTextNode(contextSelectionSummary()));
  const metrics = $(".context-metrics");
  if (metrics) metrics.innerHTML = `<span class="metric">选择资料后生成预览</span>`;
  const preview = $(".context-preview");
  if (preview) preview.innerHTML = empty("scan-text", "还没有预览", "选择资料并生成一次上下文");
  renderIcons();
}

function renderContext() {
  const selectedDocs = new Set(state.contextSelection.document_ids || []);
  const selectedBlocks = new Set(state.contextSelection.block_ids || []);
  const selectedCats = new Set(state.contextSelection.category_ids || []);
  const preview = state.contextPreview;
  const metrics = preview
    ? `<span class="metric"><strong>${esc(preview.item_count)}</strong> 个知识块</span><span class="metric"><strong>${esc(preview.character_count)}</strong> 字符</span><span class="metric"><strong>约 ${esc(preview.estimated_tokens)}</strong> tokens</span>${preview.truncated ? `<span class="status-badge historical">已按预算截断</span>` : ""}`
    : `<span class="metric">选择资料后生成预览</span>`;
  return `<div class="view-head"><div><h1>上下文生成</h1><p>从当前知识库选择资料，生成可复制或下载的上下文。</p></div><div class="view-actions"><button class="button" data-action="export-context" data-format="markdown">${icon("download")}下载 Markdown</button><button class="button button-primary" data-action="copy-context">${icon("copy")}复制结果</button></div></div><div class="context-layout"><aside class="panel context-controls"><h2>选择资料</h2><label class="field"><span>输出模式</span><select id="contextMode"><option value="full" ${state.contextMode === "full" ? "selected" : ""}>完整模式</option><option value="compact" ${state.contextMode === "compact" ? "selected" : ""}>精简模式</option><option value="custom" ${state.contextMode === "custom" ? "selected" : ""}>自定义预算</option></select></label>${state.contextMode === "custom" ? `<label class="field"><span>Token 预算</span><input id="contextBudget" type="number" min="100" max="200000" value="${esc(state.contextSelection.token_budget || 4000)}" /></label>` : ""}<label class="field"><span>资料状态</span><select id="contextStatus"><option value="current" ${state.contextSelection.statuses?.includes("current") ? "selected" : ""}>当前资料</option><option value="current,historical" ${state.contextSelection.statuses?.includes("historical") ? "selected" : ""}>当前 + 历史</option><option value="archived" ${state.contextSelection.statuses?.includes("archived") ? "selected" : ""}>归档资料</option></select></label><div class="context-selection-summary">${esc(contextSelectionSummary())}</div><div class="field"><span>按分类</span><div class="check-list">${state.categories.filter((cat) => !cat.deleted_at).map((cat) => `<label class="check-item"><input type="checkbox" data-context-category="${esc(cat.id)}" ${selectedCats.has(cat.id) ? "checked" : ""} /><span>${esc(cat.parent_id ? `　${cat.name}` : cat.name)}</span></label>`).join("")}</div></div><div class="field"><span>按文档</span><div class="check-list">${state.documents.slice(0, 120).map((doc) => `<label class="check-item"><input type="checkbox" data-context-document="${esc(doc.id)}" ${selectedDocs.has(doc.id) ? "checked" : ""} /><span>${esc(doc.title)}</span></label>`).join("")}</div></div><div class="field"><span>按知识块</span><div class="check-list">${state.blocks.slice(0, 180).map((block) => `<label class="check-item"><input type="checkbox" data-context-block="${esc(block.id)}" ${selectedBlocks.has(block.id) ? "checked" : ""} /><span>${esc(block.document_title)} / ${esc(block.heading)}</span></label>`).join("")}</div></div><button class="button button-primary button-wide" data-action="preview-context">${icon("scan-text")}生成预览</button></aside><section class="context-output"><div class="context-metrics">${metrics}</div><article class="context-preview">${contextPreviewBody(preview)}</article></section></div>`;
}

function renderSettings() {
  const tab = state.settingsTab;
  return `<div class="view-head"><div><h1>设置</h1><p>管理分类、模型路由、备份和系统状态。</p></div><div class="view-actions"><button class="button" data-action="export-backup">${icon("archive")}导出完整备份</button><button class="button" data-action="import-backup">${icon("upload")}导入备份</button></div></div><div class="settings-layout"><nav class="settings-nav"><button class="settings-tab ${tab === "providers" ? "active" : ""}" data-action="settings-tab" data-tab="providers">AI 服务商</button><button class="settings-tab ${tab === "models" ? "active" : ""}" data-action="settings-tab" data-tab="models">模型</button><button class="settings-tab ${tab === "routes" ? "active" : ""}" data-action="settings-tab" data-tab="routes">模型路由</button><button class="settings-tab ${tab === "system" ? "active" : ""}" data-action="settings-tab" data-tab="system">系统健康</button></nav><section class="settings-section">${tab === "providers" ? renderProviderSettings() : tab === "models" ? renderModelSettings() : tab === "routes" ? renderRouteSettings() : renderSystemSettings()}</section></div>`;
}
function renderProviderSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>AI 服务商</h2><p>密钥只在服务端加密保存，界面仅显示尾号。</p></div><button class="button button-primary button-small" data-action="new-provider">${icon("plus")}添加服务商</button></div>${!state.settings.encryption_configured ? `<div class="warning-box" style="margin-top:15px">${icon("key-round")}<span>Cloudflare 尚未配置 AI_CONFIG_ENCRYPTION_KEY，暂时不能保存第三方 API Key。</span></div>` : ""}<div class="provider-grid">${state.settings.providers.length ? state.settings.providers.map((provider) => `<div class="provider-card"><div><h3>${esc(provider.name)} ${statusBadge(provider.health_status)}</h3><p>${esc(providerPreset(provider.provider_type).label)} · ${esc(provider.base_url || "Workers AI binding")} · ${provider.key_configured ? esc(provider.api_key_masked) : "未配置 Key"}</p></div><div class="provider-actions"><button class="button button-small" data-action="test-provider" data-id="${esc(provider.id)}">${icon("plug-zap")}测试</button>${provider.provider_type === "cloudflare_ai" ? "" : `<button class="button button-small" data-action="sync-provider-models" data-id="${esc(provider.id)}">${icon("list-plus")}同步模型</button>`}<button class="button button-small" data-action="edit-provider" data-id="${esc(provider.id)}">${icon("pencil")}编辑</button><button class="icon-button" data-action="delete-provider" data-id="${esc(provider.id)}" aria-label="删除服务商" title="删除服务商">${icon("trash-2")}</button></div></div>`).join("") : empty("plug", "还没有服务商", "添加 DeepSeek、火山方舟或兼容 API")}</div></article>`; }
function renderModelSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>模型</h2><p>模型 ID 和能力配置来自数据库，部署后仍可调整。</p></div><button class="button button-primary button-small" data-action="new-model">${icon("plus")}添加模型</button></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>服务商</th><th>模型 ID</th><th>能力</th><th>状态</th><th></th></tr></thead><tbody>${state.settings.models.length ? state.settings.models.map((model) => `<tr><td><strong>${esc(model.display_name)}</strong></td><td>${esc(model.provider_name || "")}</td><td>${esc(model.model_id)}</td><td>${model.supports_structured_output ? "结构化 JSON" : "普通文本"}</td><td>${model.enabled ? statusBadge("healthy") : statusBadge("archived")}</td><td><button class="button button-small" data-action="edit-model" data-id="${esc(model.id)}">编辑</button></td></tr>`).join("") : `<tr><td colspan="6">暂无模型</td></tr>`}</tbody></table></div></article>`; }
function renderRouteSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>模型路由</h2><p>整理和压缩任务分别使用独立路由。</p></div></div><div class="provider-grid">${state.settings.routes.map((route) => `<div class="provider-card"><div><h3>${esc(route.task_type === "organize_capture" ? "整理收集" : "压缩上下文")}</h3><p>默认模型：${esc(route.default_model_name || "未配置")} · 超时 ${esc(route.timeout_ms)} ms · 重试 ${esc(route.max_retries)} 次</p></div><button class="button button-small" data-action="edit-route" data-task="${esc(route.task_type)}">${icon("sliders-horizontal")}调整</button></div>`).join("")}</div></article>`; }
function renderSystemSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>系统健康</h2><p>当前实例绑定、密钥和服务商状态。</p></div><button class="button button-small" data-action="health">${icon("refresh-cw")}检查</button></div><div id="healthResult" class="empty">${icon("activity")}<div><strong>尚未检查</strong><p>点击检查读取当前部署状态。</p></div></div><div class="setting-note">导出的 JSON 和 ZIP 不包含登录密钥、加密主密钥或第三方 API Key。导入也不会覆盖这些密钥。</div></article>`; }

function bindView() {
  $$("[data-action]").forEach((node) => node.addEventListener("click", () => runAction(node).catch(handleError)));
  $("#captureForm")?.addEventListener("submit", (event) => submitCapture(event).catch(handleError));
  $("#captureSearch")?.addEventListener("input", filterCaptures);
  $("#captureStateFilter")?.addEventListener("change", filterCaptures);
  $("#workDailyLogForm")?.addEventListener("submit", (event) => submitWorkDailyLog(event).catch(handleError));
  $$("[data-work-filter]").forEach((node) => {
    const eventName = node.tagName === "INPUT" ? "input" : "change";
    node.addEventListener(eventName, (event) => updateWorkFilter(event).catch(handleError));
  });
  $$("[data-people-filter]").forEach((node) => {
    const eventName = node.tagName === "INPUT" ? "input" : "change";
    node.addEventListener(eventName, (event) => updatePeopleFilter(event).catch(handleError));
  });
  $$("[data-audio-filter]").forEach((node) => {
    const eventName = node.tagName === "INPUT" ? "input" : "change";
    node.addEventListener(eventName, (event) => updateAudioFilter(event).catch(handleError));
  });
  $("#contextMode")?.addEventListener("change", (event) => { state.contextMode = event.target.value; state.contextPreview = null; render(); });
  $("#contextStatus")?.addEventListener("change", (event) => { state.contextSelection.statuses = event.target.value.split(","); resetContextPreviewUi(); });
  $$('[data-context-category], [data-context-document], [data-context-block]').forEach((input) => input.addEventListener("change", updateContextSelection));
}

async function runAction(node) {
  const action = node.dataset.action;
  const id = node.dataset.id;
  if (action === "goto") return setView(node.dataset.viewTarget);
  if (action === "web-ai-assist") return openWebAiAssist(node);
  if (action === "refresh-review") { state.selectedProposal = null; await Promise.all([loadDashboard(), loadCaptures(), loadProposals()]); render(); return; }
  if (action === "capture-detail") return openCapture(id);
  if (action === "proposal-detail") { state.selectedProposal = (await api(`proposals/${id}`)).proposal; setView("review"); return; }
  if (action === "apply-proposal") { await api(`proposals/${id}/apply`, { method: "POST", body: {} }); toast("提案已应用"); await refreshReviewState(id); setView("review"); return; }
  if (action === "reject-proposal") { if (!window.confirm("确定拒绝这条提案的全部操作吗？")) return; await api(`proposals/${id}/reject`, { method: "POST", body: {} }); toast("提案已拒绝"); await refreshReviewState(id); setView("review"); return; }
  if (action === "apply-operation") { const result = await api(`proposals/${node.dataset.proposal}/apply`, { method: "POST", body: { operation_ids: [id] } }); toast("操作已接受"); await refreshReviewState(node.dataset.proposal, result.proposal); setView("review"); return; }
  if (action === "reject-operation") { await api(`proposal-operations/${id}`, { method: "PATCH", body: { status: "rejected" } }); toast("操作已拒绝"); await refreshReviewState(state.selectedProposal?.id || ""); setView("review"); return; }
  if (action === "edit-operation") return openOperationEditor(id);
  if (action === "work-tab") { state.workTab = node.dataset.tab || "today"; await syncWorkViewSelection(); return; }
  if (action === "work-project-new") return openWorkProjectEditor();
  if (action === "work-project-detail") return openWorkProject(id);
  if (action === "work-project-edit") return openWorkProjectEditor(id);
  if (action === "work-project-delete") {
    if (!window.confirm("归档这个项目？相关模块和任务也会一起归档。")) return;
    await api(`work/projects/${id}`, { method: "DELETE" });
    await refreshWorkState();
    toast("项目已归档");
    return;
  }
  if (action === "work-module-new") return openWorkModuleEditor(null, node.dataset.project || state.work.selectedProjectId || "");
  if (action === "work-module-detail") return openWorkModule(id);
  if (action === "work-module-edit") return openWorkModuleEditor(id);
  if (action === "work-module-delete") {
    if (!window.confirm("归档这个模块？相关任务也会一起归档。")) return;
    await api(`work/modules/${id}`, { method: "DELETE" });
    await refreshWorkState();
    toast("模块已归档");
    return;
  }
  if (action === "work-item-new") return openWorkItemEditor(null, node.dataset.project || state.work.selectedProjectId || "", node.dataset.module || "");
  if (action === "work-item-detail") return openWorkItem(id);
  if (action === "work-item-edit") return openWorkItemEditor(id);
  if (action === "work-item-delete") {
    if (!window.confirm("归档这条任务或问题？")) return;
    await api(`work/items/${id}`, { method: "DELETE" });
    await refreshWorkState();
    toast("任务已归档");
    return;
  }
  if (action === "work-milestone-new") return openWorkMilestoneEditor(null, node.dataset.project || state.work.selectedProjectId || "");
  if (action === "work-milestone-detail") return openWorkMilestone(id);
  if (action === "work-milestone-edit") return openWorkMilestoneEditor(id);
  if (action === "work-milestone-history") return openWorkHistory("milestone", id);
  if (action === "work-milestone-delete") {
    if (!window.confirm("删除这个里程碑？")) return;
    await api(`work/milestones/${id}`, { method: "DELETE" });
    await refreshWorkState();
    toast("里程碑已删除");
    return;
  }
  if (action === "work-log-new") { state.workTab = "today"; render(); requestAnimationFrame(focusWorkDailyLogForm); return; }
  if (action === "work-log-detail") return openWorkLog(id);
  if (action === "work-log-edit") return openWorkLogEditor(id);
  if (action === "work-log-generate") { await api(`work/daily-logs/${id}/retry`, { method: "POST", body: {} }); await refreshWorkState(); toast("日报已重新生成"); return; }
  if (action === "work-log-copy" || action === "work-copy-daily") { await copyWorkDailyOutput(id, node.dataset.format || "concise"); return; }
  if (action === "work-log-export") { await downloadWorkExport("markdown"); return; }
  if (action === "work-history" || action === "work-milestone-history") return openWorkHistory(node.dataset.entity || "milestone", id);
  if (action === "work-history-restore") {
    if (!window.confirm("恢复这个历史版本吗？当前版本会先保存一份历史。")) return;
    const original = node.innerHTML;
    try {
      node.disabled = true;
      node.innerHTML = `${icon("loader-circle")}恢复中`;
      renderIcons();
      await api(`work/entities/${node.dataset.entity}/${node.dataset.entityId}/restore/${node.dataset.versionId}`, { method: "POST", body: {} });
      closeModal();
      await refreshWorkState();
      toast("历史版本已恢复");
    } finally {
      node.disabled = false;
      node.innerHTML = original;
      renderIcons();
    }
    return;
  }
  if (action === "work-proposal-apply") { await api(`work/proposals/${id}/apply`, { method: "POST", body: { operation_ids: [id] } }); await refreshWorkState(); toast("提案已接受"); return; }
  if (action === "work-proposal-reject") { await api(`work/proposals/${id}/reject`, { method: "POST", body: {} }); await refreshWorkState(); toast("提案已拒绝"); return; }
  if (action === "people-tab") { state.peopleTab = node.dataset.tab || "people"; await syncPeopleViewSelection(); return; }
  if (action === "person-detail") {
    state.peopleTab = "people";
    state.people.selectedPersonId = id;
    state.people.selectedPerson = null;
    if (state.view !== "people") setView("people"); else await syncPeopleViewSelection();
    return;
  }
  if (action === "organization-detail") {
    state.peopleTab = "organizations";
    state.people.selectedOrganizationId = id;
    state.people.selectedOrganization = null;
    if (state.view !== "people") setView("people"); else await syncPeopleViewSelection();
    return;
  }
  if (action === "people-person-new") return openPeoplePersonEditor(null, node.dataset.organization || "");
  if (action === "people-person-edit") return openPeoplePersonEditor(id);
  if (action === "people-person-delete") {
    if (!window.confirm("删除这个人员档案？相关历史记录会保留引用。")) return;
    await api(`people/${id}`, { method: "DELETE" });
    state.people.selectedPersonId = "";
    state.people.selectedPerson = null;
    await refreshPeopleSelection({ tab: "people" });
    toast("人员已删除");
    return;
  }
  if (action === "people-organization-new") return openPeopleOrganizationEditor(null, node.dataset.parent || "");
  if (action === "people-organization-edit") return openPeopleOrganizationEditor(id);
  if (action === "people-organization-delete") {
    if (!window.confirm("删除这个组织？组织下仍有人员时后端会拒绝删除。")) return;
    await api(`organizations/${id}`, { method: "DELETE" });
    state.people.selectedOrganizationId = "";
    state.people.selectedOrganization = null;
    await refreshPeopleSelection({ tab: "organizations" });
    toast("组织已删除");
    return;
  }
  if (action === "person-role-new") return openPersonRoleEditor(null, id || node.dataset.person || state.people.selectedPersonId || "");
  if (action === "person-role-edit") return openPersonRoleEditor(id);
  if (action === "person-expertise-new") return openPersonExpertiseEditor(null, id || node.dataset.person || state.people.selectedPersonId || "");
  if (action === "person-expertise-edit") return openPersonExpertiseEditor(id);
  if (action === "project-person-new") return openProjectPersonEditor(null, { projectId: node.dataset.project || state.work.selectedProjectId || "", personId: node.dataset.person || state.people.selectedPersonId || "" });
  if (action === "project-person-edit") return openProjectPersonEditor(id);
  if (action === "item-person-new") return openWorkItemPersonEditor(null, { workItemId: node.dataset.item || state.work.selectedItemId || "", personId: node.dataset.person || state.people.selectedPersonId || "" });
  if (action === "item-person-edit") return openWorkItemPersonEditor(id);
  if (action === "audio-tab") { state.audioTab = node.dataset.tab || "recordings"; await syncAudioViewSelection(); return; }
  if (action === "audio-recording-detail") {
    state.audioTab = "recordings";
    state.audio.selectedRecordingId = id;
    state.audio.selectedRecording = null;
    if (state.view !== "audio") setView("audio"); else await syncAudioViewSelection();
    return;
  }
  if (action === "audio-meeting-detail") {
    state.audioTab = "meetings";
    state.audio.selectedMeetingId = id;
    state.audio.selectedMeeting = null;
    if (state.view !== "audio") setView("audio"); else await syncAudioViewSelection();
    return;
  }
  if (action === "audio-recording-new") return openAudioRecordingEditor();
  if (action === "audio-recording-edit") return openAudioRecordingEditor(id);
  if (action === "audio-recording-delete") {
    if (!window.confirm("删除这个录音？原始文件、转写片段和关联会议会一起归档或删除。")) return;
    await api(`work/audio/${id}`, { method: "DELETE" });
    state.audio.selectedRecordingId = "";
    state.audio.selectedRecording = null;
    await refreshAudioSelection({ tab: "recordings" });
    toast("录音已删除");
    return;
  }
  if (action === "audio-recording-process" || action === "audio-recording-retry" || action === "audio-recording-cancel") {
    const endpoint = action === "audio-recording-process" ? "process" : action === "audio-recording-retry" ? "retry" : "cancel";
    await api(`work/audio/${id}/${endpoint}`, { method: "POST", body: {} });
    await refreshAudioSelection({ recordingId: id, tab: "recordings" });
    toast(endpoint === "cancel" ? "处理已取消" : endpoint === "retry" ? "已发起重试" : "已发起处理");
    return;
  }
  if (action === "audio-meeting-new") return openAudioMeetingEditor();
  if (action === "audio-meeting-edit") return openAudioMeetingEditor(id);
  if (action === "audio-meeting-delete") {
    if (!window.confirm("删除这个会议？参会人、主题和互动记录会一起归档。")) return;
    await api(`work/meetings/${id}`, { method: "DELETE" });
    state.audio.selectedMeetingId = "";
    state.audio.selectedMeeting = null;
    await refreshAudioSelection({ tab: "meetings" });
    toast("会议已删除");
    return;
  }
  if (action === "audio-meeting-analyze") {
    await api(`work/meetings/${id}/analyze`, { method: "POST", body: {} });
    await refreshAudioSelection({ meetingId: id, tab: "meetings" });
    toast("会议已进入分析审核");
    return;
  }
  if (action === "audio-meeting-confirm") {
    await api(`work/meetings/${id}/confirm-participants`, { method: "POST", body: {} });
    await refreshAudioSelection({ meetingId: id, tab: "meetings" });
    toast("参会人已确认");
    return;
  }
  if (action === "audio-transcript-new") return openTranscriptSegmentEditor(null, node.dataset.recording || state.audio.selectedRecordingId || state.audio.selectedMeeting?.recording_id || "");
  if (action === "audio-speaker-new") return openMeetingParticipantEditor(null, node.dataset.meeting || state.audio.selectedMeetingId || state.audio.selectedRecording?.meeting?.id || "");
  if (action === "audio-topic-new") return openMeetingTopicEditor(null, node.dataset.meeting || state.audio.selectedMeetingId || state.audio.selectedRecording?.meeting?.id || "");
  if (action === "transcript-segment-edit") return openTranscriptSegmentEditor(id);
  if (action === "audio-speaker-edit") return openMeetingParticipantEditor(id);
  if (action === "audio-topic-edit") return openMeetingTopicEditor(id);
  if (action === "category-filter") { state.libraryCategory = node.dataset.id; state.selectedDocument = null; render(); return; }
  if (action === "document-detail") {
    if (state.selectedDocument?.id === id) {
      state.selectedDocument = null;
      render();
      return;
    }
    state.selectedDocument = (await api(`documents/${id}`)).document;
    render();
    return;
  }
  if (action === "new-document") return openDocumentEditor();
  if (action === "edit-document") return openDocumentEditor(id);
  if (action === "delete-document") { if (!window.confirm("删除文档及其知识块？资料会先进入软删除状态。")) return; await api(`documents/${id}`, { method: "DELETE" }); toast("文档已删除"); state.selectedDocument = null; await refreshKnowledgeState(); render(); return; }
  if (action === "new-block") return openBlockEditor(null, id);
  if (action === "edit-block") return openBlockEditor(id);
  if (action === "versions") return openVersions(id);
  if (action === "export-library") return downloadFile("export/markdown", `nanstar-context-${Date.now()}.md`);
  if (action === "preview-context") return previewContext();
  if (action === "copy-context") return copyContext();
  if (action === "export-context") return downloadContext(node.dataset.format || "markdown");
  if (action === "settings-tab") { state.settingsTab = node.dataset.tab; render(); return; }
  if (action === "new-provider") return openProviderEditor();
  if (action === "edit-provider") return openProviderEditor(id);
  if (action === "test-provider") { await api(`settings/ai/providers/${id}/test`, { method: "POST", body: {} }); toast("服务商连接正常"); await Promise.all([loadSettings(), loadDashboard()]); render(); return; }
  if (action === "sync-provider-models") { const result = await api(`settings/ai/providers/${id}/models/sync`, { method: "POST", body: {} }); await Promise.all([loadSettings(), loadDashboard()]); toast(`已同步 ${result.model_ids?.length || 0} 个模型，新增 ${result.created || 0} 个`); render(); return; }
  if (action === "delete-provider") { if (!window.confirm("删除这个服务商配置？")) return; await api(`settings/ai/providers/${id}`, { method: "DELETE" }); toast("服务商已删除"); await Promise.all([loadSettings(), loadDashboard()]); render(); return; }
  if (action === "new-model") return openModelEditor();
  if (action === "edit-model") return openModelEditor(id);
  if (action === "edit-route") return openRouteEditor(node.dataset.task);
  if (action === "health") return checkHealth();
  if (action === "export-backup") return downloadFile("export/zip", `nanstar-context-backup-${Date.now()}.zip`);
  if (action === "import-backup") return openImport();
}

function filterCaptures() {
  const query = ($( "#captureSearch")?.value || "").toLowerCase().trim();
  const status = $("#captureStateFilter")?.value || "";
  const rows = state.captures.filter((item) => (!status || item.state === status) && (!query || String(item.raw_text).toLowerCase().includes(query) || String(item.cleaned_text).toLowerCase().includes(query)));
  const root = $("#captureList"); if (root) root.innerHTML = captureRows(rows); renderIcons();
  $$("#captureList [data-action]").forEach((node) => node.addEventListener("click", () => runAction(node).catch(handleError)));
}

function updateContextSelection(event) {
  const input = event.target;
  const field = input.dataset.contextCategory ? "category_ids" : input.dataset.contextDocument ? "document_ids" : "block_ids";
  const value = input.dataset.contextCategory || input.dataset.contextDocument || input.dataset.contextBlock;
  const values = new Set(state.contextSelection[field] || []);
  if (input.checked) values.add(value); else values.delete(value);
  state.contextSelection[field] = [...values];
  resetContextPreviewUi();
}

async function submitCapture(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = $("button[type=submit]", form); button.disabled = true; button.innerHTML = `${icon("loader-circle")}整理中`;
  const note = $("#capturePrivacyNote");
  const originalNote = note?.textContent || "";
  const progressNotes = [
    "正在保存原始输入，并准备整理请求。",
    "正在请求外部 AI；中转站排队和模型思考都会计入服务商超时。",
    "仍在等待服务商返回；如果超过超时，会记录具体失败原因。",
    "长推理模型可能较慢，稍后也可以在收集箱查看运行记录。"
  ];
  let progressIndex = 0;
  if (note) note.textContent = progressNotes[progressIndex];
  const progressTimer = window.setInterval(() => {
    progressIndex = Math.min(progressIndex + 1, progressNotes.length - 1);
    if (note) note.textContent = progressNotes[progressIndex];
  }, 12000);
  try {
    await api("captures", { method: "POST", body: { raw_text: data.get("raw_text"), processing_mode: data.get("processing_mode"), preferred_category_id: data.get("preferred_category_id"), requested_model_id: data.get("requested_model_id"), organize: true } });
    toast("整理完成，已生成待审核提案"); await loadCore(); setView("review");
  } catch (error) {
    await loadCore().catch(() => {});
    render();
    throw error;
  } finally { window.clearInterval(progressTimer); if (note) note.textContent = originalNote; button.disabled = false; button.innerHTML = `${icon("sparkles")}保存并整理`; renderIcons(); }
}

async function openWebAiAssist(trigger) {
  const form = $("#captureForm");
  if (!form || !form.reportValidity()) return;
  const data = new FormData(form);
  const original = trigger.innerHTML;
  try {
    trigger.disabled = true;
    trigger.innerHTML = `${icon("loader-circle")}生成中`;
    renderIcons();
    const result = await api("captures/web-ai-prompt", {
      method: "POST",
      body: {
        raw_text: data.get("raw_text"),
        preferred_category_id: data.get("preferred_category_id")
      }
    });
    openWebAiAssistModal(result.capture, result.prompt);
    await Promise.all([loadDashboard(), loadCaptures()]);
    updateCounts();
  } catch (error) {
    handleError(error);
  } finally {
    trigger.disabled = false;
    trigger.innerHTML = original;
    renderIcons();
  }
}

function openWebAiAssistModal(capture, prompt) {
  showModal(modalShell("网页 AI 辅助整理", "复制 Prompt 到网页版 AI，再把 JSON 回复粘贴回来", `<div class="web-ai-flow"><div class="web-ai-links"><button class="button" data-modal-action="copy-web-ai-prompt">${icon("copy")}复制 Prompt</button><a class="button" href="https://chat.deepseek.com/" target="_blank" rel="noreferrer">${icon("external-link")}DeepSeek</a><a class="button" href="https://www.doubao.com/chat/" target="_blank" rel="noreferrer">${icon("external-link")}豆包</a></div><label class="field"><span>Prompt</span><textarea id="webAiPrompt" class="web-ai-textarea" readonly>${esc(prompt)}</textarea></label><label class="field"><span>网页版 AI 返回 JSON</span><textarea id="webAiResult" class="web-ai-result" placeholder="粘贴网页版 AI 的完整 JSON 回复"></textarea></label><div class="setting-note">平台只解析你粘贴的 JSON，不会登录或控制网页版 AI。</div></div>`, `<button class="button" data-close-modal>关闭</button><button class="button button-primary" data-modal-action="submit-web-ai-result">${icon("clipboard-check")}生成待审核提案</button>`), "modal-wide");

  $("[data-modal-action=copy-web-ai-prompt]")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#webAiPrompt")?.value || "");
    toast("Prompt 已复制");
  });
  $("[data-modal-action=submit-web-ai-result]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const resultText = $("#webAiResult")?.value || "";
    if (!resultText.trim()) return toast("请先粘贴网页版 AI 返回的 JSON", "error");
    const original = button.innerHTML;
    try {
      button.disabled = true;
      button.innerHTML = `${icon("loader-circle")}解析中`;
      renderIcons();
      const result = await api(`captures/${capture.id}/web-ai-result`, { method: "POST", body: { result_text: resultText } });
      closeModal();
      await loadCore();
      state.selectedProposal = result.proposal_id ? (await api(`proposals/${result.proposal_id}`)).proposal : null;
      toast("已生成待审核提案");
      setView("review");
    } catch (error) {
      handleError(error);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
      renderIcons();
    }
  });
}

function showModal(content, sizeClass = "") {
  const dialog = $("#modal");
  dialog.className = ["modal", sizeClass].filter(Boolean).join(" ");
  $("#modalCard").innerHTML = content;
  dialog.showModal();
  renderIcons();
  $$("[data-close-modal]", dialog).forEach((button) => button.addEventListener("click", () => dialog.close()));
  $$("[data-action]", dialog).forEach((button) => button.addEventListener("click", () => runAction(button).catch(handleError)));
}
function closeModal() { $("#modal").close(); }
function modalShell(title, subtitle, body, foot = `<button class="button" data-close-modal>取消</button>`) { return `<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div><button class="icon-button" data-close-modal aria-label="关闭">${icon("x")}</button></div><div class="modal-body">${body}</div><div class="modal-foot">${foot}</div>`; }

function providerFormPayload(card) {
  return {
    provider_type: $("[name=provider_type]", card).value,
    name: $("[name=name]", card).value,
    base_url: $("[name=base_url]", card).value,
    api_key: $("[name=api_key]", card).value,
    timeout_ms: $("[name=timeout_ms]", card).value,
    enabled: $("[name=enabled]", card).checked
  };
}

function discoveredModelsMarkup(models, selectedId = "") {
  if (!models.length) return `<div class="empty compact">${icon("search-x")}<div><strong>没有发现模型</strong><p>请检查 Base URL 和 API Key。</p></div></div>`;
  return `<div class="model-picker">${models.map((model, index) => {
    const modelId = model.id || model.model_id || "";
    const display = model.display_name || modelDisplayName(modelId);
    return `<label class="model-option"><input type="radio" name="discovered_model_id" value="${esc(modelId)}" ${modelId === selectedId || (!selectedId && index === 0) ? "checked" : ""} /><span><strong>${esc(display)}</strong><small>${esc(modelId)}${model.owned_by ? ` · ${esc(model.owned_by)}` : ""}</small></span></label>`;
  }).join("")}</div>`;
}

function setDiscoveryPanel(models, selectedId = "") {
  const panel = $("#modelDiscoveryPanel");
  const list = $("#modelDiscoveryList");
  if (!panel || !list) return;
  panel.hidden = false;
  list.innerHTML = discoveredModelsMarkup(models, selectedId);
  renderIcons();
}

async function openOperationEditor(id) {
  const operation = state.selectedProposal?.operations?.find((item) => item.id === id) || (await api(`proposals/${state.selectedProposal?.id}`)).proposal.operations.find((item) => item.id === id);
  if (!operation) return;
  showModal(modalShell("编辑审核操作", "修改后接受会保留 edited 状态", `<div class="two-col"><label class="field"><span>操作类型</span><select name="action"><option value="create_document" ${operation.action === "create_document" ? "selected" : ""}>新建文档</option><option value="create_block" ${operation.action === "create_block" ? "selected" : ""}>新建知识块</option><option value="append" ${operation.action === "append" ? "selected" : ""}>追加</option><option value="merge" ${operation.action === "merge" ? "selected" : ""}>合并替换</option><option value="replace" ${operation.action === "replace" ? "selected" : ""}>替换</option><option value="mark_historical" ${operation.action === "mark_historical" ? "selected" : ""}>标记历史</option><option value="archive" ${operation.action === "archive" ? "selected" : ""}>归档</option></select></label><label class="field"><span>建议标题</span><input name="proposed_heading" value="${esc(operation.proposed_heading)}" /></label></div><label class="field"><span>建议正文</span><textarea name="proposed_body_md">${esc(operation.proposed_body_md)}</textarea></label><label class="field"><span>修改原因</span><input name="reason" value="${esc(operation.reason)}" /></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-operation">${icon("save")}保存修改</button>`));
  $("[data-modal-action=save-operation]")?.addEventListener("click", async () => { const body = { action: $("[name=action]", $("#modalCard")).value, proposed_heading: $("[name=proposed_heading]", $("#modalCard")).value, proposed_body_md: $("[name=proposed_body_md]", $("#modalCard")).value, reason: $("[name=reason]", $("#modalCard")).value, status: "edited" }; try { await api(`proposal-operations/${id}`, { method: "PATCH", body }); closeModal(); await refreshReviewState(state.selectedProposal?.id || ""); toast("操作已保存"); render(); } catch (error) { handleError(error); } });
}

function openDocumentEditor(id = null) {
  const current = id ? state.documents.find((item) => item.id === id) : null;
  const title = current ? "编辑文档" : "新建文档";
  showModal(modalShell(title, "文档是知识块的容器", `<div class="two-col"><label class="field"><span>文档标题</span><input name="title" required value="${esc(current?.title || "")}" /></label><label class="field"><span>分类</span><select name="category_id">${categoryOptions(current?.category_id, false)}</select></label></div><label class="field"><span>摘要</span><textarea name="summary" style="min-height:90px">${esc(current?.summary || "")}</textarea></label>${current ? "" : `<label class="field"><span>初始正文（可选）</span><textarea name="body_md" style="min-height:130px"></textarea></label>`}`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-document">${icon("save")}保存</button>`));
  $("[data-modal-action=save-document]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { title: $("[name=title]", card).value, category_id: $("[name=category_id]", card).value, summary: $("[name=summary]", card).value }; if (!current) body.body_md = $("[name=body_md]", card).value; try { const result = current ? await api(`documents/${id}`, { method: "PATCH", body }) : await api("documents", { method: "POST", body }); closeModal(); await refreshKnowledgeState(result.document?.id); toast(current ? "文档已更新" : "文档已创建"); render(); } catch (error) { handleError(error); } });
}

function openBlockEditor(id, documentId = null) {
  let current = null;
  if (id) for (const doc of state.documents) current = doc.blocks?.find((block) => block.id === id) || current;
  showModal(modalShell(current ? "编辑知识块" : "新建知识块", "正文使用 Markdown 保存", `<label class="field"><span>标题</span><input name="heading" required value="${esc(current?.heading || "")}" /></label><label class="field"><span>正文</span><textarea name="body_md" required style="min-height:230px">${esc(current?.body_md || "")}</textarea></label><label class="field"><span>状态</span><select name="status">${["current", "historical", "archived"].map((item) => `<option value="${item}" ${item === (current?.status || "current") ? "selected" : ""}>${statusLabel(item)}</option>`).join("")}</select></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-block">${icon("save")}保存</button>`));
  $("[data-modal-action=save-block]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { heading: $("[name=heading]", card).value, body_md: $("[name=body_md]", card).value, status: $("[name=status]", card).value }; try { if (current) await api(`blocks/${id}`, { method: "PATCH", body }); else await api(`documents/${documentId}/blocks`, { method: "POST", body }); closeModal(); await refreshKnowledgeState(current?.document_id || documentId); toast("知识块已保存"); render(); } catch (error) { handleError(error); } });
}

async function openVersions(id) {
  const result = await api(`blocks/${id}/versions`);
  showModal(modalShell("历史版本", "每次正式编辑前都会保留当前版本", result.versions.length ? result.versions.map((version) => `<div class="operation-card"><div class="operation-card-head"><div><h3>版本 ${esc(version.version_no)}</h3><p>${esc(version.change_note || "未填写修改原因")} · ${fmtTime(version.created_at)}</p></div><button class="button button-small" data-version-restore="${esc(version.id)}" data-block="${esc(id)}">恢复</button></div><div class="compare-content">${esc(version.body_md)}</div></div>`).join("") : empty("history", "还没有历史版本", "下一次编辑时会自动生成"), `<button class="button" data-close-modal>关闭</button>`));
  $$('[data-version-restore]').forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("恢复这个版本？当前正文会先保存为新历史版本。")) return; try { await api(`blocks/${button.dataset.block}/restore/${button.dataset.versionRestore}`, { method: "POST", body: {} }); closeModal(); toast("版本已恢复"); await refreshKnowledgeState(state.selectedDocument?.id || ""); render(); } catch (error) { handleError(error); } }));
}

function renderAiRun(run) {
  const status = run.status || "unknown";
  const name = aiRunName(run.provider_name, run.model_name);
  const pieces = [];
  if (name) pieces.push(name);
  if (run.attempt_no) pieces.push(`第 ${run.attempt_no} 次`);
  if (run.latency_ms) pieces.push(`耗时 ${fmtLatency(run.latency_ms)}`);
  if (status === "running" && run.created_at) pieces.push(`已等待 ${fmtElapsedSince(run.created_at)}`);
  if (run.created_at) pieces.push(fmtTime(run.created_at));
  const errorLine = run.error_code || run.error_message ? `<p class="ai-run-error">${esc(aiErrorMessage(run.error_code, run.error_message))}</p>` : "";
  return `<article class="ai-run-item ${esc(status)}"><div class="ai-run-head"><strong>${esc(statusLabel(status))}</strong>${statusBadge(status)}</div><small>${esc(pieces.join(" · ") || "未记录模型")}</small>${errorLine}</article>`;
}

async function openCapture(id) {
  const result = await api(`captures/${id}`);
  const capture = result.capture;
  const proposal = capture.proposals?.[0];
  const runs = capture.ai_runs || [];
  const stale = isStaleCapture(capture);
  const canRetry = ["failed", "draft"].includes(capture.state) || stale;
  const latestRun = runs[0] || null;
  const errorText = capture.error_message || (latestRun?.error_code || latestRun?.error_message ? aiErrorMessage(latestRun.error_code, latestRun.error_message) : "无");
  const runTimeline = runs.length ? `<div class="ai-run-stack">${runs.map(renderAiRun).join("")}</div>` : empty("activity", capture.state === "analyzing" ? "还没有 AI 调用记录" : "暂无 AI 调用记录", capture.state === "analyzing" ? "如果这里长期为空，说明整理请求可能在写入模型尝试前被中断。" : "本地规则或手动收集不会产生外部 AI 记录。");
  showModal(modalShell("收集详情", `${statusLabel(capture.state)} · ${fmtTime(capture.updated_at)}${stale ? " · 可能已中断" : ""}`, `<div class="info-list"><div class="info-row"><span>处理模式</span><strong>${esc(captureModeLabel(capture.processing_mode))}</strong></div><div class="info-row"><span>分类</span><strong>${esc(capture.category_name || "自动判断")}</strong></div><div class="info-row"><span>错误</span><strong>${esc(errorText)}</strong></div></div><div class="compare-pane"><div class="compare-label">原始输入</div><div class="compare-content">${esc(capture.raw_text)}</div></div>${proposal ? `<div class="compare-pane"><div class="compare-label">最新整理结果</div><div class="compare-content">${esc(proposal.cleaned_text)}</div></div>` : ""}<div class="compare-pane"><div class="compare-label">AI 调用记录</div>${runTimeline}</div>`, `<button class="button" data-close-modal>关闭</button>${canRetry ? `<button class="button button-primary" data-modal-action="retry-capture" data-id="${esc(id)}">${icon("rotate-ccw")}重试整理</button>` : ""}`));
  $("[data-modal-action=retry-capture]")?.addEventListener("click", async (event) => {
    const retryButton = event.currentTarget;
    try {
      retryButton.disabled = true;
      retryButton.innerHTML = `${icon("loader-circle")}重试中`;
      renderIcons();
      await api(`captures/${id}/retry`, { method: "POST", body: {} });
      closeModal();
      toast("整理请求已完成");
      await loadCore();
      render();
    } catch (error) {
      retryButton.disabled = false;
      retryButton.innerHTML = `${icon("rotate-ccw")}重试整理`;
      renderIcons();
      await loadCore().catch(() => {});
      render();
      handleError(error);
    }
  });
}

function openProviderEditor(id = null) {
  const current = state.settings.providers.find((item) => item.id === id);
  const selectedType = current?.provider_type || "deepseek";
  const preset = providerPreset(selectedType);
  let discoveredModels = [];
  showModal(modalShell(current ? "编辑 AI 服务商" : "添加 AI 服务商", "选择服务商并填写 API Key 后可自动发现模型", `<div class="two-col"><label class="field"><span>服务类型</span><select name="provider_type">${providerTypeOptions(selectedType)}</select></label><label class="field"><span>显示名称</span><input name="name" value="${esc(current?.name || preset.name)}" required /></label></div><label class="field"><span>Base URL</span><input name="base_url" value="${esc(current?.base_url || preset.base_url)}" placeholder="https://api.deepseek.com" /></label><div class="provider-key-row"><label class="field"><span>API Key</span><input name="api_key" type="password" autocomplete="new-password" placeholder="${current?.key_configured ? `已配置 ${esc(current.api_key_masked)}，留空不变` : "输入服务商 API Key"}" /></label><button class="button" data-modal-action="discover-provider">${icon("radar")}发现模型</button></div><div class="two-col"><label class="field"><span>单次模型请求总超时（毫秒）</span><input name="timeout_ms" type="number" value="${esc(current?.timeout_ms || 30000)}" min="3000" max="120000" /><small>从平台发出请求到收齐响应的总等待时间，包含中转站排队、模型思考和响应返回。长推理模型建议 90000-120000。</small></label><label class="inline-check"><input name="enabled" type="checkbox" ${current?.enabled !== false ? "checked" : ""} />启用服务商</label></div><section id="modelDiscoveryPanel" class="model-discovery" hidden><div class="panel-title"><div><h3>发现到的模型</h3><p>保存后会同步到模型列表。</p></div></div><div id="modelDiscoveryList"></div><label class="inline-check"><input name="set_default_model" type="checkbox" checked />把选中模型设为默认整理模型</label></section>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-provider">${icon("save")}保存并同步</button>`));

  const card = $("#modalCard");
  const typeInput = $("[name=provider_type]", card);
  const nameInput = $("[name=name]", card);
  const baseInput = $("[name=base_url]", card);
  const keyInput = $("[name=api_key]", card);
  const discoverButton = $("[data-modal-action=discover-provider]", card);
  const presetNames = Object.values(PROVIDER_PRESETS).map((item) => item.name);
  const presetUrls = Object.values(PROVIDER_PRESETS).map((item) => item.base_url).filter(Boolean);

  function updateProviderDefaults() {
    const nextPreset = providerPreset(typeInput.value);
    if (!current || !nameInput.value.trim() || presetNames.includes(nameInput.value.trim())) nameInput.value = nextPreset.name;
    if (!current || !baseInput.value.trim() || presetUrls.includes(baseInput.value.trim())) baseInput.value = nextPreset.base_url;
    const external = typeInput.value !== "cloudflare_ai";
    baseInput.disabled = !external;
    keyInput.disabled = !external;
    discoverButton.disabled = !external;
    if (!external) {
      baseInput.value = "";
      $("#modelDiscoveryPanel").hidden = true;
    }
  }

  typeInput.addEventListener("change", () => { discoveredModels = []; updateProviderDefaults(); });
  updateProviderDefaults();

  discoverButton.addEventListener("click", async () => {
    const body = providerFormPayload(card);
    try {
      discoverButton.disabled = true;
      discoverButton.innerHTML = `${icon("loader-circle")}发现中`;
      if (current && !body.api_key) {
        const result = await api(`settings/ai/providers/${current.id}/models/sync`, { method: "POST", body: {} });
        await loadSettings();
        discoveredModels = state.settings.models
          .filter((model) => model.provider_id === current.id && result.model_ids?.includes(model.model_id))
          .map((model) => ({ id: model.model_id, display_name: model.display_name, owned_by: model.provider_type }));
      } else {
        const result = await api("settings/ai/providers/discover", { method: "POST", body });
        discoveredModels = result.models || [];
      }
      setDiscoveryPanel(discoveredModels);
      toast(`发现 ${discoveredModels.length} 个模型`);
    } catch (error) {
      handleError(error);
    } finally {
      discoverButton.disabled = typeInput.value === "cloudflare_ai";
      discoverButton.innerHTML = `${icon("radar")}发现模型`;
      renderIcons();
    }
  });

  $("[data-modal-action=save-provider]", card)?.addEventListener("click", async () => {
    const body = providerFormPayload(card);
    const selectedModelId = $("[name=discovered_model_id]:checked", card)?.value || discoveredModels[0]?.id || "";
    const shouldSync = body.provider_type !== "cloudflare_ai" && (discoveredModels.length || current);
    try {
      const result = current
        ? await api(`settings/ai/providers/${id}`, { method: "PATCH", body })
        : await api("settings/ai/providers", { method: "POST", body });
      const provider = result.provider;
      if (shouldSync) await api(`settings/ai/providers/${provider.id}/models/sync`, { method: "POST", body: {} });
      await loadSettings();
      const routeModel = selectedModelId
        ? state.settings.models.find((model) => model.provider_id === provider.id && model.model_id === selectedModelId)
        : state.settings.models.find((model) => model.provider_id === provider.id && model.enabled);
      if ($("[name=set_default_model]", card)?.checked && routeModel) {
        await api("settings/ai/routes/organize_capture", { method: "PATCH", body: { default_model_id: routeModel.id } });
      }
      await Promise.all([loadSettings(), loadDashboard()]);
      closeModal();
      toast(routeModel ? `服务商已保存，默认模型为 ${routeModel.display_name}` : "服务商已保存");
      render();
    } catch (error) {
      handleError(error);
    }
  });
}

function openModelEditor(id = null) {
  const current = state.settings.models.find((item) => item.id === id);
  showModal(modalShell(current ? "编辑模型" : "添加模型", "模型 ID 由服务商账号或推理接入点决定", `<div class="two-col"><label class="field"><span>服务商</span><select name="provider_id">${state.settings.providers.map((provider) => `<option value="${esc(provider.id)}" ${provider.id === current?.provider_id ? "selected" : ""}>${esc(provider.name)}</option>`).join("")}</select></label><label class="field"><span>显示名称</span><input name="display_name" value="${esc(current?.display_name || "")}" required /></label></div><label class="field"><span>真实模型 ID / 推理接入点 ID</span><input name="model_id" value="${esc(current?.model_id || "")}" required /></label><div class="two-col"><label class="field"><span>成本等级</span><select name="cost_level">${["unknown", "free", "low", "medium", "high"].map((level) => `<option value="${level}" ${level === (current?.cost_level || "unknown") ? "selected" : ""}>${level}</option>`).join("")}</select></label><label class="field"><span>最大输出 Token</span><input name="max_output_tokens" type="number" value="${esc(current?.max_output_tokens || 1800)}" /></label></div><div class="two-col"><label class="inline-check"><input name="enabled" type="checkbox" ${current?.enabled !== false ? "checked" : ""} />启用模型</label><label class="inline-check"><input name="supports_structured_output" type="checkbox" ${current?.supports_structured_output !== false ? "checked" : ""} />支持 JSON 输出</label></div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-model">${icon("save")}保存</button>`));
  $("[data-modal-action=save-model]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { provider_id: $("[name=provider_id]", card).value, display_name: $("[name=display_name]", card).value, model_id: $("[name=model_id]", card).value, cost_level: $("[name=cost_level]", card).value, max_output_tokens: $("[name=max_output_tokens]", card).value, enabled: $("[name=enabled]", card).checked, supports_structured_output: $("[name=supports_structured_output]", card).checked }; try { if (current) await api(`settings/ai/models/${id}`, { method: "PATCH", body }); else await api("settings/ai/models", { method: "POST", body }); closeModal(); await Promise.all([loadSettings(), loadDashboard()]); toast("模型已保存"); render(); } catch (error) { handleError(error); } });
}

function openRouteEditor(taskType) {
  const route = state.settings.routes.find((item) => item.task_type === taskType);
  if (!route) return;
  showModal(modalShell("调整模型路由", taskType === "organize_capture" ? "原始输入整理" : "上下文压缩", `<label class="field"><span>默认模型</span><select name="default_model_id"><option value="">未配置</option>${state.settings.models.filter((model) => model.enabled).map((model) => `<option value="${esc(model.id)}" ${model.id === route.default_model_id ? "selected" : ""}>${esc(model.display_name)}</option>`).join("")}</select></label><div class="two-col"><label class="field"><span>超时（毫秒）</span><input name="timeout_ms" type="number" value="${esc(route.timeout_ms)}" /></label><label class="field"><span>最大重试</span><input name="max_retries" type="number" min="0" max="2" value="${esc(route.max_retries)}" /></label></div><div class="two-col"><label class="field"><span>最大输入字符</span><input name="max_input_chars" type="number" value="${esc(route.max_input_chars)}" /></label><label class="field"><span>最大输出 Token</span><input name="max_output_tokens" type="number" value="${esc(route.max_output_tokens)}" /></label></div><label class="inline-check"><input name="allow_cross_provider" type="checkbox" ${route.allow_cross_provider ? "checked" : ""} />允许跨服务商切换</label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-route">${icon("save")}保存</button>`));
  $("[data-modal-action=save-route]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { default_model_id: $("[name=default_model_id]", card).value, timeout_ms: $("[name=timeout_ms]", card).value, max_retries: $("[name=max_retries]", card).value, max_input_chars: $("[name=max_input_chars]", card).value, max_output_tokens: $("[name=max_output_tokens]", card).value, allow_cross_provider: $("[name=allow_cross_provider]", card).checked }; try { await api(`settings/ai/routes/${taskType}`, { method: "PATCH", body }); closeModal(); await loadSettings(); await loadDashboard(); toast("模型路由已更新"); render(); } catch (error) { handleError(error); } });
}

async function previewContext() {
  syncContextSelectionFromDom();
  const budget = $("#contextBudget")?.value;
  if (budget) state.contextSelection.token_budget = Number(budget);
  state.contextPreview = await api("context/preview", { method: "POST", body: { selection: state.contextSelection, mode: state.contextMode, token_budget: state.contextSelection.token_budget } });
  render(); toast(state.contextPreview.markdown ? "上下文预览已生成" : "当前筛选没有命中知识块", state.contextPreview.markdown ? "ok" : "error");
}

async function copyContext() {
  if (!state.contextPreview?.markdown) return toast("请先生成上下文预览", "error");
  await navigator.clipboard.writeText(state.contextPreview.markdown); toast("上下文已复制");
}

async function downloadContext(format) {
  if (!state.contextPreview?.markdown) return toast("请先生成有内容的上下文预览", "error");
  const response = await fetch(`/api/context/export/${format}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: state.contextSelection, mode: state.contextMode, token_budget: state.contextSelection.token_budget }) });
  if (!response.ok) throw new Error("上下文导出失败");
  saveBlob(await response.blob(), `nanstar-context-${Date.now()}.${format === "json" ? "json" : "md"}`);
}

async function downloadFile(path, filename) {
  const response = await fetch(`/api/${path}`, { credentials: "include" });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "下载失败"); }
  saveBlob(await response.blob(), filename);
}
function saveBlob(blob, filename) { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); }

async function checkHealth() {
  const result = await api("health");
  const root = $("#healthResult");
  root.className = "info-list";
  root.innerHTML = `<div class="info-row"><span>D1 数据库</span><strong>${result.database.bound ? "已绑定" : "未绑定"} · ${esc(result.database.latency_ms)} ms</strong></div><div class="info-row"><span>登录密钥</span><strong>${result.secrets.auth_configured ? "已配置" : "缺失"}</strong></div><div class="info-row"><span>AI 加密主密钥</span><strong>${result.secrets.ai_encryption_configured ? "已配置" : "缺失"}</strong></div><div class="info-row"><span>Workers AI</span><strong>${result.workers_ai_bound ? "已绑定" : "未绑定"}</strong></div><div class="info-row"><span>启用服务商</span><strong>${esc(result.providers.enabled)} / ${esc(result.providers.total)}</strong></div>`;
  toast("系统健康检查完成");
}

function openImport() {
  showModal(modalShell("导入 JSON 备份", "先预览，再确认写入；不会覆盖任何密钥", `<label class="field"><span>备份文件</span><input id="importFile" type="file" accept="application/json,.json" /></label><div id="importPreview" class="setting-note">请选择 NanStar Context 导出的 JSON 文件。</div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="apply-import" disabled>${icon("upload")}确认导入</button>`));
  let backup = null;
  $("#importFile")?.addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; try { backup = JSON.parse(await file.text()); const preview = await api("import/preview", { method: "POST", body: backup }); $("#importPreview").textContent = `共 ${preview.total} 行：${Object.entries(preview.counts).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join("，") || "空备份"}`; $("[data-modal-action=apply-import]").disabled = false; } catch (error) { backup = null; $("#importPreview").textContent = error.message || "文件无法解析"; handleError(error); } });
  $("[data-modal-action=apply-import]")?.addEventListener("click", async () => { if (!backup || !window.confirm("确认把预览中的数据写入当前数据库？同 ID 数据会更新。")) return; try { const result = await api("import/apply", { method: "POST", body: backup }); closeModal(); await Promise.all([loadCore(), loadSettings()]); toast(`已导入 ${result.total} 行`); render(); } catch (error) { handleError(error); } });
}

async function boot() {
  renderIcons();
  try {
    const session = await api("session");
    if (!session.authenticated) return showLogin();
    showApp();
    await loadCore();
    try { await loadSettings(); } catch (error) { console.warn("settings unavailable", error); }
    setView(state.view);
  } catch (error) { showLogin(); $("#loginError").textContent = error.message; $("#loginError").hidden = false; }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const errorNode = $("#loginError"); errorNode.hidden = true;
  try { await api("session", { method: "POST", body: { token: $("#loginToken").value } }); $("#loginToken").value = ""; showApp(); await loadCore(); try { await loadSettings(); } catch {} setView("dashboard"); } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
});
$("#logoutButton").addEventListener("click", async () => { try { await api("session", { method: "DELETE" }); } finally { showLogin(); } });
$("#openSidebar").addEventListener("click", () => $("#sidebar").classList.add("open"));
$("#closeSidebar").addEventListener("click", () => $("#sidebar").classList.remove("open"));
$("#refreshButton").addEventListener("click", async () => { try { await loadCore(); if (state.view === "settings") await loadSettings(); toast("数据已刷新"); render(); } catch (error) { handleError(error); } });
$("#modal").addEventListener("cancel", (event) => event.preventDefault());
document.addEventListener("click", (event) => {
  const node = event.target.closest("[data-view]");
  if (!node) return;
  event.preventDefault();
  setView(node.dataset.view);
});
$("#modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.preventDefault(); });
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
boot();
