# NBA Fantasy Assistant — Mimari Analiz ve Geliştirme Yol Haritası

> **Durum: Onaylanmış mimari plan.**
> Bu mimari plan kullanıcı tarafından 20 Ekim 2026 tarihinde onaylanmıştır. Bu güncelleme yalnızca dokümanın onay durumunu kaydeder; uygulama geliştirmesini başlatmaz.

- Tarih: 20 Ekim 2026
- Repository: [bautralp/nba-fantasy-assistant](https://github.com/bautralp/nba-fantasy-assistant)
- İncelenen sürüm: v3.3
- İnceleme referansı: `0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5`
- Yöntem: Statik kod incelemesi. Uygulama çalıştırılmamış ve test edilmemiştir.
- Kapsam: Önceki mimari analizin ve geliştirme yol haritasının tamamının dokümantasyona aktarılması. Bu değişiklik uygulama kodunu veya `index.html` dosyasını değiştirmez.

Öneri, önce mevcut hesaplama sonuçlarını testlerle sabitlemek, ardından hesaplama motorunu bağımsızlaştırmak ve yeni arayüzü bu motorun üzerine kurmaktır. İlk sürümün kapsamını **10 takım, 13 oyunculuk kadro, snake draft ve 9 kategori** olarak koruyup bu değerleri merkezi lig kurallarına taşımak uygun olur.

Bu kapsam ilk sürümde sabittir; farklı takım sayıları, kadro kapasiteleri, draft biçimleri veya kategori setleri ilk sürüme eklenmeyecektir. Değerler gelecekte yapılandırılabilir olacak şekilde `domain/rules/leagueRules.ts` içinde ortak lig kuralları olarak tutulmalı; toplam seçim sayısı takım sayısı × kadro kapasitesinden türetilmelidir. Yeni lig kurulumunda tüm takım adı alanları boş başlamalı; örnek takım adları veya otomatik doldurulmuş isimler bulunmamalıdır.

## 1. Mevcut mimari ve teknik riskler

Uygulama yaklaşık 69 KB’lık tek `index.html` içinde HTML, üst üste eklenmiş CSS sürümleri, veri okuma, hesaplama, kayıt ve DOM güncellemesini birlikte barındırıyor.

| Alan | Mevcut yapı | Risk / geçiş kararı |
|---|---|---|
| Uygulama durumu | Global `state`; oyuncular, takım isimleri, seçimler ve hedefler birlikte | Değişikliklerin etkisini izlemek zor. İşlemler merkezi ve tip güvenli komutlara taşınmalı. |
| Hesaplama | `calculateModel`, `teamsScores`, `balancePlan`, `suggestions` global durumu okuyor | Motoru UI olmadan sınamak güç. Girdileri parametre alan saf fonksiyonlara ayrılmalı. |
| Görünüm | `innerHTML`, global olay dinleyicileri, geniş kapsamlı `render()` | Hesaplama ve yeniden çizim birbirine bağlı. React bileşenleri ve türetilmiş seçiciler kullanılmalı. |
| Kalıcılık | Tek `localStorage` anahtarında tüm durum | Şema geçişi ve hata kurtarma mekanizması sınırlı. Sürümlü kayıt katmanı gerekli. |
| Oyuncu kimliği | Normalize edilmiş oyuncu adı | Aynı ada sahip oyuncular çakışabilir; isim değişikliği draft eşleşmesini bozabilir. Kalıcı ID gerekli. |
| Takım kimliği | Dizideki sıra numarası | Takım kimliği ile draft sırası birbirine bağlı. `teamId` ve `draftOrder` ayrılmalı. |
| Lig kuralları | `10`, `13`, `130` farklı fonksiyonlarda sabit | Yeni modüllerde yanlış varsayımların yayılma riski var. Tek bir kural modeli kullanılmalı. |
| Veri yükleme | CSV/JSON; `.xlsx` desteği yok | Excel için ayrı bir okuma adaptörü ve ortak doğrulama hattı gerekli. |
| Yedek doğrulama | Üst düzey alanlar kontrol ediliyor | Geçersiz oyuncu referansı, mükerrer seçim, kapasite aşımı ve bozuk iç alanlar geçebilir. |
| Stil | v3.1–v3.3 CSS kuralları birbirini eziyor | Görünüm değişiklikleri beklenmedik sonuç üretebilir. Tasarım değişkenleri ve bileşen stilleri ayrılmalı. |

İki önemli davranış farkı ayrıca kayda alınmalı:

- `rankTeams()` eşit puanları aynı sıraya yerleştiriyor; Power Rankings görünümü ise kendi sıralamasında `1, 2, 3…` numaralandırıyor. Yeni görünümde ortak sıralama çıktısını kullanmak öneriliyor; bu, mevcut tutarsızlığın bilinçli düzeltmesi olarak belgelenmeli.
- “Son seçimi geri al”, son eklenen draft seçimini kaldırıyor. Takım değiştirme veya seçim silme gibi tüm işlemleri geri alan genel bir geçmiş sistemi değil. İlk sürümde mevcut anlam korunmalı.

Kaynak: [durum, veri okuma ve hesaplama fonksiyonları](https://github.com/bautralp/nba-fantasy-assistant/blob/0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5/index.html#L157), [draft işlemleri ve pozisyon yerleşimi](https://github.com/bautralp/nba-fantasy-assistant/blob/0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5/index.html#L331).

## 2. Önerilen mimari ve ortak veri modelleri

Bağımlılık yönü şöyle olmalı:

```text
React arayüzü
      ↓
Uygulama işlemleri ve durum yönetimi
      ↓
Ortak veri modelleri + saf hesaplama motoru

Excel / JSON / localStorage adaptörleri
      ↓
Doğrulanmış ortak veri modelleri
```

Hesaplama motoru React, DOM, dosya formatı veya `localStorage` hakkında bilgi taşımamalı. Aynı kadroyu ve projeksiyonu Draft, Waiver ve Trade modülleri hesaplatabilmeli.

| Model | Temel alanlar ve sorumluluk |
|---|---|
| `Player` | Kalıcı `id`, ad, isteğe bağlı sağlayıcı kimlikleri. Projeksiyon istatistikleri burada tutulmaz. |
| `ProjectionDataset` | Sezon/dönem, kaynak, içe aktarma zamanı, veri birimi, şema sürümü |
| `PlayerProjection` | `playerId`, `datasetId`, GP ve istatistikler; aynı oyuncunun farklı dönem projeksiyonlarını destekler |
| `League` | ID, kullanıcı adı, sezon, kategori kuralları, kadro slotları, aktif veri seti |
| `Team` | ID, `leagueId`, kullanıcı tarafından girilen ad |
| `Roster` / `RosterEntry` | Takımın oyuncu üyelikleri; pozisyon uygunluğu ve isteğe bağlı slot tercihi |
| `Strategy` | `leagueId`, `teamId`, kategori hedefleri; başlangıçta tümü `unset` |
| `DraftSession` / `DraftPick` | Takım ID’lerinden oluşan draft sırası, sıralı seçimler, draft durumu |
| `WorkspaceSnapshot` | Şema sürümü ve yedeklenmesi gereken tüm iş verileri |

Pozisyon uygunluğunu yalnızca oyuncunun evrensel bir özelliği olarak kabul etmemek gerekir: ileride sağlayıcıya, sezona veya lige göre değişebilir. İlk sürümde Excel’deki `POS`, aktif lig/dönem için uygunluk kaydı oluşturur.

Draft sırasında kadrolar seçimlerden türetilmeli; aynı oyuncu ataması iki farklı yerde bağımsız güncellenmemeli. Draft tamamlandığında ortak kadro modeli üzerinden Waiver ve Trade çalışmalarına temel oluşturulabilir. Gelecekteki olası transfer senaryoları gerçek kadroyu değiştirmeden ayrı girdilerle hesaplanmalı.

İlk sürüm için merkezi reducer ve Context yeterli bir başlangıçtır. Modal açık/kapalı durumu, arama ve sıralama gibi geçici arayüz durumları iş verisinden ayrı tutulmalı. Hesaplanan puanlar yedeğe yazılmamalı; yüklenen veriden yeniden üretilmeli.

Veri saklama, `application/ports.ts` içindeki `WorkspaceRepository` sözleşmesi üzerinden yapılmalı. Yükleme ve kaydetme işlemleri baştan asenkron bir sözleşmeyle tanımlanmalı; React bileşenleri ve hesaplama motoru doğrudan `localStorage` çağırmamalıdır. İlk uygulama `localStorageRepository.ts` olabilir. Gelecekte aynı sözleşmeyi uygulayan bir IndexedDB adaptörüne geçiş, iş kurallarını ve arayüzü değiştirmemelidir. IndexedDB uygulaması ilk sürümün kapsamına dahil değildir.

Önerilen klasör ağacı:

```text
src/
  app/
    App.tsx
    AppProvider.tsx
    workspaceReducer.ts
    selectors.ts

  domain/
    models/
      player.ts
      projection.ts
      league.ts
      team.ts
      roster.ts
      strategy.ts
      draft.ts
    rules/
      leagueRules.ts
      invariants.ts

  engine/
    projections.ts
    referencePool.ts
    categoryScores.ts
    teamScores.ts
    rankings.ts
    categoryBalance.ts
    recommendations.ts
    opponentAnalysis.ts
    lineupMatching.ts
    modelConfig.ts

  application/
    draftCommands.ts
    importPlayers.ts
    restoreBackup.ts
    ports.ts

  infrastructure/
    excel/
      readWorkbook.ts
      createTemplate.ts
    import/
      validateRows.ts
      normalizeRows.ts
      legacyCsvJson.ts
    persistence/
      localStorageRepository.ts
      backupSchema.ts
      migrateV3.ts

  features/
    league/
      LeagueSetup.tsx
      LeagueSettingsDialog.tsx
    draft/
      DraftWorkspace.tsx
      DraftStatusBar.tsx
      PlayerPoolTable.tsx
      PlayerAssignmentDialog.tsx
      RecommendationsPanel.tsx
    analysis/
      CategoryPowerRankings.tsx
      CategoryBalanceSummary.tsx
      OpponentAnalysis.tsx
    strategy/
      StrategyDialog.tsx
    rosters/
      RosterOverview.tsx
      TeamRoster.tsx
    data/
      PlayerImportDialog.tsx
      ImportPreview.tsx
      BackupControls.tsx

  shared/
    ui/
    formatting/
  styles/

tests/
  fixtures/
  legacy/
  parity/
  integration/
  e2e/
```

Waiver ve Trade için şimdiden boş ekranlar veya kullanılmayan servisler eklemek yerine ortak modelleri ve hesaplama sınırlarını hazırlamak yeterli.

## 3. Korunması gereken iş kuralları

Bunlar geçişin hesaplama sözleşmesi olmalı.

| Konu | v3.3 davranışı |
|---|---|
| Kategoriler | FG%, FT%, 3PM, PTS, REB, AST, STL, BLK, TO |
| Maç başına veri | GP hariç istatistikler GP ile çarpılarak sezon toplamına çevrilir |
| FG% / FT% katkısı | Yüzdelerin basit ortalaması kullanılmaz; hacim etkisi `FGM − bazFG × FGA` ve `FTM − bazFT × FTA` ile hesaplanır |
| Top kaybı | Düşük TO avantajlıdır; ham katkıda işaret ters çevrilir |
| Referans havuzu | Önce tüm geçerli oyuncular puanlanır; toplam ilk Z-score’a göre en fazla 130 oyuncu seçilir; bazlar ve Z-score’lar yeniden hesaplanır |
| Standart sapma | Örneklem standart sapması kullanılır; tek gözlem veya sıfır sapmada bölen 1 olur |
| Sıfır atış hacmi | Referans FG ve FT bazları gerektiğinde sırasıyla `0.47` ve `0.78` olur |
| Takım kategori puanı | `13 × toplamZ / (geçerliOyuncuSayısı + 4)`; geçerli oyuncusu olmayan takımın puanı `null` |
| Sıralama | Yüksek puan önde; `1e-10` altındaki farklar mevcut eşitlik kuralına tabidir |
| Kategori hedefleri | `unset`, `top1`, `top3`, `top5`, `top7`, `punt` |
| Öneri kapsamı | Seçilmemiş, geçerli projeksiyonu olan oyuncular; kendi takımının ihtiyaçlarına göre ilk 5 |
| Öneri sıralaması | Dinamik kategori ağırlıkları × oyuncu Z-score’ları + pozisyon bonusu; eşitlikte RANK |
| Pozisyon bonusu | Doldurulabilen ilave zorunlu slot başına `0.55` |
| Draft | 10 takım, 13 tur, toplam 130 seçim; snake sıra |
| Kapasite | Bir oyuncu tek takıma atanabilir; takım başına en fazla 13 oyuncu |
| Sıra dışı seçim | Kullanıcı açıkça onaylarsa mümkün |
| Seçim kaldırma | Sonraki sıra hesabı mevcut seçim sayısına göre kayar |
| Draft sırası değişikliği | Draft başladıktan sonra engellenir |

Kategori hedef temposu `top1=.72`, `top3=.43`, `top5=.19`, `top7=-.04`; hedef katsayıları `1.12`, `1.07`, `1.03`, `.91`. Öncelik hesabındaki kalan seçim, tempo açığı, sınırlandırmalar ve rakip düzeltmeleri aynen taşınmalı. **Bunlar şampiyonluk olasılığı değil, sezgisel öneri parametreleri.**

**Power Rankings yorumlama kuralı:** Bu alan, seçilmiş oyuncuların projeksiyonları ve tamamlanmamış kadrolar üzerinden yapılan **geçici kategori güç değerlendirmesidir**. Kesin sezon sonu sıralaması, maç kazanma veya kategori galibiyet olasılığı değildir. Her seçimle değişir; kadro büyüklüğünü normalize etmek bu belirsizliği ortadan kaldırmaz. Bu açıklama arayüzde alanın yanında görünür olmalı; puanlar olasılık yüzdesi olarak sunulmamalıdır.

Rakip analizinde önde olanlar veya puan farkı mutlak olarak `0.65` altında olanlar dikkate alınıyor. Güven etiketi, iki takımın geçerli oyuncu sayısının küçüğü 3’ten azsa “Düşük”, diğer durumda “Orta”.

Pozisyon yerleşimi:

```text
PG, SG, SF, PF, C, G, F, UTIL, UTIL, UTIL, BENCH, BENCH, BENCH
```

Zorunlu yedi slot deterministik iki parçalı eşleştirmeyle dolduruluyor. Çok pozisyonlu oyuncuların uygun yere kaydırılabilmesi korunmalı. Pozisyonu bilinmeyen oyuncu UTIL/BENCH’e yerleşebilir; zorunlu slot katkısı garanti edilemez.

Kaynak: [hesaplama ve öneri kuralları](https://github.com/bautralp/nba-fantasy-assistant/blob/0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5/index.html#L194).

## 4. Yeni arayüzün bileşen planı

İlk açılışta lig veya takım isimleri önceden doldurulmamalı. Kullanıcı lig adını, 10 takımın adını, kendi takımını ve draft sırasını belirleyerek boş ligi oluşturmalı. Oyuncu havuzu ve seçimler boş başlamalı; yedekten geri yükleme alternatif giriş olmalı.

**Arayüz sınırı:** Daha önce kaldırılan büyük özet kutuları veya KPI kartları geri getirilmeyecek. Ana odak oyuncu havuzu ve beş oyunculuk öneri paneli olarak kalacak. Lig, tur ve sıra bilgileri kompakt bir satırda; kategori ihtiyaç özeti öneri paneli içinde kısa metin/etiketlerle gösterilecek. `DraftStatusBar` ve `CategoryBalanceSummary` büyük özet kutularına dönüşmemeli.

Masaüstü yerleşimi:

```text
Lig / Benim takımım / Tur ve sıra
Strateji · Veri yükle · Yedekle · Geri yükle · Son seçimi geri al

Kategori Power Rankings                         [Daralt]
9 kategori için ilk 5 takım

Oyuncu havuzu                         │ Beş oyunculuk öneri paneli
Arama · Filtre · Sıralama              │ Kategori ihtiyaç özeti
Kompakt istatistik tablosu             │ 1–5 öneri ve gerekçeleri
Sayfalama                             │ Rakip uyarıları

Kadrolar · Ayrıntılı analiz
```

| Bileşen | Beklenen davranış |
|---|---|
| `CategoryPowerRankings` | Varsayılan açık; tek kontrolle daraltılır; boş ligde açık boş durum gösterir; geçici kategori güç değerlendirmesi açıklaması görünürdür |
| `PlayerPoolTable` | Sabit başlık ve oyuncu sütunu; sayısal değerler sağa hizalı; atama sütunu kaldırılır |
| `PlayerAssignmentDialog` | Oyuncuya tıklanınca açılır; istatistik, mevcut takım, takım seçimi, ata/değiştir/kaldır işlemleri |
| `StrategyDialog` | Dokuz kategori hedefi; Kaydet/İptal; kaydetmeden ana stratejiyi değiştirmez |
| `RecommendationsPanel` | Yeterli aday varsa beş öneri; puan, kategori etkileri, pozisyon uyumu ve açılabilir gerekçeler |
| `RosterOverview` | Mevcut sürümdeki gibi kadrolar başlangıçta açık |
| `PlayerImportDialog` | Şablon indirme, yükleme, hata listesi ve uygulanacak değişiklik önizlemesi |
| `BackupControls` | Kayıt durumu ve JSON yedekleme/geri yükleme |

Masaüstünde havuz ve öneriler yan yana kalmalı; tablo yatay kaydırması panel içinde olmalı. Küçük ekranlarda alt alta geçilmeli. Tasarımda 32–36 px tablo satırları, eşit genişlikli rakamlar, sınırlı vurgu renkleri ve kısa etiketler kullanılmalı.

Modal erişilebilirliği de kabul koşulu olmalı: klavyeyle açma, odak yönetimi, Escape ile kapatma ve kapanınca odağın açan öğeye dönmesi.

Arayüz kabul kriterleri: masaüstünde havuz ve öneriler yan yana kalır; büyük özet kutuları bulunmaz; Power Rankings ilk açılışta açıktır ve daraltılabilir; oyuncu atama yalnızca oyuncu modalındaki işlem akışıyla yönetilir; kategori stratejisi ayrı sekme yerine modalda belirlenir; takım kadroları varsayılan açık gelir.

## 5. Excel formatı ve doğrulama yaklaşımı

İndirilebilir dosya `nba-fantasy-projections.xlsx` olmalı. Şablonda gerçek veya örnek oyuncu satırı bulunmamalı.

| Sayfa | İçerik |
|---|---|
| `Players` | Başlıklar ve doldurulacak boş veri alanı |
| `Settings` | Şema sürümü, sezon, veri birimi: `perGame` / `totals` |
| `Instructions` | Alan açıklamaları, birimler ve doğrulama kuralları |

`Players` sütunları:

| Alan | Kural |
|---|---|
| `PLAYER_ID` | İlk yüklemede boş bırakılabilir; varsa benzersiz metin. Sonraki güncellemelerde temel eşleştirme anahtarı |
| `PLAYER` | Zorunlu oyuncu adı |
| `POS` | İsteğe bağlı; örneğin `PG,SG`. Eksikse yerleşim uyarısı |
| `RANK` | İsteğe bağlı pozitif tam sayı |
| `GP` | Zorunlu pozitif sayı |
| `FGM`, `FGA`, `FTM`, `FTA` | Zorunlu, negatif olmayan sayılar |
| `3PM`, `PTS`, `REB`, `AST`, `STL`, `BLK`, `TO` | Zorunlu, negatif olmayan sayılar |

FG% ve FT% kullanıcı girdisi olmamalı; isabet/deneme değerlerinden türetilmeli. Tek dosyada tek istatistik birimi kullanılmalı.

Yükleme sırası:

1. Dosya ve çalışma kitabı yapısını doğrula.
2. Başlıkları eşleştir; aynı alana karşılık gelen mükerrer sütunları bildir.
3. Hücreleri normalize et; boş ile sıfırı ayır.
4. Alan ve satır kurallarını kontrol et.
5. Oyuncu kimliklerini mevcut havuzla eşleştir.
6. Yeni, güncellenen, eksik ve sorunlu kayıtları önizle.
7. Kullanıcı uyguladığında veriyi tek işlemde değiştir.

Temel kontroller: `FGM ≤ FGA`, `FTM ≤ FTA`, negatif/sonlu olmayan değerlerin reddi, geçerli pozisyon kodları ve mükerrer ID kontrolü. Ondalık GP değerleri projeksiyonlarda mümkün olduğundan zorunlu tam sayı yapılmamalı. Belirsiz metin sayı biçimleri sessizce tahmin edilmemeli.

Doğrulama sonuçları aşağıdaki sınıflara ayrılmalı; satır hatası ile dosya düzeyindeki ret birbirine karıştırılmamalıdır:

| Sınıf | Örnekler | Davranış |
|---|---|---|
| Dosyanın tamamen reddi | Okunamayan/bozuk veya şifreli çalışma kitabı; gerekli sayfa ya da zorunlu sütun eksikliği; çelişkili/mükerrer sütun eşleştirmesi; desteklenmeyen şema; eksik veya belirsiz veri birimi; kimliği kullanılabilir hiçbir oyuncu satırı bulunmaması | Yükleme uygulanmaz; mevcut havuz ve draft olduğu gibi korunur. Dosya düzeyindeki hata açıklanır. |
| Satırın analiz dışında tutulması | Kimliği belirli oyuncuda eksik istatistik, geçersiz sayı, negatif değer, GP ≤ 0, FGM > FGA veya FTM > FTA | Oyuncu ve mevcut draft üyeliği korunabilir; ilgili projeksiyon analiz dışı işaretlenir. Bu satır Z-score, takım puanı ve öneri hesabına girmez; diğer geçerli satırlar kullanılabilir. |
| Alan uyarısı | Eksik/geçersiz POS veya isteğe bağlı RANK | POS bilinmiyor olarak işaretlenir, zorunlu slot uygunluğu varsayılmaz; RANK kullanılmaz. İstatistikler geçerliyse kategori analizi devam eder. |
| Kullanıcı çözümü gereken kimlik sorunu | Mükerrer PLAYER_ID, aynı adla birden fazla aday, mevcut oyuncuyla çelişen ID veya oyuncu kimliği belirlenemeyen satır | Otomatik eşleştirme yapılmaz. Sorunlu satırlar ve adaylar kullanıcıya gösterilir; kullanıcı eşleştirene veya sorunlu satırı açıkça dışarıda bırakana kadar yükleme uygulanmaz. |

Formül hücreleri hesaplanmamalı; kullanıcıdan değer olarak yapıştırması istenmeli. İstatistik alanındaki formül satır düzeyinde analiz hatasıdır; veri birimi gibi dosyanın yorumlanmasını belirleyen bir alandaysa dosya düzeyinde ret sebebidir. Hatalı istatistikler sıfıra çevrilmemeli. Tüm projeksiyonlar analiz dışıysa bu durum açıkça gösterilmeli ve analiz/öneriler boş durum sunmalıdır.

ID’siz yeni oyunculara kalıcı ID atanmalı. Yeniden yüklemede otomatik güncelleme yalnızca benzersiz ve çelişkisiz kalıcı ID eşleşmesiyle yapılmalı. Ad eşleştirmesi yalnızca kullanıcıya öneri olarak gösterilmeli ve uygulanmadan önce onaylanmalı; belirsiz ID eşleşmesinde isim benzerliğine veya satır sırasına dayanarak otomatik seçim yapılmamalıdır. Mevcut havuzu ID’lerle Excel’e dışa aktarma, sonraki güncellemeleri güvenilir kılar.

### Excel yeniden yükleme kabul kriterleri

- Başarılı yeniden yüklemede mevcut draft seçimlerinin oyuncu kimliği, takım sahipliği, seçim sırası ve toplam seçim sayısı korunur. Projeksiyon güncellemesi draftı sıfırlamaz veya seçimleri yeniden sıralamaz.
- Yeni dosyada bulunmayan seçilmiş oyuncu silinmez. Kimliği ve draft seçimi korunur; aktif yeni veri setinde projeksiyonu bulunmadığı gösterilir ve analiz dışında tutulur. Önceki projeksiyon yeni veriymiş gibi sessizce kullanılmaz.
- Seçilmiş oyuncunun yeni satırı hatalıysa draft seçimi korunur; yalnızca ilgili projeksiyon analiz dışında tutulur. Dosyada olmayan seçilmemiş oyuncuların havuzdan çıkması gibi değişiklikler de önizlemede gösterilir.
- Belirsiz eşleşmeler kullanıcıya satır, mevcut oyuncu ve aday kimliklerle sunulur. Kullanıcı çözümlemeden veya sorunlu satırı açıkça dışarıda bırakmadan yükleme uygulanmaz; mevcut seçimler otomatik taşınmaz.
- Dosyanın reddi, kullanıcının iptali veya çözülmemiş kimlik sorunu mevcut çalışma alanında kısmi değişiklik bırakmaz. Doğrulama ve eşleştirme tamamlandıktan sonra değişiklikler tek işlemde uygulanır.
- Kabul testi, yükleme öncesi ve sonrası sıralı draft seçimlerini birebir karşılaştırır; bu kontrol yeni dosyada eksik/hatalı seçilmiş oyuncu bulunması durumunda da geçmelidir.

CSV/JSON içe aktarma desteğinin de aynı doğrulama hattına bağlı bir uyumluluk adaptörü olarak korunması öneriliyor.

## 6. Yedekleme ve eski kayıtların taşınması

Yeni yedek formatı sürümlü olmalı; lig, takımlar, oyuncular, projeksiyonlar, strateji ve sıralı draft seçimlerini kapsamalı.

v3 yedek geçişinde:

- Takım indeksleri kalıcı takım ID’lerine çevrilir.
- Eski oyuncu ID’leri yeni kimliklere eşlenir.
- Seçim sırası ve takım sahipliği korunur.
- Mevcut takım adları ve strateji aynen taşınır.
- Geçersiz referanslar ve kapasite ihlalleri raporlanır.
- Doğrulama tamamlanmadan mevcut çalışma alanı değiştirilmez.

“Örnek isim bulunmaması” yeni liglerin başlangıç durumuna uygulanmalı; kullanıcının yüklediği eski yedekteki isimler silinmemeli.

Eski HTML’in çalıştığı adres ile Vercel adresi farklı olacağından geçişi otomatik tarayıcı kaydı aktarımına dayandırmamak gerekir. Güvenilir yol eski uygulamadan JSON yedeği indirip yeni uygulamaya yüklemektir.

### Tarayıcı kaydı, sınırlar ve taşınabilirlik

İlk sürümde `localStorage` kullanılabilir; ancak tarayıcı depolaması sınırlıdır ve kalıcı yedek garantisi vermez. Kota, kullanılabilirlik ve saklama davranışı tarayıcıya ve çalışma koşullarına bağlıdır. Site verilerinin temizlenmesi, farklı tarayıcı/profil veya adres kullanılması kayıtların kaybolmasına ya da erişilememesine yol açabilir. Büyük projeksiyon havuzlarında tüm JSON durumunu senkron yazmak arayüzü de geciktirebilir.

Kayıt adaptörü kota/erişim/serileştirme hatalarını açık sonuç olarak döndürmeli. Başarısız yazmada “kaydedildi” gösterilmemeli; bellekteki çalışma korunmalı, kullanıcıya kaydedilemediği ve JSON yedeği indirmesi gerektiği bildirilmelidir. JSON yedeği, tarayıcı dışına taşınabilir kurtarma kopyasıdır; otomatik tarayıcı kaydının yerine geçmez ve yalnızca hata anında erişilebilir olmamalıdır.

`WorkspaceRepository` sözleşmesi ve ortak sürümlü `WorkspaceSnapshot`, gelecekte IndexedDB adaptörünün aynı kayıtları okuyabilmesini sağlamalıdır. Geçişte eski kaydı okuma → doğrulama/dönüştürme → yeni depoya yazma → yeniden okuyup doğrulama sırası izlenmeli; yeni kayıt doğrulanmadan eski kopya kaldırılmamalıdır. JSON içe/dışa aktarma, depolama teknolojisinden bağımsız kalmalıdır.

## 7. Eski–yeni sonuç karşılaştırma test planı

**Geliştirme ön koşulu:** Yeni motorun geliştirilmesine ve diğer uygulama aşamalarına geçmeden önce, referans commit’teki gerçek v3.3 hesaplama kodu çalıştırılarak sabit test girdileri ve bunlara karşılık gelen beklenen sonuçlar üretilmeli, doğrulanmalı ve sürüm kontrolüne alınmalıdır. Bu doküman güncellemesi test üretimi veya geliştirme başlangıcı değildir; aşağıdaki hazırlık geliştirme onayı sonrasında yapılacaktır.

1. Referans `index.html` ve hesaplama kodu `0e28afb9d0c2fff0e6fa9e25d90651fab7fa4ed5` commit’ine sabitlenir. Test düzeneği eski kodu yeniden yazmak yerine değişmemiş gerçek fonksiyonlarını çalıştırır; gerekli DOM/tarayıcı bağımlılıkları yalnızca çalıştırma adaptöründe karşılanır.
2. v3.3’ün gerçek girdi biçimine uygun oyuncular, veri birimleri, takımlar, sıralı seçimler ve kategori hedefleri sabit fixture dosyaları olarak hazırlanır. Rastgele senaryo gerekiyorsa seed sabitlenir ve oluşan girdi de saklanır.
3. Beklenen referans havuzu, bazlar, Z-score’lar, takım puanları/sıraları, kategori öncelikleri, öneriler, rakip analizi ve pozisyon yerleşimleri yalnızca bu eski kod çalıştırılarak üretilir. Girdi ve beklenen çıktı çiftleri `tests/fixtures/` altında; çalıştırma düzeneği `tests/legacy/` altında tutulur.
4. Kaynak commit/blob kimliği, çalıştırma yöntemi ve ortamı, senaryo açıklaması ve üretim komutu kaydedilir. Aynı girdilerle tekrar çalıştırmanın aynı çıktıları verdiği doğrulanır.
5. Bu referans seti tamamlanmadan 2–10. geliştirme aşamalarına geçilmez. Yeni motorun kendi sonuçları hiçbir zaman referans kabul edilmez; test sırasında beklenen çıktılar yeni motorla yeniden üretilmez veya başarısız testi geçirmek için otomatik güncellenmez.

Bilinçli davranış değişiklikleri eski referans çıktısını değiştirmeden ayrı test beklentileri ve değişiklik gerekçeleriyle belgelenmelidir.

| Test grubu | Karşılaştırılacak sonuç |
|---|---|
| Projeksiyon dönüşümü | Aynı verinin maç başına ve toplam biçimlerinde eşdeğer sonuç vermesi |
| Referans havuzu | Seçilen oyuncu ID’leri, baz yüzdeler, ortalamalar, standart sapmalar |
| Oyuncu değerleri | Her oyuncunun dokuz kategori Z-score’u |
| Takım analizi | Toplamlar, geçerli oyuncu sayısı, kategori puanları ve sıralar |
| Strateji | Tempo açığı, öncelik, durum etiketleri ve draft evreleri |
| Öneriler | İlk beş oyuncu ve sırası, toplam puan, katkılar, önce/sonra sıraları |
| Rakip analizi | Rakipler, farklar, güven etiketleri ve sıralama |
| Pozisyonlar | Yerleşimler, dolan zorunlu slot sayısı ve bonus |
| Draft işlemleri | Atama, taşıma, kaldırma, geri alma ve snake sıra |
| Yedek | Eski yedeği yükleme ve yeni yedeği kaydedip geri açma eşdeğerliği |
| Excel yeniden yükleme | Geçerli ID güncellemesinde ve eksik/hatalı seçilmiş oyuncuda seçim kimliği, takım sahipliği, sıra ve sayının korunması; belirsiz ID’de otomatik eşleştirme yapılmaması |
| Yükleme hata sınıfları | Dosya düzeyindeki ret ve iptalde durumun değişmemesi; satır hatalarının yalnızca ilgili projeksiyonu analiz dışında bırakması |
| Depolama sözleşmesi | Kota/erişim hatasının görünür olması, yanlış başarı bildirimi verilmemesi ve JSON yedeğin bellekteki çalışmadan üretilebilmesi |

Senaryolar; boş havuz, tek oyuncu, 130’dan az/fazla oyuncu, eşit puanlar, sıfır varyans, sıfır FGA/FTA, eksik POS, çok pozisyonlu oyuncular, geçersiz projeksiyonlar, dolu takım, son seçim ve tüm kategorilerin `unset`/`punt` olması durumlarını kapsamalı.

Sayısal değerlerde başlangıç toleransı `1e-9` mutlak/bağıl hata olabilir. Oyuncu seçimi ve sıralamalar birebir karşılaştırılmalı; özellikle mevcut eşitlik eşikleri çevresindeki örnekler ayrıca test edilmeli.

Arayüz testleri de şu akışları doğrulamalı: boş lig oluşturma → Excel yükleme → strateji kaydetme → modal üzerinden seçim → yeniden hesaplama → sayfayı yenileme → yedek indirip geri yükleme.

Ayrıca boş takım adı alanları, büyük özet kutularının bulunmaması, masaüstünde havuz/öneri birlikteliği, Power Rankings'in varsayılan açık ve daraltılabilir olması, geçici değerlendirme açıklaması, modal atama/strateji akışları ve varsayılan açık kadrolar doğrulanmalıdır.

Power Rankings eşitlik düzeltmesi ve daha sıkı veri doğrulaması gibi bilinçli değişiklikler ayrı beklentilerle sınanmalı; hesaplama regresyonu olarak gizlenmemeli.

## 8. Küçük aşamalara bölünmüş uygulama planı

Aşamalar bağımlılık sırasındadır; her biri ayrı incelenebilir değişiklik olmalı.

| Aşama | Çıktı | Tamamlanma ölçütü |
|---|---|---|
| 1. Davranışı sabitle — geliştirme ön koşulu | Gerçek v3.3 kodundan üretilmiş sabit girdi/beklenen çıktı çiftleri ve tekrar üretim düzeneği | Referans seti sürüm kontrolünde; eski kodla tekrar üretim doğrulanmış; tamamlanmadan 2–10. aşamalara geçilmez |
| 2. Proje iskeleti | React + TypeScript + Vite, tip kontrolü, test ve build komutları | Temiz kurulum ve üretim build’i başarılı |
| 3. Ortak modeller | Kimlikler, ortak lig kuralları, projeksiyon ve kadro modelleri | Model/veri bütünlüğü testleri başarılı; ilk sürüm 10 takım, 13 oyuncu, snake, 9-cat; gelecekte yapılandırılabilir kurallar tek yerde |
| 4. Hesaplama motoru | Saf TypeScript hesaplama fonksiyonları | Eski–yeni karşılaştırma testleri başarılı |
| 5. Kayıt ve geçiş | IndexedDB'ye geçirilebilir kayıt sözleşmesi, localStorage adaptörü, sürümlü JSON yedek, v3 dönüştürücü | Eski draft yeniden açılıyor; veri kaybı yok; kayıt sınırı/hatası görünür ve JSON kurtarma akışı çalışıyor |
| 6. Boş lig kurulumu | Kullanıcı isimleri, takım seçimi ve sıra | Varsayılan lig/takım adı yok |
| 7. Excel hattı | Boş şablon, hata sınıfları, önizleme ve kimlik eşleştirme | Yeniden yüklemede mevcut draft seçimleri korunuyor; belirsiz ID otomatik eşleşmiyor; dosya reddi ve satırın analiz dışı kalması ayrı doğrulanıyor |
| 8. Draft çalışma alanı | Kompakt tablo, atama modalı, beşli öneri paneli | Büyük özet kutuları yok; masaüstünde yan yana düzen ve modal draft akışları çalışıyor |
| 9. Strateji ve analiz | Strateji modalı, varsayılan açık/daraltılabilir Power Rankings, açık kadrolar ve rakip analizi | Tüm v3.3 analiz özellikleri erişilebilir; Power Rankings geçici değerlendirme olarak sunuluyor |
| 10. Yayına hazırlık | Uçtan uca testler, erişilebilirlik, performans ve Vercel ayarları | Üretim build’i ve önizleme doğrulaması başarılı |

Vercel için statik Vite çıktısı yeterli: build komutu `npm run build`, çıktı dizini `dist`. İlk sürümde veritabanı, hesap sistemi veya API gerekmiyor. Vite’ın bu dağıtım biçimi ve Vercel desteği resmi belgelerde mevcut. [Vite dağıtım rehberi](https://vite.dev/guide/static-deploy.html), [Vercel Vite desteği](https://vercel.com/docs/frameworks/frontend/vite).

**Onay durumu:** Bu mimari plan kullanıcı tarafından onaylanmıştır. Teknik içerik, iş kuralları, geliştirme ön koşulları ve aşamalar korunmuştur. Bu güncelleme yalnızca dokümantasyon kapsamındadır; uygulama kodu değişikliği veya yayına alma işlemi içermez.


### Aşama 9 uygulama notu

PR #9 sonrası `3c22431` tabanından eklenen React analiz görünümleri, yukarıdaki
motor sözleşmelerini doğrudan kullanır. `selectDraftAnalysis()` saf sunum
selector’üdür; türetilmiş sonuçlar kalıcı modele eklenmez. Power Rankings’in
eski bağımsız numaralandırması yerine `rankTeams()` kullanılması bilinçli
görünüm farkıdır; golden-master veya motor algoritması değişikliği değildir.
Kadro slotları `matchLineup()` sonucudur; yerleşemeyen oyuncular ayrıca
görünür tutulur. [Uygulama ve doğrulama ayrıntıları](stage-9-analysis.md).
Dağıtım mevcut Netlify hattını kullanır; bu aşama hosting yapılandırmasını
değiştirmez.


### Aşama 10 uygulama notu

PR #10 sonrası `acf44ca` tabanında tek açık tema, kontrast tokenları,
`beforeunload` ve ham kayıt bazına dayalı iyimser çakışma koruması eklenir.
WorkspaceSnapshot/JSON şeması, saf motor, legacy referanslar ve golden-master
korunur. localStorage CAS sunmadığı için tam eşzamanlılık garantisi verilmez;
çakışma kullanıcı kararı olmadan bellek yenilemez. Dosya önizlemesinde gereksiz
DOM üretimi ve tablo sıralama tekrarları azaltılır. GitHub Actions bağımsız test
hattıdır. Hosting **Netlify** olarak kalır; plandaki eski Vercel ifadeleri güncel
dağıtım kararı değildir. [Ayrıntılar ve doğrulama](stage-10-hardening.md).
