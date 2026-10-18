/**
 * Tiffin Tracker backend. Deploy this as a Web App (Extensions > Apps Script
 * inside a Google Sheet, paste this file, then Deploy > New deployment > Web app).
 * Execute as: Me. Who has access: Anyone.
 * Copy the resulting /exec URL into the app's "Sync Settings" panel.
 */

// Entries saved before tiffin services existed have a blank Service cell and
// belong to this service. Must match DEFAULT_SERVICE_ID in script.js.
var DEFAULT_SERVICE_ID = 's1';

// Set this in Project Settings > Script Properties (key: API_TOKEN) so it
// never lives in the source code. If unset, the API is open to anyone with
// the URL.
function isAuthorized(token) {
  var required = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!required) return true;
  return token === required;
}

function doGet(e) {
  if (!isAuthorized(e.parameter.token)) return respondToGet(e, { error: 'unauthorized' });
  return respondToGet(e, getAllData());
}

// Apps Script Web Apps don't send CORS headers, so a cross-origin fetch()
// GET is blocked by the browser. The frontend instead loads this as a
// <script> tag (JSONP), which isn't subject to CORS, via ?callback=name.
function respondToGet(e, obj) {
  var callback = e.parameter.callback;
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return respond(obj);
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  if (!isAuthorized(body.token)) return respond({ error: 'unauthorized' });
  var action = body.action;
  var payload = body.payload || {};
  var result;
  switch (action) {
    case 'getAll':
      result = getAllData();
      break;
    case 'saveDay':
      result = saveDay(payload);
      break;
    case 'deleteDay':
      result = deleteDay(payload);
      break;
    case 'addPerson':
      result = addPerson(payload);
      break;
    case 'removePerson':
      result = removePerson(payload);
      break;
    case 'savePrices':
      result = savePrices(payload);
      break;
    case 'saveServices':
      result = saveServices(payload);
      break;
    case 'replaceAll':
      result = replaceAll(payload);
      break;
    default:
      result = { error: 'unknown action: ' + action };
  }
  return respond(result);
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function getAllData() {
  var services = getServices();
  return {
    people: getPeople(),
    services: services,
    // First service's prices, so a not-yet-refreshed older page still works.
    prices: services[0].prices,
    entries: getEntries()
  };
}

// ---------- People ----------

function getPeople() {
  var sheet = getSheet('People');
  var values = sheet.getDataRange().getValues();
  var people = [];
  for (var i = 0; i < values.length; i++) {
    var name = values[i][0];
    if (name) people.push(String(name));
  }
  return people;
}

function addPerson(payload) {
  var name = String(payload.name || '').trim();
  if (!name) return { error: 'no name given' };
  var people = getPeople();
  if (people.indexOf(name) === -1) {
    getSheet('People').appendRow([name]);
  }
  return { people: getPeople() };
}

function removePerson(payload) {
  var name = String(payload.name || '').trim();
  var sheet = getSheet('People');
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] === name) sheet.deleteRow(i + 1);
  }
  return { people: getPeople() };
}

// ---------- Prices ----------

function ensurePricesSheet() {
  var sheet = getSheet('Prices');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['breakfast', 'lunch', 'dinner']);
    sheet.appendRow([0, 0, 0]);
  }
  return sheet;
}

function getPrices() {
  var sheet = ensurePricesSheet();
  var values = sheet.getRange(2, 1, 1, 3).getValues()[0];
  return {
    breakfast: Number(values[0]) || 0,
    lunch: Number(values[1]) || 0,
    dinner: Number(values[2]) || 0
  };
}

// Only used by an older page that still has a single global price list: it
// updates the default service.
function savePrices(payload) {
  var services = getServices();
  var target = services[0];
  services.forEach(function (s) {
    if (s.id === DEFAULT_SERVICE_ID) target = s;
  });
  target.prices = {
    breakfast: Number(payload.breakfast) || 0,
    lunch: Number(payload.lunch) || 0,
    dinner: Number(payload.dinner) || 0
  };
  writeServices(services);
  return getAllData();
}

