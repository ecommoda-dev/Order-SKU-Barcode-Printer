// ══════════════════════════════════════════════════════════════
// EcomModa — Order SKU Barcode Printer Worker (v1.0.0)
// skills: worker-builder v2.1.0 · constants v1.10.0 ·
//         shopify-graphql-helper v1.1.0 — 06-09-2026
// ══════════════════════════════════════════════════════════════
//
// بيرجّع بيانات الباركود عشان الواجهة تطبع ليبل 2×1 إنش:
//   ① `get_order`  — أوردر كامل → بنوده الفعّالة (SKU · barcode · كمية)
//   ② `search_sku` — بحث مباشر بـ SKU أو رقم باركود، **من غير أوردر**
//
// 🔴 **قراءة بحتة.** صفر كتابة على شوبيفاي · صفر كتابة في D1 · صفر
//    ميوتيشن. الانحرافان الموثّقان عن `ecommoda-worker-builder` Step 2:
//
//    • Rule 2 (D1 logging) — الأداة **مابتكتبش أي صف**، فمفيش `DB` binding
//      ومفيش `writeLog` ومفيش قيمة `tool` في `ecommoda-constants` §7.
//      قرار أحمد 06-09-2026. لو اتقرر تسجيل الطباعة بعدين، الصف يتسجّل
//      في §7 **قبل** أول `writeLog` — مش بعده.
//    • Rule 3 (Universal D1 Auth) — الأداة **مالهاش واجهة مستقلة**؛
//      مستهلكها الوحيد `sku-barcode.html` جوّه هب مركز عمليات المخزن،
//      والدخول بيحصل هناك عبر `orders-packing-checker-worker` وبيتسجّل
//      تحت `warehouse_ops_center`. فالأداة **بتتطلّب دخول فعلاً**، بس
//      نقطة الدخول مش هنا — فمفيش §SHARED ومفيش endpoints دخول.
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
const WORKER_VERSION = '1.0.0';
const SECRET_GROUP   = 'warehouse_ops';
const API_VERSION    = '2026-01';   // صريحة دايمًا — ممنوع "latest"

// سقف بنود الأوردر في نداء واحد. أكبر أوردر في المتجر أقل من ده بفارق
// كبير، بس القطع **بيتبلّغ** عنه في الرد (`itemsTruncated`) بدل ما يعدّي
// في السكوت — ليبل ناقص = قطعة بتخرج من المخزن من غير باركود.
const ORDER_LINE_ITEMS_MAX = 100;

// سقف نتايج البحث المباشر. أعلى من كده يبقى الموظف بيتصفّح كتالوج،
// مش بيدوّر على صنف — والواجهة بتقول إن فيه أكتر.
const SKU_SEARCH_MAX = 50;

// ══════════════════════════════════════════════════════
// §CORS — أداة قراءة فقط → Option A: Wildcard
// ══════════════════════════════════════════════════════
// (`references/cors-patterns.md` — مفيش أي كتابة على شوبيفاي، والحماية
//  الحقيقية في `WORKER_SECRET`.)
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
const Q_ORDER = `
  query OrderItems($q: String!) {
    orders(first: 1, query: $q) {
      nodes {
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
      }
    }
  }
`;

async function fetchOrderItems(env, token, rawOrder) {
  // تطبيع اسم الأوردر — فلتر `name:` بيطلب الـ `#`
  // (`shopify-graphql-helper` Step 3).
  const orderName = rawOrder.startsWith('#') ? rawOrder : '#' + rawOrder;

  const data = await shopifyGQL(env, token, Q_ORDER, { q: `name:${orderName}` }, 'get_order');
  const order = data?.data?.orders?.nodes?.[0];
  if (!order) return null;

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
// ⚠️ `sku:` و`barcode:` **صالحين على `productVariants`** ومش صالحين على
//    `orders` (اللي بيرجّع صفر نتايج بلا أي خطأ — `shopify-graphql-helper`
//    Step 3). اتأكد حيًا 06-09-2026 على `FL-PO-10` و`34271298`.
async function searchVariants(env, token, term) {
  // الرقم الصافي ممكن يكون باركود أو جزء من SKU — بندوّر بالاتنين.
  // النجمة بتخلّي `FL-PO-10` يطابق `FL-PO-10 / Black / 43` (الـ SKU عندنا
  // بيشمل اللون والمقاس).
  const safe = term.replace(/["\\]/g, ' ').trim();
  const q = `(sku:${safe}*) OR (barcode:${safe})`;

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
        const raw = (url.searchParams.get('order') || '').trim();
        if (!raw) return json({ error: 'رقم الأوردر مطلوب' }, 400, request);

        const token = await getAccessToken(env);
        const result = await fetchOrderItems(env, token, raw);
        if (!result) {
          const shown = raw.startsWith('#') ? raw : '#' + raw;
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

      return json({ error: `action غير معروف: ${action}` }, 400, request);
    } catch (e) {
      return json({ error: e.message || 'خطأ غير متوقع' }, 500, request);
    }
  },
};
