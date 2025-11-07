#!/bin/sh
set -e

if [ -d storage ]; then
    mkdir -p storage/app/public storage/framework/cache storage/framework/sessions \
        storage/framework/views storage/logs
    chown -R www-data:www-data storage bootstrap/cache || true
fi

php artisan config:cache || true
php artisan route:cache || true
php artisan view:cache || true
php artisan storage:link || true

exec "$@"

