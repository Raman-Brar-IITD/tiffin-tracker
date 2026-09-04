(function () {
  "use strict";

  const MEALS = ["breakfast", "lunch", "dinner"];
  const MEAL_LABEL = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };

  // Shared login for this household's copy of the app. Since GitHub Pages
  // requires a public repo, this only screens out casual visitors — anyone
  // who views the page source can read it. Not real security.
  const AUTH_USER = "tiffinwala";
  const AUTH_PASS = "tiffinlelo";

  // Pre-filled so a phone opening this page for the first time syncs
  // immediately without needing the URL/token typed in by hand. Still
  // overridable from the Sync Settings panel.
  const DEFAULT_SYNC_URL = "https://script.google.com/macros/s/AKfycbwYrYldiqxpxt3ixXCxC_3FfWc3QX5peFrduEy6XffyLrIsonFm_doQm745LL4n-SeHeQ/exec";
  const DEFAULT_SYNC_TOKEN = "RknxZu9OHyZNWfYbSLPWLcyI769RN6a2";

  const STORE_KEYS = {
    people: "tiffin_people",
    prices: "tiffin_prices",
    entries: "tiffin_entries",
    syncUrl: "tiffin_sync_url",
    syncToken: "tiffin_sync_token",
    authed: "tiffin_authed"
  };

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

  let people = load(STORE_KEYS.people, []);
  let prices = load(STORE_KEYS.prices, { breakfast: 0, lunch: 0, dinner: 0 });
  // entries: { "YYYY-MM-DD": { breakfast: {name: qty}, lunch: {...}, dinner: {...} } }
  let entries = load(STORE_KEYS.entries, {});
  let syncUrl = load(STORE_KEYS.syncUrl, DEFAULT_SYNC_URL);
  let syncToken = load(STORE_KEYS.syncToken, DEFAULT_SYNC_TOKEN);

  function persistAll() {
    save(STORE_KEYS.people, people);
    save(STORE_KEYS.prices, prices);
    save(STORE_KEYS.entries, entries);
  }

  // ---------- REMOTE SYNC (Google Apps Script Web App) ----------
  const syncStatusEl = document.getElementById("sync-status");

  function setSyncStatus(text, isError) {
    if (!syncStatusEl) return;
    syncStatusEl.textContent = text;
    syncStatusEl.style.color = isError ? "var(--danger)" : "var(--success)";
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
    else if (tab === "entry") renderEntryForm();
  }

  async function syncFromRemote(showStatus) {
    if (!syncUrl) return;
    if (showStatus) setSyncStatus("Syncing…", false);
    try {
      const data = await remoteGetAll();
      if (data.people) people = data.people;
      if (data.prices) prices = data.prices;
      if (data.entries) entries = data.entries;
      persistAll();
      refreshActiveTab();
      if (showStatus) setSyncStatus("Synced with Google Sheet.", false);
    } catch (err) {
      if (showStatus) setSyncStatus("Could not reach the sheet — showing last saved data.", true);
    }
  }

  async function pushToRemote(action, payload) {
    if (!syncUrl) return;
    try {
      const data = await remotePost(action, payload);
      if (data.people) people = data.people;
      if (data.prices) prices = data.prices;
      if (data.entries) entries = data.entries;
      persistAll();
      refreshActiveTab();
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
      if (btn.dataset.tab === "entry") renderEntryForm();
    });
  });

  // ---------- ENTRY FORM ----------
  const entryDateInput = document.getElementById("entry-date");
  const entryMealsWrap = document.getElementById("entry-meals");
  const entryStatus = document.getElementById("entry-status");

  entryDateInput.value = todayStr();

  function renderEntryForm() {
    entryMealsWrap.innerHTML = "";
    entryStatus.textContent = "";

    if (people.length === 0) {
      entryMealsWrap.innerHTML =
        '<p class="empty-msg">Add at least one person under "People &amp; Prices" before logging tiffins.</p>';
      return;
    }

    const date = entryDateInput.value || todayStr();
    const dayData = entries[date] || {};

    MEALS.forEach((meal) => {
      const block = document.createElement("div");
      block.className = "meal-block";
      block.style.setProperty("--meal-color", `var(--${meal})`);

      const heading = document.createElement("h3");
      heading.textContent = MEAL_LABEL[meal];
      block.appendChild(heading);

      people.forEach((person) => {
        const row = document.createElement("div");
        row.className = "person-qty-row";

        const label = document.createElement("label");
        label.textContent = person;

        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.dataset.meal = meal;
        input.dataset.person = person;
        const existing = dayData[meal] && dayData[meal][person];
        input.value = existing ? existing : "";
        input.placeholder = "0";

        row.appendChild(label);
        row.appendChild(input);
        block.appendChild(row);
      });

      entryMealsWrap.appendChild(block);
    });
  }

  entryDateInput.addEventListener("change", renderEntryForm);

  document.getElementById("save-entry").addEventListener("click", () => {
    const date = entryDateInput.value || todayStr();
    const inputs = entryMealsWrap.querySelectorAll("input[data-meal]");
    if (inputs.length === 0) return;

    const dayData = { breakfast: {}, lunch: {}, dinner: {} };
    let anyValue = false;

    inputs.forEach((inp) => {
      const qty = parseInt(inp.value, 10);
      if (!isNaN(qty) && qty > 0) {
        dayData[inp.dataset.meal][inp.dataset.person] = qty;
        anyValue = true;
      }
    });

    if (anyValue) {
      entries[date] = dayData;
    } else {
      delete entries[date];
    }
    persistAll();

    entryStatus.textContent = `Saved entry for ${fmtDateNice(date)}.`;
    setTimeout(() => (entryStatus.textContent = ""), 2500);

    pushToRemote("saveDay", { date, dayData });
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
      card.appendChild(header);

      MEALS.forEach((meal) => {
        const mealEntries = dayData[meal] || {};
        const namesWithQty = Object.keys(mealEntries).filter((n) => mealEntries[n] > 0);
        if (namesWithQty.length === 0) return;
        const line = document.createElement("div");
        line.className = "day-line";
        const tag = `<span class="meal-tag ${meal}">${MEAL_LABEL[meal]}</span>`;
        const parts = namesWithQty.map((n) => `${n}: ${mealEntries[n]}`).join(", ");
        line.innerHTML = tag + parts;
        card.appendChild(line);
      });

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
    // returns { person: {breakfast, lunch, dinner, totalQty, cost} }, plus grand totals
    const summary = {};
    people.forEach((p) => {
      summary[p] = { breakfast: 0, lunch: 0, dinner: 0 };
    });

    datesInRange.forEach((date) => {
      const dayData = entries[date];
      if (!dayData) return;
      MEALS.forEach((meal) => {
        const mealEntries = dayData[meal] || {};
        Object.keys(mealEntries).forEach((person) => {
          if (!summary[person]) summary[person] = { breakfast: 0, lunch: 0, dinner: 0 };
          summary[person][meal] += mealEntries[person];
        });
      });
    });

    let grand = { breakfast: 0, lunch: 0, dinner: 0, cost: 0 };
    Object.keys(summary).forEach((person) => {
      const s = summary[person];
      s.totalQty = s.breakfast + s.lunch + s.dinner;
      s.cost = s.breakfast * (prices.breakfast || 0) + s.lunch * (prices.lunch || 0) + s.dinner * (prices.dinner || 0);
      grand.breakfast += s.breakfast;
      grand.lunch += s.lunch;
      grand.dinner += s.dinner;
      grand.cost += s.cost;
    });

    return { summary, grand };
  }

  function buildSummaryTable(summary, grand) {
    const names = Object.keys(summary).filter((n) => people.includes(n) || summary[n].totalQty > 0);
    if (names.length === 0) {
      return '<p class="empty-msg">No tiffins recorded in this period.</p>';
    }

    let html = "<table><thead><tr><th>Person</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>Total</th><th>Cost</th></tr></thead><tbody>";
    names.forEach((name) => {
      const s = summary[name];
      html += `<tr><td>${name}</td><td>${s.breakfast}</td><td>${s.lunch}</td><td>${s.dinner}</td><td>${s.totalQty}</td><td>${fmtMoney(s.cost)}</td></tr>`;
    });
    html += `</tbody><tfoot><tr><td>Total</td><td>${grand.breakfast}</td><td>${grand.lunch}</td><td>${grand.dinner}</td><td>${grand.breakfast + grand.lunch + grand.dinner}</td><td>${fmtMoney(grand.cost)}</td></tr></tfoot></table>`;
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

    const { summary, grand } = summarize(dates);
    document.getElementById("weekly-table-wrap").innerHTML = buildSummaryTable(summary, grand);
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

    const { summary, grand } = summarize(dates);
    document.getElementById("monthly-table-wrap").innerHTML = buildSummaryTable(summary, grand);
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

    document.getElementById("price-breakfast").value = prices.breakfast || 0;
    document.getElementById("price-lunch").value = prices.lunch || 0;
    document.getElementById("price-dinner").value = prices.dinner || 0;
  }

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
    prices = {
      breakfast: parseFloat(document.getElementById("price-breakfast").value) || 0,
      lunch: parseFloat(document.getElementById("price-lunch").value) || 0,
      dinner: parseFloat(document.getElementById("price-dinner").value) || 0
    };
    persistAll();
    const status = document.getElementById("price-status");
    status.textContent = "Prices saved.";
    setTimeout(() => (status.textContent = ""), 2000);
    pushToRemote("savePrices", prices);
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
    const data = { people, prices, entries };
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
        if (data.prices) prices = data.prices;
        if (data.entries) entries = data.entries;
        persistAll();
        alert("Data imported successfully.");
        renderPeople();
        renderEntryForm();
      } catch (err) {
        alert("Could not read that file. Make sure it's a valid export from this app.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (confirm("This will permanently erase all people, prices, and logged tiffins. Continue?")) {
      people = [];
      prices = { breakfast: 0, lunch: 0, dinner: 0 };
      entries = {};
      persistAll();
      renderPeople();
      renderEntryForm();
    }
  });

  // ---------- LOGIN GATE ----------
  function unlockApp() {
    document.getElementById("login-gate").style.display = "none";
    document.getElementById("app-root").style.display = "block";
    if (syncUrl) syncFromRemote(true);
  }

  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.getElementById("login-user").value.trim();
    const pass = document.getElementById("login-pass").value;
    if (user === AUTH_USER && pass === AUTH_PASS) {
      save(STORE_KEYS.authed, true);
      document.getElementById("login-error").textContent = "";
      unlockApp();
    } else {
      document.getElementById("login-error").textContent = "Incorrect username or password.";
    }
  });

  // ---------- INIT ----------
  renderEntryForm();
  renderPeople();
  if (load(STORE_KEYS.authed, false)) unlockApp();
})();
