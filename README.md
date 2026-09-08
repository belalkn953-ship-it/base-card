# Base Card — حزمة تشغيلية جاهزة للنشر

منصة شحن ألعاب عربية مبنية بـ Node.js وExpress وSQLite، وتتضمن:

- واجهة عربية متجاوبة للزوار.
- إنشاء طلب مع رقم فريد تلقائيًا.
- اختيار اللعبة والباقة وPlayer ID وبيانات العميل.
- رفع صورة إيصال اختيارية حتى 5MB.
- تتبع الطلب حسب رقم الطلب.
- حالات: قيد الانتظار، قيد المعالجة، مكتمل، مرفوض.
- لوحة إدارة محمية بتسجيل دخول.
- إدارة الألعاب والباقات وإظهارها أو إخفائها.
- إدارة الطلبات وتغيير حالتها وعرض الإيصالات.
- تعديل اسم الموقع والشعار والنصوص ورقم واتساب وحساب شام كاش.
- رفع صورة رمز QR الرسمي لشام كاش وعرضه تلقائيًا للعملاء.
- صندوق رسائل للدعم الفني.
- حماية أساسية عبر Helmet وRate Limit وHttpOnly Sessions.
- دعم PWA: يمكن تثبيته من Google Chrome على الهاتف كاختصار/تطبيق مستقل.
- تسجيل دخول العملاء عبر Google OAuth وربط الطلب بحساب العميل.

## التشغيل محليًا أو على VPS

يتطلب Node.js 18 أو أحدث.

```bash
cp .env.example .env
# عدّل ADMIN_PASSWORD داخل .env قبل التشغيل
npm install
npm start
```

ثم افتح:

- الموقع: `http://YOUR_SERVER:3000/`
- لوحة الإدارة: `http://YOUR_SERVER:3000/admin`

## متغيرات البيئة

- `PORT`: المنفذ، الافتراضي 3000.
- `ADMIN_USERNAME`: اسم المستخدم الأول، الافتراضي admin.
- `ADMIN_PASSWORD`: كلمة مرور المشرف الأول، يجب تغييرها.
- `SESSION_DAYS`: مدة جلسة الدخول بالأيام.
- `NODE_ENV=production`: لتفعيل Secure Cookies عند استخدام HTTPS.
- `GOOGLE_CLIENT_ID` و`GOOGLE_CLIENT_SECRET`: بيانات تطبيق Google OAuth.
- `GOOGLE_CALLBACK_URL`: رابط الرجوع بعد تسجيل الدخول، ويجب أن يكون نفس الرابط المسجل داخل Google OAuth.

## تفعيل تسجيل الدخول عبر Google

أنشئ OAuth Client من Google Cloud Console واختر Web application، ثم أضف رابط الرجوع التالي بعد استبدال النطاق باسم نطاقك:

```text
https://YOUR_DOMAIN/auth/google/callback
```

ضع Client ID وClient Secret في ملف `.env`، ثم أعد تشغيل التطبيق. سيظهر زر **الدخول عبر Google** للزوار، وبعد نجاح الدخول يتم ربط الطلب بحساب العميل.

## النشر باستخدام Docker

```bash
docker build -t base-card .
docker run -d --name base-card \
  -p 3000:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='ضع-كلمة-مرور-قوية-هنا' \
  -e NODE_ENV=production \
  -v base-card-data:/app/data \
  -v base-card-uploads:/app/uploads \
  base-card
```

استخدم Nginx أو منصة استضافة توفر HTTPS أمام المنفذ 3000. احتفظ بمجلدي `data` و`uploads` على قرص دائم حتى لا تضيع الطلبات والإيصالات عند إعادة التشغيل.

## ملاحظات الإنتاج

- لا تستخدم كلمة المرور الافتراضية.
- فعّل HTTPS.
- خذ نسخة احتياطية دورية من `data/base-card.db` ومجلد `uploads`.
- رقم واتساب يجب أن يكون بصيغة دولية بدون علامة + عند إدخاله في لوحة الإدارة، مثل `9639xxxxxxxx`.
- الأسعار تُحفظ كنص حتى يمكن إدخال العملة بالشكل الذي تريده.
