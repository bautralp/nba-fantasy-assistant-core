> Tarihsel Aşama 11 sözleşmesidir. Yeni manuel UI için [Aşama 12 formatı](projection-format.md) geçerlidir.

# Oyuncu projeksiyonu dosyaları — Aşama 11

## Kullanım

**Oyuncu havuzunu yükle** veya **Ayarlar → Oyuncu havuzunu değiştir** bölümünü açın. İlk yükleme için boş
**nba-fantasy-projections.xlsx** şablonunu indirin. Yeniden yükleme için
**Mevcut havuzu ID’leriyle Excel’e aktar** dosyasını kullanın: bu dosya kalıcı
`Player.id` değerlerini `PLAYER_ID` sütununa yazar.

Dosyayı seçin, sezon/birimi kontrol edin ve önizlemeyi inceleyin. Metaverisi eksik
CSV/JSON için sezonu girin ve birimi açıkça seçin. Kimlik sorunlarında mevcut
oyuncuyu seçebilir, ayrı yeni oyuncu oluşturabilir veya satırı açıkça aktarım
dışında bırakabilirsiniz. Aynı oyuncuya iki satır bağlanamaz. Belirsiz kararlar
çözülmeden uygulama açılamaz. Satır kararları 20 satırlık sayfalarda gösterilir.

**Yüklemeyi uygula** bellekte yeni veri setini aktif eder. **Kaydet** tarayıcıya
kalıcılaştırır. Kaydedilmemiş durum görünürdür. Kayıt hatasında bellekteki veri
korunur; sayfayı kapatmadan **Acil JSON kurtarma → JSON yedeğini indir** ile kurtarma kopyası alın.
İptal veya dosya reddi mevcut çalışma alanını değiştirmez. Önizleme sonrası lig
ayarı/geri yükleme gibi bir işlem workspace revizyonunu değiştirirse yeniden
önizleme gerekir. Eski asenkron dosya okumaları yeni seçimi değiştiremez.

## Excel yapısı

Gerçek OOXML `.xlsx` dosyasında üç sayfa zorunludur:

| Sayfa | İçerik |
|---|---|
| `Players` | İlk satırda sütun başlıkları, sonraki satırlarda oyuncular |
| `Settings` | A sütununda anahtar, B sütununda değer; başlık satırı yok |
| `Instructions` | Alanlar, pozisyonlar, sayılar, birimler ve güncelleme kuralları |

Settings anahtarları:

| Anahtar | Değer |
|---|---|
| `schemaVersion` | `1` |
| `season` | Lig sezonuyla aynı metin |
| `unit` | Tam olarak `perGame` veya `totals` |

Şablon lig sezonu ve mevcut veri setinin birimiyle (ilk yüklemede `perGame`)
oluşturulur. `Players` yalnızca başlık satırı içerir; örnek oyuncu bulunmaz.
İndirilen şablondaki `Settings.unit` dosyayı doldurmadan önce değiştirilebilir.

| Sütun | Kural |
|---|---|
| `PLAYER_ID` | Yeni oyuncuda boş olabilir; mevcut oyuncu için kalıcı uygulama ID’si. Güvenli pozitif tam sayı veya metin; bütün kimlikler uygulamada string saklanır. |
| `PLAYER` | Yeni oyuncuda zorunlu ad. Aynı ad farklı oyuncularda kullanılabilir. |
| `POS` | İsteğe bağlı `PG, SG, SF, PF, C, G, F`; virgül, `/`, boşluk, `;` veya `-` ile ayrılır. |
| `RANK` | İsteğe bağlı pozitif tam sayı; geçersizse uyarılır ve kullanılmaz. |
| `GP` | Zorunlu pozitif sonlu sayı; ondalık olabilir. |
| `FGM`, `FGA`, `FTM`, `FTA` | Zorunlu, negatif olmayan sonlu sayılar; `FGM ≤ FGA`, `FTM ≤ FTA`. |
| `3PM`, `PTS`, `REB`, `AST`, `STL`, `BLK`, `TO` | Zorunlu, negatif olmayan sonlu sayılar. |

`PLAYER` ve tüm sayısal projeksiyon sütunları zorunludur; `PLAYER_ID`, `POS` ve
`RANK` sütunları uyumluluk dosyalarında bulunmayabilir. Şablon hepsini içerir.
FG% ve FT% girdisi alınmaz; motor isabet/deneme hacminden hesaplar. G tek başına
PG/SG, F tek başına SF/PF uygunluğu vermez. Bilinmeyen pozisyon tokenları uyarılır
ve kullanılmaz; tanınan tokenlar korunur.

