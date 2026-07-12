// ============================================================
// MatheInnova Backend – server.js (FINAL, abgeglichen)
// Express + Pi Platform API + PostgreSQL (Railway)
// ============================================================
// Kombiniert das ALTE Verhalten (das die index.html erwartet):
//  - Pfade /payments/approve und /payments/complete
//  - Antwortformat { success, paymentId, txid, priceType, unlocked }
//  - Preisvalidierung über PRICE_TABLE
//  - CORS-Whitelist und Rate-Limiting auf Zahlungs-Endpunkten
//  - Schutz gegen Doppelverarbeitung
// mit der NEUEN Logik:
//  - PostgreSQL statt Arbeitsspeicher (Tabellen: unlocks, players)
//  - /auth/verify (jetzt mit success:true – das Frontend prüft darauf!)
//  - /unlocks, /score, /leaderboard, /incomplete
//
// WICHTIG:
//  - PRICE_TABLE ist auf die AKTUELLEN Frontend-Preise angepasst:
//    0.5 π (1 Level) und 14 π (alle Level). Die alte server.js hatte
//    noch 5 π – das passt nicht mehr zur index.html.
//  - Keine zusätzlichen Abhängigkeiten nötig: nur express, cors, pg.
//    (axios und express-rate-limit werden NICHT mehr gebraucht.)
// ============================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const PI_API_KEY = process.env.PI_API_KEY; // Railway-Variable, wie bisher
const PI_API = "https://api.minepi.com/v2";

if (!PI_API_KEY) {
  console.warn("WARNUNG: PI_API_KEY ist nicht gesetzt – Zahlungen werden fehlschlagen.");
}

// Railway läuft hinter einem Proxy – nötig, damit req.ip die echte
// Client-IP für das Rate-Limiting liefert.
app.set("trust proxy", 1);

app.use(express.json());

// Frontend (index.html, validation-key.txt) direkt ausliefern
app.use(express.static(__dirname));

// CORS-Whitelist (wie in der alten Version)
app.use(cors({
  origin: [
    "https://golden-cobbler-2dc822.netlify.app",
    "https://sandbox.minepi.com",
    "https://marvelous-wisdom-production-1860.up.railway.app"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Schützt die Zahlungs-Endpunkte vor zu vielen Anfragen pro IP.
// Eigene Mini-Implementierung ohne Zusatzpaket (max. 20 Anfragen / Minute / IP).
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 20;
const rlBuckets = new Map();

function paymentLimiter(req, res, next) {
  const now = Date.now();
  const ip = req.ip || "unknown";
  let b = rlBuckets.get(ip);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + RL_WINDOW_MS };
    rlBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > RL_MAX) {
    return res.status(429).json({ error: "Zu viele Anfragen. Bitte versuch es in einer Minute noch einmal." });
  }
  next();
}

// Abgelaufene Einträge regelmäßig aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rlBuckets) {
    if (now > b.reset) rlBuckets.delete(ip);
  }
}, 5 * 60 * 1000);

// ── PREIS-KONFIGURATION ──────────────────────────────────────────────────────
// An die aktuellen Frontend-Preise angepasst (index.html):
//   0.5 π  -> 1 Level  ("single_level")
//   14 π   -> alle Level ("all_levels")
const PRICE_TABLE = [
  { amount: 0.5, type: "single_level", product: "level" },
  { amount: 14,  type: "all_levels",   product: "all" }
];
const AMOUNT_TOLERANCE = 0.0001; // Toleranz für Float-Vergleich

function resolvePrice(amount) {
  return PRICE_TABLE.find(p => Math.abs(p.amount - amount) < AMOUNT_TOLERANCE) || null;
}

// ── DATENBANK ────────────────────────────────────────────────────────────────
// DATABASE_URL stellt Railway automatisch bereit.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  // Freischaltungen (ersetzt das frühere In-Memory-Objekt)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unlocks (
      id          SERIAL PRIMARY KEY,
      uid         TEXT NOT NULL,
      product     TEXT NOT NULL,           -- "level" oder "all"
      memo        TEXT,
      payment_id  TEXT UNIQUE,
      txid        TEXT,
      amount      NUMERIC,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Spieler für die Bestenliste
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      uid         TEXT PRIMARY KEY,
      nickname    TEXT NOT NULL,
      stars       INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log("Datenbank bereit.");
}

