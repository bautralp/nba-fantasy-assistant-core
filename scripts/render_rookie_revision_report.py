"""Render factual delivery answers from reviewed, versioned research outputs."""
import json
from pathlib import Path
from statistics import mean

def fmt(value):return '—' if value is None else f'{value:.3f}'
def pct(value):return '—' if value is None else f'{100*value:.1f}%'

def main():
    root=Path('docs');coverage=json.loads((root/'stage-14-1-revision-coverage.json').read_text())
    backtest=json.loads((root/'stage-14-1-revision-backtest.json').read_text());collection=coverage['collection']
    criteria=json.loads(Path('scripts/rookie-acceptance-criteria.json').read_text())
    params=json.loads(Path('scripts/rookie-parameters.json').read_text());acceptance=backtest.get('acceptance',{})
    draft=coverage['draftSelections'];by_id={r['playerId']:r for r in draft}
    lines=['# PR #17 revizyonu — Rookie kapsamı ve bağımsız değerlendirme','',
        '**Production rookie modeli kapalıdır.** Kimlik doğrulaması, istatistik verisi ve modelin production yeterliliği ayrı sonuçlardır. Sayısal projeksiyonlar değiştirilmedi.','',
        'Bu rapor önceki dokuz oyunculuk araştırmanın teslimat sayılarının yerini alır. Önceki rapor ve test sonuçları tarihsel karşılaştırma içindir; yeni bağımsız holdout olarak kullanılmadı.','',
        '## Teslimat soruları','',
        '### 1. 2026 draft kapsamı','',
        '| Seçimler | Resmî draft + ESPN ID doğrulandı | Fantasy kataloğunda | NBA katılımı ayrıca doğrulandı |',
        '|---|---:|---:|---:|']
    for n in (14,30,60):
        d=collection['draftCoverage'][str(n)]
        lines.append(f"| İlk {n} | {d['verified']}/{n} ({pct(d['verified']/n)}) | {d['inFantasyCatalog']}/{n} | {d['NBAEntryVerified']}/{n} |")
    pending_entry=[r['name'] for r in draft if not r.get('nbaEntryVerified')]
    lines+=['', 'Draft kimliği doğrulanmış fakat NBA katılımı henüz doğrulanamamış kayıtlar: '+', '.join(pending_entry)+'. Bu oyuncular havuzda kalır; NBA kadrosuna katılmadıkları varsayılmaz.']
    activity=collection.get('fantasyActivity',{});flags=activity.get('activeFlags',{})
    lines+=['',f"Deneyim sınıfları: rookie **{coverage['counts'].get('rookie',0)}**, doğrulanmış international newcomer **{coverage['counts'].get('international-newcomer',0)}**, bilinmeyen **{coverage['counts'].get('unknown',0)}**. Sayısal projeksiyon mevcut: **{coverage['numericalIntegrity']['counts']['available']}**; unavailable: **{coverage['numericalIntegrity']['counts']['unavailable']}**. Araştırma öncülü hesaplanabilen doğrulanmış rookie/newcomer: **{len(coverage['researchPriorCandidates'])}**; bunlar yeni production tahmini değildir."]
    lines+=['',f"Korunan ROS havuzu **{coverage['poolSize']}**; uygunluk kataloğu **{collection['fantasyCatalogSize']}** kayıt. Bunlar farklı paydalardır. Ham Fantasy active=true: **{flags.get('true','doğrulanamadı')}**, active=false: **{flags.get('false','doğrulanamadı')}**, alanı bulunmayan: **{flags.get('unspecified',0) if activity.get('status')=='success' else 'doğrulanamadı'}**. Uygunluğu doğrulanmış olmak aktiflik kanıtı değildir.",
        '',f"Güncel takım roster'ında doğrulanan **{collection['currentRosterVerified']}** kimlik ayrıca sayılır. Metadata hatası nedeniyle oyuncu havuzundan kayıt silinmedi.",'',
        '### 2. Dört önemli oyuncu','',
        '| Oyuncu | ESPN athlete ID | Draft sırası | Deneyim | Kimlik / NBA katılımı | NCAA bireysel veri |',
        '|---|---|---:|---|---|---|']
    for pid in ('5142718','5041935','5095151','5142620'):
        r=by_id.get(pid)
        if r:lines.append(f"| {r['name']} | {pid} | {r['overall']} | {r['experience']} | {r['verified']} / {r.get('nbaEntryVerified',False)} | {r['ncaaAvailable']} ({r['ncaaGames'] or 0} GP) |")
    lines+=['','Resmî NBA draft kaydı yıl/sıra/tur/orijinal takım ile ESPN draft kaydına bağlanır; NBA player proLink, UID ve alternativeId aynı NBA athlete ID üzerinde uyuşmalıdır. Draft API içindeki athlete.id ayrı bir kimlik alanıdır ve NBA ID olarak kullanılmaz. Exact isim/incelemiş alias yalnız uyuşmazlık korumasıdır; isimden otomatik oyuncu birleştirilmez. Draft edilmek NBA kadrosuna katılmayı tek başına kanıtlamaz.','',
        '### 3. Eski 509 HTTP 503 kaydı','',
        f"Eski **{collection['old503']}** kaydın **{collection['old503FullyRecovered']}** tanesinde athlete ve gereken kariyer endpointleri tamamen kurtarıldı. **{collection['old503IdentityRecovered']}** kayıtta NBA kimliği doğrulanabildi; bu sayı bağımsız draft kanıtıyla doğrulanmış fakat endpoint sorunu sürenleri de içerebilir. Kalan hata kaydı: **{len(collection['remaining503'])}**. Tam liste coverage JSON içindedir.",
        '', 'Kalan endpoint türleri: `'+json.dumps(collection.get('old503RemainingEndpointKinds',{}),sort_keys=True)+'`. Eski hata grubunda halen HTTP 503 alan kayıt: **'+str(collection.get('old503StillHTTP503','bilinmiyor'))+'**. HTTP hatasının kalkması ile kariyer şemasının doğrulanması aynı ölçüt değildir.',
        '', 'İki worker, tüm isteklerde ortak rate limit, exponential backoff + jitter, Retry-After saniye/HTTP-date ve ortak cooldown kullanılır. 403/404 tekrar edilmez; 429/503/ağ hataları sınırlı denenir. Başarılı yanıtların hash kontrollü kalıcı cache’i ve başarılı profiller korunur. Yalnız başarısız/yeni kayıtlar yeniden istenir. Geçersiz sayısal olmayan eski ID ağ isteğine dönüşmez.','',
        '### 4. Tarihsel eğitim grubu','',
        f"Bireysel kapsamı doğrulanmış gerçek NBA görünümü bulunan benzersiz eğitim rookie sayısı: **{backtest.get('trainingRookies','hesaplanamadı')}**; önceki model **9** idi. Sıfır NBA maçlı draft seçimleri dahil availability eğitim kohortu: **{backtest.get('trainingAvailabilityCohort','hesaplanamadı')}**.",
        '', '| Ending year | Doğrulanan kohort (availability dahil) | NCAA eşleşmesi |', '|---|---:|---:|']
    for year,count in collection['cohortCounts'].items():lines.append(f"| {year} | {count} | {collection['ncaaCohortCounts'].get(year,0)} |")
    lines+=['', 'Eğitim alt grupları: `'+json.dumps(backtest.get('trainingGroups',{}),ensure_ascii=False,sort_keys=True)+'`. NCAA dışındaki kuruluşun varlığı uluslararası profesyonel lig kanıtı sayılmaz. Doğrulanmış lig ayrımı bulunmayan tarihsel kayıt `other-organization`/`unknown` kalır; bunun için ayrı bir dönüşüm modeli kurulmaz.']
    lines+=['', 'Doğrulanmış international newcomer: '+', '.join(r['name']+' ('+r['id']+')' for r in coverage['verifiedRookies'] if r.get('experience')=='international-newcomer')+'. Bunlar için doğrulanmış bireysel uluslararası lig istatistiği sayısı 0; NCAA varlığının/yokluğunun kendisi profesyonel lig kanıtı değildir.']
    lines+=['', 'Somut kimlik sınırı: 2014 ESPN draft yanıtında Andrew Wiggins alternativeId=67429 ve link NCAA player adresidir. Bu alan NBA athlete ID kabul edilmedi. Eski draft yanıtlarında NBA proLink/UID yoksa resmî NBA draft slotu + NBA core native UID + yıl/tur/seçim ve exact isim koruması gerekir; çözülemeyen seçimler eksik kalır.']
    lines+=['', 'Kısmi sezonlar: Eksik maçın iki franchise’ı ile ilişkili oyuncular ve eksik/tutarsız istatistik satırı bulunan oyuncu sezonları araştırma kohortundan çıkarılır; boş maç sıfırla doldurulmaz. Kariyer GP verisi gözlenen maçlardan daha büyükse bireysel kapsam da reddedilir. Kısmi lig kaynağında sıfır NBA maçı ancak kariyer şeması doğrulanmışsa availability sonucu olabilir. Bu veri kalitesi seçimi performansa/20 gelecek maçta hayatta kalmaya bağlı değildir, fakat eksik franchise’ların dışlanması yine bir kapsam sınırıdır. Bütün lig kaynağı tamamlanmış sayılmaz ve production veri kapısı kapalı kalır. Gecikmiş debutlarda eski doğrulanmış draft bilgisi ve debut öncesi en son bulunan NCAA sezonu korunur.']
    lines+=['', 'Production veri kapısını kapatan eksikler:','', '| Ending year | Eksik ESPN game ID |', '|---|---|']
    for year,gap in collection.get('partialHistoricalSeasons',{}).items():lines.append('| '+year+' | '+', '.join(gap['missingGames'])+' |')
    lines+=['', f"Validation’da seçilen minutesK={params['minutesK']}, roleWeight={params['roleWeight']}, 3PA rateK={params['rateK']['3PA']}. Önceki modelin minutesK=40 ve 3PA rateK=2400 değerleri 20 maç/400 dakika örneğinde yalnız %33/%14 güncel ağırlık veriyordu; yeni değerler yaklaşık %87/%89 verir. Bu açıklama shrinkage farkını gösterir; genişleyen eğitim/NCAA/rol değişikliklerinden tek başına nedensellik çıkarılmaz. Parametreler holdout sonucuyla tekrar seçilmedi."]
    lines+=['', 'Kohortlar resmî draft + açık NBA ID veya doğrulanmış kariyer başlangıcı + daha eski NBA boxscore kontrolüyle kurulur. Retrospektif core dosyalarındaki güncel yaş/experience/pozisyon debut kanıtı ya da model girdisi değildir. Draftsız olduğu kesinleştirilemeyen kayıtlar `undrafted-or-unknown` kalır. Reddedilen adaylar ve çözülemeyen tarihsel draft seçimleri raporlanır.','',
        '### 5. NCAA ve diğer ligler','',
        f"Güncel havuzda doğrulanmış NCAA bireysel istatistiği bulunan oyuncu: **{len(coverage['preNBAData'])}**. Tarihsel eğitimde NCAA–NBA çifti: **{backtest.get('ncaaTrainingPairs','hesaplanamadı')}**. NCAA branch validation seçimi: **{backtest.get('ncaaEnabled',False)}**.",
        '', 'Yalnız NBA athlete yanıtındaki açık collegeAthlete.id crosswalk’ı kullanılır. Aynı sayısal ID’nin iki ligde aynı kişiye ait olduğu varsayılmaz. NCAA verisi debut öncesi tarihle sınırlandırılır. En az 75 eğitim çifti olmadan NCAA dönüşümü kurulmaz; draft/pozisyon alt grupları en az 30 oyuncu ister. Diğer profesyonel liglerden geliş kulüp/draft kaynağıyla doğrulanabilir; bu bireysel lig istatistiği bulunduğu anlamına gelmez. Bu revizyonda doğrulanmış uluslararası lig istatistik dönüşümü yoktur.','',
        '### 6. Bağımsız test başarısı','',
        'Kabul ölçütleri sonuçlara bakılmadan [rookie-acceptance-criteria.json](../scripts/rookie-acceptance-criteria.json) içinde kaydedildi: eğitim 2012-13–2017-18; validation 2018-19; yeni holdout 2019-20/2020-21/2021-22. Önceden incelenen 2022-23–2025-26 sonuçları yeni holdout değildir. Parametreler yalnız eğitim/validation ile seçilip testten önce hash ile dondurulur.','',
        'İlk 1/3/5 maçta normalize MAE bileşiğinde en az %5 iyileşme; 10/20 maçta en fazla %2 kötüleşme; en az iki holdout sezonunda iyileşme; en fazla iki metrikte %15 üzeri regresyon sınırı önceden belirlendi. GP MAE ve Brier regresyonu en fazla %2 olabilir. Eğitim için 150 rookie / dört sezon, holdout için checkpoint başına en az 30 gözlem gerekir.','',
        f"Erken bileşik hata değişimi: **{pct(acceptance.get('earlyCompositeRelativeChange'))}**. Geç bileşik hata değişimi: **{pct(acceptance.get('lateCompositeRelativeChange'))}**. Pozitif holdout sezonu: **{acceptance.get('positiveHoldoutSeasons','hesaplanamadı')}**. Negatif değişim daha düşük hatadır.",'',
        '| NBA GP | Koşullu hedefi bulunan oyuncu gözlemi | Erken ortalama MIN MAE | Model MIN MAE | Erken ortalama PTS MAE | Model PTS MAE |',
        '|---|---:|---:|---:|---:|---:|']
    for n in (0,1,3,5,10,20):
        rs=[r for reports in backtest.get('holdout',{}).values() for r in reports if r['nbaGames']==n]
        def value(mode,key):
            xs=[r['mae'][mode][key] for r in rs if r['mae'][mode][key] is not None]
            return mean(xs) if xs else None
        lines.append(f"| {n} | {sum(r['players'] for r in rs)} | {fmt(value('earlyNBA','MIN'))} | {fmt(value('role','MIN'))} | {fmt(value('earlyNBA','PTS'))} | {fmt(value('role','PTS'))} |")
    lines+=['', 'Availability ve kalan toplam üretim ayrı değerlendirmesi (sezonlara eşit ağırlık):','',
        '| NBA GP | GP/Brier gözlemi | Sıfır gelecek görünümü | GP MAE temel / model | Brier temel / model | Toplam PTS MAE temel / model |',
        '|---|---:|---:|---|---|---|']
    for n in (0,1,3,5,10,20):
        rs=[r for reports in backtest.get('availabilityHoldout',{}).values() for r in reports if r['nbaGames']==n]
        def av(mode,key):
            xs=[r['mae'][mode][key] for r in rs if r['mae'][mode][key] is not None]
            return mean(xs) if xs else None
        lines.append(f"| {n} | {sum(r['players'] for r in rs)} | {sum(r['zeroFutureAppearances'] for r in rs)} | {fmt(av('baseline','GP'))} / {fmt(av('rookie','GP'))} | {fmt(av('baseline','Brier'))} / {fmt(av('rookie','Brier'))} | {fmt(av('baseline','PTS'))} / {fmt(av('rookie','PTS'))} |")
    lines+=['', 'Kötüleşen noktalar korunmuştur: 1 GP koşullu MIN hatası artar; availability GP hatası 10 ve 20 GP’de hafif artar. 20 GP Brier hatası da kötüleşir. Toplam PTS hatası 3/5 GP’de artar. Kabul kararı önceden belirlenen bileşik/ortalama eşiklerle verilir; bu sonuçlar her oyuncu veya checkpoint için üstünlük kanıtı değildir. GP/Brier bütün uygun gözlemleri kullanır; sayısal maç başına tahmin olmayan oyuncuların toplam üretimi unavailable kalır. Toplam üretim paydaları ve bu oyuncu ID’leri coverage JSON içindeki availabilityPredictionCoverage alanındadır.']
    lines+=['','Tablodaki hata, sezon ortalamalarına eşit ağırlık verir. 0 GP’de erken NBA ortalaması bulunmaz; genel/draft öncülü karşılaştırması JSON’dadır. MIN ve dokuz fantasy kategori, FG/FT hacimleri/yüzdeleri, her checkpoint, her sezon, metrik paydaları ve NCAA alt kümesinde aynı oyunculara ait karşılaştırmalar tam backtest JSON’da bulunur. NCAA alt kümesinin hatası tüm havuzun hatasıyla doğrudan karşılaştırılmaz.','',
        'Koşullu hedef sonraki 30 **takım fikstürü** içinde oynanan maçların ortalamasıdır; bir görünüm yeterlidir. 20 gelecek maç şartı kaldırıldı. Hiç gelecek görünümü olmayan oyuncuda koşullu ortalama tanımsızdır, fakat oyuncu availability/GP/Brier/toplam üretim değerlendirmesinde kalır. Sıfır NBA maçı olan doğrulanmış draft seçimleri de availability’nin 0 GP grubundadır.','',
        'Availability toplam hata karşılaştırması iki GP modeli için aynı maç başına tahmini kullanır; böylece availability farkı istatistik tahmininden ayrılır. 0 GP’de doğrulanmış orijinal draft takımı kullanılır; geçmiş kontrat/rotasyon ve draft gecesi trade snapshot’ları eksiktir. Availability, oyuncunun checkpoint takımının kalan normal sezon fikstürünü kullanır. Sonraki takım değişiklikleri girdi değildir; gerçekleşen sonuç olarak ayrıca sayılır. Tarihsel kontrat/roster/sakatlık snapshot kapsamı eksiktir. Draft edilmemiş ve hiç NBA maçı olmayan oyuncular boxscore’dan yeniden kurulamaz. Bu nedenle availability bir sakatlıktan dönüş modeli değildir.','',
        'Önceki 10–20 GP bozulması dokuz oyunculuk öncül, yedi oyunculuk validation, minutesK=40 ve roleWeight=0.5 ile kalıcı shrinkage/son beş maç gürültüsü riskini taşıyordu. Yeni rapor genel öncül, draft öncülü, NCAA ve rol dallarını ayrı gösterir. Her checkpoint’te iyileşme varsayılmaz; kötüleşme saklanmaz.','',
        '### 7. Production’a alınabilecek yeni projeksiyon','',
        f"**0**. Research gate sonucu: **{acceptance.get('researchPassed',False)}**. Başarısız veri/model ölçütleri: **{', '.join(acceptance.get('failedCriteria',[backtest.get('status','unknown')])) or 'Yok; CI ve model incelemesi ayrıca gerekli'}**. Parametre artifact’i enabled=false / research-only kalır. Daha fazla oyuncuya sayı vermek için kapı açılmaz.",'',
        '### 8. Hâlâ unavailable olanlar','',
        f"**{len(coverage['unavailable'])}** oyuncu unavailable. [Tam ad/ESPN ID/deneyim/eksik veri listesi](stage-14-1-revision-coverage.json) korunur. Rookie kimliğinin doğrulanması eksik/valide edilmemiş istatistik projeksiyonunu kendiliğinden available yapmaz. Draft kimliği doğrulanmış, NBA katılımı henüz doğrulanmamış oyuncu; kimliği tamamen bilinmeyen oyuncudan Confidence ayrıntısında ayrılır.",'',
        '### 9. Oyuncu havuzu, Draft ve günlük yenileme','',
        f"Metadata göçü **{coverage['numericalIntegrity']['playersBefore']} → {coverage['numericalIntegrity']['playersAfter']}** oyuncu korur. Bütün sayısal projeksiyonlar, status, GP, RANK, TOTAL Z, rol, UUID/ESPN ID ve Fantasy pozisyonları birebir eşitlik denetiminden geçer. Mevcut draft oturumları yeni kaynakla değişmez. 2025-26 Actual, 2026-27 Projected ve manuel kaynaklar korunur.",
        '', 'Günlük akış yalnız sürümlü yerel profil/parametre artifact’ini okur. Tarihsel indirme, kariyer taraması veya yeniden eğitim günlük workflow’a eklenmedi. Geçersiz yeni snapshot’ta son doğrulanmış sürümü koruma mekanizması devam eder. İstatistik asOf tarihi ile daha sonra doğrulanan kimlik tarihi farklı olabilir; sayısal snapshot tarihi ilerletilmez.','',
        '## Kaynaklar ve erişim sınırları','',
        '- [NBA resmî 2026 draft listesi](https://www.nba.com/news/2026-nba-draft-order): 60 seçim, kayıtlı kaynak tarihi ve hash; orijinal seçim takımı korunur.',
        '- [ESPN NBA draft API](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/draft?season=2026): 60 seçim, açık proLink/UID/alternativeId; draft-internal ID ayrı tutulur.',
        '- ESPN NBA athlete/career ve 30 takım roster API’si; kimlik, collegeAthlete bağı, kariyer başlangıcı ve bağımsız NBA giriş kanıtı.',
        '- SportsDataverse NBA player boxscores 2002–2027 araştırıldı; geçmiş deneyim kontrolü ve uygun sezonlarda schedule mutabakatı. NCAA 2012–2021 ve 2026 araştırıldı. Gerçek erişim, kolonlar, satır sayıları, hash ve hata ayrıntısı [source manifest](stage-14-1-revision-sources.json) içindedir.',
        '- SportsDataverse NBA stats draft ve ESPN player core arşivleri: draft slot/UID sinyalleri; güncel yaş ve tecrübe tarihsel özellik değildir. Otomatik isim eşleşmeli crosswalk oyuncu kimliği için kabul edilmedi.',
        '', 'SportsDataverse README veri için CC BY 4.0 rozeti taşır; repository LICENSE MIT yazılım lisansıdır. ESPN/NBA içeriğinin ayrıca yeniden kullanım izni bu lisanslardan çıkarılmaz. ESPN/Disney koşullarına ve EuroLeague alternatif kaynağına önceki erişim kısıtları giderilmiş gibi gösterilmez. Ham büyük sezon dosyaları repoya ve günlük yayına eklenmez; türetilmiş özet/parametre ve kaynak atıfları sürümlenir.','',
        '## Yeniden üretim','', '```sh', 'python scripts/collect_rookie_revision.py --cache-dir .research-cache',
        'python scripts/evaluate_rookie_revision.py', 'python scripts/finalize_rookie_revision.py',
        'python scripts/render_rookie_revision_report.py', '```','',
        'Toplayıcı ve eğitim offline araştırmadır. Tam kaynaklar Actions artifact/cache içinde kalır; manifest hash’leri raporlanır. Aynı holdout üzerinde yeni parametre denemesi yapılmamalıdır. Golden-master fixture’ları değiştirilmedi. CI’nin tamamlanma durumu PR kontrol kayıtlarında ayrıca doğrulanır; pending veya başarısız tarayıcı kontrolü başarı sayılmaz.','']
    (root/'stage-14-1-revision.md').write_text('\n'.join(lines))

if __name__=='__main__':main()
