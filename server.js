const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const PI_API_KEY = process.env.PI_API_KEY;

app.use(express.json());
app.use(express.static('.'));
app.use(cors({
origin: ['https://golden-cobbler-2dc822.netlify.app', 'https://sandbox.minepi.com'],
methods: ['GET', 'POST'],
allowedHeaders: ['Content-Type', 'Authorization']
}));

const payments = {};

// ── PREIS-KONFIGURATION ──────────────────────────────────────────────────────
// amount = exakter Pi-Betrag, type = was nach erfolgreicher Zahlung freigeschaltet wird
const PRICE_TABLE = [
{ amount: 0.5, type: 'single_level' },
{ amount: 5, type: 'all_levels' }
];
const AMOUNT_TOLERANCE = 0.0001; // Toleranz für Float-Vergleich

function resolvePriceType(amount) {
const match = PRICE_TABLE.find(p => Math.abs(p.amount - amount) < AMOUNT_TOLERANCE);
return match ? match.type : null;
}

app.get('/', (req, res) => {
res.json({ status: 'Pi Kids Math Backend läuft!', version: '1.1' });
});

app.post('/payments/approve', async (req, res) => {
const { paymentId } = req.body;
if (!paymentId) return res.status(400).json({ error: 'paymentId fehlt' });

try {
const response = await axios.get(
`https://api.minepi.com/v2/payments/${paymentId}`,
{ headers: { 'Authorization': `Key ${PI_API_KEY}` } }
);
const payment = response.data;

// Preis validieren: nur bekannte Beträge werden akzeptiert
const priceType = resolvePriceType(payment.amount);
if (!priceType) {
console.warn(`Unbekannter Betrag bei Payment ${paymentId}: ${payment.amount} π`);
return res.status(400).json({ error: 'Ungültiger Zahlungsbetrag' });
}

// Bereits bekannte Zahlung? Nicht doppelt verarbeiten
if (payments[paymentId] && payments[paymentId].status !== 'pending') {
return res.json({ success: true, paymentId, amount: payment.amount, alreadyProcessed: true });
}

payments[paymentId] = {
id: paymentId,
amount: payment.amount,
priceType,
status: 'approved',
timestamp: new Date()
};

await axios.post(
`https://api.minepi.com/v2/payments/${paymentId}/approve`,
{},
{ headers: { 'Authorization': `Key ${PI_API_KEY}` } }
);

res.json({ success: true, paymentId, amount: payment.amount, priceType });
} catch (error) {
console.error('Approve error:', error.response?.data || error.message);
res.status(500).json({ error: 'Fehler beim Genehmigen' });
}
});

app.post('/payments/complete', async (req, res) => {
const { paymentId, txid } = req.body;
if (!paymentId || !txid) return res.status(400).json({ error: 'Daten fehlen' });

const record = payments[paymentId];
if (!record) {
return res.status(400).json({ error: 'Unbekannte Zahlung – approve fehlt' });
}

// Schutz gegen doppeltes Abschließen
if (record.status === 'completed') {
return res.json({ success: true, paymentId, txid, priceType: record.priceType, unlocked: true, alreadyProcessed: true });
}

try {
await axios.post(
`https://api.minepi.com/v2/payments/${paymentId}/complete`,
{ txid },
{ headers: { 'Authorization': `Key ${PI_API_KEY}` } }
);

record.status = 'completed';
record.txid = txid;

res.json({ success: true, paymentId, txid, priceType: record.priceType, unlocked: true });
} catch (error) {
console.error('Complete error:', error.response?.data || error.message);
res.status(500).json({ error: 'Fehler beim Abschließen' });
}
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
