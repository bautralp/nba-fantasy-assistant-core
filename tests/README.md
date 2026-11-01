# v3.3 regresyon referansı — Aşama 1

Bu testler sabit `tests/legacy/v3.3.html` dosyasını bütünüyle gerçek Chromium içinde
çalıştırır. Bu dosya, orijinal v3.3 commit’indeki `index.html` dosyasının anonimleştirilmiş
sürümüdür; orijinaliyle bayt düzeyinde aynı değildir. Fonksiyonlar ayrı bir hesaplama
uygulamasına taşınmaz, yeniden yazılmaz veya mock ile değiştirilmez.
DOM, localStorage, Map/Set, sıralama ve onay pencereleri gerçek tarayıcıya aittir.
Test düzeneği Playwright ve Node'un yerleşik `node:test` modülünü kullanır.
React giriş noktasını veya yeni bir hesaplama motorunu çalıştırmaz.

## Çalıştırma

Node.js 22.12 veya üzeri ve Chromium gerekir:

```sh
npm ci
npx playwright install chromium
npm test
```

Önceden kurulu Chromium kullanmak için:

```sh
CHROMIUM_PATH=/usr/bin/chromium npm test
```

Linux'ta eksik sistem kitaplıkları varsa Playwright'ın tarayıcı bağımlılıklarının
kurulması gerekir (`npx playwright install --with-deps chromium`). Kısıtlı çalışma
ortamı loopback HTTP dinlemeye ve tarayıcı alt süreçlerini başlatmaya izin vermelidir.
Test sunucusu yalnızca `127.0.0.1` üzerinde rastgele bir port dinler; GitHub veya
bir projeksiyon servisine erişim gerektirmez. Her senaryo yeni tarayıcı bağlamında
çalışır; kullanıcının tarayıcı verilerine erişmez.

## Kaynak ve beklenen çıktıların kökeni

- Başlangıç `main`: `71b3d84347e08f576dec1e7eada6e32609e0d2cd`.
- Onaylanmış planın v3.3 referansı: `0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5`.
- İki commit'teki `index.html` birebir aynıdır; blob: `6f774efbb3d932f59baa7cd6d2f7a097a7a6faef`.
- Orijinal HTML SHA-256: `12b49b7231c93605e3ded82d83f84c30352cccdfa74324e2606638459d6a9b90`.
- İlk kayıt ortamı: Node `v24.19.0`, Chromium `154.0.8037.57`, Playwright `1.56.1`.
- Ayrıntılı kayıt: `fixtures/expected/provenance.json`.

Harness referansı kendi konumuna göre `./v3.3.html` yolundan okur; repository
kökündeki `index.html` dosyasını okumaz. React + Vite dönüşümünde kökteki dosya
tamamen değiştirilse veya kaldırılsa bile eski regresyon testleri bu sabit kopyayı
çalıştırır. HTTP yanıtına anonimleştirilmiş kopyanın baytları verilir ve aşağıdaki
güncel SHA-256 her çalıştırmada doğrulanır. Referansın değişmesi testi durdurur.

Dosya yapısı:

```text
tests/legacy/v3.3.html           # Sabit, anonimleştirilmiş v3.3 HTML referansı
tests/legacy/harness.mjs        # Referansı doğrular ve tarayıcıda çalıştırır
tests/legacy/regression.test.mjs
tests/fixtures/                 # Mevcut sabit girdiler ve beklenen çıktılar
```

### Anonimleştirilmiş referans

Aşama 2'de kullanıcının açık talebiyle iki legacy HTML kopyasında yalnızca şu
üç alan değiştirildi:

- `INITIAL_TEAMS`: kişisel ligdeki on ad yerine `Takım 1`–`Takım 10`.
- Footer: kişisel takım adı yerine `NBA Fantasy Assistant`.
- `KEY`: kişisel tanımlayıcı yerine `nba_fantasy_assistant_v3`.

Hesaplama ve draft fonksiyonları, varsayılan takım indeksi dahil diğer davranışlar
korundu. Yeni anahtar eski tarayıcı kayıtlarını otomatik okumaz, taşımaz veya silmez.
Yeni anahtarda kayıt yoksa nötr varsayılanlar açılır. Gerekirse eski sürümden alınan
JSON yedeği legacy sürümün geri yükleme aracıyla yüklenebilir; yedekteki isimler
kullanıcı verisidir ve otomatik anonimleştirilmez.

