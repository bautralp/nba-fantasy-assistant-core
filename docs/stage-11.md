# Aşama 11 — Kurulum ve sekmeli Draft Assistant

## Davranış ve veri sınırları

Hazırlık durumu `selectPreparation()` ile mevcut veriden türetilir: geçerli lig
ayarları, kullanıcının takımında en az bir İlk 1/3/5/7 hedefi ve aktif veri seti.
Varsayılan hedefler değiştirilmez. Kayıt şeması hâlâ v1’dir; mevcut native kayıtlar
ve v3 migrasyon çıktıları ek geçiş gerektirmez. Draft seçimi veya oturumsuz kadro
kaydı bulunan alanlar eksik hazırlıkta uyarıyla açık kalır.

Draft pozisyonu seçilen takımın `draftOrder` içindeki yerinden türetilir.
Ayrı bir sıra form alanı yoktur. Sıra kontrolleri mevcut domain komutlarını ve
başlamış draft kısıtını kullanır.

Dört sekme aynı `DraftAssistant` bileşeninde tutulur. Seçiciler workspace nesnesi
üzerinden memoize edilir; sekme seçimi veya Ayarlar açılması motoru yeniden
çalıştırmaz. Paneller `hidden` ile erişilebilirlik ağacından ve yerleşimden çıkar;
DOM’da tutulmaları arama, filtre, sıralama, sayfalama, kaydırma ve details
seçimlerinin korunmasını sağlar. Sekmeler yön tuşları, Home ve End ile kullanılabilir.

## Sıfırlama komutları

| İşlem | Değişen veri | Korunan veri |
|---|---|---|
| Lig | Uygulamaya ait tek localStorage kaydı silinir; başarıdan sonra bellek başlangıca döner | Başka localStorage anahtarları; hata veya çakışmada mevcut bellek ve kayıt |
| Strateji | Yalnızca kullanıcı takımının dokuz hedefi `unset` | Diğer stratejiler, tüm projeksiyonlar, seçimler ve sahiplik |
| Oyuncu havuzu | `league.activeDatasetId = null` | Kalıcı kimlikler, draft ve sahiplik, tarihsel veri setleri/projeksiyonlar/pozisyonlar |

UI onay kutusu ve güncel revizyon kontrolü kullanır. Store onaysız, eski
revizyonlu, kayıt sürerken veya çakışma bulunan sıfırlamayı reddeder. Strateji ve
havuz komutları `WorkspaceStore.accept()` üzerinden merkezi doğrulamadan geçer.
Lig silme repository katmanında başarılı yüklemeden gelen baseline ile güncel
kaydı karşılaştırır, geçerliliğini doğrular ve yalnızca uygulama anahtarını siler.
Silme hatası belleği temizlemez. localStorage’ın atomik compare-and-swap desteği
yoktur; var olan optimistic kontrol aynı sınırlamayla sürer.

## Kimlik ve kurtarma

