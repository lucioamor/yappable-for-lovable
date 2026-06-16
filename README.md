# Yappable — Make Lovable Talk Back

A Chrome extension that narrates completed [Lovable](https://lovable.dev) agent responses out loud, so you can stay in the flow without reading every reply.

> Lovable works fast. Reading keeps you anchored to the screen. Yappable frees your eyes.

---

## The Problem

Every time Lovable finishes a task, you have to stop what you're doing, switch focus to the chat, and read the response to know what happened and what comes next.

If you're testing the app in another window, sketching something, or just thinking — that context switch breaks your flow. And the longer the response, the more time it takes.

Yappable fixes this by reading the response to you the moment it's ready.

---

## Features

- **Narrates completed responses automatically** — no click needed, fires the instant the agent finishes
- **Four narration modes** — Fast (just the pending decision), Beginner (plain-language summary), Advanced (technical summary), Full (everything, verbatim)
- **On-device AI summarization** — uses Chrome's built-in Gemini Nano and Prompt API when available; no data leaves your machine for this step
- **Optional ElevenLabs voice** — premium TTS with your own voice and model settings
- **Silence monitoring** — speaks up if Lovable stalls mid-task
- **Error alert** — distinct chime when Lovable shows a "Try to fix" error that needs your click
- **Verbose mode** — reads live progress updates while Lovable is working
- **Multi-tab awareness** — prefixes the project name when you have more than one Lovable tab open
- **Risk detector** — flags unvalidated performance estimates, touched copy, build/schema changes, and SEO edits
- **100% local by default** — all processing runs in the browser; ElevenLabs is optional and opt-in
- **Minimal permissions** — only activates on `lovable.dev`

---

## How It Works

1. Open any project on [lovable.dev](https://lovable.dev)
2. Click anywhere on the page once (unlocks browser autoplay)
3. Send a message to Lovable and wait — Yappable narrates the response the moment it's done
4. Use the extension popup to choose a narration mode, switch engines, or adjust the voice

The extension intercepts Lovable's completion sound at the network level, uses it as a precise trigger, then reads the finished response text through the browser's Speech Synthesis API or ElevenLabs.

---

## Narration Modes

| Mode | What it reads |
|------|---------------|
| **Fast** | Only the pending decision or question. If nothing depends on you, says you're clear to continue. |
| **Beginner** *(default)* | Plain-language summary translating technical details into practical impact. |
| **Advanced** | Technical summary: verdict, risks, and the pending decision, keeping the terms. |
| **Full** | The entire agent response, read verbatim. |

---

## Installation

### Manual (Developer Mode)
1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder
5. Open any project on `lovable.dev` and click the page once to unlock audio

> After editing any source file, reload the extension at `chrome://extensions/` and refresh the Lovable tab.

---

## Privacy

All processing is local by default. Native speech and on-device AI summaries run entirely in the browser — Lovable response text never leaves your machine in this path.

If you add an ElevenLabs API key, only the final narration text is sent to ElevenLabs to generate audio. Your API key is stored in `chrome.storage.local` and is never synced across devices.

Full privacy policy: [docs/privacy-policy.md](docs/privacy-policy.md)

---

## File Structure

```
yappable/
├── manifest.json           # Extension configuration
├── rules.json              # Declarative Net Request rule (blocks completion sound)
├── src/
│   ├── background.js       # Service worker — tab counting, install seed
│   ├── content.js          # Observer, gate, extraction, TTS, queue
│   ├── inject.js           # MAIN world — intercepts fetch, emits completion signal
│   ├── ir-builder.js       # Builds Intermediate Representation from agent output
│   ├── renderer.js         # Renders IR → speakable text per narration mode
│   ├── risk-detector.js    # Flags unvalidated metrics, copy, build, SEO changes
│   └── silence-monitor.js  # Detects stalls and announces them via the narrator queue
├── popup/
│   ├── popup.html          # Extension popup UI
│   └── popup.js            # Popup logic and settings bridge
├── assets/
│   └── single-sound-message-icq-ooh.mp3  # Notification cue sound
├── icons/                  # Extension icons (16, 32, 48, 128px)
└── docs/
    └── privacy-policy.md
```

---

## License

MIT
