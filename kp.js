(function () {
  "use strict";

  // ---- Configuration (public values only; no private data belongs in this file) ----
  var KP_CONFIG = {
    rsvpEndpoint: "/api/kp-rsvp",
    // FetLife profile URL — fill in / change here later. Leave "" to hide the link.
    fetlifeUrl: "https://fetlife.com/KingPenthouse",
    maxUpcoming: 4,
    halloweenSlug: "oct31-halloween"
  };

  // ?source= values accepted from flyer / QR links -> "How did you find us" preselect.
  // The server re-validates against its own whitelist; this is only a convenience.
  var SOURCE_TO_FOUND = {
    sexshow: "sexshow", sugardaddys: "sugardaddys", flyer: "flyer",
    fetlife: "fetlife", instagram: "social", social: "social", friend: "friend", web: "web"
  };
  var VALID_SOURCES = Object.keys(SOURCE_TO_FOUND);

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var rawSource = (params.get("source") || "").toLowerCase().slice(0, 30);
  var source = VALID_SOURCES.indexOf(rawSource) !== -1 ? rawSource : "";

  // ---- FetLife link ----
  var fl = $("fetlife-link");
  if (KP_CONFIG.fetlifeUrl && /^https:\/\//.test(KP_CONFIG.fetlifeUrl)) {
    fl.href = KP_CONFIG.fetlifeUrl;
    fl.hidden = false;
  }

  // ---- Upcoming events (from the site's existing events.js; text only, built with textContent) ----
  (function renderEvents() {
    var list = window.KP_EVENTS;
    if (!Array.isArray(list)) return;
    var cutoff = new Date(); cutoff.setHours(cutoff.getHours() - 6);
    var upcoming = list
      .filter(function (e) { return (e.status || "active") === "active" && e.slug !== KP_CONFIG.halloweenSlug; })
      .filter(function (e) { var t = Date.parse(e.date + "T23:59:59"); return !t || t >= cutoff; })
      .sort(function (a, b) { return (Date.parse(a.date) || Infinity) - (Date.parse(b.date) || Infinity); })
      .slice(0, KP_CONFIG.maxUpcoming);
    if (!upcoming.length) return;
    var box = $("event-list");
    upcoming.forEach(function (e) {
      var a = document.createElement("a");
      a.className = "event";
      a.href = "#request";
      a.setAttribute("data-prefill-event", "saturday");
      var n = document.createElement("span"); n.className = "event-name"; n.textContent = e.name || "";
      var d = document.createElement("span"); d.className = "event-date";
      d.textContent = [e.dateLabel, e.time].filter(Boolean).join(" · ");
      a.appendChild(n); a.appendChild(d); box.appendChild(a);
    });
    $("events").hidden = false;
  })();

  // ---- Prefill from CTA buttons / source param ----
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest && ev.target.closest("[data-prefill-event]");
    if (t) $("f-event").value = t.getAttribute("data-prefill-event");
  });
  if (source) $("f-found").value = SOURCE_TO_FOUND[source];

  // ---- Turnstile (only if the server reports a site key) ----
  var turnstileToken = "";
  var turnstileWidget = null;
  var turnstileOn = false;
  fetch(KP_CONFIG.rsvpEndpoint, { method: "GET", headers: { Accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg || !cfg.turnstileSiteKey) return;
      turnstileOn = true;
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.defer = true;
      s.onload = function () {
        if (!window.turnstile) return;
        turnstileWidget = window.turnstile.render("#turnstile-box", {
          sitekey: cfg.turnstileSiteKey,
          theme: "dark",
          callback: function (tok) { turnstileToken = tok; },
          "expired-callback": function () { turnstileToken = ""; },
          "error-callback": function () { turnstileToken = ""; }
        });
      };
      document.head.appendChild(s);
    })
    .catch(function () { /* config is optional */ });

  // ---- Form ----
  var form = $("kp-form");
  var errBox = $("form-error");
  var btn = $("submit-btn");
  var GENERIC = "We couldn't send your request. Please check your details and try again.";

  function showError(msg) { errBox.textContent = msg; errBox.hidden = false; }
  function clearError() { errBox.hidden = true; errBox.textContent = ""; }

  function clientValidate(v) {
    if (!v.name) return "Please enter your name or alias.";
    var age = parseInt(v.age, 10);
    if (!(age >= 19)) return "You must be at least 19 years old.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return "Please enter a valid email address.";
    if (!v.guestType || !v.event || !v.foundVia) return "Please complete all required fields.";
    if (!v.ageConfirmed) return "Please confirm that you are at least 19 years old.";
    if (turnstileOn && !turnstileToken) return "Please complete the verification check.";
    return "";
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    clearError();
    var payload = {
      name: $("f-name").value.trim(),
      age: $("f-age").value.trim(),
      email: $("f-email").value.trim(),
      guestType: $("f-guest").value,
      event: $("f-event").value,
      fetlife: $("f-fetlife").value.trim(),
      foundVia: $("f-found").value,
      message: $("f-message").value.trim(),
      ageConfirmed: $("f-age-confirm").checked,
      website: $("f-website").value, // honeypot
      source: source,
      turnstileToken: turnstileToken
    };
    var problem = clientValidate(payload);
    if (problem) { showError(problem); return; }

    btn.disabled = true;
    btn.textContent = "SENDING…";
    fetch(KP_CONFIG.rsvpEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j.ok === true, status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          var s = $("success"); s.hidden = false; s.focus();
          s.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        showError(res.status === 429 ? "Too many requests. Please try again later." : GENERIC);
        resetBtn();
      })
      .catch(function () { showError(GENERIC); resetBtn(); });
  });

  function resetBtn() {
    btn.disabled = false;
    btn.textContent = "REQUEST VERIFICATION + EVENT DETAILS";
    turnstileToken = "";
    if (turnstileWidget !== null && window.turnstile) { try { window.turnstile.reset(turnstileWidget); } catch (e) {} }
  }
})();