## CSV ve JSON

CSV; virgül, noktalı virgül veya tab ayırıcıyı, UTF-8 BOM’u, tırnaklı hücreleri,
tırnak içindeki satır sonlarını ve çift tırnak kaçışını destekler. Başlıklar
önce ortak alanlara çevrilir. v3.3 başlık takma adları korunur; örneğin `Player
Name`, `Games Played`, `FG3M`, `TOV`, `Positions`. Hem `PTS` hem `Points` gibi aynı
alana bağlanan başlıklar reddedilir. Satır/sütun sayısı uyuşmazlığı reddedilir.

JSON, oyuncu nesneleri dizisi veya aşağıdaki zarfı kabul eder. Bu örnek şema
gösterir; indirilen şablona oyuncu eklemez:

```json
{
  "schemaVersion": 1,
  "season": "2026-27",
  "unit": "perGame",
  "players": []
}
```

`players` yerine v3.3 uyumlu `data` dizisi kullanılabilir. Boş dizi uygulanamaz.
Her nesne CSV/Excel ile aynı sütun adlarını veya takma adlarını kullanır. `unit`
(veya `mode`, `dataUnit`) ve `season` satır alanları olarak da belirtilebilir.
Tüm tanımlı birimler/sezonlar aynı olmalıdır; çelişkiler kullanıcı seçimiyle
ezilmez. `season`/`unit` dosyada yoksa arayüzde açıkça girilir. Eski arayüzdeki
`season` mod etiketi yerine dosya biriminde `totals` kullanın. Tanımlı şema `1`
olmalıdır. JSON içinde tekrar eden anahtarlar sessizce ezilmez, dosya reddedilir.

WorkspaceSnapshot veya v3 draft yedekleri projeksiyon yükleyicisinden reddedilir.
Lig, takım ve seçim taşıyan bu dosyalar hata durumundaki **Acil JSON kurtarma**
akışından yüklenmelidir.

## Sayısal doğrulama ve hata sınıfları

Sayısal Excel hücreleri veya `60.5` gibi noktalı ondalık metinler kabul edilir.
Boş hücre `0` değildir. Negatif, sonlu olmayan, boolean, binlik ayırıcılı ve
virgüllü ondalık metinler kabul edilmez. `1,234` sessizce yorumlanmaz. Sıfır atış
hacmi geçerlidir. Formüller çalıştırılmaz ve önbellekteki hesap sonuçları okunmaz.

| Sınıf | Sonuç |
|---|---|
| Dosya düzeyinde ret | Bozuk dosya, eksik zorunlu sayfa/sütun, çelişkili başlık, desteklenmeyen şema, karışık/belirsiz birim veya kimliği kullanılabilir hiçbir oyuncunun olmaması. Workspace değişmez. |
| Satır düzeyinde analiz dışı | Kimliği belirli oyuncuda eksik/hatalı istatistik veya istatistik hücresinde formül. `PlayerProjection.status = excluded`; sıfır istatistikli oyuncu üretilmez. |
| Uyarı | Eksik/uygunsuz POS veya isteğe bağlı RANK. Geçerli istatistikler analizde kalır. |

Adı ve ID’si birlikte eksik satırlar konumlarıyla raporlanır, aktarılmaz. Kullanıcı
kararıyla atlanan satır da yeni veri setine aktarılmaz. Bu, kimliği çözülmüş fakat
istatistikleri hatalı olduğu için `excluded` projeksiyonla aktarılan satırdan
farklıdır. Tüm projeksiyonlar analiz dışıysa hem önizleme hem aktif veri seti
bunu açıkça gösterir. Eski projeksiyonlar veya sıfır verilerle analiz doldurulmaz.

Dosya boyutu 20 MB ile sınırlıdır. XLSX açılmış toplam içerikte 64 MB, tek parçada
20 MB, sayfa başına 50.000 satır ve 256 sütun sınırı uygular. Makro ve dış kaynak
çalıştırılmaz. DTD/entity tanımları, harici sayfa ilişkileri ve geçersiz XML
reddedilir. XLS/XLSM ve diğer elektronik tablo biçimleri bu aşamada desteklenmez.

## Kimlik kararları

- `PLAYER_ID` mevcut `Player.id` ile benzersiz ve çelişkisiz eşleşirse kimlik
  korunur. Ad değişse de aynı oyuncu kabul edilir ve görünen ad korunur. Başka
  oyuncunun sağlayıcı kimliğiyle çakışma açık karar gerektirir. İsim tek başına eşleştirme yapmaz.
