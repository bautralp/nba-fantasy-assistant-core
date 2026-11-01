# AGENTS.md — NBA Fantasy Assistant ajan talimatları

Bu dosya repoda çalışan bütün AI geliştiriciler (Codex, Claude Code ve diğerleri)
için kalıcı kurallardır. Değişen durumlar (açık PR'lar, geçici bulgular, deney
sonuçları) burada değil, `docs/` altındaki tarihli raporlarda tutulur.

## Ürün ve roller

- NBA Fantasy Basketball (H2H 9CAT) için karar desteği: Oyuncu Sıralamaları,
  Draft Asistanı ve Sezon İçi Asistanı. Hesaplar gerçek istatistiğe, açık
  varsayımlara ve açıklanabilir modellere dayanır.
- Kullanıcı ürün sahibi ve nihai karar vericidir. Ürün kapsamı ve kabul
  kriterleri ajan tarafından değiştirilmez; teknik tercihler gerekçeyle önerilir.
- Kişisel/hobi kapsamı: gerçek ihtiyaç gösterilmeden backend, veritabanı,
  üyelik, ödeme veya ücretli API önerilmez.
- UI dili Türkçe; kod, identifier ve teknik isimlendirme mevcut İngilizce
  standarttadır. Kullanıcıyla Türkçe iletişim kurulur.

## Mimari sınırlar

- `src/domain/` ve `src/engine/` saf ve deterministiktir: React, DOM, ağ, dosya,
  saat, rastgelelik ve storage erişimi yoktur.
- İş kuralı UI bileşenlerine gömülmez. Ham harici API JSON'u doğrudan hesaplama
  motoruna girmez; önce normalize edilir.
- Draft motoru (v3.3 davranışı, 10 takım / 13 oyuncu / snake) ile Sezon motoru
  (`src/seasonAnalysis/`, gerçek ESPN slot/roster kuralları) ayrı sözleşmelerdir.
  Draft sabitleri sezon modüllerine taşınmaz; farklı normalizasyon otomatik bug değildir.
- Waiver ve Takas yalnız what-if simülasyonudur. ESPN'e yazan hiçbir istek
  (transaction, claim, roster, cookie) eklenmez.

## Veri kuralları

- `null` bilinmiyor, `0` doğrulanmış sıfırdır. Eksik veri sıfıra çevrilmez.
- Actual (gerçekleşmiş) ve ROS (projeksiyon) değerleri karıştırılmaz ve öyle etiketlenir.
- Oyuncu eşleştirmesi yalnız ESPN sayısal ID ile yapılır; isimle sessiz eşleştirme yoktur.
- 2026-27 sezonu veri sözleşmelerinde `2027` anahtarıyla temsil edilir.
- Last 7/14/30 takvim günüdür, maç sayısı değildir. Yalnız normal sezon (`STD`)
  maçları sayılır; All-Star ve Cup finali hariçtir.
- Kaynak kimliği, SHA-256 ve tarih (provenance) bilgisi korunur.
- Hazır üçüncü taraf projeksiyonu kendi tahminimiz gibi kullanılmaz. Backtest ve
  geçmiş tarihli projeksiyonlarda gelecekten bilgi sızdırılmaz.
- Rookie ve returning veteran araştırma modelleri kullanıcı onayı olmadan
  production'da etkinleştirilmez; kayıtlı deney kabul kriterleri değiştirilmez.

## 9CAT matematiği

- Kategoriler: PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO. TO'da düşük değer avantajdır.
- Takım FG% = ΣFGM / ΣFGA, FT% = ΣFTM / ΣFTA. Oyuncu yüzdelerinin ortalaması alınmaz;
  payda sıfırsa oran `null` olur.
- Eşit değerler aynı sırayı paylaşır (1, 1, 3). Sıfır varyansta NaN/sonsuz üretilmez.
- Strateji hedefleri: `top1 | top3 | top5 | top7 | punt | unset`. Punt yalnız öneri
  ağırlığını etkiler, takımın gerçek istatistiksel gücünü değiştirmez.

## Testler ve yasaklar

Komutlar (`package.json` ve `.github/workflows/` esas alınır):

```sh
npm ci
npm run typecheck
npm run build
npm test                      # gerekirse CHROMIUM_PATH=/yol/chrome npm test
npm run test:browsers         # Firefox/WebKit
npm run test:pages
pip install -r scripts/requirements-stats.txt
python -m unittest discover -s tests/stats -v
```

Yasak olanlar (açık gerekçe ve kullanıcı onayı olmadan):

