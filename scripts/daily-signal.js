// ============================================================================
// daily-signal.js
// -----------------------------------------------------------------------------
// Jalan di GitHub Actions (server-side, cron), BUKAN di browser. Tujuannya
// generate "SINYAL DAILY / HOLD" dari data candle harian ASLI (bukan tick
// spot price kayak sinyal Otomatis & Intraday yang cuma punya ~2.5 jam histori).
//
// Logic-nya sengaja disederhanakan (bukan 100% akurat, tapi valid buat
// rekomendasi arah + level, sesuai request user):
//   1. Ambil 30 candle harian XAU/USD dari Twelve Data.
//   2. Bias tren dari SMA5 vs SMA15 (closing price harian).
//   3. Swing high/low signifikan dari 10 hari terakhir (exclude hari berjalan)
//      dipakai sebagai referensi SL & TP.
//   4. State machine (pending -> active -> resolved) sama seperti sinyal
//      client, tapi jendela waktunya cocok buat "hold seharian":
//        - ENTRY_WINDOW: 6 jam nunggu harga menyentuh entry
//        - SAFETY_TIMEOUT: 3 hari (kalau macet total, dianggap gagal)
//   5. State + log disimpan ke Firebase yang SAMA dipakai index.html, jadi
//      begitu app dibuka di HP/laptop, tinggal baca -- gak perlu hitung ulang.
// ============================================================================

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const FIREBASE_URL = 'https://gold-terminal-c3225-default-rtdb.asia-southeast1.firebasedatabase.app';

const SYMBOL = 'XAU/USD';
const ENTRY_WINDOW_MS = 6 * 60 * 60 * 1000;       // 6 jam nunggu entry ke-touch
const SAFETY_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000; // 3 hari jaring pengaman
const SWING_LOOKBACK_DAYS = 10;                    // rentang cari swing high/low
const SMA_SHORT = 5;
const SMA_LONG = 15;
const MIN_RISK_USD = 3;   // jarak entry-SL minimal (hindari sinyal ketiban noise)

if (!TWELVEDATA_API_KEY) {
  console.error('TWELVEDATA_API_KEY belum di-set (cek GitHub Secrets).');
  process.exit(1);
}

async function fetchDailyCandles() {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=1day&outputsize=30&apikey=${TWELVEDATA_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || !Array.isArray(data.values)) {
    throw new Error('Twelve Data error: ' + JSON.stringify(data));
  }
  // Twelve Data returns newest first -> balikkan supaya kronologis (lama -> baru)
  return data.values
    .map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close)
    }))
    .reverse();
}

async function fetchSpotPrice() {
  const res = await fetch('https://api.gold-api.com/price/XAU');
  const data = await res.json();
  return data.price;
}

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return res.json();
}

