import { Page, expect } from '@playwright/test';

/* ---------------------------- types & utilities --------------------------- */

export type ShopCard = {
  rootSelector: string;
  name: string;
  price: number;
  onSale: boolean;
  addBtnSelector?: string;
  linkSelector?: string;
};

function productItems(page: Page) {
  return page.locator('ul.products li.product'); // Storefront default
}

async function textOrEmpty(locator: ReturnType<Page['locator']>): Promise<string> {
  try {
    if (await locator.count()) {
      const t = await locator.first().textContent();
      return (t || '').trim();
    }
  } catch {}
  return '';
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function parsePrice(text: string): Promise<number> {
  const cleaned = text.replace(/[^\d.,-]/g, '').replace(/\s/g, '');
  let normalized = cleaned;
  if (cleaned.includes('.') && cleaned.includes(',')) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if ((cleaned.match(/,/g) || []).length === 1 && !cleaned.includes('.')) {
    normalized = cleaned.replace(',', '.');
  }
  const n = Number.parseFloat(normalized);
  if (Number.isNaN(n)) throw new Error(`Could not parse price from: "${text}"`);
  return n;
}

/* -------------------------------- navigation ----------------------------- */

export async function goShop(page: Page) {
  await page.goto('/shop/', { waitUntil: 'domcontentloaded' });
  let items = productItems(page);
  if ((await items.count()) === 0) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    items = productItems(page);
  }
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThan(0);
}

/* ------------------------------- scraping -------------------------------- */

export async function readShopCards(page: Page): Promise<ShopCard[]> {
  const items = productItems(page);
  const count = await items.count();
  const results: ShopCard[] = [];

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const rootSelector = `ul.products li.product:nth-of-type(${i + 1})`;

    const name =
      (await textOrEmpty(item.locator('h2'))) ||
      (await textOrEmpty(item.locator('h3'))) ||
      (await textOrEmpty(item.locator('.woocommerce-loop-product__title'))) ||
      `Product ${i + 1}`;

    const priceWrap = item.locator('.price').first();
    const currentPriceText =
      (await textOrEmpty(priceWrap.locator('ins .amount'))) ||
      (await textOrEmpty(priceWrap.locator('.amount'))) ||
      (await textOrEmpty(priceWrap));
    const price = await parsePrice(currentPriceText);

    const onSale = await item.locator('.onsale').first().isVisible().catch(() => false);

    // Try to locate a link to product details (for variable / select options flow)
    const linkSel = [
      `${rootSelector} a.woocommerce-LoopProduct-link`,
      `${rootSelector} a.woocommerce-LoopProduct-link.woocommerce-loop-product__link`,
      `${rootSelector} a:has(h2), ${rootSelector} a:has(h3)`
    ].join(', ');

    // Direct add-to-cart button (simple products)
    const addBtnSel = [
      `${rootSelector} a.ajax_add_to_cart`,
      `${rootSelector} a.add_to_cart_button`,
      `${rootSelector} button.add_to_cart_button`
    ].join(', ');
    const hasAdd = (await item.locator(addBtnSel).count()) > 0;

    results.push({
      rootSelector,
      name,
      price,
      onSale,
      addBtnSelector: hasAdd ? addBtnSel : undefined,
      linkSelector: linkSel
    });
  }

  return results;
}

/* ---------------------------- cart / checkout ---------------------------- */

export async function clearCart(page: Page) {
  const candidates = ['/cart/', '/?page_id=7', '/basket/'];
  for (const u of candidates) {
    try { await page.goto(u, { waitUntil: 'domcontentloaded' }); break; } catch {}
  }

  // Classic remove (×)
  for (;;) {
    const rows = page.locator('tr.cart_item');
    const n = await rows.count();
    if (!n) break;
    await rows.first().locator('a.remove').click();
    await expect(rows).toHaveCount(n - 1, { timeout: 8000 });
  }

  // Blocks remove
  for (;;) {
    const rows = page.locator('.wc-block-cart-items .wc-block-cart-items__row, .wc-block-cart-item');
    const n = await rows.count();
    if (!n) break;
    await rows.first().locator('button[aria-label^="Remove"], .wc-block-cart-item__remove-link').click();
    await expect(rows).toHaveCount(n - 1, { timeout: 8000 });
  }
}

/**
 * Deterministic add for simple products: /?add-to-cart=<id>
 */
