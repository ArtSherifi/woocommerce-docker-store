import { test, expect } from '@playwright/test';
import {
  goShop,
  readShopCards,
  clearCart,
  gotoCart,
  openCheckout,
  addFirstNonSale,
  addFirstSale,
  getOrderTotal,
  hasFreeShipping,
  hasOnlyPaidShipping,
  fillCheckoutMinimal,
  placeOrder,
  assertCartHas,
  addAnyPurchasable
} from '../helpers/wooutil';

test.describe.configure({ mode: 'serial' });

// Warm up server
test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.get(baseURL!);
  expect(res.ok()).toBeTruthy();
});

// Clear cart before each test
test.beforeEach(async ({ page }) => {
  await clearCart(page);
});

/* 1 */ test('Ecommerce is available', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveClass(/woocommerce/);
});

/* 2 */ test('Shop page is listing items properly', async ({ page }) => {
  await goShop(page);
  const cards = await readShopCards(page);
  expect(cards.length).toBeGreaterThan(0);
  for (const c of cards) expect(c.price).toBeGreaterThan(0);
});

/* 3 */ test('Cart page is showing correctly selected products', async ({ page }) => {
  
  await goShop(page);
  const cards = await readShopCards(page);
  const wallet = cards.find(c => /wallet/i.test(c.name)) || cards[0];
  if (!wallet) throw new Error('No product found to add to cart.');

  if (wallet.addBtnSelector) {
    await addByClick(page, wallet.addBtnSelector);
  } else {
    await page.locator(wallet.linkSelector!).first().click();
    await page.waitForLoadState('domcontentloaded');
    const addBtn = page.locator('button.single_add_to_cart_button');
    await expect(addBtn).toBeVisible();
    await addBtn.click();
  }

  
  await page.waitForTimeout(3000);

  
  await gotoCart(page);
  await assertCartHas(page, [wallet.name]);
});


/* 4 */ test('Checkout is showing the form correctly', async ({ page }) => {
  await addFirstNonSale(page);
  await openCheckout(page);

  
  await page.waitForTimeout(4000);

  
  const checkoutWrapper = page.locator('form.checkout, .wc-block-checkout');
  await expect(checkoutWrapper.first()).toBeVisible({ timeout: 20000 });

  
  const billingField = page.locator(
    [
      '#billing_first_name',
      '[name="billing_first_name"]',
      'input[placeholder*="First"]',
      'input[aria-label*="First"]',
      'input[name*="first_name"]'
    ].join(', ')
  );

  
  await expect(billingField.first()).toBeVisible({ timeout: 20000 });

  
  const placeOrder = page.locator(
    'button#place_order, button.wc-block-components-checkout-place-order-button, button:has-text("Continue"), button:has-text("Proceed")'
  );
  await expect(placeOrder.first()).toBeVisible({ timeout: 20000 });
});



/* 5 */ test('Checkout is showing correctly selected products', async ({ page }) => {
  const added = await addFirstNonSale(page);
  await openCheckout(page);
  await expect(
    page.locator('.woocommerce-checkout-review-order-table, .wc-block-components-order-summary')
  ).toContainText(added.name);
});

