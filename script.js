(function () {
  "use strict";

  const MEALS = ["breakfast", "lunch", "dinner"];
  const MEAL_LABEL = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
  const MEAL_EMOJI = { breakfast: "🌅", lunch: "🍛", dinner: "🌙" };

  // Shared PIN for this household's copy of the app. Since GitHub Pages
  // requires a public repo, this only screens out casual visitors — anyone
  // who views the page source can read it. Not real security.
  const ADMIN_PIN = "7352";

  // Pre-filled so a phone opening this page for the first time syncs
  // immediately without needing the URL/token typed in by hand. Still
  // overridable from the Sync Settings panel.
  const DEFAULT_SYNC_URL = "https://script.google.com/macros/s/AKfycbwPXiQFBokBweoNq2QR7_rslSAg1RWyQ35eI9HOYl4DvYb3SVyh4uG-7IysUbPs_p6f6Q/exec";
  const DEFAULT_SYNC_TOKEN = "RknxZu9OHyZNWfYbSLPWLcyI769RN6a2";

  // Entries logged before tiffin services existed belong to this service.
  // Must match DEFAULT_SERVICE_ID in apps-script/Code.gs.
  const DEFAULT_SERVICE_ID = "s1";

  const STORE_KEYS = {
    people: "tiffin_people",
    prices: "tiffin_prices", // legacy: single global price list, migrated into services
    services: "tiffin_services",
    lastService: "tiffin_last_service",
    entries: "tiffin_entries",
    syncUrl: "tiffin_sync_url",
    syncToken: "tiffin_sync_token",
    authed: "tiffin_authed"
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function isAdmin() {
    return load(STORE_KEYS.authed, false);
  }

  function applyAuthVisibility() {
    document.body.classList.toggle("is-admin", isAdmin());
  }

  // Older data (and older servers) keep meals directly on the day, with no
  // service. Wrap those into the default service so everything downstream
  // only deals with the byService shape.
  function normalizeEntries(raw) {
    const out = {};
    Object.keys(raw || {}).forEach((date) => {
      const day = raw[date] || {};
      let byService = day.byService;
      if (!byService) {
        const legacy = {};
        MEALS.forEach((m) => { legacy[m] = day[m] || {}; });
        const hasAny = MEALS.some((m) => Object.keys(legacy[m]).length > 0);
        byService = hasAny ? { [DEFAULT_SERVICE_ID]: legacy } : {};
      }
      const clean = { byService };
      if (day.note) clean.note = day.note;
      if (Object.keys(byService).length || clean.note) out[date] = clean;
    });
    return out;
  }

  let people = load(STORE_KEYS.people, []);
  // services: [{ id, name, prices: { breakfast, lunch, dinner } }]
  let services = load(STORE_KEYS.services, null) || [{
    id: DEFAULT_SERVICE_ID,
    name: "Tiffin 1",
    prices: load(STORE_KEYS.prices, { breakfast: 0, lunch: 0, dinner: 0 })
  }];
  // entries: { "YYYY-MM-DD": { note?, byService: { [serviceId]: { breakfast: {name: qty}, lunch: {...}, dinner: {...} } } } }
  let entries = normalizeEntries(load(STORE_KEYS.entries, {}));
  let syncUrl = load(STORE_KEYS.syncUrl, DEFAULT_SYNC_URL);
  let syncToken = load(STORE_KEYS.syncToken, DEFAULT_SYNC_TOKEN);

  function persistAll() {
    save(STORE_KEYS.people, people);
    save(STORE_KEYS.services, services);
    save(STORE_KEYS.entries, entries);
  }

  function serviceById(id) { return services.find((s) => s.id === id); }
  function serviceName(id) { const s = serviceById(id); return s ? s.name : "Removed service"; }
  function servicePrice(id, meal) {
    const s = serviceById(id);
    return s ? Number(s.prices && s.prices[meal]) || 0 : 0;
  }
  function newServiceId() {
    return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }
  function serviceHasEntries(id) {
    return Object.keys(entries).some((d) => entries[d].byService && entries[d].byService[id]);
  }

  // Merge a server response into local state (shared by sync and push).
  function applyRemote(data) {
    if (data.people) people = data.people;
    if (Array.isArray(data.services) && data.services.length) {
      services = data.services;
    } else if (data.prices) {
      // Older backend without services: its single price list is the default service's.
      const def = serviceById(DEFAULT_SERVICE_ID);
      if (def) def.prices = data.prices;
    }
    if (data.entries) entries = normalizeEntries(data.entries);
    persistAll();
    refreshActiveTab();
  }

  // ---------- REMOTE SYNC (Google Apps Script Web App) ----------
  const syncStatusEl = document.getElementById("sync-status");

  function setSyncStatus(text, isError) {
    if (syncStatusEl) {
      syncStatusEl.textContent = text;
      syncStatusEl.style.color = isError ? "var(--danger)" : "var(--success)";
    }
    const globalEl = document.getElementById("global-status");
    if (globalEl) {
      globalEl.textContent = text;
      globalEl.style.color = isError ? "#ffd9cf" : "rgba(255,255,255,0.85)";
    }
  }

  // Apps Script Web Apps don't send CORS headers, so a cross-origin fetch()
  // GET gets blocked by the browser. JSONP (loading the response as a
  // <script> tag) sidesteps that, since script loading isn't subject to CORS.
  function jsonpRequest(url) {
    return new Promise((resolve, reject) => {
      const cbName = "tiffinCb" + Date.now() + Math.floor(Math.random() * 100000);
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Sync request timed out"));
      }, 15000);
      function cleanup() {
        delete window[cbName];
        script.remove();
        clearTimeout(timer);
      }
      window[cbName] = (data) => {
        cleanup();
        resolve(data);
      };
      script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cbName;
      script.onerror = () => {
        cleanup();
        reject(new Error("Failed to reach sync sheet"));
      };
      document.body.appendChild(script);
    });
  }

  async function remoteGetAll() {
    const url = syncUrl + (syncUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(syncToken || "");
    const data = await jsonpRequest(url);
    if (data.error) throw new Error(data.error);
    return data;
  }

  // For the same CORS reason, we can't read a POST's response either. We
  // send it as a "simple" cross-origin request (which Apps Script does
  // receive and process even though we can't read the reply), then re-fetch
  // the canonical state via remoteGetAll() to confirm and reconcile.
  async function remotePost(action, payload) {
    await fetch(syncUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: syncToken, action, payload })
    });
    return remoteGetAll();
  }

  function refreshActiveTab() {
    const activeTab = document.querySelector(".tab-btn.active");
    if (!activeTab) return;
    const tab = activeTab.dataset.tab;
    if (tab === "log") renderLog();
    else if (tab === "weekly") renderWeekly();
    else if (tab === "monthly") renderMonthly();
    else if (tab === "people") renderPeople();
    else if (tab === "entry") renderEntrySummary();
  }

  async function syncFromRemote(showStatus) {
    if (!syncUrl) return;
    if (showStatus) setSyncStatus("Syncing…", false);
    try {
      applyRemote(await remoteGetAll());
      if (showStatus) setSyncStatus("Synced with Google Sheet.", false);
    } catch (err) {
      if (showStatus) setSyncStatus("Could not reach the sheet — showing last saved data.", true);
    }
  }

  async function pushToRemote(action, payload) {
    if (!syncUrl) return;
    try {
      applyRemote(await remotePost(action, payload));
      setSyncStatus("Synced with Google Sheet.", false);
    } catch (err) {
      setSyncStatus("Saved on this device, but sync to the sheet failed. Check your connection.", true);
    }
  }

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function fmtMoney(n) {
    return "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");
  }

  function fmtDateNice(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }

  // ---------- TAB NAVIGATION ----------
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "log") renderLog();
      if (btn.dataset.tab === "weekly") renderWeekly();
      if (btn.dataset.tab === "monthly") renderMonthly();
      if (btn.dataset.tab === "people") renderPeople();
      if (btn.dataset.tab === "entry") renderEntrySummary();
      if (btn.dataset.tab === "login") resetPin();
    });
  });

  // ---------- ENTRY SUMMARY (Daily Entry tab) ----------
  const entryDateInput = document.getElementById("entry-date");
  const entrySummaryEl = document.getElementById("entry-summary");
  const entryStatus = document.getElementById("entry-status");

  entryDateInput.value = todayStr();

  function buildDaySummaryHtml(dayData) {
    const byService = dayData.byService || {};
    const showTags = services.length > 1;
    let html = "";
    // Same order as the services list, so editing one service doesn't make
    // its block jump around.
    const order = (id) => { const i = services.findIndex((s) => s.id === id); return i < 0 ? services.length : i; };
    Object.keys(byService).sort((a, b) => order(a) - order(b)).forEach((sid) => {
      const block = byService[sid];
      const lines = MEALS.map((meal) => {
        const mealEntries = block[meal] || {};
        const namesWithQty = Object.keys(mealEntries).filter((n) => mealEntries[n] > 0);
        if (namesWithQty.length === 0) return "";
        const tag = `<span class="meal-tag ${meal}">${MEAL_LABEL[meal]}</span>`;
        const parts = namesWithQty.map((n) => `${esc(n)}: ${mealEntries[n]}`).join(", ");
        return `<div class="day-line">${tag}${parts}</div>`;
      }).join("");
      if (!lines) return;
      html += (showTags ? `<div><span class="svc-tag">${esc(serviceName(sid))}</span></div>` : "") + lines;
    });
    if (dayData.note) html += `<div class="summary-note">📝 ${esc(dayData.note)}</div>`;
    return html;
  }

  function renderEntrySummary() {
    entryStatus.textContent = "";
    const date = entryDateInput.value || todayStr();
    const dayData = entries[date];

    if (!dayData) {
      entrySummaryEl.innerHTML = `<p class="empty-msg">Nothing logged for ${fmtDateNice(date)} yet.</p>`;
      return;
    }

    const html = buildDaySummaryHtml(dayData);
    entrySummaryEl.innerHTML = html
      ? `<div class="summary-card">${html}</div>`
      : `<p class="empty-msg">Nothing logged for ${fmtDateNice(date)} yet.</p>`;
  }

  entryDateInput.addEventListener("change", renderEntrySummary);

  // ---------- ADD / EDIT TIFFINS MODAL ----------
  const modalOverlay = document.getElementById("add-modal-overlay");
  const modalDateInput = document.getElementById("modal-date");
  const modalPersonList = document.getElementById("modal-person-list");
  const modalNoteInput = document.getElementById("modal-note");
  const modalServiceSection = document.getElementById("modal-service-section");
  const modalServiceChips = document.getElementById("modal-service-chips");
  const modalServiceHint = document.getElementById("modal-service-hint");
  let modalServiceId = null;

  function serviceBlock(date, sid) {
    const day = entries[date];
    return (day && day.byService && day.byService[sid]) || {};
  }

  function buildModalServiceChips() {
    const date = modalDateInput.value || todayStr();
    // With a single service there is nothing to choose.
    modalServiceSection.hidden = services.length < 2;
    modalServiceChips.innerHTML = "";
    services.forEach((svc) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (svc.id === modalServiceId ? " selected" : "");
      if (entries[date] && entries[date].byService && entries[date].byService[svc.id]) chip.classList.add("has-data");
      chip.textContent = svc.name;
      chip.addEventListener("click", () => {
        modalServiceId = svc.id;
        buildModalServiceChips();
        buildModalPersonList();
      });
      modalServiceChips.appendChild(chip);
    });
    modalServiceHint.textContent = MEALS
      .map((m) => `${MEAL_LABEL[m]} ${fmtMoney(servicePrice(modalServiceId, m))}`)
      .join(" · ");
  }

  function buildModalPersonList() {
    modalPersonList.innerHTML = "";

    if (people.length === 0) {
      modalPersonList.innerHTML =
        '<p class="empty-msg">Add at least one person under "People &amp; Prices" first.</p>';
      return;
    }

    const date = modalDateInput.value || todayStr();
    const dayData = serviceBlock(date, modalServiceId);

    people.forEach((person) => {
      const hasExisting = MEALS.some((meal) => dayData[meal] && dayData[meal][person] > 0);

      const row = document.createElement("div");
      row.className = "person-toggle-row";

      const checkboxRow = document.createElement("label");
      checkboxRow.className = "checkbox-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.personToggle = person;
      checkbox.checked = hasExisting;
      const nameSpan = document.createElement("span");
      nameSpan.textContent = person;
      checkboxRow.appendChild(checkbox);
      checkboxRow.appendChild(nameSpan);

      const grid = document.createElement("div");
      grid.className = "meal-qty-grid";
      grid.dataset.personGrid = person;
      if (!hasExisting) grid.hidden = true;

      MEALS.forEach((meal) => {
        const cell = document.createElement("div");
        cell.className = "meal-qty-cell";
        const label = document.createElement("span");
        label.textContent = `${MEAL_EMOJI[meal]} ${MEAL_LABEL[meal]}`;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.dataset.meal = meal;
        input.dataset.person = person;
        const existing = dayData[meal] && dayData[meal][person];
        input.value = existing || "";
        input.placeholder = "0";
        cell.appendChild(label);
        cell.appendChild(input);
        grid.appendChild(cell);
      });

      checkbox.addEventListener("change", () => {
        grid.hidden = !checkbox.checked;
      });

      row.appendChild(checkboxRow);
      row.appendChild(grid);
      modalPersonList.appendChild(row);
    });
  }

  function openModal() {
    modalDateInput.value = entryDateInput.value || todayStr();
    modalNoteInput.value = (entries[modalDateInput.value] && entries[modalDateInput.value].note) || "";
    const last = load(STORE_KEYS.lastService, null);
    modalServiceId = serviceById(last) ? last : services[0].id;
    buildModalServiceChips();
    buildModalPersonList();
    modalOverlay.classList.add("open");
  }

  function closeModal() {
    modalOverlay.classList.remove("open");
  }

  document.getElementById("open-add-modal-btn").addEventListener("click", openModal);
  document.getElementById("close-modal-btn").addEventListener("click", closeModal);
  document.getElementById("modal-cancel-btn").addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay.classList.contains("open")) closeModal();
  });

  modalDateInput.addEventListener("change", () => {
    modalNoteInput.value = (entries[modalDateInput.value] && entries[modalDateInput.value].note) || "";
    buildModalServiceChips();
    buildModalPersonList();
  });

  document.getElementById("modal-save-btn").addEventListener("click", () => {
    const date = modalDateInput.value || todayStr();
    const sid = modalServiceId;
    const meals = { breakfast: {}, lunch: {}, dinner: {} };
    let anyValue = false;

    modalPersonList.querySelectorAll('input[data-person-toggle]').forEach((checkbox) => {
      if (!checkbox.checked) return;
      const person = checkbox.dataset.personToggle;
      const grid = modalPersonList.querySelector(`[data-person-grid="${CSS.escape(person)}"]`);
      grid.querySelectorAll("input[data-meal]").forEach((inp) => {
        const qty = parseInt(inp.value, 10);
        if (!isNaN(qty) && qty > 0) {
          meals[inp.dataset.meal][person] = qty;
          anyValue = true;
        }
      });
    });

    const note = modalNoteInput.value.trim();

    // Saving replaces only this service's tiffins for the day; the other
    // service's tiffins stay as they were. The note belongs to the whole day.
    const day = entries[date] || { byService: {} };
    if (anyValue) day.byService[sid] = meals;
    else delete day.byService[sid];
    if (note) day.note = note;
    else delete day.note;
    if (Object.keys(day.byService).length || day.note) entries[date] = day;
    else delete entries[date];
    save(STORE_KEYS.lastService, sid);
    persistAll();

    closeModal();
    entryDateInput.value = date;
    renderEntrySummary();

    entryStatus.textContent = `Saved entry for ${fmtDateNice(date)}.`;
    setTimeout(() => (entryStatus.textContent = ""), 2500);

    pushToRemote("saveDay", { date, serviceId: sid, meals, note });
  });

  document.getElementById("sync-now-entry-btn").addEventListener("click", () => {
    if (!syncUrl) {
      setSyncStatus("No sync set up on this device yet.", true);
      return;
    }
    syncFromRemote(true);
  });

  // ---------- LOG ----------
  function renderLog() {
    const wrap = document.getElementById("log-table-wrap");
    const dates = Object.keys(entries).sort((a, b) => (a < b ? 1 : -1));

    if (dates.length === 0) {
      wrap.innerHTML = '<p class="empty-msg">No entries yet.</p>';
      return;
    }

    wrap.innerHTML = "";
    dates.forEach((date) => {
      const dayData = entries[date];
      const card = document.createElement("div");
      card.className = "day-card";

      const header = document.createElement("div");
      header.className = "day-card-header";
      header.innerHTML = `<strong>${fmtDateNice(date)}</strong>`;

      if (isAdmin()) {
        const delBtn = document.createElement("button");
        delBtn.className = "delete-day-btn";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => {
          if (confirm(`Delete all entries for ${fmtDateNice(date)}?`)) {
            delete entries[date];
            persistAll();
            renderLog();
            pushToRemote("deleteDay", { date });
          }
        });
        header.appendChild(delBtn);
      }
      card.appendChild(header);
      card.insertAdjacentHTML("beforeend", buildDaySummaryHtml(dayData));

      wrap.appendChild(card);
    });
  }

  // ---------- WEEKLY ----------
  const weekPick = document.getElementById("week-pick");
  weekPick.value = todayStr();

  function getWeekRange(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDay(); // 0 = Sunday
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { start: monday, end: sunday };
  }

  function dateInRangeStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function summarize(datesInRange) {
    // Per person and per service: meal counts plus cost, where each tiffin is
    // priced by the service it came from.
    const blank = () => ({ breakfast: 0, lunch: 0, dinner: 0, cost: 0 });
    const summary = {};
    const bySvc = {};
    people.forEach((p) => { summary[p] = blank(); });

    datesInRange.forEach((date) => {
      const day = entries[date];
      if (!day || !day.byService) return;
      Object.keys(day.byService).forEach((sid) => {
        const block = day.byService[sid];
        if (!bySvc[sid]) bySvc[sid] = blank();
        MEALS.forEach((meal) => {
          const mealEntries = block[meal] || {};
          Object.keys(mealEntries).forEach((person) => {
            const qty = mealEntries[person];
            const cost = qty * servicePrice(sid, meal);
            if (!summary[person]) summary[person] = blank();
            summary[person][meal] += qty;
            summary[person].cost += cost;
            bySvc[sid][meal] += qty;
            bySvc[sid].cost += cost;
          });
        });
      });
    });

    const grand = blank();
    Object.keys(summary).forEach((person) => {
      const s = summary[person];
      s.totalQty = s.breakfast + s.lunch + s.dinner;
      grand.breakfast += s.breakfast;
      grand.lunch += s.lunch;
      grand.dinner += s.dinner;
      grand.cost += s.cost;
    });
    Object.keys(bySvc).forEach((sid) => {
      bySvc[sid].totalQty = bySvc[sid].breakfast + bySvc[sid].lunch + bySvc[sid].dinner;
    });

    return { summary, grand, bySvc };
  }

  function buildSummaryTable(summary, grand, bySvc) {
    const names = Object.keys(summary).filter((n) => people.includes(n) || summary[n].totalQty > 0);
    if (names.length === 0) {
      return '<p class="empty-msg">No tiffins recorded in this period.</p>';
    }

    let html = "<table><thead><tr><th>Person</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>Total</th><th>Cost</th></tr></thead><tbody>";
    names.forEach((name) => {
      const s = summary[name];
      html += `<tr><td>${esc(name)}</td><td>${s.breakfast}</td><td>${s.lunch}</td><td>${s.dinner}</td><td>${s.totalQty}</td><td>${fmtMoney(s.cost)}</td></tr>`;
    });
    html += `</tbody><tfoot><tr><td>Total</td><td>${grand.breakfast}</td><td>${grand.lunch}</td><td>${grand.dinner}</td><td>${grand.breakfast + grand.lunch + grand.dinner}</td><td>${fmtMoney(grand.cost)}</td></tr></tfoot></table>`;

    // What each provider is owed for the period.
    if (services.length > 1) {
      const ids = Object.keys(bySvc).sort((a, b) => services.findIndex((s) => s.id === a) - services.findIndex((s) => s.id === b));
      if (ids.length) {
        html += '<div class="section-subtitle">By tiffin service</div><table><thead><tr><th>Service</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>Total</th><th>Cost</th></tr></thead><tbody>';
        ids.forEach((sid) => {
          const s = bySvc[sid];
          html += `<tr><td>${esc(serviceName(sid))}</td><td>${s.breakfast}</td><td>${s.lunch}</td><td>${s.dinner}</td><td>${s.totalQty}</td><td>${fmtMoney(s.cost)}</td></tr>`;
        });
        html += "</tbody></table>";
      }
    }
    return html;
  }

  function renderWeekly() {
    const pickDate = weekPick.value || todayStr();
    const { start, end } = getWeekRange(pickDate);

    const rangeLabel = document.getElementById("weekly-range");
    rangeLabel.textContent = `Week: ${start.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

    const dates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      dates.push(dateInRangeStr(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    const { summary, grand, bySvc } = summarize(dates);
    document.getElementById("weekly-table-wrap").innerHTML = buildSummaryTable(summary, grand, bySvc);
  }

  weekPick.addEventListener("change", renderWeekly);

  // ---------- MONTHLY ----------
  const monthPick = document.getElementById("month-pick");
  monthPick.value = todayStr().slice(0, 7);

  function renderMonthly() {
    const val = monthPick.value || todayStr().slice(0, 7); // "YYYY-MM"
    const [year, month] = val.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();

    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
      dates.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }

    const { summary, grand, bySvc } = summarize(dates);
    document.getElementById("monthly-table-wrap").innerHTML = buildSummaryTable(summary, grand, bySvc);
  }

  monthPick.addEventListener("change", renderMonthly);

  // ---------- PEOPLE & PRICES ----------
  function renderPeople() {
    const list = document.getElementById("people-list");
    list.innerHTML = "";
    if (people.length === 0) {
      list.innerHTML = '<li style="justify-content:center;color:var(--ink-soft);font-style:italic;">No people added yet.</li>';
    }
    people.forEach((name) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = name;
      const btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.addEventListener("click", () => {
        if (confirm(`Remove ${name}? Past logged entries for them are kept but they'll no longer appear in the entry form.`)) {
          people = people.filter((p) => p !== name);
          persistAll();
          renderPeople();
          pushToRemote("removePerson", { name });
        }
      });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });

    renderServices();
  }

  // ---------- TIFFIN SERVICES ----------
  const servicesListEl = document.getElementById("services-list");

  function renderServices() {
    servicesListEl.innerHTML = "";
    services.forEach((svc) => {
      const card = document.createElement("div");
      card.className = "service-card";
      card.dataset.serviceId = svc.id;

      const head = document.createElement("div");
      head.className = "service-card-head";
      const name = document.createElement("span");
      name.textContent = svc.name;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => removeService(svc.id));
      head.appendChild(name);
      head.appendChild(removeBtn);

      const grid = document.createElement("div");
      grid.className = "service-prices";
      MEALS.forEach((meal) => {
        const label = document.createElement("label");
        label.textContent = `${MEAL_EMOJI[meal]} ${MEAL_LABEL[meal]} ₹`;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "0.5";
        input.dataset.meal = meal;
        input.value = (svc.prices && svc.prices[meal]) || 0;
        label.appendChild(input);
        grid.appendChild(label);
      });

      card.appendChild(head);
      card.appendChild(grid);
      servicesListEl.appendChild(card);
    });
  }

  // Pick up price edits that haven't been saved yet, so adding/removing a
  // service (which re-renders the list) doesn't throw them away.
  function readServicePricesFromDom() {
    servicesListEl.querySelectorAll(".service-card").forEach((card) => {
      const svc = serviceById(card.dataset.serviceId);
      if (!svc) return;
      card.querySelectorAll("input[data-meal]").forEach((inp) => {
        svc.prices[inp.dataset.meal] = parseFloat(inp.value) || 0;
      });
    });
  }

  function removeService(id) {
    readServicePricesFromDom();
    if (services.length <= 1) {
      alert("Keep at least one tiffin service.");
      return;
    }
    if (serviceHasEntries(id)) {
      alert(`"${serviceName(id)}" has tiffins logged against it, so it can't be removed. Delete those days from the Log first.`);
      return;
    }
    if (!confirm(`Remove ${serviceName(id)}?`)) return;
    services = services.filter((s) => s.id !== id);
    persistAll();
    renderServices();
    pushToRemote("saveServices", { services });
  }

  document.getElementById("add-service-btn").addEventListener("click", () => {
    const input = document.getElementById("new-service-name");
    const name = input.value.trim();
    if (!name) return;
    if (services.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      alert("A service with this name already exists.");
      return;
    }
    readServicePricesFromDom();
    services.push({ id: newServiceId(), name, prices: { breakfast: 0, lunch: 0, dinner: 0 } });
    persistAll();
    input.value = "";
    renderServices();
    pushToRemote("saveServices", { services });
  });

  document.getElementById("new-service-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-service-btn").click();
  });

  document.getElementById("add-person-btn").addEventListener("click", () => {
    const input = document.getElementById("new-person-name");
    const name = input.value.trim();
    if (!name) return;
    if (people.includes(name)) {
      alert("This person is already in the list.");
      return;
    }
    people.push(name);
    persistAll();
    input.value = "";
    renderPeople();
    pushToRemote("addPerson", { name });
  });

  document.getElementById("new-person-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-person-btn").click();
  });

  document.getElementById("save-prices-btn").addEventListener("click", () => {
    readServicePricesFromDom();
    persistAll();
    const status = document.getElementById("price-status");
    status.textContent = "Prices saved.";
    setTimeout(() => (status.textContent = ""), 2000);
    pushToRemote("saveServices", { services });
  });

  // ---------- SYNC SETTINGS ----------
  document.getElementById("sync-url").value = syncUrl;
  document.getElementById("sync-token").value = syncToken;

  document.getElementById("save-sync-btn").addEventListener("click", () => {
    syncUrl = document.getElementById("sync-url").value.trim();
    syncToken = document.getElementById("sync-token").value.trim();
    save(STORE_KEYS.syncUrl, syncUrl);
    save(STORE_KEYS.syncToken, syncToken);
    if (syncUrl) {
      syncFromRemote(true);
    } else {
      setSyncStatus("Sync disabled — using this device's saved data only.", false);
    }
  });

  // ---------- DATA EXPORT / IMPORT / RESET ----------
  document.getElementById("export-btn").addEventListener("click", () => {
    const data = { people, services, entries };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tiffin-data-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById("import-btn").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });

  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.people) people = data.people;
        if (Array.isArray(data.services) && data.services.length) {
          services = data.services;
        } else if (data.prices) {
          // Backup from before tiffin services existed.
          services = [{ id: DEFAULT_SERVICE_ID, name: "Tiffin 1", prices: data.prices }];
        }
        if (data.entries) entries = normalizeEntries(data.entries);
        persistAll();
        alert("Data imported successfully.");
        renderPeople();
        renderEntrySummary();
        pushToRemote("replaceAll", { people, services, entries });
      } catch (err) {
        alert("Could not read that file. Make sure it's a valid export from this app.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    const warning = syncUrl
      ? "This will permanently erase all people, prices, and logged tiffins — including in the synced Google Sheet. Continue?"
      : "This will permanently erase all people, prices, and logged tiffins. Continue?";
    if (confirm(warning)) {
      people = [];
      services = [{ id: DEFAULT_SERVICE_ID, name: "Tiffin 1", prices: { breakfast: 0, lunch: 0, dinner: 0 } }];
      entries = {};
      persistAll();
      renderPeople();
      renderEntrySummary();
      pushToRemote("replaceAll", { people, services, entries });
    }
  });

  function goToTab(tabName) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.click();
  }

  // ---------- ADMIN PIN LOGIN / LOGOUT ----------
  const pinDotsEls = document.querySelectorAll("#pin-dots .pin-dot");
  const pinKeypad = document.getElementById("pin-keypad");
  const pinCardEl = document.querySelector(".pin-card");
  const loginErrorEl = document.getElementById("login-error");
  let pinBuffer = "";

  function updatePinDots() {
    pinDotsEls.forEach((dot, i) => dot.classList.toggle("filled", i < pinBuffer.length));
  }

  function resetPin() {
    pinBuffer = "";
    updatePinDots();
  }

  function checkPin() {
    if (pinBuffer === ADMIN_PIN) {
      save(STORE_KEYS.authed, true);
      loginErrorEl.textContent = "";
      resetPin();
      applyAuthVisibility();
      goToTab("entry");
    } else {
      loginErrorEl.textContent = "Incorrect PIN.";
      pinCardEl.classList.add("shake");
      setTimeout(() => pinCardEl.classList.remove("shake"), 400);
      setTimeout(resetPin, 250);
    }
  }

  pinKeypad.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-key]");
    if (!btn) return;
    if (btn.dataset.key === "back") {
      pinBuffer = pinBuffer.slice(0, -1);
      updatePinDots();
      return;
    }
    if (pinBuffer.length >= 4) return;
    pinBuffer += btn.dataset.key;
    updatePinDots();
    if (pinBuffer.length === 4) setTimeout(checkPin, 150);
  });

  document.getElementById("logout-btn").addEventListener("click", () => {
    save(STORE_KEYS.authed, false);
    applyAuthVisibility();
    goToTab("weekly");
  });

  // ---------- REFRESH ----------
  document.getElementById("refresh-btn").addEventListener("click", () => {
    if (!syncUrl) {
      setSyncStatus("No sync set up on this device yet.", true);
      return;
    }
    const btn = document.getElementById("refresh-btn");
    btn.classList.add("spinning");
    syncFromRemote(true).finally(() => btn.classList.remove("spinning"));
  });

  // ---------- INIT ----------
  renderEntrySummary();
  renderPeople();
  renderWeekly();
  applyAuthVisibility();
  if (syncUrl) syncFromRemote(true);
})();
