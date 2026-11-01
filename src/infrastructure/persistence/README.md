# Aşama 12 oturum davranışı

Uygulama `LocalStorageWorkspaceRepository` adaptörünü lazy `sessionStorage` getter'ı
ve `nba-fantasy-assistant.session.v1` anahtarıyla kullanır. Eski localStorage
anahtarı uygulama tarafından okunmaz/yazılmaz/silinmez. Adaptörün varsayılan
anahtarı eski sözleşme ve regresyonlar için korunur; uygulama onu kullanmaz.

WorkspaceStore'un oturum modunda her kabul otomatik kaydedilir. Yazma sürerken
başka kabul engellenir; tamamlanan eski yazma yeni snapshot'ı ezmez. Başarısız
kayıt bellek snapshot'ını ve dirty durumunu korur. Başarı yalnız repository yazması
tamamlandığında gösterilir. Kaydet düğmesi hata sonrası yeniden deneme için kalır.
F5 oturumu yükler; tab/tarayıcı oturumu sonunda kalıcılık garanti edilmez.

`manualDraftLocked?: boolean` native v1 JSON'a geriye uyumlu opsiyonel alan olarak
eklenmiştir. Hazırlık tamamlanınca işaretlenir; strateji sıfırlansa veya son seçim
geri alınsa da korunur. Kilitli draftın veri seti/oyuncu/projeksiyon/pozisyon havuzu
UI ve store sınırında değiştirilemez. Açık onaylı tam JSON geri yükleme farklıdır:
bütün workspace tek işlemde değiştirilir; havuzlar birleştirilmez.

Oyuncu Sıralamaları dosya yüklemesi kaldırıldı; ekran yalnız merkezi Fantasy Assistant
verisini gösterir. Eski `nba-fantasy-assistant.rankings-session.v1` kaydı yeni çalışmada temizlenir.
Navigasyon ayrı bir `nba-fantasy-assistant.navigation.v1` kaydıdır; rota hiçbir
workspace verisini silmez. Yeni çalışma açık onaydan sonra aktif draft ve sıralama
verilerini temizler ve ana ekrana gider. Oturum anahtarı dışındaki hiçbir storage
anahtarı temizlenmez; Storage.clear kullanılmaz.

Aşağıdaki bölümler JSON/v3 doğrulama ve eski adaptör sözleşmesinin tarihsel
ayrıntılarıdır; yeni manuel oturum için yukarıdaki davranış geçerlidir.

# Çalışma alanı kalıcılığı — Aşama 5

Domain ve motor değişmedi. `src/application/ports.ts` içindeki asenkron
`WorkspaceRepository`, DOM tipi veya tarayıcı teknolojisi içermez. `load()` için
başarılı `null` kayıt bulunamadığını, başarısız sonuç ise erişim veya veri hatasını
ifade eder. `save()` yalnızca yazma tamamlandıysa başarılıdır. Sözleşme aynı
`WorkspaceSnapshot` ile gelecekte IndexedDB tarafından uygulanabilir.

## JSON ve doğrulama

`exportWorkspaceJson(snapshot)` ve `restoreWorkspaceJson(text)` bağımsızdır;
tarayıcı, dosya sistemi veya repository gerektirmez. Yedek doğrudan
`schemaVersion: 1` olan mevcut `WorkspaceSnapshot` şemasıdır. Domain verileri,
kimlikler, kaynak/veri seti bilgileri, pozisyonlar, stratejiler ve sıralı seçimlerin
opsiyonel `selectionIndex` / `outOfTurnConfirmed` alanları taşınır. Draft dışındaki
`rosterEntries` de desteklenir. Hesaplanan Z-score, öneri, sıralama veya geçici UI
verileri şemada yoktur; dışa aktarım her seviyede yalnızca tanımlı alanları üretir.

İçe aktarma sırası: JSON çözümle → tüm zorunlu alanları ve ayrımlı tiplerin
şekillerini kontrol et → domain `validateWorkspace` ile referans, benzersizlik,
kapasite, snake/onay ve durum kurallarını kontrol et → yeni snapshot döndür.
Bilinmeyen alanlar içe aktarmada reddedilir; yeni alanlar sürüm değerlendirmesi
gerektirir. Veri seti şema sürümü de denetlenir. Geçersiz veri sessizce onarılmaz.

