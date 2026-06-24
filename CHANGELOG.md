# Changelog

All notable changes to **Yappable for Lovable** are documented here.
This project adheres to [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Changed

- Risk flags are now spoken according to narration mode: none in Fast, the
  highest-severity flag in Beginner/Advanced, and all flags in Full.
- Live progress translation waits briefly for the task description to settle
  and serializes model sessions so only the latest state is processed.
- Background-task widget extraction is shared by narration and silence
  monitoring.

### Fixed

- Cue volume now defaults consistently to `0.8` in the popup, content script,
  and install seed.
- Removed the unused legacy speech-shaping module.

---

## [0.3.0] — 2026-06-23

### Added

- Progressive ElevenLabs MP3 playback through a Manifest V3 offscreen document.
- Persistent IndexedDB audio cache keyed by text, voice, model, format, voice settings, seed, normalization, and language.
- Local narration history with replay, download, copy, source-page, and independent audio/record deletion controls.
- Configurable streaming, cache, history, full-text retention, and LRU cache-size settings.
- Explicit full-MP3 retry after a streaming failure.

### Changed

- ElevenLabs now defaults to `eleven_flash_v2_5` with `mp3_44100_128` output.
- Streaming and full-MP3 fallback now resolve `output_format` from the user's centrally saved quality setting; neither playback path chooses or overrides a bitrate independently.
- Completed streamed audio is saved locally for zero-character replay when caching is enabled.

---

## What's new in 0.2.0 — *Speaks your language, narrates live*

The biggest update since launch. v0.2.0 turns Yappable from a "read the final
answer" tool into a running commentary on your build — in your language, the
whole way through.

- **🌍 Always in your language.** Lovable often mixes Portuguese and English in
  the same session. Yappable now translates *everything* it says — narration,
  live progress, and alerts — on-device into the language you pick, no matter
  what language Lovable replies in.
- **🎬 Live play-by-play.** Verbose mode now reads Lovable's background-task
  widget in real time: the task label once, then each step as it actually
  happens — instead of waiting for the final response. Near-duplicate steps are
  skipped so you don't hear the same thing twice.
- **🔊 Knows what Lovable is doing.** The silence monitor reads the real
  on-screen status word ("Transcribing", "Generating") with elapsed time and the
  task label, instead of a generic "in progress."
- **👋 First-run onboarding.** A clean full-screen setup opens on install: drop
  in an ElevenLabs key (verified on the spot) for premium voice, or continue on
  the built-in native voice in one click. Your language is set up front.
- **🎚️ Voice & engine overhaul.** A Native / ElevenLabs engine badge right in
  the popup, a language flag pill in the topbar, native voices filtered to your
  language, and much better ElevenLabs defaults out of the box.
- **📊 Animated waveform bar.** Optional visual feedback at the top of the page
  while Yappable is speaking (toggle in the popup).
- **↩ Repeat button & instant stop.** Replay the last narration anytime, and
  flipping narration off stops speech immediately across every Lovable tab.

---

## [0.2.0] — 2026-06-18

### Added

- **On-device translation of all speech.** Narration, verbose progress, silence
  and error alerts are normalized to the user-selected language regardless of
  the language Lovable outputs, so mixed-language sessions read cleanly.
- **First-run onboarding flow** (`popup/onboarding.html` + `onboarding.js`):
  branded full-screen setup that opens automatically on install. Captures and
  verifies an ElevenLabs API key against `GET /v1/voices`, caches the returned
  voices, and activates the ElevenLabs engine — or "Use native voice for now"
  skips it. Marks `onboardingDone` so it never reopens; `background.js` launches
  it once on `reason === "install"`.
- **Real-time background-task narration.** Verbose mode reads Lovable's new
  background-task widget verbatim: the task label is spoken once, then every
  description change is read as it happens.
- **Live status word in silence monitoring.** The monitor now announces the
  actual on-screen status ("Transcribing", "Generating", …) along with elapsed
  time and the task label, rather than a generic phrase.
- **Animated waveform bar** — optional on-page visual feedback while narrating,
  toggleable from the popup.
- **Repeat (↩) button** in the popup topbar — replays the last narration via
  `triggerNarrateNow()`.
- **Engine indicator badge** (Native / ElevenLabs) in the popup hero card;
  clicking it opens and scrolls to the Voice & engine settings.
- **Language flag pill** in the topbar using real PNG flags (flagcdn.com),
  replacing text country codes that rendered as blank squares on Windows Chrome.

### Changed

- **Stop-on-disable.** Turning narration off now sends `LN_STOP_NOW` directly to
  all `lovable.dev` tabs (faster than waiting on storage propagation; the
  `storage.onChanged` path remains as a backup), and the content script responds
  with an immediate `stopSpeaking()` + `clearPreview()`.
- **Clearer popup state.** The hero card border/glow switches from amber to green
  when narration is ON; every control below the hero (mode, sounds, voice config,
  language, repeat) fades to grey and is disabled when narration is OFF.
- **Language selector** moved out of the Settings modal into the topbar as a
  compact flag pill; auto-detect now resolves to a concrete, pre-selected real
  language code that persists (no fake "Auto" option).
- **Sounds & alerts** is now a flat, always-visible section (the accordion and
  buggy state chips were removed); "Sound before speech" is now "Ping first".
- **Native voice list** is filtered to the selected language (exact region first,
  then same base language), ordered Google → Microsoft → rest, and falls back to
  the full list when nothing matches.
- **ElevenLabs defaults retuned** for a better out-of-the-box voice: Model shown
  above Voice, Flash v2.5 marked Recommended and set as default, default voice
  Jessica, stability 0.2, similarity 0.2, style 0.5, speed 1.10, speed slider
  raised to 3.0; the Test button was removed. Defaults synced in `content.js`.

### Fixed

- **Near-duplicate progress steps no longer repeat.** In verbose mode,
  descriptions sharing ≥65% of significant words (Jaccard similarity) are
  silently dropped, and the comparison is always made against the last *spoken*
  line rather than the last *seen* one.
- Language flag pill rendering as blank squares on Windows Chrome (now real PNG
  flags).

---

## [0.1.0] — 2026-06-05

Initial public release.

### Added

- **Auto-narration** of completed Lovable responses, triggered the instant the
  agent finishes by detecting Lovable's completion sound at the network level.
- **Four narration modes** — Fast, Beginner (default), Advanced, Full.
- **Interpreter pipeline** that strips markdown, code fences, file paths, and
  symbols, then restructures output into status → what was done → why it matters
  → what to validate.
- **Risk detector** — flags unvalidated performance metrics, touched copy,
  build/schema changes, and SEO edits.
- **On-device AI summarization** via Chrome's built-in Gemini Nano + Prompt API
  when available.
- **Optional ElevenLabs voice** for premium TTS.
- **Silence monitoring**, **error alert** chime, **verbose mode**, and
  **multi-tab awareness** (project name prefix when multiple Lovable tabs are
  open).
- Local-by-default privacy posture; activates only on `lovable.dev`.

[0.2.0]: https://github.com/lucioamor/yappable-for-lovable
[0.1.0]: https://github.com/lucioamor/yappable-for-lovable
