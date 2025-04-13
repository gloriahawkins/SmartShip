// Smart Shipping Sync - Combine Orders MVP with Fulfillment Tag Update
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
  shippingCost: Number,
  createdAt: { type: Date, default: Date.now }
});
const Combine = mongoose.model('Combine', CombineSchema);

function hashAddress(address) {
  return crypto.createHash('md5').update(address.address1 + address.zip).digest('hex');
}

// Helper to update Shopify order with a tag
async function tagShopifyOrder(orderId, shop, accessToken, tagText) {
  await axios.put(
    `https://${shop}/admin/api/2023-10/orders/${orderId}.json`,
    {
      order: {
        id: orderId,
        tags: tagText
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    }
  );
}

app.post('/webhook/orders/create', async (req, res) => {
  const order = req.body;
  const customerId = order.customer?.id?.toString();
  const email = order.email;
  const shipping = order.shipping_address;
  const fulfillmentStatus = order.fulfillment_status;
  if (!customerId || !shipping || fulfillmentStatus !== 'unfulfilled') {
    return res.status(200).send('Order already fulfilled or in progress');
  }

  const newHash = hashAddress(shipping);
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const recent = await Combine.findOne({
    customerId,
    shippingHash: newHash,
    createdAt: { $gt: sixHoursAgo },
    combinedConfirmed: false
  });

  const shippingCost = parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0);

  if (recent) {
    recent.recentOrders.push(order.name);
    await recent.save();
  } else {
    await new Combine({
      customerId,
      email,
      shippingHash: newHash,
      recentOrders: [order.name],
      combinedConfirmed: false,
      shippingCost
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
    res.json({ canCombine: true, orders: combine.recentOrders, shippingCost: combine.shippingCost });
  } else {
    res.json({ canCombine: false });
  }
});

app.post('/api/confirm-combine', async (req, res) => {
  const { customerId, orderId, shop, accessToken } = req.body;
  if (!customerId || !orderId || !shop || !accessToken) return res.sendStatus(400);

  await Combine.findOneAndUpdate(
    { customerId },
    { combinedConfirmed: true }
  );

  try {
    await tagShopifyOrder(orderId, shop, accessToken, 'Hold for Combine');
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to tag order:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to update Shopify order' });
  }
});

app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    (function() {
      const customerId = window.__SHOPIFY_CUSTOMER_ID__;
      const orderId = window.__SHOPIFY_ORDER_ID__;
      const shop = window.__SHOPIFY_SHOP__;
      const token = window.__SHOPIFY_ACCESS_TOKEN__;
      if (!customerId || !orderId || !shop || !token) return;

      fetch('/api/combine-check?customerId=' + customerId)
        .then(res => res.json())
        .then(data => {
          if (data.canCombine) {
            let msg = "We noticed you've placed multiple orders. Combine them to save on shipping and packaging! ✅";
            if (data.shippingCost > 0) {
              msg += "<br>You’ll only pay $2 shipping instead of $" + data.shippingCost + "!";
            } else {
              msg += "<br>Shipping is already free — let’s save the planet together 🌍";
            }
            const box = document.createElement('div');
            box.innerHTML = '<div style="background:#ecfdf5;padding:12px;border:1px solid #d1fae5;border-radius:6px;position:fixed;bottom:15px;right:15px;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,0.15);font-family:sans-serif;font-size:14px;">' + msg + '<br><button id="combineNow" style="margin-top:8px;padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">Combine Now</button></div>';
            document.body.appendChild(box);
            document.getElementById("combineNow").onclick = () => {
              fetch('/api/confirm-combine', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId, orderId, shop, accessToken: token })
              }).then(() => {
                box.innerHTML = "✅ Combined! You'll save on shipping, and the planet thanks you 🌍";
              });
            };
          }
        });
    })();
  `);
});

app.get('/admin/combined-orders', async (req, res) => {
  const pending = await Combine.find({ combinedConfirmed: false }).sort({ createdAt: -1 });
  let html = '<h2>Pending Order Combines</h2><ul>';
  pending.forEach(c => {
    html += `<li><strong>${c.email}</strong> | Orders: ${c.recentOrders.join(', ')} | Shipping: $${c.shippingCost} | Created: ${c.createdAt.toLocaleString()}</li>`;
  });
  html += '</ul>';
  res.send(`<html><head><title>Smart Shipping Sync Admin</title></head><body style="font-family:sans-serif;padding:20px;">${html}</body></html>`);
});

app.listen(PORT, () => console.log(`Smart Shipping Sync server running on port ${PORT}`));
