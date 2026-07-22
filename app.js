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

const VIEW_TITLES = { dashboard: "工作台", captures: "收集箱", review: "待审核", library: "知识库", context: "上下文生成", settings: "设置" };

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function uid(value) { return String(value || "").replace(/[^a-zA-Z0-9_-]/g, ""); }
function fmtTime(value) { if (!value) return "未记录"; const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? "未记录" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function fmtDate(value) { if (!value) return "未设置"; const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? "未设置" : date.toLocaleDateString("zh-CN"); }
function statusLabel(value) { return ({ current: "当前", historical: "历史", archived: "归档", draft: "草稿", analyzing: "整理中", review: "待审核", approved: "已通过", partial: "部分处理", rejected: "已拒绝", failed: "失败", pending: "待处理", edited: "已编辑", accepted: "已接受", healthy: "正常", error: "异常" }[value] || value || "未知"); }
function statusBadge(value) { return `<span class="status-badge ${esc(value)}">${esc(statusLabel(value))}</span>`; }
function icon(name) { return `<i data-lucide="${esc(name)}"></i>`; }
function renderIcons() { if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } }); }
function markdown(value) {
  const source = String(value || "");
  if (!source) return `<p class="helper-text">暂无正文</p>`;
  try { return window.DOMPurify.sanitize(window.marked.parse(source)); } catch { return `<p>${esc(source)}</p>`; }
}

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
}

async function loadCategories() { state.categories = (await api("categories")).categories || []; }
async function loadDashboard() { state.dashboard = await api("dashboard"); updateCounts(); }
async function loadDocuments() { state.documents = (await api("documents")).documents || []; }
async function loadBlocks() { state.blocks = (await api("blocks")).blocks || []; }
async function loadCaptures() { state.captures = (await api("captures")).captures || []; }
async function loadProposals() { state.proposals = (await api("proposals?status=pending")).proposals || []; updateCounts(); }
async function loadSettings() {
  const [providers, models, routes, runs] = await Promise.all([api("settings/ai/providers"), api("settings/ai/models"), api("settings/ai/routes"), api("settings/ai/runs?limit=40")]);
  state.settings = { providers: providers.providers || [], models: models.models || [], routes: routes.routes || [], runs: runs.runs || [], encryption_configured: providers.encryption_configured, workers_ai_bound: providers.workers_ai_bound };
}
async function loadCore() { await Promise.all([loadCategories(), loadDashboard(), loadDocuments(), loadBlocks(), loadCaptures(), loadProposals()]); }
function updateCounts() {
  const pending = Number(state.dashboard?.counts?.pending_review ?? state.proposals.filter((item) => Number(item.pending_operations) > 0).length);
  const pendingNode = $("#navPendingCount"); pendingNode.textContent = pending; pendingNode.hidden = pending < 1;
  const captureNode = $("#navReviewCount"); captureNode.textContent = state.captures.filter((item) => item.state === "review").length; captureNode.hidden = captureNode.textContent === "0";
}

function categoryOptions(selected = "", includeAuto = true) {
  const rows = state.categories.filter((item) => !item.deleted_at).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  return `${includeAuto ? `<option value="">自动判断</option>` : ""}${rows.map((row) => `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(row.parent_id ? `　${row.name}` : row.name)}</option>`).join("")}`;
}

