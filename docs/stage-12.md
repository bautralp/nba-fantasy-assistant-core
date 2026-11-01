# Aşama 12 — Ana menü ve oturumluk manuel çalışmalar

## Ürün davranışı

Ana menü üç büyük karttan oluşur: Oyuncu Sıralamaları, Draft Asistanı ve küçük
Yapım aşamasında etiketli Sezon İçi Asistanı. Hepsi veri kaynağı seçimine gider.
Geri navigasyonu veriyi sıfırlamaz; klavye ile geçişlerde yeni başlığa odak taşınır.

| Bölüm | Manuel kaynak | Fantasy Assistant kaynağı |
|---|---|---|
| Oyuncu Sıralamaları | Excel/CSV/JSON, RANK/dosya sırası, ad araması, sütun sıralaması, hesaplanan FG%/FT% | Yapım aşamasında |
| Draft Asistanı | Mevcut üç adımlı hazırlık, 10 takım/snake, strateji, seçim/transfer/silme/geri alma ve dört analiz sekmesi | Yapım aşamasında; aktif kilitli draftta kaynak değişimi kapalı |
| Sezon İçi Asistanı | Yapım aşamasında, dosya istenmez | Yapım aşamasında |

API, örnek oyuncu, geçici sağlayıcı, ROS modeli, 12 takım, sezon içi analiz,
waiver/takas/simülasyon veya ESPN/Yahoo entegrasyonu eklenmedi.

## Kimlik ve havuz kilidi

Yeni boş Excel'in Players ve Instructions sayfalarında PLAYER_ID yoktur.
Eski dosyalardaki PLAYER_ID manuel akışta yok sayılır. Oyuncu adına, RANK'a veya
satır sırasına bağlı olmayan UUID'ler önizlemede oluşturulur, kabulde saklanır.
Seçim, takım sahipliği ve geri alma bunları kullanır. F5 ID üretmez; saklanan ID'yi
okur. Bağımsız import yeni kimlikler üretir, iki bölüm arasında kimlik taşınmaz.

Unicode/aksan/harf büyüklüğü/boşluk/noktalama farklarıyla aynı normalize ada sahip
satırlar reddedilir. Hata iki satırı adlarıyla bildirir; kullanıcı dosyayı düzeltir.
RANK/PLAYER_ID farkı mükerrer oyuncuyu güvenli şekilde ayırt etmez.

Hazırlıkta önizleme iptal edilebilir veya dosya değiştirilebilir. Hazırlıkta yeniden
kabul önceki havuzu tamamen değiştirir; yalnız bir veri seti tutulur. Üç hazırlık
adımı tamamlanıp Draft ekranı açıldığı anda `manualDraftLocked` kalıcı oturum
bayrağı olur. İlk seçim beklenmez; strateji sıfırlama veya son seçimin geri
alınması kilidi açmaz. UI ve store havuz/veri seti/projeksiyon/pozisyon değişimini
reddeder. Farklı dosya için açık onaylı Yeni çalışma gerekir.

Tam JSON kurtarma ayrı bir işlemdir: mevcut alan varsa onayla bütün workspace
atomik olarak değiştirilir; havuzlar birleştirilmez. Native JSON, v3 migration,
seçim kronolojisi/onayları, referans ve kapasite doğrulamaları korunur.

## sessionStorage ve veri güvenliği

| Anahtar | İçerik |
|---|---|
| `nba-fantasy-assistant.session.v1` | Lig, takımlar/sıra, kullanıcı takımı, hedefler, oyuncu UUID'leri, istatistikler, uygunluk, seçimler, kilit |
| `nba-fantasy-assistant.rankings-session.v1` | Bağımsız sıralama dosyası, metaverisi ve kendi UUID'leri |
| `nba-fantasy-assistant.navigation.v1` | Seçilen bölüm/kaynak ekranı |
| `nba-fantasy-assistant.draft-view.v1` | Lig kimliği ve etkin çalışma sekmesi |

Kabul edilen draft komutları otomatik kaydedilir. Kullanıcının Kaydet'e basması
zorunlu değildir; düğme yeniden deneme için kalır. Yazma sırasında kabul engellenir;
başarısız yazma önceki depolama kopyasını ve güncel belleği korur, başarı bildirmez.
Kota/erişim hatasında Acil JSON kurtarma görünür/kullanılabilir. Sıralamalar kendi
hatasını bildirir ve bellekteki tablosunu korur. Yüklemede sıralama parser'ı tekrar
çalışır; UUID sayısı ve benzersizliği denetlenir.

F5 aynı sekmede bütün draftı, kaynağı ve etkin sekmeyi geri açar. Ana menüye dönüş
ve bölümler arası gezinme bellek veya depolamayı sıfırlamaz. Draft kaynağında
Mevcut çalışmaya devam et sunulur. Sekme/tarayıcı oturumu sonunda kalıcılık garanti
edilmez; bu sınır UI'da yazılıdır.

Yeni çalışma onay kutusu ve güncel revizyon kontrolü ister. Aktif oturumun draft,
sıralama ve görünüm verileri temizlenir; ana menü açılır. Başarısız silme bellekten
veri kaldırmaz. İki bağımsız bağlamın silinmesi tek storage transaction değildir:
draft temizlenip sıralama silinemediğinde sıralama bellekte korunur, hata gösterilir
ve tekrar denenebilir. Hiçbir global Storage.clear çağrısı yoktur.

