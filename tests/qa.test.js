"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/risk-detector.js");
const irBuilder = require("../src/ir-builder.js");
const renderer = require("../src/renderer.js");
const taskWidget = require("../src/task-widget.js");
const { createLatestTask } = require("../src/latest-task.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("risk notes follow narration modes and severity", () => {
  const ir = {
    _intro: "Change complete",
    _sections: [],
    _expected: "",
    _body: "Change complete",
    slots: {
      risk: [
        { text: "Low caveat", severity: "low" },
        { text: "High caveat", severity: "high" },
        { text: "Medium caveat", severity: "medium" }
      ]
    }
  };

  assert.doesNotMatch(renderer.render(ir, { mode: "fast", lang: "en-US" }), /caveat/i);
  assert.match(renderer.render(ir, { mode: "beginner", lang: "en-US" }), /High caveat/);
  assert.doesNotMatch(renderer.render(ir, { mode: "beginner", lang: "en-US" }), /Medium caveat/);
  assert.match(renderer.render(ir, { mode: "advanced", lang: "en-US" }), /High caveat/);
  assert.match(renderer.render(ir, { mode: "completo", lang: "en-US" }), /High caveat.*Medium caveat.*Low caveat/);
  assert.equal(
    renderer.appendRiskNotes("Change complete. High caveat", ir, { mode: "beginner" })
      .match(/High caveat/g).length,
    1
  );
});

test("risk detector flows through IR into spoken output", () => {
  const ir = irBuilder.buildIR({
    id: "build-change",
    taskTitle: "Dependency update",
    body: "Implemented dependency updates in package.json.",
    structure: {
      intro: "Implemented dependency updates.",
      sections: [{ title: "Build", items: ["Updated package.json dependencies."] }],
      expected: ""
    }
  }, { lang: "en-US" });

  assert.equal(ir.slots.risk[0].source, "build_risk");
  assert.match(renderer.render(ir, { mode: "beginner", lang: "en-US" }), /Run the build and validate the environment/);
});

test("task widget reader extracts title and description from the shared DOM contract", () => {
  const clone = {
    textContent: "Current task: Updating logo",
    querySelectorAll: () => [{ remove: () => { clone.textContent = "Current task"; } }]
  };
  const wrapper = { cloneNode: () => clone };
  const muted = { textContent: ": Updating logo", parentElement: wrapper };
  const button = { querySelector: (selector) => selector === "span.text-muted-foreground" ? muted : null };
  const scope = { querySelectorAll: (selector) => selector === "li button" ? [button] : [] };
  const status = { textContent: "1 background task", parentElement: scope };
  const doc = {
    querySelectorAll: (selector) => selector === '[role="status"][aria-live]' ? [status] : []
  };

  assert.deepEqual(taskWidget.read(doc), { title: "Current task", desc: "Updating logo" });
});

test("latest task debounces changes and serializes async work", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const started = [];
  const committed = [];
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const latest = createLatestTask({
    delayMs: 5,
    work: async (value) => {
      started.push(value);
      if (value === "first") signalFirstStarted();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(30);
      inFlight--;
      return value.toUpperCase();
    },
    commit: (value) => committed.push(value)
  });

  latest.schedule("first", {});
  await firstStarted;
  latest.schedule("second", {});
  latest.schedule("latest", {});
  await sleep(90);

  assert.deepEqual(started, ["first", "latest"]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(committed, ["LATEST"]);
});