Bu işlevler mevcut çalışma alanına erişmez ve onu değiştirmez. Gelecekteki
uygulama katmanı yalnızca başarılı sonuçtan sonra dönen snapshot'ı tek işlemde
belleğe uygulamalıdır. Başarısız sonuçta mevcut referansı korumalıdır. Restore
başarılı, ardından otomatik kayıt başarısız olursa bellekteki restore edilmiş
çalışma korunmalı ve kayıt hatası gösterilmelidir; JSON yedeği yine üretilebilir.
Bu aşamada React Context/reducer veya dosya indirme/yükleme entegrasyonu yoktur.

| Hata kodu | Anlam / yapılacak işlem |
| --- | --- |
| `invalid-json` | JSON çözümlenemedi; mevcut çalışma korunur. |
| `unsupported-schema` | Desteklenmeyen snapshot/veri seti sürümü; `path` bildirilir. |
| `invalid-data` | Şekil veya domain kuralı hatası; kod ve alan yolu içeren `issues` gösterilir. |
| `serialization` | Örneğin döngüsel nesne veya BigInt; yazma yapılmaz. |
| `storage-access` | Getter, okuma veya yazma erişimi başarısız. |
| `storage-quota` | Standart veya Firefox kota hatası; kayıt başarısızdır. |
| `existing-record-invalid` | Mevcut kayıt doğrulanamadı; `reason` asıl hatayı taşır. Üzerine yazılmaz. |
| `legacy-migration` | v3 alan, kimlik, birim veya aktarım onayı sorunu; alan yollarıyla bildirilir. |

## localStorage davranışı ve sınırları

`LocalStorageWorkspaceRepository` yalnızca uygulamaya ait
`nba-fantasy-assistant.workspace.v1` anahtarını kullanır. Bağımlılık lazy getter
olarak verilebilir; testlerde `WorkspaceStorage` sahte uygulaması kullanılır.
Global localStorage getter'ının istisnası da sonuç olarak yakalanır. Adaptör hiçbir
eski/kişisel anahtarı aramaz, enumerate etmez veya okumaz.

Önce aday veri serileştirilip doğrulanır, mevcut kayıt varsa doğrulanır, sonra tek
`setItem` ile değiştirilir. Önce silme, geçici anahtar veya kısmi alan yazımı yoktur.
Native Storage sözleşmesinde başarısız `setItem` eski değeri korur. Adaptör girdi
nesnesini hiçbir durumda değiştirmez. Bozuk, doğrulanmamış veya bilinmeyen sürümlü
mevcut kayıt yüklemede hata verir; kaydetme de aynı kaydı ezmeyi reddeder. Otomatik
silme/onarım veya zorla üzerine yazma API'si yoktur. Kurtarma için mevcut ham kayıt
ayrıca güvenceye alınmalı; kullanıcı tarafından açıkça çözülmeden silinmemelidir.

Bu, çok sekmeli transaction değildir: kontrol ile yazma arasında başka sekme
yazabilir; son yazan kazanır. Disk flush, tarayıcı çökmesine karşı dayanıklılık,
kalıcı saklama veya okuma sonrası doğrulama garantisi verilmez. Kota, özel gezinme,
erişim politikası, site verisi temizliği, farklı origin/profil ve tarayıcı veriyi
etkiler. JSON'un tamamı senkron yazılır; büyük havuzlarda gecikme olabilir.
Başarısız yazma asla “kaydedildi” sayılmamalı; bellek korunmalı ve bağımsız JSON
yedeği indirme olanağı sunulmalıdır. JSON farklı cihaz/origin/tarayıcıya taşınabilir.

Gelecekte IndexedDB geçişinde aynı doğrulama hattı kullanılmalı: eskiyi oku →
doğrula/dönüştür → yeni depoya yaz → yeniden okuyup doğrula. Eski kopya yeni kayıt
doğrulanmadan kaldırılmamalıdır. IndexedDB uygulaması bu aşamada yoktur.

## Kullanıcı tarafından sağlanan v3 yedeği

`migrateLegacyV3Json(json, options)` gerçek `tests/legacy/v3.3.html` içindeki
`exportBackup()` / `fromObjects()` biçimini okur: `version: 3`, sıralı `teams`,
`myTeam`, `targets`, `{id,name,rank,pos,values,mode,valid}` oyuncuları ve kronolojik
`{id,team}` seçimleri. Legacy HTML çalıştırılmaz veya kaynak olarak içe aktarılmaz.
`options` ile lig kimliği, sezon ve ISO `importedAt` çağıran tarafından verilir;
v3 bunları güvenilir taşınabilir alanlar olarak saklamaz. Yeni lig adı boş kalır;
v3'te lig adı alanı bulunmaz. Yedekten gelen takım adları aynen korunur.

