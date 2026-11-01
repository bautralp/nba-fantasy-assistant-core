# Sezon içi 17.3–17.5 mimari sözleşmeleri

Bu belge gelecek aşamaların uygulama sınırıdır; bu PR hesaplama motoru,
waiver indirme akışı veya trade simülasyonu geliştirmez. Navigasyon kartları
“Hazırlanıyor” olarak disabled kalır.

## Ortak veri ve durum

- `PublicLeague` yalnız ESPN okuma snapshot'ıdır. Draft workspace, Draft hedefleri,
  sıralama oturumu ve merkezi Actual/ROS dataset'lerinden bağımsızdır.
- Kimlik kapsamı: `(provider=ESPN, leagueId, seasonId, espnTeamId)`; oyuncu
  kimliği pozitif sayısal ESPN ID. `matchEspnPlayer` ile mevcut providerIds.espn
  eşleşmesi kullanılır. Ada göre sessiz eşleştirme yoktur. Unmatched, ambiguous,
  invalid ayrı hata/uyarı durumlarıdır. Kaynak sahiplikleri değiştirilemez.
- Yeni hesaplamalar immutable snapshot ve saf engine fonksiyonlarıyla yapılır.
  UI ekranları normalleştirilmiş view model okur; ham JSON hesaplama motoruna
  veya bileşenlere taşınmaz. Ağ adapter'ları timeout, abort, boyut sınırı ve
  cooldown sözleşmesini korur. Eski isteğin yeni lig state'ini ezmesi engellenir.
- Önerilen ayrı store alanları: `connection`, `navigation`, `strategy`, `analysis`,
  `waiverQuery`, `scenario`. Strateji ve senaryo session anahtarları lig+sezon+takım
  kapsamında, version'lı olmalı. Snapshot/gerçek kadrolar sessionStorage'a
  kopyalanmaz. Yenilemede kaynak revision değişirse hesaplar geçersizleşir.
- Her analiz çıktısı `sourceRevision`, `datasetRevision`, `asOf`, `horizon`,
  `projectionKind` (Actual/ROS), `coverage`, `warnings` ve hesaplama model version'ı
  taşır. UI farklı snapshot'lardan before/after değerlerini karıştırmaz.
- `null` eksik veri, `0` doğrulanmış sıfırdır. Eksik istatistik, eşleşmeyen ID,
  bilinmeyen pozisyon, sakatlık, oynanacak maçlar veya roster kuralları sonuçların
  kapsamını düşürür; eksikler sıfır kabul edilmez. Kısmi sonuç görünür biçimde
  etiketlenir. Kapsam yeterli değilse analiz engellenir.
- Dokuz kategori anahtarları FG%, FT%, 3PM, REB, AST, STL, BLK, TO, PTS.
  Gerçek haftalık skor kaynağı ile güç/projeksiyon çıktısı ayrı tiplerdir.
  Hiçbir projected sonuç “ESPN gerçek skor” olarak etiketlenmez.

## 17.3 — Power Rankings ve Takım Analizi

### Girdiler ve hesap hattı

`analyzeLeague({ leagueSnapshot, projectionsByEspnId, nbaSchedule, horizon,
lineupPolicy, goals, modelVersion }) -> LeagueAnalysis` önerilen saf sınırdır.

1. Exact ESPN ID ile Actual veya ROS satırlarını bağla. Actual per-game ve ROS
   per-game/remaining-total birimlerini açıkça taşı; birimleri üst üste çarpma.
2. Analiz ufkunda gerçek NBA takvimi/oynanacak maçları kullan. Tarih ve sezon
   kapsamı doğrulanmayan schedule için maç sayısı uydurma. Oyuncunun NBA takım
   değişikliği, mevcut roster üyeliği ve projeksiyon kapsamını ayrıca doğrula.
3. ESPN `lineupSlotCounts` ve `eligibleSlots` üzerinden aktif/bench/IR kısıtlarını
   uygula. Slot kapasiteleri sezon içi ligden gelir; Draft'ın **13 kişilik CAPACITY
   sabiti bu modele taşınmaz**. Bilinmeyen lineup kilit/tarih kuralları varsa
   varsayımı çıktıdaki lineupPolicy ve uyarılarda açıkça belirt.
