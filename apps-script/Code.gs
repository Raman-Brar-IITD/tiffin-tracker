/**
 * Tiffin Tracker backend. Deploy this as a Web App (Extensions > Apps Script
 * inside a Google Sheet, paste this file, then Deploy > New deployment > Web app).
 * Execute as: Me. Who has access: Anyone.
 * Copy the resulting /exec URL into the app's "Sync Settings" panel.
 */

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
  return {
    people: getPeople(),
    prices: getPrices(),
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

function savePrices(payload) {
  var sheet = ensurePricesSheet();
  sheet.getRange(2, 1, 1, 3).setValues([[
    Number(payload.breakfast) || 0,
    Number(payload.lunch) || 0,
    Number(payload.dinner) || 0
  ]]);
  return getPrices();
}

// ---------- Entries ----------

function ensureEntriesSheet() {
  var sheet = getSheet('Entries');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Meal', 'Person', 'Qty']);
  }
  return sheet;
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
    if (!date || !meal || !person || !qty) continue;
    if (!entries[date]) entries[date] = { breakfast: {}, lunch: {}, dinner: {} };
    entries[date][meal][person] = qty;
  }

  var notes = getNotes();
  Object.keys(notes).forEach(function (date) {
    if (!entries[date]) entries[date] = { breakfast: {}, lunch: {}, dinner: {} };
    entries[date].note = notes[date];
  });

  return entries;
}

function deleteDayRows(date) {
  var sheet = ensureEntriesSheet();
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (formatDateCell(values[i][0]) === date) sheet.deleteRow(i + 1);
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

function saveDay(payload) {
  var date = payload.date;
  var dayData = payload.dayData || {};
  deleteDayRows(date);
  var sheet = ensureEntriesSheet();
  ['breakfast', 'lunch', 'dinner'].forEach(function (meal) {
    var mealData = dayData[meal] || {};
    Object.keys(mealData).forEach(function (person) {
      var qty = Number(mealData[person]);
      if (qty > 0) sheet.appendRow([date, meal, person, qty]);
    });
  });
  setNote(date, dayData.note || '');
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
  var prices = payload.prices || { breakfast: 0, lunch: 0, dinner: 0 };
  var entries = payload.entries || {};

  var peopleSheet = getSheet('People');
  peopleSheet.clear();
  people.forEach(function (name) {
    peopleSheet.appendRow([name]);
  });

  var pricesSheet = getSheet('Prices');
  pricesSheet.clear();
  pricesSheet.appendRow(['breakfast', 'lunch', 'dinner']);
  pricesSheet.appendRow([
    Number(prices.breakfast) || 0,
    Number(prices.lunch) || 0,
    Number(prices.dinner) || 0
  ]);

  var entriesSheet = getSheet('Entries');
  entriesSheet.clear();
  entriesSheet.appendRow(['Date', 'Meal', 'Person', 'Qty']);

  var notesSheet = getSheet('Notes');
  notesSheet.clear();
  notesSheet.appendRow(['Date', 'Note']);

  Object.keys(entries).forEach(function (date) {
    var dayData = entries[date];
    ['breakfast', 'lunch', 'dinner'].forEach(function (meal) {
      var mealData = (dayData && dayData[meal]) || {};
      Object.keys(mealData).forEach(function (person) {
        var qty = Number(mealData[person]);
        if (qty > 0) entriesSheet.appendRow([date, meal, person, qty]);
      });
    });
    if (dayData && dayData.note) notesSheet.appendRow([date, dayData.note]);
  });

  return getAllData();
}
