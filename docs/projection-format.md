# Manuel oyuncu dosyaları — Aşama 12

Excel şablonu `Players`, `Settings`, `Instructions` sayfalarından oluşur; örnek
oyuncu içermez. `Settings`: `schemaVersion = 1`, sezon ve `unit = perGame | totals`.
Draftta dosya sezonu lig sezonuna eşit olmalıdır. Sıralamalarda lig gerekmez.

| Sütun | Kural |
|---|---|
| PLAYER | Oyuncu adı; normalize edilmiş mükerrer adlar tüm dosyayı reddeder. |
| POS | PG, SG, SF, PF, C, G, F; eksik/bilinmeyen token uyarıdır. G/F özel pozisyonlara genişletilmez. |
| RANK | İsteğe bağlı pozitif tam sayı; geçersizse uyarı ve boş sıra. Kimlik değildir. |
| GP | Pozitif sonlu sayı; ondalık olabilir. |
| FGM, FGA, FTM, FTA | Negatif olmayan sonlu sayı; FGM ≤ FGA, FTM ≤ FTA. |
| 3PM, PTS, REB, AST, STL, BLK, TO | Negatif olmayan sonlu sayı. |

FG%/FT% girilmez; isabet ve denemeden hesaplanır. Sıfır deneme yüzde üretmez.
Boş/geçersiz istatistik sıfır kabul edilmez; satır analiz dışında tutulur ve alan
uyarıları gösterilir. Formül cache sonuçları kullanılmaz. Noktalı ondalık kabul
edilir; binlik ayırıcı, virgüllü ondalık, NaN/Infinity, boolean ve negatif sayılar
kabul edilmez. Başlık alias'ları, sezon/birim/şema çelişkileri, ZIP/XML/JSON
sınırları ve bozuk dosya retleri önceki parser ile aynıdır.

CSV virgül, noktalı virgül veya tab ayıracı kullanabilir; belirsiz ayıraç ve bozuk
tırnaklar reddedilir. JSON nesne dizisi veya `{schemaVersion:1, season, unit,
players:[...]}` biçimindedir. JSON'da mükerrer anahtarlar reddedilir. Metaverisi
olmayan CSV/JSON için kullanıcı sezon/birimi açıkça belirtir. Lig/seçim içeren
workspace ve v3 yedekleri oyuncu importunda reddedilir; Acil JSON kurtarma kullanılır.

## Çalışma kimlikleri ve kilit

Yeni şablonda ve Instructions sayfasında PLAYER_ID yoktur. Eski dosyalardaki kimlik
sütunu manuel akışta görmezden gelinir; yeni UUID'ler `crypto.randomUUID()` ile
önizleme sırasında üretilir ve kabulden sonra oturum boyunca değişmez. Ad, RANK,
satır veya dış sağlayıcı ID'sinden türetilmez. Taslak önizleme iptali mevcut
çalışmayı değiştirmez. Eski asenkron okuma yeni seçimi ezemez; eski revizyonlu
önizleme uygulanamaz.

Mükerrerlik adın Unicode normalizasyonu, aksan, harf büyüklüğü, boşluk ve noktalama
farkları dikkate alınarak kontrol edilir. Aynı isimli iki gerçek kişi varsa bile
belirsizlik sessizce aşılmaz; kullanıcı dosyadaki adları ayırt etmelidir.

Hazırlıkta yeni kabul edilen dosya önceki havuzu tamamen değiştirir; tek veri seti
kalır. Draft ekranına girilince import ve havuz sıfırlama kilitlenir. Farklı dosya
ancak açık onaylı Yeni çalışma ile kullanılabilir. Sıralama ve draft bağlamları
ayrıdır; kimlik eşleştirmesi/taşıması yapılmaz.

## Korunan uyumluluk

Native JSON ve v3 yedek doğrulaması/legacy migration korunur. Eski kimlik eşleştirme
ve ID taşıyan export işlevleri uyumluluk regresyonları için altyapıda kalır; yeni
manuel UI bunları kullanmaz. [Tarihsel Aşama 11 formatı](projection-format-stage-11.md)
yeni kullanıcı akışı için geçerli değildir. Yeni sağlayıcı veya katalog eklenmemiştir.
