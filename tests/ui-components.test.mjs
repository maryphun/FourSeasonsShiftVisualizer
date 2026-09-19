import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../ui-components.js", import.meta.url), "utf8");
function components() {
  const context = { Vue: { h: (tag, props, children) => ({ tag, props, children }) }, window: {} };
  vm.runInNewContext(source, context);
  return context;
}

test("calendar keyboard navigation stays within month boundaries", () => {
  const { window } = components();
  const selections = [];
  let focused;
  const instance = { days: Array(30), $emit: (name, index) => selections.push(index),
    $el: { querySelectorAll: () => Array.from({ length: 30 }, (_, i) => ({ focus: () => { focused = i; } })) } };
  for (const [key, index, expected] of [["ArrowRight", 29, 29], ["ArrowUp", 3, 0], ["ArrowDown", 4, 11], ["End", 4, 29], ["Home", 12, 0]]) {
    let prevented = false;
    window.ScheduleUI.MonthCalendar.methods.moveFocus.call(instance, { key, preventDefault: () => { prevented = true; } }, index);
    assert.equal(prevented, true);
    assert.equal(selections.at(-1), expected);
    assert.equal(focused, expected);
  }
});

test("icon atom renders the installed Lucide glyph without DOM replacement", () => {
  const { window } = components();
  window.lucide = { icons: { ChevronLeft: [["path", { d: "M15 18l-6-6 6-6" }]] } };
  const icon = window.ScheduleUI.UiIcon.render.call({ name: "chevron-left" });
  assert.equal(icon.tag, "svg");
  assert.equal(icon.props["aria-hidden"], "true");
  assert.equal(icon.children[0].tag, "path");
});