// ---------- Services ----------

function writeServices(services) {
  var sheet = getSheet('Services');
  sheet.clear();
  var rows = [['Id', 'Name', 'Breakfast', 'Lunch', 'Dinner']];
  services.forEach(function (s) {
    rows.push([s.id, s.name, s.prices.breakfast, s.prices.lunch, s.prices.dinner]);
  });
  sheet.getRange(1, 1, rows.length, 5).setValues(rows);
}

function cleanServices(list) {
  var seen = {};
  var out = [];
  (list || []).forEach(function (s) {
    var name = String((s && s.name) || '').trim();
    if (!name) return;
    var id = String(s.id || '') || 's' + new Date().getTime().toString(36) + out.length;
    if (seen[id]) return;
    seen[id] = true;
    var p = s.prices || {};
    out.push({
      id: id,
      name: name,
      prices: {
        breakfast: Number(p.breakfast) || 0,
        lunch: Number(p.lunch) || 0,
        dinner: Number(p.dinner) || 0
      }
    });
  });
  return out;
}

// On first use there is no Services sheet yet: seed it with one service
// carrying the old single price list, so existing entries keep their price.
function getServices() {
  var sheet = getSheet('Services');
  var values = sheet.getDataRange().getValues();
  var services = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0] || !row[1]) continue;
    services.push({
      id: String(row[0]),
      name: String(row[1]),
      prices: {
        breakfast: Number(row[2]) || 0,
        lunch: Number(row[3]) || 0,
        dinner: Number(row[4]) || 0
      }
    });
  }
  if (services.length === 0) {
    services = [{ id: DEFAULT_SERVICE_ID, name: 'Tiffin 1', prices: getPrices() }];
    writeServices(services);
  }
  return services;
}

function saveServices(payload) {
  var services = cleanServices(payload.services);
  if (services.length === 0) return { error: 'at least one service is required' };
  writeServices(services);
  return getAllData();
}

// ---------- Entries ----------

var MEALS = ['breakfast', 'lunch', 'dinner'];

function ensureEntriesSheet() {
  var sheet = getSheet('Entries');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Meal', 'Person', 'Qty', 'Service']);
  } else if (sheet.getRange(1, 5).getValue() !== 'Service') {
    // Sheet created before tiffin services existed: add the column header.
    sheet.getRange(1, 5).setValue('Service');
  }
  return sheet;
}

function serviceOfRow(cell) {
  return String(cell || '') || DEFAULT_SERVICE_ID;
}

function formatDateCell(val) {
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth() + 1);
    var d = String(val.getDate());
    if (m.length < 2) m = '0' + m;
    if (d.length < 2) d = '0' + d;
    return y + '-' + m + '-' + d;
  }
  return String(val);
}

function getEntries() {
  var sheet = ensureEntriesSheet();
  var values = sheet.getDataRange().getValues();
  var entries = {};
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var date = formatDateCell(row[0]);
    var meal = row[1];
    var person = row[2];
    var qty = Number(row[3]);
    if (!date || MEALS.indexOf(meal) === -1 || !person || !qty) continue;
    var sid = serviceOfRow(row[4]);
    if (!entries[date]) entries[date] = { byService: {} };
    if (!entries[date].byService[sid]) {
      entries[date].byService[sid] = { breakfast: {}, lunch: {}, dinner: {} };
    }
    entries[date].byService[sid][meal][person] = qty;
  }

  var notes = getNotes();
  Object.keys(notes).forEach(function (date) {
    if (!entries[date]) entries[date] = { byService: {} };
    entries[date].note = notes[date];
  });

  return entries;
}

// With a serviceId, only that service's rows for the day are removed.
function deleteDayRows(date, serviceId) {
  var sheet = ensureEntriesSheet();
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (formatDateCell(values[i][0]) !== date) continue;
    if (serviceId && serviceOfRow(values[i][4]) !== serviceId) continue;
    sheet.deleteRow(i + 1);
  }
}

