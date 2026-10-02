import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function appHarness() {
  const cache = new Map();
  let options;
  const sandbox = vm.createContext({
    Vue: { createApp(value) { options = value; return { mount() {} }; }, nextTick() {} },
    document: { currentScript: null, scripts: [], querySelector() { return null; } },
    window: {
      clearTimeout,
      setTimeout,
      matchMedia: () => ({ matches: false }),
      localStorage: {
        getItem: (key) => cache.get(key) ?? null,
        setItem: (key, value) => cache.set(key, value),
        removeItem: (key) => cache.delete(key),
      },
    },
    console,
    Date,
  });
  vm.runInContext(source, sandbox);
  const app = options.data();
  for (const [name, method] of Object.entries(options.methods)) app[name] = method.bind(app);
  for (const [name, getter] of Object.entries(options.computed)) {
    Object.defineProperty(app, name, { get: getter.bind(app) });
  }
  app.calendarToday = "2026-09-19";
  return { app, sandbox, cache };
}

test("calendar preserves actual shifts and fills missing dates without declaring leave", () => {
  const { sandbox } = appHarness();
  const actual = { dateKey: "2026-09-18", day: 18, value: "14:00 (CDT)", columnIndex: 3 };
  const days = sandbox.buildCalendarMonth(2026, 9, [actual]);
  assert.equal(days.length, 30);
  assert.equal(days[17], actual);
  assert.equal(days[0].value, "");
  assert.equal(days[0].isPlaceholder, true);
  assert.equal(sandbox.isNonWorkingShift(days[0].value), false);
});

test("light gray vertical rules keep the name and first date in separate cells", () => {
  const { sandbox } = appHarness();
  const width = 260;
  const height = 120;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const setPixel = (x, y, gray) => {
    const offset = (y * width + x) * 4;
    pixels[offset] = gray;
    pixels[offset + 1] = gray;
    pixels[offset + 2] = gray;
  };
  for (const x of [0, 110, 150, 190, 230, 259]) {
    for (let y = 0; y < height; y += 1) setPixel(x, y, x === 110 ? 160 : 0);
  }
  for (const y of [0, 20, 40, 60, 80, 100, 119]) {
    for (let x = 0; x < width; x += 1) setPixel(x, y, 0);
  }
  const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data: pixels }) }) };
  const grid = sandbox.detectTableGrid(canvas);
  assert.equal(grid.isUsable, true);
  assert.ok(grid.verticals.some((line) => Math.abs(line - 110) <= 1));

  const words = [
    { text: "Date", x0: 10, x1: 40, y0: 3, y1: 15 },
    { text: "1-Oct", x0: 115, x1: 145, y0: 3, y1: 15 },
    { text: "2-Oct", x0: 155, x1: 185, y0: 3, y1: 15 },
    { text: "3-Oct", x0: 195, x1: 225, y0: 3, y1: 15 },
    { text: "Day", x0: 10, x1: 40, y0: 23, y1: 35 },
    { text: "Thu", x0: 115, x1: 140, y0: 23, y1: 35 },
    { text: "Fri", x0: 155, x1: 178, y0: 23, y1: 35 },
    { text: "Sat", x0: 195, x1: 220, y0: 23, y1: 35 },
    { text: "Yukari (Bell)", x0: 10, x1: 90, y0: 43, y1: 55 },
    { text: "14", x0: 117, x1: 135, y0: 43, y1: 55 },
    { text: "14", x0: 157, x1: 175, y0: 43, y1: 55 },
    { text: "OFF", x0: 197, x1: 225, y0: 43, y1: 55 },
  ];
  const table = sandbox.wordsToTable(words, grid);
  assert.equal(table[0][0], "Date");
  assert.equal(table[0][1], "1-Oct");
  assert.equal(table[2][0], "Yukari (Bell)");
  assert.equal(table[2][1], "14");
  const prepared = sandbox.prepareOcrTableForSchedule(table);
  const roster = sandbox.createRosterDatabase(prepared.table);
  assert.equal(roster.month, 10);
  assert.equal(roster.profiles.length, 1);
  assert.equal(roster.profiles[0].name, "Yukari (Bell)");
  assert.deepEqual(Array.from(roster.profiles[0].shifts.slice(0, 3), (shift) => shift.dateKey),
    ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.deepEqual(Array.from(roster.profiles[0].shifts.slice(0, 3), (shift) => shift.value), ["14", "14", "OFF"]);
});