async function fbPut(path, body) {
  await fetch(`${FIREBASE_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Cari swing high & swing low sederhana: titik tertinggi/terendah di antara
// SWING_LOOKBACK_DAYS candle terakhir yang SUDAH closed (exclude hari ini
// karena candle harian berjalan belum final).
function findDailySwing(candles) {
  const closed = candles.slice(0, -1); // buang candle hari ini (belum closed)
  const recent = closed.slice(-SWING_LOOKBACK_DAYS);
  if (!recent.length) return null;
  const swingHigh = Math.max(...recent.map(c => c.high));
  const swingLow = Math.min(...recent.map(c => c.low));
  return { swingHigh, swingLow };
}

async function generateNewSignal(candles, currentPrice) {
  const closes = candles.map(c => c.close);
  const smaShort = sma(closes, SMA_SHORT);
  const smaLong = sma(closes, SMA_LONG);
  const swing = findDailySwing(candles);

  if (smaShort === null || smaLong === null || !swing) {
    return { skipped: true, reason: 'Data candle belum cukup untuk analisa daily.' };
  }

  const trendUp = smaShort > smaLong;
  const bufferBuffer = Math.max(currentPrice * 0.0015, 1.5); // buffer volatilitas ~0.15%

  let dir, entry, sl, tp, reason;

  if (trendUp) {
    dir = 'buy';
    entry = currentPrice;
    sl = swing.swingLow - bufferBuffer;
    const risk = entry - sl;
    if (risk < MIN_RISK_USD) return { skipped: true, reason: 'Jarak swing low terlalu dekat, risiko kurang valid.' };
    tp = entry + risk * 2; // R:R 1:2
    reason = `Bias naik harian (SMA${SMA_SHORT} di atas SMA${SMA_LONG}). SL di bawah swing low ${SWING_LOOKBACK_DAYS} hari terakhir + buffer. Cocok di-hold sampai TP/SL tersentuh, target seharian-beberapa hari, bukan buat scalping.`;
  } else {
    dir = 'sell';
    entry = currentPrice;
    sl = swing.swingHigh + bufferBuffer;
    const risk = sl - entry;
    if (risk < MIN_RISK_USD) return { skipped: true, reason: 'Jarak swing high terlalu dekat, risiko kurang valid.' };
    tp = entry - risk * 2;
    reason = `Bias turun harian (SMA${SMA_SHORT} di bawah SMA${SMA_LONG}). SL di atas swing high ${SWING_LOOKBACK_DAYS} hari terakhir + buffer. Cocok di-hold sampai TP/SL tersentuh, target seharian-beberapa hari, bukan buat scalping.`;
  }

  return {
    skipped: false,
    signal: {
      dir, entry, sl, tp, reason,
      createdAt: Date.now(),
      entryDeadline: Date.now() + ENTRY_WINDOW_MS,
      status: 'pending',
      triggeredAt: null
    }
  };
}

async function appendLog(entry) {
  const log = (await fbGet('signalLog')) || [];
  const arr = Array.isArray(log) ? log : [];
  arr.unshift({ ...entry, type: 'daily' });
  await fbPut('signalLog', arr.slice(0, 200));
}

async function main() {
  const [candles, currentPrice] = await Promise.all([fetchDailyCandles(), fetchSpotPrice()]);

  const stateWrap = await fbGet('dailySignalState');
  let t = stateWrap && stateWrap.signal ? stateWrap.signal : null;
  const now = Date.now();

  if (t && t.status === 'pending') {
    const touched = t.dir === 'buy' ? currentPrice <= t.entry : currentPrice >= t.entry;
    if (touched) {
      t.status = 'active';
      t.triggeredAt = now;
      console.log('Daily signal pending -> active (entry touched).');
    } else if (now > t.entryDeadline) {
      await appendLog({ result: 'expired', dir: t.dir, entry: t.entry, sl: t.sl, tp: t.tp, at: now, note: 'Entry harian tidak tersentuh dalam 6 jam.' });
      t = null;
      console.log('Daily signal expired (entry window habis).');
    }
  } else if (t && t.status === 'active') {
    const hitTP = t.dir === 'buy' ? currentPrice >= t.tp : currentPrice <= t.tp;
    const hitSL = t.dir === 'buy' ? currentPrice <= t.sl : currentPrice >= t.sl;
    if (hitTP || hitSL) {
      await appendLog({ result: hitTP ? 'win' : 'loss', dir: t.dir, entry: t.entry, sl: t.sl, tp: t.tp, at: now, triggeredAt: t.triggeredAt });
      t = null;
      console.log(`Daily signal resolved: ${hitTP ? 'WIN' : 'LOSS'}.`);
    } else if (now - t.createdAt > SAFETY_TIMEOUT_MS) {
      await appendLog({ result: 'expired', dir: t.dir, entry: t.entry, sl: t.sl, tp: t.tp, at: now, note: 'Timeout keamanan 3 hari, belum resolve TP/SL.' });
      t = null;
      console.log('Daily signal expired (safety timeout 3 hari).');
    }
  }

  if (!t) {
    const result = await generateNewSignal(candles, currentPrice);
    if (result.skipped) {
      console.log('Belum generate sinyal daily baru:', result.reason);
    } else {
      t = result.signal;
      console.log('Sinyal daily baru:', JSON.stringify(t));
    }
  }

  await fbPut('dailySignalState', { signal: t, updatedAt: now, lastPrice: currentPrice, lastRun: new Date(now).toISOString() });
  console.log('Selesai. State daily tersimpan ke Firebase.');
}

main().catch(err => {
  console.error('daily-signal.js gagal:', err);
  process.exit(1);
});
