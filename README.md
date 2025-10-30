# WooCommerce Docker Store (Storefront + WooCommerce)

## Quick start
```bash
docker compose up -d
# WordPress: http://localhost:8000
# phpMyAdmin: http://localhost:8080 (user: root / pass: root)

Shipping rules

Flat rate: €7
Free shipping: orders ≥ €100
Exception: if cart has on-sale items, free shipping is disabled
(see wp-content/mu-plugins/conditional-free-shipping.php)

Products (sample)

Leather Wallet (€70)
Running Socks (€60 regular, €48 sale)
Logo T-Shirt (Variable: S=€30, M=€32, L=€34)

Payments

Cash on Delivery enabled
Guest checkout enabled

Stack

wordpress:6.6-php8.2-apache
mysql:8
phpmyadmin/phpmyadmin