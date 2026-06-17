const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const PI_API_KEY = process.env.PI_API_KEY || 'qpajxlt4hrhsyboirfu5e5b1vxze3nn37ci5cr6lfmhccpi9vuggdckg1aunuayy';

app.use(express.json());
app.use(cors({
origin: ['https://golden-cobbler-2dc822.netlify.app', 'https://sandbox.minepi.com'],
methods: ['GET', 'POST'],
allowedHeaders: ['Content-Type', 'Authorization']
}));

const payments = {};

app.get('/', (req, res) => {
res.json({ status: 'Pi Kids Math Backend läuft!', version: '1.0' });
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
payments[paymentId] = { id: paymentId, amount: payment.amount, status: 'approved', timestamp: new Date() };
await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {}, { headers: { 'Authorization': `Key ${PI_API_KEY}` } });
res.json({ success: true, paymentId, amount: payment.amount });
} catch (error) {
res.status(500).json({ error: 'Fehler beim Genehmigen' });
}
});

app.post('/payments/complete', async (req, res) => {
const { paymentId, txid } = req.body;
if (!paymentId || !txid) return res.status(400).json({ error: 'Daten fehlen' });
try {
await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/complete`, { txid }, { headers: { 'Authorization': `Key ${PI_API_KEY}` } });
if (payments[paymentId]) { payments[paymentId].status = 'completed'; payments[paymentId].txid = txid; }
res.json({ success: true, paymentId, txid, unlocked: true });
} catch (error) {
res.status(500).json({ error: 'Fehler beim Abschließen' });
}
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