test("date-like row labels are not people and absent date headers are not invented", () => {
  const { sandbox } = appHarness();
  const mergedHeader = [
    ["Date 1-Oct", "2-Oct", "3-Oct"],
    ["Day Thu", "Fri", "Sat"],
    ["Yukari (Bell) 14", "14", "OFF"],
  ];
  const prepared = sandbox.prepareOcrTableForSchedule(mergedHeader);
  assert.equal(prepared.table[0][1], "2-Oct");
  const roster = sandbox.createRosterDatabase(prepared.table);
  assert.equal(roster.profiles.some((profile) => profile.name === "Date 1-Oct"), false);
  assert.deepEqual(Array.from(sandbox.inferDateColumns([["Yukari", "14", "OFF"]])), []);
  assert.equal(sandbox.createRosterDatabase([["Yukari", "14", "OFF"]]).profiles.length, 0);
});

test("calendar presentation preserves context, events and real monthly totals", () => {
  const { app } = appHarness();
  app.rosterDb = { year: 2026, month: 9, profiles: [{
    id: "person-0", name: "Test", shifts: [
      { dateKey: "2026-09-01", day: 1, value: "08:00 (TR)" },
      { dateKey: "2026-09-02", day: 2, value: "14:00 (CDT)" },
      { dateKey: "2026-09-03", day: 3, value: "22:30" },
      { dateKey: "2026-09-04", day: 4, value: "AL" },
    ],
  }] };
  app.selectedProfileId = "person-0";
  app.dateEvents = { "2026-09-02": "Dinner" };
  assert.equal(app.calendarDays[0].main, "08:00");
  assert.match(app.calendarDays[0].context, /TR/);
  assert.equal(app.calendarDays[1].event, "Dinner");
  assert.equal(app.calendarDays[2].late, true);
  assert.equal(app.calendarDays[3].leave, true);
  assert.deepEqual(Array.from(app.monthlyStats, (item) => item.value), [30, 3, 1, 1, 1, 1]);
  app.calendarMonthOffset = 1;
  assert.deepEqual(Array.from(app.monthlyStats, (item) => item.value), [31, 0, 0, 0, 0, 0]);
});

test("calendar handles leap years and December rollover with local date keys", () => {
  const { app, sandbox } = appHarness();
  assert.equal(sandbox.buildCalendarMonth(2028, 2).length, 29);
  assert.equal(sandbox.buildCalendarMonth(2027, 2).length, 28);
  app.rosterDb = { year: 2026, month: 12, profiles: [] };
  app.calendarMonthOffset = 1;
  assert.equal(app.calendarMonthLabel, "Jan 2027");
  assert.equal(app.calendarShifts[0].dateKey, "2027-01-01");
  assert.equal(app.calendarShifts[30].dateKey, "2027-01-31");
});

test("month navigation keeps the selected day and clamps short months", () => {
  const { app } = appHarness();
  app.rosterDb = { year: 2027, month: 1, profiles: [] };
  app.selectedShiftIndex = 30;
  app.changeCalendarMonth(1);
  assert.equal(app.activeShift.dateKey, "2027-02-28");
  app.changeCalendarMonth(1);
  assert.equal(app.calendarMonthOffset, 1);
  app.changeCalendarMonth(-1);
  assert.equal(app.activeShift.dateKey, "2027-01-28");
  app.changeCalendarMonth(-1);
  assert.equal(app.calendarMonthOffset, 0);
});

test("an older roster can reach next calendar month", () => {
  const { app } = appHarness();
  app.rosterDb = { year: 2026, month: 7, profiles: [] };
  assert.equal(app.maxCalendarMonthOffset, 3);
  app.calendarMonthOffset = 3;
  assert.equal(app.calendarMonthLabel, "Oct 2026");
});

test("cached and newly saved rosters open on today when that month is reachable", () => {
  const { app, cache } = appHarness();
  const roster = { version: 1, year: 2026, month: 9, dateColumns: [], profiles: [{ id: "me", shifts: [] }], rawTable: [] };
  app.calendarToday = "2026-10-03";
  app.setRosterDb(roster);
  assert.equal(app.calendarMonthLabel, "Oct 2026");
  assert.equal(app.activeShift.dateKey, "2026-10-03");
  assert.equal(app.activeShift.isPlaceholder, true);
  assert.equal(app.shiftClass(app.activeShift)["is-unplanned"], true);

  const { app: restored, cache: restoredCache } = appHarness();
  restored.calendarToday = "2026-10-03";
  restoredCache.set("schedulePhotoReader.roster.v1", cache.get("schedulePhotoReader.roster.v1"));
  restoredCache.set("schedulePhotoReader.profile.v1", "me");
  restored.restoreCachedRoster();
  assert.equal(restored.activeShift.dateKey, "2026-10-03");
});

