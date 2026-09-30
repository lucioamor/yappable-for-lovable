# Yappable Privacy Policy

Last updated: 2026-09-29

Yappable is a Chrome extension that narrates completed AI replies aloud: Lovable agent responses, and replies in the ChatGPT, Claude, Gemini and Grok chat apps.

## Information Yappable Processes

Yappable reads completed agent message text and task titles from `https://lovable.dev/*` pages so it can create spoken narration and show the latest observed output in the popup.

Yappable stores extension settings, the latest observed output, optional ElevenLabs settings, and optional ElevenLabs voice metadata in Chrome extension storage.

## Chat Sites (ChatGPT, Claude, Gemini, Grok)

On `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://claude.ai/*`, `https://gemini.google.com/*` and `https://grok.com/*`, Yappable reads the text of the **assistant's latest reply** once it has finished, so it can read it aloud. It does not read your prompts, your conversation list, or your account details, and it does not store reply text.

Two voice modes exist:

- **Site voice**: Yappable presses the site's own "read aloud" control, so the reply is spoken by that site's text-to-speech service, the same service you are already using. On Claude and Gemini, Yappable can change the text the site sends to its own text-to-speech request (to add a spoken "reply from…" prefix, or to send a shorter on-device summary instead of the full reply). ChatGPT and Grok read the stored reply on their servers, so Yappable cannot change what they read.
- **Yappable voice**: the reply is optionally shortened on your device (Chrome Built-in AI) and spoken by your browser's native voice, or by ElevenLabs if you enabled it (see below).

Yappable also remembers, in Chrome extension storage, your voice mode, the player speed, and whether the spoken prefix is on.

## Local Processing

By default, Yappable uses native browser speech. The Chrome Built-in AI / Gemini Nano summary path runs locally in the browser when available. Yappable does not send Lovable or chat-site reply text to a remote summarization service.

Yappable does not load remote scripts, remote stylesheets, or remote fonts.

## Optional ElevenLabs Processing

If you add an ElevenLabs API key and select ElevenLabs as the active voice engine, Yappable sends the final narration text (a Lovable narration or a chat-site reply, as it will be spoken) and voice settings to ElevenLabs to generate audio. Your ElevenLabs API key is stored in `chrome.storage.local` and is sent to ElevenLabs only for API authentication.

## Affiliate Links

Yappable may show optional outbound affiliate links to Lovable and ElevenLabs. These links are not required to use Yappable's core narration features.

If you click an affiliate link, your browser opens the destination website. The destination may receive the affiliate URL and its `utm_source=yappable` parameter. Yappable uses `rel="noopener noreferrer"` on affiliate links and does not store affiliate-link click history.

## What Yappable Does Not Do

Yappable does not collect analytics, sell data, run ad networks, retarget users, broker data, determine credit-worthiness, read Lovable credentials, or track browsing outside `https://lovable.dev/*` and the chat sites listed above.

## Data Sharing

Yappable shares data only with ElevenLabs when you enable and configure the ElevenLabs voice engine. In site-voice mode, the reply text goes to the chat site you are already using, through that site's own read-aloud request. Otherwise, Yappable does not share message text with third-party services.

Optional affiliate links are outbound links. They do not send Lovable message text, Yappable settings, or your ElevenLabs API key.

## Data Deletion

You can remove the ElevenLabs API key from the Yappable settings modal. You can also clear all Yappable settings and cached data by removing the extension or clearing the extension's stored data in Chrome.

## Limited Use

Yappable uses information only to provide its single purpose: narrating completed AI replies (Lovable and the supported chat apps). Yappable's use of information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.
