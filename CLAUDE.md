<div dir="rtl" style="text-align: right;">

# طباعة باركود SKU — Order SKU Barcode Printer (`Order-SKU-Barcode-Printer`)

![version](https://img.shields.io/badge/version-v1.0.0-blue)

**بتعمل إيه:** بترجّع بيانات الباركود عشان تتطبع ليبل **٢×١ إنش** لكل صنف —
نص الـ SKU فوق، وتحته باركود `CODE128` بيشفّر **رقم الـ Barcode** المسجّل على
المتغيّر في شوبيفاي.
**مين بيستخدمها:** المخزن — استقبال بضاعة جديدة، وإعادة طباعة ليبل ضاع.
**الإصدار:** الـ Worker `v1.0.0` (`WORKER_VERSION` في `index.js`)

> 🔴 **الريبو ده فيه الـ Worker بس.** الواجهة **مش هنا** — هي صفحة
> `sku-barcode.html` جوّه هب
> [`Warehouse-Operations-Center`](https://github.com/ecommoda-dev/Warehouse-Operations-Center).
> مفيش `index.html` هنا، ومفيش GitHub Pages مطلوبة من الريبو ده.

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Warehouse-Operations-Center/sku-barcode.html
الـ Worker : https://order-sku-barcode-printer-worker.ecommoda-dev.workers.dev
مجموعة السر : warehouse_ops          ← ecommoda-constants §6
tool في D1  : — (مفيش · الأداة مابتكتبش أي صف)
```

## 🔴 الانحرافان المعتمدان عن `ecommoda-worker-builder`

الأداة بتكسر بندين من Step 2 **بقرار صريح** (أحمد، 06-09-2026). البندان لسه
ساريان بالكامل على أي أداة تانية.

### الانحراف ١ — Rule 2: «D1 for logging (`DB` binding, always)»

**الأداة مابتكتبش أي صف.** مفيش `[[d1_databases]]` في `wrangler.toml`، ومفيش
`writeLog`، ومفيش قيمة `tool` مسجّلة في `ecommoda-constants` §7.

| | الحالة |
|---|---|
| كتابة على شوبيفاي | ❌ صفر — قراءة بحتة |
| كتابة في D1 | ❌ صفر |
| قيمة `tool` جديدة | ❌ مفيش |
| تاب سجل عمليات | ❌ مفيش (مافيش سجل يتعرض أصلاً) |

> ⚠️ **الثمن اللي لازم يتقال:** مفيش أي أثر لمين طبع إيه وإمتى. لو اتطبع
> باركود غلط على منتج، **مفيش طريقة تعرف مين ولا إمتى**. القرار اتاخد على
> أساس إن الأداة قراءة بحتة ومفيش فعل هدّام فيها — الطباعة نفسها بتحصل على
> ورق مش على البيانات.
>
> **لو اتقرر يتسجّل بعدين:** الصف `order_sku_barcode_printer` يتسجّل في
> `ecommoda-constants` §7 **قبل** أول `writeLog` (Rule 7 — مش بعده)، ويتضاف
> `[[d1_databases]]` في `wrangler.toml`، وتترفع نسخة الـ Worker والحد الأدنى
> في الهب في **نفس التسليم**.

### الانحراف ٢ — Rule 3: «Every tool requires login»

**الأداة بتتطلّب دخول فعلاً — بس نقطة الدخول مش هنا.** مستهلكها الوحيد صفحة
جوّه الهب، وأول سطر في الصفحة `requireSession()`. الدخول بيحصل في
`index.html` بتاع الهب عبر `orders-packing-checker-worker`، وبيتسجّل تحت
`warehouse_ops_center` بـ `appId`.

يعني: **مفيش §SHARED هنا، ومفيش `check_employee`/`register_pin`/
`verify_employee`/`log_logout`** — نسخ الكتلة دي كان هيدّي نقطة دخول تانية
مالهاش لازمة وسر إضافي يتدار.

> ⚠️ لو اتعمل للأداة دي **واجهة مستقلة** يومًا ما، البند ده بيرجع ساري
> بالكامل: الكتلة بتتنسخ حرفيًا من `references/shared-functions.md` والـ
> endpoints من `references/auth-endpoints.md`.

## 🔴 مجموعة السر `warehouse_ops` — العضو الرابع

`WORKER_SECRET` هنا **مش قيمة فريدة** — هو **نفس** قيمة الطباعة والتغليف
وحذف المنتج (`ecommoda-constants` §6).

| العضو | النوع |
|---|---|
| `order-printer-worker` | Worker |
| `orders-packing-checker-worker` | Worker |
| `order-item-remover-worker` | Worker |
| **`order-sku-barcode-printer-worker`** | **Worker (انضم 06-09-2026)** |
| `Warehouse-Operations-Center` | واجهة (هب) — `warehouse_ops_worker_secret` |

**السبب:** الهب شاشة إعدادات واحدة بحقل سر واحد. حقل لكل Worker معناه إن
الموظف هيلزق نفس القيمة أربع مرات — نفس النتيجة الأمنية بتكلفة تشغيلية أعلى.

> 🔴 **ده معناه إن `1.html` القديم بيقف.** النموذج الأولي كان بيقرا
> `order_sku_barcode_printer_worker_secret` وبسر خاص بيه؛ أول ما السر يتحوّل
> لقيمة المجموعة، الملف ده بيرجّع `401`. ده **متوقّع ومقصود** (قاعدة ٣ في
> §6): الملف نموذج أولي متجمّد، والواجهة الحقيقية في الهب.

> ⚠️ **التدوير بيمسّ الأربعة + الهب.** الإجراء الكامل في
> `ecommoda-constants` §6 — والبصمة القصيرة في `?action=diag` هي اللي بتثبت
> إن الأربعة على نفس القيمة (**الطول لوحده مش كافي**).

## الـ Endpoints

| الـ action | بيعمل إيه | الميثود |
|---|---|---|
| `get_order` | بنود الأوردر الفعّالة (SKU · barcode · كمية · صورة) + `orderId` | GET |
| `search_sku` | بحث في متغيّرات المنتجات بـ SKU أو رقم باركود — **من غير أوردر** | GET |
| `get_config` | `version` — الهب بيقارنه بالحد الأدنى (`barcode.min`) | GET |
| `diag` | فحص ذاتي: المتغيّرات · بصمة السر · OAuth · الصلاحيات | GET |

كلهم بيتطلّبوا `Authorization: Bearer <WORKER_SECRET>`، و`OPTIONS` بيرجّع 204.

### `get_order` — شكل الرد

```json
{
  "ok": true,
  "orderId": "6349...", "orderName": "#53768",
  "financialStatus": "PENDING", "fulfillmentStatus": "UNFULFILLED",
  "items": [
    { "title": "...", "sku": "FL-PO-10 / Black / 43", "barcode": "34271298",
      "quantity": 1, "variantTitle": "43", "variantId": "5592...", "image": "https://..." }
  ],
  "itemsTruncated": false, "itemsCap": 100
}
```

### `search_sku` — شكل الرد

```json
{ "ok": true, "term": "FL-PO-10",
  "variants": [ { "variantId": "...", "sku": "...", "barcode": "...",
                  "title": "...", "variantTitle": "43",
                  "productStatus": "ACTIVE", "image": "https://..." } ],
  "truncated": false, "cap": 50 }
```

## 🔴 الفخاخ — اللي لازم يتقرا قبل أي تعديل

### ① الباركود بيشفّر `barcode` مش `sku`

النص اللي فوق الليبل هو **الـ SKU** (`FL-PO-10 / Black / 43`)، والرقم اللي
جوّه الخطوط هو **الـ Barcode** (`34271298`). **الاتنين مختلفين تمامًا**،
وعكسهم بيخلّي السكانر يقرا رقم مالوش وجود في المخزون — **من غير أي خطأ ظاهر**.

اتأكّد حيًا بمقارنة أوردر `#53768` بتطبيق «Retail Force Barcode» الحالي
(06-09-2026).

### ② `sku:` و`barcode:` صالحين على `productVariants` بس

```
✅ productVariants(query: "sku:FL-PO-10*")     ← شغّال، متأكَّد حيًا
✅ productVariants(query: "barcode:34271298")  ← شغّال، متأكَّد حيًا
❌ orders(query: "sku:...")                    ← بيرجّع صفر نتايج **بلا أي خطأ**
```

الفلتران دول ممنوعين على `orders` (`shopify-graphql-helper` Step 3) — والفشل
**صامت**، يعني الأداة تبان شغّالة وهي بترجّع فاضي.

> ⚠️ **النجمة في `sku:${term}*` مقصودة** — الـ SKU عندنا بيشمل اللون والمقاس
> (`FL-PO-10 / Black / 43`)، فبحث بالجزء الأول من غير نجمة بيرجّع صفر.

### ③ `read_products` صلاحية إلزامية — مش `read_orders` بس

رقم الـ Barcode جاي من **المتغيّر**، و`search_sku` بيستعلم `productVariants`
مباشرة. من غير `read_products` الاتنين بيفشلوا بـ top-level error.
`?action=diag` بيفحص الصلاحيتين بالاسم.

### ④ `currentQuantity` مش `quantity`

التانية بتشمل البنود **الملغية** — يعني ليبل بيتطبع لصنف اتشال من الأوردر.

### ⑤ صورة المنتج fallback إلزامي

`ProductVariant.image` مهجورة في `2026-01`، والبديل `media`. **والأهم:** أغلب
متغيّرات المتجر `media.nodes` بترجع `[]` (اتأكّد حيًا على
`FL-PO-10 / Black / 43`) — فمن غير الرجوع لـ `product.featuredMedia` عمود
الصورة بيفضل **فاضي دايمًا**. ده بالظبط اللي كان بيحصل في النموذج الأولي.

### ⑥ القطع بيتبلّغ عنه — مايعدّيش في السكوت

`ORDER_LINE_ITEMS_MAX = 100` و`SKU_SEARCH_MAX = 50`. لما السقف يتضرب، الرد
بيشيل `itemsTruncated` / `truncated` والواجهة بتعرض بانر أصفر. **ليبل ناقص في
السكوت = قطعة بتخرج من المخزن من غير باركود** والموظف فاكر إنه طبع كل حاجة.

## `wrangler.toml` — اللي مطلوب

```toml
name = "order-sku-barcode-printer-worker"   # لازم يطابق الداشبورد بالحرف
[vars]
SHOP_DOMAIN = "6c7e1a-53.myshopify.com"
```

**الأسرار (الداشبورد + Promote، مش في الريبو):**
`WORKER_SECRET` (قيمة `warehouse_ops`) · `CLIENT_ID` · `CLIENT_SECRET`.

## النشر — الحالة الحالية

> 🔴 **الـ Worker لسه مرفوع يدوي من الداشبورد (نسخة النموذج الأولي).**
> الريبو ده لسه **مش مربوط بـ Cloudflare Workers Builds**. الخطوات المطلوبة
> مرة واحدة:
>
> ① Cloudflare → الـ Worker → Settings → Build → **Connect to Git** →
>    `ecommoda-dev/Order-SKU-Barcode-Printer` · فرع `main` · Root `/`
> ② أول `git push` بيعمل build وينشر `index.js` بدل النسخة اليدوية
> ③ حدّث `WORKER_SECRET` لقيمة مجموعة `warehouse_ops` → **Promote**
> ④ تأكد إن **عدد الـ Workers ما زادش** — اختلاف الاسم بيعمل Worker شبح
> ⑤ `?action=diag` من الهب: البصمة لازم تطابق باقي المجموعة، و`read_products` ✅

> ⚠️ **ممنوع لصق الكود في Quick Editor بعد الربط** — أول push بيدهسه والريبو
> يبقى مش مطابق للمنشور. الإجراء الكامل والفخاخ الستة →
> `ecommoda-tool-migration-playbook`.

## مسائل مفتوحة

- 🔴 **ربط Workers Builds لسه ما اتعملش** — النسخة المنشورة دلوقتي هي كود
  النموذج الأولي اليدوي (بلا `get_config` وبلا `search_sku`)، فالهب هيعرض
  «⚠️ Worker باركود SKU نسخة قديمة» لحد ما يتنشر من الريبو.
- 🔴 **`WORKER_SECRET` لسه بقيمته الخاصة** — لحد ما يتحوّل لقيمة
  `warehouse_ops` + Promote، صفحة الهب هترجّع `401`.
- 🟡 **`1.html` نموذج أولي متجمّد** — متساب للرجوع التاريخي وبس. **ممنوع
  يتعدّل**: هو بيقرا مفتاح سر قديم، وهيبطل يشتغل بعد انضمام الأداة للمجموعة.
  الواجهة الحقيقية `sku-barcode.html` في الهب.
- 🟢 **مفيش تسجيل D1** — بقرار (فوق). لو اتغيّر، الصف يتسجّل في §7 الأول.
- 🟢 **مفيش pagination على بنود الأوردر** — سقف ١٠٠ بند وبانر عند القطع.
  أوردر أكبر من كده ما حصلش في المتجر لحد دلوقتي.

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v2.1.0 |
| ecommoda-constants | v1.10.0 |
| shopify-graphql-helper | v1.1.0 |
| ecommoda-tool-migration-playbook | §13 (Promote) · §الربط بـ Builds |

آخر مطابقة: 06-09-2026 · `index.js` v1.0.0
🔴 معلّقة: — لا شيء

---

آخر تحديث: 06-09-2026 — 21:30

</div>
