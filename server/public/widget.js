/* TrustDesk embeddable help widget.
 * <script src="https://your-trustdesk/widget.js" data-trustdesk="https://your-trustdesk" defer></script>
 * Uses only the public endpoints (/api/public/*): public, trusted documents; no staff data. */
(function () {
  var script = document.currentScript;
  var base = (script && script.getAttribute('data-trustdesk')) || '';
  var color = (script && script.getAttribute('data-color')) || '#4f46e5';
  var workspace = (script && script.getAttribute('data-workspace')) || '';
  var css = '.tdw-btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:' + color + ';color:#fff;font-size:24px;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.2);z-index:99999}' +
    '.tdw-panel{position:fixed;right:20px;bottom:88px;width:360px;max-height:70vh;display:none;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.2);overflow:hidden;font-family:system-ui,sans-serif;font-size:14px;z-index:99999;color:#151a2d}' +
    '.tdw-panel.open{display:flex}.tdw-h{background:' + color + ';color:#fff;padding:14px 16px;font-weight:600}.tdw-b{padding:12px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px}' +
    '.tdw-m{padding:8px 12px;border-radius:10px;line-height:1.5;max-width:90%}.tdw-u{align-self:flex-end;background:' + color + ';color:#fff}.tdw-a{background:#f3f4f8}.tdw-s{font-size:12px;color:#646b82}' +
    '.tdw-f{display:flex;gap:6px;padding:10px;border-top:1px solid #eee}.tdw-f input{flex:1;padding:8px 10px;border:1px solid #d5d9e4;border-radius:8px;font:inherit}.tdw-f button,.tdw-x{padding:6px 10px;border-radius:8px;border:1px solid #d5d9e4;background:#fff;cursor:pointer;font:inherit}' +
    '.tdw-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  var btn = document.createElement('button'); btn.className = 'tdw-btn'; btn.setAttribute('aria-label', 'Help'); btn.textContent = '?';
  var panel = document.createElement('div'); panel.className = 'tdw-panel';
  panel.innerHTML = '<div class="tdw-h">How can we help?</div><div class="tdw-b"></div><form class="tdw-f"><input placeholder="Ask a question…" /><button type="submit">Ask</button></form>';
  document.body.appendChild(btn); document.body.appendChild(panel);
  var body = panel.querySelector('.tdw-b'); var form = panel.querySelector('form'); var input = form.querySelector('input');
  btn.onclick = function () { panel.classList.toggle('open'); input.focus(); };
  function add(cls, text) { var d = document.createElement('div'); d.className = 'tdw-m ' + cls; d.textContent = text; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; }
  function post(path, data) { return fetch(base + path, { method: 'POST', headers: workspace ? { 'Content-Type': 'application/json', 'X-Workspace-Key': workspace } : { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(function (r) { return r.json(); }); }
  form.onsubmit = function (e) {
    e.preventDefault(); var q = input.value.trim(); if (!q) return; input.value = ''; add('tdw-u', q);
    var wait = add('tdw-a tdw-s', 'Looking that up…');
    post('/api/public/ask', { question: q }).then(function (r) {
      wait.remove(); var a = add('tdw-a', r.answer || 'Sorry, something went wrong.');
      if (r.citations && r.citations.length) { var s = document.createElement('div'); s.className = 'tdw-s'; s.textContent = 'Sources: ' + r.citations.map(function (c) { return '[' + c.n + '] ' + c.title; }).join(' · '); a.appendChild(s); }
      var row = document.createElement('div'); row.className = 'tdw-row';
      var yes = document.createElement('button'); yes.className = 'tdw-x'; yes.textContent = 'That solved it';
      var no = document.createElement('button'); no.className = 'tdw-x'; no.textContent = 'Contact support';
      yes.onclick = function () { post('/api/public/deflections/' + r.event_id + '/outcome', { resolved: true }); row.remove(); add('tdw-a tdw-s', 'Great — glad it helped!'); };
      no.onclick = function () {
        row.remove();
        var box = document.createElement('form'); box.className = 'tdw-row';
        box.innerHTML = '<input type="email" required placeholder="Your email so we can reply" style="flex:1;padding:6px 8px;border:1px solid #d5d9e4;border-radius:8px;font:inherit" /><button class="tdw-x" type="submit">Send</button>';
        a.appendChild(box); box.querySelector('input').focus();
        box.onsubmit = function (ev) {
          ev.preventDefault();
          var email = box.querySelector('input').value.trim(); if (!email) return;
          box.remove();
          post('/api/public/deflections/' + r.event_id + '/outcome', { resolved: false, email: email }).then(function (o) { add('tdw-a tdw-s', o.ticket_id ? 'Ticket ' + o.ticket_id + ' created — our team will follow up at ' + email + '.' : (o.detail || 'Could not create ticket')); });
        };
      };
      if (r.answered) row.appendChild(yes); row.appendChild(no); a.appendChild(row);
    }).catch(function () { wait.textContent = 'Network error — please try again.'; });
  };
})();
