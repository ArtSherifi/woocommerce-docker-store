<?php
/**
 * Plugin Name: Conditional Free Shipping (Sale items disable free shipping)
 * Description: Free shipping over 100€ unless the cart contains on-sale items.
 */

add_filter('woocommerce_shipping_free_shipping_is_available', function($is_available, $package, $shipping_method){
    if (!$is_available) return false;
    if ( function_exists('WC') && WC()->cart ) {
        foreach ( WC()->cart->get_cart() as $item ) {
            $product = isset($item['data']) ? $item['data'] : null;
            if ( $product && is_callable([$product,'is_on_sale']) && $product->is_on_sale() ) {
                return false;
            }
        }
    }
    return $is_available;
}, 10, 3);
