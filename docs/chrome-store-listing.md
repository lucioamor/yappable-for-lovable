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
Lovable extension that talks back: reads every build aloud — what changed, why it matters, next steps. Hands-free voice updates.
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
- **Optional premium voice** via ElevenLabs (bring your own key).
- **Animated waveform bar**, repeat button, instant stop, multi-tab awareness,
  and a clean first-run onboarding.

### Privacy

100% local by default. Native speech and on-device AI summaries run entirely in
the browser — your Lovable response text never leaves your machine on this path.
ElevenLabs is optional; if enabled, only the final narration text is sent to
generate audio, and your key is stored locally and never synced.

Activates only on `lovable.dev` and makes no unnecessary network requests.

*Independent extension for Lovable builders. Not affiliated with, endorsed by,
or sponsored by Lovable.*

---

## What's new (v1.0.0)

**Speaks your language, narrates live — now stable.**

- 🌍 **Always in your language** — narration, live progress, and alerts are
  translated on-device to the language you choose, no matter what Lovable
  replies in.
- 🎬 **Live play-by-play** — verbose mode reads the background-task widget step
  by step as it happens, skipping near-duplicates, instead of waiting for the
  final response.
- 🔊 **Knows what Lovable is doing** — the silence monitor reads the real status
  word ("Transcribing", "Generating") with elapsed time and task label.
- 👋 **First-run onboarding** — clean full-screen setup: drop in an ElevenLabs
  key (verified on the spot) for premium voice, or continue on the built-in
  native voice in one click.
- 🎚️ **Voice & engine overhaul** — Native / ElevenLabs badge in the popup,
  language flag pill, native voices filtered to your language, better
  ElevenLabs defaults.
- 📊 **Animated waveform bar**, **↩ repeat button**, and **instant stop** across
  every Lovable tab.
- 🛠️ **Stability & polish** — transparent toolbar icon, network timeouts so
  setup and audio never get stuck, a native-narration stall fix, locally
  bundled language flags (works offline), and a dependency-free QA suite.
