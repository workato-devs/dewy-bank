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
  var accessToken = sessionStorage.getItem("dewy_access_token") || null;
  var refreshToken = sessionStorage.getItem("dewy_refresh_token") || null;

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
    el.textContent = "";
    if (text) {
      var div = document.createElement("div");
      div.className = "msg " + (ok ? "ok" : "err");
      div.textContent = text;
      el.appendChild(div);
    }
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
      accessToken = r.AccessToken;
      refreshToken = r.RefreshToken;
      sessionStorage.setItem("dewy_id_token", idToken);
      sessionStorage.setItem("dewy_access_token", accessToken);
      sessionStorage.setItem("dewy_refresh_token", refreshToken);
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
  // Returns true if the JWT is missing, malformed, or past its exp claim.
  function isTokenExpired(token) {
    try {
      var payload = JSON.parse(
        atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      return payload.exp * 1000 < Date.now();
    } catch (e) {
      return true; // treat malformed or missing tokens as expired
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

  // ---- No-body variant (for DELETE /payees which returns 204) ----------
  function apiNoBody(method, path) {
    return fetch(API + path, {
      method: method,
      headers: {
        authorization: "Bearer " + idToken,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
    }).then(function (r) {
      if (r.status === 204) return undefined;
      if (r.status === 401) {
        logout();
        throw new Error("Session expired, log in again");
      }
      return r.json().then(function (j) {
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
    window.WkChatWidget &&
      window.WkChatWidget.reset &&
      window.WkChatWidget.reset();
    idToken = null;
    accessToken = null;
    refreshToken = null;
    sessionStorage.removeItem("dewy_id_token");
    sessionStorage.removeItem("dewy_access_token");
    sessionStorage.removeItem("dewy_refresh_token");
    window.chatWidget.chatReset();
    hide($("appShell"));
    show($("authScreen"));
  }

  // ---- App -------------------------------------------------------------
  var accountsCache = [];
  var selectedAcct = null;

  var STATION_LABELS = {
    A1: "A1 · Station A, flaw",
    A2: "A2 · Station A, fix",
    B1: "B1 · Station B, flaw",
    B2: "B2 · Station B, fix",
    C1: "C1 · Station C, flaw",
    C2: "C2 · Station C, fix",
  };
  var _chatWidgetInited = false;

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
    loadPayees();
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
        $("accountCards").innerHTML = DOMPurify.sanitize(
          '<div class="msg err">' + esc(e.message) + "</div>",
        );
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
      $("accountCards").innerHTML = DOMPurify.sanitize(
        '<div class="card">No accounts yet.</div>',
      );
      return;
    }
    $("accountCards").innerHTML = DOMPurify.sanitize(
      accountsCache
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
            esc(money(a.balance)) +
            "</div>" +
            "</div>"
          );
        })
        .join(""),
    );
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
    var opts = DOMPurify.sanitize(
      accountsCache
        .map(function (a) {
          return (
            '<option value="' +
            esc(a.accountId) +
            '">' +
            esc(a.name) +
            " — " +
            esc(money(a.balance)) +
            "</option>"
          );
        })
        .join(""),
    );
    $("xferFrom").innerHTML = opts;
    $("xferTo").innerHTML = opts;
    if (accountsCache.length > 1) $("xferTo").selectedIndex = 1;
  }

  $("xferBtn").onclick = function () {
    var from = $("xferFrom").value,
      to = $("xferTo").value,
      amount = parseFloat($("xferAmt").value);
    var memo = $("xferMemo").value.trim();
    if (!(amount > 0)) {
      msg($("xferMsg"), "Enter a positive amount", false);
      return;
    }
    if (from === to) {
      msg($("xferMsg"), "Pick two different accounts", false);
      return;
    }
    msg($("xferMsg"), "Sending…", true);
    var body = { from: from, to: to, amount: amount };
    if (memo) body.memo = memo;
    api("POST", "/transfers", body)
      .then(function () {
        $("xferAmt").value = "";
        $("xferMemo").value = "";
        if (memo) {
          $("xferMsg").innerHTML = DOMPurify.sanitize(
            '<div class="msg ok">Transfer complete \u2713 \u00b7 \u201c' +
              esc(memo) +
              "\u201d</div>",
          );
        } else {
          msg($("xferMsg"), "Transfer complete \u2713", true);
        }
        loadAccounts();
      })
      .catch(function (e) {
        msg($("xferMsg"), e.message, false);
      });
  };

  $("payeeAddBtn").onclick = function () {
    var email = $("payeeEmail").value.trim();
    if (!email) {
      msg($("payeesMsg"), "Enter an email address", false);
      return;
    }
    api("POST", "/payees", { email: email })
      .then(function () {
        $("payeeEmail").value = "";
        msg($("payeesMsg"), "Added " + email, true);
        loadPayees();
      })
      .catch(function (e) {
        msg($("payeesMsg"), e.message, false);
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
        $("txns").innerHTML = DOMPurify.sanitize(
          '<div class="msg err">' + esc(e.message) + "</div>",
        );
      });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date((iso || "").split("#")[0]);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function fmtPayeeDate(iso) {
    if (!iso) return "";
    var d = new Date((iso || "").split("#")[0]);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
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
        esc(money(t.amount, { sign: credit })) +
        "</td></tr>";
    });
    html += "</tbody></table>";
    $("txns").innerHTML = DOMPurify.sanitize(html);
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
    $("spend").innerHTML = DOMPurify.sanitize(
      cats
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
            esc(money(by[c])) +
            "</div></div>"
          );
        })
        .join(""),
    );
  }

  // ---- Payees panel (P11) ----------------------------------------------
  function loadPayees() {
    api("GET", "/payees")
      .then(function (res) {
        renderPayees(res.payees || []);
      })
      .catch(function (e) {
        $("payeesList").innerHTML = DOMPurify.sanitize(
          '<div class="msg err">' + esc(e.message) + "</div>",
        );
      });
  }

  function renderPayees(payees) {
    var list = $("payeesList");
    if (!payees.length) {
      list.innerHTML = DOMPurify.sanitize(
        '<p style="color:var(--muted);font-size:14px;margin:0">No saved payees yet.</p>',
      );
      return;
    }
    var html =
      "<table><thead><tr>" +
      "<th>Email</th><th>Added</th><th></th>" +
      "</tr></thead><tbody>";
    payees.forEach(function (p) {
      html +=
        "<tr>" +
        "<td>" +
        esc(p.email) +
        "</td>" +
        "<td>" +
        esc(fmtPayeeDate(p.addedAt)) +
        "</td>" +
        '<td style="width:80px"><button class="ghost" style="padding:5px 10px;font-size:12px" data-email="' +
        esc(p.email) +
        '">Remove</button></td>' +
        "</tr>";
    });
    html += "</tbody></table>";
    list.innerHTML = DOMPurify.sanitize(html);
    Array.prototype.forEach.call(
      list.querySelectorAll("button[data-email]"),
      function (btn) {
        btn.onclick = function () {
          var email = btn.dataset.email;
          apiNoBody("DELETE", "/payees/" + encodeURIComponent(email))
            .then(function () {
              loadPayees();
            })
            .catch(function (e) {
              msg($("payeesMsg"), e.message, false);
            });
        };
      },
    );
  }

  function chatLoad() {
    window.chatWidget.init(function () {
      return idToken;
    }, cfg.chatFunctionUrl);
    window.chatWidget.chatLoad();
  }

  // ---- boot ------------------------------------------------------------
  if (!cfg.userPoolClientId) {
    msg($("authMsg"), "Config not loaded (config.js missing).", false);
  } else if (idToken && !isTokenExpired(idToken)) {
    // Branch 1: idToken present and still valid — restore immediately.
    console.log("[auth] restored session from storage");
    enterApp();
  } else if (idToken && refreshToken) {
    // Branch 2: idToken expired but we have a refresh token — try a silent refresh.
    console.log("[auth] token expired, refreshing");
    cognito("InitiateAuth", {
      ClientId: cfg.userPoolClientId,
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
      .then(function (j) {
        var r = j.AuthenticationResult;
        if (!r || !r.IdToken) throw new Error("No token returned");
        idToken = r.IdToken;
        accessToken = r.AccessToken;
        // Cognito's REFRESH_TOKEN_AUTH does not issue a new RefreshToken;
        // keep the existing one (refreshToken variable is unchanged).
        sessionStorage.setItem("dewy_id_token", idToken);
        sessionStorage.setItem("dewy_access_token", accessToken);
        enterApp();
      })
      .catch(function () {
        console.log("[auth] refresh failed, redirecting to login");
        idToken = null;
        accessToken = null;
        refreshToken = null;
        sessionStorage.removeItem("dewy_id_token");
        sessionStorage.removeItem("dewy_access_token");
        sessionStorage.removeItem("dewy_refresh_token");
      });
  } else if (idToken) {
    // Branch 3: idToken expired and no refresh token — clear the stale id token.
    console.log("[auth] token expired, no refresh token available");
    idToken = null;
    accessToken = null;
    sessionStorage.removeItem("dewy_id_token");
    sessionStorage.removeItem("dewy_access_token");
  }
  // If none of the branches fire, idToken was null to begin with → login screen shown.
})();
