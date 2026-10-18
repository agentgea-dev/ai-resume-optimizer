# Vektor AI

Tulis satu tema, dapatkan satu set ilustrasi SVG yang bisa diedit (sampai 100 gambar sekali jalan). Sebuah model bahasa menyusun daftar subjek yang berhubungan dengan tema beserta satu gaya visual bersama, lalu menggambar setiap subjek sebagai SVG. Default-nya model open-source lewat [Groq](https://groq.com); Claude (Haiku, Sonnet, Opus) bisa dipilih di UI.

## Cara kerja

1. **Perencanaan.** Satu panggilan JSON (model Groq yang sama, atau Claude Haiku bila model Claude dipilih) menghasilkan `N` subjek berbeda yang berhubungan dengan tema (struktur, peralatan, kendaraan, orang, proses, lingkungan, simbol), plus palet 5–8 warna dan catatan gaya untuk seluruh set. Kalau daftarnya kurang dari `N`, model diminta menambah (maksimal 2 kali); judul ganda dibuang.
2. **Menggambar paralel.** Setiap subjek digambar dalam panggilan terpisah (4 sekaligus untuk Groq, 8 untuk Claude), dengan gaya maskot flat: outline gelap tebal yang seragam, siluet dari kurva Bézier, dan cel shading dua nada (bayangan dipotong dengan `clipPath`). Aturan kanvas, gaya, dan konteks set (tema, palet) ada di system prompt yang di-cache dan dipakai bersama oleh semua gambar.
3. **Validasi.** Server menolak SVG yang memuat elemen atau atribut yang bisa menjalankan kode atau memuat sumber luar (`script`, `image`, `use`, `foreignObject`, `on*`, `href`, `url()` ke luar file, DOCTYPE), lalu mem-parse-nya dengan resvg. `url(#id)` ke `clipPath` di file yang sama diizinkan. SVG yang ditolak dikembalikan ke model sekali untuk diperbaiki.
4. **Perbaikan visual** (0–2 putaran per gambar, default 0, khusus model Claude). Server merender SVG ke PNG dengan [resvg](https://github.com/yisibl/resvg-js) dan mengirimnya kembali ke model untuk dikoreksi. Untuk Groq fitur ini dimatikan karena model default-nya hanya membaca teks.

Gambar yang gagal (ditolak model, SVG tetap tidak valid, atau error API setelah retry) ditandai di grid tanpa menghentikan gambar lain. Error yang pasti berulang untuk semua gambar (API key salah, request tidak valid) menghentikan seluruh set. Hasil bisa diunduh satu per satu (SVG/PNG) atau sekaligus sebagai ZIP.

Pendekatan ini terinspirasi dari tahap 1 [Chat2SVG](https://github.com/kingnobro/chat2svg) (LLM menulis template SVG lalu memperbaikinya secara visual), tanpa tahap diffusion dan optimasi berbasis GPU.

## Menjalankan

Butuh Node.js 20+ dan API key untuk penyedia yang dipakai: `GROQ_API_KEY` (default) dan/atau `ANTHROPIC_API_KEY`.

```bash
npm ci
cp .env.example .env.local   # isi GROQ_API_KEY dan/atau ANTHROPIC_API_KEY
npm run dev
```

Buka http://localhost:3000.

## Struktur

| File | Isi |
|---|---|
| `src/app/page.tsx` | Halaman utama |
| `src/components/vector-generator.tsx` | UI: form, progres, grid hasil, detail, unduh SVG/PNG/ZIP |
| `src/app/api/generate/route.ts` | `POST /api/generate`, mengalirkan event NDJSON |
| `src/lib/generate-vector.ts` | Pipeline: rencana set → gambar paralel → validasi → render → perbaiki |
| `src/lib/model-sessions.ts` | Sesi percakapan per penyedia (Groq, Anthropic), daftar model, dan penanganan error API |
| `src/lib/prompts.ts` | System prompt dan prompt tiap tahap |
| `src/lib/svg.ts` | Ekstraksi, validasi allowlist, dan render PNG |
| `src/lib/generate-types.ts` | Tipe event, batas input, validasi request |

## Model, waktu, dan biaya

- **Groq (default):** perencanaan dan menggambar memakai `GROQ_MODEL` (default `openai/gpt-oss-120b`) lewat `groq-sdk`, dengan JSON mode untuk perencanaan. Model lain di Groq bisa dipakai lewat `GROQ_MODEL`, asalkan mendukung JSON mode dan output panjang. Kualitas gambarnya belum diuji. Tier gratis Groq membatasi token per menit; set 100 gambar bisa lambat atau sebagian gagal karena rate limit (SDK mencoba ulang 429 sampai 8 kali).
- **Claude:** perencanaan memakai `claude-haiku-5-5`. Model penggambar: Haiku (`claude-haiku-5-5`), Sonnet (`claude-sonnet-5-5`), Opus (`claude-opus-5-5`), atau Opus 4 (`claude-opus-4-0`), dengan effort `medium`. Biaya per gambar kira-kira 1× / 20× / 40× / 150× menurut harga per token.
- Dalam uji buta (4 subjek, skala 1–10) Sonnet dan Opus 5.5 sama-sama mendapat 6,3 dan Haiku 5,0. Opus 4 belum diuji; model ini sudah deprecated, tidak mendukung parameter effort maupun fallback, dan bisa dihentikan Anthropic sewaktu-waktu.
- Sonnet dan Opus memakai server-side fallback (`fallbacks: "default"`), jadi gambar yang ditolak classifier keamanan dicoba ulang di model lain. Haiku 5.5 tidak punya fallback, jadi penolakan ditandai gagal per gambar.
- Satu set = 1 panggilan perencanaan + `N × (1 + putaran perbaikan)` panggilan menggambar (ditambah perbaikan SVG tidak valid bila perlu). 100 gambar tanpa perbaikan ≈ 101 panggilan.
- Jumlah gambar yang digambar bersamaan diatur di `concurrencyFor()` (`src/lib/model-sessions.ts`): 4 untuk Groq, 8 untuk Claude. SDK Anthropic mencoba ulang 429/5xx sampai 5 kali.
- Route mengizinkan sampai 800 detik (`maxDuration`). Batas sebenarnya di hosting (mis. Vercel) tergantung paket.

> **Sebelum deploy publik:** endpoint `/api/generate` belum punya autentikasi atau rate limit. Siapa pun yang tahu URL-nya bisa memakai kredit API Anda.
