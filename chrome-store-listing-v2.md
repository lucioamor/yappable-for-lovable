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

---

## Detailed description

**Voice mode for Lovable. Hands-free. Always on.** 🎙️

Every time Lovable finishes a response, Yappable reads it back to you — out
loud, in your language, in the level of detail you choose. So you can keep
testing, sketching, reviewing, or just thinking, while the agent works in the
background.

─────────────────────────────────────────────

🔴 THE PROBLEM EVERY LOVABLE BUILDER KNOWS

You send a prompt. You switch tabs to test something. Or you start sketching
the next screen. Or you just look away for a second.

Then you come back — and now you have to re-read the whole response just to
know if it worked. Was that a success? A partial fix? Did it touch something
it shouldn't have? Is there a decision waiting for you?

That little context switch happens dozens of times a session. It adds up. And
no generic text-to-speech tool helps — they just dump raw text at you, full
of markdown noise, code paths, and filler, with no sense of what matters.

Yappable is built for Lovable specifically. It knows when Lovable is done. It
knows what a Lovable response looks like. And it speaks to you the way a
co-pilot would — not like a robot reading a file.

─────────────────────────────────────────────

🎛️ FOUR NARRATION MODES — PICK YOUR DEPTH

Switch anytime from the popup. No restart needed.

⚡ FAST
For builders who just need the verdict.
Gets straight to the point: is there a pending decision, or are you clear to
continue? Nothing else. Best when you're moving quickly and trust the agent.

🌱 BEGINNER
The default. Perfect if you're still learning Lovable.
Plain-language summary of what happened — no jargon, no technical terms. You
hear what changed, what it means for your project, and what to check. Like
having a patient co-builder explaining every move.

🛠️ ADVANCED
For experienced builders who want the full picture, fast.
Technical verdict, real risks, any pending decision — using the actual terms.
Schema changes, environment variables, API surface, performance claims. The
stuff that matters before you ship.

📖 FULL
When you need every word.
Reads the entire Lovable response verbatim. Great for long architectural
explanations, debugging sessions, or anything you'd normally read start to
finish. Slows down slightly for dense content, reads naturally.

─────────────────────────────────────────────

🧠 WHY YAPPABLE IS IN A DIFFERENT CATEGORY THAN ANY TTS TOOL

Generic text-to-speech reads what's on screen. Yappable understands what's
happening.

✅ Built for Lovable's response format — not a general-purpose reader
✅ Speaks in your language — not necessarily the language Lovable replied in
✅ Knows the difference between a success, a partial fix, and an error
✅ Flags the things you actually miss — performance claims, copy edits,
   schema changes, SEO updates — before you trust the green checkmark
✅ Narrates live while the agent is still working, not just when it's done
✅ Knows when Lovable goes silent — and tells you the real status, not just
   "in progress"
✅ Works with premium voice (ElevenLabs) or your browser's built-in voice
✅ On-device AI summarization using Chrome's built-in Gemini Nano —
   nothing leaves your machine for that step

─────────────────────────────────────────────

🚀 HOW TO GET STARTED — 3 STEPS

**Step 1 — Install and open Lovable**
Pin the Yappable icon to your toolbar. Open any project on lovable.dev.
The extension activates automatically — no setup required to try it.

**Step 2 — Configure your preferences (inside the popup)**
Click the Yappable icon in your toolbar. You'll find:
• Your narration mode selector (Fast / Beginner / Advanced / Full)
• Language picker — choose the language Yappable speaks in
• Voice selector — browser native or ElevenLabs
• Optional: paste your ElevenLabs API key for premium voice quality.
  Verification is instant. Your key never leaves your device.

**Step 3 — Send a prompt and keep working**
That's it. The moment Lovable finishes, Yappable speaks. You don't have to
click anything, switch tabs, or check in. Just listen.

─────────────────────────────────────────────

📡 LIVE NARRATION — STAY INFORMED WHILE IT'S STILL BUILDING

Turn on **Verbose Mode** to hear Lovable's background task steps in real
time — each step narrated as it happens, not just the final result. Great for
long builds where you want to stay oriented without watching the screen.

