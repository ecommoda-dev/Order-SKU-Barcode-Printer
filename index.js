// ══════════════════════════════════════════════════════════════
// EcomModa — Order SKU Barcode Printer Worker (v1.2.0)
// skills: worker-builder v2.1.0 · constants v1.10.0 ·
//         shopify-graphql-helper v1.1.0 — 08-09-2026
// ══════════════════════════════════════════════════════════════
//
// بيرجّع بيانات الباركود عشان الواجهة تطبع ليبل 2×1 إنش:
//   ① `get_order`  — أوردر كامل → بنوده الفعّالة (SKU · barcode · كمية)
//                    بـ `order=` (الاسم) أو `id=` (الـ ID الرقمي — v1.1.0)
//   ② `search_sku` — بحث مباشر بـ SKU أو رقم باركود، **من غير أوردر**
//                    (رجع ليه مستهلك في v1.2.0 — مربع «طباعة بالـ SKU»)
//   ③ `log_print` + `get_logs*` — سجل العمليات (v1.2.0)
//
// 🔴 **صفر كتابة على شوبيفاي — لسه.** ميوتيشن واحدة مافيش. الجديد في
//    v1.2.0 هو كتابة **صف سجل append-only في D1** وبس.
//
//    • Rule 2 (D1 logging) — **الانحراف ده اتقفل في v1.2.0.** الأداة بقت
//      بتكتب `tool = 'order_sku_barcode_printer'` بـ `type` = `print`
//      (ليبلات أوردر) أو `print_sku` (ليبل صنف من غير أوردر). الثمن
//      القديم كان مكتوب صراحةً في `CLAUDE.md`: «مفيش أي أثر لمين طبع إيه
//      وإمتى» — وده بالظبط اللي تاب السجل اتضاف عشانه (قرار أحمد
//      08-09-2026).
//      🔴 **بند مفتوح:** الصف لازم يتسجّل في `ecommoda-constants` §7
//         (Rule 7 — التسجيل **قبل** أول `writeLog`). التسجيل ده بيتعمل في
//         محادثة تحديث مهارات، والبند مكتوب في `CLAUDE.md` §مسائل مفتوحة
//         في الريبوهين.
//    • Rule 3 (Universal D1 Auth) — الأداة **مالهاش واجهة مستقلة**؛
//      مستهلكها الوحيد `sku-barcode.html` جوّه هب مركز عمليات المخزن،
//      والدخول بيحصل هناك عبر `orders-packing-checker-worker` وبيتسجّل
//      تحت `warehouse_ops_center`. فالأداة **بتتطلّب دخول فعلاً**، بس
//      نقطة الدخول مش هنا — فمفيش §SHARED ومفيش endpoints دخول.
//      ⚠️ **وده لسه ساري بعد v1.2.0.** فلتر الموظف في تاب السجل بيتعبّى من
//         `get_employees` بتاع **Worker التغليف** (اللي الصفحة بتناديه أصلاً
//         لتحويل تراكينج بوسطة) — مش من هنا. نسخ §SHARED هنا كان هيدّي
//         نقطة دخول تانية مالهاش لازمة.
//      ⚠️ ونتيجة مباشرة: `employee` بييجي **من العميل** في `log_print` —
//         نفس وضع كل أدوات الستاك النهاردة (الـ Worker بيتحقق من السر مش
//         من هوية الموظف). المحاسبة **شرف مش إثبات**، بالظبط زي ما هو
//         مكتوب في `Warehouse-Operations-Center/CLAUDE.md`.
//
// 🔴 عضو في **مجموعة السر `warehouse_ops`** (`ecommoda-constants` §6) —
//    `WORKER_SECRET` قيمته **نفس قيمة** الطباعة والتغليف وحذف المنتج،
//    عشان الهب يقرا سر واحد من `warehouse_ops_worker_secret`. البصمة
//    القصيرة في `diag` هي اللي بتثبت إن المجموعة متوحّدة فعلاً.
//
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME      = 'order_sku_barcode_printer';
const WORKER_VERSION = '1.2.1';
const SECRET_GROUP   = 'warehouse_ops';
const API_VERSION    = '2026-01';   // صريحة دايمًا — ممنوع "latest"

// سقف بنود الأوردر في نداء واحد. أكبر أوردر في المتجر أقل من ده بفارق
// كبير، بس القطع **بيتبلّغ** عنه في الرد (`itemsTruncated`) بدل ما يعدّي
// في السكوت — ليبل ناقص = قطعة بتخرج من المخزن من غير باركود.
const ORDER_LINE_ITEMS_MAX = 100;

