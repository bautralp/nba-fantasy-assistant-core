# Aşama 13.1 — Gerçek performans için 9CAT Z-score

Merkezi Oyuncu Sıralamaları, doğrulanmış SportsDataverse snapshot'ındaki **maç başına** gerçekleşmiş normal sezon performansını değerlendirir. Bu geçmiş performans sıralamasıdır; ROS, oyuncu projeksiyonu, tahmini GP veya sezon sonu tahmini değildir. GP=1 dahil bütün dönem oyuncuları değerlendirilir. Az maçlı örneklemler oynaktır; kullanıcıya bu sınırlama gösterilir.

## Matematik ve motorla ortak davranış

`src/features/rankings/playerZScores.ts` saf fonksiyonu, `categoryScores.ts` içindeki `baseline`, `rawContributions`, `distribution`, `categoryValues` ve `referencePool.ts` içindeki `selectReferencePool` fonksiyonlarını kullanır. `calculateModel()` veya `projectTotals()` çağrılmaz: bunlar Draft Asistanı projeksiyonlarını sezon toplamlarına dönüştürür. Referans seçicinin tarihsel `totals.stats` alanına burada doğrudan maç başına değerler verilir; GP hiçbir katkıyla çarpılmaz. Projection dataset oluşturulmaz veya değiştirilmez.

Kategoriler FG%, FT%, 3PM, PTS, REB, AST, STL, BLK ve TO'dur. Her ağırlık 1'dir; punt veya strateji uygulanmaz.

- FG bazı: referans oyuncuların maç başına FGM toplamı / maç başına FGA toplamı. FT bazı aynı şekilde FTM / FTA'dır. GP ağırlığı uygulanmaz.
- FG ham katkısı: `FGM - baselineFG * FGA`.
- FT ham katkısı: `FTM - baselineFT * FTA`.
- TO ham katkısı: `-TO`; daha az top kaybı avantajdır.
- Diğer altı kategorinin ham katkısı maç başına istatistiğin kendisidir.
- Her kategori için `Z = (ham katkı - referans ortalaması) / referans örneklem standart sapması`.
- Örneklem standart sapması `sqrt(sum((x - mean)^2) / (n - 1))` ile hesaplanır. Mevcut motor gibi n<2 veya sıfır standart sapmada bölen 1 kullanılır. Sıfır şut hacminde FG/FT bazları motorla aynı 0.47/0.78 değerlerine döner.
- `TOTAL Z = Z_FG + Z_FT + Z_3PM + Z_PTS + Z_REB + Z_AST + Z_STL + Z_BLK + Z_TO`. Bu toplamdır, ortalama değildir.

İlk geçişte bütün dönem oyuncularıyla bazlar ve dağılımlar hesaplanır; ilk dokuz kategori Z toplamında en iyi en fazla 130 oyuncu referans seçilir. İkinci geçişte bu grubun FG/FT bazları, ortalamaları ve standart sapmaları yeniden hesaplanır. Dönemdeki **bütün** oyuncular aynı nihai dağılımla değerlendirilir. Referans sınırındaki eşitlikleri kararlı kılmak için giriş ESPN athlete ID'ye göre sıralanır. Nihai eşitlikler de ID ile çözülür. Mevcut draft motoru ve golden-master fixture'ları değiştirilmez.

Mevcut motorla bilinçli fark: girdiler sezon toplamı yerine maç başınadır; eşit referans puanlarında mevcut motor giriş sırasını korurken bu ekran ID sırasını kullanır. Kategori matematiği aynıdır.

## Dönemler ve arayüz

Season 2026-27, Last 7/14/30 Days ve Last Season 2025-26 ayrı oyuncu havuzlarına ve dağılımlara sahiptir. Last 7/14/30 takvim günüdür; mevcut tarih seçimi değişmez. **Farklı dönemlerin TOTAL Z değerleri aynı ölçekli, doğrudan karşılaştırılabilir puanlar değildir.** Her puan kendi döneminin referans grubuna göredir. Boş dönem oyuncu veya rank üretmez.

Hesaplama snapshot'ın seçili dönem nesnesine göre `useMemo` ile yapılır. Arama ve sütun sıralaması hesaplamayı tekrarlamaz. Rank filtrelemeden önce belirlenir, aramada yeniden numaralanmaz. Varsayılan TOTAL Z büyükten küçüğe sıralamadır. Hesaplamalar ve sıralama tam hassasiyetlidir; yalnızca TOTAL Z gösterimi iki ondalığa yuvarlanır. Tablo mevcut klavye erişimli yatay kaydırma bölgesini kullanır; sayfa genişliğini büyütmez.

## Doğrulama

`tests/application/playerZScores.test.ts`: eşit ağırlıklar, hacim, TO, GP bağımsızlığı, motorla referans uyumu, 130 sınırı ve eşitlikleri, tam hassasiyet, küçük/boş/sabit veri, beş ayrı dönem.

`tests/ui/central-rankings.test.mjs`: her sütunda sıralama ve aramada değişmeyen rank/puan, dönem geçişleri, aynı görünen puanların hassas sıralaması, yenilemede yeniden hesaplama, 280/375/768/1280/1920px kullanılabilirliği ve mevcut manuel/draft oturum izolasyonu. Mevcut regresyonlar korunur.
