# Chrome Web Store — Listing Copy

Copy/paste source for the Yappable for Lovable store listing. Keep this in
sync with `manifest.json`, `README.md`, and `CHANGELOG.md`.

---

## Name (max 75 chars)

```
Yappable for Lovable: voice mode that reads chat & talks back
```

## Short description (max 132 chars)

```
Voice mode for Lovable: reads every build aloud, hands-free, in your language. Native or ElevenLabs voices.
```

> SEO note: the **name** and **short description** are the strongest ranking
> signals. Front-load the search terms users actually type — *talks back, read
> aloud, voice, hands-free, narrates, speaks, audio updates* — in the first two
> lines of the detailed description below, since that's the part the store
> indexes most heavily.

---

## Detailed description

**A voice companion for Lovable that talks back.** Yappable reads every build
aloud the instant Lovable finishes — what changed, why it matters, and what to
do next — so you can keep testing, sketching, or thinking without breaking flow
to read the chat. Hands-free voice updates, in your language, on every prompt.

It's not a screen reader. Most "read aloud" tools just dump text into a TTS
engine. Yappable **interprets** the output first: it strips markdown, code
fences, file paths, and symbol noise, then restructures what's left into the
order your brain actually wants — **status → what was done → why it matters →
what to validate** — and speaks it in a few seconds of natural voice.

### What it does

- **Talks back automatically.** Narrates the response the moment the agent
  finishes — no clicking, no copy-paste.
- **Always in your language.** Lovable often mixes English and your native
  language in one session. Yappable translates everything it says — narration,
  live progress, and alerts — on-device into the language you pick.
- **Live play-by-play.** In verbose mode it reads Lovable's background-task
  widget in real time: the task label once, then each step as it happens —
  instead of waiting for the final answer. Near-duplicate steps are skipped.
- **Knows what Lovable is doing.** The silence monitor reads the real on-screen
  status word ("Transcribing", "Generating") with elapsed time and the task
  label, instead of a generic "in progress."
- **Four narration modes** — Fast, Beginner (default), Advanced, and Full — so
  you control the level of detail.
- **Risk detector.** Flags responses that touch unvalidated metrics, UI copy,
  database changes, or SEO adjustments.
- **On-device AI summarization.** When available, uses Chrome's built-in Gemini
  Nano to summarize before narrating — no data leaves the browser.
- **Optional premium voice** via ElevenLabs (bring your own key), streamed so it
  starts speaking in a moment, with any ElevenLabs model (Flash, v3, v4, v4 Turbo).
- **Never pay twice for the same audio.** Generated ElevenLabs audio is cached on
  your device, with a narration history to replay, download or copy.
- **Animated waveform bar**, repeat button, instant stop, multi-tab awareness,
  and a clean first-run onboarding.

### Privacy

100% local by default. Native speech and on-device AI summaries run entirely in
the browser — your Lovable response text never leaves your machine on this path.
ElevenLabs is optional; if enabled, only the final narration text is sent to
generate audio, and your key is stored locally and never synced. ElevenLabs
access is an optional permission, asked only when you turn it on. The audio cache
and history stay on your device, and you can turn them off or clear them anytime.

Activates only on Lovable, and makes no
unnecessary network requests.

*Independent extension for Lovable builders. Not affiliated with, endorsed by,
or sponsored by Lovable.*

---

## What's new (v1.4.0)

**Faster premium voice, fewer permissions.**

- ⚡ **Streaming ElevenLabs audio** — narration starts on the first audio chunks instead of after the whole file. Works with Flash v2.5, v3, v3 Conversational, v4 and v4 Turbo.
- 💾 **Local audio cache + history** — the same narration is never generated (or billed) twice; replay, download or copy past narrations in Settings.
- 🔒 **ElevenLabs is now an optional permission** — asked only when you turn it on. The install prompt only mentions Lovable.

## What's new (v1.3.0)

**Lovable-only, lighter permissions.**

- 🔒 **Only Lovable + ElevenLabs** — chat narration for ChatGPT, Claude, Gemini and Grok now lives in its own extension, Yappable.
- ⏹️ **Smarter Stop button** — grey when idle, red only while something is speaking.
- 📊 **Daily stats** on the main screen (words, minutes, narrations).
