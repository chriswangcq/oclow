const LANGUAGE_KEY = "ai-meditations-language";

const state = {
  view: "browse",
  currentDir: ".",
  currentMainPath: "",
  selectedPath: "",
  language: initialLanguage(),
  mcpConfig: null,
  authProviders: null,
  journalBlocks: [],
  journalType: "all",
  journalRange: "7",
  searchOpen: false,
  agentOpen: false,
  auditOpen: false,
  safetyOpen: false,
  searchResults: [],
  searchActiveIndex: -1,
  searchRequestId: 0,
  searchTimer: 0,
  loadId: 0
};

const $ = (selector) => document.querySelector(selector);

const loginView = $("#login");
const appView = $("#app");
const filePreview = $("#file-preview");
let eventsBound = false;
const HOME_PATH = "docs";
const CHILD_DOCUMENTS_DIRECTORY = "sub_docs";
const LANGUAGE_LOCALES = {
  en: "en-US",
  zh: "zh-CN"
};
const I18N = {
  en: {
    brand: "AI Meditations",
    "language.short": "中文",
    "language.action": "Switch to Chinese",
    "language.toggle": "Switch language",
    "login.google": "Continue with Google",
    "login.orPassword": "Or use password",
    "login.submit": "Sign in",
    "login.failed": "Sign in failed",
    "nav.about": "About",
    "nav.mcpGuide": "MCP Guide",
    "nav.privacy": "Privacy",
    "nav.terms": "Terms",
    "nav.docs": "Docs",
    "nav.journal": "Journal",
    "nav.search": "Search",
    "nav.audit": "Activity log",
    "nav.auditShort": "Log",
    "nav.safety": "Data safety",
    "nav.safetyShort": "Safety",
    "nav.agent": "Connect Agent",
    "nav.more": "More",
    "nav.logout": "Sign out",
    "icon.docs": "D",
    "icon.journal": "J",
    "icon.audit": "L",
    "icon.safety": "S",
    "aria.publicPages": "Public pages",
    "aria.appNavigation": "App navigation",
    "aria.mainNavigation": "Primary navigation",
    "aria.currentPath": "Current path",
    "aria.searchResults": "Search results",
    "root.docs": "All documents",
    "root.journal": "Journal",
    "root.workspace": "Workspace",
    "empty.selectDocument": "Select a document",
    "empty.selectJournal": "Select a journal entry",
    "empty.previewHint": "Choose a document from the sidebar to read it.",
    "empty.noSiblings": "No sibling documents.",
    "empty.noChildren": "No child documents.",
    "empty.noPages": "No pages.",
    "empty.noJournal": "No journal records match the current filters.",
    "empty.noSearch": "No matching content found.",
    "empty.searchStart": "Type a keyword to start searching.",
    "empty.searching": "Searching.",
    "empty.searchFailed": "Search failed.",
    "empty.loadingTitle": "Opening document",
    "empty.loadingCopy": "Markdown pages in the same document will be shown in order below.",
    "empty.noAudit": "No activity yet.",
    "empty.noBackups": "No local backups yet.",
    "sidebar.siblings": "Sibling documents",
    "sidebar.pages": "Pages in this document",
    "sidebar.children": "Child documents",
    "file.currentDocument": "Current document",
    "file.documentPackage": "Document package",
    "file.mainPage": "Main page",
    "file.same": "Peer",
    "file.child": "Child",
    "file.mainIcon": "Main",
    "file.pageIcon": "Page",
    "meta.noPages": "No pages",
    "meta.pageOne": "{count} page",
    "meta.pageMany": "{count} pages",
    "meta.childOne": "{count} child document",
    "meta.childMany": "{count} child documents",
    "timeline.type": "Type",
    "timeline.all": "All",
    "timeline.session": "Session",
    "timeline.change": "Change",
    "timeline.decision": "Decision",
    "timeline.question": "Question",
    "timeline.pending": "Needs distillation",
    "timeline.note": "Note",
    "timeline.range": "Range",
    "timeline.range7": "7 days",
    "timeline.range30": "30 days",
    "timeline.summary": "{records} records · {pending} need distillation",
    "timeline.undated": "Undated",
    "timeline.open": "Open journal",
    "timeline.distilled": "Distilled",
    "search.title": "Search",
    "search.placeholder": "Search documents, journal, and content",
    "children.aria": "Child document preview",
    "children.kicker": "Child documents",
    "children.title": "Continue reading",
    "children.noSummary": "This child document does not have a summary yet.",
    "agent.title": "Connect Agent",
    "agent.intro": "Connect AI Meditations to an MCP-capable client so agents can read and update your workspace through the file sandbox rules.",
    "agent.chooseTitle": "Start with what your client supports",
    "agent.chooseCopy": "Use automatic OAuth when the client has an OAuth, authorization, or connect flow. Use manual JSON only when that is all the client supports.",
    "agent.recommended": "Recommended",
    "agent.oauthTitle": "Automatic OAuth",
    "agent.oauthCopy": "Copy this address into your client's MCP Server URL field. The client will open a browser; sign in and approve access.",
    "agent.oauthStep1": "Choose OAuth or Remote MCP in your client.",
    "agent.oauthStep2": "Paste the MCP Server URL above.",
    "agent.oauthStep3": "Follow the prompt to sign in and approve access.",
    "agent.fallback": "Fallback",
    "agent.manualTitle": "Manual configuration",
    "agent.manualCopy": "If your client does not support OAuth, copy the full JSON config. It contains a Bearer key for this account, so only use it with clients you trust.",
    "agent.advanced": "Advanced information",
    "agent.scope": "Scope",
    "agent.scopeCurrent": "Current signed-in user's workspace",
    "audit.title": "Activity log",
    "audit.openDocument": "Open document",
    "safety.title": "Data safety",
    "safety.intro": "Export the current workspace, or keep a downloadable backup on the server.",
    "safety.download": "Download workspace",
    "safety.createBackup": "Create local backup",
    "safety.localBackups": "Local backups",
    "safety.created": "Created",
    "safety.retention": "Keep {count} backups",
    "safety.downloadBackup": "Download",
    "action.refresh": "Refresh",
    "action.close": "Close",
    "action.copy": "Copied",
    "action.copyUrl": "Copy URL",
    "action.copyJson": "Copy JSON config",
    "action.copySourcePath": "Copy source path",
    "action.showConfig": "Show config",
    "action.hideConfig": "Hide config"
  },
  zh: {
    brand: "AI 沉思录",
    "language.short": "EN",
    "language.action": "切换到 English",
    "language.toggle": "切换语言",
    "login.google": "使用 Google 登录",
    "login.orPassword": "或使用密码",
    "login.submit": "登录",
    "login.failed": "登录失败",
    "nav.about": "关于",
    "nav.mcpGuide": "MCP 接入",
    "nav.privacy": "隐私政策",
    "nav.terms": "服务条款",
    "nav.docs": "文档",
    "nav.journal": "日记",
    "nav.search": "搜索",
    "nav.audit": "操作记录",
    "nav.auditShort": "记录",
    "nav.safety": "数据安全",
    "nav.safetyShort": "安全",
    "nav.agent": "连接 Agent",
    "nav.more": "更多",
    "nav.logout": "退出登录",
    "icon.docs": "文",
    "icon.journal": "日",
    "icon.audit": "记",
    "icon.safety": "安",
    "aria.publicPages": "公开页面",
    "aria.appNavigation": "应用导航",
    "aria.mainNavigation": "主导航",
    "aria.currentPath": "当前路径",
    "aria.searchResults": "搜索结果",
    "root.docs": "全部文档",
    "root.journal": "日记",
    "root.workspace": "工作区",
    "empty.selectDocument": "选择一个文档",
    "empty.selectJournal": "选择一条记录",
    "empty.previewHint": "点击左侧页面树中的文档进行阅读。",
    "empty.noSiblings": "暂无同级文档。",
    "empty.noChildren": "暂无子文档。",
    "empty.noPages": "暂无页面。",
    "empty.noJournal": "当前筛选下暂无日记记录。",
    "empty.noSearch": "没有找到匹配内容。",
    "empty.searchStart": "输入关键词开始搜索。",
    "empty.searching": "搜索中。",
    "empty.searchFailed": "搜索失败。",
    "empty.loadingTitle": "正在展开文档",
    "empty.loadingCopy": "同一文档中的 Markdown 会按顺序排列在下方。",
    "empty.noAudit": "暂无日志。",
    "empty.noBackups": "暂无本地备份。",
    "sidebar.siblings": "同级文档",
    "sidebar.pages": "本文档子页面",
    "sidebar.children": "本文档子文档",
    "file.currentDocument": "当前文档",
    "file.documentPackage": "文档包",
    "file.mainPage": "主页面",
    "file.same": "同",
    "file.child": "子",
    "file.mainIcon": "主",
    "file.pageIcon": "页",
    "meta.noPages": "暂无页面",
    "meta.pageOne": "{count} 页",
    "meta.pageMany": "{count} 页",
    "meta.childOne": "{count} 个子文档",
    "meta.childMany": "{count} 个子文档",
    "timeline.type": "类型",
    "timeline.all": "全部",
    "timeline.session": "会话",
    "timeline.change": "变更",
    "timeline.decision": "决策",
    "timeline.question": "问题",
    "timeline.pending": "待沉淀",
    "timeline.note": "记录",
    "timeline.range": "范围",
    "timeline.range7": "7 天",
    "timeline.range30": "30 天",
    "timeline.summary": "{records} 条记录 · {pending} 条待沉淀",
    "timeline.undated": "未注明日期",
    "timeline.open": "打开日记",
    "timeline.distilled": "已沉淀",
    "search.title": "搜索",
    "search.placeholder": "搜索文档、日记和内容",
    "children.aria": "子文档预览",
    "children.kicker": "子文档",
    "children.title": "继续阅读",
    "children.noSummary": "这个子文档还没有摘要。",
    "agent.title": "连接 Agent",
    "agent.intro": "把 AI 沉思录接到支持 MCP 的 AI 客户端后，Agent 就可以按文件沙盒规则读取和更新你的工作区。",
    "agent.chooseTitle": "先看你的客户端支持什么",
    "agent.chooseCopy": "有“OAuth / 授权 / Connect”选项，就用自动授权；只有 JSON 配置入口，就用手动配置。",
    "agent.recommended": "推荐",
    "agent.oauthTitle": "自动授权",
    "agent.oauthCopy": "复制这个地址到客户端的 MCP Server URL。客户端会打开浏览器，你登录后点击授权即可。",
    "agent.oauthStep1": "在客户端选择 OAuth 或 Remote MCP。",
    "agent.oauthStep2": "粘贴上面的 MCP Server URL。",
    "agent.oauthStep3": "按提示登录 AI 沉思录并授权。",
    "agent.fallback": "备用",
    "agent.manualTitle": "手动配置",
    "agent.manualCopy": "如果客户端不支持 OAuth，复制完整 JSON 配置。里面包含当前账号的 Bearer key，请只放进你信任的客户端。",
    "agent.advanced": "高级信息",
    "agent.scope": "权限范围",
    "agent.scopeCurrent": "当前登录用户的工作区",
    "audit.title": "操作记录",
    "audit.openDocument": "进入文档",
    "safety.title": "数据安全",
    "safety.intro": "导出当前工作区，或在服务器本地保留一份可下载的备份。",
    "safety.download": "下载工作区",
    "safety.createBackup": "创建本地备份",
    "safety.localBackups": "本地备份",
    "safety.created": "已创建",
    "safety.retention": "保留 {count} 份",
    "safety.downloadBackup": "下载",
    "action.refresh": "刷新",
    "action.close": "关闭",
    "action.copy": "已复制",
    "action.copyUrl": "复制地址",
    "action.copyJson": "复制 JSON 配置",
    "action.copySourcePath": "复制源文件路径",
    "action.showConfig": "查看配置",
    "action.hideConfig": "隐藏配置"
  }
};
const ROOTS = {
  docs: { labelKey: "root.docs", emptyTitleKey: "empty.selectDocument" },
  journal: { labelKey: "root.journal", emptyTitleKey: "empty.selectJournal" }
};

