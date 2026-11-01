# Aşama 10 — Yayına hazırlık

Taban: PR #10 sonrası `main`, `acf44ca`. Branch: `stage-10-production-hardening`.

## Kullanım ve veri güvenliği

Seçimler, transfer/silme/geri alma, strateji ve dosya uygulama işlemleri önce
belleğe yazılır. **Kaydedilmemiş çalışma var / Kaydedilmedi** görünür. **Kaydet**
başarılı olduğunda gösterge ve `beforeunload` dinleyicisi kaldırılır. Uyarı yalnızca
bellekte kalıcı kayda aktarılmamış bir snapshot olduğunda etkindir. Tarayıcılar
uyarıyı her durumda göstermeyebilir; özellikle mobil kapanma veya işletim
sistemi tarafından sonlandırılmada kurtarma garantisi yoktur. Düzenli **JSON
yedeğini indir** kullanın. Otomatik kayıt eklenmedi.

Kayıt adaptörü başarıyla okuduğu/yazdığı ham JSON metnini sekmeye özel bir baz
olarak tutar. `storage` (anahtar silme ve `clear` dahil), pencere odağı ve görünür
sekmeye dönüş olaylarında mevcut kayıtla karşılaştırır. Kaydetmeden hemen önce
aynı kontrol tekrarlanır; olay kaçırılsa da eski snapshot sessizce yazılmaz.
`WorkspaceSnapshot` ve JSON şeması değişmedi; önceki yedekler geçerlidir.

Başka sekme kaydettiğinde bu sekmenin verisi **otomatik değiştirilmez**.
Kaydetme durdurulur, açık çakışma uyarısı gösterilir; düzenlemeye ve JSON
kurtarma yedeği indirmeye devam edilebilir. Önce bu sekmenin yedeğini indirin.
Sonra değiştirme kutusunu açıkça işaretleyip **Güncel tarayıcı kaydını yükle**
seçebilirsiniz. Yükleme başarısızsa mevcut bellek korunur. Bozuk kayıt silinmez,
üzerine yazılmaz. Güncel kayıt yoksa bellek korunur; JSON’u saklayıp sayfayı
bilinçli olarak yeniden açabilirsiniz. Otomatik birleştirme veya zorla üzerine
yazma eklenmedi.

**Sınır:** localStorage atomik compare-and-swap sağlamaz. İki sekme tam aynı
anda kontrol edip sonra yazarsa son yazan kazanabilir. Bu koruma tam eşzamanlılık
veya senkronizasyon garantisi değildir. Baz metninin tekrar aynısına dönmesi de
aradan geçen değişiklikleri göstermez. Tek yazan sekme kullanmak ve JSON yedek
almak en güvenli kullanım biçimidir. İleride Web Locks/IndexedDB gibi ayrı bir
kayıt protokolü değerlendirilebilir.

Kota ve SecurityError başarısızlıkları başarı göstermez; bellek ve önceki kayıt
korunur. Kaydetme/güncel kaydı yükleme sürerken store yeni işlemleri kabul etmez.
JSON geri yükleme önizlemesi revizyona ve açık değiştirme onayına bağlıdır.
JSON dosyası okumaya başlamadan 20 MB ile sınırlandırılır. XLSX sıkıştırılmış ve
açılmış boyut, XML/formül ve kimlik doğrulamalarını korur. Dosya seçimi yarışları
tokenlarla, uygulama önizlemesi snapshot/revizyon kontrolüyle yönetilir.

## Açık tema ve erişilebilirlik

Tek varsayılan tema açıktır. Yerleşim ve kullanıcı akışları korunur.

