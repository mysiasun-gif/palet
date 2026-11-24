# TakJot

Renkli notlar ve yapılacaklar listeleri için kurulabilir bir web uygulaması (PWA).
Notlar yalnızca kullanıldığı cihazda (IndexedDB) saklanır; hiçbir sunucuya gönderilmez.

## Bulut yedeği

İstersen notlarının yedeğini kendi Google Drive'ına kaydedebilir, yeni bir cihazda geri yükleyebilirsin. Sunucu yoktur; her şey tarayıcıda olur.

- **Nerede durur:** Drive'ın uygulamaya özel gizli klasöründe (appDataFolder). Drive listende görünmez, başka uygulamalar göremez. Son 3 yedek tutulur.
- **Şifreleme:** Yedek, gönderilmeden önce cihazında şifrelenir: şifrenden PBKDF2-SHA256 (600.000 tur, rastgele salt) ile anahtar üretilir, veri AES-GCM 256 ile kilitlenir (her yedekte yeni IV). Google da biz de içeriği göremeyiz.
- **Şifre kurtarılamaz:** Şifre hiçbir yere kaydedilmez, yalnızca uygulama açıkken bellekte durur. Unutursan yedekteki notlar kimse tarafından kurtarılamaz.
- **İzin:** Yalnızca `drive.appdata` izni istenir. Giriş jetonu yalnızca bellekte tutulur; cihazda yalnızca "bağlı" bilgisi, e-posta ipucu ve yedek ayarları saklanır.
- **Otomatik yedek:** İsteğe bağlı, varsayılan kapalı. Yalnızca uygulama açıkken, notlar değiştiyse günde en fazla bir kez çalışır.
- **Geri yükleme:** Yedeği seçip şifreni girersin, sonra "Mevcut notlara ekle" ya da "Mevcut notların yerine koy" seçersin.
