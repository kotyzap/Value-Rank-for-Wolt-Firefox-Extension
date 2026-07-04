# ValueRank for W — Firefox build

This folder is a Firefox port of the Chrome extension one level up. Ranking
logic, popup, and styling are identical; only two things changed to work on
Firefox:

1. **`manifest.json`** — dropped the `declarativeContent` permission (Firefox
   doesn't implement `chrome.declarativeContent`) and background is declared
   as `"scripts": ["background.js"]` instead of `"service_worker"`. Added a
   `browser_specific_settings.gecko` block (required by Firefox for storing
   an extension ID, and needed to sign/submit to addons.mozilla.org).
2. **`background.js`** — rewritten to enable/disable the toolbar icon by
   watching `tabs.onUpdated` / `tabs.onActivated` and checking the tab's
   hostname, instead of using `declarativeContent` page-match rules.

`content.js`, `content.css`, `popup.html`, `popup.js`, and the icons are
byte-for-byte copies of the Chrome version — they only use `chrome.storage`,
which Firefox supports natively via its `chrome.*` compatibility namespace.

## Load it temporarily (for testing)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file inside this `firefox/` folder.
4. Visit any `wolt.com` or `wolt.cz` category page (a URL containing
   `/items/`) to see it in action.

Temporary add-ons are removed when Firefox restarts, so repeat this each
session while testing.

## Package for real installation / AMO submission

With [web-ext](https://github.com/mozilla/web-ext) installed:

```bash
cd firefox
npx web-ext lint          # sanity-check the manifest and code
npx web-ext build         # produces a .zip in web-ext-artifacts/
```

To install permanently in a normal (non-Developer Edition/Nightly) Firefox,
the built zip must be signed by Mozilla. Either:

- Submit it at https://addons.mozilla.org/developers/ (self-distribution is
  fine — it doesn't need to be listed publicly), or
- Use `npx web-ext sign` with an AMO API key
  (see https://extensionworkshop.com/documentation/publish/self-distribution/).

Unsigned builds only load as temporary add-ons, or permanently in
Firefox Developer Edition / Nightly / ESR with
`xpinstall.signatures.required` set to `false` in `about:config`.

## Known behavior differences from Chrome

- Icon enable/disable now depends on `tabs.onUpdated`/`onActivated` firing
  correctly rather than Chrome's declarative page-match engine; behavior
  should be visually identical, but the icon may take one extra tick to grey
  out immediately after installation, before Firefox has reported any tab
  URLs yet.

## Lint status

`web-ext lint` passes with 0 errors. One warning remains
(`UNSAFE_VAR_ASSIGNMENT` on `content.js`'s `wrap.innerHTML = it.html`) — this
is inherent to the original design, which clones a real Wolt product card's
own `outerHTML` (not user-supplied input) to build the "top best value"
strip. It's unchanged from the Chrome version and safe in this context, but
worth knowing about if you submit to addons.mozilla.org, since AMO reviewers
flag it too.