// سقف نتايج البحث المباشر. أعلى من كده يبقى الموظف بيتصفّح كتالوج،
// مش بيدوّر على صنف — والواجهة بتقول إن فيه أكتر.
const SKU_SEARCH_MAX = 50;

// سقف صفوف السجل في نداء واحد — بيرجع للواجهة كـ `cap` مع `total` و
// `truncated` عشان بانر الاقتطاع مايبقاش رقم مكتوب بإيد في الواجهة.
const LOG_EXPORT_MAX = 2000;

// حراس حجم على `log_print` — الدفعة الواقعية أوردر أو تلاتة، والأرقام دي
// **حارس ضد نداء مشوّه**، مش سقف تشغيلي. تخطّيها = 400 صريحة مش قص صامت.
const LOG_MAX_ORDERS = 100;
const LOG_MAX_SKUS   = 200;

// ══════════════════════════════════════════════════════
// §CORS — Option A: Wildcard
// ══════════════════════════════════════════════════════
// (`references/cors-patterns.md`)
//
// ⚠️ **اتراجع تاني في v1.2.0 لما الأداة بقت بتكتب في D1** — والقرار إنه
//    يفضل Option A. قاعدة الاختيار في المهارة بتفرّق بين «أدوات كتابة
//    مالية/تشغيلية» (Option B) و«أدوات قراءة/عرض» (Option A)، والكتابة
//    الوحيدة هنا **صف سجل append-only** تحت اسم الأداة نفسها: صفر لمسة
//    على شوبيفاي، صفر تعديل على أي بيانات قائمة، والحماية الحقيقية —
//    قبل التعديل وبعده — هي `WORKER_SECRET`.
//    ⛔ لو الأداة كتبت يومًا حاجة على شوبيفاي، البند ده يترجع فيه فورًا
//       لـ Option B (allowlist) في **نفس** التسليم.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function getCORS(_req) { return CORS_HEADERS; }

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// متغيّر ناقص لازم يوقف العملية **باسمه** (Step 5A ⑧). من غير الفحص ده
// `SHOP_DOMAIN` الناقص بيرجّع `"error code: 1003" is not valid JSON` —
// رسالة مالهاش أي علاقة بالسبب.
function assertEnv(env, names) {
  const missing = names.filter(n => !String(env[n] ?? '').trim());
  if (missing.length) throw new Error(`متغيّرات ناقصة في الـ Worker: ${missing.join(', ')}`);
}

// بصمة قصيرة للسر — للتأكد إن كل أعضاء مجموعة `warehouse_ops` على نفس
// القيمة (`ecommoda-constants` §6). الطول لوحده **مش كافي**: سرّين
// مختلفين بنفس الطول شكلهم واحد.
//
// ⚠️ ٨ خانات hex من SHA-256 — **مش** قابلة لاسترجاع القيمة، وبتكشف
//    بالظبط الحالتين اللي بيوقعوا: ① عضو لسه على السر القديم
//    ② السر اتضاف والـ Promote ما اتعملش.
async function secretFingerprint(secret) {
  if (!secret) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(buf)].slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// صورة الصنف: صورة المتغيّر أولاً، وبعدين صورة المنتج.
//
// ⚠️ `ProductVariant.image` **مهجورة** في 2026-01 والبديل `media`.
//    والأهم: أغلب متغيّرات المتجر **مالهاش media خاصة بيها**
//    (`media.nodes` بترجع `[]` — اتأكد حيًا على `FL-PO-10 / Black / 43`)،
//    فمن غير الرجوع لصورة المنتج عمود الصورة بيفضل **فاضي دايمًا**.
function pickImage(variant, product) {
  return variant?.media?.nodes?.[0]?.preview?.image?.url
      || product?.featuredMedia?.preview?.image?.url
      || null;
}

// ══════════════════════════════════════════════════════
// §SHARED-LOG — منسوخة حرفيًا من `ecommoda-worker-builder`
//               → `references/shared-functions.md`
// ══════════════════════════════════════════════════════
//
// ⛔ **ممنوع أي تعديل على الدوال دي.** الكتلة دي مشتركة بين كل أدوات
//    الستاك، وأي تعديل محلي فيها بيخلّي السجل هنا يفلتر بشكل مختلف عن
//    اللي جنبه — والفرق **مابيديش أي خطأ**، بس التصدير بينزّل غير
//    المعروض. أي تحسين مكانه المهارة نفسها مش الأداة (درس R1).

