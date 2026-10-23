(function () {
  "use strict";

  // ── Local helpers (not on window — private to this IIFE) ──────────────────
  var $ = function (id) {
    return document.getElementById(id);
  };
  function msg(el, text, ok) {
    el.textContent = "";
    if (text) {
      var div = document.createElement("div");
      div.className = "msg " + (ok ? "ok" : "err");
      div.textContent = text;
      el.appendChild(div);
    }
  }

  // ── Station registry ────────────────────────────────────────────────────────
  var STATIONS = [
    ["A1", "A1 · Station A, flaw"],
    ["A2", "A2 · Station A, fix"],
    ["B1", "B1 · Station B, flaw"],
    ["B2", "B2 · Station B, fix"],
    ["C1", "C1 · Station C, flaw"],
    ["C2", "C2 · Station C, fix"],
  ];

  // ── Widget state ────────────────────────────────────────────────────────────
  var getToken = null;               // function() -> idToken
  var chatFunctionUrl = null;        // Lambda Function URL string
  var messages = {};                 // { station: [{role, content}] }  Bedrock history
  var transcripts = {};              // { station: [{kind, …}] }        display state
  var pendingToolCalls = {};         // { toolUseId: detailsElement }
  var currentFetchController = null; // NIT-5: AbortController for in-flight fetch
  var chat = {
    busy: false,
    thinkingBubble: null,
  };

  // ── Public API ──────────────────────────────────────────────────────────────

  function init(getTokenFn, url) {
    getToken = getTokenFn;
    chatFunctionUrl = url;

    // Attach all chat DOM listeners here — app.js never touches chat elements.
    $("chatSend").onclick = chatSend;
    $("chatText").onkeydown = function (e) {
      if (e.key === "Enter") chatSend();
    };
    $("chatStation").onchange = function () {
      updateChatSubtitle();
      chatRedraw();
    };
    $("chatClearBtn").onclick = function () {
      chatReset();
      chatLoad();
    };
  }

  function chatLoad() {
    // Restore persisted state if available.
    try {
      var savedT = sessionStorage.getItem("dewy_chat_transcripts");
      var savedM = sessionStorage.getItem("dewy_chat_messages");
      if (savedT) transcripts = JSON.parse(savedT);
      if (savedM) messages = JSON.parse(savedM);
    } catch (e) {}

    // All stations are always available — no API call needed.
    renderStations();
  }

  function chatReset() {
    // NIT-5: abort any in-flight fetch request before clearing state.
    if (currentFetchController) {
      currentFetchController.abort();
      currentFetchController = null;
    }
    sessionStorage.removeItem("dewy_chat_transcripts");
    sessionStorage.removeItem("dewy_chat_messages");
    messages = {};
    transcripts = {};
    pendingToolCalls = {};
    chat.busy = false;
    chat.thinkingBubble = null;
    chatStatusOnly("Pick a station and say hello.");
  }

  // ── Internal functions ──────────────────────────────────────────────────────

  function renderStations() {
    var sel = $("chatStation"),
      current = sel.value;
    sel.innerHTML = DOMPurify.sanitize(
      STATIONS.map(function (s) {
        return '<option value="' + esc(s[0]) + '">' + esc(s[1]) + "</option>";
      }).join(""),
    );
    var valid = STATIONS.some(function (s) {
      return s[0] === current;
    });
    if (valid) sel.value = current;
    $("chatText").disabled = $("chatSend").disabled = false;
    updateChatSubtitle();
    chatRedraw();
  }

  function updateChatSubtitle() {
    var key = $("chatStation").value;
    var entry = STATIONS.filter(function (s) {
      return s[0] === key;
    })[0];
    $("chatSubtitle").textContent = entry ? entry[1] : "";
  }

  function chatRedraw() {
    var station = $("chatStation").value;
    var list = transcripts[station] || [];
    if (!list.length) {
      chatStatusOnly("Say hello to " + station + ".");
      return;
    }
    $("chatLog").textContent = "";
    chat.thinkingBubble = null;
    list.forEach(function (e) {
      drawEntry(station, e);
    });
    if (chat.busy) chat.thinkingBubble = bubbleThinking();
  }

  function chatSend() {
    var station = $("chatStation").value;
    var text = $("chatText").value.trim();
    if (!station || !text || chat.busy) return;

    chat.busy = true;
    $("chatSend").disabled = true;
    msg($("chatMsg"), "");

    // NIT-5: abort any previous in-flight request before starting a new one.
    if (currentFetchController) currentFetchController.abort();
    currentFetchController = new AbortController();

    // Append to Bedrock message history before sending.
    (messages[station] = messages[station] || []).push({
      role: "user",
      content: text,
    });
    // Trim to MAX_HISTORY (80 entries = 40 pairs).
    if (messages[station].length > 80) {
      messages[station] = messages[station].slice(
        messages[station].length - 80,
      );
    }
    record(station, "me", text);
    chat.thinkingBubble = bubbleThinking();
    $("chatText").value = "";

    fetch(chatFunctionUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer " + getToken(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ station: station, messages: messages[station] }),
      signal: currentFetchController.signal,
    })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (j) {
            throw new Error(j.message || "HTTP " + response.status);
          });
        }
        return consumeSseStream(station, response.body.getReader());
      })
      .catch(function (e) {
        if (e.name !== "AbortError") {
          msg($("chatMsg"), e.message, false);
        }
        chatDone();
      });
  }

  function consumeSseStream(station, reader) {
    var decoder = new TextDecoder();
    var buffer = "";

    function pump() {
      return reader.read().then(function (ref) {
        if (ref.done) {
          // NIT-4: do not call chatDone() here; handleSseEvent owns lifecycle.
          return;
        }
        buffer += decoder.decode(ref.value, { stream: true });
        // NIT-3: handle both LF-only and CRLF line endings.
        var lines = buffer.split(/\r?\n/);
        buffer = lines.pop(); // incomplete last line
        lines.forEach(function (line) {
          if (!line.startsWith("data: ")) return;
          try {
            handleSseEvent(station, JSON.parse(line.slice(6)));
          } catch {}
        });
        return pump();
      });
    }
    return pump();
  }

  function handleSseEvent(station, evt) {
    switch (evt.type) {
      case "status":
        // No-op — status messages are informational only.
        break;
      case "tools":
        // Tool list received — no UI action needed currently.
        break;
      case "tool_start":
        recordToolStart(station, evt.name, evt.toolUseId, evt.input);
        break;
      case "tool_result":
        recordToolResult(station, evt.toolUseId, evt.result, evt.isError);
        break;
      case "text":
        // Append to Bedrock message history for the next turn.
        (messages[station] = messages[station] || []).push({
          role: "assistant",
          content: evt.content,
        });
        saveState();
        record(station, "dewy", evt.content);
        chatDone();
        break;
      case "error":
        msg($("chatMsg"), evt.message, false);
        chatDone();
        break;
      case "done":
        // NIT-4: no-op; chatDone() is called by the 'text' or 'error' handler.
        break;
    }
  }

  function recordToolStart(station, name, toolUseId, input) {
    (transcripts[station] = transcripts[station] || []).push({
      kind: "tool_call",
      name: name,
      toolUseId: toolUseId,
      input: input,
      result: null,
      isError: false,
    });
    var entry = transcripts[station][transcripts[station].length - 1];
    var el = bubbleToolCall(entry);
    // Key by toolUseId — unique even if the same tool is called twice in one turn.
    pendingToolCalls[toolUseId] = el;
    saveState();
  }

  function recordToolResult(station, toolUseId, result, isError) {
    var el = pendingToolCalls[toolUseId];
    // Update the persisted transcript entry.
    var list = transcripts[station] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === "tool_call" && list[i].toolUseId === toolUseId) {
        list[i].result = result;
        list[i].isError = isError;
        break;
      }
    }
    if (el) {
      fillToolCallResult(el, result, isError);
      delete pendingToolCalls[toolUseId];
    }
    saveState();
  }

  function bubbleToolCall(entry) {
    var details = document.createElement("details");
    details.className = "bubble-tool-call";
    var summary = document.createElement("summary");
    summary.className = "tool-call-summary";
    summary.textContent = "\uD83D\uDD27 " + entry.name; // 🔧 via textContent — safe
    var body = document.createElement("div");
    body.className = "tool-call-body";

    var inputSection = document.createElement("div");
    inputSection.className = "tool-call-section";
    var inputLabel = document.createElement("div");
    inputLabel.className = "tool-call-label";
    inputLabel.textContent = "Input";
    var inputPre = document.createElement("pre");
    inputPre.className = "tool-call-json";
    inputPre.textContent = JSON.stringify(entry.input, null, 2); // textContent — safe
    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputPre);

    var resultSection = document.createElement("div");
    resultSection.className = "tool-call-section tool-call-result";
    var resultLabel = document.createElement("div");
    resultLabel.className = "tool-call-label";
    resultLabel.textContent = entry.result === null ? "Pending\u2026" : "Result";
    var resultPre = document.createElement("pre");
    resultPre.className = "tool-call-json";
    resultPre.textContent = entry.result !== null ? entry.result : "";
    resultSection.appendChild(resultLabel);
    resultSection.appendChild(resultPre);

    body.appendChild(inputSection);
    body.appendChild(resultSection);
    details.appendChild(summary);
    details.appendChild(body);

    var log = $("chatLog");
    if (chat.thinkingBubble && log.contains(chat.thinkingBubble)) {
      log.insertBefore(details, chat.thinkingBubble);
    } else {
      log.appendChild(details);
    }
    log.scrollTop = log.scrollHeight;
    return details;
  }

  function fillToolCallResult(el, result, isError) {
    var resultSection = el.querySelector(".tool-call-result");
    if (!resultSection) return;
    if (isError) resultSection.classList.add("is-error");
    var label = resultSection.querySelector(".tool-call-label");
    var pre = resultSection.querySelector(".tool-call-json");
    if (label) label.textContent = "Result"; // replaces "Pending…"
    if (pre) pre.textContent = result;
  }

  function drawEntry(station, e) {
    if (e.kind === "me" || e.kind === "dewy" || e.kind === "status") {
      bubble(e.kind, e.text);
    } else if (e.kind === "tool_call") {
      bubbleToolCall(e);
    }
  }

  // ── Bubble helpers ─────────────────────────────────────────────────────────

  function bubble(kind, text) {
    var log = $("chatLog");
    var empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    var el = document.createElement("div");
    el.className = "bubble " + kind;
    if (kind === "dewy") {
      el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
      el.textContent = text;
    }
    if (kind === "me" || kind === "dewy") {
      var wrap = document.createElement("div");
      wrap.className =
        "bubble-wrap " + (kind === "me" ? "me-wrap" : "dewy-wrap");
      var label = document.createElement("div");
      label.className = "bubble-label";
      label.textContent =
        kind === "me" ? "You" : $("chatStation").value || "Dewy";
      wrap.appendChild(label);
      wrap.appendChild(el);
      var anchor =
        chat.thinkingBubble && log.contains(chat.thinkingBubble)
          ? chat.thinkingBubble
          : null;
      if (anchor) log.insertBefore(wrap, anchor);
      else log.appendChild(wrap);
    } else {
      var anchor2 =
        chat.thinkingBubble && log.contains(chat.thinkingBubble)
          ? chat.thinkingBubble
          : null;
      if (anchor2) log.insertBefore(el, anchor2);
      else log.appendChild(el);
    }
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function bubbleThinking() {
    var empty = $("chatLog").querySelector(".chat-empty");
    if (empty) empty.remove();
    var el = document.createElement("div");
    el.className = "bubble thinking";
    el.setAttribute("aria-label", "Dewy is thinking");
    el.innerHTML = "<span></span><span></span><span></span>"; // static literal — safe
    $("chatLog").appendChild(el);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
    return el;
  }

  function chatStatusOnly(text) {
    $("chatLog").textContent = "";
    chat.thinkingBubble = null;
    var el = document.createElement("div");
    el.className = "chat-empty";
    el.textContent = text;
    $("chatLog").appendChild(el);
  }

  // chatDone() takes no arguments.
  function chatDone() {
    if (chat.thinkingBubble) {
      chat.thinkingBubble.remove();
      chat.thinkingBubble = null;
    }
    chat.busy = false;
    $("chatSend").disabled = false;
    var log = $("chatLog");
    log.scrollTop = log.scrollHeight;
  }

  function record(station, kind, text) {
    (transcripts[station] = transcripts[station] || []).push({
      kind: kind,
      text: text,
    });
    if ($("chatStation").value === station) {
      drawEntry(station, transcripts[station][transcripts[station].length - 1]);
    }
    saveState();
  }

  function saveState() {
    try {
      sessionStorage.setItem(
        "dewy_chat_transcripts",
        JSON.stringify(transcripts),
      );
      sessionStorage.setItem("dewy_chat_messages", JSON.stringify(messages));
    } catch {}
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch];
    });
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  // Public API is intentionally minimal — app.js needs only three entry points.
  window.chatWidget = { init: init, chatLoad: chatLoad, chatReset: chatReset };
})();