The silence monitor also watches for stalls. If Lovable goes quiet mid-task,
Yappable speaks up with the real status, elapsed time, and the task name —
so you always know what's happening, even when nothing appears to be moving.

─────────────────────────────────────────────

🌍 SPEAKS YOUR LANGUAGE — EVEN WHEN LOVABLE DOESN'T

Lovable may switch between English and Portuguese (or any other language) mid-
session. Yappable normalizes everything into the language you chose — narration,
live progress updates, and alerts. One consistent voice, one consistent language,
no matter what the agent replies in.

Translation runs on-device via Chrome's built-in APIs. Nothing is sent to an
external service for this step.

─────────────────────────────────────────────

🔍 PRE-SHIP CHECKS — YAPPABLE FLAGS WHAT YOU'D MISS

Before you trust the green checkmark, Yappable watches for:

⚠️ Unvalidated performance claims ("it's now faster" with no proof)
⚠️ UI copy that was silently changed
⚠️ Database schema edits or migrations
⚠️ SEO metadata that was touched
⚠️ Build configuration or environment variable changes

You hear a flag when any of these appear — so you know where to look before
you move on.

─────────────────────────────────────────────

🎙️ PREMIUM VOICE WITH ELEVENLABS

The browser's built-in voice works great. But if you want something that sounds
natural — especially during long sessions — Yappable supports ElevenLabs voice
generation.

• Bring your own ElevenLabs API key
• Paste it once inside the popup — verification is instant
• Your key is stored in chrome.storage.local, never synced, never shared
• Only the final narration text is sent to ElevenLabs to generate audio

─────────────────────────────────────────────

─────────────────────────────────────────────
🧩 EVERYTHING ELSE

✔️ Animated waveform bar while speaking — visual confirmation it's running
✔️ Repeat button — replay the last narration anytime
✔️ Instant stop — silence it mid-sentence
✔️ Multi-tab awareness — says the project name when multiple Lovable tabs
   are open, so you always know which project is speaking
✔️ Error chime — a distinct sound when Lovable throws a "Try to fix" state
   that needs your click, different from the normal done signal
✔️ Clean first-run onboarding — full-screen setup the first time you open it

─────────────────────────────────────────────

🛡️ PRIVACY — LOCAL BY DEFAULT

Everything runs in your browser by default. Native speech, on-device AI
summaries, and on-device translation never send your Lovable data anywhere.

The extension activates only on Lovable. It requests only the permissions
it actually needs. No background tracking, no analytics, no data collection.

If you use ElevenLabs: only the final cleaned narration text is sent — not
the raw Lovable response. Your API key is stored locally and never synced.

─────────────────────────────────────────────

🧑‍💻 WHO THIS IS FOR

🏗️ **Builders moving fast** — you need to know what changed and whether
   you're clear to keep going, without stopping to read a wall of text.

🌱 **Beginners learning Lovable** — Yappable explains every response in
   plain language, so you always understand what the agent did and what
   comes next.

🎧 **Multitaskers** — you test, sketch, write, review, and ship while
   Lovable works. Yappable keeps you informed without pulling you back.

🏢 **Agencies and teams** — multiple tabs, multiple projects, one voice
   layer that stays consistent across all of them.

─────────────────────────────────────────────

⚠️ NOT AN OFFICIAL LOVABLE PRODUCT

Yappable is an independent community extension. It is not affiliated with,
endorsed by, or sponsored by Lovable. It works *with* Lovable — built by a
builder, for builders.

🛠️ Created by **Lucio Amorim** — Lovable Ambassador and full-stack builder
who got tired of switching tabs to read the same response twice. Open source
on GitHub. Contributions and bug reports welcome.

─────────────────────────────────────────────

Lovable moves fast. Yappable makes sure you do too. 🚀

---

## What's new (v1.3.0)

**Lovable-only, lighter permissions.**

- 🔒 **Only Lovable + ElevenLabs** — chat narration for ChatGPT, Claude, Gemini and Grok now lives in its own extension, Yappable.
- ⏹️ **Smarter Stop button** — grey when idle, red only while something is speaking.
- 📊 **Daily stats** on the main screen (words, minutes, narrations).