const VIEW_LABELS = {
  browse: "nav.docs",
  timeline: "nav.journal"
};

boot();

function initialLanguage() {
  let saved = "";
  try {
    saved = window.localStorage.getItem(LANGUAGE_KEY) ?? "";
  } catch {
    saved = "";
  }
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(key, params = {}) {
  const value = I18N[state.language]?.[key] ?? I18N.en[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

function currentLocale() {
  return LANGUAGE_LOCALES[state.language] ?? LANGUAGE_LOCALES.en;
}

function applyStaticTranslations() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  syncConfigToggleLabel();
  updateDocumentTitle();
}

async function setLanguage(language) {
  if (!["en", "zh"].includes(language) || state.language === language) return;
  state.language = language;
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // The language switch still works for the current session when storage is unavailable.
  }
  applyStaticTranslations();

  if (loginView.hidden && !appView.hidden) {
    if (state.view === "timeline") {
      renderJournalTimeline();
    } else if (state.currentDir) {
      await loadDirectory(state.currentDir);
    }
  }
}

function nextLanguage() {
  return state.language === "zh" ? "en" : "zh";
}

function updateDocumentTitle() {
  document.title = state.view === "browse" ? t("brand") : `${t("brand")} · ${t(VIEW_LABELS[state.view] ?? "nav.docs")}`;
}

function pageCountLabel(count) {
  return t(count === 1 ? "meta.pageOne" : "meta.pageMany", { count });
}

function childCountLabel(count) {
  return t(count === 1 ? "meta.childOne" : "meta.childMany", { count });
}

async function boot() {
  bindEvents();
  applyStaticTranslations();

  const bootstrap = await api(`/api/bootstrap?path=${encodeURIComponent(HOME_PATH)}`, { silent: true });
  state.authProviders = bootstrap?.providers ?? null;
  updateLoginProviders();

  if (!bootstrap?.user) {
    loginView.hidden = false;
    appView.hidden = true;
    return;
  }

  $("#user-email").textContent = bootstrap.user.email;
  loginView.hidden = true;
  appView.hidden = false;

  if (bootstrap.document) {
    const loadId = ++state.loadId;
    state.currentDir = bootstrap.document.path ?? HOME_PATH;
    renderPanelPath(state.currentDir);
    renderLoadedDocumentPackage(bootstrap.document, loadId);
  } else {
    await loadDirectory(HOME_PATH);
  }
  setView("browse");
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  $("#login-language").addEventListener("click", () => setLanguage(nextLanguage()));
  $("#menu-language").addEventListener("click", () => setLanguage(nextLanguage()));

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await api("/api/login", {
      method: "POST",
      body: {
        email: $("#email").value,
        password: $("#password").value
      },
      silent: true
    });

    if (response?.user) {
      $("#login-error").textContent = "";
      await boot();
    } else {
      $("#login-error").textContent = response?.error ?? t("login.failed");
    }
  });

  $("#menu-logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.reload();
  });

  document.querySelectorAll(".nav button").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.root) {
        await loadDirectory(button.dataset.root);
        setView("browse");
        return;
      }
      if (button.dataset.view === "timeline") await loadJournal();
      setView(button.dataset.view);
    });
  });

  $("#top-search").addEventListener("click", () => openSearchPalette());
  $("#top-audit").addEventListener("click", () => openAuditPalette());
  $("#top-safety").addEventListener("click", () => openSafetyPalette());
  $("#top-agent").addEventListener("click", () => openAgentPalette());
  $("#menu-search").addEventListener("click", () => openSearchPalette());
  $("#menu-audit").addEventListener("click", () => openAuditPalette());
  $("#menu-safety").addEventListener("click", () => openSafetyPalette());
  $("#menu-agent").addEventListener("click", () => openAgentPalette());

  $("#top-more").addEventListener("click", (event) => {
    event.stopPropagation();
    setTopMenuOpen($("#top-menu").hidden);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".menu-wrap")) closeTopMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.searchOpen) {
        closeSearchPalette();
        return;
      }
      if (state.agentOpen) {
        closeAgentPalette();
        return;
      }
      if (state.auditOpen) {
        closeAuditPalette();
        return;
      }
      if (state.safetyOpen) {
        closeSafetyPalette();
        return;
      }
      closeTopMenu();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearchPalette();
      return;
    }

    if (event.key === "/" && !isTypingTarget(event.target) && loginView.hidden && !appView.hidden) {
      event.preventDefault();
      openSearchPalette();
    }
  });

  $("#copy-path").addEventListener("click", async () => {
    const sourcePath = state.currentMainPath || state.selectedPath;
    if (sourcePath) await navigator.clipboard.writeText(sourcePath);
  });

  $("#search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.searchActiveIndex >= 0) {
      openSearchResult(state.searchActiveIndex);
      return;
    }
    await search($("#search-input").value);
  });
  $("#search-input").addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    const value = $("#search-input").value.trim();
    state.searchRequestId += 1;
    state.searchResults = [];
    state.searchActiveIndex = -1;
    renderSearchEmpty(value ? t("empty.searching") : t("empty.searchStart"));
    if (!value) return;
    state.searchTimer = window.setTimeout(() => search($("#search-input").value), 180);
  });
  $("#search-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection(-1);
    }
  });
  document.querySelectorAll("[data-close-search]").forEach((element) => {
    element.addEventListener("click", () => closeSearchPalette());
  });
  document.querySelectorAll("[data-close-agent]").forEach((element) => {
    element.addEventListener("click", () => closeAgentPalette());
  });
  document.querySelectorAll("[data-close-audit]").forEach((element) => {
    element.addEventListener("click", () => closeAuditPalette());
  });
  document.querySelectorAll("[data-close-safety]").forEach((element) => {
    element.addEventListener("click", () => closeSafetyPalette());
  });

  $("#refresh-mcp").addEventListener("click", loadMcpConfig);
  $("#copy-mcp").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(state.mcpConfig?.config ?? {}, null, 2));
    flashButton($("#copy-mcp"), t("action.copy"));
  });
  $("#copy-oauth-url").addEventListener("click", async () => {
    if (state.mcpConfig?.url) {
      await navigator.clipboard.writeText(state.mcpConfig.url);
      flashButton($("#copy-oauth-url"), t("action.copy"));
    }
  });
  $("#toggle-mcp-config").addEventListener("click", () => {
    const panel = $("#mcp-config-panel");
    const button = $("#toggle-mcp-config");
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    syncConfigToggleLabel();
  });

  $("#refresh-timeline").addEventListener("click", loadJournal);
  document.querySelectorAll("[data-timeline-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.journalType = button.dataset.timelineType;
      renderJournalTimeline();
    });
  });
  document.querySelectorAll("[data-timeline-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.journalRange = button.dataset.timelineRange;
      renderJournalTimeline();
    });
  });

  $("#refresh-audit").addEventListener("click", loadAudit);
  $("#refresh-backups").addEventListener("click", loadBackups);
  $("#download-export").addEventListener("click", () => {
    window.location.href = "/api/workspaces/export";
  });
  $("#create-backup").addEventListener("click", createBackup);
}

