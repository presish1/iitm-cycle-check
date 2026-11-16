# Cycle Check

A browser-based classroom demo for looking up IIT Madras cycle stickers and browsing an illustrative auction list. This is not an official IIT Madras service.

## Try the sticker

Open the HTTPS site on a phone, select **Open camera**, allow camera access, and point it at the printed cycle code. The supplied stickers read **HTL 26 0001**, **HTL 26 0002**, **HTL 26 0003**, and **HTL 26 0004**, each mapped to a different illustrative cycle. The first scan loads the recognition engine; keep the code well lit and steady. If the camera is unavailable or the code is hard to read, choose a photo or type the code instead. The supplied `demo-sticker.webp` can be printed or displayed on another screen.

Recognition and lookup run on each visitor's device. There is no backend and no image upload to a server. A connection is needed to load the site and recognition assets; the browser may cache them afterwards.

## Data

`data.js` contains six **fictional classroom records**, including fictional roll numbers, frame IDs and auction listings. The sample sticker is mapped to one of those fictional records. These are not campus records and must be replaced with verified data before use beyond a demo. Unknown IDs are shown in the entry field without invented details. Recognition supports IDs in the HTL XX XXXX format and tries multiple contrast and tilt treatments; keep the sticker level and well lit for the best result.

## Run locally

Serve this directory over HTTP, for example `python3 -m http.server 8000`, and visit `http://localhost:8000`. Phone camera access requires HTTPS or localhost; opening `index.html` directly is not a substitute for an HTTPS deployment. The directory is ready for GitHub Pages at the repository root.

## Third-party components

Tesseract.js 5.1.1, Tesseract.js Core 5.1.1 and English fast training data are used for on-device text recognition. jsQR 1.4.0 also supports machine-readable codes. The library licenses are in `vendor/`. The supplied sticker was used to create the demo asset and institute emblem shown in this prototype.

## Scanner messages

The camera checks the same printed code twice before opening a record. Scans try additional contrast and modest tilt corrections when the first pass fails. Extreme blur, glare, small text, steep angles and camera motion can still prevent a reliable read. Move closer and hold steady; photo upload and manual entry remain available.

- `CAM-01`: camera permission denied; enable it in browser settings.
- `CAM-02`: no camera found.
- `CAM-03`: camera is busy or unavailable to the browser.
- `CAM-04`: camera could not start.
- `CAM-05`: camera API is unavailable; use the HTTPS site or a photo.
- `CAM-06`: camera stopped unexpectedly.
- `OCR-01`: the recognition engine failed to load; check the connection.
- `IMG-01`: the selected image could not be opened.
- `SCAN-01`: the code was not clear enough to read.
- `SCAN-02`: recognition stopped unexpectedly.
- `CODE-01`: the entered code is not in the expected format.
- `DATA-01`: the recognised code does not have a local record.
