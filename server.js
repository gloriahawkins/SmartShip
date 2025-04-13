// Smart Shipping Sync - Combine Orders MVP
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const CombineSchema = new mongoose.Schema({
  customerId: String,
  email: String,
  shippingHash: String,
  recentOrders: [String],
  combinedConfirmed: Boolean,
  createdAt: { type: Date, default: Date.now }
});
const Combine = mongoose.model('Combine', CombineSchema);

function hashAddress(address) {
  return crypto.createHash('md5').update(address.address1 + address.zip).digest('hex');
}

app.post('/webhook/orders/create', async (req, res) => {
  const order = req.body;
  const customerId = order.customer?.id?.toString();
  const email = order.email;
  const shipping = order.shipping_address;
  if (!customerId || !shipping) return res.sendStatus(400);

  const newHash = hashAddress(shipping);
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const recent = await Combine.findOne({
    customerId,
    shippingHash: newHash,
    createdAt: { $gt: sixHoursAgo },
    combinedConfirmed: false
  });

  if (recent) {
    recent.recentOrders.push(order.name);
    await recent.save();
  } else {
    await new Combine({
      customerId,
      email,
      shippingHash: newHash,
      recentOrders: [order.name],
      combinedConfirmed: false
    }).save();
  }
  res.sendStatus(200);
});

app.get('/api/combine-check', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.sendStatus(400);

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const combine = await Combine.findOne({
    customerId,
    createdAt: { $gt: sixHoursAgo },
    combinedConfirmed: false
  });

  if (combine && combine.recentOrders.length >= 2) {
    res.json({ canCombine: true, orders: combine.recentOrders });
  } else {
    res.json({ canCombine: false });
  }
});

app.post('/api/confirm-combine', async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.sendStatus(400);
  await Combine.findOneAndUpdate(
    { customerId },
    { combinedConfirmed: true }
  );
  res.json({ success: true });
});

app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    (function() {
      const customerId = window.__SHOPIFY_CUSTOMER_ID__; // Replace or detect via Liquid
      if (!customerId) return;
      fetch('/api/combine-check?customerId=' + customerId)
        .then(res => res.json())
        .then(data => {
          if (data.canCombine) {
            const msg = "We noticed you've placed multiple orders. Combine them to save on shipping and packaging! ✅";
            const box = document.createElement('div');
            box.innerHTML = '<div style="background:#ecfdf5;padding:12px;border:1px solid #d1fae5;border-radius:6px;position:fixed;bottom:15px;right:15px;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,0.15);font-family:sans-serif;font-size:14px;">' + msg + '<br><button id="combineNow" style="margin-top:8px;padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">Combine Now</button></div>';
            document.body.appendChild(box);
            document.getElementById("combineNow").onclick = () => {
              fetch('/api/confirm-combine', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId })
              }).then(() => {
                box.innerHTML = "✅ Combined! You'll save on shipping, and the planet thanks you 🌍";
              });
            };
          }
        });
    })();
  `);
});

app.listen(PORT, () => console.log(`Smart Shipping Sync server running on port ${PORT}`));
