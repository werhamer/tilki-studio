# Değişiklik günlüğü

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