// ---------- Notes ----------

function ensureNotesSheet() {
  var sheet = getSheet('Notes');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Note']);
  }
  return sheet;
}

function getNotes() {
  var sheet = ensureNotesSheet();
  var values = sheet.getDataRange().getValues();
  var notes = {};
  for (var i = 1; i < values.length; i++) {
    var date = formatDateCell(values[i][0]);
    var note = values[i][1];
    if (date && note) notes[date] = String(note);
  }
  return notes;
}

function deleteNoteRow(date) {
  var sheet = ensureNotesSheet();
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (formatDateCell(values[i][0]) === date) sheet.deleteRow(i + 1);
  }
}

function setNote(date, note) {
  deleteNoteRow(date);
  if (note) ensureNotesSheet().appendRow([date, note]);
}

// Replaces one service's tiffins for a day (the other services' rows stay)
// and sets the day's note. An older page sends { date, dayData } with no
// service; that is treated as the default service.
function saveDay(payload) {
  var date = payload.date;
  var legacy = payload.dayData || {};
  var serviceId = payload.serviceId || DEFAULT_SERVICE_ID;
  var meals = payload.meals || legacy;
  var note = payload.note !== undefined ? payload.note : legacy.note;
  deleteDayRows(date, serviceId);
  var sheet = ensureEntriesSheet();
  MEALS.forEach(function (meal) {
    var mealData = meals[meal] || {};
    Object.keys(mealData).forEach(function (person) {
      var qty = Number(mealData[person]);
      if (qty > 0) sheet.appendRow([date, meal, person, qty, serviceId]);
    });
  });
  setNote(date, note || '');
  return { entries: getEntries() };
}

function deleteDay(payload) {
  deleteDayRows(payload.date);
  deleteNoteRow(payload.date);
  return { entries: getEntries() };
}

// Wholesale overwrite used by Import Data and Erase All Data, so those
// bulk local changes actually land in the sheet instead of getting
// silently reverted by the next sync pulling the old remote state.
function replaceAll(payload) {
  var people = payload.people || [];
  var entries = payload.entries || {};
  // An older page sends a single price list instead of services.
  var services = cleanServices(payload.services);
  if (services.length === 0) {
    services = cleanServices([{ id: DEFAULT_SERVICE_ID, name: 'Tiffin 1', prices: payload.prices }]);
  }

  var peopleSheet = getSheet('People');
  peopleSheet.clear();
  if (people.length) {
    peopleSheet.getRange(1, 1, people.length, 1).setValues(people.map(function (name) { return [name]; }));
  }

  writeServices(services);

  var entryRows = [['Date', 'Meal', 'Person', 'Qty', 'Service']];
  var noteRows = [['Date', 'Note']];
  Object.keys(entries).forEach(function (date) {
    var day = entries[date] || {};
    // Older shape: meals directly on the day, belonging to the default service.
    var byService = day.byService;
    if (!byService) {
      byService = {};
      byService[DEFAULT_SERVICE_ID] = day;
    }
    Object.keys(byService).forEach(function (sid) {
      var block = byService[sid] || {};
      MEALS.forEach(function (meal) {
        var mealData = block[meal] || {};
        Object.keys(mealData).forEach(function (person) {
          var qty = Number(mealData[person]);
          if (qty > 0) entryRows.push([date, meal, person, qty, sid]);
        });
      });
    });
    if (day.note) noteRows.push([date, day.note]);
  });

  var entriesSheet = getSheet('Entries');
  entriesSheet.clear();
  entriesSheet.getRange(1, 1, entryRows.length, 5).setValues(entryRows);

  var notesSheet = getSheet('Notes');
  notesSheet.clear();
  notesSheet.getRange(1, 1, noteRows.length, 2).setValues(noteRows);

  return getAllData();
}