test("a future roster opens on its own first date and a current roster opens on today", () => {
  const { app } = appHarness();
  app.calendarToday = "2026-10-03";
  app.setRosterDb({ year: 2026, month: 11, profiles: [], rawTable: [] });
  assert.equal(app.activeShift.dateKey, "2026-11-01");
  app.selectedShiftIndex = 20;
  app.setRosterDb({ year: 2026, month: 10, profiles: [], rawTable: [] });
  assert.equal(app.activeShift.dateKey, "2026-10-03");
});

test("cached rosters without month metadata fall back to the current month", () => {
  const { app, cache } = appHarness();
  app.calendarToday = "2026-10-03";
  cache.set("schedulePhotoReader.roster.v1", JSON.stringify({ version: 1, dateColumns: [], profiles: [] }));
  app.restoreCachedRoster();
  assert.equal(app.calendarMonthLabel, "Oct 2026");
  assert.equal(app.activeShift.dateKey, "2026-10-03");
});

test("next-month events persist, sync, survive a roster upload, and can be edited or removed", () => {
  const { app, cache } = appHarness();
  app.rosterDb = { year: 2026, month: 9, profiles: [] };
  app.calendarMonthOffset = 1;
  app.selectedShiftIndex = 8;
  let syncCount = 0;
  app.syncReminderEvents = () => { syncCount++; };
  app.openDateEventEditor();
  app.eventEditorValue = "Dinner with friends";
  app.saveDateEvent();
  assert.equal(app.dateEvents["2026-10-09"], "Dinner with friends");
  assert.equal(JSON.parse(cache.get("schedulePhotoReader.dateEvents.v1"))["2026-10-09"], "Dinner with friends");
  app.dateEvents = {};
  app.restoreDateEvents();
  assert.equal(app.eventActionLabel(app.activeShift), "Edit Event");
  app.setRosterDb({ year: 2026, month: 10, profiles: [], rawTable: [] });
  app.selectedShiftIndex = 8;
  assert.equal(app.shiftEventText(app.activeShift), "Dinner with friends");
  app.openDateEventEditor();
  app.eventEditorValue = "Dinner at 8";
  app.saveDateEvent();
  assert.equal(app.shiftEventText(app.activeShift), "Dinner at 8");
  app.openDateEventEditor();
  app.removeDateEvent();
  assert.equal(app.shiftEventText(app.activeShift), "");
  assert.equal(syncCount, 3);
});

test("next-month placeholders cannot edit CSV data or borrow coworkers from another year", () => {
  const { app, sandbox } = appHarness();
  const old = { dateKey: "2025-10-09", dateLabel: "9-OCT", day: 9, value: "09:00", columnIndex: 9 };
  const current = { dateKey: "2026-10-09", dateLabel: "9-OCT", day: 9, value: "", isPlaceholder: true };
  assert.equal(sandbox.findMatchingShift([old], current), null);
  app.rosterDb = { year: 2026, month: 9, profiles: [{ id: "me", shifts: [old] }] };
  app.selectedProfileId = "me";
  app.openShiftEditor(current);
  assert.equal(app.shiftEditorShift, null);
});

test("day gestures preserve button taps and capture actual horizontal swipes", () => {
  const { app } = appHarness();
  let captures = 0;
  const target = { setPointerCapture() { captures++; }, releasePointerCapture() {} };
  const pointer = { clientX: 120, clientY: 60, pointerId: 1, pointerType: "mouse", button: 0, currentTarget: target };
  app.startDaySwipe(pointer);
  app.finishDaySwipe(pointer);
  assert.equal(captures, 0);
  assert.equal(app.daySuppressClick, false);
  app.startDaySwipe(pointer);
  app.moveDaySwipe({ ...pointer, clientX: 118, clientY: 90 });
  assert.equal(captures, 0);
  app.moveDaySwipe({ ...pointer, clientX: 40 });
  assert.equal(captures, 1);
  app.finishDaySwipe({ ...pointer, clientX: 40 });
  assert.equal(app.daySuppressClick, true);
  app.resetDayMotion();
});