Güncel anonimleştirilmiş HTML SHA-256:
`09207d8c00c80fb9813a29c203e4b6d0e19e428d1e3de8499ba72f0804fabbb3`.
`harness.mjs` bu yeni kimliği zorunlu tutar. İki güncel kopyayı karşılaştırmak için:

```sh
cmp public/legacy/v3.3.html tests/legacy/v3.3.html
sha256sum public/legacy/v3.3.html tests/legacy/v3.3.html
```

Orijinal commit/blob ve yukarıdaki orijinal hash tarihsel köken bilgisidir;
anonimleştirilmiş dosyaya ait değildir. Git geçmişi yeniden yazılmamıştır.
`fixtures/expected/provenance.json` ilk kaydın tarihsel bilgisini aynen korur.
22 senaryo ve beklenen hesaplama sonuçları değiştirilmemiş veya yeniden
üretilmemiştir. Harness her senaryoda takım adlarını sentetik `Team 0`–`Team 9`
değerleriyle kurar ve kaydı HTML'in güncel `KEY` sabitiyle okur. Bu nedenle ad ve
anahtar değişikliği mevcut sonuçların değiştirilmesini gerektirmez. 26 test bu
beklentilere karşı yeniden çalıştırılır; uyuşmazlıklar referans yenilenerek giderilmez.

`attachEvents()` ve ilk `go('draft')` dahil bütün sayfa çalışır. Ardından sabit
senaryo durumu kurulur; girdiler gerçek `fromObjects()` ile ayrıştırılır.
Hesaplamalar ve draft komutları gerçek fonksiyonlara çağrıdır. `render()`, `save()`
ve `confirm()` dahil yan etkiler devrededir; sayfa JavaScript hatası testi düşürür.

`calculateModel()` dışarıya referans oyuncu kimliklerini vermediği için dört
senaryoda Chromium debugger ile yerel `ref` dizisi salt okunur gözlemlenir.
Kaynağa kod eklenmez. Bu gözlemin tüm diğer çıktıları değiştirmediği ayrıca
normal çalıştırmayla karşılaştırılır. `reference-ids.json` bu gerçek dizilerin
sırasını saklar; referans seçme algoritması test kodunda yeniden uygulanmaz.

## Sabit girdiler ve kapsam

`fixtures/players.json`, 140 sentetik oyuncunun açık sayısal girdilerini içerir;
kişisel veri veya harici veri kaynağı yoktur. `scenarios.json` sabit havuz indeksleri,
kadrolar, hedefler, alan değişiklikleri ve onay/iptal yanıtlarını tanımlar. Çalışma
anında rastgele veri üretilmez. Eşdeğer sezon toplamı satırları da dosyada saklıdır.

| Senaryolar | Kaydedilen davranış |
|---|---|
| empty-pool, empty-rosters, single-player | Boş analiz/kadro, null puanlar, tek gözlem sapması |
| early, middle, late, last-pick, completed | Draft evreleri, hedef temposu, öncelik, kalan seçim, beşli öneriler |
| all-unset, all-punt, all-top1, all-top7 ve karma hedefler | Bütün hedef türleri, önerilerin kapanması, kategori katkıları |
| reference-exactly-130, reference-over-130 | İki aşamalı referans seçimi, bazlar, ortalamalar, sapmalar, her oyuncunun Z-score'u |
| equivalent-totals | Maç başına/sezon toplamı eşdeğerliği |
| zero-volume, identical-statistics | FG/FT varsayılan bazları, sıfır varyans, eşit puanlar ve RANK ile öneri sırası |
| invalid-projections, all-invalid | Eksik/geçersiz istatistik, sıfır GP, isabet/deneme ihlali, negatif değer; kadro sayısı ile analiz sayısının ayrılması |
| multi-position-roster | Çok pozisyonlu eşleştirme, bilinmeyen POS, UTIL/BENCH, zorunlu slotlar ve bonus |
| draft-operations, full-team | Atama, taşıma, kaldırma, son seçimi geri alma, kapasite, onay/iptal ve draft başladıktan sonra sıra değişikliği engeli |

