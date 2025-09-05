// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const pdfParse = require("pdf-parse");
const sqlite3 = require("sqlite3").verbose();

// CONFIG: change API_KEY to something secret
// For simplicity during development we explicitly set it here.
// You can later change to process.env.API_KEY for production.
const API_KEY = "secret123";

// DEBUG: print what the server expects (non-secret) and helpful start line
console.log("DEBUG: Server started. Expected API_KEY (development) ->", API_KEY);

const app = express();
// --- Strong CORS + preflight handler ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://127.0.0.1:5500"); // or http://localhost:5500 if that's what you open
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200); // immediately end preflight
  }
  next();
});

const port = process.env.PORT || 3000;

/*// CORS setup
app.use(cors({
  origin: "*",                 // allow all origins (or restrict to frontend URL)
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"]
}));*/

// Also handle OPTIONS requests globally
//app.options("*", cors());


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// validate-key endpoint (check API key when user clicks Unlock)
// This version logs what header/body/query contains so we can debug mismatches.
app.post("/validate-key", (req, res) => {
  console.log(">>> /validate-key request headers:", req.headers);
  const key = req.headers["x-api-key"] || req.body.apiKey || req.query.apiKey;
  console.log(">>> /validate-key resolved key value:", key);

  if (!key || key !== API_KEY) {
    console.log(">>> validate-key: rejected (received != expected)");
    return res.status(401).json({ valid: false, error: "Invalid API key" });
  }

  console.log(">>> validate-key: accepted");
  return res.json({ valid: true });
});


// ensure storage dirs exist
const BASE = __dirname;
const uploadDir = path.join(BASE, "uploads");
const keyDir = path.join(BASE, "keys");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });

