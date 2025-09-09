
# AfriWrite Mini (Working MVP)

Minimal Node.js + Express + SQLite app to publish and sell ebooks (demo). 
- Writers can register, upload a PDF, set a price.
- Readers can register, browse, buy (demo), and download a watermarked copy.

## Run locally
```bash
cd afriwrite-mini
npm install
npm start
# open http://localhost:3000
```

## Demo flow
1. Register as **Writer**, publish a book (PDF required).
2. Log out, register a **Reader**, open the book page, click **Buy now (Demo)**.
3. Go to **My Library** and **Download** your watermarked PDF.

## Notes
- Payment is mocked as instant success; integrate Paystack/Flutterwave later.
- PDF watermarking via `pdf-lib` adds buyer email + order id to footer of each page.
- Files are stored locally under `/uploads` (originals) and `/purchases` (watermarked copies).
- This is for local/demo use; not production hardened.