- Golden-master / legacy fixture'larını ve beklenen çıktıları (`tests/legacy/`,
  `tests/fixtures/`), frozen corpus'u, araştırma protokollerini değiştirmek.
- Test skip etmek, assertion silmek, toleransları gevşetmek, beklenen sonucu
  testi geçirmek için değiştirmek.
- Çalıştırılamayan testi başarılı gibi raporlamak. Lokal sonuç ile GitHub CI
  sonucu ayrı belirtilir.

Bilinçli olarak farklı sonuç üreten yeni algoritma için önce sözleşme ve
gerekçe yazılır, kullanıcı onayı alınır.

## Git, CI ve yayın

- `main` branch'ine doğrudan yazılmaz. Merge, force push, production deploy,
  `workflow_dispatch` ve koruma kuralı değişikliği yalnız kullanıcı açıkça isterse yapılır.
- Canlı yayın yalnız GitHub Pages'tir (`https://nba-fantasy-assistant.github.io/`).
  Kaynak repo private'tır; yayın ayrı public repoya `publish-pages.yml` ile
  SHA ve manifest kontrollü yapılır. Netlify ve Cloudflare Pages kullanılmaz.
- `public/data/*.json` günlük veri workflow'u tarafından, `research/rookie-shadow-*`
  branch'i shadow kayıt workflow'u tarafından yazılır; ajanlar bunları elle güncellemez.

## GitHub Actions dakikaları

Kaynak repo private; aylık Actions dakikası sınırlıdır ve bir kez tükenmiştir.
Amaç aynı kalite güvencesini en az dakikayla sağlamaktır.

1. Önce yerelde doğrula: ilgili typecheck, build, birim/entegrasyon ve tarayıcı testleri.
   Yalnız test almak için push yapılmaz.
2. Değişiklikleri mantıklı gruplarda topla; her küçük düzeltmeyi ayrı push etme.
   Yalnız metin/açıklama düzeltmesi için push yapma.
3. Tam CI matrisi merge öncesi zorunludur; geliştirme ortasında tekrar tekrar çalıştırılmaz.
   Draft PR'lar Chromium ile hafif CI alır; tam matris PR "ready for review" olunca çalışır.
4. Tasarruf için kontrol kaldırılmaz: kaynak kimliği, matematik, regresyon, veri tutarlılığı,
   freshness ve publication güvenlik kontrolleri zayıflatılmaz; yalnız tekrarlar azaltılır.
5. Günlük veri yenileme keyfî olarak kapatılmaz; maliyet test ve yayın tarafında optimize edilir.
6. Altyapı hatası (runner atanmaması, kota) kod hatası değildir; en fazla bir kez yeniden
   çalıştırılır ve kullanıcıya raporlanır. CI tetiklemek için boş commit, close/reopen yapılmaz.
7. PR açıklamasında CI tüketimi yazılır: kaç workflow/push çalıştı, hangileri gerekliydi.
8. Başka ajanın branch'ine push, gereksiz rebase/force-push ve gereksiz CI tekrarı yapılmaz.

## Paralel geliştirme modeli

Codex ve Claude Code eşit konumda, **paralel geliştiricilerdir**. Birbirinin
işini denetleyen bir ana model yoktur.

1. Her ajan kendi özelliğini kendi branch'inde ve kendi PR'ında geliştirir.
   Branch adı ajanı belli eder: `codex/<konu>` veya `claude/<konu>`.
2. Bir ajan başka ajanın branch'ine veya PR'ına commit atmaz, değişikliğini
   açıklamasız geri almaz.
3. İşe başlamadan önce güncel `main` ve açık PR'lar incelenir. PR açıklamasında
   dayanılan base commit SHA'sı ve dokunulan dosya alanları yazılır.
4. Açık bir PR'ın değiştirdiği dosyaya dokunmak gerekirse durulur ve çakışma
   riski kullanıcıya raporlanır. Kullanıcı sıralamayı veya sahipliği belirler.
5. Başka bir PR'a bağımlı iş, açıklamada bu bağımlılığı açıkça belirtir.
6. Çapraz inceleme ayrı ve isteğe bağlı bir görevdir; yalnız kullanıcı isterse
   yapılır ve inceleme sırasında incelenen PR değiştirilmez.
7. Başka ajanın sonucu otorite kabul edilmez; doğruluk iddiaları kendi
   doğrulamayla kontrol edilir.
8. Nihai entegrasyon, merge sırası ve ürün kararları kullanıcıya aittir.
