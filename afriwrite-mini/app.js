
import express from "express";
import session from "express-session";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "fs";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import csurf from "csurf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

// --- Folders ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const PURCHASE_DIR = path.join(__dirname, "purchases");
[UPLOAD_DIR, PUBLIC_DIR, PURCHASE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); });

// --- DB setup ---
const db = new Database(path.join(__dirname, "afriwrite.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'READER',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    price_ngn INTEGER NOT NULL,
    pdf_path TEXT NOT NULL,
    cover_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(buyer_id, book_id),
    FOREIGN KEY(buyer_id) REFERENCES users(id),
    FOREIGN KEY(book_id) REFERENCES books(id)
  );
`);

// --- App config ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use("/covers", express.static(UPLOAD_DIR));
app.use("/files", express.static(UPLOAD_DIR));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true if behind HTTPS proxy
}));

const csrfProtection = csurf();

app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    req.headers["content-type"] &&
    req.headers["content-type"].startsWith("multipart/form-data")
  ) {
    return next();
  }
  csrfProtection(req, res, next);
});

// --- Multer storage ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_COVER_SIZE = 2 * 1024 * 1024; // 2MB

const upload = multer({
  storage,
  limits: { fileSize: MAX_PDF_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "pdf") {
      if (file.mimetype !== "application/pdf" || ext !== ".pdf") {
        return cb(new Error("Invalid PDF file"));
      }
    } else if (file.fieldname === "cover") {
      const allowed = [".png", ".jpg", ".jpeg"];
      if (!file.mimetype.startsWith("image/") || !allowed.includes(ext)) {
        return cb(new Error("Invalid cover image"));
      }
    }
    cb(null, true);
  }
});

const bookUpload = upload.fields([{ name: "pdf", maxCount: 1 }, { name: "cover", maxCount: 1 }]);

// --- Helpers ---
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect("/login");
    if (req.session.user.role !== role) return res.status(403).send("Forbidden");
    next();
  }
}

// Inject user and CSRF token into locals
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : null;
  next();
});

// --- Routes ---
app.get("/", (req, res) => {
  const books = db.prepare(`
    SELECT b.*, u.name as author_name 
    FROM books b JOIN users u ON u.id=b.author_id
    ORDER BY datetime(b.created_at) DESC
    LIMIT 25
  `).all();
  res.render("index", { books });
});

// Register
app.get("/register", (req, res) => res.render("register", { error: null }));
app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!email || !password) return res.render("register", { error: "Email and password are required" });
  try {
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    db.prepare("INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES (?,?,?,?,?,datetime('now'))")
      .run(id, email.toLowerCase(), hash, name || "", (role === "WRITER" ? "WRITER" : "READER"));
    req.session.user = { id, email: email.toLowerCase(), name, role: (role === "WRITER" ? "WRITER" : "READER") };
    res.redirect("/");
  } catch (e) {
    res.render("register", { error: "Could not register: " + (e.code === "SQLITE_CONSTRAINT_UNIQUE" ? "Email already used" : e.message) });
  }
});

// Login
app.get("/login", (req, res) => res.render("login", { error: null }));
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user) return res.render("login", { error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render("login", { error: "Invalid credentials" });
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  const next = req.query.next || "/";
  res.redirect(next);
});
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Writer: new book form
app.get("/writer/books/new", requireRole("WRITER"), (req, res) => {
  res.render("new_book", { error: null });
});

app.post("/writer/books/new", requireRole("WRITER"),
  (req, res, next) => {
    bookUpload(req, res, err => {
      if (err) return res.render("new_book", { error: err.message });
      next();
    });
  },
  csrfProtection,
  (req, res) => {
    const { title, description, price_ngn } = req.body;
    const pdf = req.files["pdf"]?.[0];
    const cover = req.files["cover"]?.[0];
    if (!pdf) return res.render("new_book", { error: "PDF is required" });
    if (cover && cover.size > MAX_COVER_SIZE) {
      fs.unlink(path.join(UPLOAD_DIR, cover.filename), () => {});
      fs.unlink(path.join(UPLOAD_DIR, pdf.filename), () => {});
      return res.render("new_book", { error: "Cover image too large" });
    }
    const id = uuidv4();
    db.prepare(`INSERT INTO books (id, author_id, title, description, price_ngn, pdf_path, cover_path, created_at)
                VALUES (?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, req.session.user.id, title, description, parseInt(price_ngn || "0", 10), pdf.filename, cover?.filename || null);
    res.redirect("/books/" + id);
  });