// 🔴 **`writeLog` (صف واحد) مش منسوخة هنا عن قصد — والسبب مش تنضيف كود.**
//    وحدة العملية في الأداة دي هي **الدفعة**، مش الصف: ضغطة طباعة واحدة
//    بتنتج صف لكل أوردر. لو الكتابة اتعملت بحلقة `writeLog`، فشل في نص
//    الحلقة بيسيب **نص دفعة مسجّلة** — سجل بيقول إن ٣ أوردرات اتطبعت
//    والحقيقة ٨، من غير أي خطأ ظاهر. `writeLogBatch` تحت بتكتبهم كلهم أو
//    ولا واحد. نسخ `writeLog` جنبها كان هيسيب **مسارين كتابة** يفترقوا مع
//    أول تعديل (درس R1).
//    ⚠️ الشكل (الأعمدة والترتيب والتحويلات) **مطابق لـ `writeLog` بالحرف**
//       — أي حقل جديد في المهارة يتضاف هنا في نفس التمريرة.
async function writeLogBatch(db, entries) {
  if (!entries.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await db.batch(entries.map(entry => stmt.bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  )));
  return entries.length;
}

/**
 * بنّاء شرط الفلترة الموحّد — التلات دوال تحته بتستخدمه، فمفيش SQL مكرر
 * يتعتّق في واحدة ويسيب التانية.
 * ⚠️ `dateFrom`/`dateTo` بيتقارنوا بـ `substr(timestamp,1,10)` = **UTC**،
 *    والعرض بتوقيت القاهرة. الفرق مقبول لفلتر بالأيام — **بس مكتوب**.
 * `login`/`logout` مستثنيين في SQL دايمًا.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

/** صفحة واحدة من السجل — سقف ١٠٠ صف مفروض من السيرفر. */
async function getLogs(db, { limit = 100, offset = 0, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

/** العدّ الحقيقي بنفس الفلاتر — بيتنادى بالتوازي مع الاتنين التانيين. */
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * التصدير — لحد `LOG_EXPORT_MAX`.
 * ⚠️ الدالة دي **بتقص في السكوت** بطبيعتها، فالـ endpoint لازم يرجّع
 *    `cap`/`total`/`truncated` كمان.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/** قراءة فلاتر السجل من الـ query string — مصدر واحد للتلات endpoints. */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}
// ══════════════════════════════════════════════════════
// END §SHARED-LOG
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════
async function getAccessToken(env) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      grant_type:    'client_credentials',
    }),
  });
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in response');
  return data.access_token;
}

// النسخة الكاملة القياسية (`ecommoda-worker-builder` Step 5A ① ·
// `shopify-graphql-helper` Step 1) — نسخة حرفية، بترمي على: فشل شبكة ·
// HTTP status · رد مش JSON · `data.errors` · `data` فاضية.
//
// ⛔ `return resp.json()` عطل مش اختصار — بيخلّي نقص الصلاحية (اللي بيظهر
//    كـ top-level error) يعدّي كأنه رد سليم بداتا فاضية.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: network failure — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: Shopify HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: non-JSON response — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(`${opName}: ${data.errors.map(e => e.message).join(' | ')}` + (codes.length ? ` [${codes.join(',')}]` : ''));
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: response has no data — ${text.slice(0, 180)}`);
    return data;
  }
  throw lastErr || new Error(`${opName}: unknown failure`);
}

// ══════════════════════════════════════════════════════
// §BARCODE — منطق الأداة
// ══════════════════════════════════════════════════════

// ─── §BARCODE::fetchOrderItems ───
//
// 🔴 **الحقول معرّفة مرة واحدة** (`ORDER_FIELDS`) والاستعلامان بينادوها.
//    البحث بالاسم والبحث بالـ ID لازم يرجّعوا **نفس الشكل بالحرف** —
//    نسختين من قايمة الحقول كانتا هيفترقا مع أول حقل جديد، والفرق
//    بيظهر كعمود فاضي في مسار واحد بس (درس R1).
const ORDER_FIELDS = `
        id
        legacyResourceId
        name
        displayFinancialStatus
        displayFulfillmentStatus
        lineItems(first: ${ORDER_LINE_ITEMS_MAX}) {
          pageInfo { hasNextPage }
          nodes {
            title
            sku
            currentQuantity
            variant {
              id
              legacyResourceId
              title
              barcode
              media(first: 1) { nodes { preview { image { url } } } }
              product { id title featuredMedia { preview { image { url } } } }
            }
          }
        }
