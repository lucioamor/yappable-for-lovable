# Yappable for Lovable — Every build, debriefed

Natural voice companion for [Lovable](https://lovable.dev) that briefs you audibly on every prompt — what changed, why it matters, and what to do next. Selectable interpretation according to user experience, from beginners to advanced builders.

*Independent extension for Lovable builders.*

> Lovable ships fast. Reading keeps your eyes glued to the chat. **Yappable frees them.**

It's not a screen reader. It's a co-pilot that tells you **what changed, why it matters, and what to double-check** — in a few seconds of natural speech, with the markdown, file paths, and symbol noise stripped out.

---

## The Problem

Every time Lovable finishes a task, you stop, switch focus to the chat, and read the response to figure out what happened and what's next.

If you're testing the app in another window, sketching, or just thinking — that context switch breaks your flow. The longer the response, the worse it gets.

Yappable reads the response to you the instant it's ready. You keep building.

---

## What Makes It Different

Most "read aloud" tools just dump the text into a TTS engine. Yappable **interprets** the output before speaking it:

- Strips markdown, code fences, file names, and symbols that work on screen but sound like static.
- Restructures the response into the order your brain actually wants: **status → what was done → why it matters → what to validate.**
- Speaks in **your language**, always — Lovable often mixes Portuguese and English in the same session; Yappable normalizes everything to the language you picked.
- Narrates **live progress** as tasks run, not just the final result.

Reading is a commodity. Knowing *what's happening right now and where to look* is the product.

---

## Features

- **Auto-narrates completed responses** — fires the instant the agent finishes, no click required
- **Four narration modes** — Fast, Beginner, Advanced, Full (see below)
- **On-device AI summarization** — uses Chrome's built-in Gemini Nano + Prompt API when available; nothing leaves your machine for this step
- **Optional ElevenLabs voice** — premium TTS with your own voice and model settings (opt-in)
- **Always in your language** — all speech (narration, progress, alerts) is translated on-device to the language you selected during onboarding, regardless of what language Lovable outputs
- **Verbose mode** — reads the background-task widget in real time: task label once, then every description change verbatim as it happens
- **Live status** — silence monitor reads the actual on-screen status word ("Transcribing", "Generating") instead of a generic phrase
- **Silence monitoring** — speaks up if Lovable stalls mid-task, with elapsed time and task label
- **Error alert** — distinct chime when Lovable surfaces a "Try to fix" error that needs your click
- **Animated waveform bar** — optional visual feedback at the top of the page while narrating (toggle in popup)
- **Multi-tab awareness** — prefixes the project name when you've got more than one Lovable tab open
- **100% local by default** — all processing runs in the browser; ElevenLabs is optional
- **Minimal permissions** — only activates on `lovable.dev`

---

## Narration Modes

| Mode | What it reads |
|------|---------------|
| **Fast** | Only the pending decision or question. If nothing depends on you, it tells you you're clear to continue. |
| **Beginner** *(default)* | Plain-language summary that translates technical detail into practical impact. |
| **Advanced** | Technical summary — verdict, risks, and the pending decision, keeping the terms. |
| **Full** | The entire agent response, read verbatim. |

---

## How It Works

1. Open any project on [lovable.dev](https://lovable.dev)
2. Click anywhere on the page once (unlocks browser autoplay)
3. Send a message to Lovable — Yappable narrates the response the moment it's done
4. Use the popup to switch modes, change engines, or tune the voice

Under the hood: Yappable detects Lovable's completion sound at the network level and uses it as a precise "the agent is done" trigger, then runs the finished response text through its interpreter and speaks it via the browser's Speech Synthesis API or ElevenLabs.

---

## Installation

### Manual (Developer Mode)

1. Clone or download this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder
5. Open any project on `lovable.dev` and click the page once to unlock audio

> After editing any source file, reload the extension at `chrome://extensions/` and refresh the Lovable tab.

The default path (native speech + on-device summary) needs **no account and no API key**. ElevenLabs is entirely optional.

---

## Privacy

All processing is local by default. Native speech and on-device AI summaries run entirely in the browser — Lovable response text never leaves your machine in this path.

If you add an ElevenLabs API key, only the final narration text is sent to ElevenLabs to generate audio. Your key is stored in `chrome.storage.local` and is never synced across devices or sent anywhere else.

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

## More tools for Lovable builders

- **Lovable Skills** — https://github.com/lucioamor/lovable-skills/
- **Lovable Chat Exporter** — https://github.com/lucioamor/lovable-chat-exporter
- **Lovable Co-Pilot (Prompt Assistant GPT)** — https://chatgpt.com/g/g-68556719564081918997f266b3ddf952-lovable-co-pilot-prompt-assistant-v4-3-2026-05-21

---

## License

Open and free to use, all rights reserved. You may install and use Yappable for
Lovable at no cost, but you may **not** modify/remix, redistribute, or resell it.
See [LICENSE](LICENSE) for full terms.

*Independent extension for Lovable builders. Not affiliated with, endorsed by, or sponsored by Lovable.*