/* 6 */ test('Shipping is free if Checkout total is > 100 euros', async ({ page }) => {
  
  await goShop(page);
  const cards = await readShopCards(page);
  const card = cards.find(c => /leather\s*wallet/i.test(c.name)) ?? cards[0];
  if (!card) throw new Error('No product cards found.');

  const link = page.locator(card.linkSelector ?? `${card.rootSelector} a`).first();
  await link.click();
  await page.waitForLoadState('domcontentloaded');

  
  const selects = page.locator('form.cart select[name^="attribute_"]');
  for (let i = 0; i < await selects.count(); i++) {
    const v = await selects.nth(i).evaluate(el => {
      const opts = Array.from((el as HTMLSelectElement).options);
      const f = opts.find(o => o.value && !o.disabled);
      return f ? f.value : '';
    });
    if (v) await selects.nth(i).selectOption(v);
  }

  
  const qty = page.locator('form.cart input[name="quantity"], form.cart .qty').first();
  if (await qty.count()) await qty.fill('2');
  await page.locator('form.cart button.single_add_to_cart_button').click();
  await page.waitForLoadState('domcontentloaded');

  
  await openCheckout(page);
  await page.waitForSelector('.wc-block-checkout, form.checkout', { timeout: 20000 });

  
  await fillCheckoutMinimal(page);
    await page.waitForTimeout(2000);

  
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);

  
  const shippingSel = [
    '.wc-block-checkout__shipping-methods',
    '.wc-block-components-shipping-rates-control',
    '.woocommerce-shipping-totals',
    '[class*="shipping-methods"]'
  ].join(', ');
  await page.waitForSelector(shippingSel, { state: 'attached', timeout: 20000 });

 
  const shippingArea = page.locator(shippingSel).first();
  await shippingArea.scrollIntoViewIfNeeded();
  for (let i = 0; i < 5; i++) {
    if (await shippingArea.isVisible().catch(() => false)) break;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
  }

  
   await expect(page.locator('text=/Free shipping/i')).toBeVisible({ timeout: 15000 });
});






/* 7 */ test('Shipping is not free if Checkout total is < 100 euros', async ({ page }) => {
  await addFirstNonSale(page);
  await openCheckout(page);
  const total = await getOrderTotal(page);
  expect(total).toBeLessThan(100);
  expect(await hasOnlyPaidShipping(page)).toBeTruthy();
});

/* 8 */ test('Shipping is not free if total > 100 but there is a Discounted product', async ({ page }) => {
 
  await addFirstSale(page);

  
  await addFirstNonSale(page);
  await addFirstNonSale(page);

 
  await openCheckout(page);

 
  await fillCheckoutMinimal(page);
  await page.waitForTimeout(2000); // allow rates to update

 
  expect(await hasOnlyPaidShipping(page)).toBeTruthy();
});



/* 9 */ test('The purchase completes successfully', async ({ page }) => {
  
  await addFirstNonSale(page);

 
  await openCheckout(page);
  await page.waitForSelector('.wc-block-checkout, form.checkout', { timeout: 30000 });

  
  const shippingHeader = page.locator(
    'h2:has-text("Shipping address"), .wc-block-components-checkout-step__title:has-text("Shipping address")'
  );
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 600);
    if (await shippingHeader.first().isVisible()) break;
    await page.waitForTimeout(800);
  }

  
  await page.waitForSelector('input[name*="first_name"], input[id*="first_name"]', { timeout: 20000 });

  await page.fill('input[type="email"], input[name="email"]', 'artsherifi10@gmail.com');
  await page.waitForTimeout(500);
  await page.fill('input[name*="first_name"], input[id*="first_name"]', 'Arti');
  await page.waitForTimeout(300);
  await page.fill('input[name*="last_name"], input[id*="last_name"]', 'Sherifi');
  await page.waitForTimeout(300);
  await page.fill('input[name*="address_1"], input[id*="address_1"]', '123 Main St');
  await page.waitForTimeout(300);
  await page.fill('input[name*="city"], input[id*="city"]', 'Tirana');
  await page.waitForTimeout(300);
  await page.fill('input[name*="postcode"], input[id*="postcode"]', '1001');
  await page.waitForTimeout(300);
  await page.fill('input[name*="phone"], input[id*="phone"]', '0691234567');

  
  await page.keyboard.press('End');
  await page.waitForTimeout(1500);

  
  const placeOrderBtn = page.locator('button:has-text("Place order"), button:has-text("Place Order")');
  await placeOrderBtn.first().scrollIntoViewIfNeeded();
  await placeOrderBtn.first().click({ timeout: 30000 });

  
  await page.waitForURL(/order-received/, { timeout: 40000 });

  
  const thankYouNotice = page.locator('.woocommerce-notice.woocommerce-notice--success');
  await expect(thankYouNotice).toContainText(/thank you|Order received|faleminderit/i, { timeout: 20000 });
});