function render() {
  const root = $("#viewRoot");
  root.innerHTML = ({ dashboard: renderDashboard, captures: renderCaptures, review: renderReview, library: renderLibrary, context: renderContext, settings: renderSettings }[state.view] || renderDashboard)();
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
    <div class="dashboard-grid"><section class="panel pad capture-panel"><div class="panel-title"><div><h2>快速收集</h2><p>原始输入会先保存，再按选定模式生成待审核提案。</p></div>${icon("pen-line")}</div><form id="captureForm"><label class="field"><span class="sr-only">原始输入</span><textarea name="raw_text" required maxlength="120000" placeholder="粘贴一段工作、生活、经历、习惯或计划……"></textarea></label><div class="capture-options"><label class="field"><span>处理模式</span><select name="processing_mode"><option value="external_ai">外部 AI</option><option value="platform_rules">平台本地规则</option><option value="manual_only">完全手动</option></select></label><label class="field"><span>目标分类</span><select name="preferred_category_id">${categoryOptions()}</select></label><label class="field"><span>指定模型</span><select name="requested_model_id" id="captureModelOptions"><option value="">自动选择</option>${state.settings.models.map((model) => `<option value="${esc(model.id)}">${esc(model.display_name || model.model_id)}</option>`).join("")}</select></label></div><div class="capture-submit-row"><span class="helper-text" id="capturePrivacyNote">外部 AI 模式会把本次输入和少量候选资料发送给已配置的服务商。</span><button class="button button-primary" type="submit">${icon("sparkles")}保存并整理</button></div></form></section><div class="dashboard-side"><section class="panel pad model-card"><div class="panel-title"><div><h3>当前整理模型</h3><p>来自 AI 路由设置</p></div>${icon("cpu")}</div>${defaultModel ? `<div class="model-state"><span class="status-dot ${defaultModel.health_status === "error" ? "error" : "ok"}"></span><div><strong>${esc(defaultModel.display_name || defaultModel.model_id)}</strong><small>${esc(defaultModel.provider_name || "未命名服务商")}</small></div></div>` : `<div class="empty"><div><strong>尚未配置模型</strong><p>本地规则和完全手动仍可使用。</p></div></div>`}</section><section class="panel"><div class="panel-title" style="padding:18px 18px 12px"><div><h3>最近更新</h3><p>正式知识库中的最新文档</p></div><button class="icon-button" data-action="goto" data-view-target="library" aria-label="查看全部" title="查看全部">${icon("arrow-up-right")}</button></div>${recent.length ? `<div class="list">${recent.map((doc) => `<div class="list-row"><div class="list-main"><strong>${esc(doc.title)}</strong><small>${esc(doc.category_name || "未分类")} · ${fmtTime(doc.updated_at)}</small></div>${statusBadge(doc.status)}</div>`).join("")}</div>` : empty("inbox", "还没有正式文档", "从上面的快速收集开始")}</section></div></div>${failures.length ? `<section class="panel" style="margin-top:18px"><div class="panel-title" style="padding:18px"><div><h3>最近失败</h3><p>原始输入仍然保留，可以在收集箱重试。</p></div></div><div class="list">${failures.map((item) => `<div class="list-row"><div class="list-main"><strong>${esc(item.raw_text)}</strong><small>${esc(item.error_code || "整理失败")} · ${fmtTime(item.updated_at)}</small></div><button class="button button-small" data-action="capture-detail" data-id="${esc(item.id)}">查看</button></div>`).join("")}</div></section>` : ""}`;
}

function empty(iconName, title, copy) { return `<div class="empty">${icon(iconName)}<div><strong>${esc(title)}</strong><p>${esc(copy)}</p></div></div>`; }

function renderCaptures() {
  return `<div class="view-head"><div><h1>收集箱</h1><p>原始输入、整理状态和失败任务。</p></div><div class="view-actions"><button class="button button-primary" data-action="goto" data-view-target="dashboard">${icon("plus")}新建收集</button></div></div><div class="toolbar"><div class="search">${icon("search")}<input id="captureSearch" placeholder="搜索原始输入" /></div><select id="captureStateFilter" aria-label="按状态筛选"><option value="">全部状态</option>${["draft", "analyzing", "review", "approved", "partial", "rejected", "failed"].map((item) => `<option value="${item}">${statusLabel(item)}</option>`).join("")}</select></div><section class="panel"><div id="captureList" class="list">${captureRows(state.captures)}</div></section>`;
}
function captureRows(rows) { return rows.length ? rows.map((item) => `<div class="list-row" data-action="capture-detail" data-id="${esc(item.id)}"><div class="list-main"><strong>${esc(item.raw_text || "未命名输入")}</strong><small>${esc(item.category_name || "自动分类")} · ${fmtTime(item.updated_at)} · ${Number(item.proposal_count || 0)} 项提案</small></div><div class="list-meta">${statusBadge(item.state)}${item.processing_mode === "external_ai" ? `<span class="tag">外部 AI</span>` : `<span class="tag">${item.processing_mode === "platform_rules" ? "本地规则" : "手动"}</span>`}</div></div>`).join("") : empty("inbox", "收集箱是空的", "输入一段资料后，它会出现在这里"); }

function renderReview() {
  const proposal = state.selectedProposal;
  return `<div class="view-head"><div><h1>待审核</h1><p>长期资料只会在你确认后发生变化。</p></div><div class="view-actions"><button class="button" data-action="refresh-review">${icon("refresh-cw")}刷新</button>${proposal ? `<button class="button button-primary" data-action="apply-proposal" data-id="${esc(proposal.id)}">${icon("check-check")}接受全部</button><button class="button button-danger" data-action="reject-proposal" data-id="${esc(proposal.id)}">${icon("x")}全部拒绝</button>` : ""}</div></div><div class="review-layout"><section class="review-list">${state.proposals.length ? state.proposals.map((item) => `<div class="list-row ${proposal?.id === item.id ? "active" : ""}" data-action="proposal-detail" data-id="${esc(item.id)}"><div class="list-main"><strong>${esc(item.cleaned_text || item.raw_text || "未命名提案")}</strong><small>${esc(item.provider_name || (item.capture_state === "failed" ? "整理失败" : "本地规则"))} · ${fmtTime(item.updated_at)}</small></div><div class="list-meta"><span class="tag">${esc(item.pending_operations || 0)} 项</span></div></div>`).join("") : empty("clipboard-check", "没有待审核提案", "新的整理结果会出现在这里")}</section>${proposal ? renderProposalDetail(proposal) : `<section class="panel">${empty("mouse-pointer-2", "选择一条提案", "查看原始输入、建议和冲突")}</section>`}</div>`;
}
function renderProposalDetail(proposal) {
  const pending = (proposal.operations || []).filter((op) => ["pending", "edited"].includes(op.status));
  return `<section class="review-detail"><div class="panel pad"><div class="panel-title"><div><h2>提案审核</h2><p>${esc(proposal.provider_name || "平台本地规则")} · ${esc(proposal.model_name || "无外部模型")} · ${fmtTime(proposal.created_at)}</p></div>${statusBadge(proposal.status)}</div><div class="proposal-summary" style="margin-top:18px"><div class="info-list"><div class="info-row"><span>输入模式</span><strong>${esc(proposal.capture?.processing_mode === "external_ai" ? "外部 AI" : proposal.capture?.processing_mode === "platform_rules" ? "平台本地规则" : "完全手动")}</strong></div><div class="info-row"><span>输入长度</span><strong>${esc((proposal.capture?.raw_text || "").length)} 字符</strong></div><div class="info-row"><span>调用用量</span><strong>${proposal.output_tokens ? `${esc(proposal.input_tokens || 0)} / ${esc(proposal.output_tokens)} tokens` : "未调用外部模型"}</strong></div></div><div class="info-list"><div class="info-row"><span>提案操作</span><strong>${esc(proposal.operations?.length || 0)} 项</strong></div><div class="info-row"><span>冲突</span><strong>${esc((proposal.conflicts || []).length)} 项</strong></div><div class="info-row"><span>待处理</span><strong>${esc(pending.length)} 项</strong></div></div></div></div><div class="compare-grid"><div class="compare-pane"><div class="compare-label">原始输入</div><div class="compare-content">${esc(proposal.capture?.raw_text || "")}</div></div><div class="compare-pane"><div class="compare-label">整理后的完整表达</div><div class="compare-content">${esc(proposal.cleaned_text || "")}</div></div></div>${(proposal.conflicts || []).length ? `<div class="warning-box">${icon("triangle-alert")}<span>${esc((proposal.conflicts || []).join("；"))}</span></div>` : ""}<div class="operation-stack">${(proposal.operations || []).map(renderOperation).join("")}</div></section>`;
}
function renderOperation(operation) {
  const body = operation.proposed_body_md || "";
  const current = operation.current_body_md || "暂无现有正文";
  const canReview = ["pending", "edited"].includes(operation.status);
  return `<article class="operation-card ${operation.conflict ? "conflict" : ""}"><div class="operation-card-head"><div><h3>${esc(operation.proposed_title || operation.proposed_heading || "未命名操作")}</h3><p>${esc(operation.action)} · ${esc(operation.target_category_name || "待选择分类")} ${operation.target_document_title ? `· ${esc(operation.target_document_title)}` : ""}</p></div>${statusBadge(operation.status)}</div><div class="operation-card-body"><div class="compare-grid"><div class="compare-pane"><div class="compare-label">修改前</div><div class="compare-content">${esc(current)}</div></div><div class="compare-pane"><div class="compare-label">建议内容</div><div class="compare-content">${esc(body || "此操作只改变状态或位置")}</div></div></div><p class="helper-text" style="margin-top:12px">${esc(operation.reason || "未填写原因")}</p>${canReview ? `<div class="operation-actions"><button class="button button-small" data-action="edit-operation" data-id="${esc(operation.id)}">${icon("pencil")}编辑</button><button class="button button-small button-danger" data-action="reject-operation" data-id="${esc(operation.id)}">${icon("x")}拒绝</button><button class="button button-small button-primary" data-action="apply-operation" data-proposal="${esc(operation.proposal_id)}" data-id="${esc(operation.id)}">${icon("check")}接受</button></div>` : ""}</div></article>`;
}

function renderLibrary() {
  const docs = state.documents.filter((doc) => !state.libraryCategory || state.libraryCategory === "all" || doc.category_id === state.libraryCategory || state.categories.find((cat) => cat.id === doc.category_id)?.parent_id === state.libraryCategory);
  return `<div class="view-head"><div><h1>知识库</h1><p>正式资料、知识块和历史版本。</p></div><div class="view-actions"><button class="button" data-action="export-library">${icon("download")}导出 Markdown</button><button class="button button-primary" data-action="new-document">${icon("plus")}新建文档</button></div></div><div class="split-layout"><aside class="panel tree-panel"><span class="tree-heading">分类</span><button class="tree-item ${!state.libraryCategory || state.libraryCategory === "all" ? "active" : ""}" data-action="category-filter" data-id="all">${icon("layers-3")}全部资料</button>${state.categories.filter((cat) => !cat.deleted_at).map((cat) => `<button class="tree-item ${state.libraryCategory === cat.id ? "active" : ""} ${cat.parent_id ? "child" : ""}" data-action="category-filter" data-id="${esc(cat.id)}">${icon(cat.parent_id ? "corner-down-right" : "folder")}${esc(cat.name)}</button>`).join("")}</aside><section class="document-list">${docs.length ? docs.map(renderDocumentCard).join("") : empty("library", "这个分类还没有文档", "可以从收集箱整理一条资料，或直接新建文档")}${state.selectedDocument ? renderDocumentDetail(state.selectedDocument) : ""}</section></div>`;
}
function renderDocumentCard(doc) { return `<article class="document-card ${state.selectedDocument?.id === doc.id ? "selected" : ""}" data-action="document-detail" data-id="${esc(doc.id)}"><div><h3>${esc(doc.title)}</h3><p>${esc(doc.summary || "暂无摘要")}</p><div class="card-meta"><span class="tag">${esc(doc.category_name || state.categories.find((cat) => cat.id === doc.category_id)?.name || "未分类")}</span><span class="tag">${esc(doc.block_count || 0)} 个知识块</span>${statusBadge(doc.status)}</div></div><div class="card-side"><span>${fmtTime(doc.updated_at)}</span>${icon("arrow-up-right")}</div></article>`; }
function renderDocumentDetail(doc) { return `<article class="detail-panel"><div class="detail-head"><div><h2>${esc(doc.title)}</h2><p>${esc(doc.summary || "暂无摘要")} · ${esc(doc.tags?.join("、") || "无标签")}</p></div><div class="detail-actions"><button class="button button-small" data-action="edit-document" data-id="${esc(doc.id)}">${icon("pencil")}编辑</button><button class="button button-small" data-action="new-block" data-id="${esc(doc.id)}">${icon("plus")}知识块</button><button class="icon-button" data-action="delete-document" data-id="${esc(doc.id)}" aria-label="删除文档" title="删除文档">${icon("trash-2")}</button></div></div><div class="block-stack">${doc.blocks?.length ? doc.blocks.map((block) => `<article class="knowledge-block"><div class="block-top"><div><h3>${esc(block.heading)}</h3><small>${statusLabel(block.status)} · 更新于 ${fmtTime(block.updated_at)}</small></div><div class="detail-actions"><button class="icon-button" data-action="edit-block" data-id="${esc(block.id)}" aria-label="编辑知识块" title="编辑知识块">${icon("pencil")}</button><button class="icon-button" data-action="versions" data-id="${esc(block.id)}" aria-label="查看历史版本" title="查看历史版本">${icon("history")}</button></div></div><div class="markdown-body">${markdown(block.body_md)}</div><p class="source-line">来源：${block.source_capture_id ? esc(block.source_capture_id) : "手动创建"}</p></article>`).join("") : empty("file-text", "文档还没有知识块", "添加一个知识块开始记录")}</div></article>`; }

function renderContext() {
  const selectedDocs = new Set(state.contextSelection.document_ids || []);
  const selectedBlocks = new Set(state.contextSelection.block_ids || []);
  const selectedCats = new Set(state.contextSelection.category_ids || []);
  const preview = state.contextPreview;
  return `<div class="view-head"><div><h1>上下文生成</h1><p>从当前知识库选择资料，生成可复制或下载的上下文。</p></div><div class="view-actions"><button class="button" data-action="export-context" data-format="markdown">${icon("download")}下载 Markdown</button><button class="button button-primary" data-action="copy-context">${icon("copy")}复制结果</button></div></div><div class="context-layout"><aside class="panel context-controls"><h2>选择资料</h2><label class="field"><span>输出模式</span><select id="contextMode"><option value="full" ${state.contextMode === "full" ? "selected" : ""}>完整模式</option><option value="compact" ${state.contextMode === "compact" ? "selected" : ""}>精简模式</option><option value="custom" ${state.contextMode === "custom" ? "selected" : ""}>自定义预算</option></select></label>${state.contextMode === "custom" ? `<label class="field"><span>Token 预算</span><input id="contextBudget" type="number" min="100" max="200000" value="${esc(state.contextSelection.token_budget || 4000)}" /></label>` : ""}<label class="field"><span>资料状态</span><select id="contextStatus"><option value="current" ${state.contextSelection.statuses?.includes("current") ? "selected" : ""}>当前资料</option><option value="current,historical" ${state.contextSelection.statuses?.includes("historical") ? "selected" : ""}>当前 + 历史</option><option value="archived" ${state.contextSelection.statuses?.includes("archived") ? "selected" : ""}>归档资料</option></select></label><div class="field"><span>按分类</span><div class="check-list">${state.categories.filter((cat) => !cat.deleted_at).map((cat) => `<label class="check-item"><input type="checkbox" data-context-category="${esc(cat.id)}" ${selectedCats.has(cat.id) ? "checked" : ""} /><span>${esc(cat.parent_id ? `　${cat.name}` : cat.name)}</span></label>`).join("")}</div></div><div class="field"><span>按文档</span><div class="check-list">${state.documents.slice(0, 120).map((doc) => `<label class="check-item"><input type="checkbox" data-context-document="${esc(doc.id)}" ${selectedDocs.has(doc.id) ? "checked" : ""} /><span>${esc(doc.title)}</span></label>`).join("")}</div></div><div class="field"><span>按知识块</span><div class="check-list">${state.blocks.slice(0, 180).map((block) => `<label class="check-item"><input type="checkbox" data-context-block="${esc(block.id)}" ${selectedBlocks.has(block.id) ? "checked" : ""} /><span>${esc(block.document_title)} / ${esc(block.heading)}</span></label>`).join("")}</div></div><button class="button button-primary button-wide" data-action="preview-context">${icon("scan-text")}生成预览</button></aside><section class="context-output"><div class="context-metrics">${preview ? `<span class="metric"><strong>${esc(preview.item_count)}</strong> 个知识块</span><span class="metric"><strong>${esc(preview.character_count)}</strong> 字符</span><span class="metric"><strong>约 ${esc(preview.estimated_tokens)}</strong> tokens</span>${preview.truncated ? `<span class="status-badge historical">已按预算截断</span>` : ""}` : `<span class="metric">选择资料后生成预览</span>`}</div><article class="context-preview">${preview ? `<div class="markdown-body">${markdown(preview.markdown)}</div>` : empty("scan-text", "还没有预览", "选择资料并生成一次上下文")}</article></section></div>`;
}

function renderSettings() {
  const tab = state.settingsTab;
  return `<div class="view-head"><div><h1>设置</h1><p>管理分类、模型路由、备份和系统状态。</p></div><div class="view-actions"><button class="button" data-action="export-backup">${icon("archive")}导出完整备份</button><button class="button" data-action="import-backup">${icon("upload")}导入备份</button></div></div><div class="settings-layout"><nav class="settings-nav"><button class="settings-tab ${tab === "providers" ? "active" : ""}" data-action="settings-tab" data-tab="providers">AI 服务商</button><button class="settings-tab ${tab === "models" ? "active" : ""}" data-action="settings-tab" data-tab="models">模型</button><button class="settings-tab ${tab === "routes" ? "active" : ""}" data-action="settings-tab" data-tab="routes">模型路由</button><button class="settings-tab ${tab === "system" ? "active" : ""}" data-action="settings-tab" data-tab="system">系统健康</button></nav><section class="settings-section">${tab === "providers" ? renderProviderSettings() : tab === "models" ? renderModelSettings() : tab === "routes" ? renderRouteSettings() : renderSystemSettings()}</section></div>`;
}
function renderProviderSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>AI 服务商</h2><p>密钥只在服务端加密保存，界面仅显示尾号。</p></div><button class="button button-primary button-small" data-action="new-provider">${icon("plus")}添加服务商</button></div>${!state.settings.encryption_configured ? `<div class="warning-box" style="margin-top:15px">${icon("key-round")}<span>Cloudflare 尚未配置 AI_CONFIG_ENCRYPTION_KEY，暂时不能保存第三方 API Key。</span></div>` : ""}<div class="provider-grid">${state.settings.providers.length ? state.settings.providers.map((provider) => `<div class="provider-card"><div><h3>${esc(provider.name)} ${statusBadge(provider.health_status)}</h3><p>${esc(provider.provider_type)} · ${esc(provider.base_url || "Workers AI binding")} · ${provider.key_configured ? esc(provider.api_key_masked) : "未配置 Key"}</p></div><div class="provider-actions"><button class="button button-small" data-action="test-provider" data-id="${esc(provider.id)}">${icon("plug-zap")}测试</button><button class="button button-small" data-action="edit-provider" data-id="${esc(provider.id)}">${icon("pencil")}编辑</button><button class="icon-button" data-action="delete-provider" data-id="${esc(provider.id)}" aria-label="删除服务商" title="删除服务商">${icon("trash-2")}</button></div></div>`).join("") : empty("plug", "还没有服务商", "添加 DeepSeek、火山方舟或兼容 API")}</div></article>`; }
function renderModelSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>模型</h2><p>模型 ID 和能力配置来自数据库，部署后仍可调整。</p></div><button class="button button-primary button-small" data-action="new-model">${icon("plus")}添加模型</button></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>服务商</th><th>模型 ID</th><th>能力</th><th>状态</th><th></th></tr></thead><tbody>${state.settings.models.length ? state.settings.models.map((model) => `<tr><td><strong>${esc(model.display_name)}</strong></td><td>${esc(model.provider_name || "")}</td><td>${esc(model.model_id)}</td><td>${model.supports_structured_output ? "结构化 JSON" : "普通文本"}</td><td>${model.enabled ? statusBadge("healthy") : statusBadge("archived")}</td><td><button class="button button-small" data-action="edit-model" data-id="${esc(model.id)}">编辑</button></td></tr>`).join("") : `<tr><td colspan="6">暂无模型</td></tr>`}</tbody></table></div></article>`; }
function renderRouteSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>模型路由</h2><p>整理和压缩任务分别使用独立路由。</p></div></div><div class="provider-grid">${state.settings.routes.map((route) => `<div class="provider-card"><div><h3>${esc(route.task_type === "organize_capture" ? "整理收集" : "压缩上下文")}</h3><p>默认模型：${esc(route.default_model_name || "未配置")} · 超时 ${esc(route.timeout_ms)} ms · 重试 ${esc(route.max_retries)} 次</p></div><button class="button button-small" data-action="edit-route" data-task="${esc(route.task_type)}">${icon("sliders-horizontal")}调整</button></div>`).join("")}</div></article>`; }
function renderSystemSettings() { return `<article class="panel settings-card"><div class="panel-title"><div><h2>系统健康</h2><p>当前实例绑定、密钥和服务商状态。</p></div><button class="button button-small" data-action="health">${icon("refresh-cw")}检查</button></div><div id="healthResult" class="empty">${icon("activity")}<div><strong>尚未检查</strong><p>点击检查读取当前部署状态。</p></div></div><div class="setting-note">导出的 JSON 和 ZIP 不包含登录密钥、加密主密钥或第三方 API Key。导入也不会覆盖这些密钥。</div></article>`; }