// Browse and book detail
app.get("/books/:id", (req, res) => {
  const book = db.prepare(`SELECT b.*, u.name as author_name FROM books b JOIN users u ON u.id=b.author_id WHERE b.id=?`).get(req.params.id);
  if (!book) return res.status(404).send("Not found");
  // If user owns, show in library info
  let owns = false;
  if (req.session.user) {
    const row = db.prepare("SELECT 1 FROM orders WHERE buyer_id=? AND book_id=? AND status='PAID'").get(req.session.user.id, book.id);
    owns = !!row;
  }
  res.render("book_detail", { book, owns });
});

// Mock buy flow (instant success)
app.post("/buy/:id", requireAuth, async (req, res) => {
  const book = db.prepare("SELECT * FROM books WHERE id=?").get(req.params.id);
  if (!book) return res.status(404).send("Not found");
  // Create order or set to PAID
  const orderId = uuidv4();
  try {
    db.prepare("INSERT OR IGNORE INTO orders (id,buyer_id,book_id,status,created_at) VALUES (?,?,?,?,datetime('now'))")
      .run(orderId, req.session.user.id, book.id, "PAID");
  } catch (e) {
    // ignore duplicates
  }

  // Generate user-specific watermarked copy
  const buyerEmail = req.session.user.email;
  const wmOutPath = path.join(PURCHASE_DIR, `${req.session.user.id}_${book.id}.pdf`);
  try {
    const pdfBytes = await fs.promises.readFile(path.join(UPLOAD_DIR, book.pdf_path));
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    pages.forEach((p, idx) => {
      const { width, height } = p.getSize();
      const text = `Purchased by ${buyerEmail} | Book ${book.title} | Order ${orderId}`;
      p.drawText(text, {
        x: 36, y: 20, size: 10, font, color: rgb(0.6,0.6,0.6),
        opacity: 0.6
      });
    });
    const stamped = await pdfDoc.save();
    await fs.promises.writeFile(wmOutPath, stamped);
  } catch (e) {
    console.error("Watermark error", e);
    return res.status(500).send("Failed to prepare purchase");
  }

  res.redirect("/library");
});

// Library
app.get("/library", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT o.book_id, b.title, b.cover_path, b.price_ngn
    FROM orders o JOIN books b ON b.id=o.book_id
    WHERE o.buyer_id=? AND o.status='PAID'
    ORDER BY datetime(o.created_at) DESC
  `).all(req.session.user.id);
  res.render("library", { items: rows });
});

// Download purchased
app.get("/download/:bookId", requireAuth, (req, res) => {
  const own = db.prepare("SELECT 1 FROM orders WHERE buyer_id=? AND book_id=? AND status='PAID'")
    .get(req.session.user.id, req.params.bookId);
  if (!own) return res.status(403).send("You do not own this book");
  const wmOutPath = path.join(PURCHASE_DIR, `${req.session.user.id}_${req.params.bookId}.pdf`);
  if (!fs.existsSync(wmOutPath)) return res.status(404).send("Your copy is not ready");
  res.download(wmOutPath, "your-book.pdf");
});

// Simple search
app.get("/search", (req, res) => {
  const q = (req.query.q || "").trim();
  let rows = [];
  if (q) {
    rows = db.prepare(`SELECT b.*, u.name as author_name
                       FROM books b JOIN users u ON u.id=b.author_id
                       WHERE b.title LIKE ? OR b.description LIKE ?
                       ORDER BY datetime(b.created_at) DESC`).all(`%${q}%`, `%${q}%`);
  }
  res.render("search", { q, books: rows });
});

app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    return res.status(403).send("Invalid CSRF token");
  }
  next(err);
});

// Start
app.listen(PORT, () => {
  console.log(`AfriWrite Mini running at http://localhost:${PORT}`);
});
