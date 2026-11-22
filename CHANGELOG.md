# Değişiklik günlüğü

## 0.1.4

- **Düzeltme: sadece ses kayıtlarında sesin bir kısmı kayboluyordu.** Kayıt motoru takıldığında
  (örneğin ekran kartı süreci çöktükten sonra, yüksek kare hızında) ses parçaları küçük bir
  tampondan taşıp atılıyor, kalanlar da gecikmeli geldiği için araya boşluk konuyordu
  (bir kayıtta sesin ~%34'ü). Artık ses tamponu ~5 saniye, zamanlama parçanın yakalandığı ana
  göre yapılıyor ve sadece ses modunda önizleme hiç çizilmiyor. Takılma testinde kayıp %0.
- **Düzeltme: 320 kbps seçilince ses Opus'a geçiyordu.** Windows'un AAC kodlayıcısı en fazla
  192 kbps destekliyor; artık 192 kbps AAC kullanılıyor (Opus'lu .m4a bazı kurgu programlarında açılmıyordu).
- Mikrofon açılınca uygulanan ayarlar (gürültü / yankı engelleme) günlüğe yazılıyor.
- Sadece ses modunda yanlışlıkla çıkan "Donanım kodlayıcı bulunamadı" uyarısı kaldırıldı.

## 0.1.3

- **Düzeltme: küçültülmüş pencereler kaynak listesinde çıkmıyordu.** Pencere sekmesi,
  pencereler açık olsa bile simge durumundaysa "Gösterilecek bir şey yok" diyordu. Artık
  küçültülmüş pencereler de listelenir; seçilince pencere açılır ve yakalanır.
- **Yeni: Güçlü gürültü engelleme.** Mikrofon için Kapalı / Normal / Güçlü seçimi. Güçlü
  seviye RNNoise (wasm) kullanır; testte uğultu ~48 dB bastırıldı, konuşma düzeyi değişmedi.
  İsteğe bağlı yankı engelleme eklendi.
- **Yeni: Sadece ses kaydı.** Ses kartındaki "Kayıt türü"nden görüntüsüz kayıt seçilebilir;
  mikrofon (ve istenirse sistem sesi) ayrı ses düzeyleriyle `.m4a` dosyasına yazılır.
  Duraklat / sürdür, ayrı ses kanalları ve kütüphanede oynatma desteklenir.
- **Lisans GPL-3.0 oldu** (0.1.2 ve öncesi MIT). "Tilki Studio" adı ve tilki logosu için
  [TRADEMARKS.md](TRADEMARKS.md) eklendi. Hakkında bölümünde Siber Tilki kanal bağlantısı var.
- **Düzeltme: hata çıkınca kayıt siliniyordu.** Kayıt sırasında yazma ya da kodlayıcı hatası
  olursa dosyanın tamamı siliniyordu. Artık o ana kadarki kısım korunuyor ve haber veriliyor.
- **Kodlayıcı hatasında kayıt durup kalmıyor:** yeni bir dosyada kendiliğinden sürüyor
  (10 dakikada en fazla 3 kez).
- **İzin ve klasör kontrolü:** ilk açılışta (ve Ayarlar > Genel > Kontrol et ile) ekran,
  mikrofon ve kayıt klasörü kontrol edilir. Windows Güvenliği'nin "Denetimli klasör erişimi"
  yazmayı engellerse ya da Windows mikrofonu kapatırsa ne yapılacağı ve ilgili ayarı açan
  düğme gösterilir. Eskiden yalnızca "EPERM" gibi anlaşılmaz bir hata çıkıyordu.
- **Mikrofon koparsa** (USB çıktı, sürücü sıfırlandı) uyarı + bildirim çıkar, mikrofon 3
  saniyede bir yeniden bağlanmaya çalışılır. Seçili mikrofon yoksa varsayılana geçildiği söylenir.
- **Ekran yakalaması kayıt ortasında koparsa** aynı ekran kendiliğinden yeniden yakalanır.
- **Disk alanı:** 1 GB'tan az boş yer varsa kayıt başlamaz; kayıt sırasında 3 GB altında uyarı,
  600 MB altında kayıt dosya bozulmadan durdurulur.
- **Hata günlüğü:** `%APPDATA%\Tilki Studio\logs` altına yazılır (son 10 gün).
- Arayüz çökerse yarım kalan kayıt kapatılır ve korunur; yeniden açılınca haber verilir.

## 0.1.2

- **Düzeltme: kayıt "Başlatılıyor…" ekranında takılı kalabiliyordu.** Ekran kartı sürücüsü
  kodek sorgusuna yanıt vermediğinde uygulama sonsuza kadar bekliyordu. Artık her sorgu
  süreyle sınırlı; kayıt başlatılamazsa ne yapılacağını söyleyen bir uyarı çıkıyor.
- Arayüz süreci çökerse pencere donmuş kalmıyor, kendini yeniden yüklüyor.
- Kapanış yarım kalırsa arka planda penceresiz bir Tilki Studio kalmıyor; uygulama yeniden
  açıldığında pencere her zaman geliyor.

## 0.1.1

- **Kayıt anında başlıyor:** video kodlayıcı arka planda hazır bekler; kayıt tuşuna
  basınca kaydın başlaması ~2 saniyeden ~15 ms'ye indi.
- **Daha az işlemci kullanımı:** kayıt sırasında sürekli çalışan arayüz animasyonları
  kaldırıldı, ses göstergeleri seyrekleştirildi, önizleme 30 fps ile sınırlandı. Kamera ve
  ölçekleme yoksa ekran karesi doğrudan kodlayıcıya gider. 1080p60 kayıtta işlemci
  kullanımı yaklaşık yarıya indi.
- **Varsayılan kısayollar** `Alt+F9` / `F10` / `F11` / `F12` oldu; eskileri
  (`Ctrl+Shift+…`) editör ve tarayıcı kısayollarıyla çakışıyordu.
- **MKV:** dosyalara her zaman süre ve arama dizini yazılır. MKV ani kapanmaya zaten
  dayanıklı olduğu için "çökmeye dayanıklı kayıt" seçeneği artık yalnızca MP4'ü etkiler.
- Kayıt sürerken pencere kapatılınca dosya düzgünce kapatılır.
- Mikrofonu olmayan bilgisayarlarda her açılışta çıkan uyarı kaldırıldı.

## 0.1.0

İlk sürüm: ekran / pencere / bölge kaydı, donanım kodlama (H.264 / HEVC / AV1), sabit kare
hızı, sistem sesi + mikrofon, ayrı ses kanalları, kamera kutusu, anlık tekrar,
duraklat / sürdür, genel kısayollar, kayıt kütüphanesi, Türkçe ve İngilizce arayüz.