4. Günlük/haftalık uygun lineup maçlarını hesapla. Bench oyuncusunun tüm maçlarını
   otomatik aktif sayma; IR katkısı yalnız uygun aktivasyon senaryosuyla alınır.
   Oyun sayısı kısıtları ve gün içi lineup kilitleri desteklenmiyorsa açık sınırdır.
5. Counting kategorileri uygun maç katkılarından topla. FG% = toplam FGM / toplam
   FGA, FT% = toplam FTM / toplam FTA. Oyuncu yüzdelerinin aritmetik ortalaması
   yasaktır. Denominator yoksa oran null; sıfır atışla %0 üretme.
6. Karşılaştırılabilir takım toplamlarından kategori güç puanı ve lig sırası üret.
   TO ters yönde. Güç puanı normalizasyon yöntemi/version'ı ve referans popülasyon
   açıklanabilir olmalı; eşit puanlar aynı sırayı paylaşır (ör. 1,1,3).
   Sıfır varyans kategorisinde sonsuz/NaN oluşmaz; eşitlik etiketi kullanılır.

Çıktı: her takım/kategori için `projectedValue`, `powerScore`, `rank`,
`gamesIncluded`, `coverage`, `warnings`; lig genelinde dokuz kategori rankings.
Standings'in sezon W/L/T kaydı bu modelin güç sırası yerine kullanılmaz.

### Bağımsız strateji ve açıklamalar

`SeasonCategoryGoals` dokuz kategorinin her biri için
`top1 | top3 | top5 | top7 | punt | unset` taşır. UI karşılıkları İlk 1/3/5/7,
Punt, Belirlenmedi. Draft hedef modelinin anlamı korunabilir ancak state'i
paylaşılmaz; draft stratejisi değişmez. Takım Analizi ve Waiver aynı sezon içi
strateji kaydını iki yönlü günceller.

Oyuncular strateji uyum puanıyla sıralanır. Her açıklama sayısal delil taşır:
ör. hedef kategoride marginal güç değişimi, ağırlıklı yüzde hacmi etkisi,
uygun oynanacak maç sayısı, TO maliyeti ve punt ağırlığı. `reasons[]` içinde
kategori, önceki/sonraki değer, delta, birim ve model gerekçesi olur. Büyük sıfatlı
ve veri içermeyen “çok iyi oyuncu” açıklaması üretilmez. Takım toplamına
marjinal katkı ile tek oyuncunun z-score'u birbirine karıştırılmaz.

Kabul testleri: weighted FG/FT, zero-volume/null, TO ters yön, eşit sıralar,
ID belirsizliği, farklı roster kapasiteleri, IR ve pozisyon çakışmaları,
günlük lineup doluluğu, ufukta maç olmayan oyuncu, Actual/ROS birimleri,
bağımsız hedefler ve snapshot değişiminde invalidation.

## 17.4 — Waiver Asistanı

- Ayrı `WaiverPoolAdapter`: `readPage({ leagueId, seasonId, offset, limit,
  statusFilter, signal }) -> { players, nextOffset, fetchedAt, completeness }`.
  `kona_player_info` ve özel `X-Fantasy-Filter` yalnız doğrulanmış anonim erişimle
  kullanılır. Statüler FREEAGENT/WAIVERS; ONTEAM satırları elenir/uyarı üretir.
  ID deduplication, değişen sayfalarda eksik/tekrar gözlemi ve maksimum sayfa/byte
  bütçesi gerekir. Root total olmadığı için havuz tamamlığı iddia edilmez.
- Mevcut PlayerTable sunum/filtre davranışları tekrar kullanılabilir; adı ve
  doğrulanmış pozisyonlarıyla filtreleme, sayfalama, sıralama, erişilebilir
  seçim sağlanır. İstatistik birimleri ve kaynak güncelliği görünür kalır.
- “Stratejiye göre oyuncu bul” ortak SeasonCategoryGoals üzerinden filtre/sıralama
  uygular. Takım Analizi'nde değiştirilen hedefler burada, buradaki değişiklikler
  Takım Analizi'nde görünür; draft hedefleri etkilenmez.
- `simulateAddDrop({ baseRevision, myTeamId, addPlayerId, dropPlayerId,
  goals, horizon }) -> AddDropAnalysis`. Eklenen waiver oyuncusundan sonra
  kullanıcının gerçek kadrosundan bırakılacak oyuncu açıkça seçilir.