function updateLoginProviders() {
  const googleEnabled = Boolean(state.authProviders?.google?.enabled);
  $("#google-login").hidden = !googleEnabled;
  $("#login-divider").hidden = !googleEnabled;
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav button").forEach((button) => {
    const isActive = button.dataset.root
      ? view === "browse" && rootSegment(state.currentDir) === button.dataset.root
      : button.dataset.view === view;
    button.classList.toggle("active", isActive);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.id !== `${view}-view`;
  });

  updateDocumentTitle();
}

function setTopMenuOpen(open) {
  $("#top-menu").hidden = !open;
  $("#top-more").setAttribute("aria-expanded", String(open));
  $("#top-more").classList.toggle("active", open);
}

function syncConfigToggleLabel() {
  const panel = $("#mcp-config-panel");
  const button = $("#toggle-mcp-config");
  if (!panel || !button) return;
  button.textContent = panel.hidden ? t("action.showConfig") : t("action.hideConfig");
}

function closeTopMenu() {
  setTopMenuOpen(false);
}

function openSearchPalette() {
  if (!loginView.hidden || appView.hidden) return;
  closeTopMenu();
  closeAgentPalette({ restoreFocus: false });
  closeAuditPalette({ restoreFocus: false });
  closeSafetyPalette({ restoreFocus: false });
  state.searchOpen = true;
  $("#search-overlay").hidden = false;
  $("#top-search").classList.add("active");
  $("#top-search").setAttribute("aria-expanded", "true");

  const input = $("#search-input");
  if (input.value.trim()) {
    search(input.value);
  } else {
    renderSearchEmpty(t("empty.searchStart"));
  }

  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeSearchPalette(options = {}) {
  const restoreFocus = options.restoreFocus ?? true;
  if (!state.searchOpen) return;
  window.clearTimeout(state.searchTimer);
  state.searchOpen = false;
  $("#search-overlay").hidden = true;
  $("#top-search").classList.remove("active");
  $("#top-search").setAttribute("aria-expanded", "false");
  if (restoreFocus && $("#search-overlay").contains(document.activeElement)) {
    $("#top-search").focus();
  }
}

async function openAgentPalette() {
  if (!loginView.hidden || appView.hidden) return;
  closeTopMenu();
  closeSearchPalette({ restoreFocus: false });
  closeAuditPalette({ restoreFocus: false });
  closeSafetyPalette({ restoreFocus: false });
  state.agentOpen = true;
  $("#agent-overlay").hidden = false;
  $("#top-agent").classList.add("active");
  $("#top-agent").setAttribute("aria-expanded", "true");
  window.requestAnimationFrame(() => $("#copy-oauth-url").focus());
  await loadMcpConfig();
}

function closeAgentPalette(options = {}) {
  const restoreFocus = options.restoreFocus ?? true;
  if (!state.agentOpen) return;
  state.agentOpen = false;
  $("#agent-overlay").hidden = true;
  $("#top-agent").classList.remove("active");
  $("#top-agent").setAttribute("aria-expanded", "false");
  if (restoreFocus && $("#agent-overlay").contains(document.activeElement)) {
    $("#top-agent").focus();
  }
}

async function openAuditPalette() {
  if (!loginView.hidden || appView.hidden) return;
  closeTopMenu();
  closeSearchPalette({ restoreFocus: false });
  closeAgentPalette({ restoreFocus: false });
  closeSafetyPalette({ restoreFocus: false });
  state.auditOpen = true;
  $("#audit-overlay").hidden = false;
  $("#top-audit").classList.add("active");
  $("#top-audit").setAttribute("aria-expanded", "true");
  await loadAudit();
  window.requestAnimationFrame(() => $("#refresh-audit").focus());
}

function closeAuditPalette(options = {}) {
  const restoreFocus = options.restoreFocus ?? true;
  if (!state.auditOpen) return;
  state.auditOpen = false;
  $("#audit-overlay").hidden = true;
  $("#top-audit").classList.remove("active");
  $("#top-audit").setAttribute("aria-expanded", "false");
  if (restoreFocus && $("#audit-overlay").contains(document.activeElement)) {
    $("#top-audit").focus();
  }
}

async function openSafetyPalette() {
  if (!loginView.hidden || appView.hidden) return;
  closeTopMenu();
  closeSearchPalette({ restoreFocus: false });
  closeAgentPalette({ restoreFocus: false });
  closeAuditPalette({ restoreFocus: false });
  state.safetyOpen = true;
  $("#safety-overlay").hidden = false;
  $("#top-safety").classList.add("active");
  $("#top-safety").setAttribute("aria-expanded", "true");
  await loadBackups();
  window.requestAnimationFrame(() => $("#download-export").focus());
}

function closeSafetyPalette(options = {}) {
  const restoreFocus = options.restoreFocus ?? true;
  if (!state.safetyOpen) return;
  state.safetyOpen = false;
  $("#safety-overlay").hidden = true;
  $("#top-safety").classList.remove("active");
  $("#top-safety").setAttribute("aria-expanded", "false");
  if (restoreFocus && $("#safety-overlay").contains(document.activeElement)) {
    $("#top-safety").focus();
  }
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

async function loadDirectory(path = ".") {
  const loadId = ++state.loadId;
  state.currentDir = path;
  renderPanelPath(path);
  showLoadingPreview(path);

  const data = await api(`/api/documents/package?path=${encodeURIComponent(path)}`);
  if (loadId !== state.loadId) return;
  renderLoadedDocumentPackage(data, loadId);
}

function renderLoadedDocumentPackage(data, loadId = state.loadId) {
  const path = data.path ?? state.currentDir;
  const entries = data.entries ?? [];
  state.currentDir = path;
  renderPanelPath(path);
  renderSidebarNavigation(path, data.siblingDocuments ?? [], data.pages ?? [], data.childDocuments ?? []);
  openDocumentPackage(path, entries, data.childDocuments ?? [], data.pages ?? [], loadId);
}

function renderPanelPath(path) {
  const container = $("#panel-path");
  container.innerHTML = "";
  const crumbs = panelPathCrumbs(path);
  const visibleCrumbs = compactCrumbs(crumbs);

  for (const crumb of visibleCrumbs) {
    if (container.childNodes.length) {
      const sep = document.createElement("span");
      sep.className = "panel-path-sep";
      sep.textContent = "/";
      container.append(sep);
    }

    if (crumb.ellipsis) {
      const ellipsis = document.createElement("span");
      ellipsis.className = "panel-path-ellipsis";
      ellipsis.textContent = "...";
      container.append(ellipsis);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.label;
    button.title = crumb.path;
    button.addEventListener("click", () => loadDirectory(crumb.path));
    container.append(button);
  }
}

function panelPathCrumbs(path) {
  const root = rootSegment(path);
  const rootConfig = ROOTS[root];
  const rootPath = rootConfig ? root : ".";
  const rootLabel = rootConfig ? t(rootConfig.labelKey) : t("root.workspace");
  const crumbs = [{ label: rootLabel, path: rootPath }];
  if (path === "." || rootConfig && path === root) return crumbs;

  const displayPath = rootConfig ? path.slice(root.length + 1) : path;
  let cursor = rootConfig ? root : "";
  for (const part of displayPath.split("/").filter(Boolean)) {
    cursor = cursor ? `${cursor}/${part}` : part;
    if (part === CHILD_DOCUMENTS_DIRECTORY) continue;
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}

function compactCrumbs(crumbs) {
  if (crumbs.length <= 3) return crumbs;
  return [crumbs[0], { ellipsis: true }, ...crumbs.slice(-2)];
}

function renderSidebarNavigation(currentPath, siblingDocuments, pages, childDocuments) {
  renderSiblingDocumentList(siblingDocuments, currentPath);
  renderPageList(pages);
  renderChildDocumentList(childDocuments);
}

function renderSiblingDocumentList(documents, currentPath) {
  const container = $("#sibling-list");
  container.innerHTML = "";
  $("#sibling-count").textContent = String(documents.length);

  if (!documents.length) {
    renderEmptyList(container, t("empty.noSiblings"));
    return;
  }

  for (const doc of documents) {
    const row = document.createElement("button");
    row.className = "file-row sibling-row";
    row.dataset.kind = "document";
    row.dataset.path = doc.path;
    row.title = doc.title;
    row.classList.toggle("active", doc.path === currentPath);
    row.innerHTML = `
      <span class="file-icon" aria-hidden="true">${escapeHtml(t("file.same"))}</span>
      <span class="file-name">${escapeHtml(doc.title)}</span>
      <span class="file-meta">${escapeHtml(doc.path === currentPath ? t("file.currentDocument") : documentCardMeta(doc))}</span>
    `;
    row.addEventListener("click", async () => {
      await loadDirectory(doc.path);
    });
    container.append(row);
  }
}

function renderChildDocumentList(childDocuments) {
  const container = $("#file-list");
  container.innerHTML = "";
  $("#subdoc-count").textContent = String(childDocuments.length);

  if (!childDocuments.length) {
    renderEmptyList(container, t("empty.noChildren"));
    return;
  }

  for (const childDocument of childDocuments) {
    const row = document.createElement("button");
    row.className = "file-row child-document-row";
    row.dataset.kind = "document";
    row.dataset.path = childDocument.path;
    row.title = childDocument.title;
    row.innerHTML = `
      <span class="file-icon" aria-hidden="true">${escapeHtml(t("file.child"))}</span>
      <span class="file-name">${escapeHtml(childDocument.title)}</span>
      <span class="file-meta">${escapeHtml(documentCardMeta(childDocument))}</span>
    `;
    row.addEventListener("click", async () => {
      await loadDirectory(childDocument.path);
    });
    container.append(row);
  }
}

function renderPageList(pages) {
  const container = $("#page-list");
  container.innerHTML = "";
  $("#page-count").textContent = String(Math.max(0, pages.length));

  if (!pages.length) {
    renderEmptyList(container, t("empty.noPages"));
    return;
  }

  for (const page of pages) {
    const row = document.createElement("button");
    row.className = "file-row page-row";
    row.dataset.kind = "page";
    row.dataset.path = page.sourcePath;
    const pageName = page.pageNumber === 1 ? t("file.mainPage") : displayPageName(page);
    row.title = `${pageName} · ${sourceFileName(page.sourcePath)}`;
    row.innerHTML = `
      <span class="file-icon" aria-hidden="true">${escapeHtml(page.pageNumber === 1 ? t("file.mainIcon") : t("file.pageIcon"))}</span>
      <span class="file-name">${escapeHtml(pageName)}</span>
      <span class="file-meta">${escapeHtml(sourceFileName(page.sourcePath))}</span>
    `;
    row.addEventListener("click", () => {
      if (!scrollToPage(page.sourcePath)) {
        openFile(page.sourcePath, { displayPath: page.displayPath });
      }
    });
    container.append(row);
  }
}

function renderEmptyList(container, message) {
  const empty = document.createElement("div");
  empty.className = "empty-folder compact";
  empty.textContent = message;
  container.append(empty);
}

function documentCardMeta(document) {
  const stats = [
    document.pageCount ? pageCountLabel(document.pageCount) : t("meta.noPages"),
    document.childCount ? childCountLabel(document.childCount) : ""
  ].filter(Boolean).join(" · ");
  return stats || t("file.documentPackage");
}

function showLoadingPreview(path) {
  state.currentMainPath = "";
  state.selectedPath = "";
  filePreview.innerHTML = "";
  setSourceChip(path);
  $("#preview-empty").hidden = false;
  $("#preview-doc").hidden = true;
  const empty = $("#preview-empty");
  empty.querySelector("h3").textContent = t("empty.loadingTitle");
  empty.querySelector("p").textContent = t("empty.loadingCopy");
}

function openDocumentPackage(path, entries, childDocuments = [], pages = [], loadId = state.loadId) {
  if (loadId !== state.loadId) return;
  if (!pages.length && !childDocuments.length) {
    state.currentMainPath = "";
    state.selectedPath = "";
    filePreview.innerHTML = "";
    $("#preview-empty").hidden = false;
    $("#preview-doc").hidden = true;
    $("#preview-empty").querySelector("h3").textContent = t(currentRootConfig().emptyTitleKey);
    $("#preview-empty").querySelector("p").textContent = t("empty.previewHint");
    return;
  }

  filePreview.innerHTML = `${pages.map(renderPageSection).join("")}${renderChildDocumentSection(childDocuments)}`;
  bindChildDocumentCards();
  state.currentMainPath = pages[0]?.sourcePath ?? path;
  setSourceChip(state.currentMainPath);
  if (pages[0]) {
    selectPage(pages[0].sourcePath);
  } else {
    state.selectedPath = path;
    updateSelectedRow();
  }
  $("#preview-empty").hidden = true;
  $("#preview-doc").hidden = false;
  setView("browse");
}

async function openFile(path, options = {}) {
  const loadId = ++state.loadId;
  const data = await api(`/api/files/render?path=${encodeURIComponent(path)}`);
  if (loadId !== state.loadId) return;
  filePreview.innerHTML = renderPageSection({
    sourcePath: path,
    displayPath: options.displayPath ?? pageDisplayPath(path),
    html: data.html,
    depth: 0,
    pageNumber: 1
  });
  state.currentMainPath = path;
  setSourceChip(state.currentMainPath);
  selectPage(path);
  $("#preview-empty").hidden = true;
  $("#preview-doc").hidden = false;
  renderPageList([]);
  setView("browse");
}

async function search(query) {
  const trimmed = query.trim();
  const container = $("#search-results");
  if (!trimmed) {
    state.searchRequestId += 1;
    state.searchResults = [];
    state.searchActiveIndex = -1;
    renderSearchEmpty(t("empty.searchStart"));
    return;
  }

  const requestId = ++state.searchRequestId;
  renderSearchEmpty(t("empty.searching"));

  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(trimmed)}`);
  } catch {
    if (requestId === state.searchRequestId) renderSearchEmpty(t("empty.searchFailed"));
    return;
  }
  if (requestId !== state.searchRequestId) return;

  state.searchResults = data.results ?? [];
  state.searchActiveIndex = state.searchResults.length ? 0 : -1;
  container.innerHTML = "";

  if (!state.searchResults.length) {
    renderSearchEmpty(t("empty.noSearch"));
    return;
  }

  state.searchResults.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-result-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === state.searchActiveIndex));
    row.dataset.searchIndex = String(index);
    row.innerHTML = `
      <span class="search-result-main">
        <strong>${escapeHtml(item.file)}</strong>
        <small>${escapeHtml(item.snippet)}</small>
      </span>
      <span class="search-result-line">${escapeHtml(String(item.line))}</span>
    `;
    row.addEventListener("mouseenter", () => setSearchActiveIndex(index));
    row.addEventListener("click", () => openSearchResult(index));
    container.append(row);
  });
  updateSearchActiveResult();
}

function renderSearchEmpty(message) {
  const container = $("#search-results");
  container.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "search-empty";
  empty.textContent = message;
  container.append(empty);
}

function moveSearchSelection(delta) {
  if (!state.searchResults.length) return;
  const nextIndex = (state.searchActiveIndex + delta + state.searchResults.length) % state.searchResults.length;
  setSearchActiveIndex(nextIndex);
}

function setSearchActiveIndex(index) {
  state.searchActiveIndex = index;
  updateSearchActiveResult();
}

function updateSearchActiveResult() {
  document.querySelectorAll("[data-search-index]").forEach((row) => {
    const active = Number(row.dataset.searchIndex) === state.searchActiveIndex;
    row.classList.toggle("active", active);
    row.setAttribute("aria-selected", String(active));
  });
}

async function openSearchResult(index) {
  const item = state.searchResults[index];
  if (!item) return;
  closeSearchPalette({ restoreFocus: false });
  await openDocumentTarget(item.file);
}

async function loadJournal() {
  const data = await api("/api/journal/blocks");
  state.journalBlocks = data.blocks ?? [];
  renderJournalTimeline();
}

function renderJournalTimeline() {
  updateSegmentedButtons("[data-timeline-type]", "timelineType", state.journalType);
  updateSegmentedButtons("[data-timeline-range]", "timelineRange", state.journalRange);

  const blocks = filteredJournalBlocks();
  $("#timeline-summary").textContent = t("timeline.summary", {
    records: blocks.length,
    pending: state.journalBlocks.filter((block) => block.status === "pending").length
  });
  const container = $("#timeline-list");
  container.innerHTML = "";

  if (!blocks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-folder";
    empty.textContent = t("empty.noJournal");
    container.append(empty);
    return;
  }

  for (const block of blocks) {
    const item = document.createElement("article");
    item.className = "timeline-item";
    item.dataset.type = block.type;
    item.innerHTML = `
      <div class="timeline-item-head">
        <time>${escapeHtml(block.date || t("timeline.undated"))}</time>
        <span class="timeline-pill" data-type="${escapeHtml(block.type)}">${escapeHtml(timelineTypeLabel(block.type))}</span>
        <span class="timeline-status" data-status="${escapeHtml(block.status)}">${escapeHtml(timelineStatusLabel(block.status))}</span>
      </div>
      <h3>${escapeHtml(block.title)}</h3>
      ${block.excerpt ? `<p>${escapeHtml(block.excerpt)}</p>` : ""}
      ${renderTimelineMeta(block)}
      <div class="timeline-item-foot">
        <span class="path-chip" title="${escapeHtml(block.sourcePath)}:${block.line}">${escapeHtml(humanDisplayPath(block.sourcePath))}:${block.line}</span>
        <button class="ghost small" type="button" data-open-source="${escapeHtml(block.sourcePath)}">${escapeHtml(t("timeline.open"))}</button>
      </div>
    `;
    item.querySelector("[data-open-source]").addEventListener("click", () => openDocumentTarget(block.sourcePath));
    item.querySelectorAll("[data-open-link]").forEach((button) => {
      button.addEventListener("click", () => openDocumentTarget(button.dataset.openLink));
    });
    container.append(item);
  }
}

function filteredJournalBlocks() {
  return state.journalBlocks.filter((block) => {
    if (state.journalType === "pending" && block.status !== "pending") return false;
    if (!["all", "pending"].includes(state.journalType) && block.type !== state.journalType) return false;
    return inJournalRange(block);
  });
}

function inJournalRange(block) {
  if (state.journalRange === "all") return true;
  const days = Number(state.journalRange);
  if (!Number.isFinite(days)) return true;
  const anchor = latestJournalDateMs();
  const blockDate = Date.parse(`${block.date}T00:00:00`);
  if (!Number.isFinite(blockDate)) return true;
  return blockDate >= anchor - (days - 1) * 24 * 60 * 60 * 1000;
}

function latestJournalDateMs() {
  const dates = state.journalBlocks
    .map((block) => Date.parse(`${block.date}T00:00:00`))
    .filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : Date.now();
}

function updateSegmentedButtons(selector, dataKey, activeValue) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button.dataset[dataKey] === activeValue);
  });
}

function renderTimelineMeta(block) {
  const tags = (block.tags ?? []).map((tag) => `<span class="timeline-tag">${escapeHtml(tag)}</span>`).join("");
  const links = (block.links ?? [])
    .slice(0, 4)
    .map((link) => `<button class="timeline-link" type="button" data-open-link="${escapeHtml(link)}">${escapeHtml(sourceFileName(link))}</button>`)
    .join("");
  if (!tags && !links) return "";
  return `<div class="timeline-meta">${tags}${links}</div>`;
}

function renderChildDocumentSection(childDocuments) {
  if (!childDocuments.length) return "";
  const cards = childDocuments.map(renderChildDocumentCard).join("");
  return `
    <section class="child-documents-section" aria-label="${escapeHtml(t("children.aria"))}">
      <div class="child-documents-head">
        <div>
          <p>${escapeHtml(t("children.kicker"))}</p>
          <h2>${escapeHtml(t("children.title"))}</h2>
        </div>
        <span>${childDocuments.length}</span>
      </div>
      <div class="child-document-grid">
        ${cards}
      </div>
    </section>
  `;
}

function renderChildDocumentCard(document) {
  const tags = (document.tags ?? [])
    .slice(0, 5)
    .map((tag) => `<span class="child-document-tag">${escapeHtml(tag)}</span>`)
    .join("");
  const stats = [
    document.pageCount ? pageCountLabel(document.pageCount) : t("meta.noPages"),
    document.childCount ? childCountLabel(document.childCount) : ""
  ].filter(Boolean).join(" · ");
  const updated = document.updatedAt ? new Date(document.updatedAt).toLocaleDateString(currentLocale()) : "";
  return `
    <button class="child-document-card" type="button" data-open-child-document="${escapeHtml(document.path)}">
      <span class="child-document-kicker">${escapeHtml(t("children.kicker"))}</span>
      <h3>${escapeHtml(document.title)}</h3>
      ${document.summary ? `<p>${escapeHtml(document.summary)}</p>` : `<p class="muted-copy">${escapeHtml(t("children.noSummary"))}</p>`}
      <div class="child-document-tags">${tags}</div>
      <span class="child-document-meta">${escapeHtml([stats, updated].filter(Boolean).join(" · "))}</span>
    </button>
  `;
}

function bindChildDocumentCards() {
  filePreview.querySelectorAll("[data-open-child-document]").forEach((button) => {
    button.addEventListener("click", () => openDocumentTarget(button.dataset.openChildDocument));
  });
}

function timelineTypeLabel(type) {
  return {
    session: t("timeline.session"),
    change: t("timeline.change"),
    decision: t("timeline.decision"),
    question: t("timeline.question"),
    note: t("timeline.note")
  }[type] ?? t("timeline.note");
}

function timelineStatusLabel(status) {
  return status === "pending" ? t("timeline.pending") : t("timeline.distilled");
}

async function loadMcpConfig() {
  state.mcpConfig = await api("/api/mcp-config");
  const mcpUrl = state.mcpConfig.url;
  const origin = new URL(mcpUrl, location.origin).origin;
  $("#mcp-oauth-url").textContent = mcpUrl;
  $("#mcp-oauth-discovery").textContent = `${origin}/.well-known/oauth-protected-resource/mcp`;
  $("#mcp-config").textContent = JSON.stringify(state.mcpConfig.config, null, 2);
}

function flashButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function loadAudit() {
  const data = await api("/api/audit/recent");
  const container = $("#audit-list");
  container.innerHTML = "";

  if (!data.events.length) {
    const empty = document.createElement("div");
    empty.className = "empty-folder";
    empty.textContent = t("empty.noAudit");
    container.append(empty);
    return;
  }

  for (const event of data.events) {
    const row = document.createElement("div");
    row.className = "list-row audit-row";
    const targetPath = event.documentPath ?? "";
    row.innerHTML = `
      <div class="audit-main">
        <strong>${escapeHtml(event.operation)} ${escapeHtml(event.path ?? "")}</strong>
        <small>${new Date(event.time).toLocaleString(currentLocale())} · ${escapeHtml(event.actorType)}</small>
      </div>
    `;
    if (targetPath) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost small";
      button.textContent = t("audit.openDocument");
      button.title = targetPath;
      button.addEventListener("click", () => openDocumentTarget(targetPath));
      row.append(button);
    }
    container.append(row);
  }
}

async function createBackup() {
  const button = $("#create-backup");
  button.disabled = true;
  try {
    await api("/api/backups", { method: "POST" });
    await loadBackups();
    flashButton(button, t("safety.created"));
  } finally {
    button.disabled = false;
  }
}

async function loadBackups() {
  const data = await api("/api/backups");
  const container = $("#backup-list");
  container.innerHTML = "";
  $("#backup-retention").textContent = t("safety.retention", { count: data.retentionCount ?? 14 });

  if (!data.backups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-folder";
    empty.textContent = t("empty.noBackups");
    container.append(empty);
    return;
  }

  for (const backup of data.backups) {
    const row = document.createElement("div");
    row.className = "list-row backup-row";
    row.innerHTML = `
      <div class="audit-main">
        <strong>${escapeHtml(backup.id)}</strong>
        <small>${new Date(backup.createdAt).toLocaleString(currentLocale())} · ${formatBytes(backup.size)}</small>
      </div>
      <a class="ghost small backup-download" href="${escapeHtml(backup.downloadUrl)}">${escapeHtml(t("safety.downloadBackup"))}</a>
    `;
    container.append(row);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok && !options.silent) throw new Error(data.error ?? response.statusText);
  return data;
}

function displayPageName(page) {
  const name = sourceFileName(page.sourcePath).replace(/\.md$/i, "");
  return name || page.displayPath;
}

function sourceFileName(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

async function openDocumentTarget(path) {
  if (isMarkdownPath(path)) {
    if (isReadmePath(path)) {
      await loadDirectory(dirname(path));
      return;
    }

    const parent = dirname(path);
    await loadDirectory(parent);
    if (!scrollToPage(path)) await openFile(path);
    return;
  }

  await loadDirectory(path);
}

function dirname(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function isMarkdownPath(path) {
  return path.toLowerCase().endsWith(".md");
}

function isReadmePath(path) {
  const lower = path.toLowerCase();
  return lower === "readme.md" || lower.endsWith("/readme.md");
}

function renderPageSection(page) {
  const isFirst = page.pageNumber === 1;
  return `
    <section id="${pageSectionId(page.sourcePath)}" class="page-section" data-depth="${Math.min(page.depth, 4)}" data-source-path="${escapeHtml(page.sourcePath)}">
      ${isFirst ? "" : `<div class="page-divider"><span>${escapeHtml(page.displayPath)}</span></div>`}
      <div class="markdown">${page.html}</div>
    </section>
  `;
}

function pageSectionId(path) {
  return `page-${path.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function scrollToPage(path) {
  const target = document.getElementById(pageSectionId(path));
  if (!target) return false;
  selectPage(path);
  scrollPageIntoView(target);
  return true;
}

function selectPage(path) {
  state.selectedPath = path;
  updateSelectedRow();
}

function setSourceChip(path) {
  const chip = $("#current-path-file");
  chip.textContent = path ? humanDisplayPath(path) : "";
  chip.title = path || "";
}

function scrollPageIntoView(target) {
  const preview = $(".preview-pane");
  const previewRect = preview.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (preview.scrollHeight > preview.clientHeight) {
    preview.scrollTo({
      top: preview.scrollTop + targetRect.top - previewRect.top,
      behavior: "auto"
    });
  }
  target.scrollIntoView({ block: "start", behavior: "auto" });
}

function pageDisplayPath(path) {
  if (!path || path === ".") return t("root.workspace");
  const pathWithoutExtension = path.toLowerCase().endsWith("/readme.md")
    ? path.slice(0, -"/README.md".length)
    : path.replace(/\.md$/i, "");
  return humanDisplayPath(pathWithoutExtension);
}

function humanDisplayPath(path) {
  return path
    .split("/")
    .filter((part) => part && part !== CHILD_DOCUMENTS_DIRECTORY)
    .join("/") || ".";
}

function rootSegment(path) {
  return path.split("/").filter(Boolean)[0] ?? ".";
}

function currentRootConfig() {
  return ROOTS[rootSegment(state.currentDir)] ?? ROOTS.docs;
}

function updateSelectedRow() {
  document.querySelectorAll(".page-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.path === state.selectedPath);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
