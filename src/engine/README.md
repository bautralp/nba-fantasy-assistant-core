# Saf hesaplama motoru — Aşama 4

Motor `src/domain` modellerini kullanır. React, DOM, dosya okuma, saat, rastgelelik,
localStorage veya global çalışma alanı içermez. Girdiler değişmez; her çağrı yeni
sonuç üretir. Sonuçlar kalıcılık modelinin parçası değildir.

## Kullanım sözleşmesi

Girdiler domain bütünlük kontrollerinden geçmiş olmalıdır: desteklenen ilk sürüm
kuralları (10 takım, 13 oyuncu, snake, dokuz kategori), benzersiz kimlikler, geçerli
referanslar. Sayısal doğrulama/import motorun sorumluluğu değildir. Hatalı bir
projeksiyon `status: 'excluded'` ile aktarılır; hatalı istatistik sıfıra çevrilmez.
`status: 'valid'` alanı domain doğrulamasının geçtiği anlamına gelir.

- `projectTotals(projection, dataset)`: maç başına veriyi GP ile çarpar; GP değişmez.
  Eksik, hariç tutulan veya başka veri setine ait projeksiyon için `null` döner.
- `calculateModel(players, projections, dataset)`: yalnızca belirtilen veri setini
  kullanır. Oyuncu dizisinin sırası eşit puanlarda korunur. `valid`, sezon toplamları,
  bazlar, ortalamalar, örneklem sapmaları ve `ReadonlyMap<PlayerId, CategoryValues>`
  Z-score'larını verir. `referenceIds` referans havuzunun sıralı kimlikleridir.
  Boş modelde `usable=false`, bazlar `null`, Z haritası boştur; ortalamalar,
  sapmalar ve referans sayısı legacy gibi bulunmaz.
- `teamScores(teams, roster, model, extra?)`: kadro üyeliğini ve analize giren oyuncu
  sayısını ayrı tutar. `extra`, tek oyuncunun etkisini mutasyon olmadan hesaplar.
- `rankTeams(scores)`: kategori → takım kimliği → sıra/null. Takım dizisinin indeksi
  kimlik değildir. Eşit puanlar aynı sırayı paylaşır; sonraki sıra atlayabilir.
- `categoryBalance(scores, teamId, targets, ranks?)` ve
  `opponentAnalysis(scores, teamId, targets)`: belirtilen takımın planını/rakiplerini
  döndürür. `teamId` skorlar içinde bulunmalıdır. Stratejiden `targets` aktarılır.
- `recommendations(input)`: seçilmemiş, analize uygun ilk beş oyuncuyu; puanı,
  pozisyon gerekçesini, kategori katkılarını, önce/sonra sıralarını, tempo açığını,
  ihtiyaç etiketlerini ve ilgili rakipleri verir. Veri setine göre süzülmüş
  projeksiyonlar aynı modelle kullanılmalıdır (RANK eşitlik çözümü için).
- `eligible`, `matchLineup`, `positionFit`: aktif lig/veri seti/sezona göre çağıran
  tarafından çözülmüş `PositionEligibility` kayıtlarının `playerId`/`positions`
  alanlarıyla çalışır. Kayıt yoksa boş pozisyon dizisi aktarılır. `matchLineup`
  kadro sırasını koruyan girdiden slot indeksi → oyuncu kimliği döndürür.
  Kadroya analiz dışında kalan oyuncular da dahildir; bulunmayan Player eklenmez.
  `preferredSlot` v3.3 yerleşim algoritmasında kullanılmaz.

Draft sırasında kadro `deriveDraftRoster(session)` ile türetilir. Diğer kullanımda
`RosterEntry[]` doğrudan aktarılır. Motor snake sıra veya draft komutlarını yeniden
uygulamaz; domain katmanındaki sözleşmeler kullanılmalıdır.