- Önce/sonra analiz aynı projeksiyon/schedule snapshot'ıyla ortak 17.3 engine'ini
  çalıştırır. Dokuz kategoride değer, güç, lig sırası, güç ve sıra deltaları
  gösterilir. Sıra kazancı için işaret konvansiyonu açık: `beforeRank-afterRank`.
  FG/FT değişimleri yüzde puanı ve hacimle açıklanır.
- Roster kapasitesi, IR uygunluğu, slot uygunluğu, waiver bekleme tarihi ve
  eksik projection coverage uyarıları hesap öncesi gösterilir. Bilinmeyen ESPN
  kuralları otomatik “işlem geçerli” sonucu üretmez. Snapshot yenilenirse waiver
  sahipliği ve drop üyeliği yeniden doğrulanır.
- **Yalnız simülasyon**. Submit etiketi ESPN işlem emri gibi görünmez. ESPN'e
  transaction/claim/roster write API'si veya cookie mekanizması eklenmez.

Kabul testleri: status filtering, paging duplicates/end/cap, CORS failure,
429/retry-after, oyuncu adı/pozisyon araması, ortak hedef senkronizasyonu,
eski snapshot, geçersiz drop, aynı oyuncu add/drop, IR/kapasite uyarısı,
weighted oran ve diğer takımlara göre rank değişimi.

## 17.5 — Takas Asistanı

`TradeScenario = { schemaVersion, baseRevision, moves, history }`.
Her `Move = { playerId, sourceTeamId, target: TeamId | 'waiver' }` gerçek ESPN
ID'leri ve başlangıç snapshot'ındaki sahipliği referans alır.

- Tüm takımların gerçek roster'ı salt okunur başlangıçtır. Bir oyuncu farklı
  takıma veya waiver wire'a taşınabilir. Birden fazla takım ve hamle aynı
  senaryoda bulunabilir. Her oyuncu için yalnız bir effective hedef vardır;
  yeni hedef eski hedefi açıkça değiştirir veya çatışma hatası verir.
- Kaynak takım gerçeğe göre doğrulanır. Aynı takım hedefi/no-op reddedilir.
  Oyuncu hiçbir senaryoda kopyalanamaz; atomik uygulamadan sonra sahiplik
  partition invariant'ı kontrol edilir. Waiver hedefi takımlardan çıkarır.
- Undo son senaryo düzenlemesini geri alır; reset başlangıç snapshot'ına döner.
  İşlemler gerçek ESPN kadrosunu değiştirmez. Senaryo yalnız kullanıcıya ait
  session kapsamındadır; kamuya gerçek roster payload'ı yazılmaz.
- “Takasları tamamla” önce hamleleri ve uyarıları gösterip **simülasyon onayı**
  alır. Onay yalnız yerel scenario revision'ını sabitler. Yeni hamle veya kaynak
  yenilemesi onayı kaldırır; farklı revision üzerinden sessiz simülasyon yoktur.
- `simulateTrades({ baseSnapshot, scenario, projections, goals, horizon })`
  atomik sanal roster'ları kurar ve **tüm takımların** dokuz kategori rankings'ini
  17.3 engine'iyle yeniden hesaplar. Oyuncusu değişmeyen takımın da göreli sırası
  değişebilir. Her takım/kategori için önce/sonra değer, güç, rank, delta döner.
- Gerçek trade deadline, veto, oyuncu kilidi, acquisition limit, waiver işleme
  zamanı, IR ve roster kuralları ile what-if arasındaki farklar açıkça etiketlenir.
  Simülasyon sonucu “ESPN'de geçerli/onaylı takas” anlamına gelmez.
- **Yalnız what-if**. ESPN kadrolarına yazma, transfer, transaction veya gerçek
  takas gönderme işlevi bu mimarinin dışında kalır.

Kabul testleri: çok takımlı/çok hamleli atomik senaryo, çift hedef engeli,
waiver hedefi, aynı takım/no-op, yanlış kaynak, undo/reset, stale revision,
onay iptali, tüm takımlarda göreli rank değişimi, weighted FG/FT ve TO,
kapasite/IR/uygunluk uyarıları, hiçbir ESPN mutation isteği gönderilmemesi.
