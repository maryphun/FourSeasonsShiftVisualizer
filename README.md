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
node server.mjs
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
node server.mjs
```

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

Deploy:

```powershell
npm.cmd run deploy
```

Cloudflare will give you a free `*.workers.dev` URL after deployment.

## Automatic deploy from GitHub

The project includes a GitHub Actions workflow at `.github/workflows/deploy.yml`.
Every push to `main` will build the public assets and run `npm run deploy`.

Before the first automatic deploy, add these repository secrets in GitHub:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
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

The Google Vision runtime secret is stored in Cloudflare, not GitHub. If you deploy under
a new Worker name or a new Cloudflare account, set it again:

```powershell
npx.cmd wrangler secret put GOOGLE_VISION_API_KEY
```