```ts
import { deriveDraftRoster } from '../domain/rules/draftRules.ts';
import { calculateModel, teamScores, recommendations } from './index.ts';

const roster = deriveDraftRoster(session);
const activeProjections = projections.filter(p => p.datasetId === dataset.id);
const model = calculateModel(players, activeProjections, dataset);
const scores = teamScores(teams, roster, model);
const topFive = recommendations({
  players, projections: activeProjections, teams, roster, model,
  teamId: strategy.teamId, targets: strategy.targets,
  eligibility: resolvedEligibility,
});
```

## Korunan v3.3 davranışları

İki aşamalı en fazla 130 oyunculuk referans seçimi, hacim ağırlıklı FG/FT katkısı,
ters işaretli TO, örneklem sapması ve sıfır sapmada 1 böleni korunur. Sıfır atış
hacminde FG=.47 / FT=.78 bazları kullanılır. Takım puanı
`13 × toplamZ / (rated + 4)`; analize uygun oyuncu yoksa `null` olur.

Hedef temposu, clamp sınırları, rakip düzeltmeleri ve Türkçe durum/güven etiketleri
v3.3 ile aynıdır. `unset` ve `punt` ağırlığa/tehditlere katılmaz; etkin hedef yoksa
öneri üretilmez. Tam draft veya dolu takım için de öneriler boştur. Eşit öneri
puanında RANK (eksikse 9999), sonra girdi sırası kullanılır. Kategori sıralamasında
komşu puan farkının mutlak değeri `< 1e-10` olduğunda eşitlik zincirlenir.

`G`, PG/SG/G slot uygunluğunu ifade eden genel slotta kullanılabilir; tek başına
PG veya SG uygunluğu vermez. Aynı kural F için SF/PF yönünde geçerlidir. Zorunlu
slotlar deterministik augmenting-path eşleştirmeyle doldurulur; ilave dolan slot
başına .55 bonus verilir. Bilinmeyen pozisyon UTIL/BENCH'e yerleşebilir.

Bilinçli algoritma değişikliği yapılmadı; sabit referanslarda hesaplama farkı
saptanmadı. Power Rankings görünümündeki ayrı numaralandırma bu aşamada ele alınmaz.
Hesaplar sezgisel geçici değerlendirmelerdir; galibiyet olasılığı değildir.

## Doğrulama

`npm run test:engine` tarayıcı gerektirmez. 22 sabit v3.3 senaryosu toplamlar,
bazlar/ortalamalar/sapmalar, her oyuncunun Z-score'u, takım puanları/sıraları,
dinamik plan, rakip analizi, öneriler/katkılar ve pozisyon sonuçları için sınanır.
Dört senaryodaki debugger ile gözlemlenmiş referans kimlikleri ayrıca birebir
karşılaştırılır. Sayısal tolerans `1e-9 × max(1, |beklenen|)`; kimlikler, dizi
sıraları, sayımlar, kategori sıraları, etiketler ve null değerler birebirdir.

Test adaptörü sabit legacy `imported.records` alanını sınır girdisi olarak kullanır:
bu alan gerçek `fromObjects()` çıktısıdır. İstatistik/kimlik alanlarını domain
modellerine eşler; importer veya hesaplama algoritması içermez. Draft komutlu
senaryolarda kayıtlı son kadro/takım durumu kullanılır. Yeni motor referans üretmez;
`expected/`, referans kimlikleri ve 26 legacy test korunur. Adaptörün kullandığı
sabit sınır girdileri de legacy testlerde gerçek fonksiyonla doğrulanır.

Ek kontroller: maç başına/toplam eşdeğerliği, G/F kuralları, başka veri setinin
izolasyonu, eksik/hariç projeksiyon, aynı adlı oyuncuların bağımsız kimliği, takım
sırasından bağımsız kimlikler, donmuş girdiler ve tekrarlı çağrıda değişmeyen sonuç.
`tsconfig.engine.json` motoru DOM ve Node ortam tipleri olmadan da kontrol eder.

Excel, kalıcılık, React entegrasyonu, Waiver/Trade ve yayın kapsam dışıdır.