Takım indeksi `${leagueId}:team:${index}`, tam eski oyuncu kimliği `v3:${legacyId}`
olur. Oyuncu kimliği ayrıca `providerIds.legacyV3` içinde korunur. Bu eşleme
isim, satır sırası veya istatistiklere bağlı değildir; v3'ün ad temelli eski ID'si
yeniden hesaplanmaz. İki aynı adlı fakat farklı ID'li oyuncu birleştirilmez.
Tekrarlanan ID, eksik kimlik, bilinmeyen seçim ID'si, geçersiz takım ve kapasite
ihlali tüm aktarımı reddeder; benzer isimle veya dizi indeksiyle eşleştirme yoktur.
Karışık/bilinmeyen satır birimleri reddedilir; mevcut tek aktif veri setine sessiz
birim dönüşümü yapılmaz. `perGame` ve `totals` ayrı ayrı desteklenir.

v3 geçmiş silmelerde diziyi sıkıştırır; seçimlerin orijinal indeksi ve onayları
yedekte bulunmaz. Aktarım mevcut kronolojik diziyi ve sahipliği aynen korur,
`selectionIndex` için bu dizinin indeksini kaydeder. Snake ile uyuşmayan seçimlerde
varsayılan sonuç `legacy-turn-confirmation-required` hatasıdır. Çağıran bu seçimleri
gösterip kullanıcının sahipliği koruma onayını aldıktan sonra
`confirmUnverifiableTurns: true` ile tekrar çağırabilir. Yalnızca bu durumda
uyuşmayan seçimlere `outOfTurnConfirmed: true` yazılır; eski onay bulunmuş gibi
davranılmaz. Domain kuralları gevşetilmez. Sonraki silmeler tarihsel indeksi ve
verilmiş onayı koruyan Aşama 3 domain işlemleriyle çalışır. Yeni sıra kalan seçim
sayısından hesaplanmaya devam eder.

Başarı sonucunda `{ snapshot, notices }` döner. Aşağıdaki sınırlar raporlanır:

- Her dolu v3 draftında orijinal seçim indeksleri/onaylarının bulunmadığı bildirilir.
  Onayla korunan uyuşmazlıklar seçim bazında ayrıca bildirilir.
- Eksik, hatalı veya legacy tarafından analiz dışı işaretlenmiş projeksiyonlar
  `excluded` olur; oyuncu ve seçim korunur. Domain excluded modeli ham istatistik
  taşımaz; bu satırların ham değerlerinin tutulmadığı açık notice ile raporlanır.
  Orijinal v3 dosyası ayrıca saklanmalıdır.
- Geçersiz/kesirli RANK kullanılmaz ve raporlanır. Tanınan POS token'ları korunur;
  bilinmeyen token'lar raporlanır, özel pozisyon uygunluğu varsayılmaz.
- `targets` yalnızca kullanıcının seçili takımına uygulanır; v3 diğer takımlar için
  strateji tutmaz. Diğer takımlar `unset` kalır.
- `source.file` kaynak adı olur. Yerelleştirilmiş `source.loaded` tahmin edilmez;
  sağlanan `importedAt` ile değiştirildiği raporlanır. Satır birimiyle uyuşmayan
  `source.mode` kullanılmadığı ayrıca bildirilir.
- Domain karşılığı olmayan `strongLimit` ve diğer ek alanlar `unmapped-field`
  notice'larıyla alan yolu düzeyinde bildirilir. Kişisel değerler koda yazılmaz.

Aktarım mevcut çalışma alanına erişmez; başarısız aktarım kısmi veri uygulamaz.
Çağıran tüm doğrulama ve gerekli onaylar tamamlanınca snapshot'ı tek işlemde
uygulamalıdır. Eski anahtarlardan otomatik taşıma yoktur.

## Doğrulama

`npm run test:persistence`: Storage hataları için fake Storage, gerçek domain
kuralları ve eksik projeksiyon için gerçek hesaplama motoru kullanılır. Boş/kısmi/
tam draft, tarihsel silme/onaylar, JSON eşdeğerliği ve retleri, kayıtta veri kaybını
önleme, gerçekçi sentetik v3 yedeği, sabit legacy importer kayıtları ve anahtar
izolasyonu doğrulanır. Mevcut HTML ve sabit referanslar değiştirilmez.
