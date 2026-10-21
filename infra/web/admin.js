/* Dewy Bank — Admin Console. Same Cognito login as the banking app; the
 * Customer API gates /admin/* on the `facilitators` group claim, so this
 * console carries NO static API key. All privileged actions are authenticated
 * admin calls, distinct from the intentionally-insecure x-api-key Admin API the
 * Workato Genies consume. */
(function () {
  var cfg = window.DEWY_CONFIG || {};
  var COGNITO = 'https://cognito-idp.' + cfg.region + '.amazonaws.com/';
  var API = (cfg.customerApiUrl || '').replace(/\/+$/, '');
  var idToken = sessionStorage.getItem('dewy_id_token') || null;

  var $ = function (id) { return document.getElementById(id); };
  function show(el) { el && el.classList.remove('hide'); }
  function hide(el) { el && el.classList.add('hide'); }
  function msg(el, text, ok) { el.innerHTML = text ? '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + text + '</div>' : ''; }
  function money(n) { var neg = n < 0; return (neg ? '−' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function cognito(action, body) {
    return fetch(COGNITO, { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.' + action }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || j.__type || 'Request failed'); return j; }); });
  }
  function login(email, pass) {
    return cognito('InitiateAuth', { ClientId: cfg.userPoolClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: pass } })
      .then(function (j) { var r = j.AuthenticationResult; if (!r || !r.IdToken) throw new Error('No token returned'); idToken = r.IdToken; sessionStorage.setItem('dewy_id_token', idToken); return r; });
  }
  function claims() { try { return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } }
  function isFacilitator() { var g = claims()['cognito:groups'] || []; if (typeof g === 'string') g = g.replace(/[\[\]]/g, '').split(/[,\s]+/); return (g || []).indexOf('facilitators') !== -1; }

  function api(method, path, body) {
    return fetch(API + path, { method: method, headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) {
        if (r.status === 401) { logout(); throw new Error('Session expired, log in again'); }
        if (r.status === 403) throw new Error('Forbidden — this account is not in the facilitators group.');
        if (!r.ok) throw new Error(j.message || 'Request failed'); return j;
      }); });
  }

  // ---- login flow ------------------------------------------------------
  $('loginBtn').onclick = function () {
    var email = $('email').value.trim(), pass = $('pass').value;
    msg($('loginMsg'), 'Signing in…', true);
    login(email, pass).then(function () {
      if (!isFacilitator()) { msg($('loginMsg'), 'This account is not in the facilitators group.', false); return; }
      enterConsole();
    }).catch(function (e) { msg($('loginMsg'), e.message, false); });
  };
  $('logout').onclick = function () { logout(); };
  function logout() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } idToken = null; sessionStorage.removeItem('dewy_id_token'); hide($('console')); show($('login')); }

  function enterConsole() {
    hide($('login')); show($('console'));
    var c = claims(); $('who').textContent = c.email || c['cognito:username'] || 'facilitator';
    $('liveToggle').onchange = function () { setLive($('liveToggle').checked); };
    loadAll();
    setLive(true);
  }

  // ---- live polling ----------------------------------------------------
  var pollTimer = null;
  function setLive(on) {
    $('liveDot').classList.toggle('off', !on);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (on) pollTimer = setInterval(function () { loadAll(true); }, 4000);
  }

  // ---- data ------------------------------------------------------------
  function loadAll(quiet) {
    api('GET', '/admin/overview').then(function (o) {
      $('stCustomers').textContent = o.customers;
      $('stAccounts').textContent = o.accounts;
      $('stTotal').textContent = money(o.totalBalance);
    }).catch(function (e) { if (!quiet) msg($('acctMsg'), e.message, false); });
    loadAccounts(quiet);
  }

  $('refresh').onclick = function () { loadAll(); };

  function loadAccounts(quiet) {
    if (!quiet) $('accounts').textContent = 'Loading…';
    api('GET', '/admin/accounts').then(function (res) {
      var accts = res.accounts || [];
      renderLeaderboard(accts);
      renderAccounts(accts);
    }).catch(function (e) { if (!quiet) $('accounts').innerHTML = '<div class="msg err">' + e.message + '</div>'; });
  }

  // ---- leaderboard -----------------------------------------------------
  var lastTotals = {}; // holder -> total, to detect movement
  function renderLeaderboard(accts) {
    if (!accts.length) { $('leaderboard').textContent = 'No account holders yet.'; return; }
    var totals = {}, counts = {};
    accts.forEach(function (a) {
      var k = a.email || a.customerId;
      totals[k] = (totals[k] || 0) + Number(a.balance || 0);
      counts[k] = (counts[k] || 0) + 1;
    });
    var holders = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var max = Math.max.apply(null, holders.map(function (h) { return Math.abs(totals[h]); }).concat([1]));
    var html = '<div class="lb">';
    holders.forEach(function (h, i) {
      var v = totals[h], prev = lastTotals[h];
      var delta = (prev !== undefined) ? (v - prev) : 0;
      var pct = Math.max(3, Math.round((Math.abs(v) / max) * 100));
      var flash = delta > 0.001 ? ' flash-up' : (delta < -0.001 ? ' flash-down' : '');
      var deltaHtml = Math.abs(delta) > 0.001
        ? '<div class="lb-delta ' + (delta > 0 ? 'up' : 'down') + '">' + (delta > 0 ? '▲ +' : '▼ −') + '$' + Math.abs(delta).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</div>'
        : '';
      html += '<div class="lb-row' + flash + '" data-h="' + encodeURIComponent(h) + '">' +
        '<div class="lb-rank">' + (i + 1) + '</div>' +
        '<div class="lb-name">' + h + '<div class="sub">' + counts[h] + ' account' + (counts[h] > 1 ? 's' : '') + '</div></div>' +
        '<div class="lb-bar"><div class="lb-fill" style="width:' + pct + '%"></div></div>' +
        '<div><div class="lb-amt' + (v < 0 ? ' neg' : '') + '">' + money(v) + '</div>' + deltaHtml + '</div>' +
        '</div>';
    });
    html += '</div>';
    $('leaderboard').innerHTML = html;
    lastTotals = totals;
    // clear the flash highlight after the animation so it only pulses on change
    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll('.lb-row'), function (r) {
        r.classList.remove('flash-up', 'flash-down');
      });
    }, 1500);
  }

  function renderAccounts(accts) {
    if (!accts.length) { $('accounts').textContent = 'No accounts yet. Have a customer sign up in the banking app.'; return; }
    // group by email/customer
    var groups = {};
    accts.forEach(function (a) { var k = a.email || a.customerId; (groups[k] = groups[k] || []).push(a); });
    var html = '<table><thead><tr><th>Account</th><th>Name</th><th>Balance</th><th>Actions</th></tr></thead><tbody>';
    Object.keys(groups).forEach(function (k) {
      html += '<tr class="cust-head"><td colspan="4">👤 ' + k + '</td></tr>';
      groups[k].forEach(function (a) {
        var neg = a.balance < 0;
        html += '<tr>' +
          '<td class="mono">' + a.accountId + '</td>' +
          '<td>' + a.name + '</td>' +
          '<td class="bal' + (neg ? ' neg' : '') + '">' + money(a.balance) + '</td>' +
          '<td><div class="acts">' +
            '<button class="ghost sm" data-act="credit" data-id="' + a.accountId + '">+$100</button>' +
            '<button class="ghost sm" data-act="debit" data-id="' + a.accountId + '">−$100</button>' +
            '<button class="ghost sm" data-act="set" data-id="' + a.accountId + '">Set…</button>' +
            '<button class="danger sm" data-act="reset" data-id="' + a.accountId + '">Reset $1000</button>' +
          '</div></td></tr>';
      });
    });
    html += '</tbody></table>';
    $('accounts').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () { doAct(b.dataset.act, b.dataset.id); };
    });
  }

  function doAct(act, id) {
    if (act === 'credit') return adjust(id, 100);
    if (act === 'debit') return adjust(id, -100);
    if (act === 'reset') return setBalance(id, 1000);
    if (act === 'set') {
      var v = prompt('Set balance for\n' + id + '\nto (USD):', '1000');
      if (v === null) return;
      var n = parseFloat(v); if (!isFinite(n)) { msg($('acctMsg'), 'Invalid amount', false); return; }
      return setBalance(id, n);
    }
  }
  function adjust(id, amount) {
    msg($('acctMsg'), 'Adjusting ' + id + '…', true);
    api('POST', '/admin/adjust-balance', { id: id, amount: amount })
      .then(function (r) { msg($('acctMsg'), 'Adjusted → ' + money(r.balance), true); loadAll(); })
      .catch(function (e) { msg($('acctMsg'), e.message, false); });
  }
  function setBalance(id, balance) {
    msg($('acctMsg'), 'Setting ' + id + '…', true);
    api('POST', '/admin/set-balance', { id: id, balance: balance })
      .then(function (r) { msg($('acctMsg'), 'Set → ' + money(r.balance), true); loadAll(); })
      .catch(function (e) { msg($('acctMsg'), e.message, false); });
  }

  // ---- facilitator transfer -------------------------------------------
  $('xBtn').onclick = function () {
    var from = $('xFrom').value.trim(), to = $('xTo').value.trim(), amount = parseFloat($('xAmt').value);
    if (!from || !to) { msg($('xMsg'), 'Both account IDs are required', false); return; }
    if (!(amount > 0)) { msg($('xMsg'), 'Enter a positive amount', false); return; }
    msg($('xMsg'), 'Sending…', true);
    api('POST', '/admin/transfer', { from: from, to: to, amount: amount })
      .then(function () { msg($('xMsg'), 'Transfer complete ✓', true); $('xAmt').value = ''; loadAll(); })
      .catch(function (e) { msg($('xMsg'), e.message, false); });
  };

  // ---- boot ------------------------------------------------------------
  if (!cfg.userPoolClientId) { msg($('loginMsg'), 'Config not loaded (config.js missing).', false); }
  else if (idToken && isFacilitator()) { enterConsole(); }
})();
