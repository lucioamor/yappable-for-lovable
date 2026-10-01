"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

require(path.join(root, "src", "risk-detector.js"));
const irBuilder = require(path.join(root, "src", "ir-builder.js"));
const renderer = require(path.join(root, "src", "renderer.js"));
const speech = require(path.join(root, "src", "speech-shaping.js"));

test("manifest is internally consistent", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
    ...Object.values(manifest.icons),
    ...manifest.declarative_net_request.rule_resources.map((entry) => entry.path)
  ];
  for (const relative of referenced) {
    assert.ok(fs.existsSync(path.join(root, relative)), `missing manifest file: ${relative}`);
  }
});

test("manifest is scoped to Lovable, ElevenLabs is optional, with no chat-site leftovers", () => {
  assert.deepEqual(manifest.permissions, ["storage", "declarativeNetRequestWithHostAccess"]);
  assert.deepEqual(manifest.host_permissions, ["https://lovable.dev/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://api.elevenlabs.io/*"]);
  // WithHostAccess needs host access to the blocked URL: keep every DNR rule on lovable.dev.
  const rules = JSON.parse(fs.readFileSync(path.join(root, "rules.json"), "utf8"));
  for (const rule of rules) assert.match(rule.condition.urlFilter, /^\|\|lovable\.dev\//);
  for (const entry of manifest.content_scripts) assert.deepEqual(entry.matches, ["https://lovable.dev/*"]);
  assert.doesNotMatch(JSON.stringify(manifest), /chatgpt|claude\.ai|gemini|grok/i);
  for (const gone of ["chat-adapters", "chat-narrator", "player-ui", "media-hook"]) {
    assert.ok(!fs.existsSync(path.join(root, "src", `${gone}.js`)), `${gone}.js should live in yappable (the AI chats extension)`);
  }
});

test("changelog contains the manifest release", () => {
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`\\[${manifest.version.replaceAll(".", "\\.")}\\]`));
});

test("ElevenLabs verification uses the current voices endpoint and distinguishes forbidden keys", async () => {
  let requestedUrl = "";
  const context = {
    AbortController,
    clearTimeout,
    setTimeout,
    fetch: async (url) => {
      requestedUrl = url;
      return { ok: false, status: 403 };
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "tts-provider.js"), "utf8"), context);
  const result = await context.YapTts.verify("test-key");
  assert.equal(requestedUrl, "https://api.elevenlabs.io/v2/voices?page_size=100");
  assert.equal(result.reason, "forbidden");
});

test("Flash v2.5 defaults to API-safe automatic text normalization", () => {
  for (const relative of ["popup/popup.js", "src/content.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /elevenTextNormalization:\s*"auto"/, relative);
  }
});

test("default popup does not load remote executable or flag assets", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:\/\//i);
  assert.doesNotMatch(js, /flagcdn\.com/i);
});

test("risk detector ignores proposals and flags completed risky work", () => {
  const proposal = global.LovableRisk.detectRisks({
    body: "I could update package.json and the database schema."
  }, "en-US");
  assert.equal(proposal.hasRisk, false);

  const completed = global.LovableRisk.detectRisks({
    body: "Implemented the package.json dependency and database schema update."
  }, "en-US");
  assert.equal(completed.hasRisk, true);
  assert.equal(completed.riskFlags[0].type, "build_risk");
});

test("IR extracts metrics, domains, and risk slots", () => {
  const ir = irBuilder.buildIR({
    id: "1",
    taskTitle: "Improve login",
    body: "Implemented login API changes and updated package.json.",
    structure: {
      intro: "Implemented login API changes.",
      sections: [{ title: "Authentication", items: ["Updated the session token."] }],
      expected: "Expected LCP from 20s to 3-4s."
    }
  }, { lang: "en-US" });

  assert.deepEqual(ir.domains.sort(), ["api", "auth", "performance"]);
  assert.equal(ir.metrics.length, 1);
  assert.equal(ir.metrics[0].from.value, "20");
  assert.equal(ir.metrics[0].to.value, "3-4");
  assert.ok(ir.slots.risk.some((slot) => slot.source === "build_risk"));
});

test("renderer handles fast, summary, full, and localized clear states", () => {
  const ir = irBuilder.buildIR({
    taskTitle: "Checkout",
    body: "Implemented checkout. Do you want me to deploy it?",
    structure: {
      intro: "Checkout is ready.",
      sections: [{ title: "Changes", items: ["Added validation."] }],
      expected: "Expected: fewer payment errors."
    }
  }, { lang: "en-US" });

  assert.equal(renderer.render(ir, { mode: "fast", lang: "en-US" }), "Do you want me to deploy it?");
  assert.match(renderer.render(ir, { mode: "beginner", lang: "en-US" }), /Checkout is ready/);
  assert.match(renderer.render(ir, { mode: "completo", lang: "en-US" }), /Added validation/);

  ir._body = "Everything is complete.";
  assert.equal(
    renderer.render(ir, { mode: "fast", lang: "pt-BR" }),
    "Pode seguir, nada depende de você por enquanto."
  );
});

