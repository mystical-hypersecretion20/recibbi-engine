# tessdata — offline Tesseract language data

Drop the English language data here so the offline OCR path works **without**
downloading from the jsdelivr CDN (which a TLS-intercepting proxy may block).

Place **either** of these in this directory:

- `eng.traineddata`     ← uncompressed (preferred — loaded straight from cache)
- `eng.traineddata.gz`  ← compressed (also fine — read locally, then unpacked)

Get the file from a network without TLS interception (e.g. Google Colab). The
matching asset for this project (tesseract.js 5.x, LSTM-only) is:

    https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz

## Orientation data (recommended) — `osd.traineddata`

The OCR path runs Tesseract's OSD (orientation & script detection) so a sideways
or upside-down phone photo is auto-rotated before recognition. That needs
`osd.traineddata` in this directory (uncompressed, ~10 MB). Without it the code
still runs — it just logs a warning and skips orientation correction (set
`TESSERACT_OSD=0` to skip it deliberately). Fetch it from the official Tesseract
data repo:

    curl -fL https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/osd.traineddata -o osd.traineddata

Both `*.traineddata` files are gitignored (they're large binaries), so each
build environment must place them here before `docker build` / `podman build`
copies them into the image.

See `../test/README.md` ("TLS-intercepting proxy gotcha") for the Colab snippet and
the full story. Once the file is here:

    npm run test:live:tesseract     # should now OCR the sample instead of skipping

The code points Tesseract at this folder via `config.tessdataDir`
(override with the `TESSDATA_PATH` env var, e.g. a mounted volume in Docker).