- Önceden bilinmeyen, benzersiz ve çelişkisiz bir `PLAYER_ID` yeni kalıcı kimlik
  olarak kabul edilir. ID boşsa UUID üretilir. İsimden veya satırdan ID üretilmez.
- Mükerrer ID, eski sağlayıcı ID’si, mevcut isim adayları veya dolu bir havuza
  ID’siz yeniden yükleme varsa kullanıcı
  eşleştirme, ayrı yeni oyuncu veya satırı atlama kararı verir. Belirsiz satırda ayrı yeni oyuncu
  kararı bağımsız UUID kullanır; çelişen ID kaynak bilgisi olarak tutulabilir.
- `providerIds.legacyV3` yalnızca aday bulmakta kullanılır; `Player.id` ile aynı
  olduğu varsayılmaz. Tekil `providerIds.projectionFile` ise otomatik eşleşebilir.
- Yeni UUID’ler önizleme oluşturulurken atanır; React render’larında ve karar
  değişikliklerinde sabit kalır. Yeni önizleme yeni aday UUID’ler üretebilir.
- Mevcut oyuncunun adını/kimliğini eşleştirme işlemiyle sessizce değiştirmeyiz.
  Excel’e dışa aktarılan `PLAYER_ID`, kaynak sağlayıcı ID’si değil `Player.id`’dir.

### PLAYER_ID için hassasiyet güvenliği

