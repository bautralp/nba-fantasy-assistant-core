# Domain — Aşama 3

Ortak TypeScript modelleri ve saf iş kuralları. React, DOM, Node API'leri veya
localStorage bağımlılığı yoktur. `tsconfig.domain.json`, yalnızca ES2022 kitaplığı
ile bu sınırı ayrıca kontrol eder.

- `Player.id`, çağıran katmanın verdiği kalıcı kimliktir; ad, sağlayıcı kimliği,
  satır sırası veya projeksiyondan türetilmez. Aynı adlı oyuncular farklı ID taşır.
- `ProjectionDataset`, sezon/dönem, kaynak, zaman, veri birimi ve şema bilgisini;
  `PlayerProjection`, oyuncu/veri seti çifti için istatistikleri taşır. FG% ve FT%
  saklanmaz. Analiz dışında kalan projeksiyonlar nedenleriyle temsil edilir;
  oyuncu kimliği ve kadro üyeliği korunur. Excel/API/JSON okuma burada yapılmaz.
- `PositionEligibility`, lig veya veri seti ile sezon bağlamına aittir. Aynı oyuncu
  farklı bağlamlarda farklı pozisyonlara uygun olabilir. Boş liste bilinmiyor
  anlamındadır. `G` yalnızca genel guard, `F` yalnızca genel forward tokenıdır;
  PG/SG veya SF/PF olarak genişletilmez. v3.3 `eligible` fonksiyonunda PG/SG,
  G slotuna; SF/PF, F slotuna uygundur. Ters yönde uygunluk varsayılmaz
  (`tests/legacy/v3.3.html:334–339`). `RosterEntry.preferredSlot`, kesin yerleşim değildir.
- `Team.id` kimliktir; `DraftSession.draftOrder`, ilk turdaki takım ID sırasıdır.
  Seçim dizisi kronolojiktir; ayrı bir seçim sayacı yoktur. Snake sırası sıfırdan
  başlayan indeksle hesaplanır; 130 seçimden sonra sıradaki takım `null` olur.
  `DraftPick.selectionIndex`, atama anındaki seçim sayısını tutar. Düzenlenmemiş
  eski domain kayıtlarında alan yoksa dizideki indeks esas alınır. `removeDraftPick`,
  silmeden önce eksik tarihsel indeksleri kaydeder; sahiplik ve gerçek onay bilgisi
  değişmez. İndeksler silmeden sonra monoton veya benzersiz olmak zorunda değildir:
  yeni seçim kalan seçim sayısında yapılır. Sonraki takım hesabı her zaman güncel
  seçim sayısını kullanır; tarihsel indeks yalnızca geçmiş atamayı doğrular.
  `appendDraftPick` bu anlık indeksi kendisi kaydeder ve yeni sıra dışı atamada
  `outOfTurnConfirmed: true` ister. Silme işlemi bu onayı üretmez; önceden onaysız
  olan bir atama silmeden sonra da geçersizdir. Tarihsel indekslerin tamamı
  0–129 aralığında tam sayı olmalıdır. Draftta seçim varken `changeDraftOrder`
  sıralamayı değiştirmez ve hata verir.
- Draft oturumu varken kadro yalnızca seçimlerden türetilir. `rosterEntries` boş
  kalır. Oturum olmadan aynı üyelik modeli bağımsız kadroyu temsil eder. Tamamlanan
  draftın kadroya devri ve kullanıcı işlem akışları sonraki uygulama katmanının
  sorumluluğudur; iki bağımsız atama kaynağı tutulmaz.
- `WorkspaceSnapshot`, tek lig çalışma alanının sürümlü, JSON ile taşınabilir iş
  verisidir. Hesaplanmış skor, öneri veya arayüz durumu içermez. Depolama adaptörü
  veya sürüm göçü bu aşamada yoktur.

`rules/leagueRules.ts`, ilk sürümün 10 takım, 13 oyuncu, snake ve 9-cat sınırlarını
merkezileştirir. Toplam seçim bu değerlerden türetilir. Model şekli gelecekteki
ayar değişikliklerine uygundur; doğrulama bu sürümde alternatif kuralları reddeder.
Dokuz kategorinin hedefleri `unset | top1 | top3 | top5 | top7 | punt` birleşimidir.
`createInitialWorkspace` boş isimler/havuz/seçimler ve her takım için `unset`
hedeflerle başlar. Kimlik üretimi, saat veya kişisel örnek veri içermez.

`validateWorkspace` tipli domain verisindeki referansları, mükerrer kimlikleri,
projeksiyon değerlerini, uygunluk bağlamlarını, hedefleri, draft durumunu/sırasını,
mükerrer oyuncu atamasını ve takım kapasitesini kontrol eder. Girdiyi değiştirmez;
kararlı hata kodu ve alan yolu döndürür. Ham/bozuk JSON için bir şema ayrıştırıcısı
değildir: ileride kaynak adaptörleri önce bilinmeyen girdiyi ayrıştırmalıdır.

Kontroller:

```sh
npm run typecheck
npm run test:domain
CHROMIUM_PATH=/usr/bin/chromium npm test
npm run build
```

Domain testleri Node'un yerleşik test çalıştırıcısı ve TypeScript tip silme
özelliğiyle çalışır; yeni test bağımlılığı yoktur. `npm test` ayrıca mevcut 26
regresyon testini çalıştırır. Sabit v3.3 HTML ve beklenen çıktılar değiştirilmez.