| Token | Renk / kullanım |
|---|---|
| `--background` | `#F7F8FC` genel zemin |
| `--surface` / `--surface-alt` | `#FFFFFF` / `#EDF1F7` panel ve ikincil kontroller |
| `--text` / `--muted` | `#162B4D` / `#526580` metin |
| `--accent` / `--accent-hover` | `#F4C542` / `#E6B62E` ana buton |
| `--accent-soft` | `#FFF3C5` seçili takım/satır ve uyarı zemini |
| `--border` / `--control-border` | `#E0E6EF` dekoratif sınır / `#7B8AA0` kontrol sınırı |
| `--link` / `--focus-ring` | `#224E85` bağlantı ve görünür odak |
| `--danger` / `--success` | `#A12235` / `#24623E` durum metinleri |

Sarı yalnızca vurgu zemini olarak kullanılır; uzun metin rengi değildir.
`color-scheme: light` native input/select kontrollerini kapsar. Sticky hücreler,
hover, seçili satır, modal/backdrop, kadrolar, öneriler ve analizler merkezi
CSS değişkenlerini kullanır. Disabled kontroller kesikli sınırla da ayrılır.
Hata/kayıt/çakışma bilgisi metin ve status/alert rolleriyle aktarılır.

Kontrast testleri gerçek CSS tokenlarını okuyup WCAG sRGB bağıl parlaklık
formülüyle hesaplar: 20 normal metin/zemin çifti ≥4.5:1; sarı/hover üzerinde
lacivert ≥4.5:1; 5 focus/zemin ve 2 kontrol sınırı/zemin çifti ≥3:1.
Örnek oranlar: lacivert/beyaz **14.12:1**, ikincil metin/beyaz **5.95:1**,
lacivert/sarı **8.68:1**, kontrol sınırı/ikincil zemin **3.10:1**.
Native erişilebilirlik ağacı testi görünür etkileşimli kontrollerin adlarını,
form hatalarının odak ve `aria-describedby` ilişkilerini denetler. Ek bağımlılık
gerektirmez. Bu sınırlı otomatik denetim tam WCAG sertifikası veya kapsamlı ekran
okuyucu denetimi değildir.

Native `<dialog>` top layer/inert davranışı, Tab/Shift+Tab sarma, Escape ve açan
öğeye odak dönüşü test edilir. İç içe `<details>`, klavyeden kaydırılan tablolar,
sticky başlık/oyuncu sütunu korunur. 1280 px ekranın %200 zoom karşılığı 640 CSS
px reflow ve ayrıca iki kat kök yazı boyutu test edilir. Bu, başsız testte gerçek
tarayıcı menüsünden zoom uygulamakla aynı ölçüm değildir; manuel zoom/ekran
okuyucu kontrolü yayın sonrası da yararlıdır. 280/375/768/1280/1920 px testleri
sayfa taşmasını ve modalın ekran içinde kalmasını denetler.

## Test kapsamı ve CI

Mevcut **233 test** korunur: domain 25, motor/parity 26, persistence 13, legacy
26, application 47, Chromium 66, import 30. Legacy 26 test, HTML referansları,
motor algoritmaları ve golden-master girdileri/çıktıları değiştirilmedi.

Yeni testler:

- 30 tema/kontrast testi; 4 kayıt/çakışma testi.
- 10 gerçek Chromium testi: 600 oyuncuyla tek kapsamlı draft yolculuğu, iki sekme,
  dirty/unload, beş responsive genişlik, zoom eşdeğeri, erişilebilirlik ağacı.
- E2E boş lig, on takım, kendi takım/sıra, kayıt, gerçek boş XLSX indirme, sentetik
  XLSX önizleme/uygulama, hedefler, ilk ve diğer takım seçimleri, snake dönüşü,
  açık sıra dışı onayı, transfer, silme/undo, gerçek motorla Power Rankings/
  öneri/kadro karşılaştırması, yeniden dosya yükleme, eksik/analiz dışı seçilmiş
  oyuncu, kimlik/geçmiş koruması, kayıt/yenileme, JSON restore eşdeğerliği içerir.
  Hesaplama motoru mock edilmez.
- Aynı gerçek yolculuk Firefox/WebKit için ayrı `npm run test:browsers` hedefidir.
  Kurulamayan tarayıcı testleri sessizce atlanmaz; hedef hata verir.