Güvenli pozitif sayısal hücreler string kimliğe çevrilir; metin kimlikler aynen
saklanır. Ayrıntılı normalizasyon, sınır ve geriye dönük uyumluluk kuralları
[Aşama 11 kimlik sözleşmesi](#aşama-11-kimlik-sözleşmesi) bölümündedir.
Geçersiz ID satır numarasıyla kimlik hatası olarak önizlenir. Hata yeni oyuncu
veya eşleştirme kararıyla atlatılamaz; kaynak düzeltilmeli veya satır açıkça
atlanmalıdır. Mevcut draft oyuncuları ve sahiplik kayıtları korunur.

## Yeniden yükleme ve domain uyumluluğu

Her başarılı yükleme yeni `ProjectionDataset` oluşturur. Kaynak dosya adı,
`source.kind` (`excel`, `csv`, `json`), sezon, birim, şema ve aktarım zamanı ayrı
saklanır. Aktif veri seti yalnızca `league.activeDatasetId` ile belirlenir.
Pozisyon uygunluğu yeni veri seti ve sezon kapsamında saklanır.

Yeni dosyada olmayan seçilmiş oyuncunun kimliği ve seçimi kalır; yeni veri
setinde projeksiyon kaydı olmaz. Yeni satırı hatalı olan seçilmiş oyuncunun
seçimi kalır; yalnızca yeni projeksiyonu `excluded` olur. Önizleme her iki durumu
ve aktif havuzdan çıkacak seçilmemiş oyuncuları gösterir. Aktif veri setinde
projeksiyonu olmayan seçilmiş oyuncular uygulama sonrasında da listelenir.

Oyuncular ve geçmiş veri setleri silinmez. Aktif havuz, yeni veri setindeki
projeksiyon kimliklerinden oluşur; tüm `workspace.players` geçmiş kimlikleri de
içerir. Dışa aktarım aktif havuzla birlikte aktif projeksiyonu eksik seçilmiş
oyuncuları da içerir; hatalı/eksik projeksiyonun istatistik hücreleri boş kalır.
Eski veri setinden sayı doldurulmaz.

Saf `applyImport`, eski snapshot ve revizyonu denetler, oyuncu/projeksiyon/uygunluk
koleksiyonlarını birlikte oluşturur ve `validateWorkspace` çalıştırır. Ancak
başarılı sonuç `WorkspaceStore.accept()` ile uygulanır. `DraftSession` nesnesi,
tüm sıralı `DraftPick` kayıtları, sıra, takım sahipliği, `selectionIndex`,
`outOfTurnConfirmed`, durum, stratejiler ve kullanıcı takımı aynen korunur.

Snapshot şema sürümü `1` kalır. Tek domain genişletmesi `source.kind` alanına
`csv` eklenmesidir; CSV kaynağını JSON/Excel olarak yanlış etiketlememek için
gereklidir. Önceki tüm geçerli v1 JSON yedekleri ve v3 geçişi desteklenir. Yeni
CSV veri setli yedekleri eski uygulama sürümüne yüklemek desteklenmez; güncel
sürüm bu yedekleri doğrular ve tüm veri setleriyle geri yükler.

## Bağımlılıklar ve doğrulama

`fflate` 0.8.3 ZIP sıkıştırma/açmayı, `fast-xml-parser` 5.11.2 OOXML XML okuma ve
yapısal doğrulamayı sağlar. İkisi de MIT lisanslıdır; tarayıcıda çalışır. Formül
motoru veya makro çalıştırma bağımlılığı getirmezler. Kısıtlı tablo sözleşmesi
`infrastructure/projections/workbook.ts` içinde uygulanır; ortak iş kuralları
`application/projectionRows.ts` ve `application/importPlayers.ts` içindedir.
20 Ekim 2026 `npm audit` sonucu bilinen güvenlik açığı sayısı sıfırdır.

`tests/fixtures/import/openpyxl.xlsx`, openpyxl 3.1.5 ile bağımsız üretilmiş
sentetik uyumluluk dosyasıdır. Gerçek lig/oyuncu verisi içermez. Unicode/XML
metni, seyrek hücreler, farklı ilişki yolları ve formül hücresi içerir.

```sh
npm run test:import
CHROMIUM_PATH=/usr/bin/chromium npm run test:ui
CHROMIUM_PATH=/usr/bin/chromium npm test
npm run build
```

Yeni testler saf domain/engine fonksiyonlarını mock etmez. İlk/orta/son tur ve
130 seçimlik tamamlanmış draftlar; eksik ve hatalı seçilmiş oyuncularla birebir
karşılaştırılır. Gerçek React/Chromium testleri yükleme, kimlik kararları, önizleme,
uygulama, tekrar yükleme, kayıt hatasından JSON kurtarma ve 280/375/1280 px
yerleşimlerini denetler. Ekran görüntüleri `artifacts/ui/projections-*.png` altında
üretilir. Golden-master kaynakları, 26 legacy testi ve sabit çıktılar değiştirilmez.

## Aşama 11 kimlik sözleşmesi

- Excel sayısal hücreleri ve JSON sayıları yalnızca güvenli pozitif tam sayıysa
  kabul edilir: `1 ≤ PLAYER_ID ≤ Number.MAX_SAFE_INTEGER`. Kesir, sıfır, negatif,
  formül, boolean ve güvenli sınırı aşan sayı kimlik hatasıdır; satır açıkça
  atlanmadan uygulanamaz. Kaynakta kesir olup Number’a dönüşürken tam sayıya
  yuvarlanan değerler de XML/JSON kaynak metninden kontrol edilip reddedilir.
- Sayısal `1` ve metin `"1"` aynı string kimliğe dönüşür. Metin kimlikler opaktır;
  basamaklar, baştaki sıfırlar ve eski boşluklar aynen korunur. `"001"`, `"1"` ve
  `" 001 "` ayrı kimliklerdir. Büyük metin ID’leri Number’a çevrilmez.
- Şablonun PLAYER_ID sütunu Metin biçimindedir. Excel’de sayısal girilmiş güvenli
  hücreler de okunur; Excel’in dosyayı kaydetmeden önce yaptığı bir yuvarlama
  geri alınamaz. Uzun kimliklerde hücre biçimini veri girişinden önce Metin yapın.
- Benzersiz ID mevcut `Player.id` veya tekil `providerIds.projectionFile` kaydıyla
  eşleşirse ad farklı olsa da aynı oyuncudur. Önizleme dosyadaki adı ve korunacak
  kalıcı görünen adı açıkça gösterir. Kalıcı ad otomatik değiştirilmez.
- Aynı dosyada mükerrer ID’ler (sayısal `1` + metin `"1"` dahil) açık satır kararı
  gerektirir; aynı oyuncuya iki satır bağlanamaz. Bir ID birden fazla kalıcı
  oyuncuya işaret ederse otomatik eşleşmez. Legacy sağlayıcı kimliği tek başına
  yeni `projectionFile` kimliği sayılmaz; açık eşleştirme gerekir.
- Farklı ID’ler benzer isimlerle birleştirilmez. Aynı isim mevcutsa açık seçim
  istenir; ayrı yeni oyuncu seçimi bağımsız kalıcı kimlik üretir.
- İçe aktarma eski UUID’leri değiştirmez. Havuz dışa aktarımı mevcut `Player.id`
  değerini string yazar; satır sırasından yeni sayısal ID üretilmez. Yeni sayısal
  ID ile oluşturulmuş oyuncu yine aynı sayısal metni dışa verir. Tarihsel veri
  setleri, draft seçimleri ve takım sahipliği reimport sırasında aynen korunur.