function bindView() {
  $$("[data-action]").forEach((node) => node.addEventListener("click", () => runAction(node).catch(handleError)));
  $("#captureForm")?.addEventListener("submit", (event) => submitCapture(event).catch(handleError));
  $("#captureSearch")?.addEventListener("input", filterCaptures);
  $("#captureStateFilter")?.addEventListener("change", filterCaptures);
  $("#contextMode")?.addEventListener("change", (event) => { state.contextMode = event.target.value; render(); });
  $("#contextStatus")?.addEventListener("change", (event) => { state.contextSelection.statuses = event.target.value.split(","); });
  $$('[data-context-category], [data-context-document], [data-context-block]').forEach((input) => input.addEventListener("change", updateContextSelection));
}

async function runAction(node) {
  const action = node.dataset.action;
  const id = node.dataset.id;
  if (action === "goto") return setView(node.dataset.viewTarget);
  if (action === "refresh-review") { state.selectedProposal = null; await loadProposals(); render(); return; }
  if (action === "capture-detail") return openCapture(id);
  if (action === "proposal-detail") { state.selectedProposal = (await api(`proposals/${id}`)).proposal; setView("review"); return; }
  if (action === "apply-proposal") { await api(`proposals/${id}/apply`, { method: "POST", body: {} }); toast("提案已应用"); state.selectedProposal = null; await loadCore(); setView("review"); return; }
  if (action === "reject-proposal") { if (!window.confirm("确定拒绝这条提案的全部操作吗？")) return; await api(`proposals/${id}/reject`, { method: "POST", body: {} }); toast("提案已拒绝"); state.selectedProposal = null; await loadCore(); setView("review"); return; }
  if (action === "apply-operation") { await api(`proposals/${node.dataset.proposal}/apply`, { method: "POST", body: { operation_ids: [id] } }); toast("操作已接受"); state.selectedProposal = (await api(`proposals/${node.dataset.proposal}`)).proposal; render(); return; }
  if (action === "reject-operation") { await api(`proposal-operations/${id}`, { method: "PATCH", body: { status: "rejected" } }); toast("操作已拒绝"); if (state.selectedProposal) state.selectedProposal = (await api(`proposals/${state.selectedProposal.id}`)).proposal; render(); return; }
  if (action === "edit-operation") return openOperationEditor(id);
  if (action === "category-filter") { state.libraryCategory = node.dataset.id; state.selectedDocument = null; render(); return; }
  if (action === "document-detail") { state.selectedDocument = (await api(`documents/${id}`)).document; render(); return; }
  if (action === "new-document") return openDocumentEditor();
  if (action === "edit-document") return openDocumentEditor(id);
  if (action === "delete-document") { if (!window.confirm("删除文档及其知识块？资料会先进入软删除状态。")) return; await api(`documents/${id}`, { method: "DELETE" }); toast("文档已删除"); state.selectedDocument = null; await loadDocuments(); render(); return; }
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
  if (action === "test-provider") { await api(`settings/ai/providers/${id}/test`, { method: "POST", body: {} }); toast("服务商连接正常"); await loadSettings(); render(); return; }
  if (action === "delete-provider") { if (!window.confirm("删除这个服务商配置？")) return; await api(`settings/ai/providers/${id}`, { method: "DELETE" }); toast("服务商已删除"); await loadSettings(); render(); return; }
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
}

