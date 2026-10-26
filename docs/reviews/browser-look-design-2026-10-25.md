# Letting the model see the page — design note (2026-10-25)

Robert: "they need to be able to sort of 'see'". Today a page reaches the model only as text with numbered controls
(src/tools/browser.ts `describe`). The review's failures that text cannot fix: a consent wall inside an iframe that
fills the screen but is absent from the snapshot (F13); a page that "looks empty" because its content is drawn by
script or sits in a frame; a layout question ("which of these is the main story?") that the text order answers wrong.

## What exists
- `browser_screenshot` already saves a PNG of the viewport to the run's folder (for the person, in Files).
- Every provider call is text only: `ChatMessage.content: string` (src/provider.ts:23); the Anthropic, OpenAI-style
  and OpenRouter paths all do `messages.map((m) => ({ role: m.role, content: m.content }))` (lines 172, 205, 272, 478).
- The agent rebuilds one user message per step (`brain.chat({ system: runSystem, messages: [{ role: 'user', content:
  prompt }] })`, agent.ts:1324); tool results enter the history as fenced text (agent.ts:2082).
- Models: GPT-6.1 Sol and the Claude models take images; GPT-6 Luna and most local models do not.

## The change (about a day)
1. **Provider: image parts.** `ChatMessage.content: string | Array<{ type: 'text'; text: string } | { type: 'image';
   mime: 'image/jpeg' | 'image/png'; data: string /* base64 */ }>`. Each provider maps the array: Anthropic →
   `{type:'image', source:{type:'base64', media_type, data}}`; OpenAI-style and OpenRouter → `{type:'image_url',
   image_url:{url:'data:<mime>;base64,<data>'}}`; Ollama → `images:[data]` on the message; a provider or model that
   cannot take images drops the image part and appends "(a screenshot was attached but this model cannot see images)".
   A `supportsImages(model)` reading from the provider's model list (OpenRouter `architecture.input_modalities`) gates it.
2. **Tool: `browser_look`.** Takes the open page's screenshot (viewport, 1280×900), scales to ≤1024 px wide JPEG
   quality 70 (~80–150 KB, roughly 800–1,500 input tokens on current pricing), and returns text
   "(looking at the page: <title> — <url>)" plus a side channel: the registry's `callDetailed` result gains an optional
   `image` ({ mime, data }). The agent attaches that image to the NEXT model call only (one step), as a user content
   part after the prompt text, with a line "SCREENSHOT of the open page, as a reader would see it; the numbered
   controls in the text are the same page". It is never kept in history (no re-paying it every step).
3. **Budget and rules.** At most `MWA_BROWSER_LOOKS` (default 3) looks per run; refused beyond that with a note. Only
   when the brain's current model supports images; otherwise the tool says so and suggests browser_scroll /
   browser_page. The browsing guide tells the model when to look: the snapshot reads like a consent notice or is
   nearly empty, a control it expects is not listed, or the question is about layout or an image. Taint: a
   screenshot is outside content like the page text; it does not change the taint state (already tainted by
   browser_open).
4. **Safety.** The image goes only to the configured provider (same data-handling rules as the page text: US hosts,
   `data_collection: deny` on OpenRouter). Vault values on screen: `redactVault` cannot mask pixels, so a look is
   refused while a password box on the page is non-empty (check `input[type=password]` values via the page) — the
   review proved the demo site prints the password in its body; a screenshot would carry it to the model.
5. **Measurement.** Rerun the review's S7 cases (BBC consent wall, infinite scroll "Loading…", a PDF link) and S6
   (screenshot) with looks on vs off, Sol; count passes and $ per task. Expect the consent-wall case to flip.

## Not in scope
- Per-step vision (every call with a screenshot): too costly and the text snapshot already carries the controls.
- Vision for Luna or local models: gated off until a model that takes images is the cheap tier.
- Drawing on the screenshot (numbered boxes): a nice-to-have once looks are measured useful.