Yerel Firefox/WebKit indirmeleri ortamın ağ politikası nedeniyle 403
`Domain forbidden` aldı; çalıştırma girişimleri eksik executable ile başarısız
oldu. Yerel çapraz tarayıcı doğrulaması **başarılı değildir**. CI üç motorun
binaries ve sistem bağımlılıklarını kurup Firefox/WebKit hedefini de çalıştırır.

`.github/workflows/ci.yml` her PR ve main push’unda Node 24 (≥22.12), npm cache,
`npm ci`, Playwright kurulumu, typecheck, build, audit, tüm testler, ayrı tarayıcı
hedefi ve performans ölçümlerini çalıştırır. Yetki `contents: read`; başarısız
komut workflow’u başarısız yapar. Log ve `artifacts/` 14 gün saklanır; görev
zaman aşımı 20 dakikadır. Netlify Deploy Preview ayrı durum kontrolüdür.

Tekrarlama:

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run typecheck
npm run build
npm test
npm run test:browsers
npm run test:performance
npm run test:performance:browser
npm audit
```

Sistem Chromium’u için `CHROMIUM_PATH=/usr/bin/chromium` kullanılabilir.

## Performans ve bellek

150/300/600 oyuncu, 10 takım ve 130 snake seçimde gerçek komut/selector/analiz
ölçülür. Bir ısınma + üç koşunun medyanı, seçim işlemlerinde p95 raporlanır.
Tarayıcı ölçümleri gerçek React/Vite uygulamasında dosya yükleme, önizleme,
arama/sıralama, seçim ve panel güncelleme, JSON indirme süreleridir; Playwright
iletişimini ve development server maliyetini de içerir. Sonuçlar cihaz SLA’sı
veya yalnızca motor süresi olarak yorumlanmamalıdır.

İyileştirmeler: arama metni bir defa normalize edilir, sıralama anahtarları
karşılaştırma başına yeniden hesaplanmaz. Import incelemesi memoize edilir;
kapalı kimlik karar bölümünün en fazla 20 × oyuncu sayısı kadar option DOM’u
açılana kadar oluşturulmaz. Sorunlu kimliklerde bölüm otomatik açık kalır;
kararlar ve sayfalama korunur. Workspace referansına bağlı mevcut selector
memoization ve 25 satırlık oyuncu sayfalaması korunur. Motor değişmez.

[Ham önce/sonra ölçümler](measurements/stage-10/) tekrar üretilebilir. Tarayıcı
önce ölçümü değişmemiş `acf44ca` worktree’sinde aynı betikle alınır. Gizli panel
DOM’u yerine ihtiyaç anında üretim kullanılması bellek baskısını azaltır;
uygulama sonrası DOM sayısı oyuncu ölçeğiyle büyümez. Bu bir heap sızıntısı
kanıtı değildir. Tarihsel datasetler JSON’da bilinçli olarak korunmaya devam
eder; otomatik veri temizliği eklenmez. Kalıcı kayıt baz metni ek bir JSON
kopyası tutar. Çok büyük dosya ve yüzlerce geçmiş yükleme hâlâ bellek tüketebilir.

Performans kabul sınırları baz ölçümden geniş seçildi: Node tarafında XLSX
1500 ms, önizleme 500 ms, seçim p95 50 ms, selector p95 100 ms, analiz p95 50 ms,
JSON 250 ms; tarayıcıda startup 10 s, XLSX önizleme 5 s, kullanıcı işlemleri 2 s.
DOM <5000 öğe. Bunlar aşırı regresyon korumasıdır; her işlem için aynı süre
kullanılmaz. Paylaşımlı CI’da küçük süre farkları optimizasyon kanıtı sayılmaz.

Yerel sonuç: **277/277 test**, TypeScript ve production build başarılı.

| Oyuncu | XLSX önizleme önce → sonra (ms) | Seçim/paneller önce → sonra (ms) | Startup sonra (ms) |
|---|---|---|---|
| 150 | 222.70 → 86.74 | 183.55 → 176.94 | 553.46 |
| 300 | 591.37 → 119.81 | 206.12 → 176.63 | 545.31 |
| 600 | 717.74 → 217.36 | 189.98 → 192.84 | 571.14 |

600 oyuncuda arama/sıralama 65.23 → 63.88 ms, XLSX uygulama/paneller
133.53 → 93.37 ms, JSON indirme 64.64 → 43.30 ms. Uygulama sonrası DOM
üç ölçekte de 980 öğedir. Küçük farklar ölçüm gürültüsüdür; asıl iyileşme
gereksiz kimlik seçeneklerinin oluşturulmamasında görülür.

Node ölçümü (150 / 300 / 600 oyuncu; ms):

| İşlem | 150 | 300 | 600 |
|---|---|---|---|
| XLSX okuma | 23.942 | 39.387 | 69.829 |
| Önizleme | 3.524 | 8.283 | 28.819 |
| İlk selector | 0.835 | 1.340 | 2.399 |
| Seçim p95 | 0.221 | 0.329 | 0.592 |
| Öneriler dahil selector p95 | 1.137 | 1.490 | 2.918 |
| Analiz/kadro selector p95 | 0.130 | 0.121 | 0.147 |
| JSON export | 2.815 | 4.414 | 8.531 |
| JSON restore | 3.088 | 4.059 | 7.382 |

Her ölçek 130 seçime ulaşır ve JSON sonucu orijinaliyle derin eşit karşılaştırılır.
Gerçek tarayıcıdaki JSON restore ölçümü [yolculuk raporundadır](measurements/stage-10/journey-chromium.json).

## Güvenlik ve dağıtım

`npm audit`: **0** açık (info/low/moderate/high/critical tamamı 0); production
ve development bağımlılıkları birlikte incelendi. Yeni bağımlılık eklenmedi.
Üretim etkisi olan raporlanmış açık yok. [Audit JSON](measurements/stage-10/npm-audit.json).

Uygulama tarayıcı tarafında kalır: backend, hesap, telemetri, analytics veya
veri gönderme eklenmedi. React metin kaçışını test eden kötü amaçlı lig adı
HTML olarak çalışmaz. Dosyalar doğrulanmadan uygulanmaz; loglara içerik yazılmaz.
`dist` yalnızca index, derlenmiş JS/CSS ve mevcut `legacy/v3.3.html` içerir;
test, fixture, screenshot, kaynak doküman veya JSON lig kaydı yayınlanmaz.
Legacy HTML başlangıç oyuncuları boş, takım adları genel örneklerdir; sabit
fixture’lar sentetiktir. Referans dosyaları değişmeden korunur. Hosting Netlify
olarak kalır; deployment yapılandırması değiştirilmedi.

## Görseller

[Önce: Aşama 9 masaüstü](screenshots/stage-9-desktop.png) ·
[Önce: mobil](screenshots/stage-9-mobile.png).
Yeni ekranlar aşağıdaki tablodadır; testler bütün çıktıları `artifacts/ui/stage-10/`
altında yeniden üretir. Kaydedilmiş görseller yalnızca sentetik veri içerir.

| Ekran | 280 px | 375 px | 768 px | 1280 px | 1920 px |
|---|---|---|---|---|---|
| Boş lig | [280](screenshots/stage-10/setup-280.png) | [375](screenshots/stage-10/setup-375.png) | [768](screenshots/stage-10/setup-768.png) | [1280](screenshots/stage-10/setup-1280.png) | [1920](screenshots/stage-10/setup-1920.png) |
| Excel önizleme | [280](screenshots/stage-10/import-280.png) | [375](screenshots/stage-10/import-375.png) | [768](screenshots/stage-10/import-768.png) | [1280](screenshots/stage-10/import-1280.png) | [1920](screenshots/stage-10/import-1920.png) |
| Oyuncu havuzu | [280](screenshots/stage-10/pool-280.png) | [375](screenshots/stage-10/pool-375.png) | [768](screenshots/stage-10/pool-768.png) | [1280](screenshots/stage-10/pool-1280.png) | [1920](screenshots/stage-10/pool-1920.png) |
| Öneriler | [280](screenshots/stage-10/recommendations-280.png) | [375](screenshots/stage-10/recommendations-375.png) | [768](screenshots/stage-10/recommendations-768.png) | [1280](screenshots/stage-10/recommendations-1280.png) | [1920](screenshots/stage-10/recommendations-1920.png) |
| Atama modalı | [280](screenshots/stage-10/modal-280.png) | [375](screenshots/stage-10/modal-375.png) | [768](screenshots/stage-10/modal-768.png) | [1280](screenshots/stage-10/modal-1280.png) | [1920](screenshots/stage-10/modal-1920.png) |
| Power Rankings | [280](screenshots/stage-10/power-280.png) | [375](screenshots/stage-10/power-375.png) | [768](screenshots/stage-10/power-768.png) | [1280](screenshots/stage-10/power-1280.png) | [1920](screenshots/stage-10/power-1920.png) |
| Kadrolar | [280](screenshots/stage-10/rosters-280.png) | [375](screenshots/stage-10/rosters-375.png) | [768](screenshots/stage-10/rosters-768.png) | [1280](screenshots/stage-10/rosters-1280.png) | [1920](screenshots/stage-10/rosters-1920.png) |
| Kategori/rakip | [280](screenshots/stage-10/analysis-280.png) | [375](screenshots/stage-10/analysis-375.png) | [768](screenshots/stage-10/analysis-768.png) | [1280](screenshots/stage-10/analysis-1280.png) | [1920](screenshots/stage-10/analysis-1920.png) |
| Hata/kaydedilmemiş | [280](screenshots/stage-10/error-dirty-280.png) | [375](screenshots/stage-10/error-dirty-375.png) | [768](screenshots/stage-10/error-dirty-768.png) | [1280](screenshots/stage-10/error-dirty-1280.png) | [1920](screenshots/stage-10/error-dirty-1920.png) |
| Tam çalışma alanı | [280](screenshots/stage-10/workspace-280.png) | [375](screenshots/stage-10/workspace-375.png) | [768](screenshots/stage-10/workspace-768.png) | [1280](screenshots/stage-10/workspace-1280.png) | [1920](screenshots/stage-10/workspace-1920.png) |

[200% zoom eşdeğeri](screenshots/stage-10/zoom-200.png).

Kapsam dışı konular: yeni fantasy özellikleri, kapsamlı redesign, tema
değiştirme kontrolü, backend/bulut senkronizasyonu ve motorun yeniden yazılması.

### PR #11 inceleme düzeltmesi — ilk yüklemede erişim hatası

İlk `load()` geçici SecurityError ile başarısız olduğunda kayıt bazı oluşmaz.
`save()` bu durumda yalnızca anahtar gerçekten boşsa yeni kayıt oluşturabilir;
mevcut geçerli kayıt `storage-conflict` ile korunur. Bozuk kayıt için önceki
`existing-record-invalid` davranışı ve başarılı yüklemeden sonraki baz
karşılaştırması değişmez. Çakışma mevcut JSON kurtarma ve açık onayla güncel
kaydı yükleme akışını kullanır; bellek kendiliğinden değiştirilmez.

Üç ek persistence regresyon testi ve gerçek iki sekmeli React testi; ilk erişim
hatası → bellekte farklı çalışma → erişimin düzelmesi → kaydetmenin reddi → JSON
kurtarma → açık onayla yükleme → normal kayıt zincirini doğrular. Boş depolama ve
bozuk kayıt da kapsanır. Bu kontrol localStorage'a atomik compare-and-swap veya
tam eşzamanlılık garantisi eklemez.
