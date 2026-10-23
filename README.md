# Trading Replay Tool

Replay chart bar-per-bar dengan indikator pine script, dan latihan entry manual. Data candle dari Binance.

![type](https://img.shields.io/badge/type-replay_tool-blue) ![pinescript](https://img.shields.io/badge/pine-v5%20subset-green)

## Fitur

- **Replay**: play/pause, step ±1 / ±10, slider, kecepatan 0.5–4×, mulai dari tanggal tertentu (WIB)
- **10 koin**: BTC, ETH, BNB, XRP, SOL, TRX, ZEC, HYPE, DOGE, ADA — TF 15m / 1h / 4h / 1D
- **SMC LuxAlgo** sebagai overlay bawaan (BOS/CHoCH swing+internal, order block, EQH/EQL, Strong/Weak High/Low)
- **Script Pine**: tempel indikator Pine Script v5/v6, langsung jalan di chart. Daftar script **dikosongkan** — tidak ada template bawaan
- **Input otomatis**: `input.*` di script langsung jadi kontrol UI (angka, pilihan, warna, on/off)
- **Latihan entry**: LONG/SHORT di close bar kursor, ukuran posisi USDT, SL/TP opsional yang dicek otomatis, equity, floating P/L, winrate, riwayat trade
- **Tanpa server**: murni frontend. Data sesi/trade/script tersimpan di `localStorage` browser masing-masing

## How to use

Buka link Github pages di browser: https://minji972.github.io/ReplayChartCrypto/

> Tidak perlu Docker,tidak perlu `localhost:9000`. 

## Add script Pine

1. Buka panel **Script Pine**
2. Tempel kode indikator Pine Script (diawali `//@version=5` atau `//@version=6`)
3. Centang untuk menampilkan di chart, atau hapus kapan saja

## Yang didukung dari Pine Script

Interpreter bawaan (`js/pine-runtime.js`) ditulis dari nol untuk tool ini — bukan bahasa mini, melainkan subset Pine Script v5/v6 yang sebenarnya:

- `indicator()`, `input.int/float/bool/string/color/source`
- `ta.sma/ema/rma/wma/hma/vwma`, `ta.rsi`, `ta.macd`, `ta.stdev/variance`, `ta.atr/tr`, `ta.highest/lowest`, `ta.pivothigh/pivotlow`, `ta.cross/crossover/crossunder`, `ta.change/mom/roc`, `ta.linreg`, `ta.supertrend`, `ta.cci/mfi/stoch`, `ta.barssince`
- `math.abs/max/min/avg/floor/ceil/round/pow/sqrt/log/exp/sign`, `str.tostring`, `nz()`, `na()`
- `plot`, `plotshape`, `plotchar`, `hline`, `fill`, `bgcolor`, `barcolor`
- `line.new`, `label.new`, `box.new`, `linefill.new` + method umum (`set_*`, `get_price`, `delete`)
- `var`, fungsi `nama() => ...`, `if/else if/else`, `for`, `while`, `switch`, ternary, operator histori `x[1]`
- `barstate.isfirst/islast/...`, `display.*`, `color.new`, konstanta `color.*`/`size.*`/`shape.*`/`location.*`

### 

- `strategy.*` belum didukung — tool ini untuk replay + entry manual, bukan backtest otomatis
- `request.*`, `array.*`/`matrix.*`/`map.*`, `varip`, dan tipe buatan pengguna belum didukung
- Indikator `overlay=false` saat ini digambar di chart utama (belum ada pane terpisah)
- Script yang mengandalkan fitur di atas akan menampilkan pesan error yang jelas saat **Tes**, bukan gagal diam-diam

## Structure

```
trading-replay-tool/
├── index.html            # aplikasi (single page)
├── css/style.css         # tema gelap ala trading
├── js/
│   ├── pine-runtime.js   # interpreter Pine Script v5/v6 subset (tanpa dependensi)
│   ├── smc-engine.js     # engine Smart Money Concepts (port dari LuxAlgo, CC BY-NC-SA 4.0)
│   ├── binance.js        # ambil data klines dari Binance Vision API
│   ├── chart.js          # chart candlestick canvas + overlay
│   └── app.js            # replay, latihan entry, manajemen script
├── README.md
├── LICENSE               # CC BY-NC-SA 4.0
└── .gitignore
```

## 

Setiap indikator (termasuk SMC) dievaluasi ulang dari bar 0 sampai kursor setiap kursor bergerak. Nilai di bar `i` tidak pernah membaca bar `> i`. Pivot butuh konfirmasi N bar, trailing level update per bar — sama seperti perilaku aslinya.

## Lisensi & atribusi

Lisensi di bawah **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)** — lihat `LICENSE`.

- Engine SMC (`js/smc-engine.js`) adalah port dari indikator **"Smart Money Concepts [LuxAlgo]"** © LuxAlgo, berlisensi CC BY-NC-SA 4.0. https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-SMC-LuxAlgo/
- Pine Script® adalah merek dagang terdaftar TradingView, Inc. Tool ini adalah implementasi independen dan tidak berafiliasi dengan TradingView.
- Data pasar oleh Binance.