async function submitCapture(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = $("button[type=submit]", form); button.disabled = true; button.innerHTML = `${icon("loader-circle")}整理中`;
  try {
    await api("captures", { method: "POST", body: { raw_text: data.get("raw_text"), processing_mode: data.get("processing_mode"), preferred_category_id: data.get("preferred_category_id"), requested_model_id: data.get("requested_model_id"), organize: true } });
    toast("原始输入已保存，提案正在生成"); await loadCore(); setView("review");
  } finally { button.disabled = false; button.innerHTML = `${icon("sparkles")}保存并整理`; renderIcons(); }
}

function showModal(content) { const dialog = $("#modal"); $("#modalCard").innerHTML = content; dialog.showModal(); renderIcons(); $("[data-close-modal]")?.addEventListener("click", () => dialog.close()); }
function closeModal() { $("#modal").close(); }
function modalShell(title, subtitle, body, foot = `<button class="button" data-close-modal>取消</button>`) { return `<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div><button class="icon-button" data-close-modal aria-label="关闭">${icon("x")}</button></div><div class="modal-body">${body}</div><div class="modal-foot">${foot}</div>`; }

async function openCapture(id) {
  const result = await api(`captures/${id}`);
  const capture = result.capture;
  const proposal = capture.proposals?.[0];
  showModal(modalShell("收集详情", `${statusLabel(capture.state)} · ${fmtTime(capture.updated_at)}`, `<div class="info-list"><div class="info-row"><span>处理模式</span><strong>${esc(capture.processing_mode)}</strong></div><div class="info-row"><span>分类</span><strong>${esc(capture.category_name || "自动判断")}</strong></div><div class="info-row"><span>错误</span><strong>${esc(capture.error_message || "无")}</strong></div></div><div class="compare-pane"><div class="compare-label">原始输入</div><div class="compare-content">${esc(capture.raw_text)}</div></div>${proposal ? `<div class="compare-pane"><div class="compare-label">最新整理结果</div><div class="compare-content">${esc(proposal.cleaned_text)}</div></div>` : ""}`, `<button class="button" data-close-modal>关闭</button>${["failed", "draft"].includes(capture.state) ? `<button class="button button-primary" data-modal-action="retry-capture" data-id="${esc(id)}">${icon("rotate-ccw")}重试整理</button>` : ""}`));
  $("[data-modal-action=retry-capture]")?.addEventListener("click", async () => { try { await api(`captures/${id}/retry`, { method: "POST", body: {} }); closeModal(); toast("已开始重试"); await loadCore(); render(); } catch (error) { handleError(error); } });
}

