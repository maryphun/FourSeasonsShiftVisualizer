# Schedule Photo Reader

A local prototype UI for a shift schedule photo reader.

## Current phase

The app lets a user upload or drag in a shift photo, sends the image to Google Vision
through the local Node server, maps detected text into a table, and builds a cached
roster database from column A names and the month date columns.

The parsed roster, selected profile, and edited display names are stored in `localStorage`,
so a returning user skips upload and profile selection until they import a new photo.
The spreadsheet preview is hidden by default and can be opened with `Manually Edit Data`.

## Run local Google Vision app

For the current local prototype, paste your Google Vision API key into:

```text
server.local-config.mjs
```

Then start the server from this folder:

```powershell
npm.cmd install
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:5177
```

The key stays on the local Node server. The Vue app calls `/api/vision`, so the page no
longer asks for the API key on every upload.

You can also use a short-lived OAuth token instead:

```powershell
$env:GOOGLE_OAUTH_TOKEN="YOUR_SHORT_LIVED_GOOGLE_TOKEN"
npm.cmd run dev
```

## UI development

Tailwind CSS is compiled locally; no Tailwind CDN is required. `styles/app.css`
defines the theme, motion, and component refinements, and imports the existing
layout rules from `styles.css`. Both `npm.cmd run dev` and `npm.cmd run build`
generate `assets/app.css`. Run `npm.cmd run watch:css` in a second terminal while
editing styles. The generated stylesheet is not committed.

The month arrows include the month after the roster and at least the next calendar
month. Dates without roster data allow events but cannot edit a missing CSV shift.
Events remain keyed by full date in the existing local cache and reminder sync, so
uploading the next roster keeps those events. Run `npm.cmd test` for calendar and
event persistence checks.

## Google Vision mini test

Recommended: set a service account JSON key in your terminal, then run the standalone test script:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\service-account.json"
node tools/google-vision-test.mjs "C:\Users\phunm\Downloads\IMG_5315.JPG"
```

If your Google Cloud project accepts API-key auth, this can also work:

```powershell
$env:GOOGLE_API_KEY="YOUR_KEY"
node tools/google-vision-test.mjs "C:\Users\phunm\Downloads\IMG_5315.JPG"
```

The script writes raw OCR results to `vision-test-output/`.

## Deploy to Cloudflare

This project deploys as a Cloudflare Worker with Static Assets. Static files are staged
into `public/`, and `/api/vision` runs from `worker/index.js`.

Install dependencies:

```powershell
npm.cmd install
```

Build the safe public asset folder:

```powershell
npm.cmd run build
```

Set your Google Vision key as a Cloudflare secret:

```powershell
npx.cmd wrangler secret put GOOGLE_VISION_API_KEY
```

Create the D1 database used for daily event alerts:

```powershell
npx.cmd wrangler d1 create schedule-photo-reader-reminders
```

Copy the `database_id` from Wrangler's output into the `REMINDER_DB` binding in
`wrangler.jsonc`. `npm.cmd run deploy` applies D1 migrations automatically; to run
the migration by itself:

```powershell
npx.cmd wrangler d1 migrations apply REMINDER_DB --remote
```

Deploy:

```powershell
npm.cmd run deploy
```

Cloudflare will give you a free `*.workers.dev` URL after deployment.

Daily event alerts use a Worker cron trigger every 15 minutes. The Worker stores each
phone's next due reminder in D1 and sends only when that user's local notification time
is due. Cached reminder times are rounded to the nearest 15 minutes.
On iPhone, install the site to the Home Screen first, then enable alerts from the app.

## Frontend Structure

The dashboard uses the existing Vue runtime and Tailwind v4 CLI. Run `npm run
build:css` after CSS/component edits, or `npm run watch:css` while developing.

- Atoms: `UiIcon`, `UiAction`, and the date badge in `ui-components.js`.
- Molecules: shift reading and month navigation.
- Organisms: shift cards, the keyboard-accessible calendar, and monthly totals.
- Page template and data orchestration: `index.html` and `app.js`.
- Shared tokens and styles: `styles/tokens.css`, `atoms.css`, `schedule.css`,
  `surfaces.css`, and `motion.css`, compiled through `styles/app.css`.

Business data stays in the parent app; presentation components receive props and
emit actions. Modal focus is contained and returns to its trigger. The page stays
fixed to the viewport, with contained scrolling available on smaller screens.
Manrope is self-hosted with its license in `assets/Manrope-OFL.txt`.

## Automatic deploy from GitHub

The project includes a GitHub Actions workflow at `.github/workflows/deploy.yml`.
Every push to `main` will build the public assets and run `npm run deploy`.

Before the first automatic deploy, add these repository secrets in GitHub:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
GOOGLE_VISION_API_KEY
```

In GitHub, open the repository, then go to:

```text
Settings > Secrets and variables > Actions > New repository secret
```

Create a Cloudflare API token from:

```text
Cloudflare Dashboard > My Profile > API Tokens
```

The token needs permission to deploy Workers, such as `Workers Scripts Edit` on the
Cloudflare account that owns this Worker.

The GitHub workflow uploads the Google Vision key as a Cloudflare secret during deploy.
If you deploy manually under a new Worker name or a new Cloudflare account, set it again:

```powershell
npx.cmd wrangler secret put GOOGLE_VISION_API_KEY
```
