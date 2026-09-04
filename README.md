# Schedule Photo Reader

A local prototype UI for a shift schedule photo reader.

## Current phase

The app lets a user upload or drag in a shift photo, sends the image to Google Vision
through the local Node server, maps detected text into a table, and builds a cached
roster database from column A names and the month date columns.

This phase does not store photos, call Cloudflare, or use a backend database yet.
The parsed roster and selected profile are stored in `localStorage`, so a returning
user skips upload and profile selection until they clear the cache or import a new photo.
The spreadsheet preview is hidden by default and can be opened with `Review Spreadsheet`.

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