async function openOperationEditor(id) {
  const operation = state.selectedProposal?.operations?.find((item) => item.id === id) || (await api(`proposals/${state.selectedProposal?.id}`)).proposal.operations.find((item) => item.id === id);
  if (!operation) return;
  showModal(modalShell("编辑审核操作", "修改后接受会保留 edited 状态", `<div class="two-col"><label class="field"><span>操作类型</span><select name="action"><option value="create_document" ${operation.action === "create_document" ? "selected" : ""}>新建文档</option><option value="create_block" ${operation.action === "create_block" ? "selected" : ""}>新建知识块</option><option value="append" ${operation.action === "append" ? "selected" : ""}>追加</option><option value="merge" ${operation.action === "merge" ? "selected" : ""}>合并替换</option><option value="replace" ${operation.action === "replace" ? "selected" : ""}>替换</option><option value="mark_historical" ${operation.action === "mark_historical" ? "selected" : ""}>标记历史</option><option value="archive" ${operation.action === "archive" ? "selected" : ""}>归档</option></select></label><label class="field"><span>建议标题</span><input name="proposed_heading" value="${esc(operation.proposed_heading)}" /></label></div><label class="field"><span>建议正文</span><textarea name="proposed_body_md">${esc(operation.proposed_body_md)}</textarea></label><label class="field"><span>修改原因</span><input name="reason" value="${esc(operation.reason)}" /></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-operation">${icon("save")}保存修改</button>`));
  $("[data-modal-action=save-operation]")?.addEventListener("click", async () => { const body = { action: $("[name=action]", $("#modalCard")).value, proposed_heading: $("[name=proposed_heading]", $("#modalCard")).value, proposed_body_md: $("[name=proposed_body_md]", $("#modalCard")).value, reason: $("[name=reason]", $("#modalCard")).value, status: "edited" }; try { await api(`proposal-operations/${id}`, { method: "PATCH", body }); closeModal(); state.selectedProposal = (await api(`proposals/${state.selectedProposal.id}`)).proposal; toast("操作已保存"); render(); } catch (error) { handleError(error); } });
}