Her sonuç dosyasında sezon toplamları, hacim ağırlıklı FG/FT bazları, dokuz
kategori Z-score'u, takım toplamları/puanları/sıraları, dinamik plan, önerilerin
puan/katkı/önce-sonra sıraları, rakip farkları ve güven etiketleri bulunur.
Snake sıranın tüm 130 seçimi ve tamamlandıktan sonraki mevcut yardımcı fonksiyon
davranışı kaydedilir. Draft adımlarında seçimler, takım sırası, sonraki seçim,
localStorage'a kaydedilen durum, toast ve gerçek confirm metinleri de karşılaştırılır.
`rankTeams` için `1e-10` eşiğinin iki yanındaki sabit girdiler ayrıca çalıştırılır.

Sayısal hesaplamalar `1e-9 × max(1, |beklenen|)` toleransıyla karşılaştırılır.
Kimlikler, dizi sırası, kategori sıraları, seçim indeksleri, sayımlar, metinler ve
null değerler birebir karşılaştırılır. Beklenen alanların eksilmesi/eklenmesi de hata
verir. Taze tarayıcı bağlamında aynı senaryonun tekrar üretimi ayrıca doğrulanır.

## Kayıt ve değişiklik politikası

İlk kayıt komutları:

```sh
CHROMIUM_PATH=/usr/bin/chromium npm run test:capture
CHROMIUM_PATH=/usr/bin/chromium node tests/legacy/capture-reference.mjs
```

Bunlar yalnızca ilk oluşturma araçlarıdır. `expected/` mevcutsa ilk komut;
`reference-ids.json` mevcutsa ikinci komut başarısız olur. Normal `npm test`
beklenen çıktılara hiçbir şey yazmaz. Başarısız testi geçirmek için dosyaları
silip yeniden üretmeyin. Bilinçli davranış değişikliği yeni beklenti ve gerekçesiyle
ayrı değerlendirilmelidir; bu v3.3 referansı korunmalıdır.

Gelecekteki motor aynı girdiler ve sabit beklenen çıktılarla sınanabilir. O aşamada
motor için ayrı adaptör eklenmeli; eski HTML veya bu oracle değiştirilmemelidir.

## Sınırlar

Bu çalışma hesaplama/draft regresyon referansıdır; matematiksel doğruluk veya
sezon sonucu garantisi değildir. Mevcut davranışları, tutarsızlıkları dahil korur.
Görsel ekran düzeni, klavye erişilebilirliği, dosya yükleme/indirme UI akışı,
bozuk yedekler, depolama kotası hataları ve farklı tarayıcı motorları bu aşamanın
otomatik kapsamına dahil değildir. Planın sonraki aşamalarındaki Excel, yeni
kalıcılık sözleşmesi ve yeni arayüz testleri henüz uygulanmamıştır. Chromium
haricinde bir tarayıcıda sonuç eşdeğerliği iddia edilmez.

## Aşama 4 motor karşılaştırmaları

`npm run test:engine`, `tests/parity/engine.test.mjs` üzerinden 22 sabit senaryoyu
yeni TypeScript motoruyla karşılaştırır. Domain modeli eşlemesi yalnızca test
adaptöründedir; hesaplar `src/engine` fonksiyonlarında yapılır. Kaydedilmiş
`imported.records` sınır girdisi ve komutlu senaryoların son kadro durumu kullanılır.
26 legacy test, HTML ve fixture dosyaları değiştirilmez. Kullanım sözleşmesi,
toleranslar ve ek kontroller: [Motor dokümanı](../src/engine/README.md).

## Aşama 5 kalıcılık ve geçiş

`npm run test:persistence`, `tests/persistence/*.test.ts` testlerini tarayıcısız
çalıştırır. 13 test; JSON round-trip/ret, Storage erişim/kota/serileştirme hataları,
mevcut bozuk kaydın korunması, bellek girdisinin değişmemesi ve kullanıcıdan gelen
v3 JSON geçişini kapsar. Fake Storage kullanılır; domain ve motor mock edilmez.
`fixtures/persistence/v3-backup.json` yalnızca sentetik oyuncu/takımlar içerir.
Sabit `expected/early.json` içindeki gerçek importer çıktısı da dönüştürücüyle
kontrol edilir. Legacy referansları ve fixture üretim araçları değiştirilmez.

