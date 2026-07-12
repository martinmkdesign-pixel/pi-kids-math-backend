// ============================================================
// MatheInnova Backend – server.js
// Express + Pi Platform API + PostgreSQL (Railway)
// ============================================================
// Neu gegenüber der Vorversion:
//  - PostgreSQL statt Arbeitsspeicher (Zahlungen überleben Neustarts)
//  - Bestenliste: POST /score und GET /leaderboard
//  - GET /unlocks: gekaufte Freischaltungen wiederherstellen
// Die bestehenden Zahlungs-Endpunkte (/approve, /complete) und der
// Ablauf sind unverändert – nur die Speicherung ist jetzt persistent.
// ============================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// Frontend (index.html, validation-key.txt) weiterhin direkt ausliefern
app.use(express.static(__dirname));

// ---------- Konfiguration ----------
const PI_API_KEY = process.env.PI_API_KEY; // wie bisher als Railway-Variable
const PI_API = "https://api.minepi.com/v2";
const PORT = process.env.PORT || 3000;

if (!PI_API_KEY) {
  console.warn("WARNUNG: PI_API_KEY ist nicht gesetzt – Zahlungen werden fehlschlagen.");
}

// ---------- Datenbank ----------
// DATABASE_URL stellt Railway automatisch bereit, sobald die
// Postgres-Datenbank mit dem Service verknüpft ist.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  // Freischaltungen (ersetzt das bisherige In-Memory-Objekt)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unlocks (
      id          SERIAL PRIMARY KEY,
      uid         TEXT NOT NULL,
      product     TEXT NOT NULL,           -- z.B. "level" oder "all"
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

// ---------- Hilfsfunktionen ----------
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
    throw new Error(`Pi API ${endpoint} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Access Token des Nutzers gegen die Pi API prüfen (für Bestenliste).
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

// ---------- Zahlungs-Endpunkte (Ablauf wie bisher) ----------

// Schritt 1: Zahlung freigeben
app.post("/approve", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "paymentId fehlt" });
    await piRequest(`/payments/${paymentId}/approve`, "POST");
    res.json({ ok: true });
  } catch (e) {
    console.error("approve:", e.message);
    res.status(500).json({ error: "Approve fehlgeschlagen" });
  }
});

// Schritt 2: Zahlung abschließen + Freischaltung DAUERHAFT speichern
app.post("/complete", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ error: "paymentId/txid fehlt" });

    // Erst bei Pi abschließen …
    const payment = await piRequest(`/payments/${paymentId}/complete`, "POST", { txid });

    // … dann in der Datenbank festhalten (idempotent dank UNIQUE auf payment_id)
    const uid = payment.user_uid;
    const memo = payment.memo || "";
    const amount = payment.amount || null;
    const product = memo.toLowerCase().includes("komplett") ? "all" : "level";

    await pool.query(
      `INSERT INTO unlocks (uid, product, memo, payment_id, txid, amount)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (payment_id) DO NOTHING`,
      [uid, product, memo, paymentId, txid, amount]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("complete:", e.message);
    res.status(500).json({ error: "Complete fehlgeschlagen" });
  }
});

// Unvollständige Zahlungen abschließen (Pi ruft das beim App-Start auf)
app.post("/incomplete", async (req, res) => {
  try {
    const { payment } = req.body;
    if (payment && payment.identifier && payment.transaction && payment.transaction.txid) {
      await piRequest(`/payments/${payment.identifier}/complete`, "POST", {
        txid: payment.transaction.txid,
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("incomplete:", e.message);
    res.json({ ok: true }); // nicht blockieren
  }
});

// ---------- Freischaltungen wiederherstellen ----------
// Das Frontend kann damit nach Login gekaufte Inhalte abrufen –
// unabhängig von Gerät oder Browser-Cache.
app.post("/unlocks", async (req, res) => {
  try {
    const { accessToken } = req.body;
    const user = await verifyUser(accessToken);
    const r = await pool.query(
      `SELECT product, memo, created_at FROM unlocks WHERE uid = $1 ORDER BY created_at`,
      [user.uid]
    );
    res.json({ unlocks: r.rows });
  } catch (e) {
    console.error("unlocks:", e.message);
    res.status(401).json({ error: "Nicht autorisiert" });
  }
});

// ---------- Bestenliste ----------

// Punktestand melden (Gesamtsterne). Authentifiziert über das Pi Access Token,
// damit niemand fremde Scores manipulieren kann.
app.post("/score", async (req, res) => {
  try {
    const { accessToken, stars, nickname } = req.body;
    const user = await verifyUser(accessToken);

    const s = parseInt(stars, 10);
    if (!Number.isFinite(s) || s < 0 || s > 1000) {
      return res.status(400).json({ error: "Ungültiger Punktestand" });
    }
    const nick = sanitizeNickname(nickname);
    if (!nick) return res.status(400).json({ error: "Ungültiger Spielername" });

    // Upsert: Sterne nur erhöhen, nie verringern (Schutz vor Fehl-Meldungen)
    await pool.query(
      `INSERT INTO players (uid, nickname, stars, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (uid) DO UPDATE
         SET nickname = EXCLUDED.nickname,
             stars = GREATEST(players.stars, EXCLUDED.stars),
             updated_at = now()`,
      [user.uid, nick, s]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("score:", e.message);
    res.status(401).json({ error: "Nicht autorisiert" });
  }
});

// Öffentliche Top-Liste (nur Spitzname + Sterne, keine Pi-Usernames!)
app.get("/leaderboard", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT nickname, stars FROM players ORDER BY stars DESC, updated_at ASC LIMIT 25`
    );
    res.json({ leaderboard: r.rows });
  } catch (e) {
    console.error("leaderboard:", e.message);
    res.status(500).json({ error: "Bestenliste nicht verfügbar" });
  }
});

// ---------- Start ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`MatheInnova Backend läuft auf Port ${PORT}`));
  })
  .catch((e) => {
    console.error("Datenbank-Initialisierung fehlgeschlagen:", e);
    process.exit(1);
  });
