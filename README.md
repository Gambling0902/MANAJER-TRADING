# XAU/USD Analysis Terminal (PWA)

Dashboard analisa teknikal + fundamental gold, live, bisa dipasang di HP seperti aplikasi (tanpa perlu file .apk).

## 1. Upload ke GitHub

1. Buat repo baru di GitHub, misalnya `gold-terminal`.
2. Upload semua file di folder ini (`index.html`, `manifest.json`, `service-worker.js`, `icon-192.png`, `icon-512.png`) ke repo tersebut — bisa drag & drop lewat web GitHub (tombol "Add file" → "Upload files").
3. Masuk ke **Settings → Pages**.
4. Di bagian **Source**, pilih branch `main` dan folder `/ (root)`, lalu **Save**.
5. Tunggu 1-2 menit. GitHub akan kasih link seperti:
   `https://username-kamu.github.io/gold-terminal/`

## 2. Pasang di HP (Android)

1. Buka link GitHub Pages di atas pakai **Chrome** di HP.
2. Tap menu titik tiga (⋮) di pojok kanan atas → **"Add to Home screen"** / **"Tambahkan ke Layar Utama"**.
3. Ikon "Gold Terminal" akan muncul di home screen HP kamu, terbuka full-screen kayak app biasa (tanpa address bar browser).

## 3. Pasang di HP (iPhone)

1. Buka link GitHub Pages pakai **Safari**.
2. Tap tombol **Share** (kotak dengan panah ke atas) → **"Add to Home Screen"**.

## 4. Kalau tetap mau file .apk asli

PWA di atas sudah cukup untuk kebutuhan "buka cepat dari HP saat mau trading". Tapi kalau tetap ingin file `.apk` yang bisa di-install manual:

1. Selesaikan langkah 1 (repo sudah live di GitHub Pages).
2. Buka **https://www.pwabuilder.com** di browser.
3. Masukkan URL GitHub Pages kamu, klik **Start**.
4. Pilih platform **Android** → klik **Generate Package** → download file `.apk`-nya.
5. Ini gratis, resmi (dipakai banyak developer), dan tidak perlu install software tambahan di komputer.

## Catatan

- Semua data (harga, chart, sinyal, berita, kalender) tetap live, bukan disimpan di GitHub — GitHub cuma nge-host tampilannya.
- Kalau nanti mau update dashboard (nambah fitur dll), tinggal edit `index.html` di GitHub, otomatis ke-update di HP kamu (asal koneksi internet nyala, karena PWA fetch versi terbaru tiap dibuka).