`npm test`: 25 domain + 26 motor + 13 kalıcılık + 26 legacy = 90 test.
Kullanım ve korunamayan v3 alanları:
[Kalıcılık dokümanı](../src/infrastructure/persistence/README.md).

## Aşama 8

`tests/application/draft.test.ts`: 17 saf komut/selector testi; 130/131 sınırı,
transfer onayı/kapasitesi, tarihsel indeksler, atomik ret, aktif dataset izolasyonu,
G/F kapsamı, birimler ve yedi değiştirilmemiş v3.3 oracle öneri sırası/puanı.
`tests/ui/draft.test.mjs`: gerçek React + Chromium draft akışları ve
`artifacts/ui/draft-workspace-{280,375,1280}.png`, `draft-modal-{280,375,1280}.png`.
Legacy fixture/HTML motoru mock edilmez veya yeniden üretilmez.

İnceleme için son doğrulamanın iki ekran görüntüsü sürüm kontrolünde tutulur:
[1280 px masaüstü](../docs/screenshots/stage-8-desktop.png) ve
[375 px mobil atama modalı](../docs/screenshots/stage-8-mobile-modal.png).

## Aşama 9

`tests/application/analysis.test.ts`: 20 yeni test; on sabit v3.3 oracle
senaryosunda takım puanları, kategori sıraları, ihtiyaç/öncelik/durum alanları,
rakip farkı/sırası/güveni ve tüm takım yerleşimleri karşılaştırılır.
`tests/helpers/analysisFixture.ts` yalnızca sabit importer girdisini domain
modellerine eşler; hesaplama veya referans üretimi yapmaz.

Power Rankings görünümünün `rankTeams()` sıralarını kullanması ayrı bilinçli
fark testiyle doğrulanır: `1,2,2,4`, zincirlenmiş yakın eşitlik ve deterministik
takım kimliği sırası. Golden-master dosyaları değiştirilmez.

`tests/ui/analysis.test.mjs`: 20 yeni gerçek React/Chromium testi. Geçici UI
etkileşimlerinde model hesabının yeniden çalışmadığı test ortamına özel sayaçla
denetlenir. `CHROMIUM_PATH=/usr/bin/chromium npm test`: toplam 233 test.
[Detaylı kapsam ve 280/375/1280 px görseller](../docs/stage-9-analysis.md).


## Aşama 10

Mevcut 233 teste tema/kontrast, optimistic storage conflict ve gerçek draft
E2E/klavye/responsive/erişilebilirlik ağacı senaryoları eklenir. Motor ve eski
26 legacy test değiştirilmez. `npm test` varsayılan Chromium hedefidir;
`npm run test:browsers` Firefox ve WebKit'i ayrı çalıştırır. Eksik executable
başarı/skip sayılmaz. Performans hedefleri `test:performance` (150/300/600,
130 seçim) ve `test:performance:browser` (gerçek React etkileşimleri) şeklindedir.
`artifacts/` CI log ve görsellerini içerir. [Kapsam, sınırlar ve ölçümler](../docs/stage-10-hardening.md).

## Aşama 11

`tests/application/preparation.test.ts`, `tests/ui/preparation.test.mjs` ve yeni
kimlik senaryoları üç adımlı hazırlığı, sekmeler arası bütünlüğü/memoizasyonu,
sıfırlama onaylarını ve hata/çakışma korumalarını doğrular. Normal UI’da JSON veya
legacy bağlantısı yoktur; mevcut JSON regresyonları `tests/helpers/workspaceUi.mjs`
ile gerçek bir geçici storage hatası yaratarak Acil JSON kurtarma yolunu kullanır.
Hiçbir üretim test kancası eklenmez. `npm run test:browsers` yeni hazırlık akışını
da Firefox ve WebKit üzerinde çalıştırır. UI test dosyaları sıralı çalıştırılır.

280, 375, 768, 1280 ve 1920 px kurulum ve dört sekme görüntüleri:
[teslimat notları](../docs/stage-11.md#ekran-görüntüleri).
