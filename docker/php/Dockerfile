FROM php:8.2-fpm-bullseye AS build

ENV APP_ROOT=/var/www/html \
    COMPOSER_ALLOW_SUPERUSER=1 \
    PATH="$PATH:/var/www/html/vendor/bin"

WORKDIR ${APP_ROOT}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        unzip \
        libzip-dev \
        libicu-dev \
        libxml2-dev \
        libonig-dev \
        libpng-dev \
        libjpeg62-turbo-dev \
        libfreetype6-dev \
        libssl-dev \
        libcurl4-openssl-dev \
        libpq-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        bcmath \
        exif \
        gd \
        intl \
        mbstring \
        opcache \
        pcntl \
        pdo_mysql \
        zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2.7 /usr/bin/composer /usr/bin/composer

RUN usermod -u 1000 www-data && groupmod -g 1000 www-data

COPY composer.json composer.lock ./

RUN composer install \
        --no-interaction \
        --prefer-dist \
        --no-dev \
        --optimize-autoloader \
        --no-scripts

COPY . .

RUN composer dump-autoload --optimize \
    && php artisan package:discover --ansi \
    && php artisan vendor:publish --tag=laravel-assets --ansi --force || true \
    && mkdir -p storage/logs storage/framework/cache storage/framework/sessions storage/framework/views bootstrap/cache sessions \
    && chown -R www-data:www-data storage bootstrap/cache sessions

FROM build AS php-runtime

COPY docker/php/opcache.ini /usr/local/etc/php/conf.d/opcache.ini
COPY docker/php/php.ini /usr/local/etc/php/conf.d/99-app.ini
COPY docker/php/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9000

ENTRYPOINT ["entrypoint.sh"]

CMD ["php-fpm"]

FROM nginx:1.27-alpine AS nginx-runtime

RUN apk add --no-cache bash

COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /var/www/html /var/www/html

WORKDIR /var/www/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

