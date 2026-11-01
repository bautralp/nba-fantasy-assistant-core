# React workspace akışı

`leagueSetup.ts`, geçici formu doğrular ve `createInitialWorkspace` / `changeDraftOrder`
üzerinden tek bir `WorkspaceSnapshot` üretir. İsimlerden veya sıradan kimlik türetilmez;
yeni kurulumdaki UUID'ler uygulama katmanında üretilir. Her kabulden önce
`validateWorkspace` çalışır. Mevcut workspace güncellenirken yalnızca lig alanları,
takım adları ve izin verilen draft sırası değiştirilir. Veriyle uyumsuz sezon
geçişi reddedilir; mevcut projeksiyon veya uygunluk verileri başka sezona taşınmaz.

`WorkspaceStore`, Context + `useSyncExternalStore` ile React'e bağlanır. Tek kabul
edilmiş snapshot vardır. Form girdileri, dosya önizlemesi, aktarım onayları ve
bildirimler geçicidir; kayda veya hesaplama motoruna girmez. Kalıcı kayıt yalnızca
repository üzerinden ve açık Kaydet işlemiyle yapılır. Form gönderimi açıkça
oluşturma/kaydetme işlemidir. Eksik form repository'ye ulaşmaz.

Yükleme tek uçuşludur; React StrictMode tekrarları aynı Promise'i kullanır.
Yükleme tamamlanmadan düzenleme/aktarım kabul edilmez. Kaydetme sırasında ikinci
kayıt ve workspace değiştirme engellenir. Promise sonuçları eski snapshot'ı
geri uygulamaz. Başarısız kayıt snapshot'ı ve dirty durumunu korur. JSON yedeği
bu kabul edilmiş bellek durumundan alınır. Formdaki henüz gönderilmemiş eksik
alanlar yedeğe dahil değildir.

JSON geri yükleme: dosyayı oku → mevcut adapter ile doğrula → varsa v3 seçim
onayını al ve yeniden doğrula → bildirimleri ve önizlemeyi göster → mevcut alanı
değiştirme onayı al → tek seferde belleğe kabul et. Dosya okumaları istek kimliğiyle
korunur; eski okuma yeni dosya seçimini geçersiz kılamaz. Önizlemeden sonra workspace
değişirse yeniden önizleme gerekir. Aktarım otomatik kaydedilmez. Bozuk kayıt
repository tarafından korunur; bu sürümde zorla silme/üzerine yazma arayüzü yoktur.

v3 için yeni UUID lig kimliği, kullanıcı tarafından girilen sezon ve dosya seçimi
anındaki ISO aktarım zamanı kullanılır. Eski veri yükleme tarihi tahmin edilmez.
Dönüştürücüye onay ilk denemede gönderilmez; doğrulanamayan seçimlerin oyuncu ve
takım bilgisi gösterildikten sonra ayrı onayla yeniden denenir. Notices kullanıcıya
alan yolu ve açıklamayla gösterilir. Kapsamlı dosya yönetimi veya otomatik legacy
anahtar keşfi yoktur.

Sınırlar: aynı origin'deki çoklu sekmeler son yazan kazanır davranışını sürdürür.
Hesap, sunucu veya cihazlar arasında otomatik eşitleme yoktur. Lig düzenleme ve dosya aktarım
onayları sayfa içinde sunulur; draft ve strateji için aşağıdaki modal akışı kullanılır.

Projeksiyon içe aktarma: Excel/CSV/JSON adaptörleri `RawFile` üretir;
`projectionRows.ts` formatlardan bağımsız başlık/sayı/pozisyon doğrulamasını yapar.
`importPlayers.ts` kimlik adaylarını ve önizlemedeki kalıcı ID’leri hazırlar,
kararları doğrular ve saf `applyImport` ile yeni snapshot üretir. Mevcut havuza
ID’siz yeniden yükleme açık kimlik kararı gerektirir. İsim ve legacyV3 sağlayıcı
ID’si otomatik eşleşmez. Aynı ID’ye birden fazla satır bağlanamaz.

Önizleme workspace referansını ve revizyonunu taşır. Uygulama anında ikisi de
kontrol edilir; yeni snapshot `validateWorkspace` geçmeden store’a verilmez.
DraftSession ve stratejiler aynen korunur; yeni veri seti, projeksiyonlar ve
veri seti kapsamında pozisyon uygunluğu tek kabulde eklenir. Geçmiş veri setleri
ve oyuncu kimlikleri korunur; aktif veri setinde eksik oyuncuya eski projeksiyon
aktarılmaz. Ayrıntılar: [Veri formatı](../../docs/projection-format.md).

## Draft komutları ve selector

`draftCommands.ts` saf ve atomik `applyDraftCommand` sınırıdır. Append/remove
mevcut domain fonksiyonlarına gider. Transfer yalnızca hedef kaydın sahipliğini
ve onayını değiştirir; tarihsel indeks (eski kayıtta eksikse o anki indeks)
korunur, hedef kapasitesi kontrol edilir ve eski onay devralınmaz. Undo son
oyuncu kimliğini de doğrular. Her sonuç `validateWorkspace` sonrasında store'a
kabul ettirilir; reddedilen accept başarı mesajı üretmez. Strateji komutu yalnızca
aktif kullanıcı takımını etkiler. Kaydet davranışı değiştirilmemiştir.

`draftSelectors.ts`, aktif dataset/projeksiyon → model → draft kadrosu → kapsamlı
pozisyon çözümü → skor/sıra → hedef/plan/rakip → öneri akışını toplar. Lig/sezon
uygunluğu, aynı aktif dataset/sezon uygunluğunu override eder; geçmiş dataset
uygunluğu fallback değildir. Eşleşmeyen oyuncuya boş pozisyon listesi gider.
G/F tokenları genişletilmez. `projectTotals`, `matchLineup` ve recommendations'ın
`positionFit` çıktıları aynı gerçek motordan gelir. Sonuçlar snapshot'a yazılmaz.
React selector'ı snapshot referansına göre memoize eder; arama, sıralama, sayfa,
modal açma ve geçici strateji değerleri hesabı yeniden başlatmaz.

Atama/strateji/undo native `<dialog>.showModal()` kullanır: top layer ve inert
arka plan, tarayıcı odak tuzağı, Escape ve açıcıya geri odak. Her modal açılış
revizyonunu tutar; workspace/veri seti değişiminde işlem devre dışı kalır. İşlem
anında store'un en güncel snapshot/revizyonu da yeniden kontrol edilir. Yeni
onay takım seçimi değiştiğinde sıfırlanır. Lig editörü ve dosya önizlemesi mevcut
sayfa içi akışlarını korur.