`;

const Q_ORDER = `
  query OrderItems($q: String!) {
    orders(first: 1, query: $q) {
      nodes {
${ORDER_FIELDS}
      }
    }
  }
`;

// ⚠️ البحث بالـ ID بيستخدم الجذر `order(id:)` مش فلتر `id:` جوّه
//    `orders(query:)` — الفلتر النصي بيرجّع **صفر نتايج بلا أي خطأ** لو
//    الشكل مش مظبوط، والجذر بيرجّع `null` صريحة (نفس عيلة الفخ في
//    `shopify-graphql-helper` Step 3).
const Q_ORDER_BY_ID = `
  query OrderById($id: ID!) {
    order(id: $id) {
${ORDER_FIELDS}
    }
  }
`;

// بيحوّل رد شوبيفاي للشكل اللي الواجهة بتقراه. **المسارين بيعدّوا من
// هنا** — مفيش تشكيل تاني في أي مكان.
function shapeOrder(order) {
  const li = order.lineItems || {};
  const items = (li.nodes || [])
    // ⚠️ `currentQuantity` مش `quantity` — التانية بتشمل البنود الملغية،
    //    يعني ليبل بيتطبع لصنف اتشال من الأوردر.
    .filter(n => (n.currentQuantity || 0) > 0)
    .map(n => ({
      title:        n.title,
      sku:          n.sku || null,
      // ⚠️ ده رقم الـ Barcode الفعلي من المتغيّر — **ده** اللي بيتشفّر في
      //    الباركود المطبوع، مش الـ SKU النصي. مؤكَّد بمقارنة أوردر #53768
      //    بتطبيق "Retail Force Barcode" الحالي (06-09-2026).
      barcode:      n.variant?.barcode || null,
      quantity:     n.currentQuantity,
      variantTitle: (n.variant?.title && n.variant.title !== 'Default Title') ? n.variant.title : null,
      variantId:    n.variant?.legacyResourceId || null,
      image:        pickImage(n.variant, n.variant?.product),
    }));

  return {
    // 🔴 الـ ID الرقمي إلزامي جنب اسم الأوردر — الواجهة بتبني بيه لينك
    //    صفحة الأوردر على شوبيفاي (`ecommoda-worker-builder` Step 5).
    orderId:           order.legacyResourceId,
    orderName:         order.name,
    financialStatus:   order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    items,
    // القطع **بيتبلّغ عنه** — ليبل ناقص في السكوت = قطعة بتخرج من المخزن
    // من غير باركود.
    itemsTruncated: !!li.pageInfo?.hasNextPage,
    itemsCap:       ORDER_LINE_ITEMS_MAX,
  };
}

async function fetchOrderItems(env, token, rawOrder) {
  // تطبيع اسم الأوردر — فلتر `name:` بيطلب الـ `#`
  // (`shopify-graphql-helper` Step 3).
  const orderName = rawOrder.startsWith('#') ? rawOrder : '#' + rawOrder;

  const data = await shopifyGQL(env, token, Q_ORDER, { q: `name:${orderName}` }, 'get_order');
  const order = data?.data?.orders?.nodes?.[0];
  if (!order) return null;
  return shapeOrder(order);
}

// ─── §BARCODE::fetchOrderById (v1.1.0) ───
//
// 🔴 **ده اللي بيخلّي ماسح باركود شوبيفاي يشتغل.** باركود الأوردر
//    المطبوع بيشفّر الـ **ID الرقمي** (١٠ أرقام فأكتر) مش اسم الأوردر
//    (٥ أرقام)، فبحث `name:` عليه بيرجّع 404 على أوردر موجود فعلاً.
//    نفس التفرقة الموجودة في `orders-packing-checker-worker`.
//
// ⚠️ الرقم بيتفحص إنه **أرقام بس** قبل ما يتركّب في الـ GID — من غير
//    الفحص ده أي نص بيتحقن في معرّف شوبيفاي.
async function fetchOrderById(env, token, rawId) {
  if (!/^\d+$/.test(rawId)) return null;
  const data = await shopifyGQL(
    env, token, Q_ORDER_BY_ID, { id: `gid://shopify/Order/${rawId}` }, 'get_order_by_id');
  const order = data?.data?.order;
  if (!order) return null;
  return shapeOrder(order);
}

// ─── §BARCODE::searchVariants ───
const Q_VARIANTS = `
  query SkuLookup($q: String!, $n: Int!) {
    productVariants(first: $n, query: $q) {
      pageInfo { hasNextPage }
      nodes {
        id
        legacyResourceId
        sku
        barcode
        title
        displayName
        media(first: 1) { nodes { preview { image { url } } } }
        product { id title status featuredMedia { preview { image { url } } } }
      }
    }
  }
`;