// SQLite DB
const dbPath = path.join(BASE, "uploads.db");
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    storedName TEXT,
    mimetype TEXT,
    size INTEGER,
    uploadTime TEXT,
    signature TEXT,
    metadata TEXT
  )`);
});

// RSA keys: generate if missing
const privPath = path.join(keyDir, "private.pem");
const pubPath = path.join(keyDir, "public.pem");
if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
  console.log("Generating RSA keypair...");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  fs.writeFileSync(privPath, privateKey, "utf8");
  fs.writeFileSync(pubPath, publicKey, "utf8");
}
const PRIVATE_KEY = fs.readFileSync(privPath, "utf8");
const PUBLIC_KEY = fs.readFileSync(pubPath, "utf8");

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file.originalname) || "";
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

// API key middleware — improved logging for debugging
function checkApiKey(req, res, next) {
  // log incoming values so we can see what the frontend sends
  console.log("---- api key check ----");
  console.log("Header x-api-key:", req.headers["x-api-key"]);
  console.log("Form apiKey (req.body.apiKey):", req.body && req.body.apiKey);
  console.log("Query apiKey:", req.query && req.query.apiKey);
  console.log("------------------------");

  const key = req.headers["x-api-key"] || req.body.apiKey || req.query.apiKey;
  if (!key || key !== API_KEY) {
    // respond with helpful info for debugging (do not leak private key value)
    return res.status(401).json({
      error: "Invalid API key",
      received: {
        header: !!req.headers["x-api-key"],
        form: !!(req.body && req.body.apiKey),
        query: !!(req.query && req.query.apiKey)
      }
    });
  }
  next();
}


// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Serve uploaded files (original) and certificates and qr images
app.use("/uploads", express.static(uploadDir)); // original files, certs, qrs

// Upload endpoint: protected by API key
app.post("/upload", checkApiKey, upload.single("report"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
    if (req.file.mimetype !== "application/pdf") {
      // remove file
      fs.unlinkSync(path.join(uploadDir, req.file.filename));
      return res.status(400).json({ success: false, error: "Only PDF allowed" });
    }

    // read file bytes and parse text to verify it's the Linux wipe report format
    const filePath = path.join(uploadDir, req.file.filename);
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    const text = (pdfData && pdfData.text) ? pdfData.text : "";

    // Heuristic: check for expected markers in the Linux-generated wipe PDF
    const markers = ["Wipe Record", "Device", "Wipe Method", "Status"];
    let matched = 0;
    const low = text.toLowerCase();
    for (const m of markers) {
      if (low.includes(m.toLowerCase())) matched++;
    }

    if (matched < 3) {
      // Not recognized as the expected wipe-report PDF => reject
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: "PDF not recognized as valid wipe-report type" });
    }

    // Everything ok -> create record
    const id = uuidv4();
    const uploadTime = new Date().toISOString();
    const metadata = {
      id,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadTime,
      extractedTextSnippet: text.slice(0, 800) // store a snippet for quick viewing
    };

    // sign the record (we sign id|originalName|uploadTime)
    const signPayload = `${id}|${metadata.originalName}|${uploadTime}`;
    const signer = crypto.createSign("SHA256");
    signer.update(signPayload);
    signer.end();
    const signature = signer.sign(PRIVATE_KEY, "base64");

    // create certificate PDF (signed)
    const certPath = path.join(uploadDir, `${id}-certificate.pdf`);
    await createCertificatePDF(certPath, metadata, signature, PUBLIC_KEY);

    // generate QR image that points to verify page
    const host = req.headers.host || `localhost:${port}`;
    const verifyUrl = `http://${host}/verify/${id}`;
    const qrPath = path.join(uploadDir, `${id}.png`);
    await QRCode.toFile(qrPath, verifyUrl, { type: "png", width: 300 });

    // store record in DB
    const stmt = db.prepare(`INSERT INTO uploads (id, originalName, storedName, mimetype, size, uploadTime, signature, metadata) VALUES (?,?,?,?,?,?,?,?)`);
    stmt.run(id, metadata.originalName, metadata.storedName, metadata.mimetype, metadata.size, metadata.uploadTime, signature, JSON.stringify(metadata), (err) => {
      stmt.finalize();
      if (err) {
        console.error("DB insert error:", err);
      }
    });

    // return URLs (served from /uploads/)
    const baseUrl = `http://${host}`;
    res.json({
      success: true,
      id,
      verifyUrl,
      qrUrl: `${baseUrl}/uploads/${path.basename(qrPath)}`,
      certificateUrl: `${baseUrl}/uploads/${path.basename(certPath)}`
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify page (human-friendly)
app.get("/verify/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM uploads WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).send("DB error");
    if (!row) return res.status(404).send("<h2>Not found</h2><p>No record for that id.</p>");

    const meta = JSON.parse(row.metadata);
    const signature = row.signature || "";
    // verify signature
    const signPayload = `${row.id}|${meta.originalName}|${meta.uploadTime}`;
    const verifier = crypto.createVerify("SHA256");
    verifier.update(signPayload);
    verifier.end();
    const valid = verifier.verify(PUBLIC_KEY, signature, "base64");

    // render a simple HTML page showing metadata and verification
    const downloadCert = `/uploads/${row.id}-certificate.pdf`;
    const downloadFile = `/download/${row.id}`;
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8"/>
          <title>Verify - ${id}</title>
          <style>
            body{font-family:Arial,Helvetica,sans-serif;background:#0d1117;color:#e6edf3;padding:28px}
            .card{background:#10141a;padding:18px;border-radius:10px;max-width:820px;margin:auto;box-shadow:0 8px 40px rgba(0,0,0,0.6)}
            a.btn{display:inline-block;padding:10px 14px;border-radius:8px;background:#00bcd4;color:#032; text-decoration:none;font-weight:600;margin-top:10px}
            pre{white-space:pre-wrap;background:#0b0f13;padding:10px;border-radius:8px}
            .ok{color:#7ef9a6}
            .bad{color:#ff8080}
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Verification for ${id}</h2>
            <p>Original filename: <strong>${meta.originalName}</strong></p>
            <p>Size: ${meta.size} bytes</p>
            <p>Uploaded at: ${meta.uploadTime}</p>
            <p>Signature valid: <strong class="${valid ? "ok" : "bad"}">${valid ? "YES" : "NO"}</strong></p>
            <p>
              <a class="btn" href="${downloadFile}">Download original report</a>
              <a class="btn" href="${downloadCert}" style="margin-left:10px">Download signed certificate</a>
            </p>
            <h3>Extracted text snippet</h3>
            <pre>${escapeHtml(meta.extractedTextSnippet || "")}</pre>
            <h4>Public key (PEM)</h4>
            <pre style="font-size:11px">${escapeHtml(PUBLIC_KEY)}</pre>
          </div>
        </body>
      </html>
    `;
    res.send(html);
  });
});

// Download original file
app.get("/download/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM uploads WHERE id = ?", [id], (err, row) => {
    if (err || !row) return res.status(404).send("Not found");
    const meta = JSON.parse(row.metadata);
    const filePath = path.join(uploadDir, meta.storedName);
    if (!fs.existsSync(filePath)) return res.status(404).send("File missing");
    res.download(filePath, meta.originalName);
  });
});

// helper: create a signed certificate PDF using pdfkit
function createCertificatePDF(destPath, metadata, signatureB64, publicKeyPem) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(destPath);
      doc.pipe(stream);

      doc.fontSize(20).fillColor("#0b3c4a").text("Data Wipe Certificate", { align: "center" });
      doc.moveDown(1);

      doc.fontSize(12).fillColor("#222").text(`Certificate ID: ${metadata.id}`);
      doc.moveDown(0.5);

      doc.fontSize(12).text(`Original filename: ${metadata.originalName}`);
      doc.text(`Upload time: ${metadata.uploadTime}`);
      doc.text(`File size: ${metadata.size} bytes`);
      doc.text(`Signed by: Wipe-Certs System`);
      doc.moveDown(1);

      doc.fontSize(13).text("Statement:", { underline: true });
      doc.fontSize(11).text("This certificate attests that the uploaded wipe report indicates a completed data wipe. The signature below cryptographically signs the certificate metadata for verification.", { align: "left" });
      doc.moveDown(1);

      doc.fontSize(11).text("Signature (base64):");
      // show signature in smaller font and wrapped
      doc.fontSize(9).fillColor("#000").text(signatureB64, { width: 480 });

      doc.addPage();
      doc.fontSize(12).text("Verification details", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10).text("Public key (PEM):");
      doc.moveDown(0.2);
      doc.fontSize(8).text(publicKeyPem, { width: 480 });

      doc.end();

      stream.on("finish", () => resolve());
      stream.on("error", (e) => reject(e));
    } catch (e) {
      reject(e);
    }
  });
}

// small helper to escape HTML in verify page
function escapeHtml(unsafe) {
  return (unsafe || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