test("speech shaping never leaks ElevenLabs markup to native speech", () => {
  const risk = [{ severity: "high", spokenNote: "Run the build." }];
  const ssml = speech.shape("Done. Run the build.", {
    lens: "risk",
    model: "eleven_flash_v2_5",
    riskFlags: risk
  });
  assert.match(ssml.eleven.text, /<break time="1\.2s"\/>/);
  assert.doesNotMatch(ssml.native.text, /<break|\[pause\]/);

  const v3 = speech.shape("Concluído. Run the build.", {
    lens: "risk",
    model: "eleven_v3",
    riskFlags: risk
  });
  assert.equal(v3.family, "v3tags");
  assert.match(v3.eleven.text, /\[long pause\]/);
  assert.doesNotMatch(v3.eleven.text, /<break/);
  assert.equal(speech.familyOf("eleven_v3_conversational"), "v3tags");
  assert.equal(speech.familyOf("eleven_v4"), "v3tags");
  assert.equal(speech.familyOf("eleven_v4_turbo"), "v3tags");
});

test("injected completion interceptor silences the sound and preserves other fetches", async () => {
  const messages = [];
  const delegated = [];
  class MediaElement {
    constructor(src = "") {
      this.src = src;
      this.currentSrc = src;
      this.muted = false;
      this.volume = 1;
      this.paused = false;
    }
    pause() { this.paused = true; }
    play() { return Promise.resolve("played"); }
  }

  const context = {
    ArrayBuffer,
    Blob,
    DataView,
    HTMLMediaElement: MediaElement,
    Promise,
    Response,
    window: {
      location: { origin: "https://lovable.dev" },
      postMessage: (payload, origin) => messages.push({ payload, origin }),
      fetch: async (...args) => { delegated.push(args); return new Response("ok"); }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "inject.js"), "utf8"), context);

  const silent = await context.window.fetch("https://lovable.dev/audio/generation-complete.mp3?v=1");
  assert.equal(silent.headers.get("content-type"), "audio/wav");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, "https://lovable.dev");

  const ordinary = await context.window.fetch("https://lovable.dev/api/project");
  assert.equal(await ordinary.text(), "ok");
  assert.equal(delegated.length, 1);
});

test("background seeds defaults, opens onboarding once, and counts project tabs", () => {
  let onInstalled;
  let onMessage;
  const syncWrites = [];
  const createdTabs = [];
  const context = {
    chrome: {
      i18n: { getUILanguage: () => "pt-BR" },
      runtime: {
        getURL: (relative) => `chrome-extension://test/${relative}`,
        onInstalled: { addListener: (fn) => { onInstalled = fn; } },
        onMessage: { addListener: (fn) => { onMessage = fn; } }
      },
      storage: {
        local: { get: (_defaults, cb) => cb({ onboardingDone: false }), set: (_val, cb) => { if (cb) cb(); } },
        sync: {
          get: (keys, cb) => {
            if (Array.isArray(keys)) cb({});
            else if (Object.prototype.hasOwnProperty.call(keys, "elevenModel")) cb({ elevenModel: "eleven_turbo_v2_5" });
            else cb({ lang: "" });
          },
          set: (value) => syncWrites.push(value)
        }
      },
      tabs: {
        create: (value) => createdTabs.push(value),
        query: (_query, cb) => cb([{ id: 1 }, { id: 2 }])
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "background.js"), "utf8"), context);

  onInstalled({ reason: "install" });
  assert.ok(syncWrites.some((value) => value.lang === "pt-BR"));
  assert.ok(syncWrites.some((value) => value.enabled === true && value.mode === "beginner"));
  assert.ok(syncWrites.some((value) => value.elevenModel === "eleven_flash_v2_5"));
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, "chrome-extension://test/popup/onboarding.html");

  let response;
  const keepOpen = onMessage(
    { __yappable: true, type: "countLovableTabs" },
    null,
    (value) => { response = value; }
  );
  assert.equal(keepOpen, true);
  assert.equal(response.count, 2);
});

