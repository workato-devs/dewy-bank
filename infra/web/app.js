/* Dewy Bank SPA — plain JS, no build. Reads window.DEWY_CONFIG from config.js
 * (injected at deploy): { region, userPoolId, userPoolClientId, customerApiUrl }.
 *
 * Auth is direct-to-Cognito via the IDP JSON API (SignUp / ConfirmSignUp /
 * InitiateAuth USER_PASSWORD_AUTH); the SPA client has no secret. The IdToken is
 * sent as `Authorization: Bearer <idToken>` to the Customer API, whose JWT
 * authorizer validates it and whose handler scopes everything to the token's
 * `sub` (and gates /admin/* on the `facilitators` group claim). */
(function () {
  var cfg = window.DEWY_CONFIG || {};
  var COGNITO = "https://cognito-idp." + cfg.region + ".amazonaws.com/";
  var API = (cfg.customerApiUrl || "").replace(/\/+$/, "");
  var idToken = sessionStorage.getItem("dewy_id_token") || null;

  var $ = function (id) {
    return document.getElementById(id);
  };
  function show(el) {
    el && el.classList.remove("hide");
  }
  function hide(el) {
    el && el.classList.add("hide");
  }
  // Escape text before it goes into innerHTML. Memos are free text from whoever
  // sent the money (P2), so everything from the API is escaped on display; the
  // backend still stores it exactly as sent.
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
  function msg(el, text, ok) {
    el.innerHTML = text
      ? '<div class="msg ' + (ok ? "ok" : "err") + '">' + esc(text) + "</div>"
      : "";
  }
  function money(n, opts) {
    var neg = n < 0;
    var v = Math.abs(Number(n) || 0);
    var s =
      "$" +
      v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    return (neg ? "−" : opts && opts.sign ? "+" : "") + s;
  }

  // ---- category + account visuals -------------------------------------
  var CAT_ICON = {
    Dining: "🍽️",
    Groceries: "🛒",
    Income: "💰",
    Transport: "🚗",
    Housing: "🏠",
    Transfer: "↔️",
    Interest: "🏦",
    Shopping: "🛍️",
    Travel: "✈️",
    Other: "•",
  };
  var CAT_COLOR = {
    Dining: "#f59e0b",
    Groceries: "#16a34a",
    Transport: "#0ea5a4",
    Housing: "#7c3aed",
    Shopping: "#ec4899",
    Travel: "#0b5cff",
    Other: "#94a3b8",
  };
  var ACCT_ICON = { checking: "💳", savings: "🏦", credit: "💠" };
  function acctType(a) {
    return a.type || "checking";
  }

  // ---- Cognito IDP JSON calls -----------------------------------------
  function cognito(action, body) {
    return fetch(COGNITO, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService." + action,
      },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || j.__type || "Request failed");
        return j;
      });
    });
  }
  function signUp(email, pass) {
    return cognito("SignUp", {
      ClientId: cfg.userPoolClientId,
      Username: email,
      Password: pass,
      UserAttributes: [{ Name: "email", Value: email }],
    });
  }
  function confirmSignUp(email, code) {
    return cognito("ConfirmSignUp", {
      ClientId: cfg.userPoolClientId,
      Username: email,
      ConfirmationCode: code,
    });
  }
  function login(email, pass) {
    return cognito("InitiateAuth", {
      ClientId: cfg.userPoolClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: pass },
    }).then(function (j) {
      var r = j.AuthenticationResult;
      if (!r || !r.IdToken) throw new Error("No token returned");
      idToken = r.IdToken;
      sessionStorage.setItem("dewy_id_token", idToken);
      return r;
    });
  }

  // ---- JWT claims (client-side read of the already-validated token) ----
  function claims() {
    try {
      return JSON.parse(
        atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
    } catch (e) {
      return {};
    }
  }
  function isFacilitator() {
    var g = claims()["cognito:groups"] || [];
    if (typeof g === "string") g = g.replace(/[\[\]]/g, "").split(/[,\s]+/);
    return (g || []).indexOf("facilitators") !== -1;
  }

  // ---- Customer API ----------------------------------------------------
  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: {
        authorization: "Bearer " + idToken,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401) {
          logout();
          throw new Error("Session expired, log in again");
        }
        if (!r.ok) throw new Error(j.message || "Request failed");
        return j;
      });
    });
  }

  // ---- Auth UI ---------------------------------------------------------
  function activate(tab) {
    $("tabLogin").classList.toggle("active", tab === "login");
    $("tabSignup").classList.toggle("active", tab === "signup");
    $("loginForm").classList.toggle("hide", tab !== "login");
    $("signupForm").classList.toggle("hide", tab !== "signup");
    hide($("confirmForm"));
    msg($("authMsg"), "");
  }
  $("tabLogin").onclick = function () {
    activate("login");
  };
  $("tabSignup").onclick = function () {
    activate("signup");
  };

  $("suBtn").onclick = function () {
    var email = $("suEmail").value.trim(),
      pass = $("suPass").value;
    msg($("authMsg"), "Creating account…", true);
    signUp(email, pass)
      .then(function () {
        hide($("signupForm"));
        show($("confirmForm"));
        msg(
          $("authMsg"),
          "Account created — check your email for a code.",
          true,
        );
      })
      .catch(function (e) {
        msg($("authMsg"), e.message, false);
      });
  };
  $("confBtn").onclick = function () {
    var email = $("suEmail").value.trim(),
      code = $("confCode").value.trim();
    confirmSignUp(email, code)
      .then(function () {
        msg($("authMsg"), "Confirmed! Log in to continue.", true);
        activate("login");
        $("loginEmail").value = email;
      })
      .catch(function (e) {
        msg($("authMsg"), e.message, false);
      });
  };
  $("loginBtn").onclick = function () {
    var email = $("loginEmail").value.trim(),
      pass = $("loginPass").value;
    msg($("authMsg"), "Logging in…", true);
    login(email, pass)
      .then(enterApp)
      .catch(function (e) {
        msg($("authMsg"), e.message, false);
      });
  };
  $("logout").onclick = function (e) {
    e.preventDefault();
    logout();
  };
  function logout() {
    idToken = null;
    sessionStorage.removeItem("dewy_id_token");
    if (typeof chatReset === "function") chatReset();
    hide($("appShell"));
    show($("authScreen"));
  }

  // ---- App -------------------------------------------------------------
  var accountsCache = [];
  var selectedAcct = null;

  function enterApp() {
    hide($("authScreen"));
    show($("appShell"));
    $("asOf").textContent =
      "As of " +
      new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    if (isFacilitator()) show($("adminLink"));
    api("GET", "/me")
      .then(function (me) {
        $("sideEmail").textContent = me.email || me.customerId;
        $("hello").textContent =
          "Welcome back" + (me.email ? ", " + me.email.split("@")[0] : "");
      })
      .catch(function () {});
    loadAccounts();
    chatLoad();
  }

  function loadAccounts() {
    api("GET", "/accounts")
      .then(function (res) {
        accountsCache = res.accounts || [];
        renderNet();
        renderCards();
        renderTransferOptions();
        if (accountsCache.length) {
          openDetail(
            selectedAcct && find(selectedAcct)
              ? selectedAcct
              : accountsCache[0].accountId,
          );
        }
      })
      .catch(function (e) {
        $("accountCards").innerHTML =
          '<div class="msg err">' + esc(e.message) + "</div>";
      });
  }
  function find(id) {
    return accountsCache.filter(function (a) {
      return a.accountId === id;
    })[0];
  }

  function renderNet() {
    var total = accountsCache.reduce(function (s, a) {
      return s + Number(a.balance || 0);
    }, 0);
    $("netAmt").textContent = money(total);
    var assets = accountsCache.filter(function (a) {
      return a.balance >= 0;
    }).length;
    $("netMeta").textContent =
      accountsCache.length + " accounts · " + assets + " in good standing";
  }

  function renderCards() {
    if (!accountsCache.length) {
      $("accountCards").innerHTML = '<div class="card">No accounts yet.</div>';
      return;
    }
    $("accountCards").innerHTML = accountsCache
      .map(function (a) {
        var t = acctType(a),
          neg = a.balance < 0;
        var last4 = (a.accountId || "").slice(-4);
        return (
          '<div class="acct-card" data-id="' +
          esc(a.accountId) +
          '">' +
          '<span class="tag">' +
          esc(t) +
          "</span>" +
          '<div class="ic ' +
          esc(t) +
          '">' +
          (ACCT_ICON[t] || "💳") +
          "</div>" +
          '<div class="nm">' +
          esc(a.name) +
          "</div>" +
          '<div class="no mono">•••• ' +
          esc(last4) +
          "</div>" +
          '<div class="bal' +
          (neg ? " neg" : "") +
          '">' +
          money(a.balance) +
          "</div>" +
          "</div>"
        );
      })
      .join("");
    Array.prototype.forEach.call(
      document.querySelectorAll(".acct-card"),
      function (c) {
        c.onclick = function () {
          openDetail(c.dataset.id);
        };
      },
    );
  }

  function renderTransferOptions() {
    var opts = accountsCache
      .map(function (a) {
        return (
          '<option value="' +
          esc(a.accountId) +
          '">' +
          esc(a.name) +
          " — " +
          money(a.balance) +
          "</option>"
        );
      })
      .join("");
    $("xferFrom").innerHTML = opts;
    $("xferTo").innerHTML = opts;
    if (accountsCache.length > 1) $("xferTo").selectedIndex = 1;
  }

  $("xferBtn").onclick = function () {
    var from = $("xferFrom").value,
      to = $("xferTo").value,
      amount = parseFloat($("xferAmt").value);
    if (!(amount > 0)) {
      msg($("xferMsg"), "Enter a positive amount", false);
      return;
    }
    if (from === to) {
      msg($("xferMsg"), "Pick two different accounts", false);
      return;
    }
    msg($("xferMsg"), "Sending…", true);
    api("POST", "/transfers", { from: from, to: to, amount: amount })
      .then(function () {
        msg($("xferMsg"), "Transfer complete ✓", true);
        $("xferAmt").value = "";
        loadAccounts();
      })
      .catch(function (e) {
        msg($("xferMsg"), e.message, false);
      });
  };

  function openDetail(id) {
    selectedAcct = id;
    var acct = find(id);
    $("actAcct").textContent = acct ? acct.name : "";
    $("txns").textContent = "Loading…";
    api("GET", "/accounts/" + encodeURIComponent(id) + "/transactions")
      .then(function (res) {
        renderTxns(res.transactions || []);
        renderSpend(res.transactions || []);
      })
      .catch(function (e) {
        $("txns").innerHTML =
          '<div class="msg err">' + esc(e.message) + "</div>";
      });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date((iso || "").split("#")[0]);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function renderTxns(txns) {
    if (!txns.length) {
      $("txns").textContent = "No transactions yet.";
      return;
    }
    var html = "<table><tbody>";
    txns.forEach(function (t) {
      var cat = t.category || "Other";
      var credit = t.type === "credit";
      html +=
        '<tr class="txn"><td style="width:46px"><div class="catdot">' +
        (CAT_ICON[cat] || "•") +
        "</div></td>" +
        '<td><div class="tdesc">' +
        esc(t.memo || t.counterparty || cat) +
        "</div>" +
        '<div class="tsub">' +
        esc(fmtDate(t.createdAt)) +
        " · " +
        esc(cat) +
        "</div></td>" +
        '<td style="width:90px"><span class="badge ' +
        (credit ? "credit" : "debit") +
        '">' +
        esc(t.type) +
        "</span></td>" +
        '<td class="amt-cell ' +
        (credit ? "credit" : "debit") +
        '">' +
        money(t.amount, { sign: credit }) +
        "</td></tr>";
    });
    html += "</tbody></table>";
    $("txns").innerHTML = html;
  }

  function renderSpend(txns) {
    var by = {};
    txns
      .filter(function (t) {
        return t.type === "debit";
      })
      .forEach(function (t) {
        var c = t.category || "Other";
        by[c] = (by[c] || 0) + Number(t.amount || 0);
      });
    var cats = Object.keys(by).sort(function (a, b) {
      return by[b] - by[a];
    });
    if (!cats.length) {
      $("spend").textContent = "No spending on this account yet.";
      return;
    }
    var max = Math.max.apply(
      null,
      cats.map(function (c) {
        return by[c];
      }),
    );
    $("spend").innerHTML = cats
      .map(function (c) {
        var pct = Math.max(6, Math.round((by[c] / max) * 100));
        var color = CAT_COLOR[c] || CAT_COLOR.Other;
        return (
          '<div class="bar-row"><div>' +
          (CAT_ICON[c] || "•") +
          " " +
          esc(c) +
          "</div>" +
          '<div class="track"><div class="fill" style="width:' +
          pct +
          "%;background:" +
          color +
          '"></div></div>' +
          '<div class="val">' +
          money(by[c]) +
          "</div></div>"
        );
      })
      .join("");
  }

  // ---- Chat panel (P8) -------------------------------------------------
  // Talks to the participant's own Genies through the bank's /chat proxy; the
  // browser never holds a Workato key. Sending is asynchronous, so after each
  // send the panel polls /chat/events until the turn finishes. Every Genie
  // reply is set with textContent, never as HTML.
  var STATIONS = [
    ["A1", "A1 · Station A, flaw"],
    ["A2", "A2 · Station A, fix"],
    ["B1", "B1 · Station B, flaw"],
    ["B2", "B2 · Station B, fix"],
    ["C1", "C1 · Station C, flaw"],
    ["C2", "C2 · Station C, fix"],
  ];
  var chat = {
    configured: {},
    conversations: {},
    since: {},
    seen: {},
    polling: null,
    busy: false,
  };

  function chatLoad() {
    console.log("[chat] init");
    try {
      var saved = sessionStorage.getItem("dewy_chat_transcripts");
      if (saved) {
        transcripts = JSON.parse(saved);
        var n = Object.keys(transcripts).reduce(function (s, k) {
          return s + transcripts[k].length;
        }, 0);
        console.log("[chat] restored " + n + " messages from session storage");
      }
    } catch (e) {}
    api("GET", "/me/genie-clients")
      .then(function (r) {
        chat.configured = r.stations || {};
        renderStations();
      })
      .catch(function (e) {
        msg($("chatMsg"), e.message, false);
      });
  }

  function renderStations() {
    var sel = $("chatStation"),
      current = sel.value;
    var ready = STATIONS.filter(function (s) {
      return chat.configured[s[0]];
    });
    sel.innerHTML = ready
      .map(function (s) {
        return '<option value="' + esc(s[0]) + '">' + esc(s[1]) + "</option>";
      })
      .join("");
    if (
      ready.some(function (s) {
        return s[0] === current;
      })
    )
      sel.value = current;
    var any = ready.length > 0;
    sel.classList.toggle("hide", !any);
    $("chatText").disabled = $("chatSend").disabled = !any;
    if (!any) {
      show($("chatSetup"));
      chatStatusOnly("Set up chat to talk to your stations.");
    } else {
      chatRedraw();
    }
  }

  function bubble(kind, text) {
    var log = $("chatLog");
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    var empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    var el = document.createElement("div");
    el.className = "bubble " + kind;
    el.textContent = text;
    log.appendChild(el);
    if (nearBottom) {
      log.scrollTop = log.scrollHeight;
      console.log("[chat] scroll: auto");
    } else {
      console.log("[chat] scroll: user-scrolled");
    }
    return el;
  }
  function chatStatusOnly(text) {
    $("chatLog").innerHTML = "";
    var el = document.createElement("div");
    el.className = "chat-empty";
    el.textContent = text;
    $("chatLog").appendChild(el);
  }

  // Each station keeps its own transcript for this session.
  var transcripts = {};
  function record(station, kind, text, extra) {
    (transcripts[station] = transcripts[station] || []).push({
      kind: kind,
      text: text,
      extra: extra,
    });
    if ($("chatStation").value === station)
      drawEntry(station, transcripts[station][transcripts[station].length - 1]);
    try {
      sessionStorage.setItem(
        "dewy_chat_transcripts",
        JSON.stringify(transcripts),
      );
      var n = Object.keys(transcripts).reduce(function (s, k) {
        return s + transcripts[k].length;
      }, 0);
      console.log("[chat] saved history (" + n + " messages)");
      console.log(
        "[chat] saved history for " +
          station +
          " (" +
          (transcripts[station] || []).length +
          " messages)",
      );
    } catch (e) {}
  }
  function chatRedraw() {
    var station = $("chatStation").value;
    var list = transcripts[station] || [];
    if (!list.length) {
      chatStatusOnly("Say hello to " + station + ".");
      return;
    }
    $("chatLog").innerHTML = "";
    list.forEach(function (e) {
      drawEntry(station, e);
    });
  }
  function drawEntry(station, e) {
    if (e.kind !== "confirm") {
      bubble(e.kind, e.text);
      return;
    }
    var el = bubble("confirm", e.text);
    if (e.extra.answered) return;
    var acts = document.createElement("div");
    acts.className = "acts";
    [
      ["approved", "Approve", ""],
      ["rejected", "Decline", "ghost"],
    ].forEach(function (b) {
      var btn = document.createElement("button");
      btn.textContent = b[1];
      if (b[2]) btn.className = b[2];
      btn.onclick = function () {
        answerConfirmation(station, e, b[0]);
      };
      acts.appendChild(btn);
    });
    el.appendChild(acts);
  }

  function chatSend() {
    var station = $("chatStation").value,
      text = $("chatText").value.trim();
    if (!station || !text || chat.busy) return;
    chat.busy = true;
    $("chatSend").disabled = true;
    msg($("chatMsg"), "");
    console.log('[chat] send: "' + text.slice(0, 50) + '"');
    record(station, "me", text);
    $("chatText").value = "";
    api("POST", "/chat", {
      station: station,
      message: text,
      conversation: chat.conversations[station],
    })
      .then(function (r) {
        chat.conversations[station] = r.conversation;
        pollEvents(station, r.run);
      })
      .catch(function (e) {
        console.error("[chat] error: " + e.message);
        msg($("chatMsg"), e.message, false);
        chatDone();
      });
  }

  function answerConfirmation(station, entry, resolution) {
    entry.extra.answered = true;
    chatRedraw();
    record(
      station,
      "status",
      resolution === "approved" ? "You approved it." : "You declined it.",
    );
    api("POST", "/chat", {
      station: station,
      conversation: chat.conversations[station],
      approval: { call_id: entry.extra.callId, resolution: resolution },
    })
      .then(function () {
        pollEvents(station);
      })
      .catch(function (e) {
        msg($("chatMsg"), e.message, false);
      });
  }

  // Workato's event payloads are relayed as is; read them defensively.
  function eventsOf(r) {
    var x = r.events;
    if (Array.isArray(x)) return x;
    return (x && (x.events || x.data || x.items)) || [];
  }
  function field(e, names) {
    for (var i = 0; i < names.length; i++) {
      var path = names[i].split("."),
        v = e;
      for (var j = 0; j < path.length && v != null; j++) v = v[path[j]];
      if (v != null && v !== "") return v;
    }
    return null;
  }

  // The events feed has no end-of-turn event: a turn ends with its run's agent.message
  // (observed 2026-10-22; processing.finished never arrives). Without the run's ID, the
  // next agent.message ends the turn.
  function pollEvents(station, run) {
    clearTimeout(chat.polling);
    var started = Date.now();
    var partialBubble = null;
    var thinkingEl = null;
    var chunkN = 0;
    var totalBytes = 0;

    // Thinking indicator — inserted before first tick result arrives
    thinkingEl = document.createElement("div");
    thinkingEl.className = "bubble dewy thinking";
    thinkingEl.innerHTML = "<span></span><span></span><span></span>";
    var log = $("chatLog");
    var empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    log.appendChild(thinkingEl);
    log.scrollTop = log.scrollHeight;
    console.log("[chat] poll: open");
    console.log("[chat] streaming started");

    (function tick() {
      var conv = chat.conversations[station];
      var q =
        "?station=" +
        encodeURIComponent(station) +
        "&conversation=" +
        encodeURIComponent(conv) +
        (chat.since[conv]
          ? "&since=" + encodeURIComponent(chat.since[conv])
          : "");
      api("GET", "/chat/events" + q)
        .then(function (r) {
          var finished = false,
            seen = (chat.seen[conv] = chat.seen[conv] || {});
          eventsOf(r).forEach(function (e) {
            var type = field(e, ["type", "event", "event_type", "name"]);
            var id = field(e, ["seq_num", "id"]);
            var key =
              id != null ? String(id) : type + "|" + field(e, ["created_at"]);
            if (seen[key]) return;
            seen[key] = true;
            var at = field(e, ["created_at", "createdAt"]);
            if (at) chat.since[conv] = at;

            // Per-event chunk accounting
            chunkN++;
            var byteLen = JSON.stringify(e).length;
            totalBytes += byteLen;
            console.log(
              "[chat] chunk #" + chunkN + " (+" + byteLen + " bytes)",
            );

            if (type === "agent.message") {
              if (thinkingEl) {
                thinkingEl.remove();
                thinkingEl = null;
                console.log("[chat] first chunk received");
              }
              var text = field(e, [
                "data.message",
                "data.content",
                "data.text",
                "message",
                "content",
                "text",
                "payload.message",
              ]);
              if (text) {
                record(
                  station,
                  "dewy",
                  typeof text === "string" ? text : JSON.stringify(text),
                );
                partialBubble = $("chatLog").lastElementChild;
              }
              if (
                !run ||
                field(e, ["genie_run_id", "data.genie_run_id"]) === run
              )
                finished = true;
            } else if (type === "skill.confirmation_required") {
              if (thinkingEl) {
                thinkingEl.remove();
                thinkingEl = null;
              }
              var callId = field(e, [
                "data.call_id",
                "call_id",
                "data.id",
                "payload.call_id",
              ]);
              var skill = field(e, [
                "data.skill_name",
                "data.skill",
                "skill_name",
                "data.name",
              ]);
              record(
                station,
                "confirm",
                "Dewy wants to run " + (skill || "a tool") + ". Approve?",
                { callId: callId, answered: false },
              );
              finished = true; // the turn pauses until the person answers
            } else if (type === "processing.finished") {
              if (thinkingEl) {
                thinkingEl.remove();
                thinkingEl = null;
              }
              finished = true;
            }
          });
          if (finished) {
            console.log("[chat] poll: close");
            console.log("[chat] stream complete");
            console.log(
              "[chat] complete (" +
                (Date.now() - started) +
                "ms, " +
                totalBytes +
                " total bytes)",
            );
            chatDone();
            return;
          }
          if (Date.now() - started > 120000) {
            if (thinkingEl) {
              thinkingEl.remove();
              thinkingEl = null;
            }
            record(station, "status", "No reply yet. Try again in a moment.");
            console.log(
              "[chat] complete (" +
                (Date.now() - started) +
                "ms, " +
                totalBytes +
                " total bytes)",
            );
            chatDone();
            return;
          }
          chat.polling = setTimeout(tick, 1200);
        })
        .catch(function (e) {
          console.error("[chat] error: " + e.message);
          if (thinkingEl) {
            thinkingEl.remove();
            thinkingEl = null;
          }
          if (partialBubble) {
            partialBubble.textContent += " ⚠ Response cut short";
          }
          msg($("chatMsg"), e.message, false);
          chatDone();
        });
    })();
  }

  function chatDone() {
    chat.busy = false;
    $("chatSend").disabled = false;
    var last = $("chatLog").lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function chatReset() {
    sessionStorage.removeItem("dewy_chat_transcripts");
    clearTimeout(chat.polling);
    chat = {
      configured: {},
      conversations: {},
      since: {},
      seen: {},
      polling: null,
      busy: false,
    };
    transcripts = {};
    chatStatusOnly("Pick a station and say hello.");
  }

  $("chatSend").onclick = chatSend;
  $("chatText").onkeydown = function (e) {
    if (e.key === "Enter") chatSend();
  };
  $("chatStation").onchange = function () {
    var station = $("chatStation").value;
    var msgs = (transcripts[station] || []).length;
    console.log(
      "[chat] switched to " + station + ", restored " + msgs + " messages",
    );
    chatRedraw();
  };
  $("chatClearBtn").onclick = function () {
    chatReset();
    chatLoad();
  };
  $("chatSetupToggle").onclick = function () {
    $("chatSetup").classList.toggle("hide");
  };
  $("chatSaveBlob").onclick = function () {
    var blob;
    try {
      blob = JSON.parse($("chatBlob").value);
    } catch (e) {
      msg(
        $("chatSetupMsg"),
        "That isn’t valid setup text: paste the whole block, including the braces.",
        false,
      );
      return;
    }
    msg($("chatSetupMsg"), "Saving…", true);
    api("PUT", "/me/genie-clients", blob)
      .then(function (r) {
        $("chatBlob").value = "";
        chat.configured = r.stations || {};
        msg($("chatSetupMsg"), "Saved ✓", true);
        hide($("chatSetup"));
        renderStations();
      })
      .catch(function (e) {
        msg($("chatSetupMsg"), e.message, false);
      });
  };

  // ---- boot ------------------------------------------------------------
  if (!cfg.userPoolClientId) {
    msg($("authMsg"), "Config not loaded (config.js missing).", false);
  } else if (idToken) {
    enterApp();
  }
})();
