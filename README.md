# Vektor AI

Ubah deskripsi teks menjadi ilustrasi SVG yang bisa diedit. Claude menggambar SVG dari bentuk-bentuk dasar, lalu melihat hasil render-nya sendiri dan memperbaiki bagian yang janggal.

## Cara kerja

1. **Rancang dan gambar.** Claude menulis rencana singkat (objek, bagian, bentuk, warna, posisi), lalu menulis SVG di kanvas 512×512 memakai `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`, dan `g`.
2. **Validasi.** Server menolak SVG yang memuat elemen atau atribut yang bisa menjalankan kode atau memuat sumber luar (`script`, `image`, `use`, `foreignObject`, `on*`, `href`, `url()`, DOCTYPE), lalu mem-parse-nya dengan resvg. SVG yang ditolak dikembalikan ke model untuk diperbaiki.
3. **Perbaikan visual** (0–3 putaran, default 2). Server merender SVG ke PNG dengan [resvg](https://github.com/yisibl/resvg-js), mengirim gambar itu kembali ke Claude, dan Claude memperbaiki proporsi, posisi, bagian yang hilang, atau komposisi. Proses berhenti lebih awal kalau model tidak mengubah apa pun.

Setiap draf dikirim ke browser secara streaming, jadi pengguna bisa melihat dan membandingkan semua versi, lalu mengunduh SVG/PNG atau menyalin kodenya.

Pendekatan ini terinspirasi dari tahap 1 [Chat2SVG](https://github.com/kingnobro/chat2svg) (LLM menulis template SVG lalu memperbaikinya secara visual), tanpa tahap diffusion dan optimasi berbasis GPU.

## Menjalankan

Butuh Node.js 20+ dan API key Anthropic.

```bash
npm ci
cp .env.example .env.local   # isi ANTHROPIC_API_KEY
npm run dev
```

Buka http://localhost:3000.

## Struktur

| File | Isi |
|---|---|
| `src/app/page.tsx` | Halaman utama |
| `src/components/vector-generator.tsx` | UI: form, progres, pratinjau, riwayat draf, unduh |
| `src/app/api/generate/route.ts` | `POST /api/generate`, mengalirkan event NDJSON |
| `src/lib/generate-vector.ts` | Pipeline Claude: gambar → validasi → render → perbaiki |
| `src/lib/prompts.ts` | System prompt dan prompt tiap tahap |
| `src/lib/svg.ts` | Ekstraksi, validasi allowlist, dan render PNG |
| `src/lib/generate-types.ts` | Tipe event, batas input, validasi request |

## Model dan biaya

Pipeline memakai `claude-opus-5-5` dengan effort `medium` (`src/lib/generate-vector.ts`). Satu permintaan menjalankan 1 + jumlah putaran perbaikan panggilan model, dan setiap putaran mengirim ulang seluruh percakapan beserta gambarnya. Prompt caching aktif untuk menekan biaya input berulang. Server-side fallback (`fallbacks: "default"`) aktif, sehingga permintaan yang ditolak classifier keamanan dicoba ulang di model lain.

> **Sebelum deploy publik:** endpoint `/api/generate` belum punya autentikasi atau rate limit. Siapa pun yang tahu URL-nya bisa memakai kredit API Anda.