// بحث مباشر من غير أوردر — لإعادة طباعة ليبل ضاع.
//
// ✅ **رجع ليه مستهلك في v1.2.0** بعد ما فضل بلا مستهلك من هب v1.10.0:
//    مربع «طباعة بالـ SKU» في `sku-barcode.html` بينادي المسار ده بالـ SKU
//    الكامل زي ما هو مسجّل على شوبيفاي (`RN-AD-115 / Black / 45`).
//    ⚠️ يعني البند اللي كان مفتوح («يتشال ولا يفضل؟») **اتقفل بالإبقاء** —
//       والشيل بقى تغيير كاسر، مش تنضيف.
//
// ⚠️ `sku:` و`barcode:` **صالحين على `productVariants`** ومش صالحين على
//    `orders` (اللي بيرجّع صفر نتايج بلا أي خطأ — `shopify-graphql-helper`
//    Step 3). اتأكد حيًا 06-09-2026 على `FL-PO-10` و`34271298`.
// 🔴 **الباج اللي النسخة دي اتكتبت عشانه (v1.2.1):** الاستعلام القديم كان
//    `(sku:${term}*) OR (barcode:${term})` بالمدخل **زي ما هو**. الـ SKU
//    عندنا فيه **مسافات وشرطات مايلة** (`SD1 / Light grey / 45`)، وبحث
//    شوبيفاي بيقسّم النص ده لكلمات منفصلة — فـ `Light` و`grey` بقوا شروط
//    بحث عامة، والنتيجة **صفر** على SKU **موجود فعلاً**. ⚠️ وطبعًا **من
//    غير أي خطأ**: الرد `200` بمصفوفة فاضية، والواجهة بتقول «مفيش أي صنف
//    بالـ SKU ده على شوبيفاي» على صنف قدام الموظف في الجدول.
//
// 🔴 **الحل: كل كلمة في المدخل بتبقى شرط `sku:` لوحده، والشروط بـ `AND`.**
//    `SD1 / Light grey / 45` → `(sku:SD1*) AND (sku:Light*) AND (sku:grey*)
//    AND (sku:45*)`. اتأكّد **حيًا** على المتجر (08-09-2026): الشكل ده
//    بيرجّع الصنف الواحد بالظبط، والجزئي (`SD1 / Light`) بيرجّع الأربعة
//    مقاسات — يعني نفس الاستعلام بيخدم البحث الكامل والجزئي.
//    ⚠️ **`sku:"..."` (اقتباس) بيشتغل للتطابق التام بس** — اتجرّب حيًا
//       ورجّع الصنف صح، بس `sku:"SD1 / Light"` رجّع **صفر**، يعني كان
//       هيكسر البحث الجزئي اللي القايمة المنسدلة قايمة عليه.
//    ⚠️ **النجمة على كل كلمة مقصودة** — `45*` بيطابق `45` بالظبط كمان،
//       والمقاس آخر كلمة في الـ SKU فمن غير النجمة الكلمة الناقصة وانت
//       بتكتب مابتطابقش حاجة.
//
// ⚠️ **`barcode:` بيتضاف بس لما المدخل كله رقم صافي** — الباركود رقم
//    مالوش مسافات، وخلطه في استعلام فيه `AND` كان بيخلّي أسبقية
//    `AND`/`OR` غامضة والنتيجة بتفرق من مدخل للتاني.
function buildSkuQuery(term) {
  // شيل اللي بيكسر بنية الاستعلام نفسه (اقتباس · قوس · نجمة مكتوبة
  // بالإيد · نقطتين) — مش تطبيع للمعنى، ده تنضيف بنية.
  const tokens = String(term).replace(/["\\()*:]/g, ' ').split(/[\s/]+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    return `(sku:${tokens[0]}*) OR (barcode:${tokens[0]})`;
  }
  return tokens.map(t => `(sku:${t}*)`).join(' AND ');
}

async function searchVariants(env, token, term) {
  const q = buildSkuQuery(term);
  // مدخل كله رموز — نرجّع فاضي **من غير نداء**، بدل استعلام مشوّه.
  if (!q) return { variants: [], truncated: false, cap: SKU_SEARCH_MAX };

  const data = await shopifyGQL(env, token, Q_VARIANTS, { q, n: SKU_SEARCH_MAX }, 'search_sku');
  const conn = data?.data?.productVariants || {};

  const variants = (conn.nodes || []).map(v => ({
    variantId:   v.legacyResourceId,
    sku:         v.sku || null,
    barcode:     v.barcode || null,
    title:       v.product?.title || v.displayName || '',
    variantTitle: (v.title && v.title !== 'Default Title') ? v.title : null,
    productStatus: v.product?.status || null,
    image:       pickImage(v, v.product),
  }));

  return {
    variants,
    // القطع هنا **مش** نفس خطورة قطع الأوردر (الموظف بيدوّر مش بيطبع
    // دفعة)، بس برضه بيتقال بدل ما يفتكر إن دي كل النتايج.
    truncated: !!conn.pageInfo?.hasNextPage,
    cap:       SKU_SEARCH_MAX,
  };
}

// ══════════════════════════════════════════════════════
// §PRINT-LOG — تحويل دفعة الطباعة لصفوف D1 (v1.2.0)
// ══════════════════════════════════════════════════════
//
// 🔴 **صف لكل أوردر، مش صف للدفعة كلها ولا صف لكل ليبل.**
//    · صف للدفعة كله = عمود `order_name` فاضي، والسجل بيبقى مش قابل
//      للبحث برقم أوردر — وده **أول** سؤال بيتسأل («الأوردر ده اتطبع
//      ليبله ولا لأ؟»). و`buildLogFilterSQL` بيبحث في `order_name` أصلاً.
//    · صف لكل ليبل = دفعة ٤٢ ليبل بتكتب ٤٢ صف، والجدول بيبقى ضوضاء.
//    الأصناف وأعداد النسخ بتتحفظ في `extra.items` — تفصيلة بتتقرا لما
//    تتطلب، مش صف في الجدول.
//
// 🔴 **ليبل بلا أوردر (`type = 'print_sku'`) بياخد صف لكل صنف** — هنا
//    الصنف **هو** وحدة العملية (مفيش أوردر يجمّعه)، فالـ `sku` لازم يبقى
//    في عموده عشان الفلتر والتصدير يشوفوه.
//
// ⚠️ كل الصفوف بتتكتب بـ **نفس** `timestamp` — الدفعة عملية واحدة، ولو كل
//    صف أخد وقته الصفوف بتتفرّق في الترتيب وتبان كأنها عمليات منفصلة.
function buildPrintLogRows(body) {
  const employee = String(body?.employee || '').trim() || null;
  const orders   = Array.isArray(body?.orders)   ? body.orders   : [];
  const skuItems = Array.isArray(body?.skuItems) ? body.skuItems : [];

  if (!employee) throw new Error('اسم الموظف مطلوب في تسجيل الطباعة');
  if (orders.length > LOG_MAX_ORDERS)  throw new Error(`عدد الأوردرات أكبر من الحد (${LOG_MAX_ORDERS})`);
  if (skuItems.length > LOG_MAX_SKUS)  throw new Error(`عدد الأصناف أكبر من الحد (${LOG_MAX_SKUS})`);
  if (!orders.length && !skuItems.length) throw new Error('مفيش أي ليبل في الدفعة');

  const timestamp = new Date().toISOString();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
  const str = (v, max = 300) => (v === null || v === undefined) ? null : String(v).slice(0, max);

  // العدد الكلي بيتحسب **هنا من نفس المصفوفات** — مش بيتقرا من حقل
  // بيبعته العميل. رقم بيبعته العميل جنب التفاصيل اللي بتناقضه = صف
  // بيكدب من غير أي خطأ.
  const orderLabels = orders.reduce(
    (s, o) => s + (Array.isArray(o?.items) ? o.items.reduce((a, i) => a + num(i?.copies), 0) : 0), 0);
  const skuLabels   = skuItems.reduce((s, i) => s + num(i?.copies), 0);
  const batchTotal  = orderLabels + skuLabels;

  const rows = [];

  for (const o of orders) {
    const items  = (Array.isArray(o?.items) ? o.items : [])
      .map(i => ({ sku: str(i?.sku, 120), barcode: str(i?.barcode, 60), copies: num(i?.copies) }))
      .filter(i => i.copies > 0);
    const labels = items.reduce((s, i) => s + i.copies, 0);
    if (!labels) continue;   // أوردر كل أصنافه على صفر = ما اتطبعش، فمفيش صف

    rows.push({
      tool: TOOL_NAME, type: 'print', timestamp, employee,
      orderId:   str(o?.orderId, 40),
      orderName: str(o?.orderName, 40),
      // `delta` = عدد الليبلات اللي خرجت من الطابعة للأوردر ده. ده الرقم
      // الوحيد اللي ينفع يتجمّع في تقرير بعدين.
      delta: labels,
      notes: `${labels} ليبل · ${items.length} صنف`,
      extra: { source: str(o?.source, 20) || 'manual', items, batchTotal },
    });
  }

  for (const i of skuItems) {
    const copies = num(i?.copies);
    if (!copies) continue;
    rows.push({
      tool: TOOL_NAME, type: 'print_sku', timestamp, employee,
      sku:          str(i?.sku, 120),
      productTitle: str(i?.title, 250),
      delta:        copies,
      notes:        `${copies} ليبل · بدون أوردر`,
      extra: { source: 'sku', barcode: str(i?.barcode, 60), batchTotal },
    });
  }

  if (!rows.length) throw new Error('مفيش أي ليبل بعدد نسخ أكبر من صفر');
  return rows;
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // ① OPTIONS preflight — دايمًا الأول
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCORS(request) });
    }

    // ② WORKER_SECRET — دايمًا التاني
    const auth = request.headers.get('Authorization') || '';
    if (!env.WORKER_SECRET || auth !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401, request);
    }

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      // ─── §CONFIG ──────────────────────────────────────────
      // بيكشف Promote ناقص وWorker شبح — الواجهة بتقارنه بحدها الأدنى.
      if (action === 'get_config') {
        return json({
          ok: true,
          tool:    TOOL_NAME,
          version: WORKER_VERSION,
          group:   SECRET_GROUP,
        }, 200, request);
      }

      // ─── §DIAG ────────────────────────────────────────────
      // فحص ذاتي بدون أي كتابة. ⚠️ **ممنوع يرجّع قيمة أي سر** — الأسماء
      // والأطوال والبصمة بس.
      //
      // الشكل **مصفوفة** `[{ ok, label, detail }]` — الشكل المعتمد لأي
      // Worker جديد، و`ok` صريحة عشان المستهلك مايخمّنش
      // (`ecommoda-worker-builder` Step 5A ⑨).
      if (action === 'diag') {
        const checks = [];

        // ① المتغيّرات — الطول بيكشف المسافة المخفية في القيمة
        for (const name of ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET', 'WORKER_SECRET']) {
          const len = String(env[name] ?? '').length;
          checks.push({
            ok:     len > 0,
            label:  name,
            detail: len ? `مضبوط (${len} حرف)` : 'ناقص — ضيفه من الداشبورد وبعدين Promote',
          });
        }

        // ② بصمة السر — إثبات إن أعضاء المجموعة على نفس القيمة
        const fp = await secretFingerprint(env.WORKER_SECRET);
        checks.push({
          ok:     !!fp,
          label:  'بصمة السر',
          detail: fp ? `${fp} · مجموعة ${SECRET_GROUP}` : 'مفيش سر',
        });

        // ②-ب D1 (v1.2.0) — الـ binding **و** إن الجدول بيتقري فعلاً.
        //    ⚠️ وجود `env.DB` لوحده **مش كفاية**: binding موجود على قاعدة
        //       غلط بيرمي عند أول استعلام مش عند الربط، وتاب السجل ساعتها
        //       بيبان فاضي من غير أي سبب مكتوب. عشان كده الفحص **بيعدّ
        //       صفوف الأداة فعلاً**.
        if (!env.DB) {
          checks.push({ ok: false, label: 'D1 (DB)', detail: 'الـ binding ناقص — ضيف [[d1_databases]] وانشر' });
        } else {
          try {
            const n = await getLogsCount(env.DB, { tool: TOOL_NAME });
            checks.push({ ok: true, label: 'D1 (DB)', detail: `متصل — ${n} صف تحت ${TOOL_NAME}` });
          } catch (e) {
            checks.push({ ok: false, label: 'D1 (DB)', detail: `FAILED: ${e.message}` });
          }
        }

        // ③ شوبيفاي — OAuth + الصلاحيات
        //    ⚠️ `read_products` **مطلوبة**، مش `read_orders` بس: الباركود
        //       جاي من المتغيّر، و`search_sku` بيستعلم `productVariants`
        //       مباشرة. من غيرها البحث بيرجّع فاضي بخطأ صلاحية.
        try {
          const token = await getAccessToken(env);
          const d = await shopifyGQL(env, token,
            `{ currentAppInstallation { accessScopes { handle } } shop { myshopifyDomain } }`,
            {}, 'diag');
          const scopes = (d?.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
          checks.push({ ok: true, label: 'شوبيفاي OAuth', detail: `متصل — ${d?.data?.shop?.myshopifyDomain || '—'}` });
          for (const need of ['read_orders', 'read_products']) {
            checks.push({
              ok:     scopes.includes(need),
              label:  `صلاحية ${need}`,
              detail: scopes.includes(need) ? 'موجودة' : 'ناقصة — ضيفها في الـ Custom App',
            });
          }
          checks.push({ ok: true, label: 'accessScopes', detail: scopes.join(', ') || '—' });
        } catch (e) {
          checks.push({ ok: false, label: 'شوبيفاي OAuth', detail: `FAILED: ${e.message}` });
        }

        return json({
          ok: true, tool: TOOL_NAME, version: WORKER_VERSION,
          origin: request.headers.get('Origin') || '—',
          checks,
        }, 200, request);
      }

      // ─── §BARCODE ─────────────────────────────────────────
      if (action === 'get_order') {
        assertEnv(env, ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET']);
        // `id=` = الـ ID الرقمي (باركود الأوردر المطبوع) · `order=` = الاسم.
        // الاتنين بيرجّعوا **نفس الشكل** من `shapeOrder`.
        const rawId = (url.searchParams.get('id')    || '').trim();
        const raw   = (url.searchParams.get('order') || '').trim();
        if (!rawId && !raw) return json({ error: 'رقم الأوردر مطلوب' }, 400, request);

        const token  = await getAccessToken(env);
        const result = rawId ? await fetchOrderById(env, token, rawId)
                             : await fetchOrderItems(env, token, raw);
        if (!result) {
          const shown = rawId ? `ID ${rawId}` : (raw.startsWith('#') ? raw : '#' + raw);
          return json({ error: `الأوردر ${shown} مش موجود` }, 404, request);
        }
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'search_sku') {
        assertEnv(env, ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET']);
        const term = (url.searchParams.get('term') || '').trim();
        if (!term)             return json({ error: 'اكتب SKU أو رقم باركود' }, 400, request);
        if (term.length < 3)   return json({ error: 'اكتب ٣ حروف على الأقل' }, 400, request);

        const token = await getAccessToken(env);
        const result = await searchVariants(env, token, term);
        return json({ ok: true, term, ...result }, 200, request);
      }

      // ─── §LOG (v1.2.0) ────────────────────────────────────
      //
      // 🔴 **الحارس ده مش رفاهية.** من غير `env.DB` الاستعلام بيرمي
      //    `Cannot read properties of undefined` — رسالة مالهاش أي علاقة
      //    بالسبب (`binding` ناقص أو Promote ما اتعملش). نفس منطق
      //    `assertEnv` مع المتغيّرات.
      if (action === 'log_print' || action.startsWith('get_logs')) {
        if (!env.DB) {
          return json({ error: 'binding قاعدة البيانات (DB) ناقص في الـ Worker — راجع النشر' }, 500, request);
        }
      }

      // ⚠️ **POST مش GET.** الكتابة عمرها ما بتكون على GET — أي prefetch
      //    أو إعادة تحميل للرابط كان هيكتب صف تاني.
      if (action === 'log_print') {
        if (request.method !== 'POST') return json({ error: 'log_print لازم POST' }, 405, request);

        let body;
        try { body = await request.json(); }
        catch { return json({ error: 'الرد مش JSON صالح' }, 400, request); }

        let rows;
        try { rows = buildPrintLogRows(body); }
        catch (e) { return json({ error: e.message }, 400, request); }

        // الدفعة كلها أو ولا حاجة — التفاصيل فوق جنب `writeLogBatch`.
        const n = await writeLogBatch(env.DB, rows);
        return json({ ok: true, rows: n }, 200, request);
      }

      if (action === 'get_logs') {
        const p      = logParamsFrom(url, TOOL_NAME);
        const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '100'), 100);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),    0);
        const entries = await getLogs(env.DB, { ...p, limit, offset });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // 🔴 **`entries` لوحدها ممنوعة.** `getLogsExport` بتقص عند السقف من
      //    غير أي إشارة، والواجهة ساعتها بتقول «تم تصدير 2000 عملية ✓» على
      //    ملف ناقص. `cap` و`total` و`truncated` **جزء من العقد**.
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX }, 200, request);
      }

      return json({ error: `action غير معروف: ${action}` }, 400, request);
    } catch (e) {
      return json({ error: e.message || 'خطأ غير متوقع' }, 500, request);
    }
  },
};
