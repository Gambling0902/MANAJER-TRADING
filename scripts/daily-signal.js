// ============================================================================
// daily-signal.js
// -----------------------------------------------------------------------------
// Jalan di GitHub Actions (server-side, cron), BUKAN di browser. Tujuannya
// generate "SINYAL DAILY / HOLD" dari data candle harian ASLI (bukan tick
// spot price kayak sinyal Otomatis & Intraday yang cuma punya ~2.5 jam histori).
//
// v2 (REVISI): sebelumnya sinyal keluar cuma dari SMA5 vs SMA15 (trend-follow
// biasa) dan entry langsung market price berapa pun -- itu BUKAN swing yang
// benar. Sekarang sinyal HANYA keluar kalau ada REJECTION beneran di swing
// high/low (candle dengan wick panjang + close balik arah), dan harga
// sekarang masih di area zona rejection itu. Konsekuensinya: sinyal jadi
// jauh lebih jarang muncul, tapi tiap muncul beneran representasi "swing
// point dengan rejection", cocok buat di-hold beberapa hari.
//
//   1. Ambil 30 candle harian XAU/USD dari Twelve Data.
//   2. Cari swing high & swing low di SWING_LOOKBACK_DAYS hari terakhir
//      (exclude hari berjalan) -- ambil candle yang BENERAN bikin extreme itu.
//   3. Cek REJECTION di candle swing low (buat kandidat BUY) dan swing high
//      (buat kandidat SELL):
//        - wick (lower/upper) harus jauh lebih panjang dari body candle
//          (>= REJECTION_WICK_RATIO x body)
//        - close harus balik ke arah berlawanan dari extreme (close di
//          setengah bagian candle yang berlawanan dari wick)
//   4. Kalau rejection valid di salah satu sisi, cek juga bias SMA5 vs SMA15
//      searah (biar tidak swing melawan tren besar) -- kalau berlawanan,
//      dilewati.
//   5. Entry cuma dianggap valid kalau harga SEKARANG masih dekat zona
//      rejection itu (bukan sudah lari jauh) -- pakai MAX_ENTRY_DRIFT_USD.
//   6. State machine (pending -> active -> resolved) sama seperti sebelumnya:
//        - ENTRY_WINDOW: 6 jam nunggu harga menyentuh entry
//        - SAFETY_TIMEOUT: 3 hari (kalau macet total, dianggap gagal)
//   7. State + log disimpan ke Firebase yang SAMA dipakai index.html, jadi
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

// ----- Parameter baru buat validasi rejection -----
const REJECTION_WICK_RATIO = 1.5;   // wick minimal 1.5x lebih panjang dari body candle
const MIN_WICK_USD = 2;             // wick minimal segini (hindari noise di candle super kecil)
const MAX_ENTRY_DRIFT_USD = 8;      // harga sekarang maks segini jauhnya dari level rejection,
                                     // biar gak "kejar" swing yang udah lewat/lari jauh

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

// Cari candle yang BENERAN membentuk swing high & swing low di antara
// SWING_LOOKBACK_DAYS candle terakhir yang SUDAH closed (exclude hari ini
// karena candle harian berjalan belum final). Balikin candle-nya, bukan
// cuma angkanya, karena kita perlu body/wick buat cek rejection.
function findSwingCandles(candles) {
  const closed = candles.slice(0, -1); // buang candle hari ini (belum closed)
  const recent = closed.slice(-SWING_LOOKBACK_DAYS);
  if (!recent.length) return null;

  let lowCandle = recent[0], highCandle = recent[0];
  for (const c of recent) {
    if (c.low < lowCandle.low) lowCandle = c;
    if (c.high > highCandle.high) highCandle = c;
  }
  return { lowCandle, highCandle };
}

// Cek apakah sebuah candle menunjukkan REJECTION di sisi bawah (bekas swing
// low) -- wick bawah panjang + close balik ke atas. Dipakai buat kandidat BUY.
function isBullishRejection(c) {
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const range = c.high - c.low;
  if (range <= 0 || lowerWick < MIN_WICK_USD) return false;
  if (lowerWick < body * REJECTION_WICK_RATIO) return false;
  // close harus di setengah bagian ATAS candle (balik naik dari low-nya)
  const closePosition = (c.close - c.low) / range;
  return closePosition >= 0.5;
}

// Kebalikannya -- rejection di sisi atas (bekas swing high), wick atas
// panjang + close balik ke bawah. Dipakai buat kandidat SELL.
function isBearishRejection(c) {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const range = c.high - c.low;
  if (range <= 0 || upperWick < MIN_WICK_USD) return false;
  if (upperWick < body * REJECTION_WICK_RATIO) return false;
  // close harus di setengah bagian BAWAH candle (balik turun dari high-nya)
  const closePosition = (c.high - c.close) / range;
  return closePosition >= 0.5;
}

