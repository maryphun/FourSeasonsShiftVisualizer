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
