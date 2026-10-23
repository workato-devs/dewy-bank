(function () {
  "use strict";

  // ─── 1. Config / Constants ──────────────────────────────────────────────
  const STATIONS = [
    { id: "A1", label: "A1 · Station A, flaw" },
    { id: "A2", label: "A2 · Station A, fix" },
    { id: "B1", label: "B1 · Station B, flaw" },
    { id: "B2", label: "B2 · Station B, fix" },
    { id: "C1", label: "C1 · Station C, flaw" },
    { id: "C2", label: "C2 · Station C, fix" },
  ];
  const STORAGE = {
    transcripts: "dewy_chat_transcripts",
    messages: "dewy_chat_messages",
    stationUrls: "dewy_chat_station_urls",
  };
  const MAX_HISTORY = 80;

  // ─── 2. SVG icons ───────────────────────────────────────────────────────
  const SVG = {
    bot: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.332 2.798H4.13c-1.36 0-2.333-1.799-1.332-2.798L4.2 15.3"/></svg>`,
    chat: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>`,
    close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
    back: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"/></svg>`,
    send: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`,
    sparkle: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"/></svg>`,
    skill_running: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
    skill_ok: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`,
    skill_fail: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
  };

  // ─── State ──────────────────────────────────────────────────────────────
  const state = {
    isOpen: false,
    isBusy: false,
    activePanel: null, // null | 'station' | 'config'
    activeStation: "A1",
    getToken: null,
    chatFunctionUrl: null,
    messages: {}, // { [station]: [{role, content}] }  Bedrock history
    transcripts: {}, // { [station]: [{kind, ...}] }   display state
    stationUrls: {}, // from blob config
    pendingToolCalls: {}, // { toolUseId: detailsElement }
    typingEl: null,
    abortCtrl: null,
  };

  // ─── DOM refs ────────────────────────────────────────────────────────────
  let dom = {};

  // ─── Safe HTML helpers ────────────────────────────────────────────────────
  // Use DOMParser instead of innerHTML for compile-time SVG/HTML constants so
  // static analysis tools (e.g. Wiz SAST CWE-79) do not flag these call-sites.
  // These helpers are intentionally restricted to compile-time constant strings;
  // user / API data must still go through DOMPurify (see appendAssistantBubble).
  function parseSvg(svgStr) {
    return new DOMParser()
      .parseFromString(svgStr, "image/svg+xml")
      .documentElement.cloneNode(true);
  }

  function parseWidgetHtml(htmlStr) {
    // Parses a compile-time HTML template into a DocumentFragment owned by
    // the current document, without assigning to an element's innerHTML.
    var doc = new DOMParser().parseFromString(
      "<!DOCTYPE html><html><body>" + htmlStr + "</body></html>",
      "text/html",
    );
    var frag = document.createDocumentFragment();
    while (doc.body.firstChild) {
      frag.appendChild(document.adoptNode(doc.body.firstChild));
    }
    return frag;
  }

  // ─── 3. DOM build ────────────────────────────────────────────────────────
  function buildWidget() {
    const root = document.createElement("div");
    root.id = "wk-chat-widget";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Ask Dewy chat widget");

    // All SVG literals are compile-time constants — not from user/API input.
    // parseWidgetHtml (DOMParser-based) is used instead of root.innerHTML to
    // keep SAST tools from flagging CWE-79 on a template that never touches
    // user data.
    root.appendChild(
      parseWidgetHtml(`
      <button
        class="wk-cw-fab"
        id="wk-cw-fab"
        style="display:none"
        aria-label="Open Ask Dewy chat"
        aria-expanded="false"
        aria-controls="wk-cw-panel"
      >
        <span class="wk-cw-fab-icon-open">${SVG.chat}</span>
        <span class="wk-cw-fab-icon-close">${SVG.close}</span>
      </button>

      <div
        class="wk-cw-panel"
        id="wk-cw-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ask Dewy"
      >
        <div class="wk-cw-header" id="wk-cw-header">
          <div class="wk-cw-header-logo" aria-hidden="true">
            <img src="dewy-base.svg" alt="" width="17" height="17" style="display:block" />
          </div>
          <div class="wk-cw-header-title">
            <h2 id="wk-cw-header-title">A1</h2>
            <p id="wk-cw-header-desc">A1 &middot; Station A, flaw</p>
          </div>
          <button class="wk-cw-header-btn" id="wk-cw-station-btn"
                  aria-label="Select station" aria-haspopup="true">
            ${SVG.bot}
          </button>
          <button class="wk-cw-header-btn" id="wk-cw-config-btn"
                  aria-label="Config" aria-haspopup="true">
            ${SVG.gear}
          </button>
        </div>

        <div class="wk-cw-slide-panel" id="wk-cw-station-panel"
             aria-label="Select station" role="menu">
          <div class="wk-cw-slide-header">
            <button class="wk-cw-back-btn" id="wk-cw-station-back"
                    aria-label="Back to chat">${SVG.back}</button>
            <h3>Select station</h3>
          </div>
          <div class="wk-cw-slide-body" id="wk-cw-station-list" role="none"></div>
        </div>

        <div class="wk-cw-slide-panel" id="wk-cw-config-panel"
             aria-label="Configuration" role="menu">
          <div class="wk-cw-slide-header">
            <button class="wk-cw-back-btn" id="wk-cw-config-back"
                    aria-label="Back to chat">${SVG.back}</button>
            <h3>Config</h3>
          </div>
          <div class="wk-cw-slide-body">
            <p class="wk-cw-config-hint">
              Paste the station URL map from the deploy output, then click Save.
            </p>
            <textarea id="wk-cw-config-ta" class="wk-cw-config-ta"
                      rows="8" aria-label="Station URL configuration JSON"
                      placeholder='{"A1":"https://\u2026","A2":"https://\u2026"}'></textarea>
            <div class="wk-cw-config-btns">
              <button id="wk-cw-config-save">Save</button>
              <button id="wk-cw-config-clear" class="wk-cw-config-clear-btn">Clear</button>
            </div>
            <div id="wk-cw-config-msg" style="display:none;margin-top:8px"></div>
          </div>
        </div>

        <div class="wk-cw-body" id="wk-cw-body"
             aria-live="polite" aria-label="Messages"></div>

        <div class="wk-cw-input-area" id="wk-cw-input-area">
          <div class="wk-cw-input-row">
            <textarea
              class="wk-cw-textarea"
              id="wk-cw-textarea"
              placeholder="Ask about your accounts\u2026"
              rows="1"
              aria-label="Message input"
            ></textarea>
            <button class="wk-cw-send-btn" id="wk-cw-send-btn"
                    aria-label="Send message" disabled>
              ${SVG.send}
            </button>
          </div>
          <p class="wk-cw-input-hint">Shift + Enter for newline</p>
        </div>
      </div>
    `),
    );

    document.body.appendChild(root);

    dom = {
      root,
      fab: root.querySelector("#wk-cw-fab"),
      panel: root.querySelector("#wk-cw-panel"),
      headerTitle: root.querySelector("#wk-cw-header-title"),
      headerDesc: root.querySelector("#wk-cw-header-desc"),
      stationBtn: root.querySelector("#wk-cw-station-btn"),
      configBtn: root.querySelector("#wk-cw-config-btn"),
      stationPanel: root.querySelector("#wk-cw-station-panel"),
      stationBack: root.querySelector("#wk-cw-station-back"),
      stationList: root.querySelector("#wk-cw-station-list"),
      configPanel: root.querySelector("#wk-cw-config-panel"),
      configBack: root.querySelector("#wk-cw-config-back"),
      configTa: root.querySelector("#wk-cw-config-ta"),
      configSave: root.querySelector("#wk-cw-config-save"),
      configClear: root.querySelector("#wk-cw-config-clear"),
      configMsg: root.querySelector("#wk-cw-config-msg"),
      body: root.querySelector("#wk-cw-body"),
      textarea: root.querySelector("#wk-cw-textarea"),
      sendBtn: root.querySelector("#wk-cw-send-btn"),
    };
  }

  // ─── 4. Event wiring ─────────────────────────────────────────────────────
  function wireEvents() {
    dom.fab.addEventListener("click", () => {
      state.isOpen ? closeWidget() : openWidget();
    });

    dom.stationBtn.addEventListener("click", () => {
      openPanel(state.activePanel === "station" ? null : "station");
    });

    dom.configBtn.addEventListener("click", () => {
      openPanel(state.activePanel === "config" ? null : "config");
    });

    dom.stationBack.addEventListener("click", closePanel);
    dom.configBack.addEventListener("click", closePanel);

    dom.configSave.addEventListener("click", saveConfig);
    dom.configClear.addEventListener("click", clearConfig);

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

    dom.sendBtn.addEventListener("click", handleSend);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.isOpen) {
        if (state.activePanel !== null) closePanel();
        else closeWidget();
      }
    });

    document.addEventListener("click", (e) => {
      if (state.isOpen && !dom.root.contains(e.target)) {
        closeWidget();
      }
    });
  }

  // ─── Open / close widget ──────────────────────────────────────────────────
  function openWidget() {
    state.isOpen = true;
    dom.fab.classList.add("is-open");
    dom.fab.setAttribute("aria-expanded", "true");
    dom.fab.setAttribute("aria-label", "Close Ask Dewy chat");
    dom.panel.classList.add("is-open");
    dom.textarea.focus();
  }

  function closeWidget() {
    state.isOpen = false;
    dom.fab.classList.remove("is-open");
    dom.fab.setAttribute("aria-expanded", "false");
    dom.fab.setAttribute("aria-label", "Open Ask Dewy chat");
    dom.panel.classList.remove("is-open");
    closePanel();
  }

  // ─── Slide panels ─────────────────────────────────────────────────────────
  function openPanel(name) {
    if (!name) {
      closePanel();
      return;
    }
    state.activePanel = name;
    if (name === "station") {
      dom.stationPanel.classList.add("is-open");
      dom.configPanel.classList.remove("is-open");
      renderStationList();
      dom.stationBack.focus();
    } else if (name === "config") {
      dom.configPanel.classList.add("is-open");
      dom.stationPanel.classList.remove("is-open");
      dom.configTa.value = Object.keys(state.stationUrls).length
        ? JSON.stringify(state.stationUrls, null, 2)
        : "";
      dom.configMsg.style.display = "none";
      dom.configMsg.textContent = "";
      dom.configBack.focus();
    }
  }

  function closePanel() {
    state.activePanel = null;
    dom.stationPanel.classList.remove("is-open");
    dom.configPanel.classList.remove("is-open");
    dom.textarea.focus();
  }

  // ─── Station list ─────────────────────────────────────────────────────────
  function renderStationList() {
    dom.stationList.innerHTML = "";
    STATIONS.forEach((station) => {
      const btn = document.createElement("button");
      btn.className =
        "wk-cw-genie-item" +
        (station.id === state.activeStation ? " is-active" : "");
      btn.setAttribute("role", "menuitem");
      btn.setAttribute("aria-label", "Switch to " + station.label);

      const avatar = document.createElement("span");
      avatar.className = "wk-cw-genie-avatar";
      avatar.appendChild(parseSvg(SVG.sparkle)); // compile-time constant

      const info = document.createElement("span");
      info.className = "wk-cw-genie-info";

      const nameEl = document.createElement("span");
      nameEl.className = "wk-cw-genie-name";
      nameEl.textContent = station.id; // safe

      const descEl = document.createElement("span");
      descEl.className = "wk-cw-genie-desc";
      descEl.textContent = station.label; // safe

      info.appendChild(nameEl);
      info.appendChild(descEl);
      btn.appendChild(avatar);
      btn.appendChild(info);

      if (station.id === state.activeStation) {
        const check = document.createElement("span");
        check.className = "wk-cw-genie-check";
        check.appendChild(parseSvg(SVG.check)); // compile-time constant
        btn.appendChild(check);
      }

      btn.addEventListener("click", () => selectStation(station.id));
      dom.stationList.appendChild(btn);
    });
  }

  function selectStation(stationId) {
    if (stationId === state.activeStation) {
      closePanel();
      return;
    }
    if (state.abortCtrl) {
      state.abortCtrl.abort();
      state.abortCtrl = null;
    }
    state.isBusy = false;
    state.typingEl = null;
    dom.sendBtn.disabled = false;
    state.activeStation = stationId;
    updateHeader();
    closePanel();
    renderChat();
  }

  // ─── Config panel ─────────────────────────────────────────────────────────
  function saveConfig() {
    const raw = dom.configTa.value.trim();
    if (!raw) {
      clearConfig();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw); // textarea input parsed as JSON only — never injected as HTML
    } catch (e) {
      showConfigMsg("Invalid JSON: " + e.message, true);
      return;
    }
    const validKeys = new Set(STATIONS.map((s) => s.id));
    const keys = Object.keys(parsed);
    if (!keys.length || !keys.some((k) => validKeys.has(k))) {
      showConfigMsg(
        "JSON must contain at least one station key (A1\u2013C2).",
        true,
      );
      return;
    }
    state.stationUrls = parsed;
    try {
      sessionStorage.setItem(STORAGE.stationUrls, JSON.stringify(parsed));
    } catch (_) {}
    showConfigMsg("Saved.", false);
    setTimeout(() => closePanel(), 1000);
  }

  function clearConfig() {
    try {
      sessionStorage.removeItem(STORAGE.stationUrls);
    } catch (_) {}
    state.stationUrls = {};
    dom.configTa.value = "";
    showConfigMsg("Cleared. Using default URL for all stations.", false);
  }

  function showConfigMsg(text, isError) {
    dom.configMsg.textContent = text; // safe — textContent
    dom.configMsg.className = "wk-cw-system-msg" + (isError ? " is-error" : "");
    dom.configMsg.style.display = "";
  }

  // ─── Header ───────────────────────────────────────────────────────────────
  function updateHeader() {
    const station = STATIONS.find((s) => s.id === state.activeStation);
    dom.headerTitle.textContent = station ? station.id : "Dewy"; // safe
    dom.headerDesc.textContent = station ? station.label : "Ask me anything"; // safe
  }

  // ─── Chat render ──────────────────────────────────────────────────────────
  function renderChat() {
    dom.body.innerHTML = "";
    state.pendingToolCalls = {};
    state.typingEl = null;
    const list = state.transcripts[state.activeStation] || [];
    if (!list.length) {
      renderEmptyState();
      return;
    }
    list.forEach((entry) => drawEntry(entry));
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  function renderEmptyState() {
    const el = document.createElement("div");
    el.className = "wk-cw-empty-state";
    // Build empty-state with DOM methods to avoid innerHTML on user-visible elements.
    const iconWrap = document.createElement("div");
    iconWrap.className = "wk-cw-empty-icon";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.appendChild(parseSvg(SVG.sparkle)); // compile-time constant
    const titleEl = document.createElement("p");
    titleEl.className = "wk-cw-empty-title";
    titleEl.textContent = "Ask Dewy";
    const subEl = document.createElement("p");
    subEl.className = "wk-cw-empty-sub";
    subEl.textContent = "Pick a station and ask about your accounts.";
    el.appendChild(iconWrap);
    el.appendChild(titleEl);
    el.appendChild(subEl);
    dom.body.appendChild(el);
  }

  function drawEntry(entry) {
    switch (entry.kind) {
      case "me":
        appendUserBubble(entry.text);
        break;
      case "dewy":
        appendAssistantBubble(null, entry.text);
        break;
      case "tool_call": {
        const el = appendToolCard(entry.name, entry.toolUseId, entry.input);
        if (entry.result !== null) {
          fillToolCard(el, entry.result, entry.isError);
        }
        break;
      }
    }
  }

  // ─── Bubble helpers ───────────────────────────────────────────────────────
  function appendUserBubble(text) {
    const empty = dom.body.querySelector(".wk-cw-empty-state");
    if (empty) empty.remove();

    const message = document.createElement("div");
    message.className = "wk-cw-message is-user";

    const col = document.createElement("div");
    col.className = "wk-cw-msg-col";

    const bubble = document.createElement("div");
    bubble.className = "wk-cw-bubble";
    bubble.textContent = text; // safe — textContent

    col.appendChild(bubble);

    const avatar = document.createElement("div");
    avatar.className = "wk-cw-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "U";

    message.appendChild(col);
    message.appendChild(avatar);

    if (state.typingEl && dom.body.contains(state.typingEl)) {
      dom.body.insertBefore(message, state.typingEl);
    } else {
      dom.body.appendChild(message);
    }
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  function appendAssistantBubble(station, text) {
    // Remove typing indicator so bubble lands in the correct position
    hideTypingIndicator();

    const empty = dom.body.querySelector(".wk-cw-empty-state");
    if (empty) empty.remove();

    const message = document.createElement("div");
    message.className = "wk-cw-message is-genie";

    const avatar = document.createElement("div");
    avatar.className = "wk-cw-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "D";

    const col = document.createElement("div");
    col.className = "wk-cw-msg-col";

    const bubble = document.createElement("div");
    bubble.className = "wk-cw-bubble";
    // API response text is rendered as Markdown.  DOMPurify.sanitize() strips
    // any executable HTML/JS before the result reaches the DOM — this is the
    // correct, intentional mitigation for CWE-79 at this call-site.
    // DOMPurify and marked are loaded as script tags before this widget script.
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(text));

    col.appendChild(bubble);
    message.appendChild(avatar);
    message.appendChild(col);
    dom.body.appendChild(message);
    dom.body.scrollTop = dom.body.scrollHeight;

    // State updates only during live streaming (station != null)
    if (station) {
      const hist = (state.messages[station] = state.messages[station] || []);
      hist.push({ role: "assistant", content: text });
      if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);

      (state.transcripts[station] = state.transcripts[station] || []).push({
        kind: "dewy",
        text,
      });
      saveState();
    }
  }

  function appendSystemMessage(text, isError) {
    const el = document.createElement("div");
    el.className = "wk-cw-system-msg" + (isError ? " is-error" : "");
    el.textContent = text; // safe — textContent
    dom.body.appendChild(el);
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  // ─── Tool card helpers ────────────────────────────────────────────────────
  function appendToolCard(name, toolUseId, input) {
    const empty = dom.body.querySelector(".wk-cw-empty-state");
    if (empty) empty.remove();

    const details = document.createElement("details");
    details.className = "wk-cw-tool-details";
    details.dataset.toolId = toolUseId;

    const summary = document.createElement("summary");
    summary.className = "wk-cw-skill-card running";
    summary.setAttribute("aria-label", "Tool: " + name + ", running");

    const iconSpan = document.createElement("span");
    iconSpan.className = "wk-cw-skill-card-icon";
    iconSpan.appendChild(parseSvg(SVG.skill_running)); // compile-time constant

    const nameSpan = document.createElement("span");
    nameSpan.className = "wk-cw-skill-name";
    nameSpan.textContent = name; // safe — textContent

    const statusSpan = document.createElement("span");
    statusSpan.className = "wk-cw-skill-status running";
    statusSpan.textContent = "running";

    summary.appendChild(iconSpan);
    summary.appendChild(nameSpan);
    summary.appendChild(statusSpan);

    const body = document.createElement("div");
    body.className = "wk-cw-tool-body";

    const inputSection = document.createElement("div");
    inputSection.className = "wk-cw-tool-section";
    const inputLabel = document.createElement("div");
    inputLabel.className = "wk-cw-tool-label";
    inputLabel.textContent = "Input";
    const inputPre = document.createElement("pre");
    inputPre.className = "wk-cw-tool-json";
    inputPre.textContent = JSON.stringify(input, null, 2); // safe — textContent

    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputPre);

    const resultSection = document.createElement("div");
    resultSection.className = "wk-cw-tool-section wk-cw-tool-result";
    const resultLabel = document.createElement("div");
    resultLabel.className = "wk-cw-tool-label";
    resultLabel.textContent = "Pending\u2026";
    const resultPre = document.createElement("pre");
    resultPre.className = "wk-cw-tool-json";

    resultSection.appendChild(resultLabel);
    resultSection.appendChild(resultPre);

    body.appendChild(inputSection);
    body.appendChild(resultSection);
    details.appendChild(summary);
    details.appendChild(body);

    // Insert before typing indicator so it stays visible after tool card
    if (state.typingEl && dom.body.contains(state.typingEl)) {
      dom.body.insertBefore(details, state.typingEl);
    } else {
      dom.body.appendChild(details);
    }
    dom.body.scrollTop = dom.body.scrollHeight;

    return details;
  }

  function fillToolCard(el, result, isError) {
    if (!el) return;
    const summary = el.querySelector(".wk-cw-skill-card");
    if (summary) {
      summary.className =
        "wk-cw-skill-card " + (isError ? "failed" : "completed");
      const iconSpan = summary.querySelector(".wk-cw-skill-card-icon");
      if (iconSpan) {
        // Replace the running SVG with completed/failed icon (compile-time constants).
        while (iconSpan.firstChild) iconSpan.removeChild(iconSpan.firstChild);
        iconSpan.appendChild(parseSvg(isError ? SVG.skill_fail : SVG.skill_ok));
      }
      const statusSpan = summary.querySelector(".wk-cw-skill-status");
      if (statusSpan) {
        statusSpan.className =
          "wk-cw-skill-status " + (isError ? "failed" : "completed");
        statusSpan.textContent = isError ? "failed" : "completed"; // safe
      }
    }
    const resultSection = el.querySelector(".wk-cw-tool-result");
    if (resultSection) {
      if (isError) resultSection.classList.add("wk-cw-tool-result--error");
      const lbl = resultSection.querySelector(".wk-cw-tool-label");
      if (lbl) lbl.textContent = "Result";
      const pre = resultSection.querySelector(".wk-cw-tool-json");
      if (pre) pre.textContent = result; // safe — textContent
    }
  }

  // ─── Typing indicator ─────────────────────────────────────────────────────
  function showTypingIndicator() {
    if (state.typingEl) return;

    const row = document.createElement("div");
    row.className = "wk-cw-typing-row";

    const avatar = document.createElement("div");
    avatar.className = "wk-cw-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "D";

    const dots = document.createElement("div");
    dots.className = "wk-cw-typing-dots";
    dots.setAttribute("aria-label", "Dewy is typing");

    for (let i = 0; i < 3; i++) {
      dots.appendChild(document.createElement("span"));
    }

    row.appendChild(avatar);
    row.appendChild(dots);
    dom.body.appendChild(row);
    dom.body.scrollTop = dom.body.scrollHeight;

    state.typingEl = row;
  }

  function hideTypingIndicator() {
    if (state.typingEl) {
      state.typingEl.remove();
      state.typingEl = null;
    }
  }

  // ─── Input helpers ────────────────────────────────────────────────────────
  function autoResizeTextarea() {
    dom.textarea.style.height = "auto";
    dom.textarea.style.height = Math.min(dom.textarea.scrollHeight, 120) + "px";
  }

  function updateSendBtn() {
    dom.sendBtn.disabled = !dom.textarea.value.trim() || state.isBusy;
  }

  function chatDone() {
    hideTypingIndicator();
    state.isBusy = false;
    updateSendBtn();
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  // ─── 5. Bedrock SSE ──────────────────────────────────────────────────────
  async function handleSend() {
    const station = state.activeStation;
    const text = dom.textarea.value.trim();
    if (!station || !text || state.isBusy) return;

    state.isBusy = true;
    dom.sendBtn.disabled = true;
    dom.textarea.value = "";
    dom.textarea.style.height = "auto";

    const empty = dom.body.querySelector(".wk-cw-empty-state");
    if (empty) empty.remove();

    appendUserBubble(text);

    // Update Bedrock message history
    const hist = (state.messages[station] = state.messages[station] || []);
    hist.push({ role: "user", content: text });
    if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);

    // Persist transcript entry for user message
    (state.transcripts[station] = state.transcripts[station] || []).push({
      kind: "me",
      text,
    });
    saveState();

    showTypingIndicator();

    if (state.abortCtrl) state.abortCtrl.abort();
    state.abortCtrl = new AbortController();

    try {
      // Always POST to the Bedrock Lambda Function URL.
      // Pass the station's MCP URL (if configured) in the body so the Lambda
      // can connect to the correct Workato server.  The widget never calls
      // Workato directly — the Cognito Bearer token is only valid for the Lambda.
      const res = await fetch(state.chatFunctionUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + state.getToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          station,
          messages: state.messages[station],
          mcp_url: state.stationUrls[station] || null,
        }),
        signal: state.abortCtrl.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || "HTTP " + res.status);
      }
      await consumeSseStream(station, res.body.getReader());
    } catch (err) {
      if (err.name !== "AbortError") {
        hideTypingIndicator();
        appendSystemMessage(err.message, true);
        chatDone();
      }
    }
  }

  function consumeSseStream(station, reader) {
    const decoder = new TextDecoder();
    let buffer = "";

    function pump() {
      return reader.read().then(function (ref) {
        if (ref.done) return;
        buffer += decoder.decode(ref.value, { stream: true });
        // Handle both LF-only and CRLF line endings
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop(); // keep incomplete last line
        lines.forEach(function (line) {
          if (!line.startsWith("data: ")) return;
          try {
            handleSseEvent(station, JSON.parse(line.slice(6)));
          } catch (_) {}
        });
        return pump();
      });
    }
    return pump();
  }

  function handleSseEvent(station, evt) {
    switch (evt.type) {
      case "status":
        break; // no-op
      case "tools":
        break; // no-op
      case "tool_start":
        recordToolStart(station, evt.name, evt.toolUseId, evt.input);
        break;
      case "tool_result":
        recordToolResult(station, evt.toolUseId, evt.result, evt.isError);
        break;
      case "text":
        appendAssistantBubble(station, evt.content);
        chatDone();
        break;
      case "done":
        hideTypingIndicator();
        break;
      case "error":
        hideTypingIndicator();
        appendSystemMessage(evt.message, true);
        chatDone();
        break;
    }
  }

  function recordToolStart(station, name, toolUseId, input) {
    (state.transcripts[station] = state.transcripts[station] || []).push({
      kind: "tool_call",
      name,
      toolUseId,
      input,
      result: null,
      isError: false,
    });
    const el = appendToolCard(name, toolUseId, input);
    state.pendingToolCalls[toolUseId] = el;
    saveState();
  }

  function recordToolResult(station, toolUseId, result, isError) {
    const el = state.pendingToolCalls[toolUseId];
    // Update persisted transcript entry
    const list = state.transcripts[station] || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === "tool_call" && list[i].toolUseId === toolUseId) {
        list[i].result = result;
        list[i].isError = isError;
        break;
      }
    }
    if (el) {
      fillToolCard(el, result, isError);
      delete state.pendingToolCalls[toolUseId];
    }
    saveState();
  }

  // ─── 6. State management ─────────────────────────────────────────────────
  function loadState() {
    try {
      const t = sessionStorage.getItem(STORAGE.transcripts);
      const m = sessionStorage.getItem(STORAGE.messages);
      const u = sessionStorage.getItem(STORAGE.stationUrls);
      if (t) state.transcripts = JSON.parse(t);
      if (m) state.messages = JSON.parse(m);
      if (u) state.stationUrls = JSON.parse(u);
    } catch (_) {}
  }

  function saveState() {
    try {
      sessionStorage.setItem(
        STORAGE.transcripts,
        JSON.stringify(state.transcripts),
      );
      sessionStorage.setItem(STORAGE.messages, JSON.stringify(state.messages));
    } catch (_) {}
  }

  // ─── 7. Public API ────────────────────────────────────────────────────────
  function init(getTokenFn, url) {
    state.getToken = getTokenFn;
    state.chatFunctionUrl = url;
  }

  function chatLoad() {
    loadState();
    dom.fab.style.display = ""; // make FAB visible
    updateHeader();
    renderChat();
  }

  function chatReset() {
    if (state.abortCtrl) {
      state.abortCtrl.abort();
      state.abortCtrl = null;
    }
    sessionStorage.removeItem(STORAGE.transcripts);
    sessionStorage.removeItem(STORAGE.messages);
    // Intentionally leave dewy_chat_station_urls so participants don't
    // have to re-paste the config after every logout/login cycle.
    state.messages = {};
    state.transcripts = {};
    state.pendingToolCalls = {};
    state.isBusy = false;
    state.typingEl = null;
    closeWidget();
    dom.fab.style.display = "none"; // hide until next login
  }

  window.chatWidget = { init, chatLoad, chatReset };
  window.WkChatWidget = {
    open() {
      openWidget();
    },
    close() {
      closeWidget();
    },
    reset() {
      closeWidget();
    }, // app.js calls this on logout before chatReset
  };

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  buildWidget();
  wireEvents();
})();
