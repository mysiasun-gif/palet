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

## Gizli notlar

Bir notu ⋮ menüsünden "Gizli yap" ile kilitleyebilirsin. Telefonu eline alan biri gizli notun içeriğini şifre olmadan ne uygulamada ne de cihazdaki veride görebilir.

- **Şifreleme:** Şifrenden PBKDF2-SHA256 (600.000 tur, 16 bayt rastgele salt) ile bir anahtar üretilir. Bu anahtar, notları kilitleyen asıl anahtarı (AES-GCM 256) açar. Bellekteki anahtar dışa aktarılamaz. Her gizli notun başlığı, metni ve liste maddeleri tek parça şifrelenir, her kayıtta yeni 12 bayt IV kullanılır. Cihazda yalnızca renk, tarih, sabitleme ve sıra açık kalır.
- **Saklanmayanlar:** Şifre ve anahtar diske yazılmaz. Cihazda sadece salt, sarılmış anahtar ve bir kontrol bloğu (bilinen bir metnin şifreli hâli) durur. Kilitlenince anahtar bellekten silinir.
- **Kilit:** Uygulama arka plana geçince kilitlenir (Hemen, 30 sn, 1 dk ya da 5 dk). Arka plandayken sayfa örtülür. 5 yanlış denemeden sonra bekleme süresi artar (30 sn, 1 dk, 5 dk…), sayaç cihazda kalır.
- **Arama ve bildirim:** Arama gizli notlarda hiçbir zaman eşleşmez. Hatırlatıcı bildiriminde yalnızca "Gizli not" yazar.
- **Yedek:** Dosya ve bulut yedeğinde gizli notlar şifreli kalır. Başka cihazda açmak için o notların şifresi gerekir. Farklı şifreyle gelen notlar kaybolmaz, kilitli kalır ve o şifre sorulur.
- **Parmak izi / yüz:** Yalnızca cihaz WebAuthn PRF desteklerse sunulur. Doğrulama, anahtarı açan gerçek bir sır üretir. Desteklenmiyorsa seçenek kapalıdır.
- **Şifremi unuttum:** Şifre kurtarılamaz. Bu seçenek, "SİL" yazarak onayladığında yalnızca gizli notları siler.
- **Sınırlar:** PWA ekran görüntüsünü engelleyemez. Bir not gizlenmeden önce alınmış yedeklerde o notun açık hâli durabilir. Kısa, yalnızca rakamlı şifreler, cihazın verisi kopyalanırsa denenerek kırılabilir.