async function generateNewSignal(candles, currentPrice) {
  const closes = candles.map(c => c.close);
  const smaShort = sma(closes, SMA_SHORT);
  const smaLong = sma(closes, SMA_LONG);
  const swing = findSwingCandles(candles);

  if (smaShort === null || smaLong === null || !swing) {
    return { skipped: true, reason: 'Data candle belum cukup untuk analisa daily.' };
  }

  const trendUp = smaShort > smaLong;
  const bufferBuffer = Math.max(currentPrice * 0.0015, 1.5); // buffer volatilitas ~0.15%

  const bullishRejection = isBullishRejection(swing.lowCandle);
  const bearishRejection = isBearishRejection(swing.highCandle);

  // Butuh rejection BENERAN di salah satu sisi. Kalau kedua sisi sekaligus
  // reject (jarang, tapi bisa di market choppy), ambil yang searah SMA biar
  // gak melawan tren besar. Kalau nggak ada rejection sama sekali -> skip,
  // ini yang bikin sinyal jadi jarang muncul (sesuai maksudnya "swing").
  let dir = null;
  if (bullishRejection && bearishRejection) {
    dir = trendUp ? 'buy' : 'sell';
  } else if (bullishRejection) {
    dir = 'buy';
  } else if (bearishRejection) {
    dir = 'sell';
  }

  if (!dir) {
    return { skipped: true, reason: `Belum ada rejection valid di swing high (${swing.highCandle.high.toFixed(2)}) atau swing low (${swing.lowCandle.low.toFixed(2)}) ${SWING_LOOKBACK_DAYS} hari terakhir -- ditunggu dulu, bukan asal ikut arah SMA.` };
  }

  // Sinyal harus searah tren SMA juga -- rejection doang gak cukup kalau
  // jelas-jelas melawan tren besar (biar tetap "swing following the trend",
  // bukan asal counter-trend tiap ada wick).
  if ((dir === 'buy' && !trendUp) || (dir === 'sell' && trendUp)) {
    return { skipped: true, reason: `Rejection ${dir === 'buy' ? 'bullish di swing low' : 'bearish di swing high'} kedeteksi, TAPI berlawanan dengan bias SMA${SMA_SHORT}/SMA${SMA_LONG} harian -- dilewati, jangan lawan tren besar.` };
  }

  let entry, sl, tp, reason;
  const rejectionLevel = dir === 'buy' ? swing.lowCandle.low : swing.highCandle.high;

  // Harga sekarang harus masih di sekitar zona rejection -- kalau udah lari
  // jauh dari level itu, berarti momen entry-nya udah lewat, bukan dikejar.
  const drift = Math.abs(currentPrice - rejectionLevel);
  if (drift > MAX_ENTRY_DRIFT_USD) {
    return { skipped: true, reason: `Rejection valid di ${dir === 'buy' ? 'swing low' : 'swing high'} (${rejectionLevel.toFixed(2)}), TAPI harga sekarang (${currentPrice.toFixed(2)}) sudah lari ${drift.toFixed(1)} dari zona itu -- momen entry sudah lewat, ditunggu setup baru.` };
  }

  if (dir === 'buy') {
    entry = currentPrice;
    sl = swing.lowCandle.low - bufferBuffer;
    const risk = entry - sl;
    if (risk < MIN_RISK_USD) return { skipped: true, reason: 'Jarak swing low terlalu dekat, risiko kurang valid.' };
    tp = entry + risk * 2; // R:R 1:2
    reason = `Rejection bullish kedeteksi di swing low ${SWING_LOOKBACK_DAYS} hari terakhir (${swing.lowCandle.low.toFixed(2)}, candle ${swing.lowCandle.time}) -- wick bawah panjang, close balik naik. Searah bias SMA${SMA_SHORT}/SMA${SMA_LONG} harian. SL di bawah swing low + buffer. Cocok di-hold sampai TP/SL tersentuh, target beberapa hari, bukan buat scalping.`;
  } else {
    entry = currentPrice;
    sl = swing.highCandle.high + bufferBuffer;
    const risk = sl - entry;
    if (risk < MIN_RISK_USD) return { skipped: true, reason: 'Jarak swing high terlalu dekat, risiko kurang valid.' };
    tp = entry - risk * 2;
    reason = `Rejection bearish kedeteksi di swing high ${SWING_LOOKBACK_DAYS} hari terakhir (${swing.highCandle.high.toFixed(2)}, candle ${swing.highCandle.time}) -- wick atas panjang, close balik turun. Searah bias SMA${SMA_SHORT}/SMA${SMA_LONG} harian. SL di atas swing high + buffer. Cocok di-hold sampai TP/SL tersentuh, target beberapa hari, bukan buat scalping.`;
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