Eski `nba-fantasy-assistant.workspace.v1` localStorage kaydı otomatik okunmaz,
silinmez veya üzerine yazılmaz. Otomatik migrasyon/anahtar keşfi eklenmedi.
Kullanıcının sağladığı native/v3 JSON yedeği açık onaylı kurtarma akışında kullanılabilir.
Eski adaptörün varsayılan anahtarı ve tarihsel import/export kimlik sözleşmeleri
uyumluluk regresyonları için korunur; yeni manuel UI bunları kullanmaz.

## Test kapsamı ve değişen beklentiler

Motor, kategori kuralları, `src/engine`, sabit golden-master dosyaları ve 26 legacy
HTML testi değiştirilmedi. Eski testler sessizce silinmedi; ürün kararıyla geçersiz
beklentiler aşağıdaki şekilde güncellendi.

| Önceki beklenti | Aşama 12 beklentisi / korunan kapsam |
|---|---|
| Açılışta hazırlık ekranı | Ana menü → Draft → kaynak seçimi → aynı hazırlık testleri |
| localStorage'a elle Kaydet | Otomatik sessionStorage; kota/erişim, bozuk kayıt ve JSON kurtarma testleri sürüyor |
| İki sekme aynı draft kaydını paylaşır | Bağımsız oturumlar ve eski localStorage'a dokunmama; eski repository conflict testleri ayrıca korunuyor |
| Draft sırasında Excel reimport/analiz yenileme | UI/store kilidi, aynı seçim/öneri/analizlerin korunması; eski saf import uyumluluk testleri tutuluyor |
| Mükerrer ad için ayrı oyuncu seçimi | Tüm manuel dosyanın açık satır bilgisiyle reddi; eski kimlik kararları altyapıda test edilmeye devam ediyor |
| Yeni Excel'de sayısal PLAYER_ID | Yeni şablonda kimlik yok; eski kimlikli dosyalar ayrı legacy fixture helper'ıyla hâlâ doğrulanıyor |
| Havuz sıfırlama / lig silme | Kilitli havuz sıfırlanamaz; Yeni çalışma onayı, revizyon, silme hatası ve doğru anahtar temizliği |
| Restore sonrası elle kayıt | Onaylı restore otomatik kaydedilir; hatalı/stale restore atomik kalır |
| Dirty başarılı komuttan sonra sürer | Başarılı otomatik kayıtta temiz; başarısız kayıtta dirty ve beforeunload korunur |

`npm test`: **334/334** (25 domain, 26 motor, 20 persistence, 26 legacy,
57 application, 96 Chromium UI, 54 import, 30 tema/kontrast).
Önceki 320 sayısı Chromium suite'lerine ek 12 Firefox/WebKit smoke testi içeriyordu.
Yeni `test:browsers` aynı akışlara kaynak seçimi/sıralama/F5 ekleyerek 20 testi kapsar;
toplam hedef kapsam **354** testtir. Form odağı testleri gerçek asenkron odak
aktarımı için `waitForFunction` kullanır; gerçek erişilebilirlik hatası gizlenmez.

TypeScript, build, audit (0 açık), model performansı ve gerçek Chromium performansı
lokalde geçti. 150/300/600 oyunculu tarayıcı ölçümleri mevcut bütçelerin içinde;
600 oyuncuda medyan XLSX önizleme ~490 ms, uygulama/panel ~419 ms. Ölçümler geliştirme
Vite ve Playwright etkileşim süresini içerir; benchmark donanım garantisi değildir.
Firefox/WebKit indirmeleri yerel ortamın ağ politikasıyla engellendi. CI bunları
standart GitHub runner'da kurar. CI sonucu PR açıklamasında ayrıca belirtilir.

## Responsive görüntüler

280, 375, 768, 1280 ve 1920 CSS px'de ana menü, kaynak seçimi ve gerçek dosyadan
oluşan tablo için sayfa genişliği kontrol edilir. Tablo kendi erişilebilir yatay
kaydırma alanındadır. Aynı beş genişlikte hazırlık ve dört draft sekmesi kontrolleri
korunur; klavye tab navigasyonu, native dialog, focus containment/Escape/geri odak,
200% reflow, kontrast ve erişilebilir isim testleri devam eder.

| Görünüm | Mobil (375) | Masaüstü (1280) |
|---|---|---|
| Ana menü | [Mobil](screenshots/stage-12/home-375.png) | [Masaüstü](screenshots/stage-12/home-1280.png) |
| Kaynak seçimi | [Mobil](screenshots/stage-12/source-375.png) | [Masaüstü](screenshots/stage-12/source-1280.png) |
| Manuel sıralamalar | [Mobil](screenshots/stage-12/rankings-375.png) | [Masaüstü](screenshots/stage-12/rankings-1280.png) |
| Draft | [Mobil](screenshots/stage-12/draft-375.png) | [Masaüstü](screenshots/stage-12/draft-1280.png) |

![Ana menü](screenshots/stage-12/home-1280.png)

## Bilinen sınırlar

- Kaynak katalogları, otomatik NBA verileri ve sezon içi işlevler henüz yoktur.
- Kalıcılık yalnız tarayıcı sekmesi oturumuna aittir; veri tabanı/hesap/eşitleme yoktur.
- Aynı ada sahip gerçek kişiler dosyada kullanıcı tarafından ayırt edilmelidir.
- Büyük dosyalar mevcut parser sınırlarına ve sessionStorage kotasına tabidir.
- Sıralama ekranında fantasy ranking üretilmez; eksik RANK görsel olarak `—` kalır.