export async function addByClick(page: Page, selector: string) {
  const btn = page.locator(selector).first();
  await expect(btn).toBeVisible();

  let pid = await btn.getAttribute('data-product_id');
  if (!pid) {
    const href = (await btn.getAttribute('href')) || '';
    const m = href.match(/[?&]add-to-cart=(\d+)/i);
    if (m) pid = m[1];
  }
  if (!pid) throw new Error('Could not determine product_id for add-to-cart.');

  await page.goto(`/?add-to-cart=${pid}`, { waitUntil: 'domcontentloaded' });
  await gotoCart(page);
}

/**
 * Add from single product page (handles variable products).
 * - Opens PDP (if not already there)
 * - Selects first available option for each attribute
 * - Clicks "Add to cart"
 */
export async function addFromPDP(page: Page, fromShopCard?: ShopCard) {
  // If we're on shop, go to PDP using linkSelector
  if (fromShopCard) {
    const link = page.locator(fromShopCard.linkSelector!).first();
    await expect(link, `Product link not found for "${fromShopCard.name}"`).toBeVisible();
    await Promise.all([page.waitForLoadState('domcontentloaded'), link.click()]);
  }

  // If it's a variable product, pick first option for each select
  const selects = page.locator('form.cart select[name^="attribute_"]');
  const selectsCount = await selects.count();
  for (let i = 0; i < selectsCount; i++) {
    const sel = selects.nth(i);
    const options = await sel.locator('option').all();
    const firstEnabled = await sel.evaluate((el) => {
      const opts = Array.from((el as HTMLSelectElement).options);
      const found = opts.find((o) => !!o.value && !o.disabled);
      return found ? found.value : '';
    });
    if (firstEnabled) {
      await sel.selectOption(firstEnabled);
    }
  }

  // Quantity optional – default 1
  const addBtn = page.locator('button.single_add_to_cart_button');
  await expect(addBtn).toBeVisible();
  await Promise.all([page.waitForLoadState('domcontentloaded'), addBtn.click()]);

  // Go to cart (link or direct page)
  const viewCart = page.locator('a:has-text("View cart"), a:has-text("Shiko shportën"), a[href*="/cart"]');
  if (await viewCart.count()) {
    await Promise.all([page.waitForLoadState('domcontentloaded'), viewCart.first().click()]);
  } else {
    await gotoCart(page);
  }
}

/**
 * Add any purchasable product:
 * - Prefer non-sale simple via add button
 * - Else open PDP and add (handles variable)
 * Returns product name added.
 */
export async function addAnyPurchasable(page: Page): Promise<string> {
  await goShop(page);
  const cards = await readShopCards(page);

  // 1) Try first addable (simple) product
  const addable = cards.find((c) => c.addBtnSelector);
  if (addable?.addBtnSelector) {
    await addByClick(page, addable.addBtnSelector);
    return addable.name;
  }

  // 2) Fallback: open first card PDP and add (variable supported)
  const first = cards[0];
  await addFromPDP(page, first);
  return first.name;
}

/**
 * Add first NON-SALE product (simple or variable).
 */
export async function addFirstNonSale(page: Page): Promise<ShopCard> {
  await goShop(page);
  const cards = await readShopCards(page);
  const nonSale = cards.find(c => !c.onSale);
  if (!nonSale) throw new Error('No non-sale product found.');

  if (nonSale.addBtnSelector) {
    await addByClick(page, nonSale.addBtnSelector);
  } else {
    await addFromPDP(page, nonSale);
  }
  return nonSale;
}

/**
 * Add first ON-SALE product (simple or variable).
 */
export async function addFirstSale(page: Page): Promise<ShopCard> {
  await goShop(page);
  const cards = await readShopCards(page);
  const sale = cards.find(c => c.onSale);
  if (!sale) throw new Error('No on-sale product found.');

  if (sale.addBtnSelector) {
    await addByClick(page, sale.addBtnSelector);
  } else {
    await addFromPDP(page, sale);
  }
  return sale;
}