[Projeksiyon formatı](projection-format.md#aşama-11-kimlik-sözleşmesi) sayısal,
metin, başında sıfır bulunan, mükerrer ve UUID kimliklerin sözleşmesini açıklar.
Sayısal `1` / metin `"1"` aynıdır; `"001"` ayrı kalır. Büyük metinler Number’a
çevrilmez. Kaynak XML/JSON’da tam sayı olmayan fakat Number dönüşümünde yuvarlanan
kimlikler de reddedilir. Aynı ID/farklı ad önizlemede bildirilir; kalıcı görünen ad
ve draft sahipliği korunur. Havuz dışa aktarımı satır sırasından ID üretmez.

Normal arayüzde JSON yedek veya legacy sürüm bağlantısı bulunmaz. Kayıt/yükleme
hatası ve sekme çakışmasında Acil JSON kurtarma açılır. Mevcut JSON/v3 restore ve
export kodu, golden referanslar ve legacy migrasyonlar korunur. Kurtarma paneli
hata düzeldiğinde görünmez; daha önce hazırlanmış önizleme revizyon kontrolünü
korur. Çakışma halinde açık onay olmadan güncel kayıt belleğe yüklenmez veya
üzerine yazılmaz.

## Ekran görüntüleri

Gerçek Chromium, 1000 CSS px yükseklik; sentetik oyuncu ve takım verileri.
Her genişlikte setup ve dört sekme için yatay sayfa taşması kontrol edilir.

| Genişlik | Kurulum | Draft | Power Rankings | Kadrolar | Analiz |
|---|---|---|---|---|---|
| 280 px | [Kurulum](screenshots/stage-11/setup-280.png) | [Draft](screenshots/stage-11/draft-280.png) | [Power](screenshots/stage-11/power-280.png) | [Kadrolar](screenshots/stage-11/rosters-280.png) | [Analiz](screenshots/stage-11/analysis-280.png) |
| 375 px | [Kurulum](screenshots/stage-11/setup-375.png) | [Draft](screenshots/stage-11/draft-375.png) | [Power](screenshots/stage-11/power-375.png) | [Kadrolar](screenshots/stage-11/rosters-375.png) | [Analiz](screenshots/stage-11/analysis-375.png) |
| 768 px | [Kurulum](screenshots/stage-11/setup-768.png) | [Draft](screenshots/stage-11/draft-768.png) | [Power](screenshots/stage-11/power-768.png) | [Kadrolar](screenshots/stage-11/rosters-768.png) | [Analiz](screenshots/stage-11/analysis-768.png) |
| 1280 px | [Kurulum](screenshots/stage-11/setup-1280.png) | [Draft](screenshots/stage-11/draft-1280.png) | [Power](screenshots/stage-11/power-1280.png) | [Kadrolar](screenshots/stage-11/rosters-1280.png) | [Analiz](screenshots/stage-11/analysis-1280.png) |
| 1920 px | [Kurulum](screenshots/stage-11/setup-1920.png) | [Draft](screenshots/stage-11/draft-1920.png) | [Power](screenshots/stage-11/power-1920.png) | [Kadrolar](screenshots/stage-11/rosters-1920.png) | [Analiz](screenshots/stage-11/analysis-1920.png) |

![Masaüstü Draft](screenshots/stage-11/draft-1280.png)

![Mobil kurulum](screenshots/stage-11/setup-375.png)

## Doğrulama

Aşama 10’un mevcut test senaryoları korunur. UI testlerinin navigasyonu yeni
kurulum, sekme ve Ayarlar yollarına uyarlanır. Eski JSON testleri gerçek geçici
storage erişim hatası üzerinden acil kurtarmayı çalıştırır; normal UI’da JSON
bulunmadığı ayrı test edilir. Yeni testler kurulum kapıları, derived draft sırası,
sekme durum/veri koruması ve motor çağrı sayısı, güvenli sıfırlamalar, v1/v3
hazırlık uyumluluğu, sayısal/UUID kimlik ve isim değiştirilmiş reimportu kapsar.
Tarayıcı testleri paylaşılan Vite önbelleği ve kaynak çekişmesini sınırlamak için
sıralı çalışır. GitHub Actions Chromium testleri, Firefox/WebKit yolculukları,
TypeScript, build, düşük seviye dahil npm audit ve performans kontrollerini sürdürür.

Yerel Firefox/WebKit indirme adresleri cloud ağ politikasında engellendiği için
bu motorlar GitHub Actions üzerinde doğrulanır. CI/Netlify bağlantıları ve son
sonuçlar PR açıklamasında tutulur.

## Bilinen sınırlamalar

- Sekme ve geçici UI seçimleri sayfa yenilemede sıfırlanır; iş verileri açık Kaydet
  işlemiyle saklanır. Sekme geçişinde UI seçimleri korunur.
- Paneller durum korumak için DOM’da tutulur; oyuncu havuzu 25 satırla sayfalanır.
- Havuz sıfırlaması tarihsel veri depolamasını azaltmaz. Tam temizlik lig sıfırlamasıdır.
- Ad değişiklikleri otomatik uygulanmaz; dosya adı ve mevcut görünen ad önizlenir.
- Excel’in dosya kaydedilmeden önce yaptığı hassasiyet kaybı geri alınamaz; uzun
  ID’ler veri girişinden önce Metin hücresi olarak hazırlanmalıdır.
- Yeni backend, hesap eşitlemesi veya motor algoritması değişikliği yoktur.
