const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/jalwapay';

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err.message));

const PaymentConfigSchema = new mongoose.Schema({
  upiId: { type: String, default: '' },
  upiName: { type: String, default: '' },
  bankName: { type: String, default: '' },
  accountHolder: { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  ifscCode: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

const UserWalletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, default: 'User' },
  balance: { type: Number, default: 0 },
  cashbackToday: { type: Number, default: 0 }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAW', 'CASHBACK'], required: true },
  amount: { type: Number, required: true },
  utrOrDest: { type: String, default: '' },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

const PaymentConfig = mongoose.model('PaymentConfig', PaymentConfigSchema);
const UserWallet = mongoose.model('UserWallet', UserWalletSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

function requireAdmin(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.body?.pin;
  if (!pin || String(pin) !== String(ADMIN_PIN)) {
    return res.status(401).json({ error: 'Invalid Admin PIN' });
  }
  next();
}

async function getOrCreateWallet(userId = 'JP-849201') {
  let wallet = await UserWallet.findOne({ userId });
  if (!wallet) {
    wallet = await UserWallet.create({
      userId,
      name: 'Rahul Sharma',
      balance: 1250,
      cashbackToday: 85
    });
  }
  return wallet;
}

// --- Public / User Endpoints ---

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'jalwapay-backend' });
});

app.get('/api/payment-config', async (req, res) => {
  try {
    const config = await PaymentConfig.findOne().sort({ updatedAt: -1 });
    res.json({ config: config || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.params.userId);
    const transactions = await Transaction.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.json({ wallet, transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { userId = 'JP-849201', amount, utrNumber } = req.body;
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }
    if (!utrNumber || String(utrNumber).trim().length < 6) {
      return res.status(400).json({ error: 'Valid UTR / Reference number required' });
    }

    await getOrCreateWallet(userId);
    const tx = await Transaction.create({
      userId,
      type: 'DEPOSIT',
      amount: numericAmount,
      utrOrDest: String(utrNumber).trim(),
      status: 'PENDING'
    });

    res.status(201).json({ transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId = 'JP-849201', amount, destination } = req.body;
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const wallet = await getOrCreateWallet(userId);
    if (wallet.balance < numericAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    wallet.balance -= numericAmount;
    await wallet.save();

    const tx = await Transaction.create({
      userId,
      type: 'WITHDRAW',
      amount: numericAmount,
      utrOrDest: destination || 'Saved Bank/UPI',
      status: 'PENDING'
    });

    res.status(201).json({ wallet, transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin Endpoints ---

app.post('/api/admin/payment-config', requireAdmin, async (req, res) => {
  try {
    const { upiId, upiName, bankName, accountHolder, accountNumber, ifscCode } = req.body;
    let config = await PaymentConfig.findOne();
    if (!config) {
      config = new PaymentConfig();
    }
    config.upiId = upiId || '';
    config.upiName = upiName || '';
    config.bankName = bankName || '';
    config.accountHolder = accountHolder || '';
    config.accountNumber = accountNumber || '';
    config.ifscCode = ifscCode || '';
    config.updatedAt = new Date();
    await config.save();

    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/transactions/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision } = req.body; // 'APPROVED' or 'REJECTED'
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be APPROVED or REJECTED' });
    }

    const tx = await Transaction.findById(req.params.id);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    if (tx.status !== 'PENDING') {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    tx.status = decision;
    await tx.save();

    const wallet = await getOrCreateWallet(tx.userId);
    if (tx.type === 'DEPOSIT' && decision === 'APPROVED') {
      wallet.balance += tx.amount;
      await wallet.save();
    }
    if (tx.type === 'WITHDRAW' && decision === 'REJECTED') {
      wallet.balance += tx.amount;
      await wallet.save();
    }

    res.json({ transaction: tx, wallet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