test("popup loads and explicitly saves a local ElevenLabs key", async () => {
  class FakeClassList {
    constructor() { this.values = new Set(); }
    toggle(name, force) {
      if (force === false) this.values.delete(name);
      else if (force === true) this.values.add(name);
      else if (this.values.has(name)) this.values.delete(name);
      else this.values.add(name);
    }
    contains(name) { return this.values.has(name); }
  }
  class FakeElement {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.classList = new FakeClassList();
      this.dataset = {};
      this.listeners = {};
      this.hidden = false;
      this.checked = false;
      this.disabled = false;
      this.value = "";
      this.textContent = "";
      this.style = {};
    }
    get options() { return this.children.filter((child) => child.tagName === "OPTION"); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll(selector) {
      if (selector === ".dd-opt") return this.children.filter((child) => child.classList.contains("dd-opt"));
      return [];
    }
    scrollIntoView() {}
  }

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id.includes("Voice") ? "select" : "div"));
    return elements.get(id);
  };
  const modeInputs = ["fast", "beginner", "advanced", "completo"].map((value) => {
    const input = new FakeElement("input");
    input.value = value;
    return input;
  });
  const storageEvents = [];
  const context = {
    AbortController,
    Audio: class { play() { return Promise.resolve(); } pause() {} },
    SpeechSynthesisUtterance: class {},
    URL,
    clearTimeout,
    fetch: async () => { throw new Error("unexpected network call"); },
    navigator: { language: "en-US", languages: ["en-US"] },
    setTimeout,
    setInterval: () => 0,
    speechSynthesis: {
      cancel() {}, getVoices() { return []; }, pause() {}, resume() {}, speak() {}
    },
    addEventListener() {},
    document: {
      body: new FakeElement("body"),
      addEventListener() {},
      createElement: (tag) => new FakeElement(tag),
      getElementById: element,
      querySelector: () => new FakeElement("label"),
      querySelectorAll: (selector) => selector === 'input[name="mode"]' ? modeInputs : []
    },
    chrome: {
      runtime: { getURL: (value) => value, lastError: null },
      tabs: {
        query: (query, cb) => cb(query.active ? [{ id: 1 }] : []),
        sendMessage: (_id, _message, cb) => cb && cb(null)
      },
      storage: {
        onChanged: { addListener() {} },
        sync: {
          get: (_defaults, cb) => cb({ enabled: true, engine: "elevenlabs", lang: "en-US" }),
          remove: (key) => storageEvents.push(["remove-sync", key]),
          set: (value) => storageEvents.push(["set-sync", value])
        },
        local: {
          get: (key, cb) => {
            if (key === "elevenVoicesCache") {
              cb({ elevenVoicesCache: { key: "local-secret", voices: [{ id: "v1", name: "Voice" }] } });
            } else {
              cb({ elevenKey: "local-secret", debug: false });
            }
          },
          set: (value, cb) => { storageEvents.push(["set-local", value]); if (cb) cb(); }
        }
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8"), context);

  assert.equal(element("keyTxt").textContent, "Configured");
  assert.equal(element("elevenVoiceId").options.length, 1);
  assert.equal(element("elevenVoiceId").options[0].value, "v1");
  assert.equal(storageEvents.some(([type, value]) => type === "remove-sync" && value === "elevenKey"), false);

  context.YapTts = { verify: async () => ({ valid: false, reason: "network_error" }), requestAccess: async () => true, hasAccess: async () => true };
  element("elevenKey").value = "new-local-secret";
  await element("saveElevenKey").listeners.click();
  assert.ok(storageEvents.some(([type, value]) => type === "set-local" && value.elevenKey === "new-local-secret"));
  assert.match(element("msg").textContent, /Key saved/);
});

test("onboarding saves the ElevenLabs key before verification completes", async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "", disabled: false, hidden: false, type: "password",
        textContent: "", className: "", style: {}, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }
      });
    }
    return elements.get(id);
  };
  const localWrites = [];
  const context = {
    AbortController,
    clearTimeout,
    setTimeout,
    document: { getElementById: element },
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: { set: (value, cb) => { localWrites.push(value); if (cb) cb(); } },
        sync: { set: (_value, cb) => { if (cb) cb(); } }
      },
      tabs: {}
    },
    YapTts: { verify: async () => ({ valid: false, reason: "network_error" }), requestAccess: async () => true, hasAccess: async () => true }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "popup", "onboarding.js"), "utf8"), context);

  element("key").value = "onboarding-secret";
  await element("activate").listeners.click();
  assert.ok(localWrites.some((value) => value.elevenKey === "onboarding-secret"));
  assert.equal(localWrites.find((value) => value.elevenKey === "onboarding-secret").auth.providers.elevenlabs.status, "verifying");
  assert.match(element("statusTxt").textContent, /saved/);
});