// ── HILFSFUNKTIONEN ──────────────────────────────────────────────────────────
async function piRequest(endpoint, method, body) {
  const res = await fetch(`${PI_API}${endpoint}`, {
    method,
    headers: {
      "Authorization": `Key ${PI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Pi API ${endpoint} -> ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Access Token des Nutzers gegen die Pi API prüfen.
// Gibt { uid, username } zurück oder wirft einen Fehler.
async function verifyUser(accessToken) {
  const res = await fetch(`${PI_API}/me`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Ungültiges Access Token");
  return res.json();
}

// Spitznamen serverseitig absichern: nur erlaubte Zeichen, max. 30 Zeichen.
function sanitizeNickname(name) {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[^a-zA-Z0-9äöüÄÖÜß \-]/g, "").trim().slice(0, 30);
  return clean.length >= 3 ? clean : null;
}

// priceType aus einem DB-Eintrag ableiten (für idempotente Antworten)
function priceTypeFromProduct(product) {
  return product === "all" ? "all_levels" : "single_level";
}

// ── STATUS / FRONTEND ────────────────────────────────────────────────────────
// Die App wird direkt von Railway ausgeliefert (Pi Browser lädt diese URL).
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Status-Check wie früher unter GET / – jetzt unter /health
app.get("/health", (_req, res) => {
  res.json({ status: "MatheInnova Backend läuft!", version: "2.1" });
});

// ── LOGIN-VERIFIZIERUNG ──────────────────────────────────────────────────────
// Das Frontend prüft auf verifyData.success – deshalb success:true!
// (ok:true bleibt zusätzlich erhalten, falls anderswo darauf geprüft wird.)
app.post("/auth/verify", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ success: false, error: "accessToken fehlt" });
    const user = await verifyUser(accessToken);
    res.json({ success: true, ok: true, uid: user.uid, username: user.username });
  } catch (e) {
    console.error("auth/verify:", e.message);
    res.status(401).json({ success: false, error: "Verifizierung fehlgeschlagen" });
  }
});

// ── ZAHLUNGS-ENDPUNKTE ───────────────────────────────────────────────────────
// Pfade wie in der alten Version (/payments/...), da die index.html diese
// aufruft. Die kurzen Pfade (/approve, /complete) bleiben als Alias bestehen.

// Schritt 1: Zahlung prüfen und freigeben
async function handleApprove(req, res) {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "paymentId fehlt" });

  try {
    // Zahlungsdaten von Pi holen und Betrag validieren
    const payment = await piRequest(`/payments/${paymentId}`, "GET");
    const price = resolvePrice(payment.amount);
    if (!price) {
      console.warn(`Unbekannter Betrag bei Payment ${paymentId}: ${payment.amount} π`);
      return res.status(400).json({ error: "Ungültiger Zahlungsbetrag" });
    }

    // Bereits genehmigt oder abgeschlossen? Nicht doppelt verarbeiten.
    const st = payment.status || {};
    if (st.developer_approved || st.developer_completed) {
      return res.json({
        success: true, paymentId, amount: payment.amount,
        priceType: price.type, alreadyProcessed: true
      });
    }

    await piRequest(`/payments/${paymentId}/approve`, "POST");
    res.json({ success: true, paymentId, amount: payment.amount, priceType: price.type });
  } catch (e) {
    console.error("approve:", e.message);
    res.status(500).json({ error: "Fehler beim Genehmigen" });
  }
}
app.post("/payments/approve", paymentLimiter, handleApprove);
app.post("/approve", paymentLimiter, handleApprove); // Alias

// Schritt 2: Zahlung abschließen + Freischaltung DAUERHAFT speichern
async function handleComplete(req, res) {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) return res.status(400).json({ error: "Daten fehlen" });

  try {
    // Schon in der Datenbank? -> idempotent antworten (Doppel-Schutz)
    const existing = await pool.query(
      `SELECT product FROM unlocks WHERE payment_id = $1`, [paymentId]
    );
    if (existing.rows.length > 0) {
      return res.json({
        success: true, paymentId, txid,
        priceType: priceTypeFromProduct(existing.rows[0].product),
        unlocked: true, alreadyProcessed: true
      });
    }

    // Bei Pi abschließen – die Antwort enthält das Payment-Objekt
    const payment = await piRequest(`/payments/${paymentId}/complete`, "POST", { txid });

    // priceType primär über den Betrag bestimmen, Memo als Fallback
    const amount = payment.amount ?? null;
    let price = amount !== null ? resolvePrice(amount) : null;
    if (!price) {
      const memo = (payment.memo || "").toLowerCase();
      price = memo.includes("komplett") ? PRICE_TABLE[1] : PRICE_TABLE[0];
      console.warn(`Payment ${paymentId}: Betrag ${amount} π nicht in PRICE_TABLE, Fallback über Memo -> ${price.type}`);
    }

    // In der Datenbank festhalten (idempotent dank UNIQUE auf payment_id)
    await pool.query(
      `INSERT INTO unlocks (uid, product, memo, payment_id, txid, amount)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (payment_id) DO NOTHING`,
      [payment.user_uid, price.product, payment.memo || "", paymentId, txid, amount]
    );

    res.json({ success: true, paymentId, txid, priceType: price.type, unlocked: true });
  } catch (e) {
    console.error("complete:", e.message);
    res.status(500).json({ error: "Fehler beim Abschließen" });
  }
}
app.post("/payments/complete", paymentLimiter, handleComplete);
app.post("/complete", paymentLimiter, handleComplete); // Alias

// Unvollständige Zahlungen abschließen (falls Pi das beim App-Start aufruft).
// Hinweis: Die aktuelle index.html schickt offene Zahlungen an
// /payments/complete – dieser Endpunkt bleibt als Absicherung bestehen.
app.post("/incomplete", async (req, res) => {
  try {
    const { payment } = req.body;
    if (payment && payment.identifier && payment.transaction && payment.transaction.txid) {
      await piRequest(`/payments/${payment.identifier}/complete`, "POST", {
        txid: payment.transaction.txid,
      });
    }
    res.json({ ok: true, success: true });
  } catch (e) {
    console.error("incomplete:", e.message);
    res.json({ ok: true, success: true }); // nicht blockieren
  }
});

// ── FREISCHALTUNGEN WIEDERHERSTELLEN ─────────────────────────────────────────
// Das Frontend kann damit nach dem Login gekaufte Inhalte abrufen –
// unabhängig von Gerät oder Browser-Cache.
app.post("/unlocks", async (req, res) => {
  try {
    const { accessToken } = req.body;
    const user = await verifyUser(accessToken);
    const r = await pool.query(
      `SELECT product, memo, created_at FROM unlocks WHERE uid = $1 ORDER BY created_at`,
      [user.uid]
    );
    res.json({ success: true, unlocks: r.rows });
  } catch (e) {
    console.error("unlocks:", e.message);
    res.status(401).json({ success: false, error: "Nicht autorisiert" });
  }
});

// ── BESTENLISTE ──────────────────────────────────────────────────────────────

// Punktestand melden (Gesamtsterne). Authentifiziert über das Pi Access Token.
app.post("/score", async (req, res) => {
  try {
    const { accessToken, stars, nickname } = req.body;
    const user = await verifyUser(accessToken);

    const s = parseInt(stars, 10);
    if (!Number.isFinite(s) || s < 0 || s > 1000) {
      return res.status(400).json({ success: false, error: "Ungültiger Punktestand" });
    }
    const nick = sanitizeNickname(nickname);
    if (!nick) return res.status(400).json({ success: false, error: "Ungültiger Spielername" });

    // Upsert: Sterne nur erhöhen, nie verringern
    await pool.query(
      `INSERT INTO players (uid, nickname, stars, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (uid) DO UPDATE
         SET nickname = EXCLUDED.nickname,
             stars = GREATEST(players.stars, EXCLUDED.stars),
             updated_at = now()`,
      [user.uid, nick, s]
    );
    res.json({ success: true, ok: true });
  } catch (e) {
    console.error("score:", e.message);
    res.status(401).json({ success: false, error: "Nicht autorisiert" });
  }
});

// Öffentliche Top-Liste (nur Spitzname + Sterne, keine Pi-Usernames!)
app.get("/leaderboard", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT nickname, stars FROM players ORDER BY stars DESC, updated_at ASC LIMIT 25`
    );
    res.json({ success: true, leaderboard: r.rows });
  } catch (e) {
    console.error("leaderboard:", e.message);
    res.status(500).json({ success: false, error: "Bestenliste nicht verfügbar" });
  }
});

// ── START ────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`MatheInnova Backend läuft auf Port ${PORT}`));
  })
  .catch((e) => {
    console.error("Datenbank-Initialisierung fehlgeschlagen:", e);
    process.exit(1);
  });
