# SupplySys (Strawberry Supply) — Firebase MVP

هذا مشروع MVP لنظام توريد فراولة (مكتب + ميداني) مبني على Firebase:
- Firestore (بيانات تشغيلية)
- Cloud Functions (ترقيم + ترحيل عهد العبوات + ترحيل الاستلام + الشحن + الكرتون)
- Firebase Auth (تسجيل دخول)
- Hosting (Web/PWA)

## المتطلبات
- Node.js 18+
- Firebase CLI
  - npm i -g firebase-tools
- صلاحية على مشروع Firebase: supplysys-2025

## 1) الإعداد الأولي
```bash
firebase login
firebase use supplysys-2025
```

## 2) نشر القواعد والـ Functions
```bash
cd functions
npm i
npm run build
cd ..
firebase deploy --only firestore:rules,functions
```

## 3) تشغيل الويب محليًا
```bash
cd web
npm i
npm run dev
```

## 4) إنشاء مستخدمين وأدوار
هذا الـ MVP يتوقع وجود وثيقة مستخدم داخل:
`orgs/<orgId>/users/<uid>`

مثال:
```json
{
  "orgId": "<orgId>",
  "role": "admin",
  "status": "active",
  "name": "Admin"
}
```

الأدوار المدعومة:
- admin
- ops_manager
- warehouse
- accounting
- field

ملاحظة: إنشاء المستخدم عبر Firebase Auth يتم من الـ Console، ثم تضيف/تعدّل وثيقة المستخدم في Firestore.

## 5) بيانات مبدئية
أنشئ:
- org: `orgs/<orgId>` (مثلاً orgs/main)
- plant: `orgs/<orgId>/plants/plant1`
- farms: `orgs/<orgId>/farms/...`
- cartonItems: `orgs/<orgId>/cartonItems/carton1`

## 6) تدفقات التشغيل الأساسية
- عبوات: Packaging Transfer DRAFT -> postPackagingTransfer()
- استلام فراولة: Inbound Receipt DRAFT -> postInboundReceipt()
- شحن: Shipment DRAFT -> postShipment()
- كرتون: Carton Purchase DRAFT -> postCartonPurchase() / Carton Issue DRAFT -> postCartonIssue()