test("current ElevenLabs speech models are visible and deprecated Turbo v2.5 is removed", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  for (const id of ["eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_v3_conversational", "eleven_multilingual_v2", "eleven_flash_v2_5"]) {
    assert.match(html, new RegExp(`value=["']${id}["']`));
  }
  assert.doesNotMatch(html, /value=["']eleven_turbo_v2_5["']/);
});

test("stop button is grey until Lovable audio plays", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  assert.match(html, /\.stop-btn\.live \{[^}]*var\(--danger\)/);
  assert.doesNotMatch(html, /\.stop-btn \{[^}]*color: var\(--danger\)/);
  assert.doesNotMatch(html.replace(/<a id="crossPromo"[\s\S]*?<\/a>/, ""), /tabPlatforms|viewPlatforms|chatgpt|claude|gemini|grok/i);
  assert.match(html, /<a id="crossPromo"[^>]*\bhidden\b/);
  const js = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(js, /audible: true/);
  assert.match(js, /LOVABLE_URLS/);
});

test("ElevenLabs verification does not call the API without the optional permission", async () => {
  let called = false;
  const context = {
    AbortController, clearTimeout, setTimeout,
    chrome: { runtime: {}, permissions: { contains: (_o, cb) => cb(false) } },
    fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "tts-provider.js"), "utf8"), context);
  assert.equal((await context.YapTts.verify("k")).reason, "no_permission");
  assert.equal(await context.YapTts.quota("k"), null);
  assert.equal(called, false);
});

test("audio cache key changes when any generation parameter changes", async () => {
  const context = { crypto, TextEncoder, btoa, atob };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "audio-store.js"), "utf8"), context);
  const S = context.YapAudioStore;
  const base = { text: "hi", voiceId: "v", model: "m", format: "mp3_44100_64", stability: 0.2, similarity: 0.2, style: 0.5, speed: 1.1, useSpeakerBoost: false, normalization: "auto", lang: "en" };
  const k0 = await S.keyFor(base);
  assert.equal(await S.keyFor({ ...base }), k0);
  const changes = { text: "hey", voiceId: "w", model: "n", format: "mp3_44100_128", stability: 0.3, similarity: 0.3, style: 0.6, speed: 1.0, useSpeakerBoost: true, normalization: "off", seed: 7, lang: "pt" };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(await S.keyFor({ ...base, [field]: value }), k0, field);
  }
});

test("audio cache evicts least recently used clips first, only until under the limit", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "audio-store.js"), "utf8"), context);
  const e = (key, bytes, lastUsed) => ({ key, bytes, lastUsed, audio: {} });
  const out = context.YapAudioStore.pickEvictions([e("a", 40, 3), e("b", 40, 1), e("c", 40, 2)], 80);
  assert.deepEqual(Array.from(out), ["b"]);
  assert.deepEqual(Array.from(context.YapAudioStore.pickEvictions([e("a", 40, 1)], 80)), []);
});

test("audio base64 helpers round-trip", () => {
  const context = { btoa, atob };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "audio-store.js"), "utf8"), context);
  const bytes = new Uint8Array(70000).map((_, i) => i % 251);
  const back = new Uint8Array(context.YapAudioStore.b64ToBuf(context.YapAudioStore.bufToB64(bytes.buffer)));
  assert.equal(back.length, bytes.length);
  assert.ok(back.every((v, i) => v === bytes[i]));
});

function loadStream(extra = {}) {
  const context = { setTimeout, clearTimeout, Uint8Array, ...extra };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src", "eleven-stream.js"), "utf8"), context);
  return context.YapElevenStream;
}
const bodyOf = (parts) => ({
  body: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } })
});

test("ElevenLabs streaming is used only for MP3 formats with MediaSource support", () => {
  const MediaSource = { isTypeSupported: (mime) => mime === "audio/mpeg" };
  const S = loadStream({ MediaSource });
  assert.equal(S.supported("mp3_44100_64"), true);
  assert.equal(S.supported("pcm_16000"), false);
  assert.equal(S.supported("opus_48000_64"), false);
  assert.equal(loadStream().supported("mp3_44100_64"), false, "no MediaSource -> full download");
});

test("ElevenLabs stream keeps every chunk and resolves the complete MP3 for the cache", async () => {
  const S = loadStream();
  const s = S.open(bodyOf([[1, 2], [3], [4, 5, 6]]));
  const buf = await s.done;
  assert.deepEqual(Array.from(new Uint8Array(buf)), [1, 2, 3, 4, 5, 6]);
  assert.equal(s.finished, true);
  assert.equal(s.bytes, 6);
});

test("an empty ElevenLabs stream fails instead of playing silence", async () => {
  const s = loadStream().open(bodyOf([]));
  await assert.rejects(s.done);
  assert.ok(s.failed);
});

test("a stalled ElevenLabs stream calls onStall", async () => {
  let stalled = false;
  let ctrl;
  const res = { body: new ReadableStream({ start(c) { ctrl = c; c.enqueue(new Uint8Array([1])); } }) };
  const s = loadStream().open(res, { stallMs: 20, onStall: () => { stalled = true; ctrl.error(new Error("aborted")); } });
  await assert.rejects(s.done);
  assert.equal(stalled, true);
});