/** Open cart and ensure visible container exists. */
export async function openCart(page: Page) {
  if (!/\/cart\/|\?page_id=\d+|\/basket\/|\/koshe\//i.test(page.url())) {
    await page.goto('/cart/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  const anyCartContainer = page.locator(
    [
      '.woocommerce-cart-form',           // classic
      'p.cart-empty', '.cart-empty',      // classic empty
      'table.shop_table.cart',            // classic table
      '.cart_totals',                     // classic totals
      '.wc-block-cart',                   // blocks wrapper
      '.wp-block-woocommerce-cart',       // blocks wrapper
      '.wc-block-cart__empty-cart',       // blocks empty
      '.wc-block-components-totals',      // blocks totals
      '.wc-block-cart-items'              // blocks items table
    ].join(', ')
  );

  const spinner = page.locator('.wc-block-components-loading-mask, .wc-block-components-spinner');
  if (await spinner.count()) {
    await spinner.first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  }

  if ((await anyCartContainer.count()) === 0) {
    await page.goto('/?page_id=7', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  await expect(anyCartContainer.first()).toBeVisible({ timeout: 12000 });
}

/** Go to cart, wait until rows/titles are present. */
export async function gotoCart(page: Page, cartUrlHint?: string) {
  const target = cartUrlHint || '/cart/';
  await page.goto(target, { waitUntil: 'networkidle' }).catch(() => {});
  await openCart(page);
  await page.waitForTimeout(4000); // 👈 wait 4 seconds for totals to load

  const classicRows = page.locator('tr.cart_item');
  const blocksTable = page.locator('.wc-block-cart-items');
  const blocksRows = page.locator('.wc-block-cart-items .wc-block-cart-items__row, .wc-block-cart-item');

  const spinner = page.locator('.wc-block-components-loading-mask, .wc-block-components-spinner');
  if (await spinner.count()) {
    await spinner.first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  }

  for (let i = 0; i < 15; i++) {
    const hasClassic = (await classicRows.count()) > 0;
    const hasBlocks = (await blocksRows.count()) > 0 || (await blocksTable.count()) > 0;
    if (hasClassic || hasBlocks) break;
    await page.waitForTimeout(300);
  }
}

export async function openCheckout(page: Page) {
  const anyCheckout = page.locator(
    'form.checkout, #customer_details, .woocommerce-checkout-review-order-table, .wc-block-checkout, .wp-block-woocommerce-checkout'
  );
  if (await anyCheckout.count()) {
    await expect(anyCheckout.first()).toBeVisible({ timeout: 12000 });
    return;
  }

  await page.goto('/checkout/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await anyCheckout.count()) {
    await expect(anyCheckout.first()).toBeVisible({ timeout: 12000 });
    return;
  }

  await openCart(page);
  const proceed = page.locator('a.checkout-button, a:has-text("Proceed to checkout")').first();
  if (await proceed.count()) {
    await Promise.all([page.waitForLoadState('domcontentloaded'), proceed.click()]);
  }
  await expect(anyCheckout.first()).toBeVisible({ timeout: 12000 });
}

export async function getOrderTotal(page: Page): Promise<number> {
  if (page.isClosed()) throw new Error('Page already closed before reading order total.');

  // Helper: wait for Woo Blocks spinners to finish if present
  const waitWooIdle = async () => {
    const spinners = page.locator('.wc-block-components-loading-mask, .wc-block-components-spinner');
    if (await spinners.count().catch(() => 0)) {
      await spinners.first().waitFor({ state: 'detached', timeout: 12000 }).catch(() => {});
    }
  };

  // 1) Wait for either CART or CHECKOUT containers to show up
  await page.waitForFunction(() => {
    const qs = (s: string) => document.querySelector(s);
    return (
      // cart
      qs('.wc-block-cart') ||
      qs('.woocommerce-cart-form') ||
      qs('.cart_totals') ||
      // checkout
      qs('.wp-block-woocommerce-checkout') ||
      qs('.wc-block-checkout') ||
      qs('form.checkout')
    );
  }, null, { timeout: 20_000 });

  await waitWooIdle();

  // 2) Try CART totals first (this test reads while on /cart/)
  for (let attempt = 0; attempt < 8; attempt++) {
    // evaluate inside the page to find the "Total" row within cart
    const cartTxt = await page.evaluate(() => {
      const moneyRx = /[€$£]\s*[\d.,]+|[\d.,]+\s*[€$£]/;
      // Blocks cart root
      const blockCart = document.querySelector('.wc-block-cart');
      if (blockCart) {
        // look in the totals area footer row
        const totals = blockCart.querySelector(
          '.wc-block-cart__totals, .wc-block-components-totals, .wc-block-components-totals-footer'
        );
        if (totals) {
          // find a row that contains "Total"
          const rows = totals.querySelectorAll('.wc-block-components-totals-item, .wc-block-components-totals-footer-item');
          for (const row of Array.from(rows)) {
            const t = (row.textContent || '').trim();
            if (/total/i.test(t)) {
              const amountEl =
                row.querySelector('.wc-block-components-formatted-money-amount, .amount, .woocommerce-Price-amount, bdi') ||
                Array.from(row.querySelectorAll('*')).find((n) => moneyRx.test(n.textContent || ''));
              if (amountEl) return (amountEl.textContent || '').trim();
              const m = t.match(moneyRx);
              if (m) return m[0].trim();
            }
          }
          // last resort: any money in totals area
          const anyMoney = (totals.textContent || '').match(moneyRx);
          if (anyMoney) return anyMoney[0].trim();
        }
      }

      // Classic cart
      const classicTotals = document.querySelector('.cart_totals');
      if (classicTotals) {
        // order-total row first
        const orderRow = classicTotals.querySelector('.order-total');
        if (orderRow) {
          const el =
            orderRow.querySelector('.amount, .woocommerce-Price-amount, bdi') ||
            Array.from(orderRow.querySelectorAll('*')).find((n) => moneyRx.test(n.textContent || ''));
          if (el) return (el.textContent || '').trim();
          const m = (orderRow.textContent || '').match(moneyRx);
          if (m) return m[0].trim();
        }
        const anyMoney = (classicTotals.textContent || '').match(moneyRx);
        if (anyMoney) return anyMoney[0].trim();
      }

      return '';
    }).catch(() => '');

    if (cartTxt && /[\d€£$]/.test(cartTxt)) {
      try { return parsePrice(cartTxt); } catch { /* keep trying */ }
    }

    await waitWooIdle();
    if (page.isClosed()) break;
    // Give cart fragments a moment to finish updating
    await page.waitForTimeout(1000).catch(() => {});
  }

  // 3) Fallback: CHECKOUT totals (in case the test called from there)
  for (let attempt = 0; attempt < 6; attempt++) {
    const checkoutTxt = await page.evaluate(() => {
      const moneyRx = /[€$£]\s*[\d.,]+|[\d.,]+\s*[€$£]/;
      const root =
        document.querySelector('.wp-block-woocommerce-checkout') ||
        document.querySelector('.wc-block-checkout') ||
        document.querySelector('form.checkout');
      if (!root) return '';
      const rows = root.querySelectorAll(
        '.wc-block-components-totals-item, .wc-block-components-totals-footer-item, tr.order-total, .order-total, .wc-block-checkout__order-summary'
      );
      for (const row of Array.from(rows)) {
        const t = (row.textContent || '').trim();
        if (/total/i.test(t)) {
          const el =
            row.querySelector('.wc-block-components-formatted-money-amount, .amount, .woocommerce-Price-amount, bdi') ||
            Array.from(row.querySelectorAll('*')).find((n) => moneyRx.test(n.textContent || ''));
          if (el) return (el.textContent || '').trim();
          const m = t.match(moneyRx);
          if (m) return m[0].trim();
        }
      }
      const any = (root.textContent || '').match(moneyRx);
      return any ? any[0].trim() : '';
    }).catch(() => '');

    if (checkoutTxt && /[\d€£$]/.test(checkoutTxt)) {
      try { return parsePrice(checkoutTxt); } catch { /* keep trying */ }
    }

    await waitWooIdle();
    if (page.isClosed()) break;
    await page.waitForTimeout(800).catch(() => {});
  }

  // 4) Last chance: quick known selectors sweep
  const selectors = [
    // Classic
    '.cart_totals .order-total .amount',
    '.order-total .amount',
    '.woocommerce-Price-amount bdi',
    // Blocks
    '.wc-block-cart__totals .wc-block-components-formatted-money-amount',
    '.wc-block-components-totals-footer-item .wc-block-components-formatted-money-amount',
    '.wc-block-components-totals-item__value',
    '.wc-block-components-order-summary-item__total-price'
  ];
  for (const sel of selectors) {
    const v = (await page.locator(sel).first().textContent().catch(() => ''))?.trim() || '';
    if (v && /[\d€£$]/.test(v)) {
      try { return parsePrice(v); } catch {}
    }
  }

  throw new Error('Could not find order total on the page.');
}


export async function hasFreeShipping(page: Page): Promise<boolean> {
  const classicInputs = page.locator('input[name^="shipping_method"]');
  const classicCount = await classicInputs.count();
  for (let i = 0; i < classicCount; i++) {
    const value = await classicInputs.nth(i).getAttribute('value');
    if (value && value.includes('free_shipping')) return true;
  }
  const classicTxt =
    (await textOrEmpty(page.locator('.woocommerce-shipping-totals'))) ||
    (await textOrEmpty(page.locator('.cart_totals'))) ||
    (await textOrEmpty(page.locator('.woocommerce-checkout-review-order-table')));
  if ((classicTxt || '').toLowerCase().includes('free')) return true;

  const blocksShippingArea = page.locator(
    '.wc-block-components-radio-control, .wc-block-components-totals, .wc-block-checkout__shipping-methods'
  );
  const blocksText = await blocksShippingArea.allTextContents().catch(() => []);
  if (blocksText.join(' ').toLowerCase().includes('free')) return true;
  return false;
}

export async function hasOnlyPaidShipping(page: Page): Promise<boolean> {
  if (await hasFreeShipping(page)) return false;

  const classicInputs = page.locator('input[name^="shipping_method"]');
  if ((await classicInputs.count()) > 0) {
    for (let i = 0; i < (await classicInputs.count()); i++) {
      const value = await classicInputs.nth(i).getAttribute('value');
      if (value && value.includes('free_shipping')) return false;
    }
    return true;
  }

  const blocksArea = page.locator('.wc-block-components-totals, .wc-block-checkout__shipping-methods');
  const txts = await blocksArea.allTextContents().catch(() => []);
  const joined = txts.join(' ').toLowerCase();
  if (joined.includes('shipping') && !joined.includes('free')) return true;

  return true;
}

export async function fillCheckoutMinimal(page: Page) {
  const fill = async (selectors: string[], value: string) => {
    for (const s of selectors) {
      const el = page.locator(s).first();
      if (await el.count()) {
        try { await el.fill(value); return; } catch {}
      }
    }
  };
  await fill(['#billing_first_name', '[name="billing_first_name"]'], 'Test');
  await fill(['#billing_last_name', '[name="billing_last_name"]'], 'Buyer');
  await fill(['#billing_address_1', '[name="billing_address_1"]'], 'Rruga e Testit 1');
  await fill(['#billing_city', '[name="billing_city"]'], 'Tirana');
  await fill(['#billing_postcode', '[name="billing_postcode"]'], '1001');
  await fill(['#billing_phone', '[name="billing_phone"]'], '+35560000000');
  await fill(['#billing_email', '[name="billing_email"]'], 'buyer@example.com');

  const codClassic = page.locator('input#payment_method_cod, input[name="payment_method"][value="cod"]');
  if (await codClassic.count()) {
    try { await codClassic.first().check(); } catch {}
  }
  const blocksPayment = page.locator('.wc-block-components-radio-control, .wc-block-checkout__payment-methods');
  if (await blocksPayment.count()) {
    const codByLabel = blocksPayment.getByText(/cash on delivery|cod/i).locator('..').locator('input[type="radio"]');
    if (await codByLabel.count()) {
      try { await codByLabel.first().check(); } catch {}
    }
  }
}

export async function placeOrder(page: Page) {
  const btnBlocks = page.locator('button.wc-block-components-checkout-place-order-button');
  if (await btnBlocks.count()) {
    await btnBlocks.first().click();
    await page.waitForLoadState('domcontentloaded');
    return;
  }
  const btnClassic = page.locator('#place_order, button[name="woocommerce_checkout_place_order"]');
  if (await btnClassic.count()) {
    await btnClassic.first().click();
    await page.waitForLoadState('domcontentloaded');
    return;
  }
}

/* -------- Strict assertCartHas: checks only real cart rows (no cross-sells) --- */

export async function assertCartHas(page: Page, expectedNames: string[]) {
  // Classic rows + names
  const classicRows = page.locator('table.shop_table.cart tr.cart_item');
  const classicNames = classicRows.locator('td.product-name a, td.product-name');

  // Blocks rows + names
  const blocksRows = page.locator('.wc-block-cart-items .wc-block-cart-item, .wc-block-cart-items__row');
  const blocksNames = blocksRows.locator(
    '.wc-block-cart-item__product-name, .wc-block-components-product-name, a[rel="product"]'
  );

  // wait a bit for rows
  for (let i = 0; i < 10; i++) {
    const hasClassic = await classicRows.count();
    const hasBlocks  = await blocksRows.count();
    if (hasClassic || hasBlocks) break;
    await page.waitForTimeout(300);
  }

  const names: string[] = [];
  const pushTexts = async (loc: ReturnType<Page['locator']>) => {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const txt = (await loc.nth(i).innerText().catch(() => '')).trim();
      if (txt) names.push(txt);
    }
  };
  if (await classicNames.count()) await pushTexts(classicNames);
  if (await blocksNames.count())  await pushTexts(blocksNames);

  expect(names.length, `No cart items found.\nPage URL: ${page.url()}`).toBeGreaterThanOrEqual(expectedNames.length);

  const haystack = names.join(' | ');
  for (const name of expectedNames) {
    const rx = new RegExp(escapeRegex(name), 'i');
    expect(rx.test(haystack), `Missing in cart: ${name}\nSeen rows: ${haystack}`).toBeTruthy();
  }
}
