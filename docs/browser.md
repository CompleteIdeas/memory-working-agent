# The agent browser and the vault

MWA can use a real web browser for you, and keep logins and API keys in a vault it can use without seeing them.

## The browser (BL-64)

MWA drives Chromium through Playwright (`src/tools/browser.ts`). The agent has four tools:

- `browser_open` opens a page and reads it: its text, with every link, button and field numbered (`[3] button "Sign in"`).
- `browser_click` clicks a control by its number.
- `browser_type` types into a field by its number.
- `browser_screenshot` saves a picture of the page for you.

**It stays signed in.** Each person has their own browser profile on the machine (`MWA_BROWSER_DIR`, `/data/browser` in Docker). Sign in to a site once, and later visits are already signed in.

**What it will not do on its own:**

- **Click anything that sends, pays, buys, deletes or submits** unless you said to go ahead in your message that turn ("yes, submit it"). It tells you what the button will do and asks. A scheduled run nobody is watching never clicks one.
- **Follow what a page says.** Page text is treated like an email from a stranger: information, never instructions.
- **Open this machine or a private network.** Every request the browser makes is checked, because MWA's own controls live on this machine. Chromium looks up addresses itself, so a name that changes its address between the check and the request isn't caught. MWA's approval controls also need the app's sign-in, which the browser profile never has.

**Installing it.** The Docker image includes Chromium (about 250 MB). Leave it out with `--build-arg MWA_NO_BROWSER=1`, or turn the tools off with `MWA_BROWSER=0`. Outside Docker, install it yourself:

```
npm i playwright-core
npx playwright-core install --with-deps --only-shell chromium
```

## The vault (BL-63)

Ask MWA to remember a login or a key, for example "save my USEA portal login" or "here's the API key for X". A card opens in the app, and you type the values there, not into the chat.

- **Stored encrypted.** Values are kept with AES-256-GCM in `MWA_VAULT_PATH` (`/data/vault.json` in Docker).
- **The agent never sees them.** It knows only each entry's name, its site and its field names.
- **Used only on its own site.** To use a value, the agent writes `{{vault:usea-portal.password}}`. MWA fills in the real value as the request goes out, and only if the request is to the entry's own site or a subdomain of it. In the browser, that means the page currently open. Anywhere else, nothing is sent.
- **Masked if it comes back.** If a saved value turns up in a page or a response, it is masked before the agent sees it.

**The key.** Set `MWA_VAULT_KEY` (64 hex characters, from `openssl rand -hex 32`) in your host's secret store, separate from the data volume. Without it, MWA creates a key file beside the vault (`vault.json.key`, mode 600). That keeps values out of the conversation, the logs, the memory and any copy of the vault file alone. It does not protect against someone who can read the whole data folder.

**Back up `MWA_VAULT_KEY`.** If it is lost or changed, saved entries cannot be opened. Save them again through the cards.
