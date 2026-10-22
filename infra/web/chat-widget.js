/**
 * Workato Genie Chat Widget
 * Version: 1.0.0
 *
 * Self-contained IIFE — adapted for Dewy Bank workshop.
 * No auto-init; call window.WkChatWidget.init(config) to start.
 *
 * Config shape (window.WkChatConfig):
 *   apiUrl:    string  — bank API base URL (e.g. "https://api.example.com")
 *   idToken:   string  — Cognito ID token for Bearer auth
 *   stations:  object  — { stationHandle: { name: "Station Name" }, … }
 */
(function () {
  "use strict";

  // ─── Configuration ────────────────────────────────────────────────────────

  const scriptEl =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  const CONFIG = {
    cssUrl: (scriptEl && scriptEl.dataset.cssUrl) || "/chat-widget.css",
  };

  // ─── Inject CSS ───────────────────────────────────────────────────────────

  function injectCss() {
    if (document.getElementById("wk-chat-widget-css")) return;
    const link = document.createElement("link");
    link.id = "wk-chat-widget-css";
    link.rel = "stylesheet";
    link.href = CONFIG.cssUrl;
    document.head.appendChild(link);
  }

  // ─── SVG Icons ────────────────────────────────────────────────────────────

  const SVG = {
    bot: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.332 2.798H4.13c-1.36 0-2.333-1.799-1.332-2.798L4.2 15.3"/></svg>`,
    chat: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>`,
    close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
    menu: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>`,
    back: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"/></svg>`,
    send: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>`,
    history: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    sparkle: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"/></svg>`,
    skill_running: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
    skill_ok: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`,
    skill_fail: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>`,
  };

  // ─── Lightweight Markdown renderer ───────────────────────────────────────

  function renderMarkdown(text) {
    if (!text) return "";
    let html = text
      // Escape HTML entities first (prevent XSS); include " to prevent href injection in links
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    // Fenced code blocks
    html = html.replace(
      /```[\w]*\n([\s\S]*?)```/g,
      (_, code) => `<pre><code>${code.trimEnd()}</code></pre>`,
    );

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Unordered lists (wrap consecutive items)
    // Match: "- item" OR "• item" OR a line that starts with **bold** (implicit list)
    html = html.replace(/^[-*•] (.+)$/gm, "<li>$1</li>");
    // Wrap consecutive <li> blocks
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Links
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );

    // Paragraphs (double newline → <p>)
    html = html
      .split(/\n\n+/)
      .map((block) => {
        block = block.trim();
        if (!block) return "";
        if (/^<(h[1-3]|ul|ol|li|pre|blockquote)/.test(block)) return block;
        return `<p>${block.replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n");

    return html;
  }

  // ─── API helpers ──────────────────────────────────────────────────────────

  function apiUrl() {
    return ((window.WkChatConfig && window.WkChatConfig.apiUrl) || "").replace(
      /\/$/,
      "",
    );
  }

  async function apiFetch(url, opts) {
    const token = window.WkChatConfig && window.WkChatConfig.idToken;
    const authHeaders = token ? { Authorization: "Bearer " + token } : {};
    const mergedHeaders = Object.assign(
      {},
      authHeaders,
      (opts && opts.headers) || {},
    );
    const res = await fetch(
      url,
      Object.assign({}, opts, { headers: mergedHeaders }),
    );
    return res;
  }

  async function checkAuth() {
    return true;
  }

  async function fetchGenies() {
    const stations = window.WkChatConfig && window.WkChatConfig.stations;
    if (!stations) return [];
    return Object.entries(stations).map(function ([key, val]) {
      return {
        handle: key,
        name: (val && val.name) || key,
        description: "",
      };
    });
  }

  async function createConversation(genieHandle) {
    return null;
  }

  async function fetchMessages(conversationId, genieHandle) {
    return [];
  }

  async function logout() {
    await apiFetch(apiUrl() + "/api/auth/logout", { method: "POST" });
  }

  // ─── Bank polling implementation ──────────────────────────────────────────

  async function sendMessageStream(
    conversationId,
    genieHandle,
    message,
    callbacks,
  ) {
    const { onTyping, onMessage, onSkill, onDone, onError } = callbacks;

    let res;
    try {
      res = await apiFetch(apiUrl() + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          station: genieHandle,
          message: message,
          conversation: conversationId || undefined,
        }),
      });
    } catch (err) {
      onError && onError("Network error — please try again.");
      return;
    }

    if (!res.ok) {
      onError && onError("Failed to send message. Please try again.");
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      onError && onError("Invalid response from server.");
      return;
    }

    // If this was a new conversation, persist the server-assigned ID
    if (conversationId === null && data.conversation) {
      state.activeConvId = data.conversation;
      state.conversations.unshift({
        conversation_id: data.conversation,
        topic: null,
        created_at: new Date().toISOString(),
      });
    }

    onTyping && onTyping(true);

    // Poll the events endpoint until the run finishes
    await new Promise(function (resolve) {
      const startTime = Date.now();
      const seen = new Set();
      let since = 0;
      let finished = false;

      function poll() {
        if (finished) return;
        const convId = state.activeConvId;
        const url =
          apiUrl() +
          "/chat/events?station=" +
          encodeURIComponent(genieHandle) +
          "&conversation=" +
          encodeURIComponent(convId) +
          "&since=" +
          since;

        apiFetch(url)
          .then(function (r) {
            if (!r.ok) {
              onError &&
                onError("Error polling for response. Please try again.");
              onTyping && onTyping(false);
              finished = true;
              resolve();
              return;
            }
            return r.json().then(function (evtData) {
              const events = evtData.events || evtData.result || [];
              events.forEach(function (evt) {
                // Deduplicate by seq_num, falling back to id
                const dedupeKey = evt.seq_num != null ? evt.seq_num : evt.id;
                if (dedupeKey != null && seen.has(dedupeKey)) return;
                if (dedupeKey != null) seen.add(dedupeKey);

                // Advance the since cursor
                if (typeof evt.seq_num === "number" && evt.seq_num > since) {
                  since = evt.seq_num;
                }

                const evType = evt.type;
                if (evType === "agent.message") {
                  onTyping && onTyping(false);
                  onMessage &&
                    onMessage({
                      message_id:
                        evt.message_id || evt.id || "msg-" + Date.now(),
                      source: "genie",
                      content: evt.message || evt.content || "",
                      created_at: evt.created_at || new Date().toISOString(),
                    });
                } else if (evType && evType.startsWith("skill.")) {
                  const status =
                    evType === "skill.running"
                      ? "running"
                      : evType === "skill.failed"
                        ? "failed"
                        : "completed";
                  onSkill &&
                    onSkill({
                      name: evt.skill_name || evt.name || "",
                      status: status,
                    });
                } else if (evType === "processing.finished") {
                  finished = true;
                }
              });

              // Resolve when finished or run status signals completion
              if (
                finished ||
                evtData.status === "completed" ||
                evtData.status === "waiting_for_customer"
              ) {
                onTyping && onTyping(false);
                onDone && onDone();
                resolve();
                return;
              }

              // Hard timeout: 120 seconds
              if (Date.now() - startTime >= 120000) {
                onTyping && onTyping(false);
                onDone && onDone();
                resolve();
                return;
              }

              setTimeout(poll, 1200);
            });
          })
          .catch(function (err) {
            onError &&
              onError("Network error while polling. Please try again.");
            onTyping && onTyping(false);
            resolve();
          });
      }

      setTimeout(poll, 1200);
    });
  }

  // ─── State ────────────────────────────────────────────────────────────────

  const state = {
    isOpen: false,
    isAuthed: false,
    isLoading: true,
    activePanel: null, // null | 'genie' | 'history'
    genies: [],
    activeGenie: null, // { handle, name, description }
    conversations: [],
    activeConvId: null,
    messages: [],
    skillCards: {}, // skill_name → { name, status }
    isTyping: false,
    isSending: false,
    unreadCount: 0,
    seenMessageIds: new Set(),
  };

  // ─── DOM element references ───────────────────────────────────────────────

  let dom = {};

  // ─── Build DOM ────────────────────────────────────────────────────────────

  function buildWidget() {
    // Root element (all widget markup lives here for style isolation)
    const root = document.createElement("div");
    root.id = "wk-chat-widget";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Genie Chat Widget");

    // ── FAB ──
    root.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: static SVG/HTML template only */ `
      <!-- FAB -->
      <button
        class="wk-cw-fab"
        id="wk-cw-fab"
        aria-label="Open chat"
        aria-expanded="false"
        aria-controls="wk-cw-panel"
      >
        <span class="wk-cw-fab-icon-open">${SVG.chat}</span>
        <span class="wk-cw-fab-icon-close">${SVG.close}</span>
        <span class="wk-cw-fab-badge" id="wk-cw-badge" hidden aria-label="unread messages">0</span>
      </button>

      <!-- Panel -->
      <div
        class="wk-cw-panel"
        id="wk-cw-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Chat with Genie"
      >
        <!-- Header -->
        <div class="wk-cw-header" id="wk-cw-header">
          <div class="wk-cw-header-logo" aria-hidden="true">${SVG.bot}</div>
          <div class="wk-cw-header-title">
            <h2 id="wk-cw-genie-name">Genie</h2>
            <p id="wk-cw-genie-desc"></p>
          </div>
          <button class="wk-cw-header-btn" id="wk-cw-menu-btn" aria-label="Open menu" aria-haspopup="true">
            ${SVG.menu}
          </button>
        </div>

        <!-- Genie selector panel (slide in from left) -->
        <div class="wk-cw-slide-panel" id="wk-cw-genie-panel" aria-label="Select Genie" role="menu">
          <div class="wk-cw-slide-header">
            <button class="wk-cw-back-btn" id="wk-cw-genie-back" aria-label="Back to chat">${SVG.back}</button>
            <h3>Select Genie</h3>
          </div>
          <div class="wk-cw-slide-body" id="wk-cw-genie-list" role="none"></div>
        </div>

        <!-- History panel (slide in from left) -->
        <div class="wk-cw-slide-panel" id="wk-cw-history-panel" aria-label="Chat history" role="menu">
          <div class="wk-cw-slide-header">
            <button class="wk-cw-back-btn" id="wk-cw-history-back" aria-label="Back to chat">${SVG.back}</button>
            <h3>Chat History</h3>
          </div>
          <div class="wk-cw-slide-body" id="wk-cw-history-list" role="none">
            <button class="wk-cw-new-chat-btn" id="wk-cw-new-chat-btn" aria-label="Start new conversation">
              ${SVG.plus}
              New conversation
            </button>
          </div>
        </div>

        <!-- Chat body (typing indicator is appended here dynamically) -->
        <div class="wk-cw-body" id="wk-cw-body" aria-live="polite" aria-label="Messages"></div>

        <!-- Input area -->
        <div class="wk-cw-input-area" id="wk-cw-input-area">
          <div class="wk-cw-input-row">
            <textarea
              class="wk-cw-textarea"
              id="wk-cw-textarea"
              placeholder="Message your genie…"
              rows="1"
              aria-label="Message input"
              aria-multiline="true"
            ></textarea>
            <button class="wk-cw-send-btn" id="wk-cw-send-btn" aria-label="Send message" disabled>
              ${SVG.send}
            </button>
          </div>
          <p class="wk-cw-input-hint">Shift + Enter for newline</p>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    // Cache references
    dom = {
      root,
      fab: root.querySelector("#wk-cw-fab"),
      badge: root.querySelector("#wk-cw-badge"),
      panel: root.querySelector("#wk-cw-panel"),
      header: root.querySelector("#wk-cw-header"),
      genieName: root.querySelector("#wk-cw-genie-name"),
      genieDesc: root.querySelector("#wk-cw-genie-desc"),
      menuBtn: root.querySelector("#wk-cw-menu-btn"),
      geniePanel: root.querySelector("#wk-cw-genie-panel"),
      genieBack: root.querySelector("#wk-cw-genie-back"),
      genieList: root.querySelector("#wk-cw-genie-list"),
      historyPanel: root.querySelector("#wk-cw-history-panel"),
      historyBack: root.querySelector("#wk-cw-history-back"),
      historyList: root.querySelector("#wk-cw-history-list"),
      newChatBtn: root.querySelector("#wk-cw-new-chat-btn"),
      body: root.querySelector("#wk-cw-body"),
      inputArea: root.querySelector("#wk-cw-input-area"),
      textarea: root.querySelector("#wk-cw-textarea"),
      sendBtn: root.querySelector("#wk-cw-send-btn"),
    };
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────

  function wireEvents() {
    // FAB toggle
    dom.fab.addEventListener("click", () => {
      state.isOpen ? closeWidget() : openWidget();
    });

    // Hamburger menu — cycles through: null → history, history → genie, genie → null
    dom.menuBtn.addEventListener("click", () => {
      if (state.activePanel === null) {
        openPanel("history");
      } else if (state.activePanel === "history") {
        openPanel("genie");
      } else {
        closePanel();
      }
    });

    // Back buttons
    dom.genieBack.addEventListener("click", closePanel);
    dom.historyBack.addEventListener("click", closePanel);

    // New conversation
    dom.newChatBtn.addEventListener("click", handleNewConversation);

    // Textarea auto-resize + send on Enter
    dom.textarea.addEventListener("input", () => {
      autoResizeTextarea();
      updateSendBtn();
    });
    dom.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Send button
    dom.sendBtn.addEventListener("click", handleSend);

    // Close on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.isOpen) {
        if (state.activePanel !== null) closePanel();
        else closeWidget();
      }
    });

    // Click outside to close
    document.addEventListener("click", (e) => {
      if (state.isOpen && !dom.root.contains(e.target)) {
        closeWidget();
      }
    });
  }

  // ─── Open / close widget ──────────────────────────────────────────────────

  function openWidget() {
    state.isOpen = true;
    state.unreadCount = 0;
    dom.fab.classList.add("is-open");
    dom.fab.setAttribute("aria-expanded", "true");
    dom.fab.setAttribute("aria-label", "Close chat");
    dom.panel.classList.add("is-open");
    updateBadge();
    dom.textarea.focus();
  }

  function closeWidget() {
    state.isOpen = false;
    dom.fab.classList.remove("is-open");
    dom.fab.setAttribute("aria-expanded", "false");
    dom.fab.setAttribute("aria-label", "Open chat");
    dom.panel.classList.remove("is-open");
    closePanel();
    dom.fab.focus();
  }

  // ─── Slide panels ─────────────────────────────────────────────────────────

  function openPanel(name) {
    state.activePanel = name;
    if (name === "genie") {
      dom.geniePanel.classList.add("is-open");
      dom.historyPanel.classList.remove("is-open");
      renderGenieList();
      dom.genieBack.focus();
    } else if (name === "history") {
      dom.historyPanel.classList.add("is-open");
      dom.geniePanel.classList.remove("is-open");
      renderHistoryList();
      dom.historyBack.focus();
    }
  }

  function closePanel() {
    state.activePanel = null;
    dom.geniePanel.classList.remove("is-open");
    dom.historyPanel.classList.remove("is-open");
    // Re-enable input in case it was disabled during a load that has since finished
    if (state.isAuthed && !state.isSending) {
      dom.textarea.disabled = false;
      updateSendBtn();
    }
    dom.textarea.focus();
  }

  // ─── Render: Genie selector ───────────────────────────────────────────────

  function renderGenieList() {
    dom.genieList.innerHTML = "";
    state.genies.forEach((genie) => {
      const btn = document.createElement("button");
      btn.className =
        "wk-cw-genie-item" +
        (state.activeGenie && state.activeGenie.handle === genie.handle
          ? " is-active"
          : "");
      btn.setAttribute("role", "menuitem");
      btn.setAttribute("aria-label", `Switch to ${genie.name}`);
      btn.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: all interpolations are HTML-escaped or compile-time SVG constants */ `
        <span class="wk-cw-genie-avatar">${SVG.sparkle}</span>
        <span class="wk-cw-genie-info">
          <span class="wk-cw-genie-name">${escapeHtml(genie.name)}</span>
          ${genie.description ? `<span class="wk-cw-genie-desc">${escapeHtml(genie.description)}</span>` : ""}
        </span>
        ${
          state.activeGenie && state.activeGenie.handle === genie.handle
            ? `<span class="wk-cw-genie-check">${SVG.check}</span>`
            : ""
        }
      `;
      btn.addEventListener("click", () => selectGenie(genie));
      dom.genieList.appendChild(btn);
    });

    if (state.genies.length === 0) {
      dom.genieList.innerHTML =
        '<p style="padding:16px;font-size:13px;color:var(--wk-text-muted)">No genies configured.</p>';
    }
  }

  async function selectGenie(genie) {
    state.activeGenie = genie;
    state.conversations = [];
    state.activeConvId = null;
    state.messages = [];
    state.skillCards = {};

    updateHeader();
    closePanel();

    // Load conversations for this genie and auto-create if none
    await loadConversationsAndInit();
  }

  // ─── Render: History list ─────────────────────────────────────────────────

  function renderHistoryList() {
    // Keep the "New conversation" button
    const newBtn = dom.newChatBtn;
    dom.historyList.innerHTML = "";
    dom.historyList.appendChild(newBtn);

    if (state.conversations.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wk-cw-history-empty";
      empty.textContent = "No conversations yet.";
      dom.historyList.appendChild(empty);
      return;
    }

    // Group by date
    const now = new Date();
    const todayStr = now.toDateString();
    const yesterdayStr = new Date(now.getTime() - 86400000).toDateString();

    const groups = {};
    state.conversations.forEach((c) => {
      const d = new Date(c.created_at).toDateString();
      const key =
        d === todayStr ? "Today" : d === yesterdayStr ? "Yesterday" : d;
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });

    Object.entries(groups).forEach(([label, convs]) => {
      const labelEl = document.createElement("div");
      labelEl.className = "wk-cw-history-section-label";
      labelEl.textContent = label;
      dom.historyList.appendChild(labelEl);

      convs.forEach((c) => {
        const btn = document.createElement("button");
        btn.className =
          "wk-cw-history-item" +
          (c.conversation_id === state.activeConvId ? " is-active" : "");
        btn.setAttribute("role", "menuitem");
        btn.setAttribute(
          "aria-label",
          `Open conversation: ${formatTopic(c.topic)}`,
        );
        btn.dataset.convId = c.conversation_id;
        btn.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: all interpolations are HTML-escaped or compile-time SVG constants */ `
          <span class="wk-cw-history-icon">${SVG.history}</span>
          <span class="wk-cw-history-topic">${escapeHtml(formatTopic(c.topic))}</span>
        `;
        btn.addEventListener("click", () =>
          loadConversation(c.conversation_id),
        );
        dom.historyList.appendChild(btn);
      });
    });
  }

  // ─── Render: Chat messages ────────────────────────────────────────────────

  function renderMessages() {
    dom.body.innerHTML = "";

    if (state.messages.length === 0) {
      renderEmptyState();
      return;
    }

    state.messages.forEach((msg) => appendMessageEl(msg));

    // Render any active skill cards
    Object.values(state.skillCards).forEach((card) => renderSkillCard(card));

    scrollToBottom();
  }

  function renderEmptyState() {
    const el = document.createElement("div");
    el.className = "wk-cw-empty-state";
    el.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: static SVG/HTML template only */ `
      <div class="wk-cw-empty-icon" aria-hidden="true">${SVG.sparkle}</div>
      <p class="wk-cw-empty-title">Start a conversation</p>
      <p class="wk-cw-empty-sub">
        Ask me anything — I'm your AI assistant powered by Workato Agent Studio.
      </p>
    `;
    dom.body.appendChild(el);
  }

  function appendMessageEl(msg) {
    // Remove empty state if present
    const emptyState = dom.body.querySelector(".wk-cw-empty-state");
    if (emptyState) emptyState.remove();

    const isUser = msg.source === "user";
    const wrapper = document.createElement("div");
    wrapper.className = `wk-cw-message ${isUser ? "is-user" : "is-genie"}`;
    wrapper.dataset.messageId = msg.message_id;

    const time = new Date(msg.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    if (isUser) {
      wrapper.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: content is HTML-escaped via escapeHtml() */ `
        <div class="wk-cw-msg-col">
          <div class="wk-cw-bubble">${escapeHtml(msg.content)}</div>
          <div class="wk-cw-msg-time">${time}</div>
        </div>
        <div class="wk-cw-avatar" aria-hidden="true">U</div>
      `;
    } else {
      wrapper.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: renderMarkdown() HTML-escapes input before processing; links sanitized via &quot; escaping */ `
        <div class="wk-cw-avatar" aria-hidden="true">G</div>
        <div class="wk-cw-msg-col">
          <div class="wk-cw-bubble">${renderMarkdown(msg.content)}</div>
          <div class="wk-cw-msg-time">${time}</div>
        </div>
      `;
    }

    dom.body.appendChild(wrapper);
    scrollToBottom();
  }

  function renderSkillCard(card) {
    // Remove existing card for this skill name if present
    const existing = dom.body.querySelector(
      `[data-skill="${escapeAttr(card.name)}"]`,
    );
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.className = `wk-cw-skill-card ${card.status}`;
    el.dataset.skill = card.name;
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", `Skill ${card.name}: ${card.status}`);

    const iconSvg =
      card.status === "running"
        ? SVG.skill_running
        : card.status === "completed"
          ? SVG.skill_ok
          : SVG.skill_fail;

    el.innerHTML = /* nosemgrep: javascript.browser.security.insecure-document-methods.insecure-document-method -- workshop widget: all interpolations are HTML-escaped or compile-time SVG constants */ `
      <span class="wk-cw-skill-card-icon" aria-hidden="true">${iconSvg}</span>
      <span class="wk-cw-skill-name">${escapeHtml(card.name)}</span>
      <span class="wk-cw-skill-status ${escapeHtml(card.status)}">${escapeHtml(card.status)}</span>
    `;
    dom.body.appendChild(el);
    scrollToBottom();
  }

  function appendSystemMessage(text, isError) {
    const el = document.createElement("div");
    el.className = "wk-cw-system-msg" + (isError ? " is-error" : "");
    el.textContent = text;
    dom.body.appendChild(el);
    scrollToBottom();
  }

  function renderLoadingScreen() {
    dom.body.innerHTML = `<div class="wk-cw-loading"><div class="wk-cw-spinner" aria-label="Loading…"></div></div>`;
  }

  // ─── Header updates ───────────────────────────────────────────────────────

  function updateHeader() {
    if (!state.activeGenie) return;
    dom.genieName.textContent = state.activeGenie.name;
    dom.genieDesc.textContent = state.activeGenie.description || "";
  }

  // ─── Badge ────────────────────────────────────────────────────────────────

  function updateBadge() {
    if (state.unreadCount > 0 && !state.isOpen) {
      dom.badge.removeAttribute("hidden");
      dom.badge.textContent =
        state.unreadCount > 9 ? "9+" : String(state.unreadCount);
    } else {
      dom.badge.setAttribute("hidden", "");
    }
  }

  // ─── Input helpers ────────────────────────────────────────────────────────

  function autoResizeTextarea() {
    const el = dom.textarea;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function updateSendBtn() {
    const hasText = dom.textarea.value.trim().length > 0;
    dom.sendBtn.disabled = !hasText || state.isSending || !state.isAuthed;
  }

  function setInputDisabled(disabled) {
    dom.textarea.disabled = disabled;
    updateSendBtn();
  }

  // ─── Scroll ───────────────────────────────────────────────────────────────

  function scrollToBottom() {
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  // ─── Typing indicator (lives inside #wk-cw-body) ─────────────────────────

  function showTypingIndicator() {
    if (dom.body.querySelector(".wk-cw-typing-row")) return; // already shown
    const row = document.createElement("div");
    row.className = "wk-cw-typing-row";
    row.setAttribute("aria-label", "Genie is typing");
    row.innerHTML = `
      <div class="wk-cw-avatar" aria-hidden="true">G</div>
      <div class="wk-cw-typing-dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    `;
    dom.body.appendChild(row);
  }

  function hideTypingIndicator() {
    const row = dom.body.querySelector(".wk-cw-typing-row");
    if (row) row.remove();
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  async function handleSend() {
    const text = dom.textarea.value.trim();
    if (!text || state.isSending) return;

    dom.textarea.value = "";
    dom.textarea.style.height = "auto";
    state.isSending = true;
    setInputDisabled(true);

    // Append user message immediately
    const userMsg = {
      message_id: `local-${Date.now()}`,
      source: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    state.messages.push(userMsg);
    appendMessageEl(userMsg);

    // Clear skill cards and typing indicator from previous turn
    state.skillCards = {};
    hideTypingIndicator();

    await sendMessageStream(
      state.activeConvId,
      state.activeGenie.handle,
      text,
      {
        onTyping(v) {
          state.isTyping = v;
          if (v) {
            showTypingIndicator();
          } else {
            hideTypingIndicator();
          }
          scrollToBottom();
        },
        onMessage(msg) {
          // de-dupe
          if (state.seenMessageIds.has(msg.message_id)) return;
          state.seenMessageIds.add(msg.message_id);
          state.messages.push(msg);
          appendMessageEl(msg);

          // Badge if widget is closed
          if (!state.isOpen) {
            state.unreadCount++;
            updateBadge();
          }
        },
        onSkill(card) {
          state.skillCards[card.name] = card;
          renderSkillCard(card);
        },
        onDone() {
          hideTypingIndicator();
        },
        onError(msg) {
          hideTypingIndicator();
          appendSystemMessage(msg, true);
        },
      },
    );

    state.isSending = false;
    setInputDisabled(false);
    dom.textarea.focus();
  }

  async function handleNewConversation() {
    closePanel();
    state.activeConvId = null;
    state.messages = [];
    state.skillCards = {};
    renderMessages();
    dom.textarea.focus();
  }

  async function loadConversation(convId) {
    closePanel();
    if (convId === state.activeConvId) return;

    state.activeConvId = convId;
    state.messages = [];
    state.skillCards = {};

    renderLoadingScreen();
    setInputDisabled(true);

    const msgs = await fetchMessages(convId, state.activeGenie.handle);
    msgs.forEach((m) => state.seenMessageIds.add(m.message_id));
    state.messages = msgs;

    renderMessages();
    setInputDisabled(false);
    dom.textarea.focus();
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  async function loadConversationsAndInit() {
    renderMessages();
    setInputDisabled(false);
  }

  async function init(config) {
    // Guard against duplicate init
    if (document.getElementById("wk-chat-widget")) {
      if (config) setConfig(config);
      return;
    }

    // Store config
    if (config) window.WkChatConfig = config;

    injectCss();
    buildWidget();
    wireEvents();

    state.isAuthed = true;
    dom.inputArea.style.display = "";

    const genies = await fetchGenies();
    state.genies = genies;
    state.activeGenie = genies[0] || null;

    if (!state.activeGenie) {
      appendSystemMessage(
        "No stations configured. Please check your configuration.",
        false,
      );
      setInputDisabled(true);
      return;
    }

    updateHeader();
    state.activeConvId = null;
    state.messages = [];
    state.skillCards = {};
    renderMessages();
    setInputDisabled(false);
  }

  async function setConfig(config) {
    if (!window.WkChatConfig) window.WkChatConfig = {};
    Object.assign(window.WkChatConfig, config);
    const genies = await fetchGenies();
    state.genies = genies;
    state.activeGenie = genies[0] || null;
    state.activeConvId = null;
    state.messages = [];
    state.skillCards = {};
    if (state.activeGenie) {
      updateHeader();
      setInputDisabled(false);
    } else {
      appendSystemMessage(
        "No stations configured. Please check your configuration.",
        false,
      );
      setInputDisabled(true);
    }
    renderMessages();
  }

  function reset() {
    state.activeConvId = null;
    state.messages = [];
    state.skillCards = [];
    state.conversations = [];
    if (dom.fab) closeWidget();
  }

  // ─── Utility ─────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    return String(str || "").replace(/"/g, "&quot;");
  }

  function formatTopic(topic) {
    if (!topic) return "New conversation";
    const s = String(topic);
    return /^\d+$/.test(s) ? "New conversation" : s;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.WkChatWidget = {
    init: init,
    setConfig: setConfig,
    reset: reset,
    open: openWidget,
    close: closeWidget,
    toggle() {
      state.isOpen ? closeWidget() : openWidget();
    },
  };
})();