function openDocumentEditor(id = null) {
  const current = id ? state.documents.find((item) => item.id === id) : null;
  const title = current ? "编辑文档" : "新建文档";
  showModal(modalShell(title, "文档是知识块的容器", `<div class="two-col"><label class="field"><span>文档标题</span><input name="title" required value="${esc(current?.title || "")}" /></label><label class="field"><span>分类</span><select name="category_id">${categoryOptions(current?.category_id, false)}</select></label></div><label class="field"><span>摘要</span><textarea name="summary" style="min-height:90px">${esc(current?.summary || "")}</textarea></label>${current ? "" : `<label class="field"><span>初始正文（可选）</span><textarea name="body_md" style="min-height:130px"></textarea></label>`}`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-document">${icon("save")}保存</button>`));
  $("[data-modal-action=save-document]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { title: $("[name=title]", card).value, category_id: $("[name=category_id]", card).value, summary: $("[name=summary]", card).value }; if (!current) body.body_md = $("[name=body_md]", card).value; try { const result = current ? await api(`documents/${id}`, { method: "PATCH", body }) : await api("documents", { method: "POST", body }); closeModal(); state.selectedDocument = result.document; await loadDocuments(); toast(current ? "文档已更新" : "文档已创建"); render(); } catch (error) { handleError(error); } });
}

function openBlockEditor(id, documentId = null) {
  let current = null;
  if (id) for (const doc of state.documents) current = doc.blocks?.find((block) => block.id === id) || current;
  showModal(modalShell(current ? "编辑知识块" : "新建知识块", "正文使用 Markdown 保存", `<label class="field"><span>标题</span><input name="heading" required value="${esc(current?.heading || "")}" /></label><label class="field"><span>正文</span><textarea name="body_md" required style="min-height:230px">${esc(current?.body_md || "")}</textarea></label><label class="field"><span>状态</span><select name="status">${["current", "historical", "archived"].map((item) => `<option value="${item}" ${item === (current?.status || "current") ? "selected" : ""}>${statusLabel(item)}</option>`).join("")}</select></label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-block">${icon("save")}保存</button>`));
  $("[data-modal-action=save-block]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { heading: $("[name=heading]", card).value, body_md: $("[name=body_md]", card).value, status: $("[name=status]", card).value }; try { if (current) await api(`blocks/${id}`, { method: "PATCH", body }); else await api(`documents/${documentId}/blocks`, { method: "POST", body }); closeModal(); state.selectedDocument = (await api(`documents/${current?.document_id || documentId}`)).document; await loadDocuments(); toast("知识块已保存"); render(); } catch (error) { handleError(error); } });
}

async function openVersions(id) {
  const result = await api(`blocks/${id}/versions`);
  showModal(modalShell("历史版本", "每次正式编辑前都会保留当前版本", result.versions.length ? result.versions.map((version) => `<div class="operation-card"><div class="operation-card-head"><div><h3>版本 ${esc(version.version_no)}</h3><p>${esc(version.change_note || "未填写修改原因")} · ${fmtTime(version.created_at)}</p></div><button class="button button-small" data-version-restore="${esc(version.id)}" data-block="${esc(id)}">恢复</button></div><div class="compare-content">${esc(version.body_md)}</div></div>`).join("") : empty("history", "还没有历史版本", "下一次编辑时会自动生成"), `<button class="button" data-close-modal>关闭</button>`));
  $$('[data-version-restore]').forEach((button) => button.addEventListener("click", async () => { if (!window.confirm("恢复这个版本？当前正文会先保存为新历史版本。")) return; try { await api(`blocks/${button.dataset.block}/restore/${button.dataset.versionRestore}`, { method: "POST", body: {} }); closeModal(); toast("版本已恢复"); await loadDocuments(); if (state.selectedDocument) state.selectedDocument = (await api(`documents/${state.selectedDocument.id}`)).document; render(); } catch (error) { handleError(error); } }));
}

function openProviderEditor(id = null) {
  const current = state.settings.providers.find((item) => item.id === id);
  showModal(modalShell(current ? "编辑 AI 服务商" : "添加 AI 服务商", "API Key 保存后只能替换或删除", `<div class="two-col"><label class="field"><span>服务类型</span><select name="provider_type">${["deepseek", "volcengine", "openai_compatible", "cloudflare_ai"].map((type) => `<option value="${type}" ${type === (current?.provider_type || "deepseek") ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field"><span>显示名称</span><input name="name" value="${esc(current?.name || "")}" required /></label></div><label class="field"><span>Base URL</span><input name="base_url" value="${esc(current?.base_url || "")}" placeholder="https://api.deepseek.com" /></label><label class="field"><span>API Key</span><input name="api_key" type="password" autocomplete="new-password" placeholder="${current?.key_configured ? `已配置 ${esc(current.api_key_masked)}，留空不变` : "输入服务商 API Key"}" /></label><div class="two-col"><label class="field"><span>超时（毫秒）</span><input name="timeout_ms" type="number" value="${esc(current?.timeout_ms || 30000)}" min="3000" max="120000" /></label><label class="inline-check"><input name="enabled" type="checkbox" ${current?.enabled !== false ? "checked" : ""} />启用服务商</label></div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-provider">${icon("save")}保存</button>`));
  $("[data-modal-action=save-provider]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { provider_type: $("[name=provider_type]", card).value, name: $("[name=name]", card).value, base_url: $("[name=base_url]", card).value, api_key: $("[name=api_key]", card).value, timeout_ms: $("[name=timeout_ms]", card).value, enabled: $("[name=enabled]", card).checked }; try { if (current) await api(`settings/ai/providers/${id}`, { method: "PATCH", body }); else await api("settings/ai/providers", { method: "POST", body }); closeModal(); await loadSettings(); toast("服务商已保存"); render(); } catch (error) { handleError(error); } });
}

function openModelEditor(id = null) {
  const current = state.settings.models.find((item) => item.id === id);
  showModal(modalShell(current ? "编辑模型" : "添加模型", "模型 ID 由服务商账号或推理接入点决定", `<div class="two-col"><label class="field"><span>服务商</span><select name="provider_id">${state.settings.providers.map((provider) => `<option value="${esc(provider.id)}" ${provider.id === current?.provider_id ? "selected" : ""}>${esc(provider.name)}</option>`).join("")}</select></label><label class="field"><span>显示名称</span><input name="display_name" value="${esc(current?.display_name || "")}" required /></label></div><label class="field"><span>真实模型 ID / 推理接入点 ID</span><input name="model_id" value="${esc(current?.model_id || "")}" required /></label><div class="two-col"><label class="field"><span>成本等级</span><select name="cost_level">${["unknown", "free", "low", "medium", "high"].map((level) => `<option value="${level}" ${level === (current?.cost_level || "unknown") ? "selected" : ""}>${level}</option>`).join("")}</select></label><label class="field"><span>最大输出 Token</span><input name="max_output_tokens" type="number" value="${esc(current?.max_output_tokens || 1800)}" /></label></div><div class="two-col"><label class="inline-check"><input name="enabled" type="checkbox" ${current?.enabled !== false ? "checked" : ""} />启用模型</label><label class="inline-check"><input name="supports_structured_output" type="checkbox" ${current?.supports_structured_output !== false ? "checked" : ""} />支持 JSON 输出</label></div>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-model">${icon("save")}保存</button>`));
  $("[data-modal-action=save-model]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { provider_id: $("[name=provider_id]", card).value, display_name: $("[name=display_name]", card).value, model_id: $("[name=model_id]", card).value, cost_level: $("[name=cost_level]", card).value, max_output_tokens: $("[name=max_output_tokens]", card).value, enabled: $("[name=enabled]", card).checked, supports_structured_output: $("[name=supports_structured_output]", card).checked }; try { if (current) await api(`settings/ai/models/${id}`, { method: "PATCH", body }); else await api("settings/ai/models", { method: "POST", body }); closeModal(); await loadSettings(); toast("模型已保存"); render(); } catch (error) { handleError(error); } });
}

function openRouteEditor(taskType) {
  const route = state.settings.routes.find((item) => item.task_type === taskType);
  if (!route) return;
  showModal(modalShell("调整模型路由", taskType === "organize_capture" ? "原始输入整理" : "上下文压缩", `<label class="field"><span>默认模型</span><select name="default_model_id"><option value="">未配置</option>${state.settings.models.filter((model) => model.enabled).map((model) => `<option value="${esc(model.id)}" ${model.id === route.default_model_id ? "selected" : ""}>${esc(model.display_name)}</option>`).join("")}</select></label><div class="two-col"><label class="field"><span>超时（毫秒）</span><input name="timeout_ms" type="number" value="${esc(route.timeout_ms)}" /></label><label class="field"><span>最大重试</span><input name="max_retries" type="number" min="0" max="2" value="${esc(route.max_retries)}" /></label></div><div class="two-col"><label class="field"><span>最大输入字符</span><input name="max_input_chars" type="number" value="${esc(route.max_input_chars)}" /></label><label class="field"><span>最大输出 Token</span><input name="max_output_tokens" type="number" value="${esc(route.max_output_tokens)}" /></label></div><label class="inline-check"><input name="allow_cross_provider" type="checkbox" ${route.allow_cross_provider ? "checked" : ""} />允许跨服务商切换</label>`, `<button class="button" data-close-modal>取消</button><button class="button button-primary" data-modal-action="save-route">${icon("save")}保存</button>`));
  $("[data-modal-action=save-route]")?.addEventListener("click", async () => { const card = $("#modalCard"); const body = { default_model_id: $("[name=default_model_id]", card).value, timeout_ms: $("[name=timeout_ms]", card).value, max_retries: $("[name=max_retries]", card).value, max_input_chars: $("[name=max_input_chars]", card).value, max_output_tokens: $("[name=max_output_tokens]", card).value, allow_cross_provider: $("[name=allow_cross_provider]", card).checked }; try { await api(`settings/ai/routes/${taskType}`, { method: "PATCH", body }); closeModal(); await loadSettings(); await loadDashboard(); toast("模型路由已更新"); render(); } catch (error) { handleError(error); } });
}

async function previewContext() {
  const budget = $("#contextBudget")?.value;
  if (budget) state.contextSelection.token_budget = Number(budget);
  state.contextPreview = await api("context/preview", { method: "POST", body: { selection: state.contextSelection, mode: state.contextMode, token_budget: state.contextSelection.token_budget } });
  render(); toast("上下文预览已生成");
}

async function copyContext() {
  if (!state.contextPreview?.markdown) return toast("请先生成上下文预览", "error");
  await navigator.clipboard.writeText(state.contextPreview.markdown); toast("上下文已复制");
}

async function downloadContext(format) {
  if (!state.contextPreview) return toast("请先生成上下文预览", "error");
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
  $("[data-modal-action=apply-import]")?.addEventListener("click", async () => { if (!backup || !window.confirm("确认把预览中的数据写入当前数据库？同 ID 数据会更新。")) return; try { const result = await api("import/apply", { method: "POST", body: backup }); closeModal(); await loadCore(); toast(`已导入 ${result.total} 行`); render(); } catch (error) { handleError(error); } });
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
$$('[data-view]').forEach((node) => node.addEventListener("click", (event) => { event.preventDefault(); setView(node.dataset.view); }));
$("#modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
boot();
